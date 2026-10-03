//! OBS WebSocket v5: подключение, рукопожатие и запросы.
//!
//! Порт обвязки `startObsWebSocket` из `server/integrations/obs-websocket.js`.
//! Чистые части (подпись, кадры, план камер) — в
//! [`crate::integrations::obs_websocket`]; здесь сокет, рукопожатие
//! `Hello → Identify → Identified`, корреляция «запрос → ответ» с таймаутом и
//! реконнект.
//!
//! Устройство: сокетом владеет одна задача. Она читает кадры и попутно отдаёт
//! наружу исходящие через канал `outbox`, поэтому `request` может слать кадры из
//! любого места, не забирая сокет себе. Ответы находит по `requestId` в общей
//! таблице ожидающих.
//!
//! Отличие от JS: OBS-контроллер пока не пишет в журнал (`terminal_log`/
//! `debug_log`) — шина и файл для журнала уже подключены, а записи этого
//! модуля добавятся следом; на работу это не влияет.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::integrations::obs_websocket::{
    build_camera_switch_plan, identify_frame, request_frame, resolve_filter_duration,
};
use crate::integrations::twitch_chat_control::{ConnectFn, EmitFn, SpawnFn};
use crate::protocol::event_types;
use crate::storage::history::{js_number_or_zero, js_truthy};

const RECONNECT_MS: u64 = 3_000;
const REQUEST_TIMEOUT_MS: u64 = 10_000;

/// Сколько ждать ответа на запрос.
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

/// Общее состояние одного подключения.
#[derive(Clone)]
struct Session {
    outbox: mpsc::UnboundedSender<String>,
    pending: Pending,
    connected: Arc<AtomicBool>,
    next_id: Arc<AtomicU64>,
    /// Куда уходят события шины (`camera_angle_changed` и подобные).
    emit: EmitFn,
}

/// Клиент OBS WebSocket.
pub struct ObsClient {
    connect: ConnectFn,
    spawn: SpawnFn,
    /// Настройки OBS (host/port/password) на момент подключения.
    config: Arc<dyn Fn() -> Value + Send + Sync>,
    session: Mutex<Option<Session>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    /// Поколения таймеров автовыключения фильтров: повторный запуск того же
    /// фильтра делает прежний таймер недействительным (как `clearTimeout`).
    filter_generations: Mutex<HashMap<String, u64>>,
}

impl ObsClient {
    pub fn new(
        connect: ConnectFn,
        spawn: SpawnFn,
        config: Arc<dyn Fn() -> Value + Send + Sync>,
    ) -> Self {
        Self {
            connect,
            spawn,
            config,
            session: Mutex::new(None),
            stop: Mutex::new(None),
            filter_generations: Mutex::new(HashMap::new()),
        }
    }

