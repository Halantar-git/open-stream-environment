//! Подключение к анонимному чату Twitch: одно активное соединение за раз.
//!
//! Порт обвязки `startTwitchChat`/`restartTwitchChat` из `server/index.js`:
//! сервис чата либо выключен, либо ждёт канал, либо читает его. Здесь только
//! жизненный цикл — сам протокол в [`crate::integrations::twitch_chat`], сокет в
//! [`crate::integrations::twitch_chat_socket`], а способ запустить фоновую
//! задачу и подключиться инжектируются. Поэтому контроллер проверяется без сети
//! и без рантайма: тест подставляет свой транспорт и сам проигрывает задачу.
//!
//! Остановка — через `oneshot`: задача гоняет `run_chat` и `stop` в `select!`,
//! поэтому прежнее соединение закрывается, когда приходит новое (или `stop`).

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::integrations::twitch_chat::{anonymous_nick, run_chat, ConnectFuture, IRC_WS_URL};
use crate::protocol::event_types;

/// Пауза перед переподключением — как автореконнект tmi.js в JS.
pub const RECONNECT_DELAY_MS: u64 = 3000;

/// Как подключиться к чату: URL → сокет. В приложении — WebSocket, в тестах —
/// заготовленный транспорт.
pub type ConnectFn = Arc<dyn Fn(String) -> ConnectFuture + Send + Sync>;

/// Как запустить фоновую задачу. В приложении — рантайм Tauri, в тестах — место
/// под задачу, которую тест проигрывает сам.
pub type SpawnFn = Arc<dyn Fn(Pin<Box<dyn Future<Output = ()> + Send>>) + Send + Sync>;

/// Куда уходят события шины.
pub type EmitFn = Arc<dyn Fn(Value) + Send + Sync>;

