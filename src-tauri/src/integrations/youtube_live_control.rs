//! Опрос YouTube Live: поиск эфира и чтение чата.
//!
//! Порт обвязки `startYoutube` из `server/integrations/youtube-live.js` поверх
//! разборщика [`crate::integrations::youtube_live`]. HTTP и обмен токенов
//! инжектируются, поэтому последовательность опроса проверяется без сети.
//!
//! Отличия от JS: журнал не переносим (его место — события шины), а паузы между
//! опросами делает `sleep` в фоновой задаче вместо `setTimeout`; остановка —
//! `oneshot`, как у остальных контроллеров. Отказ `liveChatMessages` решается так
//! же: `404` и `403` с причиной «чат кончился» сбрасывают `liveChatId` и ищут
//! эфир заново, остальные `403` ждут `QUOTA_BACKOFF_MS`.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::integrations::twitch_chat_control::{EmitFn, SpawnFn};
use crate::integrations::twitch_helix::Tokens;
use crate::integrations::youtube_live::{
    chat_message_from_item, classify_live_chat_failure, event_alert_from_item, polling_interval,
    MIN_POLL_MS, QUOTA_BACKOFF_MS, RETRY_DELAY_MS,
};
use crate::protocol::event_types;
use crate::storage::history::js_truthy;

/// Обмен `refresh_token` на `access_token` в Google.
pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
/// Список своих трансляций — из него берётся `liveChatId`.
pub const LIVE_BROADCASTS_URL: &str = "https://www.googleapis.com/youtube/v3/liveBroadcasts";
/// Опрос сообщений чата.
pub const LIVE_CHAT_URL: &str = "https://www.googleapis.com/youtube/v3/liveChatMessages";
/// Запасной поиск `activeLiveChatId` по `videoId`.
pub const VIDEOS_URL: &str = "https://www.googleapis.com/youtube/v3/videos";

/// Будущее GET: статус и **сырое** тело — причины отказа бывают не-JSON.
pub type GetFuture = Pin<Box<dyn Future<Output = (u16, String)> + Send>>;
/// GET с `Bearer`: URL и токен → статус и тело.
pub type GetFn = Arc<dyn Fn(String, String) -> GetFuture + Send + Sync>;
/// Текущие настройки YouTube: нужен `videoId` для запасного поиска.
pub type YoutubeConfigFn = Arc<dyn Fn() -> Value + Send + Sync>;