    /// Переподключиться: закрыть прежнее соединение и, если служба включена,
    /// поднять новое. События уходят в `emit`.
    pub fn restart(self: &Arc<Self>, enabled: bool, emit: EmitFn) {
        if let Some(stop) = self.lock(&self.stop).take() {
            let _ = stop.send(());
        }
        *self.lock(&self.session) = None;
        // Прежние таймеры фильтров больше не относятся к делу.
        self.lock(&self.filter_generations).clear();

        if !enabled {
            emit(connection_status("disabled"));
            return;
        }

        let (outbox, outbox_rx) = mpsc::unbounded_channel::<String>();
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let session = Session {
            outbox: outbox.clone(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            connected: Arc::new(AtomicBool::new(false)),
            next_id: Arc::new(AtomicU64::new(1)),
            emit: Arc::clone(&emit),
        };
        *self.lock(&self.session) = Some(session.clone());

        let connect = Arc::clone(&self.connect);
        let config = Arc::clone(&self.config);
        (self.spawn)(Box::pin(async move {
            run(connect, config, session, outbox_rx, stop_rx, emit).await;
        }));

        *self.lock(&self.stop) = Some(stop_tx);
    }

    /// Закрыть соединение.
    pub fn stop(&self) {
        if let Some(stop) = self.lock(&self.stop).take() {
            let _ = stop.send(());
        }
        *self.lock(&self.session) = None;
        self.lock(&self.filter_generations).clear();
    }

    /// Подключено ли сейчас.
    pub fn is_connected(&self) -> bool {
        self.lock(&self.session)
            .as_ref()
            .map(|session| session.connected.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    /// Отправить запрос и дождаться ответа (или таймаута).
    pub async fn request(&self, request_type: &str, request_data: &Value) -> Result<Value, String> {
        let session = self
            .lock(&self.session)
            .clone()
            .filter(|session| session.connected.load(Ordering::SeqCst))
            .ok_or_else(|| "OBS не подключен".to_string())?;

        let id = session.next_id.fetch_add(1, Ordering::SeqCst);
        let request_id = id.to_string();
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        session
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(request_id.clone(), tx);

        let frame = request_frame(request_type, request_data, &request_id);
        if session.outbox.send(format!("{frame}")).is_err() {
            return Err("OBS не подключен".to_string());
        }

        match tokio::time::timeout(Duration::from_millis(REQUEST_TIMEOUT_MS), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("OBS request cancelled: {request_type}")),
            Err(_) => {
                session
                    .pending
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&request_id);
                Err(format!("OBS request timeout: {request_type}"))
            }
        }
    }

    /// Переключить сцену, не дожидаясь ответа — как `switchScene` в JS.
    pub fn switch_scene(&self, scene_name: &str) -> bool {
        if scene_name.is_empty() {
            return false;
        }
        let Some(session) = self
            .lock(&self.session)
            .clone()
            .filter(|session| session.connected.load(Ordering::SeqCst))
        else {
            return false;
        };
        let id = session.next_id.fetch_add(1, Ordering::SeqCst);
        let frame = request_frame(
            "SetCurrentProgramScene",
            &serde_json::json!({ "sceneName": scene_name }),
            &id.to_string(),
        );
        session.outbox.send(format!("{frame}")).is_ok()
    }

    /// Переключить ракурс камеры: включить целевой источник, остальные — выключить.
    pub async fn set_camera_angle(&self, angle_id: &str) -> Result<Value, String> {
        let obs = (self.config)();
        let angles = obs.get("cameraAngles").cloned().unwrap_or(Value::Null);
        let Some(list) = angles.as_array().filter(|list| !list.is_empty()) else {
            return Err("No camera angles configured".to_string());
        };
        let Some(target) = list
            .iter()
            .find(|angle| angle.get("id").and_then(Value::as_str) == Some(angle_id))
        else {
            return Err(format!("Unknown camera angle: {angle_id}"));
        };
        let has_scene = target
            .get("sceneName")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.is_empty());
        let has_source = target
            .get("cameraSource")
            .and_then(Value::as_str)
            .is_some_and(|source| !source.is_empty());
        if !has_scene || !has_source {
            return Err(format!(
                "Camera angle {angle_id} missing sceneName/cameraSource"
            ));
        }

        let webcam = obs
            .get("webcamSource")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        for op in build_camera_switch_plan(&angles, angle_id, &[webcam]) {
            let scene = op["sceneName"].clone();
            let source = op["cameraSource"].clone();
            let enabled = op["enabled"].clone();
            let item = self
                .request(
                    "GetSceneItemId",
                    &serde_json::json!({ "sceneName": scene.clone(), "sourceName": source.clone() }),
                )
                .await?;
            let scene_item_id = item.get("sceneItemId").cloned().unwrap_or(Value::Null);
            self.request(
                "SetSceneItemEnabled",
                &serde_json::json!({
                    "sceneName": scene,
                    "sceneItemId": scene_item_id,
                    "sceneItemEnabled": enabled,
                }),
            )
            .await?;
        }
        self.emit_bus(bus_event(
            "camera_angle_changed",
            serde_json::json!({ "activeCameraAngle": angle_id }),
        ));
        Ok(serde_json::json!({ "activeCameraAngle": angle_id }))
    }

