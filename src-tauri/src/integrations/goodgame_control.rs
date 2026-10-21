//! Подключение к чату GoodGame: поиск канала, чтение и отправка сообщений.
//!
//! Обвязка `wss://chat-1.goodgame.ru/chat2/`: имя канала превращается в
//! числовой `channel_id` через `getchannelstatus`, затем одно соединение
//! присоединяется к чату и разбирает кадры разборщиком
//! [`crate::integrations::goodgame`]. Чтение доступно гостю, для отправки нужны
//! `user_id` и токен чата: контроллер шлёт `auth` до `join`, а `send_message`
//! уходит в то же соединение.
//!
//! Транспорт и поиск канала инжектируются: контроллер проверяется без сети, а
//! настоящий WebSocket живёт в [`crate::integrations::twitch_chat_socket`].

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::integrations::goodgame::{
    bus_event, chat_message, event_alert, join_frame, parse_frame, CHAT_WS_URL,
};
use crate::integrations::twitch_chat::ChatTransport;
use crate::integrations::twitch_chat_control::{ConnectFn, EmitFn, SpawnFn};
use crate::protocol::event_types;

/// Пауза перед переподключением.
pub const RECONNECT_DELAY_MS: u64 = 3000;

/// Будущее поиска канала: имя или id → числовой `channel_id`.
pub type ResolveFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
/// Как получить `channel_id` по настройке канала.
pub type ResolveFn = Arc<dyn Fn(String) -> ResolveFuture + Send + Sync>;
/// Результат отправки сообщения (`{ ok, error? }`).
pub type SendFuture = Pin<Box<dyn Future<Output = Value> + Send>>;

/// Что отправить в живое соединение.
pub enum OutgoingKind {
    Message(String),
    Moderate {
        user_id: String,
        duration: Option<f64>,
        reason: String,
    },
}

/// Сообщение на отправку вместе с местом под ответ.
pub struct Outgoing {
    pub kind: OutgoingKind,
    pub reply: oneshot::Sender<Value>,
}

/// Одно подключение к GoodGame за раз.
pub struct GoodgameControl {
    connect: ConnectFn,
    resolve: ResolveFn,
    spawn: SpawnFn,
    reconnect_delay: Option<Duration>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    /// Канал отправки живого соединения; `None` — служба не подключена.
    outgoing: Mutex<Option<mpsc::UnboundedSender<Outgoing>>>,
}

impl GoodgameControl {
    pub fn new(connect: ConnectFn, resolve: ResolveFn, spawn: SpawnFn) -> Self {
        Self {
            connect,
            resolve,
            spawn,
            reconnect_delay: None,
            stop: Mutex::new(None),
            outgoing: Mutex::new(None),
        }
    }

    /// Повторять подключение после обрыва.
    pub fn with_reconnect(mut self, delay: Duration) -> Self {
        self.reconnect_delay = Some(delay);
        self
    }

