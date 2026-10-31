//! Подключение к Twitch EventSub: welcome, переподключение и уведомления.
//!
//! Порт обвязки `startTwitchEvents` из `server/integrations/twitch-eventsub.js`.
//! Сам разбор событий — в [`crate::integrations::twitch_eventsub`], сокет — общий
//! с чатом (`tokio-tungstenite` с TLS), подписка — инжектируемая функция (в
//! приложении — HTTP-запрос к Helix, в тестах — заглушка). Поэтому протокол
//! проверяется без сети.
//!
//! Отличие от JS: сторож keepalive не заведён — о разрыве сообщает сам сокет;
//! при `session_reconnect` подписка не повторяется (Twitch её сохраняет), как и в
//! JS. После обрыва служба переподключается сама, а ошибка подписки даёт статус
//! `error` и повтор.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::integrations::twitch_chat_control::{ConnectFn, EmitFn, SpawnFn};
use crate::integrations::twitch_eventsub::{notification_events, parse_message, EventSubMessage};
use crate::protocol::event_types;

/// Куда подключается EventSub.
pub const EVENTS_WS_URL: &str = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";

/// Пауза перед переподключением после обрыва.
pub const RECONNECT_DELAY_MS: u64 = 3000;

/// Окно, в котором одинаковые подарочные уведомления считаются повтором
/// одного и того же подарка.
pub const GIFT_DEDUPE_MS: u128 = 2000;

/// Склейка массового подарка. Twitch может прислать один подарок несколькими
/// уведомлениями (по одному на получателя), и без склейки зритель видит
/// десятки одинаковых карточек подряд. Сравниваем пару «ник + число подписок»:
/// у одного подарка `total` во всех уведомлениях одинаков.
#[derive(Default)]
struct GiftDedupe {
    last: Option<(String, u64, std::time::Instant)>,
}

impl GiftDedupe {
    /// `true` — повтор: всю пачку (алерт и счётчик) пропускаем.
    fn is_repeat(&mut self, events: &[Value]) -> bool {
        let Some(alert) = events.iter().find_map(gift_alert) else {
            return false;
        };
        let user = alert
            .get("user")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let count = alert.get("count").and_then(Value::as_f64).unwrap_or(0.0);
        // Единичный подарок приходит без `total`: это отдельные покупки, их
        // склеивать нельзя — иначе потерялись бы настоящие подарки.
        if user.is_empty() || count < 2.0 {
            self.last = None;
            return false;
        }
        let now = std::time::Instant::now();
        let count = count as u64;
        if let Some((last_user, last_count, at)) = &self.last {
            if *last_user == user
                && *last_count == count
                && now.duration_since(*at).as_millis() <= GIFT_DEDUPE_MS
            {
                // Пачка может идти дольше одного уведомления — окно продлеваем.
                self.last = Some((user, count, now));
                return true;
            }
        }
        self.last = Some((user, count, now));
        false
    }
}

/// Нагрузка алерта о подарочной подписке в наборе событий уведомления.
fn gift_alert(event: &Value) -> Option<&Value> {
    if event.get("type").and_then(Value::as_str) != Some("alert") {
        return None;
    }
    let payload = event.get("payload")?;
    if payload.get("kind").and_then(Value::as_str) == Some("gift_sub") {
        Some(payload)
    } else {
        None
    }
}

/// Подписаться на события для сессии. В приложении — HTTP к Helix.
pub type SubscribeFn =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;
/// Текущий конфиг целиком — из него собираются события уведомления.
pub type ConfigFn = Arc<dyn Fn() -> Value + Send + Sync>;

/// Начальные счётчики после подписки (`fetchInitialStats`): снимок или `None`.
pub type StatsFn =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Option<Value>> + Send>> + Send + Sync>;

