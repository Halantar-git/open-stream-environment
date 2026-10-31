//! DonateX: донаты в реальном времени через SignalR.
//!
//! Порт `server/integrations/donatex.js`: публичный хаб
//! `wss://donatex.gg/api/public-donations-hub` пушит донаты и обновления цели.
//! Авторизация — «external token» из кабинета, он уходит в `access_token`.
//! Протокол — SignalR JSON: кадры разделяются символом `0x1E`, рукопожатие
//! `{"protocol":"json","version":1}`, keepalive-пинги `{"type":6}`.
//!
//! Разбор payload отделён от транспорта: [`donation_alert_from_payload`],
//! [`goal_update_from_payload`] и [`ai_response_from_payload`] — чистые функции,
//! их проверяют тесты без сети. Сокет живёт в [`DonatexControl`].

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::oneshot;

use crate::integrations::twitch_chat_control::{ConnectFn, EmitFn, SpawnFn};
use crate::protocol::event_types;
use crate::storage::history::{js_number_or_zero, number_value};

/// Публичный хаб донатов DonateX.
pub const HUB_URL: &str = "wss://donatex.gg/api/public-donations-hub";

/// Текущее состояние музыкального виджета DonateX.
pub const MUSIC_CURRENT_URL: &str = "https://donatex.gg/api/v1/music/current";

const RECONNECT_MS: u64 = 5_000;
/// Сколько названий треков держать в памяти. Одно и то же имя спрашивают
/// алерт и опрос музыки, а за длинный стрим треков бывает много.
const TITLE_CACHE_LIMIT: usize = 128;

// Сервер шлёт пинг примерно раз в 15 секунд. Если трафика нет дольше этого
// срока, соединение считается полуоткрытым и пересоздаётся.
const WATCHDOG_MS: u64 = 45_000;

/// Разделитель кадров SignalR JSON (0x1E).
const RECORD_SEPARATOR: char = '\u{1e}';

fn string_trimmed(value: Option<&Value>) -> String {
    value
        .filter(|value| crate::storage::history::js_truthy(Some(value)))
        .map(crate::state::js_string)
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Разобрать payload доната в алерт — как `donationAlertFromPayload` в JS.
pub fn donation_alert_from_payload(payload: &Value) -> Value {
    let username = string_trimmed(payload.get("username"));
    let name = string_trimmed(payload.get("name"));
    let user = if !username.is_empty() {
        username
    } else if !name.is_empty() {
        name
    } else {
        "Аноним".to_string()
    };

    let currency = string_trimmed(payload.get("currency"));
    let message = string_trimmed(payload.get("message"));
    // Записанное голосовое сообщение важнее TTS. `paidVoice` — это название
    // платного голоса, а не ссылка, поэтому в audio его больше не кладём.
    let voice_message = string_trimmed(payload.get("voiceMessagePath"));
    let voice = if !voice_message.is_empty() {
        voice_message
    } else {
        string_trimmed(payload.get("voiceFilePath"))
    };
    let music_link = string_trimmed(payload.get("musicLink"));
    let music_title = string_trimmed(payload.get("musicTitle"));
    let music_title = if music_title.is_empty() {
        let fallback = string_trimmed(payload.get("musicName"));
        if fallback.is_empty() {
            string_trimmed(payload.get("songName"))
        } else {
            fallback
        }
    } else {
        music_title
    };

    let mut out = Map::new();
    out.insert("kind".to_string(), Value::from("donation"));
    out.insert("source".to_string(), Value::from("donatex"));
    out.insert("user".to_string(), Value::from(user));
    out.insert(
        "amount".to_string(),
        number_value(js_number_or_zero(payload.get("amount"))),
    );
    out.insert(
        "currency".to_string(),
        Value::from(if currency.is_empty() {
            "RUB".to_string()
        } else {
            currency
        }),
    );
    out.insert("message".to_string(), Value::from(message));
    if !music_link.is_empty() {
        out.insert("musicLink".to_string(), Value::from(music_link));
    }
    if !music_title.is_empty() {
        out.insert("musicTitle".to_string(), Value::from(music_title));
    }
    if !voice.is_empty() {
        out.insert("voiceUrl".to_string(), Value::from(voice));
    }
    Value::Object(out)
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("OpenStreamEnvironment")
            .build()
            .unwrap_or_default()
    })
}