    /// Переподключиться по текущим настройкам. Пустой канал — `not_configured`,
    /// выключенная служба — `disabled`; события уходят в `emit`.
    ///
    /// Токен не обязателен: без него чат читается как гость, а отправка
    /// отвечает `auth_error`.
    pub fn restart(&self, enabled: bool, channel: &str, user_id: &str, token: &str, emit: EmitFn) {
        self.stop();

        if !enabled {
            emit(connection_status("disabled"));
            return;
        }
        let channel = channel.trim().to_string();
        if channel.is_empty() {
            emit(connection_status("not_configured"));
            return;
        }
        let auth = if token.trim().is_empty() {
            None
        } else {
            Some((user_id.trim().to_string(), token.trim().to_string()))
        };

        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Outgoing>();
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        let connect = Arc::clone(&self.connect);
        let resolve = Arc::clone(&self.resolve);
        let delay = self.reconnect_delay;
        let task_emit = Arc::clone(&emit);

        let task = Box::pin(async move {
            loop {
                let channel_id = tokio::select! {
                    result = resolve(channel.clone()) => result,
                    _ = &mut stop_rx => return,
                };
                let channel_id = match channel_id {
                    Ok(id) => id,
                    Err(_) => {
                        task_emit(connection_status("connecting"));
                        task_emit(connection_status("error"));
                        match delay {
                            Some(delay) if !wait_or_stop(delay, &mut stop_rx).await => continue,
                            _ => return,
                        }
                    }
                };

                task_emit(connection_status("connecting"));
                let mut transport = match connect(CHAT_WS_URL.to_string()).await {
                    Ok(transport) => transport,
                    Err(_) => {
                        task_emit(connection_status("error"));
                        match delay {
                            Some(delay) if !wait_or_stop(delay, &mut stop_rx).await => continue,
                            _ => return,
                        }
                    }
                };
                let chat_emit = Arc::clone(&task_emit);
                let ended = tokio::select! {
                    _ = run_chat(
                        &mut *transport,
                        &channel_id,
                        auth.clone(),
                        &mut out_rx,
                        move |event| chat_emit(event),
                    ) => true,
                    _ = &mut stop_rx => false,
                };
                if !ended {
                    return;
                }
                // Соединение оборвалось: не копим отправку до следующего
                // подключения — чат-окно должно сразу показать ошибку.
                while let Ok(out) = out_rx.try_recv() {
                    let _ = out
                        .reply
                        .send(json!({ "ok": false, "error": "not_connected" }));
                }
                match delay {
                    Some(delay) if !wait_or_stop(delay, &mut stop_rx).await => continue,
                    _ => return,
                }
            }
        });

        (self.spawn)(task);
        *self.lock() = Some(stop_tx);
        *self
            .outgoing
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(out_tx);
    }

    /// Поставить сообщение в живое соединение; `None` — служба не подключена.
    pub fn send_message(&self, message: &str) -> Option<SendFuture> {
        let sender = self
            .outgoing
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()?;
        let text = message.trim().to_string();
        if text.is_empty() {
            return Some(Box::pin(async {
                json!({ "ok": false, "error": "empty_message" })
            }));
        }
        let (reply, answer) = oneshot::channel();
        if sender
            .send(Outgoing {
                kind: OutgoingKind::Message(text),
                reply,
            })
            .is_err()
        {
            return Some(Box::pin(async {
                json!({ "ok": false, "error": "not_connected" })
            }));
        }
        Some(Box::pin(async move {
            answer
                .await
                .unwrap_or_else(|_| json!({ "ok": false, "error": "not_connected" }))
        }))
    }

    /// Забанить или затаймаутить пользователя GoodGame; `duration: None` —
    /// бессрочно. `None` — служба не подключена.
    pub fn moderate_user(
        &self,
        user_id: &str,
        duration: Option<f64>,
        reason: &str,
    ) -> Option<SendFuture> {
        let sender = self
            .outgoing
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()?;
        let target = user_id.trim().to_string();
        if target.is_empty() || target.parse::<u64>().is_err() {
            return Some(Box::pin(async {
                json!({ "ok": false, "error": "missing_user_id" })
            }));
        }
        let (reply, answer) = oneshot::channel();
        if sender
            .send(Outgoing {
                kind: OutgoingKind::Moderate {
                    user_id: target,
                    duration,
                    reason: reason.to_string(),
                },
                reply,
            })
            .is_err()
        {
            return Some(Box::pin(async {
                json!({ "ok": false, "error": "not_connected" })
            }));
        }
        Some(Box::pin(async move {
            answer
                .await
                .unwrap_or_else(|_| json!({ "ok": false, "error": "not_connected" }))
        }))
    }