    /// Включить фильтр камеры. Со сроком — включить и выключить по таймеру;
    /// без срока — переключить текущее состояние.
    pub async fn trigger_camera_filter(
        self: &Arc<Self>,
        filter_id: &str,
        duration_override: Option<f64>,
    ) -> Result<Value, String> {
        let obs = (self.config)();
        let filters = obs.get("cameraFilters").cloned().unwrap_or(Value::Null);
        let Some(filter) = filters.as_array().and_then(|list| {
            list.iter()
                .find(|filter| filter.get("id").and_then(Value::as_str) == Some(filter_id))
        }) else {
            return Err(format!("Unknown camera filter: {filter_id}"));
        };
        let source = filter
            .get("sourceName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let name = filter
            .get("filterName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if source.is_empty() || name.is_empty() {
            return Err(format!(
                "Camera filter {filter_id} missing sourceName/filterName"
            ));
        }

        let configured = js_number_or_zero(filter.get("durationSec")).max(0.0);
        let duration = resolve_filter_duration(configured, duration_override);

        if duration > 0.0 {
            self.request(
                "SetSourceFilterEnabled",
                &serde_json::json!({ "sourceName": source, "filterName": name, "filterEnabled": true }),
            )
            .await?;
            self.emit_bus(bus_event(
                "camera_filter_changed",
                serde_json::json!({ "filterId": filter_id, "active": true }),
            ));

            // Автовыключение по сроку — отдельной задачей (как `setTimeout` в JS).
            // Номер поколения отменяет прежний таймер того же фильтра: иначе
            // старый срок погасил бы фильтр раньше нового.
            let generation = {
                let mut generations = self.lock(&self.filter_generations);
                let entry = generations.entry(filter_id.to_string()).or_insert(0);
                *entry += 1;
                *entry
            };
            let this = Arc::clone(self);
            let timer_filter_id = filter_id.to_string();
            let ms = (duration * 1000.0) as u64;
            (self.spawn)(Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(ms)).await;
                // Прежний таймер или сброс сессии — выходим, не трогая фильтр.
                {
                    let mut generations = this.lock(&this.filter_generations);
                    if generations.get(&timer_filter_id).copied() != Some(generation) {
                        return;
                    }
                    generations.remove(&timer_filter_id);
                }
                let off = this
                    .request(
                        "SetSourceFilterEnabled",
                        &serde_json::json!({ "sourceName": source, "filterName": name, "filterEnabled": false }),
                    )
                    .await;
                if off.is_ok() {
                    this.emit_bus(bus_event(
                        "camera_filter_changed",
                        serde_json::json!({ "filterId": timer_filter_id, "active": false }),
                    ));
                }
            }));
            return Ok(serde_json::json!({ "filterId": filter_id, "active": true }));
        }

        let enabled = self
            .request(
                "GetSourceFilter",
                &serde_json::json!({ "sourceName": source, "filterName": name }),
            )
            .await?;
        let next = !js_truthy(enabled.get("filterEnabled"));
        self.request(
            "SetSourceFilterEnabled",
            &serde_json::json!({ "sourceName": source, "filterName": name, "filterEnabled": next }),
        )
        .await?;
        self.emit_bus(bus_event(
            "camera_filter_changed",
            serde_json::json!({ "filterId": filter_id, "active": next }),
        ));
        Ok(serde_json::json!({ "filterId": filter_id, "active": next }))
    }

    /// Показать или скрыть вебкамеру в текущей сцене.
    pub async fn toggle_webcam(&self, source_name: &str) -> Result<bool, String> {
        if source_name.is_empty() {
            return Err("Webcam source name is empty".to_string());
        }
        let scene = self
            .request("GetCurrentProgramScene", &serde_json::json!({}))
            .await?;
        let scene_name = scene
            .get("currentProgramSceneName")
            .cloned()
            .filter(|name| js_truthy(Some(name)))
            .ok_or_else(|| "Cannot determine current scene".to_string())?;
        let item = self
            .request(
                "GetSceneItemId",
                &serde_json::json!({ "sceneName": scene_name.clone(), "sourceName": source_name }),
            )
            .await?;
        let scene_item_id = item
            .get("sceneItemId")
            .cloned()
            .filter(|id| !id.is_null())
            .ok_or_else(|| "Webcam source not found in current scene".to_string())?;
        let current = self
            .request(
                "GetSceneItemEnabled",
                &serde_json::json!({ "sceneName": scene_name.clone(), "sceneItemId": scene_item_id.clone() }),
            )
            .await?;
        let enabled = js_truthy(current.get("sceneItemEnabled"));
        self.request(
            "SetSceneItemEnabled",
            &serde_json::json!({
                "sceneName": scene_name,
                "sceneItemId": scene_item_id,
                "sceneItemEnabled": !enabled,
            }),
        )
        .await?;
        Ok(!enabled)
    }

    /// Переключить mute микрофона; возвращает новое состояние.
    pub async fn toggle_mic_mute(&self, source_name: &str) -> Result<bool, String> {
        if source_name.is_empty() {
            return Err("Mic source name is empty".to_string());
        }
        let data = self
            .request(
                "ToggleInputMute",
                &serde_json::json!({ "inputName": source_name }),
            )
            .await?;
        Ok(js_truthy(data.get("inputMuted")))
    }

    /// Разослать событие шины через текущую сессию.
    fn emit_bus(&self, event: Value) {
        if let Some(session) = self.lock(&self.session).clone() {
            (session.emit)(event);
        }
    }

    fn lock<'a, T>(&self, mutex: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
        mutex.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Цикл подключения: сокет → рукопожатие → запросы/ответы → реконнект.