/// Текущий трек из ответа `/v1/music/current`.
///
/// `hasTrack: false` и пустая ссылка означают «музыки нет» — тогда виджет
/// нужно погасить, а не показывать прошлый трек. Название и заказчика этот
/// метод не знает: DonateX отдаёт только ссылку.
pub fn music_track_from_current(payload: &Value) -> Option<Value> {
    if payload.get("hasTrack").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let link = string_trimmed(payload.get("musicLink"));
    if link.is_empty() {
        return None;
    }
    Some(json!({
        "musicLink": link,
        "source": "donatex",
        "isPlaying": payload
            .get("isPlaying")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }))
}

/// Запросить текущий трек музыкального виджета DonateX.
///
/// `Ok(None)` — трека нет, `Err` — сеть или ответ сервиса. Вызывающий по этой
/// разнице решает, гасить ли уже показанный трек: моргнувшая сеть не повод
/// очищать экран.
pub async fn fetch_music_current(token: &str) -> Result<Option<Value>, String> {
    let response = http_client()
        .get(MUSIC_CURRENT_URL)
        .bearer_auth(token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("status {}", response.status()));
    }
    let payload: Value = response.json().await.map_err(|error| error.to_string())?;
    Ok(music_track_from_current(&payload))
}

/// Название ролика YouTube: DonateX отдаёт в музыке только ссылку, а в
/// карточке нужно что-то понятнее адреса. Ошибка или не-YouTube ссылка
/// просто оставляют название пустым.
pub async fn fetch_youtube_title(link: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(link).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if !(host == "youtu.be" || host == "youtube.com" || host.ends_with(".youtube.com")) {
        return None;
    }
    let mut url = reqwest::Url::parse("https://www.youtube.com/oembed").ok()?;
    url.query_pairs_mut()
        .append_pair("url", link)
        .append_pair("format", "json");
    let response = http_client()
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: Value = response.json().await.ok()?;
    payload
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
}

/// Название ролика с кэшем: его спрашивают и алерт доната, и опрос
/// музыки, а YouTube отвечает не мгновенно.
pub async fn youtube_title_cached(link: &str) -> Option<String> {
    if let Some(title) = title_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(link)
        .cloned()
    {
        return Some(title);
    }
    let title = fetch_youtube_title(link).await?;
    {
        let mut cache = title_cache()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if cache.len() >= TITLE_CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(link.to_string(), title.clone());
    }
    Some(title)
}

fn title_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Дописать в алерт название заказанного трека.
///
/// В объекте доната DonateX названия нет — только ссылка, поэтому спрашиваем
/// YouTube. Ждём не дольше секунды с небольшим: алерт важнее полного названия,
/// а карточка музыки всё равно покажет его следом.
async fn enrich_music_title(alert: &mut Value) {
    let has_title = alert
        .get("musicTitle")
        .and_then(Value::as_str)
        .is_some_and(|title| !title.trim().is_empty());
    if has_title {
        return;
    }
    let Some(link) = alert
        .get("musicLink")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return;
    };
    let Ok(Some(title)) =
        tokio::time::timeout(Duration::from_millis(1_200), youtube_title_cached(&link)).await
    else {
        return;
    };
    if let Some(map) = alert.as_object_mut() {
        map.insert("musicTitle".to_string(), Value::from(title));
    }
}

/// Обновление цели из payload `GoalUpdated`.
///
/// Читает новые поля (`currentAmount`/`goalAmount`) и старые
/// (`current`/`target`); если суммы нет вовсе — обновлять нечего.
pub fn goal_update_from_payload(payload: &Value) -> Option<Value> {
    if !payload.is_object() {
        return None;
    }
    let current = payload
        .get("currentAmount")
        .or_else(|| payload.get("current"));
    let target = payload.get("goalAmount").or_else(|| payload.get("target"));
    if current.is_none() && target.is_none() {
        return None;
    }

    let mut out = Map::new();
    out.insert(
        "current".to_string(),
        number_value(js_number_or_zero(current)),
    );
    if let Some(target) = target.filter(|value| crate::storage::history::js_truthy(Some(value))) {
        out.insert(
            "target".to_string(),
            number_value(js_number_or_zero(Some(target))),
        );
    }
    Some(Value::Object(out))
}