/// Одно подключение к EventSub за раз.
pub struct TwitchEventsControl {
    connect: ConnectFn,
    subscribe: SubscribeFn,
    spawn: SpawnFn,
    /// Пауза перед переподключением; `None` — не переподключаться (тесты).
    reconnect_delay: Option<Duration>,
    /// Начальные счётчики фолловеров/подписчиков — `fetchInitialStats`.
    fetch_stats: Option<StatsFn>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl TwitchEventsControl {
    pub fn new(connect: ConnectFn, subscribe: SubscribeFn, spawn: SpawnFn) -> Self {
        Self {
            connect,
            subscribe,
            spawn,
            reconnect_delay: None,
            fetch_stats: None,
            stop: Mutex::new(None),
        }
    }

    /// Включить автоматическое переподключение (как сокет-хендлер в JS).
    pub fn with_reconnect(mut self, delay: Duration) -> Self {
        self.reconnect_delay = Some(delay);
        self
    }

    /// Включить добор начальных счётчиков после подписки.
    pub fn with_stats(mut self, fetch: StatsFn) -> Self {
        self.fetch_stats = Some(fetch);
        self
    }

    /// Переподключиться: закрыть прежнее соединение и, если служба включена,
    /// поднять новое. События уходят в `emit`.
    pub fn restart(&self, enabled: bool, config: ConfigFn, emit: EmitFn) {
        self.stop();
        if !enabled {
            emit(connection_status("disabled"));
            return;
        }

        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        let connect = Arc::clone(&self.connect);
        let subscribe = Arc::clone(&self.subscribe);
        let task_emit = Arc::clone(&emit);
        let delay = self.reconnect_delay;
        let fetch_stats = self.fetch_stats.clone();

        (self.spawn)(Box::pin(async move {
            let mut url = EVENTS_WS_URL.to_string();
            // После session_reconnect подписка не запрашивается: Twitch её хранит.
            let mut reconnecting = false;
            // Склейка подарочных подписок живёт дольше одного соединения: пачка
            // уведомлений может продолжиться после переподключения.
            let mut gifts = GiftDedupe::default();
            loop {
                task_emit(connection_status("connecting"));
                let Ok(mut transport) = connect(url.clone()).await else {
                    task_emit(connection_status("error"));
                    if reconnect_or_return(delay, &mut stop_rx).await {
                        return;
                    }
                    continue;
                };
                let outcome = loop {
                    tokio::select! {
                        // Остановку обрабатываем только между кадрами: подписка —
                        // короткий запрос, прерывать её на полпути незачем.
                        _ = &mut stop_rx => return,
                        incoming = transport.recv() => match incoming {
                            Ok(Some(frame)) => match parse_message(&frame) {
                                EventSubMessage::Welcome(session) => {
                                    if reconnecting {
                                        reconnecting = false;
                                        task_emit(connection_status("connected"));
                                    } else {
                                        match subscribe(session).await {
                                            Ok(()) => {
                                                task_emit(connection_status("connected"));
                                                // Начальные счётчики — как `fetchInitialStats`
                                                // после успешной подписки.
                                                if let Some(fetch) = &fetch_stats {
                                                    if let Some(snapshot) = fetch().await {
                                                        task_emit(json!({ "type": "stat_snapshot", "payload": snapshot }));
                                                    }
                                                }
                                            }
                                            Err(_) => {
                                                task_emit(connection_status("error"));
                                                break Outcome::Ended;
                                            }
                                        }
                                    }
                                }
                                EventSubMessage::Reconnect(new_url) => {
                                    reconnecting = true;
                                    break Outcome::Reconnect(new_url);
                                }
                                EventSubMessage::Keepalive => {}
                                EventSubMessage::Notification(payload) => {
                                    let events = notification_events(&(config)(), &payload);
                                    // Массовый подарок приходит несколькими уведомлениями:
                                    // второе и следующие про тот же подарок пропускаем целиком —
                                    // и карточку, и прирост подписчиков.
                                    if !gifts.is_repeat(&events) {
                                        for event in events {
                                            task_emit(event);
                                        }
                                    }
                                }
                                EventSubMessage::Other => {}
                            },
                            Ok(None) => {
                                task_emit(connection_status("disconnected"));
                                break Outcome::Ended;
                            }
                            Err(_) => {
                                task_emit(connection_status("error"));
                                break Outcome::Ended;
                            }
                        }
                    }
                };
                match outcome {
                    Outcome::Reconnect(new_url) => url = new_url,
                    Outcome::Ended => {
                        if reconnect_or_return(delay, &mut stop_rx).await {
                            return;
                        }
                        // Свежий сеанс — подписываемся заново.
                        reconnecting = false;
                    }
                }
            }
        }));

        *self.lock() = Some(stop_tx);
    }

    /// Закрыть текущее соединение.
    pub fn stop(&self) {
        if let Some(stop) = self.lock().take() {
            let _ = stop.send(());
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<oneshot::Sender<()>>> {
        self.stop.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Как завершилась сессия чтения кадров.
enum Outcome {
    /// Twitch попросил перейти на новый адрес (`session_reconnect`).
    Reconnect(String),
    /// Соединение оборвалось — можно переподключиться к тому же адресу.
    Ended,
}

/// Выход из чтения: `true` — остановиться (нет автопереподключения или пришёл
/// `stop`), `false` — подождать и подключиться заново.
async fn reconnect_or_return(delay: Option<Duration>, stop: &mut oneshot::Receiver<()>) -> bool {
    match delay {
        Some(delay) => tokio::select! {
            _ = tokio::time::sleep(delay) => false,
            _ = stop => true,
        },
        None => true,
    }
}

/// Событие `connection_status` для службы событий.
fn connection_status(status: &str) -> Value {
    json!({
        "type": event_types::CONNECTION_STATUS,
        "payload": { "service": "twitchEvents", "status": status },
    })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;
    use crate::integrations::twitch_chat::{ChatTransport, RecvFuture, SendFuture};

    type BoxedTask = Pin<Box<dyn Future<Output = ()> + Send>>;

    struct FakeTransport {
        incoming: VecDeque<String>,
    }

    impl ChatTransport for FakeTransport {
        fn send(&mut self, _line: String) -> SendFuture<'_> {
            Box::pin(async { Ok(()) })
        }

        fn recv(&mut self) -> RecvFuture<'_> {
            let next = self.incoming.pop_front();
            Box::pin(async move { Ok(next) })
        }
    }

    fn frames(frames: &[&str]) -> FakeTransport {
        FakeTransport {
            incoming: frames.iter().map(|frame| (*frame).to_string()).collect(),
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

    #[tokio::test]
    async fn a_welcome_subscribes_and_a_notification_turns_into_events() {
        let (spawn, cell) = playing_spawn();
        let subscribed: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&subscribed);
        let subscribe: SubscribeFn = Arc::new(move |session| {
            recorder.lock().unwrap().push(session);
            Box::pin(async { Ok(()) })
        });
        let connect: ConnectFn = Arc::new(|_url| {
            Box::pin(async {
                Ok(Box::new(frames(&[
                    r#"{ "metadata": { "message_type": "session_welcome" }, "payload": { "session": { "id": "s1" } } }"#,
                    r#"{ "metadata": { "message_type": "notification" }, "payload": { "subscription": { "type": "channel.follow" }, "event": { "user_name": "nova" } } }"#,
                ])) as Box<dyn ChatTransport>)
            })
        });
        let control = TwitchEventsControl::new(connect, subscribe, spawn);
        let (emit, events) = collector();
        let config: ConfigFn = Arc::new(|| json!({}));

        control.restart(true, config, emit);
        let task = cell.lock().unwrap().take().expect("задача");
        task.await;

        assert_eq!(*subscribed.lock().unwrap(), ["s1"]);
        assert_eq!(
            statuses(&events),
            ["connecting", "connected", "disconnected"]
        );
        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|event| event["type"] == json!("alert")
                && event["payload"]["kind"] == json!("follow")));
        assert!(events
            .iter()
            .any(|event| event["type"] == json!("stat_delta")));
    }

    #[tokio::test]
    async fn a_reconnect_welcomes_without_subscribing_again() {
        let (spawn, cell) = playing_spawn();
        let subscribed: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&subscribed);
        let subscribe: SubscribeFn = Arc::new(move |session| {
            recorder.lock().unwrap().push(session);
            Box::pin(async { Ok(()) })
        });
        let attempts = Arc::new(Mutex::new(0u32));
        let counter = Arc::clone(&attempts);
        let connect: ConnectFn = Arc::new(move |_url| {
            let counter = Arc::clone(&counter);
            Box::pin(async move {
                let mut count = counter.lock().unwrap();
                *count += 1;
                let stream = if *count == 1 {
                    frames(&[
                        r#"{ "metadata": { "message_type": "session_welcome" }, "payload": { "session": { "id": "s1" } } }"#,
                        r#"{ "metadata": { "message_type": "session_reconnect" }, "payload": { "session": { "reconnect_url": "wss://new" } } }"#,
                    ])
                } else {
                    frames(&[
                        r#"{ "metadata": { "message_type": "session_welcome" }, "payload": { "session": { "id": "s2" } } }"#,
                    ])
                };
                Ok(Box::new(stream) as Box<dyn ChatTransport>)
            })
        });
        let control = TwitchEventsControl::new(connect, subscribe, spawn);
        let (emit, events) = collector();
        let config: ConfigFn = Arc::new(|| json!({}));

        control.restart(true, config, emit);
        let task = cell.lock().unwrap().take().expect("задача");
        task.await;

        // Подписка была ровно один раз (при первом welcome), несмотря на два.
        assert_eq!(*subscribed.lock().unwrap(), ["s1"]);
        assert_eq!(
            statuses(&events),
            [
                "connecting",
                "connected",
                "connecting",
                "connected",
                "disconnected"
            ]
        );
        assert_eq!(*attempts.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn a_disabled_service_does_not_connect() {
        let (spawn, cell) = playing_spawn();
        let subscribe: SubscribeFn = Arc::new(|_session| Box::pin(async { Ok(()) }));
        let connect: ConnectFn =
            Arc::new(|_url| Box::pin(async { Err("нельзя".to_string()) }));
        let control = TwitchEventsControl::new(connect, subscribe, spawn);
        let (emit, events) = collector();
        let config: ConfigFn = Arc::new(|| json!({}));

        control.restart(false, config, emit);

        assert!(cell.lock().unwrap().is_none());
        assert_eq!(statuses(&events), ["disabled"]);
    }

    #[tokio::test]
    async fn a_failed_subscription_reports_an_error() {
        let (spawn, cell) = playing_spawn();
        let subscribe: SubscribeFn =
            Arc::new(|_session| Box::pin(async { Err("нет прав".to_string()) }));
        let connect: ConnectFn = Arc::new(|_url| {
            Box::pin(async {
                Ok(Box::new(frames(&[
                    r#"{ "metadata": { "message_type": "session_welcome" }, "payload": { "session": { "id": "s1" } } }"#,
                ])) as Box<dyn ChatTransport>)
            })
        });
        let control = TwitchEventsControl::new(connect, subscribe, spawn);
        let (emit, events) = collector();
        let config: ConfigFn = Arc::new(|| json!({}));

        control.restart(true, config, emit);
        let task = cell.lock().unwrap().take().expect("задача");
        task.await;

        assert_eq!(statuses(&events), ["connecting", "error"]);
    }

    fn gift_events(user: &str, count: Value) -> Vec<Value> {
        vec![
            json!({
                "type": "alert",
                "payload": { "kind": "gift_sub", "user": user, "count": count },
            }),
            json!({ "type": "stat_delta", "payload": { "subscriberDelta": count } }),
        ]
    }

    #[test]
    fn identical_gift_notifications_collapse_into_one() {
        let mut gifts = GiftDedupe::default();

        // Первый подарок проходит и запоминается.
        assert!(!gifts.is_repeat(&gift_events("nova", json!(40))));
        // Такая же пачка — это повтор, её пропускаем.
        assert!(gifts.is_repeat(&gift_events("nova", json!(40))));
        assert!(gifts.is_repeat(&gift_events("NOVA ", json!(40))));
        // Другой размер или другой даритель — новые подарки.
        assert!(!gifts.is_repeat(&gift_events("nova", json!(20))));
        assert!(!gifts.is_repeat(&gift_events("star_gazer", json!(20))));
        // Оборванная серия: следующее такое же уведомление снова показываем.
        assert!(!gifts.is_repeat(&gift_events("nova", json!(5))));
        assert!(gifts.is_repeat(&gift_events("nova", json!(5))));
    }

    #[test]
    fn single_gifts_are_never_collapsed() {
        // Единичный подарок приходит без `total` — это разные покупки.
        let mut gifts = GiftDedupe::default();
        assert!(!gifts.is_repeat(&gift_events("nova", Value::Null)));
        assert!(!gifts.is_repeat(&gift_events("nova", Value::Null)));
        assert!(!gifts.is_repeat(&gift_events("nova", json!(1))));
        assert!(!gifts.is_repeat(&gift_events("nova", json!(1))));
    }

    #[tokio::test]
    async fn a_mass_gift_notification_burst_emits_one_alert() {
        let (spawn, cell) = playing_spawn();
        let subscribe: SubscribeFn = Arc::new(|_session| Box::pin(async { Ok(()) }));
        let gift = r#"{ "metadata": { "message_type": "notification" }, "payload": { "subscription": { "type": "channel.subscription.gift" }, "event": { "user_name": "nova", "total": 40, "tier": "1000" } } }"#;
        let connect: ConnectFn = Arc::new(move |_url| {
            Box::pin(async move {
                Ok(Box::new(frames(&[
                    r#"{ "metadata": { "message_type": "session_welcome" }, "payload": { "session": { "id": "s1" } } }"#,
                    gift,
                    gift,
                    gift,
                ])) as Box<dyn ChatTransport>)
            })
        });
        let control = TwitchEventsControl::new(connect, subscribe, spawn);
        let (emit, events) = collector();
        let config: ConfigFn = Arc::new(|| json!({}));

        control.restart(true, config, emit);
        let task = cell.lock().unwrap().take().expect("задача");
        task.await;

        let events = events.lock().unwrap();
        let alerts: Vec<&Value> = events
            .iter()
            .filter(|event| {
                event["type"] == json!("alert") && event["payload"]["kind"] == json!("gift_sub")
            })
            .collect();
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0]["payload"]["count"], json!(40));

        // Прирост подписчиков тоже приходит один раз и на всё число.
        let deltas: Vec<&Value> = events
            .iter()
            .filter(|event| event["type"] == json!("stat_delta"))
            .collect();
        assert_eq!(deltas.len(), 1);
        assert_eq!(deltas[0]["payload"]["subscriberDelta"], json!(40));
    }
}
