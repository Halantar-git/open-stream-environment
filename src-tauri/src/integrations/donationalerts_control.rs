//! Подключение DonationAlerts: Centrifugo, OAuth и подписка.
//!
//! Порт обвязки `startDonationAlerts` из `server/integrations/donationalerts.js`.
//! Разбор кадров и payload — в [`crate::integrations::donationalerts`]; сокет,
//! OAuth-запрос и HTTP-подписка инжектируются, поэтому протокол проверяется без
//! сети.
//!
//! Отличия от JS, о которых стоит помнить:
//!   * сторож heartbeat (ping/pong) не заведён — о разрыве сообщает сокет, а
//!     tungstenite сам отвечает на серверные `ping`;
//!   * не повторяются редкие ветки (альтернативный формат кадра `connect` и
//!     переход в режим `http` при ошибке `3003`): они нужны для старых серверов.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::integrations::donationalerts::{
    alert_from_payload, extract_payload, goal_update, is_auth_error, is_donation_payload,
    is_unrecoverable_auth_error, message_channel,
};
use crate::integrations::twitch_chat_control::{ConnectFn, EmitFn, SpawnFn};
use crate::integrations::twitch_helix::TokenFuture;
use crate::protocol::event_types;

/// Сокет Centrifugo у DonationAlerts.
pub const CENTRIFUGO_WS: &str = "wss://centrifugo.donationalerts.com/connection/websocket";

const RECONNECT_MS: u64 = 5_000;
const AUTH_RECONNECT_MS: u64 = 15_000;

/// Итог OAuth: идентификатор пользователя и токен подключения к сокету.
#[derive(Debug, Clone)]
pub struct Oauth {
    pub user_id: String,
    pub connection_token: String,
}