#[allow(clippy::too_many_arguments)]
async fn run(
    connect: ConnectFn,
    config: Arc<dyn Fn() -> Value + Send + Sync>,
    session: Session,
    mut outbox_rx: mpsc::UnboundedReceiver<String>,
    mut stop_rx: oneshot::Receiver<()>,
    emit: EmitFn,
) {
    loop {
        let obs = config();
        let host = obs
            .get("host")
            .map(crate::state::js_string)
            .unwrap_or_default();
        let port = js_number_or_zero(obs.get("port"));
        if host.trim().is_empty() || port <= 0.0 {
            emit(connection_status("not_configured"));
            return;
        }
        let password = obs
            .get("password")
            .map(crate::state::js_string)
            .unwrap_or_default();
        let url = format!("ws://{}:{}", host.trim(), port as i64);

        emit(connection_status("connecting"));
        let Ok(mut transport) = connect(url).await else {
            emit(connection_status("error"));
            if sleep_or_stop(&mut stop_rx).await {
                return;
            }
            continue;
        };

        let clean = loop {
            tokio::select! {
                _ = &mut stop_rx => return,
                outgoing = outbox_rx.recv() => match outgoing {
                    Some(line) => {
                        if transport.send(line).await.is_err() {
                            break true;
                        }
                    }
                    None => return,
                },
                incoming = transport.recv() => match incoming {
                    Ok(Some(frame)) => {
                        for line in frame.split('\n').filter(|line| !line.trim().is_empty()) {
                            let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else {
                                continue;
                            };
                            handle_message(&mut transport, &session, &password, &emit, &msg).await;
                        }
                    }
                    Ok(None) | Err(_) => break true,
                }
            }
        };

        session.connected.store(false, Ordering::SeqCst);
        if clean {
            emit(connection_status("disconnected"));
        }
        if sleep_or_stop(&mut stop_rx).await {
            return;
        }
    }
}

/// Разобрать один кадр OBS: рукопожатие и ответы на запросы.
async fn handle_message(
    transport: &mut Box<dyn crate::integrations::twitch_chat::ChatTransport>,
    session: &Session,
    password: &str,
    emit: &EmitFn,
    msg: &Value,
) {
    match msg.get("op").and_then(Value::as_u64) {
        Some(0) => {
            // Hello: отвечаем Identify (с подписью, если сервер её требует).
            let authentication = msg.get("d").and_then(|d| d.get("authentication"));
            let frame = identify_frame(authentication, password);
            let _ = transport.send(format!("{frame}")).await;
        }
        Some(2) => {
            session.connected.store(true, Ordering::SeqCst);
            emit(connection_status("connected"));
        }
        Some(7) => {
            let Some(d) = msg.get("d") else {
                return;
            };
            let request_id = d
                .get("requestId")
                .map(crate::state::js_string)
                .unwrap_or_default();
            let Some(waiting) = session
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&request_id)
            else {
                return;
            };
            let status = d.get("requestStatus");
            if status
                .and_then(|status| status.get("result"))
                .map(|result| js_truthy(Some(result)))
                .unwrap_or(false)
            {
                let data = d
                    .get("responseData")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Default::default()));
                let _ = waiting.send(Ok(data));
            } else {
                let code = status
                    .and_then(|status| status.get("code"))
                    .map(crate::state::js_string)
                    .unwrap_or_default();
                let comment = status
                    .and_then(|status| status.get("comment"))
                    .map(crate::state::js_string)
                    .unwrap_or_default();
                let _ = waiting.send(Err(format!("OBS request failed ({code}) {comment}")
                    .trim()
                    .to_string()));
            }
        }
        _ => {}
    }
}