/// Одно опрашивающее соединение за раз.
pub struct YoutubeLiveControl {
    get: GetFn,
    tokens: Tokens,
    config: YoutubeConfigFn,
    spawn: SpawnFn,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl YoutubeLiveControl {
    pub fn new(get: GetFn, tokens: Tokens, config: YoutubeConfigFn, spawn: SpawnFn) -> Self {
        Self {
            get,
            tokens,
            config,
            spawn,
            stop: Mutex::new(None),
        }
    }

    /// Переподключиться: закрыть прежний опрос и, если служба включена, поднять
    /// новый. События уходят в `emit`.
    pub fn restart(&self, enabled: bool, emit: EmitFn) {
        self.stop();
        if !enabled {
            emit(connection_status("disabled"));
            return;
        }

        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        let get = Arc::clone(&self.get);
        let tokens = self.tokens.clone();
        let config = Arc::clone(&self.config);
        let task_emit = Arc::clone(&emit);

        (self.spawn)(Box::pin(async move {
            let mut live_chat_id: Option<String> = None;
            let mut next_page_token: Option<String> = None;
            task_emit(connection_status("connecting"));
            loop {
                let delay = tick(
                    &get,
                    &tokens,
                    &config,
                    &task_emit,
                    &mut live_chat_id,
                    &mut next_page_token,
                )
                .await;
                if sleep_or_stop(&mut stop_rx, delay).await {
                    return;
                }
            }
        }));

        *self.lock() = Some(stop_tx);
    }

    /// Закрыть текущий опрос.
    pub fn stop(&self) {
        if let Some(stop) = self.lock().take() {
            let _ = stop.send(());
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<oneshot::Sender<()>>> {
        self.stop.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Один шаг опроса. Возвращает паузу до следующего — как `scheduleTick`.
///
/// Состояние `liveChatId`/`nextPageToken` живёт между шагами, поэтому приходит
/// ссылками: сброс IDs здесь и есть «поиск эфира заново» на следующем шаге.
async fn tick(
    get: &GetFn,
    tokens: &Tokens,
    config: &YoutubeConfigFn,
    emit: &EmitFn,
    live_chat_id: &mut Option<String>,
    next_page_token: &mut Option<String>,
) -> u64 {
    let access_token = match (tokens.ensure)().await {
        Ok(token) => token,
        Err(_) => {
            emit(connection_status("error"));
            return RETRY_DELAY_MS;
        }
    };
    if access_token.is_empty() {
        emit(connection_status("not_configured"));
        return RETRY_DELAY_MS;
    }

    if live_chat_id.is_none() {
        match resolve_live_chat_id(get, tokens, config, &access_token).await {
            Ok(id) => {
                *live_chat_id = Some(id);
                emit(connection_status("connected"));
            }
            Err(_) => {
                emit(connection_status("error"));
                return RETRY_DELAY_MS;
            }
        }
    }
    let chat_id = live_chat_id.clone().unwrap_or_default();

    let mut url = format!(
        "{LIVE_CHAT_URL}?part=snippet,authorDetails&liveChatId={}",
        encode_uri_component(&chat_id)
    );
    if let Some(token) = next_page_token.as_deref().filter(|token| !token.is_empty()) {
        url.push_str(&format!("&pageToken={}", encode_uri_component(token)));
    }

    let (status, body) = (get)(url, access_token.clone()).await;

    if status == 401 {
        // Токен протух: обновляем и пробуем снова на следующем шаге.
        if (tokens.refresh)().await.is_err() {
            emit(connection_status("error"));
            return RETRY_DELAY_MS;
        }
        return MIN_POLL_MS;
    }
    if status == 404 {
        *live_chat_id = None;
        *next_page_token = None;
        emit(connection_status("connecting"));
        return RETRY_DELAY_MS;
    }
    if status == 403 {
        if classify_live_chat_failure(&body) == "ended" {
            *live_chat_id = None;
            *next_page_token = None;
            emit(connection_status("connecting"));
            return RETRY_DELAY_MS;
        }
        return QUOTA_BACKOFF_MS;
    }
    if !(200..300).contains(&status) {
        emit(connection_status("error"));
        return RETRY_DELAY_MS;
    }

    let Ok(json) = serde_json::from_str::<Value>(&body) else {
        emit(connection_status("error"));
        return RETRY_DELAY_MS;
    };

    // `json.nextPageToken || null`: пустая строка так же ложна, как отсутствие.
    *next_page_token = json
        .get("nextPageToken")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string);

    for item in json
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let kind = item
            .get("snippet")
            .and_then(|snippet| snippet.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        match kind {
            "textMessageEvent" => emit(bus_event(
                event_types::CHAT_MESSAGE,
                chat_message_from_item(&item),
            )),
            "superChatEvent"
            | "superStickerEvent"
            | "newSponsorEvent"
            | "memberMilestoneChatEvent" => {
                if let Some(alert) = event_alert_from_item(&item) {
                    emit(bus_event(event_types::ALERT, alert));
                }
            }
            _ => {}
        }
    }

    polling_interval(&json)
}

/// Найти `liveChatId`: своя трансляция (`mine=true`), иначе — по `videoId`.
///
/// `mine=true` несовместим с `broadcastStatus` (сервер ответил бы `400`),
/// поэтому жизнь эфира проверяем сами по `status.lifeCycleStatus`.
async fn resolve_live_chat_id(
    get: &GetFn,
    tokens: &Tokens,
    config: &YoutubeConfigFn,
    access_token: &str,
) -> Result<String, String> {
    let url = format!("{LIVE_BROADCASTS_URL}?part=snippet,status&mine=true");
    let (status, body) = get_with_retry(get, tokens, url, access_token.to_string()).await?;
    if !(200..300).contains(&status) {
        return Err(format!("liveBroadcasts: {status} {body}"));
    }
    let json: Value = serde_json::from_str(&body).map_err(|error| error.to_string())?;
    let live = json
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                matches!(
                    item.get("status")
                        .and_then(|status| status.get("lifeCycleStatus"))
                        .and_then(Value::as_str),
                    Some("live") | Some("testing") | Some("ready")
                )
            })
        });
    if let Some(id) = live
        .and_then(|item| item.get("snippet"))
        .and_then(|snippet| snippet.get("liveChatId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        return Ok(id.to_string());
    }

    let video_id = (config)().get("videoId").cloned().unwrap_or(Value::Null);
    if js_truthy(Some(&video_id)) {
        return resolve_from_video(
            get,
            tokens,
            &crate::state::js_string(&video_id),
            access_token,
        )
        .await;
    }

    Err("no active live broadcast with liveChatId".to_string())
}

/// Запасной путь: `activeLiveChatId` конкретного ролика из настроек.
async fn resolve_from_video(
    get: &GetFn,
    tokens: &Tokens,
    video_id: &str,
    access_token: &str,
) -> Result<String, String> {
    let url = format!(
        "{VIDEOS_URL}?part=liveStreamingDetails&id={}",
        encode_uri_component(video_id)
    );
    let (status, body) = get_with_retry(get, tokens, url, access_token.to_string()).await?;
    if !(200..300).contains(&status) {
        return Err(format!("videos.list: {status} {body}"));
    }
    let json: Value = serde_json::from_str(&body).map_err(|error| error.to_string())?;
    json.get("items")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("liveStreamingDetails"))
        .and_then(|details| details.get("activeLiveChatId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "video has no activeLiveChatId (stream may not be live)".to_string())
}

/// GET с повтором после `401`: обновляем токен и пробуем тот же адрес снова.
async fn get_with_retry(
    get: &GetFn,
    tokens: &Tokens,
    url: String,
    mut token: String,
) -> Result<(u16, String), String> {
    let mut outcome = (get)(url.clone(), token.clone()).await;
    if outcome.0 == 401 {
        token = (tokens.refresh)().await?;
        outcome = (get)(url, token).await;
    }
    Ok(outcome)
}

/// Пауза перед следующим шагом; `true` — пришла остановка.
async fn sleep_or_stop(stop_rx: &mut oneshot::Receiver<()>, delay_ms: u64) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => false,
        _ = stop_rx => true,
    }
}