    /// Закрыть текущее соединение, если оно есть.
    pub fn stop(&self) {
        *self
            .outgoing
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        if let Some(stop) = self.lock().take() {
            let _ = stop.send(());
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<oneshot::Sender<()>>> {
        self.stop.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Прочитать один канал до обрыва. Заодно обслуживает отправку: сообщения из
/// `outgoing` уходят в тот же сокет, а результат возвращается в `reply`.
pub async fn run_chat<T, E>(
    transport: &mut T,
    channel_id: &str,
    auth: Option<(String, String)>,
    outgoing: &mut mpsc::UnboundedReceiver<Outgoing>,
    mut emit: E,
) where
    T: ChatTransport + ?Sized,
    E: FnMut(Value),
{
    if let Some((user_id, token)) = auth.as_ref() {
        if transport
            .send(auth_frame(user_id, token).to_string())
            .await
            .is_err()
        {
            emit(connection_status("error"));
            return;
        }
    }
    if transport
        .send(join_frame(channel_id).to_string())
        .await
        .is_err()
    {
        emit(connection_status("error"));
        return;
    }

    let mut authenticated = false;
    let mut joined = false;
    loop {
        tokio::select! {
            frame = transport.recv() => {
                let frame = match frame {
                    Ok(Some(frame)) => frame,
                    Ok(None) => break,
                    Err(_) => {
                        emit(connection_status("error"));
                        return;
                    }
                };
                if frame.is_empty() {
                    continue;
                }
                let Some((kind, data)) = parse_frame(&frame) else {
                    continue;
                };
                match kind.as_str() {
                    "success_auth" => authenticated = true,
                    "success_join" => {
                        joined = true;
                        emit(connection_status("connected"));
                    }
                    "message" => {
                        if let Some(message) = chat_message(&data) {
                            emit(bus_event(event_types::CHAT_MESSAGE, message));
                        }
                    }
                    "follower" | "payment" | "premium" | "gifted_premiums" => {
                        if let Some(alert) = event_alert(&kind, &data) {
                            emit(bus_event(event_types::ALERT, alert));
                        }
                    }
                    // `error` в протоколе не фатален: так приходят отказы
                    // модерации и жалобы на отдельное сообщение. Чтение
                    // продолжается.
                    _ => {}
                }
            }
            Some(out) = outgoing.recv() => {
                let answer = if !joined {
                    json!({ "ok": false, "error": "not_connected" })
                } else if !authenticated {
                    json!({ "ok": false, "error": "auth_error" })
                } else {
                    let frame = match &out.kind {
                        OutgoingKind::Message(text) => message_frame(channel_id, text),
                        OutgoingKind::Moderate {
                            user_id,
                            duration,
                            reason,
                        } => moderate_frame(channel_id, user_id, *duration, reason),
                    };
                    let sent = transport.send(frame.to_string()).await;
                    match sent {
                        Ok(()) => json!({ "ok": true }),
                        Err(_) => {
                            let _ = out.reply.send(json!({ "ok": false, "error": "send_failed" }));
                            emit(connection_status("error"));
                            return;
                        }
                    }
                };
                let _ = out.reply.send(answer);
            }
        }
    }

    emit(connection_status("disconnected"));
}

/// Кадр авторизации: `user_id` числом, токен — как есть.
pub fn auth_frame(user_id: &str, token: &str) -> Value {
    json!({
        "type": "auth",
        "data": {
            "user_id": user_id.trim().parse::<u64>().unwrap_or(0),
            "token": token.trim(),
        },
    })
}

/// Кадр отправки сообщения в канал.
pub fn message_frame(channel_id: &str, text: &str) -> Value {
    json!({
        "type": "send_message",
        "data": {
            "channel_id": channel_id,
            "text": text,
            "color": "",
            "icon": "",
            "role": "",
            "mobile": 0,
        },
    })
}

/// Кадр бана/таймаута. У GoodGame тип `0` — на время (минуты), `2` — бессрочно.
pub fn moderate_frame(
    channel_id: &str,
    user_id: &str,
    duration: Option<f64>,
    reason: &str,
) -> Value {
    let temporary = duration.is_some();
    let minutes = duration
        .map(|seconds| (seconds.max(1.0) / 60.0).ceil() as i64)
        .unwrap_or(0);
    json!({
        "type": "ban2",
        "data": {
            "userId": user_id.parse::<u64>().unwrap_or(0),
            "roomId": channel_id,
            "reason": reason,
            "comment": "",
            "type": if temporary { 0 } else { 2 },
            "duration": minutes,
            "deleteMessage": false,
        },
    })
}

/// Подождать `delay`, если не пришла остановка. `true` — остановка пришла.
async fn wait_or_stop(delay: Duration, stop: &mut oneshot::Receiver<()>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(delay) => false,
        _ = stop => true,
    }
}

/// Событие `connection_status` для службы GoodGame.
fn connection_status(status: &str) -> Value {
    json!({
        "type": event_types::CONNECTION_STATUS,
        "payload": { "service": "goodgame", "status": status },
    })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::integrations::twitch_chat::{RecvFuture, SendFuture as ChatSendFuture};

    type BoxedTask = Pin<Box<dyn Future<Output = ()> + Send>>;

    /// Транспорт с заготовленными кадрами; отправленное складывает в список.
    struct FakeTransport {
        incoming: VecDeque<String>,
        sent: Arc<Mutex<Vec<String>>>,
    }

    impl ChatTransport for FakeTransport {
        fn send(&mut self, line: String) -> ChatSendFuture<'_> {
            self.sent.lock().unwrap().push(line);
            Box::pin(async { Ok(()) })
        }

        fn recv(&mut self) -> RecvFuture<'_> {
            let next = self.incoming.pop_front();
            Box::pin(async move { Ok(next) })
        }
    }

    fn collector() -> (EmitFn, Arc<Mutex<Vec<Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let emit: EmitFn = Arc::new(move |event| sink.lock().unwrap().push(event));
        (emit, events)
    }

    fn playing_spawn() -> (SpawnFn, Arc<Mutex<Option<BoxedTask>>>) {
        let cell: Arc<Mutex<Option<BoxedTask>>> = Arc::new(Mutex::new(None));
        let store = Arc::clone(&cell);
        let spawn: SpawnFn = Arc::new(move |task| *store.lock().unwrap() = Some(task));
        (spawn, cell)
    }

    fn statuses(events: &Arc<Mutex<Vec<Value>>>) -> Vec<String> {
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event["type"] == json!(event_types::CONNECTION_STATUS))
            .map(|event| {
                event["payload"]["status"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            })
            .collect()
    }

    fn kind_of(events: &Arc<Mutex<Vec<Value>>>, kind: &str) -> Vec<Value> {
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event["type"] == json!(kind))
            .map(|event| event["payload"].clone())
            .collect()
    }

