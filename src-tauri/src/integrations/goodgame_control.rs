//! Подключение к чату GoodGame: поиск канала и чтение кадров v2.
//!
//! Обвязка `wss://chat-1.goodgame.ru/chat2/`: имя канала превращается в
//! числовой `channel_id` через `getchannelstatus`, затем одно соединение
//! присоединяется к чату и разбирает кадры разборщиком
//! [`crate::integrations::goodgame`]. Протокол чата не требует авторизации для
//! чтения — гость получает сообщения, фоллоу, донаты и премиумы.
//!
//! Транспорт и поиск канала инжектируются: контроллер проверяется без сети, а
//! настоящий WebSocket живёт в [`crate::integrations::twitch_chat_socket`].

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

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

/// Одно подключение к GoodGame за раз.
pub struct GoodgameControl {
    connect: ConnectFn,
    resolve: ResolveFn,
    spawn: SpawnFn,
    reconnect_delay: Option<Duration>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl GoodgameControl {
    pub fn new(connect: ConnectFn, resolve: ResolveFn, spawn: SpawnFn) -> Self {
        Self {
            connect,
            resolve,
            spawn,
            reconnect_delay: None,
            stop: Mutex::new(None),
        }
    }

    /// Повторять подключение после обрыва.
    pub fn with_reconnect(mut self, delay: Duration) -> Self {
        self.reconnect_delay = Some(delay);
        self
    }

    /// Переподключиться по текущим настройкам. Пустой канал — `not_configured`,
    /// выключенная служба — `disabled`; события уходят в `emit`.
    pub fn restart(&self, enabled: bool, channel: &str, emit: EmitFn) {
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
                    _ = run_chat(&mut *transport, &channel_id, move |event| chat_emit(event)) => {
                        true
                    }
                    _ = &mut stop_rx => false,
                };
                if !ended {
                    return;
                }
                match delay {
                    Some(delay) if !wait_or_stop(delay, &mut stop_rx).await => continue,
                    _ => return,
                }
            }
        });

        (self.spawn)(task);
        *self.lock() = Some(stop_tx);
    }

    /// Закрыть текущее соединение, если оно есть.
    pub fn stop(&self) {
        if let Some(stop) = self.lock().take() {
            let _ = stop.send(());
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<oneshot::Sender<()>>> {
        self.stop.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Прочитать один канал до обрыва. Возвращается, когда соединение закрылось
/// или сломалось.
pub async fn run_chat<T, E>(transport: &mut T, channel_id: &str, mut emit: E)
where
    T: ChatTransport + ?Sized,
    E: FnMut(Value),
{
    if transport
        .send(join_frame(channel_id).to_string())
        .await
        .is_err()
    {
        emit(connection_status("error"));
        return;
    }

    loop {
        let frame = match transport.recv().await {
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
            "success_join" => emit(connection_status("connected")),
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
            // `error` в протоколе не фатален: так приходят отказы модерации и
            // жалобы на отдельное сообщение. Чтение продолжается.
            _ => {}
        }
    }

    emit(connection_status("disconnected"));
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
    use crate::integrations::twitch_chat::{RecvFuture, SendFuture};

    type BoxedTask = Pin<Box<dyn Future<Output = ()> + Send>>;

    /// Транспорт с заготовленными кадрами; отправленное складывает в список.
    struct FakeTransport {
        incoming: VecDeque<String>,
        sent: Arc<Mutex<Vec<String>>>,
    }

    impl ChatTransport for FakeTransport {
        fn send(&mut self, line: String) -> SendFuture<'_> {
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

    #[tokio::test]
    async fn a_disabled_service_says_so_and_does_not_connect() {
        let (spawn, cell) = playing_spawn();
        let control = GoodgameControl::new(failing_connect(), failing_resolve(), spawn);
        let (emit, events) = collector();
        control.restart(false, "Miker", emit);
        assert!(cell.lock().unwrap().is_none());
        assert_eq!(statuses(&events), ["disabled"]);
    }

    #[tokio::test]
    async fn an_empty_channel_is_not_configured() {
        let (spawn, cell) = playing_spawn();
        let control = GoodgameControl::new(failing_connect(), failing_resolve(), spawn);
        let (emit, events) = collector();
        control.restart(true, "   ", emit);
        assert!(cell.lock().unwrap().is_none());
        assert_eq!(statuses(&events), ["not_configured"]);
    }

    #[tokio::test]
    async fn a_failed_resolve_reports_connecting_then_error() {
        let (spawn, cell) = playing_spawn();
        let control = GoodgameControl::new(failing_connect(), failing_resolve(), spawn);
        let (emit, events) = collector();
        control.restart(true, "Miker", emit);
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
        control.restart(true, "Miker", emit);
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
        fn send(&mut self, _line: String) -> SendFuture<'_> {
            Box::pin(async { Ok(()) })
        }

        fn recv(&mut self) -> RecvFuture<'_> {
            Box::pin(std::future::pending())
        }
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
        control.restart(true, "Miker", emit);

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