/// Ответ ИИ-персонажа из payload доната, если он есть.
///
/// `aiResponse` — текст реплики, `withAIResponse` — флаг включённости,
/// `aiResponseVoiceFilePath` — озвучка именно ИИ. Раньше голос лежал в общем
/// `paidVoice`, но в текущем API это платная озвучка доната, поэтому её
/// больше не подставляем: иначе персонаж говорил бы голосом зрителя.
///
/// Имя персонажа отдаём только если DonateX его прислал: иначе виджет берёт
/// имя из своих настроек, а не показывает чужое «Ассистент».
pub fn ai_response_from_payload(payload: &Value) -> Option<Value> {
    if !payload.is_object() {
        return None;
    }
    let ai_text = string_trimmed(payload.get("aiResponse"));
    let with_ai = payload.get("withAIResponse") == Some(&Value::Bool(true));
    if !with_ai && ai_text.is_empty() {
        return None;
    }

    let audio = string_trimmed(payload.get("aiResponseVoiceFilePath"));
    let name = string_trimmed(payload.get("aiCharacterName"));
    let name = if name.is_empty() {
        string_trimmed(payload.get("characterName"))
    } else {
        name
    };

    let mut out = json!({
        "aiText": ai_text,
        "aiAudio": audio,
    });
    if !name.is_empty() {
        out["characterName"] = Value::from(name);
    }
    Some(out)
}