    fn resolve_to(id: &'static str) -> ResolveFn {
        Arc::new(move |_channel| Box::pin(async move { Ok(id.to_string()) }))
    }

    fn failing_resolve() -> ResolveFn {
        Arc::new(|_channel| Box::pin(async { Err("канал не найден".to_string()) }))
    }

    fn failing_connect() -> ConnectFn {
        Arc::new(|_url| Box::pin(async { Err("нет TLS".to_string()) }))
    }

    #[test]
    fn moderation_frames_map_duration_to_minutes() {
        let timeout = moderate_frame("5", "42", Some(120.0), "спам");
        assert_eq!(timeout["type"], json!("ban2"));
        assert_eq!(timeout["data"]["type"], json!(0));
        assert_eq!(timeout["data"]["duration"], json!(2));
        assert_eq!(timeout["data"]["userId"], json!(42));

        let permanent = moderate_frame("5", "42", None, "спам");
        assert_eq!(permanent["data"]["type"], json!(2));
        assert_eq!(permanent["data"]["duration"], json!(0));
    }

    #[tokio::test]
    async fn a_disabled_service_says_so_and_does_not_connect() {
        let (spawn, cell) = playing_spawn();
        let control = GoodgameControl::new(failing_connect(), failing_resolve(), spawn);
        let (emit, events) = collector();
        control.restart(false, "Miker", "", "", emit);
        assert!(cell.lock().unwrap().is_none());
        assert_eq!(statuses(&events), ["disabled"]);
        assert!(control.send_message("привет").is_none());
    }