/// Обмен access-токена на данные сокета (`GET /api/v1/user/oauth`).
pub type OauthFn = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<Oauth, String>> + Send>> + Send + Sync,
>;
/// Подписка на каналы (HTTP `/centrifuge/subscribe`): `channels`, `client`, токен
/// → список `{ channel, token }`.
pub type SubscribeFn = Arc<
    dyn Fn(
            Vec<String>,
            String,
            String,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<Value>, String>> + Send>>
        + Send
        + Sync,
>;

/// Одно подключение к DonationAlerts за раз.
pub struct DonationAlertsControl {
    connect: ConnectFn,
    oauth: OauthFn,
    subscribe: SubscribeFn,
    /// Актуальный access-токен (обновляется по необходимости).
    get_token: Arc<dyn Fn() -> TokenFuture + Send + Sync>,
    spawn: SpawnFn,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl DonationAlertsControl {
    pub fn new(
        connect: ConnectFn,
        oauth: OauthFn,
        subscribe: SubscribeFn,
        get_token: Arc<dyn Fn() -> TokenFuture + Send + Sync>,
        spawn: SpawnFn,
    ) -> Self {
        Self {
            connect,
            oauth,
            subscribe,
            get_token,
            spawn,
            stop: Mutex::new(None),
        }
    }

    /// Переподключиться: закрыть прежнее соединение и, если служба включена,
    /// поднять новое. События уходят в `emit`.
    pub fn restart(&self, enabled: bool, emit: EmitFn) {
        self.stop();
        if !enabled {
            emit(connection_status("disabled"));
            return;
        }

        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        let connect = Arc::clone(&self.connect);
        let oauth = Arc::clone(&self.oauth);
        let subscribe = Arc::clone(&self.subscribe);
        let get_token = Arc::clone(&self.get_token);
        let emit = Arc::clone(&emit);

        (self.spawn)(Box::pin(async move {
            let mut auth_delay = false;
            loop {
                emit(connection_status("connecting"));

                let token = match get_token().await {
                    Ok(token) if !token.is_empty() => token,
                    Ok(_) => {
                        // Токена нет: подключаться нечем, и повтор не поможет.
                        emit(connection_status("not_configured"));
                        return;
                    }
                    Err(message) => {
                        emit(connection_status("error"));
                        if is_unrecoverable_auth_error(&message) {
                            return;
                        }
                        // Пауза 15 с — только для авторизационных ошибок (как JS).
                        auth_delay = is_auth_error(&message);
                        if sleep_or_stop(&mut stop_rx, auth_delay).await {
                            return;
                        }
                        continue;
                    }
                };

                let session = match oauth(token.clone()).await {
                    Ok(session) => session,
                    Err(message) => {
                        emit(connection_status("error"));
                        if is_unrecoverable_auth_error(&message) {
                            return;
                        }
                        auth_delay = is_auth_error(&message);
                        if sleep_or_stop(&mut stop_rx, auth_delay).await {
                            return;
                        }
                        continue;
                    }
                };

                let Ok(mut transport) = connect(CENTRIFUGO_WS.to_string()).await else {
                    emit(connection_status("error"));
                    if sleep_or_stop(&mut stop_rx, auth_delay).await {
                        return;
                    }
                    continue;
                };

                // Centrifugo использует JSON-lines: кадр заканчивается переводом строки.
                let connect_id = 1u64;
                let frame =
                    json!({ "params": { "token": session.connection_token }, "id": connect_id });
                if transport.send(format!("{frame}\n")).await.is_err() {
                    emit(connection_status("error"));
                    if sleep_or_stop(&mut stop_rx, auth_delay).await {
                        return;
                    }
                    continue;
                }

                let mut command_id = 2u64;
                let mut subscribed = false;
                let clean = 'connection: loop {
                    tokio::select! {
                        _ = &mut stop_rx => return,
                        incoming = transport.recv() => match incoming {
                            Ok(Some(frame)) => {
                                for line in frame.split('\n').filter(|line| !line.trim().is_empty()) {
                                    let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else {
                                        continue;
                                    };
                                    if !subscribed
                                        && msg.get("id").and_then(Value::as_u64) == Some(connect_id)
                                    {
                                        let client = msg
                                            .get("result")
                                            .and_then(|result| {
                                                result.get("client").or_else(|| {
                                                    result.get("body").and_then(|body| body.get("client"))
                                                })
                                            })
                                            .map(crate::state::js_string)
                                            .unwrap_or_default();
                                        if client.is_empty() {
                                            continue;
                                        }
                                        let channels = vec![
                                            format!("$alerts:donation_{}", session.user_id),
                                            format!("$goals:goal_{}", session.user_id),
                                        ];
                                        match subscribe(channels, client, token.clone()).await {
                                            Ok(sub_channels) => {
                                                for channel in sub_channels {
                                                    let command = json!({
                                                        "method": "subscribe",
                                                        "params": {
                                                            "channel": channel.get("channel").cloned().unwrap_or(Value::Null),
                                                            "token": channel.get("token").cloned().unwrap_or(Value::Null),
                                                        },
                                                        "id": command_id,
                                                    });
                                                    command_id += 1;
                                                    if transport.send(format!("{command}\n")).await.is_err() {
                                                        break;
                                                    }
                                                }
                                                subscribed = true;
                                                // Удачное подключение снимает
                                                // авторизационную паузу.
                                                auth_delay = false;
                                                emit(connection_status("connected"));
                                            }
                                            Err(_) => {
                                                emit(connection_status("error"));
                                                break 'connection false;
                                            }
                                        }
                                        continue;
                                    }
                                    if msg.get("error").is_some() {
                                        // Ответ с ошибкой JS не считает фатальным
                                        // (кроме редкого 3003, который в порт не
                                        // переносился): сокет остаётся открытым.
                                        continue;
                                    }
                                    let Some(payload) = extract_payload(&msg) else {
                                        continue;
                                    };
                                    let channel = message_channel(&msg);
                                    if channel.starts_with("$alerts:donation") {
                                        if is_donation_payload(&payload) {
                                            emit(bus_event("alert", alert_from_payload(&payload)));
                                        }
                                    } else if channel.starts_with("$goals:goal") {
                                        if let Some(update) = goal_update(&payload) {
                                            emit(bus_event("goal_external_update", update));
                                        }
                                    }
                                }
                            }
                            Ok(None) | Err(_) => break 'connection true,
                        }
                    }
                };

                if clean {
                    emit(connection_status("disconnected"));
                }
                if sleep_or_stop(&mut stop_rx, auth_delay).await {
                    return;
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

    /// Актуальный access-токен (обновляется при необходимости) — для REST-добора
    /// пропущенных донатов.
    pub fn access_token(&self) -> TokenFuture {
        (self.get_token)()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<oneshot::Sender<()>>> {
        self.stop.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Пауза перед повтором; `true` — пришла остановка.
async fn sleep_or_stop(stop_rx: &mut oneshot::Receiver<()>, auth_delay: bool) -> bool {
    let delay = if auth_delay {
        AUTH_RECONNECT_MS
    } else {
        RECONNECT_MS
    };
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(delay)) => false,
        _ = stop_rx => true,
    }
}

/// Событие `connection_status` для службы донатов.
fn connection_status(status: &str) -> Value {
    json!({
        "type": event_types::CONNECTION_STATUS,
        "payload": { "service": "donationAlerts", "status": status },
    })
}

/// Событие шины в форме `bus.emit`.
fn bus_event(kind: &str, payload: Value) -> Value {
    json!({ "type": kind, "payload": payload })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;
    use crate::integrations::twitch_chat::{ChatTransport, RecvFuture, SendFuture};

    type BoxedTask = Pin<Box<dyn Future<Output = ()> + Send>>;

    struct FakeTransport {
        incoming: VecDeque<String>,
        sent: Arc<Mutex<Vec<String>>>,
    }

    impl ChatTransport for FakeTransport {
        fn send(&mut self, line: String) -> SendFuture<'_> {
            let sent = Arc::clone(&self.sent);
            Box::pin(async move {
                sent.lock().unwrap().push(line);
                Ok(())
            })
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

    fn token(value: &'static str) -> Arc<dyn Fn() -> TokenFuture + Send + Sync> {
        Arc::new(move || Box::pin(async move { Ok(value.to_string()) }))
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
    async fn a_connect_then_a_donation_push_becomes_an_alert() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let transport_sent = Arc::clone(&sent);
        let connect: ConnectFn = Arc::new(move |_url| {
            let sent = Arc::clone(&transport_sent);
            Box::pin(async move {
                let incoming = [
                    r#"{ "id": 1, "result": { "client": "c1" } }"#,
                    r#"{ "push": { "channel": "$alerts:donation_7", "pub": { "data": { "data": { "id": 5, "username": "fan", "amount": 300 } } } } }"#,
                ]
                .iter()
                .map(|frame| (*frame).to_string())
                .collect();
                Ok(Box::new(FakeTransport { incoming, sent }) as Box<dyn ChatTransport>)
            })
        });
        let oauth: OauthFn = Arc::new(|_token| {
            Box::pin(async {
                Ok(Oauth {
                    user_id: "7".to_string(),
                    connection_token: "ct".to_string(),
                })
            })
        });
        let subscribe: SubscribeFn = Arc::new(|_channels, _client, _token| {
            Box::pin(async {
                Ok(vec![
                    json!({ "channel": "$alerts:donation_7", "token": "st" }),
                ])
            })
        });
        let (spawn, cell) = playing_spawn();
        let control = DonationAlertsControl::new(connect, oauth, subscribe, token("tok"), spawn);
        let (emit, events) = collector();

        control.restart(true, emit);
        let task = cell.lock().unwrap().take().expect("задача");
        // Драйвер переподключается вечно — ждём первый проход и отпускаем.
        let _ = tokio::time::timeout(Duration::from_millis(200), task).await;

        assert_eq!(
            statuses(&events),
            ["connecting", "connected", "disconnected"]
        );
        assert_eq!(
            statuses(&events),
            ["connecting", "connected", "disconnected"]
        );
        // Кадр connect и кадр subscribe ушли в сокет.
        let sent = sent.lock().unwrap();
        assert!(sent[0].contains("connection_token") || sent[0].contains("ct"));
        assert!(sent[1].contains("\"method\":\"subscribe\""));

        let events = events.lock().unwrap();
        let alert = events
            .iter()
            .find(|event| event["type"] == json!("alert"))
            .expect("алерт");
        assert_eq!(alert["payload"]["amount"], json!(300));
        assert_eq!(alert["payload"]["sourceId"], json!("5"));
    }

    #[tokio::test]
    async fn a_goal_frame_becomes_a_goal_update() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let transport_sent = Arc::clone(&sent);
        let connect: ConnectFn = Arc::new(move |_url| {
            let sent = Arc::clone(&transport_sent);
            Box::pin(async move {
                let incoming = [
                    r#"{ "id": 1, "result": { "client": "c1" } }"#,
                    r#"{ "push": { "channel": "$goals:goal_7", "pub": { "data": { "data": { "raised": 150, "goal": 1000 } } } } }"#,
                ]
                .iter()
                .map(|frame| (*frame).to_string())
                .collect();
                Ok(Box::new(FakeTransport { incoming, sent }) as Box<dyn ChatTransport>)
            })
        });
        let oauth: OauthFn = Arc::new(|_token| {
            Box::pin(async {
                Ok(Oauth {
                    user_id: "7".to_string(),
                    connection_token: "ct".to_string(),
                })
            })
        });
        let subscribe: SubscribeFn =
            Arc::new(|_channels, _client, _token| Box::pin(async { Ok(Vec::new()) }));
        let (spawn, cell) = playing_spawn();
        let control = DonationAlertsControl::new(connect, oauth, subscribe, token("tok"), spawn);
        let (emit, events) = collector();

        control.restart(true, emit);
        let task = cell.lock().unwrap().take().expect("задача");
        let _ = tokio::time::timeout(Duration::from_millis(200), task).await;

        let events = events.lock().unwrap();
        let goal = events
            .iter()
            .find(|event| event["type"] == json!("goal_external_update"))
            .expect("цель");
        assert_eq!(goal["payload"], json!({ "current": 150, "target": 1000 }));
    }

    #[tokio::test]
    async fn without_a_token_nothing_connects() {
        let connect: ConnectFn =
            Arc::new(|_url| Box::pin(async { Err("нельзя".to_string()) }));
        let oauth: OauthFn = Arc::new(|_token| Box::pin(async { Err("нет".to_string()) }));
        let subscribe: SubscribeFn = Arc::new(|_c, _cl, _t| Box::pin(async { Ok(Vec::new()) }));
        let (spawn, cell) = playing_spawn();
        let control = DonationAlertsControl::new(connect, oauth, subscribe, token(""), spawn);
        let (emit, events) = collector();

        control.restart(true, emit);
        let task = cell.lock().unwrap().take().expect("задача");
        task.await;

        assert_eq!(statuses(&events), ["connecting", "not_configured"]);
    }

    #[tokio::test]
    async fn a_disabled_service_does_not_connect() {
        let connect: ConnectFn =
            Arc::new(|_url| Box::pin(async { Err("нельзя".to_string()) }));
        let oauth: OauthFn = Arc::new(|_token| Box::pin(async { Err("нет".to_string()) }));
        let subscribe: SubscribeFn = Arc::new(|_c, _cl, _t| Box::pin(async { Ok(Vec::new()) }));
        let (spawn, cell) = playing_spawn();
        let control = DonationAlertsControl::new(connect, oauth, subscribe, token("tok"), spawn);
        let (emit, events) = collector();

        control.restart(false, emit);

        assert!(cell.lock().unwrap().is_none());
        assert_eq!(statuses(&events), ["disabled"]);
    }
}