/// Одно подключение к чату за раз.
pub struct TwitchChatControl {
    connect: ConnectFn,
    spawn: SpawnFn,
    /// Пауза перед переподключением; `None` — не переподключаться (так ставят
    /// тесты, чтобы задача завершалась).
    reconnect_delay: Option<Duration>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl TwitchChatControl {
    pub fn new(connect: ConnectFn, spawn: SpawnFn) -> Self {
        Self {
            connect,
            spawn,
            reconnect_delay: None,
            stop: Mutex::new(None),
        }
    }

    /// Включить автоматическое переподключение (как `reconnect: true` у tmi.js).
    pub fn with_reconnect(mut self, delay: Duration) -> Self {
        self.reconnect_delay = Some(delay);
        self
    }

    /// Переподключиться: закрыть прежнее соединение и, если чат включён и канал
    /// задан, поднять новое. События уходят в `emit` (`{ type, payload }`).
    pub fn restart(&self, enabled: bool, channel: &str, emit: EmitFn) {
        self.stop();

        if !enabled {
            emit(connection_status("disabled"));
            return;
        }
        if channel.trim().is_empty() {
            emit(connection_status("not_configured"));
            return;
        }

        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let connect = Arc::clone(&self.connect);
        let url = IRC_WS_URL.to_string();
        let channel = channel.to_string();
        let delay = self.reconnect_delay;

        let task_emit = Arc::clone(&emit);
        let task = Box::pin(async move {
            // tmi.js переподключается сам: после обрыва снова читаем канал, пока
            // не остановят. Без этого любой обрыв сети убивал бы чтение чата
            // насовсем.
            let mut stop_rx = stop_rx;
            loop {
                let mut transport = match connect(url.clone()).await {
                    Ok(transport) => transport,
                    Err(_) => {
                        // Сокет не открылся: те же два статуса, что JS.
                        task_emit(connection_status("connecting"));
                        task_emit(connection_status("error"));
                        match delay {
                            Some(delay) if !wait_or_stop(delay, &mut stop_rx).await => continue,
                            _ => return,
                        }
                    }
                };
                let nick = anonymous_nick(anonymous_seed());
                let chat_emit = Arc::clone(&task_emit);
                let ended = tokio::select! {
                    _ = run_chat(&mut *transport, &channel, &nick, move |event| chat_emit(event)) => {
                        true
                    }
                    _ = &mut stop_rx => false,
                };
                if !ended {
                    return;
                }
                // Чтение оборвалось: пауза и повтор, если не остановили.
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

/// Подождать `delay`, если не пришла остановка. `true` — остановка пришла.
async fn wait_or_stop(delay: Duration, stop: &mut oneshot::Receiver<()>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(delay) => false,
        _ = stop => true,
    }
}

/// Событие `connection_status` для сервиса чата — в форме `commands::broadcast`.
fn connection_status(status: &str) -> Value {
    json!({
        "type": event_types::CONNECTION_STATUS,
        "payload": { "service": "twitchChat", "status": status },
    })
}

/// Семя анонимного ника: номер разносит подключения, чтобы Twitch не принял
/// второе за дубль первого.
fn anonymous_seed() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::integrations::twitch_chat::{ChatTransport, RecvFuture, SendFuture};

    type BoxedTask = Pin<Box<dyn Future<Output = ()> + Send>>;

    /// Транспорт с заранее заготовленными кадрами; отправленное не интересует.
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

    /// Собирает события шины в список.
    fn collector() -> (EmitFn, Arc<Mutex<Vec<Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let emit: EmitFn = Arc::new(move |event| sink.lock().unwrap().push(event));
        (emit, events)
    }

    /// Подменяет запуск задачи: не спавнит, а складывает, чтобы тест проиграл.
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

    fn messages(events: &Arc<Mutex<Vec<Value>>>) -> Vec<Value> {
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event["type"] == json!(event_types::CHAT_MESSAGE))
            .map(|event| event["payload"].clone())
            .collect()
    }

    fn failing_connect() -> ConnectFn {
        Arc::new(|_url| Box::pin(async { Err("нет TLS".to_string()) }))
    }

    #[tokio::test]
    async fn a_disabled_chat_says_so_and_does_not_connect() {
        let (spawn, cell) = playing_spawn();
        let control = TwitchChatControl::new(failing_connect(), spawn);
        let (emit, events) = collector();
        control.restart(false, "chan", emit);
        assert!(cell.lock().unwrap().is_none());
        assert_eq!(statuses(&events), ["disabled"]);
    }

    #[tokio::test]
    async fn an_empty_channel_is_not_configured() {
        let (spawn, cell) = playing_spawn();
        let control = TwitchChatControl::new(failing_connect(), spawn);
        let (emit, events) = collector();
        control.restart(true, "   ", emit);
        assert!(cell.lock().unwrap().is_none());
        assert_eq!(statuses(&events), ["not_configured"]);
    }

    #[tokio::test]
    async fn a_failed_connect_reports_connecting_then_error() {
        let (spawn, cell) = playing_spawn();
        let control = TwitchChatControl::new(failing_connect(), spawn);
        let (emit, events) = collector();
        control.restart(true, "chan", emit);
        let task = cell.lock().unwrap().take().expect("задача");
        task.await;
        assert_eq!(statuses(&events), ["connecting", "error"]);
    }

    #[tokio::test]
    async fn a_started_reader_streams_messages_and_statuses() {
        let (spawn, cell) = playing_spawn();
        let connect: ConnectFn = Arc::new(|_url| {
            Box::pin(async {
                let incoming = [
                    ":tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!\r\n",
                    ":zritel!zritel@zritel.tmi.twitch.tv PRIVMSG #chan :привет\r\n",
                ]
                .iter()
                .map(|line| (*line).to_string())
                .collect();
                Ok(Box::new(FakeTransport { incoming }) as Box<dyn ChatTransport>)
            })
        });
        let control = TwitchChatControl::new(connect, spawn);
        let (emit, events) = collector();
        control.restart(true, "Chan", emit);
        let task = cell.lock().unwrap().take().expect("задача");
        task.await;

        assert_eq!(
            statuses(&events),
            ["connecting", "connected", "disconnected"]
        );
        let messages = messages(&events);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["message"], json!("привет"));
        assert_eq!(messages[0]["source"], json!("twitch"));
    }

    /// Транспорт, который «висит»: `recv` не завершается (живое соединение).
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
                    // Первое соединение сразу обрывается.
                    let incoming = [":tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!\r\n"]
                        .into_iter()
                        .map(String::from)
                        .collect();
                    Ok(Box::new(FakeTransport { incoming }) as Box<dyn ChatTransport>)
                } else {
                    // Дальше соединение держится, пока его не остановят.
                    Ok(Box::new(HangingTransport) as Box<dyn ChatTransport>)
                }
            })
        });
        let spawn: SpawnFn = Arc::new(|task| {
            std::mem::drop(tokio::spawn(task));
        });
        let control =
            TwitchChatControl::new(connect, spawn).with_reconnect(Duration::from_millis(10));
        let (emit, _events) = collector();
        control.restart(true, "chan", emit);

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
