//! DonationAlerts: разбор донатов и подписок Boosty.
//!
//! Порт `server/integrations/donationalerts.js` в части, что только *решает*:
//! разбор payload доната и boosty-подписки, проверка «это вообще донат», дата из
//! `created_at`, нормализация строки REST-списка, обновление цели и разбор кадра
//! Centrifugo. Это те же данные, что уходят в `bus.emit`.
//!
//! Транспорт (WebSocket Centrifugo, OAuth-обмен и HTTP-подписка) здесь не
//! подключён — он идёт следом и останется тонким: сокет + инжектируемые запросы.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::storage::history::{js_number, js_number_or_zero, js_truthy, number_value};

/// Обмен refresh-токена DonationAlerts.
pub const OAUTH_URL: &str = "https://www.donationalerts.com/oauth/token";
/// Данные сокета пользователя (идентификатор и токен подключения).
pub const USER_URL: &str = "https://www.donationalerts.com/api/v1/user/oauth";
/// Подписка Centrifugo на каналы.
pub const SUBSCRIBE_URL: &str = "https://www.donationalerts.com/api/v1/centrifuge/subscribe";
/// Список последних донатов (scope `oauth-donation-index`).
pub const DONATIONS_URL: &str = "https://www.donationalerts.com/api/v1/alerts/donations";

/// Стоит ли переподключаться после такой ошибки.
///
/// `invalid_client` — сервис не узнал пару client_id/client_secret: это не
/// сетевой сбой, повторы ничего не изменят. Правило вынесено функцией, как в JS.
pub fn is_unrecoverable_auth_error(message: &str) -> bool {
    message.to_lowercase().contains("invalid_client")
}

/// Ошибка авторизации (а не сети): для неё повтор берётся с большей паузой — как
/// `/401|refresh_token|unauthorized|invalid_grant|socket_connection_token|connectionToken/i`
/// в JS.
pub fn is_auth_error(message: &str) -> bool {
    let text = message.to_lowercase();
    [
        "401",
        "refresh_token",
        "unauthorized",
        "invalid_grant",
        "socket_connection_token",
        "connectiontoken",
    ]
    .iter()
    .any(|pattern| text.contains(pattern))
}

/// Разобрать payload доната в алерт.
pub fn donation_alert_from_payload(payload: &Value) -> Value {
    // Озвучка от сервиса: точное имя поля не задокументировано — перебираем
    // кандидатов, как в JS.
    const VOICE_KEYS: [&str; 9] = [
        "voiceUrl",
        "voice_url",
        "voice",
        "audioUrl",
        "audio_url",
        "soundUrl",
        "ttsUrl",
        "voiceFile",
        "messageAudio",
    ];
    let voice = VOICE_KEYS
        .iter()
        .find_map(|key| string_trimmed(payload.get(key)))
        .unwrap_or_default();

    let mut out = Map::new();
    out.insert("kind".to_string(), Value::from("donation"));
    out.insert(
        "user".to_string(),
        first_truthy(payload.get("username"), payload.get("name"), "Аноним"),
    );
    out.insert(
        "amount".to_string(),
        number_value(js_number_or_zero(payload.get("amount"))),
    );
    out.insert(
        "currency".to_string(),
        first_truthy(payload.get("currency"), None, "RUB"),
    );
    out.insert(
        "message".to_string(),
        first_truthy(payload.get("message"), None, ""),
    );
    if let Some(id) = payload.get("id").filter(|value| !value.is_null()) {
        out.insert(
            "sourceId".to_string(),
            Value::from(crate::state::js_string(id)),
        );
    }
    if !voice.is_empty() {
        out.insert("voiceUrl".to_string(), Value::from(voice));
    }
    Value::Object(out)
}

/// Настоящий ли это донат: у него есть хотя бы id, сумма или ник.
///
/// На канал подписки приходят и служебные кадры — без этой проверки они
/// превращались бы в «донат от Анонима на 0 RUB».
pub fn is_donation_payload(payload: &Value) -> bool {
    if !(payload.is_object() || payload.is_array()) {
        return false;
    }
    if let Some(id) = payload.get("id") {
        if !id.is_null() && !crate::state::js_string(id).trim().is_empty() {
            return true;
        }
    }
    let amount = js_number(payload.get("amount"));
    if amount.is_finite() && amount > 0.0 {
        return true;
    }
    first_truthy(payload.get("username"), payload.get("name"), "")
        .as_str()
        .map(|text| !text.trim().is_empty())
        .unwrap_or(false)
}