/// Одно подключение к DonateX за раз.
pub struct DonatexControl {
    connect: ConnectFn,
    /// External token из настроек (`donatex.externalToken`).
    get_token: Arc<dyn Fn() -> String + Send + Sync>,
    spawn: SpawnFn,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl DonatexControl {
    pub fn new(
        connect: ConnectFn,
        get_token: Arc<dyn Fn() -> String + Send + Sync>,
        spawn: SpawnFn,
    ) -> Self {
        Self {
            connect,
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
        let get_token = Arc::clone(&self.get_token);
        let emit = Arc::clone(&emit);

        (self.spawn)(Box::pin(async move {
            loop {
                emit(connection_status("connecting"));

                let token = get_token();
                if token.trim().is_empty() {
                    // Без external token подключаться некуда, повтор не поможет.
                    emit(connection_status("not_configured"));
                    return;
                }

                let url = format!("{HUB_URL}?access_token={}", encode_query(&token));
                let Ok(mut transport) = connect(url).await else {
                    emit(connection_status("error"));
                    if sleep_or_stop(&mut stop_rx).await {
                        return;
                    }
                    continue;
                };

                // Рукопожатие SignalR JSON (кадр завершается разделителем).
                let handshake =
                    format!("{{\"protocol\":\"json\",\"version\":1}}{RECORD_SEPARATOR}");
                if transport.send(handshake).await.is_err() {
                    emit(connection_status("error"));
                    if sleep_or_stop(&mut stop_rx).await {
                        return;
                    }
                    continue;
                }

                let mut buffer = String::new();
                let mut handshake_done = false;
                let mut connected = false;
                'connection: loop {
                    let incoming = tokio::select! {
                        _ = &mut stop_rx => return,
                        incoming = transport.recv() => incoming,
                        _ = tokio::time::sleep(Duration::from_millis(WATCHDOG_MS)) => {
                            // Тишина дольше watchdog: соединение полуоткрыто.
                            break 'connection;
                        }
                    };

                    let frame = match incoming {
                        Ok(Some(frame)) => frame,
                        Ok(None) | Err(_) => break 'connection,
                    };
                    buffer.push_str(&frame);

                    while let Some(index) = buffer.find(RECORD_SEPARATOR) {
                        let frame: String = buffer.drain(..=index).collect();
                        let frame = frame.trim_end_matches(RECORD_SEPARATOR);
                        if frame.is_empty() {
                            continue;
                        }
                        let Ok(msg) = serde_json::from_str::<Value>(frame) else {
                            continue;
                        };

                        if !handshake_done {
                            handshake_done = true;
                            if msg.get("error").is_some() {
                                // Токен не принят: рукопожатие не состоялось.
                                emit(connection_status("error"));
                                break 'connection;
                            }
                            connected = true;
                            emit(connection_status("connected"));
                            continue;
                        }

                        match msg.get("type").and_then(Value::as_u64) {
                            // Keepalive: отвечаем тем же типом.
                            Some(6) => {
                                let _ = transport
                                    .send(format!("{{\"type\":6}}{RECORD_SEPARATOR}"))
                                    .await;
                                continue;
                            }
                            // Сервер закрывает соединение.
                            Some(7) => break 'connection,
                            _ => {}
                        }

                        if let Some(target) = msg.get("target").and_then(Value::as_str) {
                            let payload = msg
                                .get("arguments")
                                .and_then(|args| args.get(0))
                                .cloned()
                                .unwrap_or(Value::Null);
                            handle_invocation(target, &payload, &emit).await;
                        }
                    }
                }

                if connected {
                    emit(connection_status("disconnected"));
                }
                if sleep_or_stop(&mut stop_rx).await {
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

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<oneshot::Sender<()>>> {
        self.stop.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Разобрать invocation SignalR и отправить событие шины.
async fn handle_invocation(target: &str, payload: &Value, emit: &EmitFn) {
    // Часть установок DonateX шлёт ответ ИИ отдельными целями.
    if [
        "AiAssistantGenerated",
        "AiSpeech",
        "AiResponse",
        "AiGenerated",
    ]
    .contains(&target)
    {
        if let Some(ai) = ai_response_from_payload(payload) {
            emit(bus_event("donatex_ai_event", ai));
        }
        return;
    }

    if target == "DonationCreated" || target == "DonationRerun" {
        let mut alert = donation_alert_from_payload(payload);
        enrich_music_title(&mut alert).await;
        emit(bus_event("alert", alert.clone()));

        if let Some(ai) = ai_response_from_payload(payload) {
            let mut event = ai;
            if let Value::Object(map) = &mut event {
                // Событие ИИ дополняется данными доната — виджету есть что показать.
                map.insert(
                    "user".to_string(),
                    alert.get("user").cloned().unwrap_or(Value::Null),
                );
                map.insert(
                    "amount".to_string(),
                    alert.get("amount").cloned().unwrap_or(Value::Null),
                );
                map.insert(
                    "currency".to_string(),
                    alert.get("currency").cloned().unwrap_or(Value::Null),
                );
                map.insert(
                    "message".to_string(),
                    alert.get("message").cloned().unwrap_or(Value::Null),
                );
            }
            // Текст ИИ дублируется в алерты отдельной карточкой: если виджет
            // персонажа скрыт или в режиме ссылок, реплика всё равно дойдёт до зрителя.
            let reply = event
                .get("aiText")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if !reply.is_empty() {
                emit(bus_event(
                    "alert",
                    json!({
                        "kind": "ai",
                        "user": alert.get("user").cloned().unwrap_or(Value::Null),
                        "characterName": event.get("characterName").cloned().unwrap_or(Value::Null),
                        "message": reply,
                        "durationMs": 7000,
                    }),
                ));
            }
            emit(bus_event("donatex_ai_event", event));
        }
        return;
    }

    if target == "GoalUpdated" {
        if let Some(update) = goal_update_from_payload(payload) {
            emit(bus_event("goal_external_update", update));
        }
    }
}

/// Пауза перед повтором; `true` — пришла остановка.
async fn sleep_or_stop(stop_rx: &mut oneshot::Receiver<()>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(RECONNECT_MS)) => false,
        _ = stop_rx => true,
    }
}

/// Событие `connection_status` для службы донатов.
fn connection_status(status: &str) -> Value {
    json!({
        "type": event_types::CONNECTION_STATUS,
        "payload": { "service": "donatex", "status": status },
    })
}

/// Событие шины в форме `bus.emit`.
fn bus_event(kind: &str, payload: Value) -> Value {
    json!({ "type": kind, "payload": payload })
}

/// `encodeURIComponent` для значения query-параметра.
fn encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::Future;
    use std::pin::Pin;

    use super::*;
    use crate::integrations::twitch_chat::{ChatTransport, RecvFuture, SendFuture};

    type BoxedTask = Pin<Box<dyn Future<Output = ()> + Send>>;

    fn frame(value: &str) -> String {
        format!("{value}{RECORD_SEPARATOR}")
    }

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

    fn token(value: &'static str) -> Arc<dyn Fn() -> String + Send + Sync> {
        Arc::new(move || value.to_string())
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

    fn control_with(
        incoming: Vec<String>,
        sent: Arc<Mutex<Vec<String>>>,
    ) -> (DonatexControl, Arc<Mutex<Option<BoxedTask>>>) {
        let connect: ConnectFn = Arc::new(move |_url| {
            let sent = Arc::clone(&sent);
            let incoming = incoming.clone();
            Box::pin(async move {
                Ok(Box::new(FakeTransport {
                    incoming: incoming.into_iter().collect(),
                    sent,
                }) as Box<dyn ChatTransport>)
            })
        });
        let (spawn, cell) = playing_spawn();
        (DonatexControl::new(connect, token("tok"), spawn), cell)
    }

    #[test]
    fn a_donation_becomes_an_alert_and_keeps_extra_fields() {
        let alert = donation_alert_from_payload(&json!({
            "username": "nick",
            "amount": 250,
            "currency": "RUB",
            "message": "gg",
            "musicLink": "https://example.com/track.mp3",
            "musicTitle": "Night Drive",
            "voiceFilePath": "https://cdn.donatex.gg/voice.mp3",
        }));
        assert_eq!(alert["kind"], json!("donation"));
        assert_eq!(alert["source"], json!("donatex"));
        assert_eq!(alert["user"], json!("nick"));
        assert_eq!(alert["amount"], json!(250));
        assert_eq!(alert["currency"], json!("RUB"));
        assert_eq!(alert["message"], json!("gg"));
        assert_eq!(alert["musicLink"], json!("https://example.com/track.mp3"));
        assert_eq!(alert["musicTitle"], json!("Night Drive"));
        assert_eq!(alert["voiceUrl"], json!("https://cdn.donatex.gg/voice.mp3"));
    }

    #[test]
    fn a_voice_message_wins_and_the_anonymous_fallback_is_used() {
        let alert = donation_alert_from_payload(&json!({
            "amount": "10",
            "voiceFilePath": "https://cdn.donatex.gg/default.mp3",
            "voiceMessagePath": "https://cdn.donatex.gg/recorded.mp3",
        }));
        assert_eq!(alert["user"], json!("Аноним"));
        assert_eq!(alert["amount"], json!(10));
        assert_eq!(alert["currency"], json!("RUB"));
        assert_eq!(
            alert["voiceUrl"],
            json!("https://cdn.donatex.gg/recorded.mp3")
        );
    }

    #[test]
    fn a_paid_voice_name_is_not_played_as_a_url() {
        let alert = donation_alert_from_payload(&json!({
            "amount": 10,
            "voiceFilePath": "https://cdn.donatex.gg/default.mp3",
            "paidVoice": "Альбина",
        }));
        // `paidVoice` в текущем API — название голоса, а не ссылка на файл.
        assert_eq!(
            alert["voiceUrl"],
            json!("https://cdn.donatex.gg/default.mp3")
        );
    }

    #[test]
    fn a_goal_frame_reads_new_and_legacy_fields() {
        assert_eq!(
            goal_update_from_payload(&json!({ "currentAmount": 1200, "goalAmount": 5000 })),
            Some(json!({ "current": 1200, "target": 5000 }))
        );
        assert_eq!(
            goal_update_from_payload(&json!({ "current": 40, "target": 100 })),
            Some(json!({ "current": 40, "target": 100 }))
        );
        assert_eq!(goal_update_from_payload(&json!(null)), None);
        assert_eq!(goal_update_from_payload(&json!({})), None);
    }

    #[test]
    fn an_ai_answer_is_read_from_the_donation_payload() {
        assert_eq!(
            ai_response_from_payload(&json!({ "username": "nick" })),
            None
        );
        assert_eq!(
            ai_response_from_payload(&json!({ "withAIResponse": false, "aiResponse": "" })),
            None
        );
        assert_eq!(
            ai_response_from_payload(&json!({
                "withAIResponse": true,
                "aiResponse": "Привет, спасибо!",
                "aiResponseVoiceFilePath": "https://cdn.donatex.gg/ai.mp3",
                "paidVoice": "https://cdn.donatex.gg/paid.mp3",
                "voiceFilePath": "https://cdn.donatex.gg/voice.mp3",
            })),
            Some(json!({
                "aiText": "Привет, спасибо!",
                "aiAudio": "https://cdn.donatex.gg/ai.mp3",
            }))
        );
        // Имя берётся из ответа DonateX, если сервис его прислал.
        assert_eq!(
            ai_response_from_payload(&json!({
                "aiResponse": "Здорово!",
                "aiCharacterName": "Кэти",
            })),
            Some(json!({
                "characterName": "Кэти",
                "aiText": "Здорово!",
                "aiAudio": "",
            }))
        );
        // Платная озвучка и голос доната — не голос ИИ.
        assert_eq!(
            ai_response_from_payload(&json!({
                "aiResponse": "Здорово!",
                "paidVoice": "https://cdn.donatex.gg/paid.mp3",
                "voiceFilePath": "https://cdn.donatex.gg/voice.mp3",
            })),
            Some(json!({
                "aiText": "Здорово!",
                "aiAudio": "",
            }))
        );
    }

    #[tokio::test]
    async fn a_donation_frame_becomes_an_alert_and_an_ai_event() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let incoming = vec![
            frame("{}"),
            frame(
                r#"{"type":1,"target":"DonationCreated","arguments":[{"username":"fan","amount":300,"currency":"RUB","message":"hi","aiResponse":"Спасибо!","aiResponseVoiceFilePath":"https://cdn.donatex.gg/v.mp3"}]}"#,
            ),
        ];
        let (control, cell) = control_with(incoming, Arc::clone(&sent));
        let (emit, events) = collector();

        control.restart(true, emit);
        let task = cell.lock().unwrap().take().expect("задача");
        let _ = tokio::time::timeout(Duration::from_millis(200), task).await;

        assert_eq!(
            statuses(&events),
            ["connecting", "connected", "disconnected"]
        );

        let events = events.lock().unwrap();
        let alert = events
            .iter()
            .find(|event| event["type"] == json!("alert"))
            .expect("алерт");
        assert_eq!(alert["payload"]["amount"], json!(300));
        assert_eq!(alert["payload"]["source"], json!("donatex"));

        let ai = events
            .iter()
            .find(|event| event["type"] == json!("donatex_ai_event"))
            .expect("ИИ-событие");
        assert_eq!(ai["payload"]["aiText"], json!("Спасибо!"));
        assert_eq!(ai["payload"]["user"], json!("fan"));
        assert_eq!(
            ai["payload"]["aiAudio"],
            json!("https://cdn.donatex.gg/v.mp3")
        );

        // Реплика ИИ дублируется в алерты отдельной карточкой.
        let ai_alert = events
            .iter()
            .filter(|event| event["type"] == json!("alert"))
            .find(|event| event["payload"]["kind"] == json!("ai"))
            .expect("ИИ-алерт");
        assert_eq!(ai_alert["payload"]["message"], json!("Спасибо!"));
        assert_eq!(ai_alert["payload"]["user"], json!("fan"));

        // Рукопожатие ушло в сокет первым кадром.
        let sent = sent.lock().unwrap();
        assert!(sent[0].contains("\"protocol\":\"json\""));
    }

    #[tokio::test]
    async fn a_goal_frame_becomes_a_goal_update() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let incoming = vec![
            frame("{}"),
            frame(
                r#"{"type":1,"target":"GoalUpdated","arguments":[{"currentAmount":150,"goalAmount":1000}]}"#,
            ),
        ];
        let (control, cell) = control_with(incoming, sent);
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
        let (spawn, cell) = playing_spawn();
        let control = DonatexControl::new(connect, token(""), spawn);
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
        let (spawn, cell) = playing_spawn();
        let control = DonatexControl::new(connect, token("tok"), spawn);
        let (emit, events) = collector();

        control.restart(false, emit);

        assert!(cell.lock().unwrap().is_none());
        assert_eq!(statuses(&events), ["disabled"]);
    }

    #[test]
    fn a_token_is_percent_encoded_for_the_query() {
        assert_eq!(encode_query("a b+c/d="), "a%20b%2Bc%2Fd%3D");
    }

    #[test]
    fn the_current_music_track_keeps_only_what_the_widget_shows() {
        assert_eq!(
            music_track_from_current(&json!({
                "hasTrack": true,
                "isPlaying": true,
                "musicLink": " https://www.youtube.com/watch?v=abc ",
                "widgetId": "w",
            })),
            Some(json!({
                "musicLink": "https://www.youtube.com/watch?v=abc",
                "source": "donatex",
                "isPlaying": true,
            }))
        );

        // Трека нет — карточку надо гасить, а не показывать прошлый.
        assert_eq!(
            music_track_from_current(&json!({ "hasTrack": false, "musicLink": "" })),
            None
        );
        // Пустая ссылка без флага тоже ничего не показывает.
        assert_eq!(
            music_track_from_current(&json!({ "hasTrack": true, "musicLink": "  " })),
            None
        );
    }
}