    #[tokio::test]
    async fn an_empty_channel_is_not_configured() {
        let (spawn, cell) = playing_spawn();
        let control = GoodgameControl::new(failing_connect(), failing_resolve(), spawn);
        let (emit, events) = collector();
        control.restart(true, "   ", "", "", emit);
        assert!(cell.lock().unwrap().is_none());
        assert_eq!(statuses(&events), ["not_configured"]);
    }

    #[tokio::test]
    async fn a_failed_resolve_reports_connecting_then_error() {
        let (spawn, cell) = playing_spawn();
        let control = GoodgameControl::new(failing_connect(), failing_resolve(), spawn);
        let (emit, events) = collector();
        control.restart(true, "Miker", "", "", emit);
        let task = cell.lock().unwrap().take().expect("задача");
        task.await;
        assert_eq!(statuses(&events), ["connecting", "error"]);
    }

    #[tokio::test]
    async fn a_started_reader_streams_chat_and_events() {
        let (spawn, cell) = playing_spawn();
        let sent = Arc::new(Mutex::new(Vec::new()));
        let sent_in_task = Arc::clone(&sent);
        let connect: ConnectFn = Arc::new(move |_url| {
            let sent = Arc::clone(&sent_in_task);
            Box::pin(async move {
                let incoming = [
                    r#"{"type":"welcome","data":{"protocolVersion":2}}"#,
                    r#"{"type":"success_join","data":{"channel_id":"5"}}"#,
                    r#"{"type":"message","data":{"user_id":7,"user_name":"Зритель","text":"привет &amp; пока"}}"#,
                    r#"{"type":"follower","data":{"username":"Новичок"}}"#,
                    r#"{"type":"payment","data":{"userName":"Даритель","amount":"500.00","message":"на пиво"}}"#,
                ]
                .iter()
                .map(|frame| (*frame).to_string())
                .collect();
                Ok(Box::new(FakeTransport { incoming, sent }) as Box<dyn ChatTransport>)
            })
        });
        let control = GoodgameControl::new(connect, resolve_to("5"), spawn);
        let (emit, events) = collector();
        control.restart(true, "Miker", "", "", emit);
        let task = cell.lock().unwrap().take().expect("задача");
        task.await;

        assert_eq!(
            statuses(&events),
            ["connecting", "connected", "disconnected"]
        );
        // Первым кадром уходит join с найденным channel_id.
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert!(sent[0].contains(r#""channel_id":"5""#), "{}", sent[0]);

        let messages = kind_of(&events, event_types::CHAT_MESSAGE);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["user"], json!("Зритель"));
        assert_eq!(messages[0]["message"], json!("привет & пока"));
        assert_eq!(messages[0]["source"], json!("goodgame"));

        let alerts = kind_of(&events, event_types::ALERT);
        assert_eq!(alerts.len(), 2);
        assert_eq!(alerts[0]["kind"], json!("follow"));
        assert_eq!(alerts[1]["kind"], json!("donation"));
        assert_eq!(alerts[1]["amount"], json!(500));
    }

    /// Транспорт, который «висит»: соединение живое, кадров нет.
    struct HangingTransport;

    impl ChatTransport for HangingTransport {
        fn send(&mut self, _line: String) -> ChatSendFuture<'_> {
            Box::pin(async { Ok(()) })
        }

        fn recv(&mut self) -> RecvFuture<'_> {
            Box::pin(std::future::pending())
        }
    }

    /// Транспорт, который отдаёт заготовленные кадры и потом «висит»: так тест
    /// успевает отправить сообщение в живое соединение.
    struct ScriptedTransport {
        incoming: VecDeque<String>,
        sent: Arc<Mutex<Vec<String>>>,
    }

    impl ChatTransport for ScriptedTransport {
        fn send(&mut self, line: String) -> ChatSendFuture<'_> {
            self.sent.lock().unwrap().push(line);
            Box::pin(async { Ok(()) })
        }

        fn recv(&mut self) -> RecvFuture<'_> {
            match self.incoming.pop_front() {
                Some(next) => Box::pin(async move { Ok(Some(next)) }),
                None => Box::pin(std::future::pending()),
            }
        }
    }

    #[tokio::test]
    async fn an_authenticated_user_can_send_a_message() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let transport = ScriptedTransport {
            incoming: [
                r#"{"type":"success_auth","data":{"user_id":"7","user_name":"Я"}}"#,
                r#"{"type":"success_join","data":{"channel_id":"5"}}"#,
            ]
            .iter()
            .map(|frame| (*frame).to_string())
            .collect(),
            sent: Arc::clone(&sent),
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut transport = transport;
            run_chat(
                &mut transport,
                "5",
                Some(("7".to_string(), "secret".to_string())),
                &mut rx,
                |_| {},
            )
            .await;
        });
        // Дать сессии обработать auth и join.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let (reply, answer) = oneshot::channel();
        tx.send(Outgoing {
            kind: OutgoingKind::Message("привет".to_string()),
            reply,
        })
        .unwrap();
        let result = answer.await.expect("ответ");
        assert_eq!(result["ok"], json!(true));

        let sent = sent.lock().unwrap();
        assert_eq!(sent[0], auth_frame("7", "secret").to_string());
        assert!(sent[1].contains(r#""type":"join""#));
        assert!(sent
            .iter()
            .any(|frame| frame.contains(r#""type":"send_message""#) && frame.contains("привет")));
        task.abort();
    }

    #[tokio::test]
    async fn a_guest_cannot_send_and_gets_a_clear_error() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let transport = ScriptedTransport {
            incoming: [r#"{"type":"success_join","data":{"channel_id":"5"}}"#]
                .iter()
                .map(|frame| (*frame).to_string())
                .collect(),
            sent: Arc::clone(&sent),
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut transport = transport;
            run_chat(&mut transport, "5", None, &mut rx, |_| {}).await;
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let (reply, answer) = oneshot::channel();
        tx.send(Outgoing {
            kind: OutgoingKind::Message("привет".to_string()),
            reply,
        })
        .unwrap();
        let result = answer.await.expect("ответ");
        assert_eq!(result["ok"], json!(false));
        assert_eq!(result["error"], json!("auth_error"));
        task.abort();
    }

    #[tokio::test]
    async fn the_chat_reconnects_after_a_drop_until_stopped() {
        let connects = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&connects);
        let connect: ConnectFn = Arc::new(move |_url| {
            let attempt = counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if attempt == 0 {
                    Ok(Box::new(FakeTransport {
                        incoming: VecDeque::new(),
                        sent: Arc::new(Mutex::new(Vec::new())),
                    }) as Box<dyn ChatTransport>)
                } else {
                    Ok(Box::new(HangingTransport) as Box<dyn ChatTransport>)
                }
            })
        });
        let spawn: SpawnFn = Arc::new(|task| {
            std::mem::drop(tokio::spawn(task));
        });
        let control = GoodgameControl::new(connect, resolve_to("5"), spawn)
            .with_reconnect(Duration::from_millis(10));
        let (emit, _events) = collector();
        control.restart(true, "Miker", "", "", emit);

        for _ in 0..200 {
            if connects.load(Ordering::SeqCst) >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        control.stop();
        assert!(
            connects.load(Ordering::SeqCst) >= 2,
            "чат должен переподключиться после обрыва"
        );
    }
}