/// Дата доната из `"YYYY-MM-DD HH.MM.SS"` (без зоны) как UTC-миллисекунды.
///
/// Так в apidoc: разделитель даты — пробел или `T`, времени — точка или двоеточие.
/// Не разобралось — `0`.
pub fn parse_donation_date(value: &Value) -> i64 {
    let text = if js_truthy(Some(value)) {
        crate::state::js_string(value)
    } else {
        String::new()
    };
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return 0;
    }
    let two = |start: usize| -> Option<u32> {
        let slice = &bytes[start..start + 2];
        if slice.iter().all(u8::is_ascii_digit) {
            Some((u32::from(slice[0] - b'0')) * 10 + u32::from(slice[1] - b'0'))
        } else {
            None
        }
    };
    let four = || -> Option<u32> {
        let slice = &bytes[0..4];
        if slice.iter().all(u8::is_ascii_digit) {
            Some(
                u32::from(slice[0] - b'0') * 1000
                    + u32::from(slice[1] - b'0') * 100
                    + u32::from(slice[2] - b'0') * 10
                    + u32::from(slice[3] - b'0'),
            )
        } else {
            None
        }
    };
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return 0;
    }
    if bytes[10] != b' ' && bytes[10] != b'T' {
        return 0;
    }
    if !matches!(bytes[13], b'.' | b':') || !matches!(bytes[16], b'.' | b':') {
        return 0;
    }
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) =
        (four(), two(5), two(8), two(11), two(14), two(17))
    else {
        return 0;
    };
    use chrono::TimeZone;
    chrono::Utc
        .with_ymd_and_hms(year as i32, month, day, hour, minute, second)
        .single()
        .map(|date| date.timestamp_millis())
        .unwrap_or(0)
}

/// Строка REST-списка донатов в наш формат; `None` — не строка.
pub fn normalize_donation_row(row: &Value) -> Option<Value> {
    if !row.is_object() {
        return None;
    }
    let source_id = match row.get("id") {
        Some(id) if !id.is_null() => Value::from(crate::state::js_string(id)),
        _ => Value::Null,
    };
    let shown = js_number(row.get("is_shown")) == 1.0 || js_truthy(row.get("shown_at"));
    Some(json!({
        "sourceId": source_id,
        "kind": "donation",
        "user": crate::state::js_string(&first_truthy(row.get("username"), None, "Аноним")),
        "amount": number_value(js_number_or_zero(row.get("amount"))),
        "currency": crate::state::js_string(&first_truthy(row.get("currency"), None, "RUB")),
        "message": crate::state::js_string(&first_truthy(row.get("message"), None, "")),
        "createdAt": parse_donation_date(row.get("created_at").unwrap_or(&Value::Null)),
        "shown": shown,
    }))
}

/// Список последних донатов из ответа `/api/v1/alerts/donations`.
pub fn map_recent_donations(body: &Value, limit: i64) -> Vec<Value> {
    let rows = body
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let limit = limit.max(1) as usize;
    rows.iter()
        .filter_map(normalize_donation_row)
        .take(limit)
        .collect()
}

/// Итог REST-запроса: статус, тело и сетевой сбой (тогда `status` — 0).
pub struct GetOutcome {
    pub status: u16,
    pub body: Value,
    pub network_error: Option<String>,
}

/// Будущее REST-запроса.
pub type GetFuture = Pin<Box<dyn Future<Output = GetOutcome> + Send>>;
/// GET с `Bearer`: URL и токен → итог запроса.
pub type GetFn = Arc<dyn Fn(String, String) -> GetFuture + Send + Sync>;