/// Пауза перед повтором; `true` — пришла остановка.
async fn sleep_or_stop(stop_rx: &mut oneshot::Receiver<()>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(RECONNECT_MS)) => false,
        _ = stop_rx => true,
    }
}

/// Событие `connection_status` для службы OBS.
fn connection_status(status: &str) -> Value {
    serde_json::json!({
        "type": event_types::CONNECTION_STATUS,
        "payload": { "service": "obs", "status": status },
    })
}

/// Событие шины в форме `bus.emit`.
fn bus_event(kind: &str, payload: Value) -> Value {
    serde_json::json!({ "type": kind, "payload": payload })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;
    use crate::integrations::twitch_chat::{ChatTransport, RecvFuture, SendFuture};
    use serde_json::json;

    /// Сокет, который отвечает на запросы: на кадр op 6 кладёт в очередь op 7.
    struct FakeServer {
        incoming: VecDeque<String>,
        sent: Arc<Mutex<Vec<String>>>,
    }

    impl ChatTransport for FakeServer {
        fn send(&mut self, line: String) -> SendFuture<'_> {
            self.sent.lock().unwrap().push(line.clone());
            if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                if frame.get("op").and_then(Value::as_u64) == Some(6) {
                    let id = frame["d"]["requestId"].clone();
                    let response = json!({
                        "op": 7,
                        "d": {
                            "requestId": id,
                            "requestStatus": { "result": true },
                            "responseData": { "ok": 1 },
                        },
                    });
                    self.incoming.push_back(response.to_string());
                }
            }
            Box::pin(async { Ok(()) })
        }

        fn recv(&mut self) -> RecvFuture<'_> {
            match self.incoming.pop_front() {
                Some(frame) => Box::pin(async move { Ok(Some(frame)) }),
                // Соединение живое, кадров пока нет — не закрываемся.
                None => Box::pin(std::future::pending()),
            }
        }
    }

    fn collector() -> (EmitFn, Arc<Mutex<Vec<Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let emit: EmitFn = Arc::new(move |event| sink.lock().unwrap().push(event));
        (emit, events)
    }

    /// Настоящий спавн: задача работает фоном, тест наблюдает за клиентом.
    fn real_spawn() -> SpawnFn {
        Arc::new(|task| {
            std::mem::drop(tokio::spawn(task));
        })
    }

    fn obs_config() -> Arc<dyn Fn() -> Value + Send + Sync> {
        Arc::new(|| json!({ "host": "127.0.0.1", "port": 4455, "password": "pass" }))
    }

    async fn wait_connected(client: &ObsClient) -> bool {
        for _ in 0..200 {
            if client.is_connected() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        false
    }

    fn fake_connect(sent: Arc<Mutex<Vec<String>>>) -> ConnectFn {
        Arc::new(move |_url| {
            let sent = Arc::clone(&sent);
            Box::pin(async move {
                let incoming = [
                    r#"{ "op": 0, "d": { "authentication": { "challenge": "c", "salt": "s" } } }"#,
                    r#"{ "op": 2, "d": {} }"#,
                ]
                .iter()
                .map(|frame| (*frame).to_string())
                .collect();
                Ok(Box::new(FakeServer { incoming, sent }) as Box<dyn ChatTransport>)
            })
        })
    }

    #[tokio::test]
    async fn the_handshake_signs_the_password_and_a_request_gets_its_answer() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let client = Arc::new(ObsClient::new(
            fake_connect(Arc::clone(&sent)),
            real_spawn(),
            obs_config(),
        ));
        let (emit, events) = collector();

        client.restart(true, emit);
        assert!(wait_connected(&client).await, "OBS должен подключиться");

        // Identify ушёл с подписью пароля (Hello требовал challenge+salt).
        let identify = sent
            .lock()
            .unwrap()
            .iter()
            .find(|line| line.contains("\"op\":1"))
            .cloned()
            .expect("кадр Identify");
        let identify: Value = serde_json::from_str(&identify).unwrap();
        assert!(identify["d"]["authentication"].is_string());

        let answer = client
            .request("SetCurrentProgramScene", &json!({ "sceneName": "Main" }))
            .await
            .expect("ответ");
        assert_eq!(answer["ok"], json!(1));

        client.stop();
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| event["payload"]["status"] == json!("connected"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn a_request_when_disconnected_is_refused() {
        let client = Arc::new(ObsClient::new(
            fake_connect(Arc::new(Mutex::new(Vec::new()))),
            real_spawn(),
            obs_config(),
        ));
        let result = client.request("GetVersion", &json!({})).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn without_a_host_obs_is_not_configured() {
        let client = Arc::new(ObsClient::new(
            fake_connect(Arc::new(Mutex::new(Vec::new()))),
            real_spawn(),
            Arc::new(|| json!({ "host": "", "port": 4455 })),
        ));
        let (emit, events) = collector();
        client.restart(true, emit);
        // Ждём, пока задача сообщит о состоянии.
        for _ in 0..100 {
            if !events.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let events = events.lock().unwrap();
        assert_eq!(events[0]["payload"]["status"], json!("not_configured"));
    }

    fn camera_config() -> Arc<dyn Fn() -> Value + Send + Sync> {
        Arc::new(|| {
            json!({
                "host": "127.0.0.1",
                "port": 4455,
                "password": "pass",
                "webcamSource": "Webcam",
                "cameraAngles": [
                    { "id": "cam_main", "sceneName": "Main", "cameraSource": "Cam1" },
                    { "id": "cam_side", "sceneName": "Main", "cameraSource": "Cam2" },
                ],
                "cameraFilters": [
                    { "id": "f1", "sourceName": "Cam1", "filterName": "Sepia", "durationSec": 0 },
                ],
            })
        })
    }

    fn requests(sent: &Arc<Mutex<Vec<String>>>, request_type: &str) -> Vec<Value> {
        sent.lock()
            .unwrap()
            .iter()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|frame| frame["d"]["requestType"] == json!(request_type))
            .collect()
    }

    #[tokio::test]
    async fn a_camera_angle_switch_enables_only_the_target_and_reports_it() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let client = Arc::new(ObsClient::new(
            fake_connect(Arc::clone(&sent)),
            real_spawn(),
            camera_config(),
        ));
        let (emit, events) = collector();
        client.restart(true, emit);
        assert!(wait_connected(&client).await, "OBS должен подключиться");

        let result = client.set_camera_angle("cam_side").await.expect("ракурс");
        assert_eq!(result["activeCameraAngle"], json!("cam_side"));

        // Два `SetSceneItemEnabled`: Cam1 выключить, Cam2 включить.
        let enables = requests(&sent, "SetSceneItemEnabled");
        assert_eq!(enables.len(), 2);
        assert_eq!(
            enables[0]["d"]["requestData"]["sceneItemEnabled"],
            json!(false)
        );
        assert_eq!(
            enables[1]["d"]["requestData"]["sceneItemEnabled"],
            json!(true)
        );

        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|event| event["type"] == json!("camera_angle_changed")
                && event["payload"]["activeCameraAngle"] == json!("cam_side")));
        client.stop();
    }

    #[tokio::test]
    async fn a_filter_without_a_duration_toggles_and_reports_its_state() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let client = Arc::new(ObsClient::new(
            fake_connect(Arc::clone(&sent)),
            real_spawn(),
            camera_config(),
        ));
        let (emit, events) = collector();
        client.restart(true, emit);
        assert!(wait_connected(&client).await, "OBS должен подключиться");

        let result = client
            .trigger_camera_filter("f1", None)
            .await
            .expect("фильтр");
        // `GetSourceFilter` вернул пустой ответ — фильтр был выключен, включаем.
        assert_eq!(result["active"], json!(true));
        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|event| event["type"] == json!("camera_filter_changed")
                && event["payload"]["filterId"] == json!("f1")
                && event["payload"]["active"] == json!(true)));
        client.stop();
    }
}