/// Событие `connection_status` для службы YouTube.
fn connection_status(status: &str) -> Value {
    json!({
        "type": event_types::CONNECTION_STATUS,
        "payload": { "service": "youtube", "status": status },
    })
}

/// Событие шины в форме `bus.emit`.
fn bus_event(kind: &str, payload: Value) -> Value {
    json!({ "type": kind, "payload": payload })
}

/// `encodeURIComponent`: не трогает `A-Za-z0-9-_.!~*'()`, остальное — `%XX`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    fn collector() -> (EmitFn, Arc<Mutex<Vec<Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        let emit: EmitFn = Arc::new(move |event| sink.lock().unwrap().push(event));
        (emit, events)
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

    /// Токены с готовым ответом: `ensure` — как есть, `refresh` считает вызовы.
    fn tokens(ensure: &str) -> (Tokens, Arc<Mutex<u32>>) {
        let ensure_value = ensure.to_string();
        let refreshes = Arc::new(Mutex::new(0u32));
        let counter = Arc::clone(&refreshes);
        (
            Tokens {
                ensure: Arc::new(move || {
                    let value = ensure_value.clone();
                    Box::pin(async move { Ok(value) })
                }),
                refresh: Arc::new(move || {
                    let counter = Arc::clone(&counter);
                    Box::pin(async move {
                        *counter.lock().unwrap() += 1;
                        Ok("refreshed".to_string())
                    })
                }),
            },
            refreshes,
        )
    }

    /// Ответы по адресам: `broadcasts`, `videos`, `chat` — очереди в порядке
    /// обращений. Запросы пишутся в журнал (URL и токен).
    #[derive(Default)]
    struct Script {
        broadcasts: VecDeque<(u16, String)>,
        videos: VecDeque<(u16, String)>,
        chat: VecDeque<(u16, String)>,
        calls: Vec<(String, String)>,
    }

    fn script() -> Arc<Mutex<Script>> {
        Arc::new(Mutex::new(Script::default()))
    }

    fn queue(script: &Arc<Mutex<Script>>, kind: &str, status: u16, body: &str) {
        let mut script = script.lock().unwrap();
        let queue = match kind {
            "broadcasts" => &mut script.broadcasts,
            "videos" => &mut script.videos,
            _ => &mut script.chat,
        };
        queue.push_back((status, body.to_string()));
    }

    fn get_for(script: Arc<Mutex<Script>>) -> GetFn {
        Arc::new(move |url: String, token: String| {
            let script = Arc::clone(&script);
            Box::pin(async move {
                let mut script = script.lock().unwrap();
                script.calls.push((url.clone(), token));
                let queue = if url.contains("liveBroadcasts") {
                    &mut script.broadcasts
                } else if url.contains("liveChatMessages") {
                    &mut script.chat
                } else {
                    &mut script.videos
                };
                queue.pop_front().unwrap_or((200, "{}".to_string()))
            })
        })
    }

    fn config(video_id: &str) -> YoutubeConfigFn {
        let value = json!({ "videoId": video_id });
        Arc::new(move || value.clone())
    }

    const BROADCAST_LIVE: &str = r#"{ "items": [ { "snippet": { "liveChatId": "chat1" }, "status": { "lifeCycleStatus": "live" } } ] }"#;

    #[tokio::test]
    async fn a_live_chat_turns_into_messages_and_alerts() {
        let script = script();
        queue(&script, "broadcasts", 200, BROADCAST_LIVE);
        queue(
            &script,
            "chat",
            200,
            r#"{ "items": [
                { "snippet": { "type": "textMessageEvent", "textMessageDetails": { "messageText": "привет" } },
                  "authorDetails": { "displayName": "Зритель", "channelId": "UC1" } },
                { "snippet": { "type": "superChatEvent", "superChatDetails": { "amountMicros": "5000000", "currency": "RUB", "userComment": "Круто" } },
                  "authorDetails": { "displayName": "Фанат" } }
            ], "nextPageToken": "next", "pollingIntervalMillis": 2000 }"#,
        );
        let (emit, events) = collector();
        let (tokens, _) = tokens("token");
        let get = get_for(Arc::clone(&script));
        let config = config("");

        let mut live_chat_id = None;
        let mut next_page_token = None;
        let delay = tick(
            &get,
            &tokens,
            &config,
            &emit,
            &mut live_chat_id,
            &mut next_page_token,
        )
        .await;

        assert_eq!(delay, 2000);
        assert_eq!(live_chat_id.as_deref(), Some("chat1"));
        assert_eq!(next_page_token.as_deref(), Some("next"));
        assert_eq!(statuses(&events), ["connected"]);
        let events = events.lock().unwrap();
        let message = events
            .iter()
            .find(|event| event["type"] == json!(event_types::CHAT_MESSAGE))
            .expect("сообщение чата");
        assert_eq!(message["payload"]["user"], json!("Зритель"));
        assert_eq!(message["payload"]["message"], json!("привет"));
        assert_eq!(message["payload"]["source"], json!("youtube"));
        let alert = events
            .iter()
            .find(|event| event["type"] == json!(event_types::ALERT))
            .expect("алерт");
        assert_eq!(alert["payload"]["kind"], json!("donation"));
        assert_eq!(alert["payload"]["amount"], json!(5));
    }

    #[tokio::test]
    async fn a_second_poll_carries_the_page_token() {
        let script = script();
        queue(&script, "broadcasts", 200, BROADCAST_LIVE);
        queue(
            &script,
            "chat",
            200,
            r#"{ "items": [], "nextPageToken": "page2" }"#,
        );
        queue(&script, "chat", 200, r#"{ "items": [] }"#);
        let (emit, _events) = collector();
        let (tokens, _) = tokens("token");
        let get = get_for(Arc::clone(&script));
        let config = config("");

        let mut live_chat_id = None;
        let mut next_page_token = None;
        tick(
            &get,
            &tokens,
            &config,
            &emit,
            &mut live_chat_id,
            &mut next_page_token,
        )
        .await;
        tick(
            &get,
            &tokens,
            &config,
            &emit,
            &mut live_chat_id,
            &mut next_page_token,
        )
        .await;

        let calls = script.lock().unwrap().calls.clone();
        let polls: Vec<&String> = calls
            .iter()
            .map(|(url, _)| url)
            .filter(|url| url.contains("liveChatMessages"))
            .collect();
        assert_eq!(polls.len(), 2);
        assert!(!polls[0].contains("pageToken="));
        assert!(polls[1].contains("pageToken=page2"));
        // Эфир ищется один раз: дальше чат уже известен.
        assert_eq!(
            calls
                .iter()
                .filter(|(url, _)| url.contains("liveBroadcasts"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn an_ended_chat_resets_the_id_and_looks_for_a_new_broadcast() {
        let script = script();
        queue(&script, "broadcasts", 200, BROADCAST_LIVE);
        queue(
            &script,
            "chat",
            403,
            r#"{ "error": { "errors": [ { "reason": "liveChatEnded" } ] } }"#,
        );
        let (emit, events) = collector();
        let (tokens, _) = tokens("token");
        let get = get_for(Arc::clone(&script));
        let config = config("");

        let mut live_chat_id = None;
        let mut next_page_token = None;
        let delay = tick(
            &get,
            &tokens,
            &config,
            &emit,
            &mut live_chat_id,
            &mut next_page_token,
        )
        .await;

        assert_eq!(delay, RETRY_DELAY_MS);
        assert!(live_chat_id.is_none());
        // `connected` — после поиска, `connecting` — после сброса.
        assert_eq!(statuses(&events), ["connected", "connecting"]);
    }

    #[tokio::test]
    async fn a_quota_limit_backs_off_without_losing_the_chat() {
        let script = script();
        queue(&script, "broadcasts", 200, BROADCAST_LIVE);
        queue(
            &script,
            "chat",
            403,
            r#"{ "error": { "errors": [ { "reason": "quotaExceeded" } ] } }"#,
        );
        let (emit, events) = collector();
        let (tokens, _) = tokens("token");
        let get = get_for(Arc::clone(&script));
        let config = config("");

        let mut live_chat_id = None;
        let mut next_page_token = None;
        let delay = tick(
            &get,
            &tokens,
            &config,
            &emit,
            &mut live_chat_id,
            &mut next_page_token,
        )
        .await;

        assert_eq!(delay, QUOTA_BACKOFF_MS);
        assert_eq!(live_chat_id.as_deref(), Some("chat1"));
        assert_eq!(statuses(&events), ["connected"]);
    }

    #[tokio::test]
    async fn a_missing_chat_is_reset_on_404() {
        let script = script();
        queue(&script, "broadcasts", 200, BROADCAST_LIVE);
        queue(&script, "chat", 404, "");
        let (emit, events) = collector();
        let (tokens, _) = tokens("token");
        let get = get_for(Arc::clone(&script));
        let config = config("");

        let mut live_chat_id = None;
        let mut next_page_token = Some("stale".to_string());
        let delay = tick(
            &get,
            &tokens,
            &config,
            &emit,
            &mut live_chat_id,
            &mut next_page_token,
        )
        .await;

        assert_eq!(delay, RETRY_DELAY_MS);
        assert!(live_chat_id.is_none());
        assert!(next_page_token.is_none());
        assert_eq!(statuses(&events), ["connected", "connecting"]);
    }

    #[tokio::test]
    async fn an_expired_poll_token_is_refreshed() {
        let script = script();
        queue(&script, "broadcasts", 200, BROADCAST_LIVE);
        queue(&script, "chat", 401, "");
        let (emit, events) = collector();
        let (tokens, refreshes) = tokens("token");
        let get = get_for(Arc::clone(&script));
        let config = config("");

        let mut live_chat_id = None;
        let mut next_page_token = None;
        let delay = tick(
            &get,
            &tokens,
            &config,
            &emit,
            &mut live_chat_id,
            &mut next_page_token,
        )
        .await;

        assert_eq!(delay, MIN_POLL_MS);
        assert_eq!(*refreshes.lock().unwrap(), 1);
        assert_eq!(live_chat_id.as_deref(), Some("chat1"));
        assert_eq!(statuses(&events), ["connected"]);
    }

    #[tokio::test]
    async fn a_broadcast_without_a_chat_falls_back_to_the_video_id() {
        let script = script();
        queue(
            &script,
            "broadcasts",
            200,
            r#"{ "items": [ { "snippet": {}, "status": { "lifeCycleStatus": "complete" } } ] }"#,
        );
        queue(
            &script,
            "videos",
            200,
            r#"{ "items": [ { "liveStreamingDetails": { "activeLiveChatId": "fromVideo" } } ] }"#,
        );
        let (emit, events) = collector();
        let (tokens, _) = tokens("token");
        let get = get_for(Arc::clone(&script));
        let config = config("vid123");

        let mut live_chat_id = None;
        let mut next_page_token = None;
        queue(&script, "chat", 200, r#"{ "items": [] }"#);
        let _ = tick(
            &get,
            &tokens,
            &config,
            &emit,
            &mut live_chat_id,
            &mut next_page_token,
        )
        .await;

        assert_eq!(live_chat_id.as_deref(), Some("fromVideo"));
        assert_eq!(statuses(&events), ["connected"]);
        let calls = script.lock().unwrap().calls.clone();
        assert!(calls.iter().any(|(url, _)| url.contains("id=vid123")));
    }

    #[tokio::test]
    async fn without_a_token_the_service_is_not_configured() {
        let script = script();
        let (emit, events) = collector();
        let (tokens, _) = tokens("");
        let get = get_for(Arc::clone(&script));
        let config = config("");

        let mut live_chat_id = None;
        let mut next_page_token = None;
        let delay = tick(
            &get,
            &tokens,
            &config,
            &emit,
            &mut live_chat_id,
            &mut next_page_token,
        )
        .await;

        assert_eq!(delay, RETRY_DELAY_MS);
        assert_eq!(statuses(&events), ["not_configured"]);
        assert!(script.lock().unwrap().calls.is_empty());
    }

    type BoxedTask = Pin<Box<dyn Future<Output = ()> + Send>>;

    fn playing_spawn() -> (SpawnFn, Arc<Mutex<Option<BoxedTask>>>) {
        let cell: Arc<Mutex<Option<BoxedTask>>> = Arc::new(Mutex::new(None));
        let store = Arc::clone(&cell);
        let spawn: SpawnFn = Arc::new(move |task| *store.lock().unwrap() = Some(task));
        (spawn, cell)
    }

    #[tokio::test]
    async fn a_disabled_service_does_not_poll() {
        let (spawn, cell) = playing_spawn();
        let script = script();
        let (tokens, _) = tokens("token");
        let control = YoutubeLiveControl::new(get_for(script), tokens, config(""), spawn);
        let (emit, events) = collector();

        control.restart(false, emit);

        assert!(cell.lock().unwrap().is_none());
        assert_eq!(statuses(&events), ["disabled"]);
    }

    #[tokio::test]
    async fn the_loop_reports_connecting_then_connected() {
        let (spawn, cell) = playing_spawn();
        let script = script();
        queue(&script, "broadcasts", 200, BROADCAST_LIVE);
        queue(
            &script,
            "chat",
            200,
            r#"{ "items": [], "pollingIntervalMillis": 5000 }"#,
        );
        let (tokens, _) = tokens("token");
        let control =
            YoutubeLiveControl::new(get_for(Arc::clone(&script)), tokens, config(""), spawn);
        let (emit, events) = collector();

        control.restart(true, emit);
        let task = cell.lock().unwrap().take().expect("задача");
        // Первый опрос проходит целиком, дальше задача спит — обрываем ожидание.
        let _ = tokio::time::timeout(Duration::from_millis(100), task).await;

        assert_eq!(statuses(&events), ["connecting", "connected"]);
    }
}