/// Список последних донатов (`GET /api/v1/alerts/donations`).
///
/// Сокет отдаёт только живые события, поэтому «что было в офлайне» берётся
/// отсюда (scope `oauth-donation-index`). Ошибки возвращаются объектом, а не
/// исключением: `insufficient_scope` при 401/403 значит, что токен выдан без
/// нужного scope — надо переподключить DonationAlerts.
pub async fn fetch_recent_donations(get: &GetFn, token: &str, limit: i64, page: i64) -> Value {
    if token.is_empty() {
        return json!({ "ok": false, "error": "not_authorized", "donations": [] });
    }
    let url = format!("{DONATIONS_URL}?page={}", page.max(1));
    let outcome = get(url, token.to_string()).await;
    if let Some(error) = outcome.network_error {
        return json!({ "ok": false, "error": error, "donations": [] });
    }
    if outcome.status == 401 || outcome.status == 403 {
        return json!({
            "ok": false,
            "error": "insufficient_scope",
            "status": outcome.status,
            "donations": [],
        });
    }
    if !(200..300).contains(&outcome.status) {
        return json!({
            "ok": false,
            "error": format!("http_{}", outcome.status),
            "status": outcome.status,
            "donations": [],
        });
    }
    let limit = if limit <= 0 { 30 } else { limit };
    json!({ "ok": true, "donations": map_recent_donations(&outcome.body, limit) })
}

/// Алерт подписки Boosty.
pub fn boosty_alert_from_payload(payload: &Value) -> Value {
    json!({
        "kind": "boosty_sub",
        "user": first_truthy(payload.get("username"), None, "Аноним"),
        "amount": number_value(js_number_or_zero(payload.get("amount"))),
        "currency": first_truthy(payload.get("currency"), None, "RUB"),
    })
}

/// Алерт продления Boosty.
pub fn boosty_renewal_alert_from_payload(payload: &Value) -> Value {
    let mut alert = boosty_alert_from_payload(payload);
    if let Value::Object(map) = &mut alert {
        map.insert("kind".to_string(), Value::from("boosty_resub"));
    }
    alert
}

/// Алерт по payload: boosty-подписка или обычный донат.
pub fn alert_from_payload(payload: &Value) -> Value {
    let name = payload
        .get("name")
        .map(crate::state::js_string)
        .unwrap_or_default()
        .to_lowercase();
    if name.contains("boosty") {
        if is_boosty_renewal(&name) {
            boosty_renewal_alert_from_payload(payload)
        } else {
            boosty_alert_from_payload(payload)
        }
    } else {
        donation_alert_from_payload(payload)
    }
}

/// Обновление цели из payload канала `$goals:goal`.
pub fn goal_update(payload: &Value) -> Option<Value> {
    let current = payload
        .get("raised")
        .or_else(|| payload.get("current_amount"));
    if payload.get("raised").is_none() && payload.get("current_amount").is_none() {
        return None;
    }
    let target = payload.get("goal").or_else(|| payload.get("target_amount"));
    let mut out = Map::new();
    out.insert(
        "current".to_string(),
        number_value(js_number_or_zero(current)),
    );
    if let Some(target) = target.filter(|value| js_truthy(Some(value))) {
        out.insert(
            "target".to_string(),
            number_value(js_number_or_zero(Some(target))),
        );
    }
    Some(Value::Object(out))
}

/// Разобрать кадр Centrifugo: достать полезную нагрузку.
pub fn extract_payload(msg: &Value) -> Option<Value> {
    let data = msg
        .get("push")
        .and_then(|push| push.get("pub"))
        .and_then(|pub_| pub_.get("data"))
        .or_else(|| msg.get("result").and_then(|result| result.get("data")))?;

    let data = match data {
        Value::String(text) => serde_json::from_str::<Value>(text).ok()?,
        _ => data.clone(),
    };
    if data.is_null() {
        return None;
    }
    Some(data.get("data").cloned().unwrap_or(data))
}

/// Канал кадра (`push.channel` или `result.channel`).
pub fn message_channel(msg: &Value) -> String {
    msg.get("push")
        .and_then(|push| push.get("channel"))
        .or_else(|| msg.get("result").and_then(|result| result.get("channel")))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Продление Boosty по имени события.
fn is_boosty_renewal(name: &str) -> bool {
    ["renewal", "resub", "renew", "продлен", "продл"]
        .iter()
        .any(|marker| name.contains(marker))
}

/// `value || fallback`, но значение отдаётся как есть (число остаётся числом).
fn first_truthy(first: Option<&Value>, second: Option<&Value>, fallback: &str) -> Value {
    let candidate = first
        .filter(|value| js_truthy(Some(value)))
        .or_else(|| second.filter(|value| js_truthy(Some(value))));
    candidate.cloned().unwrap_or_else(|| Value::from(fallback))
}

/// `String(value || "")` для строки кандидата, если она непустая после `trim`.
fn string_trimmed(value: Option<&Value>) -> Option<String> {
    let text = value
        .filter(|value| js_truthy(Some(value)))
        .map(crate::state::js_string)?;
    (!text.trim().is_empty()).then_some(text.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_donation_becomes_an_alert_and_keeps_the_source_id() {
        let alert = donation_alert_from_payload(&json!({
            "id": 42,
            "username": "  Вася  ",
            "amount": "300",
            "currency": "RUB",
            "message": "Удачи!",
        }));
        // `username` отдаётся как есть — это то же, что `payload.username || ...`.
        assert_eq!(alert["kind"], json!("donation"));
        assert_eq!(alert["amount"], json!(300));
        assert_eq!(alert["currency"], json!("RUB"));
        assert_eq!(alert["message"], json!("Удачи!"));
        assert_eq!(alert["sourceId"], json!("42"));
        assert!(alert.get("voiceUrl").is_none());
    }

    #[test]
    fn a_donation_without_a_name_is_anonymous() {
        let alert = donation_alert_from_payload(&json!({ "amount": 0 }));
        assert_eq!(alert["user"], json!("Аноним"));
        assert_eq!(alert["amount"], json!(0));
        assert_eq!(alert["currency"], json!("RUB"));
        assert_eq!(alert["message"], json!(""));
    }

    #[test]
    fn a_voice_url_is_recognized_among_the_candidates() {
        let alert =
            donation_alert_from_payload(&json!({ "amount": 1, "audio_url": " https://a " }));
        assert_eq!(alert["voiceUrl"], json!("https://a"));
    }

    #[test]
    fn a_service_frame_is_not_a_donation() {
        assert!(!is_donation_payload(&json!({})));
        assert!(!is_donation_payload(&json!({ "amount": 0 })));
        assert!(!is_donation_payload(&Value::Null));
        assert!(is_donation_payload(&json!({ "id": 7 })));
        assert!(is_donation_payload(&json!({ "amount": "50" })));
        assert!(is_donation_payload(&json!({ "username": "fan" })));
        assert!(!is_donation_payload(&json!({ "id": "  " })));
    }

    #[test]
    fn donation_dates_are_read_as_utc() {
        // 2023-11-14 22:13:20 UTC — известная эпоха 1_700_000_000.
        let expected = 1_700_000_000_000;
        assert_eq!(parse_donation_date(&json!("2023-11-14 22:13:20")), expected);
        // Разделители `T` и `:` тоже принимаются.
        assert_eq!(parse_donation_date(&json!("2023-11-14T22:13:20")), expected);
        assert_eq!(parse_donation_date(&json!("мусор")), 0);
        assert_eq!(parse_donation_date(&Value::Null), 0);
    }

    #[test]
    fn a_rest_row_is_normalized() {
        let row = normalize_donation_row(&json!({
            "id": 9,
            "username": "fan",
            "amount": "100",
            "currency": "",
            "message": "",
            "created_at": "2023-11-14 22:13:20",
            "is_shown": 1,
        }))
        .expect("строка");
        assert_eq!(row["sourceId"], json!("9"));
        assert_eq!(row["kind"], json!("donation"));
        assert_eq!(row["amount"], json!(100));
        assert_eq!(row["currency"], json!("RUB"));
        assert_eq!(row["shown"], json!(true));
        assert!(normalize_donation_row(&json!("строка")).is_none());
    }

    #[test]
    fn recent_donations_are_mapped_and_capped() {
        let body = json!({ "data": [
            { "id": 1, "amount": 10 },
            { "id": 2, "amount": 20 },
            { "id": 3, "amount": 30 },
        ] });
        let donations = map_recent_donations(&body, 2);
        assert_eq!(donations.len(), 2);
        assert_eq!(donations[0]["sourceId"], json!("1"));
        assert_eq!(map_recent_donations(&json!({}), 5).len(), 0);
    }

    #[test]
    fn boosty_subscriptions_are_told_from_renewals() {
        let sub = alert_from_payload(
            &json!({ "name": "subscription_boosty", "username": "fan", "amount": 500 }),
        );
        assert_eq!(sub["kind"], json!("boosty_sub"));
        assert_eq!(sub["user"], json!("fan"));
        let renewal = alert_from_payload(
            &json!({ "name": "subscription_boosty_renewal", "username": "fan" }),
        );
        assert_eq!(renewal["kind"], json!("boosty_resub"));
        // Обычное событие — донат.
        let donation =
            alert_from_payload(&json!({ "name": "donation", "username": "fan", "amount": 1 }));
        assert_eq!(donation["kind"], json!("donation"));
    }

    #[test]
    fn a_goal_frame_gives_an_update() {
        assert_eq!(
            goal_update(&json!({ "raised": "150", "goal": "1000" })),
            Some(json!({ "current": 150, "target": 1000 }))
        );
        assert_eq!(
            goal_update(&json!({ "current_amount": 20 })),
            Some(json!({ "current": 20 }))
        );
        assert!(goal_update(&json!({ "note": "ничего" })).is_none());
    }

    #[test]
    fn payloads_are_extracted_from_both_frame_shapes() {
        // Современный: push.pub.data.
        assert_eq!(
            extract_payload(&json!({ "push": { "pub": { "data": { "data": { "amount": 5 } } } } })),
            Some(json!({ "amount": 5 }))
        );
        // Старый: result.data, причём строкой.
        assert_eq!(
            extract_payload(&json!({ "result": { "data": "{\"amount\":7}" } })),
            Some(json!({ "amount": 7 }))
        );
        assert!(extract_payload(&json!({ "result": {} })).is_none());
        assert_eq!(
            message_channel(&json!({ "push": { "channel": "$alerts:donation_1" } })),
            "$alerts:donation_1"
        );
    }

    #[test]
    fn invalid_client_is_unrecoverable() {
        assert!(is_unrecoverable_auth_error(
            "refresh_token: invalid_client_credentials"
        ));
        assert!(!is_unrecoverable_auth_error("network timeout"));
    }

    fn get_once(status: u16, body: Value) -> GetFn {
        Arc::new(move |_url: String, _token: String| {
            let body = body.clone();
            Box::pin(async move {
                GetOutcome {
                    status,
                    body,
                    network_error: None,
                }
            })
        })
    }

    #[tokio::test]
    async fn recent_donations_come_from_the_rest_list() {
        let get = get_once(
            200,
            json!({ "data": [
                { "id": 5, "username": "fan", "amount": "100", "currency": "RUB", "message": "hi", "created_at": "2023-11-14 22:13:20", "is_shown": 0 },
            ] }),
        );
        let result = fetch_recent_donations(&get, "tok", 30, 1).await;
        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["donations"][0]["sourceId"], json!("5"));
        assert_eq!(result["donations"][0]["amount"], json!(100));
    }

    #[tokio::test]
    async fn a_scope_problem_and_a_network_failure_are_reported() {
        let forbidden = get_once(403, json!({}));
        let result = fetch_recent_donations(&forbidden, "tok", 30, 1).await;
        assert_eq!(result["ok"], json!(false));
        assert_eq!(result["error"], json!("insufficient_scope"));
        assert_eq!(result["status"], json!(403));

        let offline: GetFn = Arc::new(|_url: String, _token: String| {
            Box::pin(async {
                GetOutcome {
                    status: 0,
                    body: json!({}),
                    network_error: Some("не дошло".to_string()),
                }
            })
        });
        let result = fetch_recent_donations(&offline, "tok", 30, 1).await;
        assert_eq!(result["error"], json!("не дошло"));
        assert_eq!(result["donations"], json!([]));
    }

    #[tokio::test]
    async fn without_a_token_the_request_is_not_sent() {
        let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&called);
        let get: GetFn = Arc::new(move |_url: String, _token: String| {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async {
                GetOutcome {
                    status: 200,
                    body: json!({}),
                    network_error: None,
                }
            })
        });
        let result = fetch_recent_donations(&get, "", 30, 1).await;
        assert_eq!(result["error"], json!("not_authorized"));
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
    }
}
