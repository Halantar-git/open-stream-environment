//! YouTube Live: разбор сообщений и событий чата.
//!
//! Порт `server/integrations/youtube-live.js` в части, что только *решает*:
//! классификация отказа `liveChatMessages` (чат кончился или это лимит/квота),
//! микро-суммы в валюту, сообщение чата и алерт (Super Chat / Super Sticker /
//! участники), период опроса. Это те же данные, что уходят в `bus.emit`.
//!
//! Транспорт (опрос `liveChatMessages` через HTTP, поиск `liveChatId`) идёт
//! следом и останется тонким поверх этого слоя.

use serde_json::{json, Map, Value};

use crate::integrations::nick_color::nick_color;
use crate::storage::history::{js_number, js_number_or_zero, js_truthy, number_value};

/// Как часто опрашивать чат, если сервис не подсказал.
pub const FALLBACK_POLL_MS: u64 = 4_000;
/// Ниже этого периода не опускаемся.
pub const MIN_POLL_MS: u64 = 1_000;
/// Пауза перед повтором после сбоя.
pub const RETRY_DELAY_MS: u64 = 10_000;
/// Пауза при исчерпании квоты.
pub const QUOTA_BACKOFF_MS: u64 = 30_000;

/// Причины 403, при которых чат уже мёртв (эфир кончился, чат выключен).
const ENDED_CHAT_REASONS: [&str; 3] = ["livechatended", "livechatdisabled", "livechatnotfound"];

/// Что делать после отказа `liveChatMessages`.
///
/// `"ended"` — чат мёртв: сбросить `liveChatId` и искать эфир заново. `"backoff"`
/// — лимит/квота/запрет: подождать и повторить. Причина лежит в
/// `error.errors[].reason`, но тело может прийти и не-JSON — тогда смотрим сырой
/// текст.
pub fn classify_live_chat_failure(body_text: &str) -> &'static str {
    let mut reasons = String::new();
    if let Ok(body) = serde_json::from_str::<Value>(body_text) {
        if let Some(errors) = body
            .get("error")
            .and_then(|error| error.get("errors"))
            .and_then(Value::as_array)
        {
            reasons = errors
                .iter()
                .map(|error| {
                    error
                        .get("reason")
                        .filter(|reason| js_truthy(Some(reason)))
                        .map(crate::state::js_string)
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
                .join(" ");
        }
    }
    let haystack = format!("{reasons} {body_text}").to_lowercase();
    if haystack.contains("offlineat") {
        return "ended";
    }
    if ENDED_CHAT_REASONS
        .iter()
        .any(|reason| haystack.contains(reason))
    {
        "ended"
    } else {
        "backoff"
    }
}

/// Микро-сумма в валюту; не число — ноль.
pub fn micros_to_amount(micros: &Value) -> f64 {
    let number = js_number(Some(micros));
    if number.is_finite() {
        number / 1_000_000.0
    } else {
        0.0
    }
}

/// Сообщение чата YouTube для шины.
pub fn chat_message_from_item(item: &Value) -> Value {
    let snippet = item.get("snippet").cloned().unwrap_or_else(|| json!({}));
    let author = item
        .get("authorDetails")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let mut badges: Vec<Value> = Vec::new();
    if js_truthy(author.get("isChatOwner")) {
        badges.push(Value::from("broadcaster"));
    }
    if js_truthy(author.get("isChatModerator")) {
        badges.push(Value::from("moderator"));
    }
    if js_truthy(author.get("isChatSponsor")) {
        badges.push(Value::from("subscriber"));
    }

    // `(textMessageDetails && textMessageDetails.messageText) || displayMessage
    // || ""`: пустая строка так же ложна, как отсутствие поля, поэтому
    // отсеиваем её явно.
    let message = snippet
        .get("textMessageDetails")
        .and_then(|details| details.get("messageText"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .or_else(|| snippet.get("displayMessage").and_then(Value::as_str))
        .unwrap_or("");
    let display = snippet_display(&author);

    // Цвет автора YouTube не отдаёт — считаем его из `channelId || displayName`,
    // как в JS: без обоих `nickColor` вернёт цвет по умолчанию.
    let seed = match author.get("channelId") {
        Some(value) if js_truthy(Some(value)) => value.clone(),
        _ => author.get("displayName").cloned().unwrap_or(Value::Null),
    };

    json!({
        "user": display,
        "message": message,
        "source": "youtube",
        "color": nick_color(&seed),
        "badges": badges,
        "emotes": {},
    })
}

/// Алерт из события чата (Super Chat / Sticker / участники); `None` — не событие.
pub fn event_alert_from_item(item: &Value) -> Option<Value> {
    let snippet = item.get("snippet").cloned().unwrap_or_else(|| json!({}));
    let author = item
        .get("authorDetails")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let kind = snippet.get("type").and_then(Value::as_str).unwrap_or("");
    let user = snippet_display(&author);

    match kind {
        "superChatEvent" | "superStickerEvent" => {
            let details = if kind == "superChatEvent" {
                snippet.get("superChatDetails")
            } else {
                snippet.get("superStickerDetails")
            };
            let amount = micros_to_amount(
                details
                    .and_then(|details| details.get("amountMicros"))
                    .unwrap_or(&Value::Null),
            );
            let comment = details
                .and_then(|details| details.get("userComment"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    details
                        .and_then(|details| details.get("amountDisplayString"))
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| {
                    if kind == "superStickerEvent" {
                        "Super Sticker".to_string()
                    } else {
                        "Super Chat".to_string()
                    }
                });

            let mut out = Map::new();
            out.insert("kind".to_string(), Value::from("donation"));
            out.insert("user".to_string(), Value::from(user));
            out.insert("amount".to_string(), number_value(amount));
            out.insert("message".to_string(), Value::from(comment));
            // `currency || undefined` — пустая валюта в JSON не попадает.
            if let Some(currency) = details
                .and_then(|details| details.get("currency"))
                .filter(|value| js_truthy(Some(value)))
            {
                out.insert("currency".to_string(), currency.clone());
            }
            Some(Value::Object(out))
        }
        "newSponsorEvent" | "memberMilestoneChatEvent" => {
            let details = if kind == "newSponsorEvent" {
                snippet.get("newSponsorDetails")
            } else {
                snippet.get("memberMilestoneDetails")
            };
            let tier = details
                .and_then(|details| details.get("memberLevelName"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .unwrap_or("Member");
            Some(json!({ "kind": "sub", "user": user, "tier": tier }))
        }
        _ => None,
    }
}

/// Период опроса из ответа: не меньше [`MIN_POLL_MS`], иначе [`FALLBACK_POLL_MS`].
pub fn polling_interval(json: &Value) -> u64 {
    let raw = js_number_or_zero(json.get("pollingIntervalMillis"));
    let interval = if raw == 0.0 {
        FALLBACK_POLL_MS as f64
    } else {
        raw
    };
    interval.max(MIN_POLL_MS as f64) as u64
}

/// `authorDetails.displayName || "viewer"`.
fn snippet_display(author: &Value) -> String {
    author
        .get("displayName")
        .filter(|name| js_truthy(Some(name)))
        .map(crate::state::js_string)
        .unwrap_or_else(|| "viewer".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dead_chat_is_told_from_a_quota_limit() {
        assert_eq!(
            classify_live_chat_failure(
                r#"{ "error": { "errors": [ { "reason": "liveChatEnded" } ] } }"#
            ),
            "ended"
        );
        assert_eq!(
            classify_live_chat_failure("stream offlineAt 2024-01-01"),
            "ended"
        );
        assert_eq!(classify_live_chat_failure("not json"), "backoff");
        assert_eq!(
            classify_live_chat_failure(
                r#"{ "error": { "errors": [ { "reason": "quotaExceeded" } ] } }"#
            ),
            "backoff"
        );
    }

    #[test]
    fn micros_become_currency() {
        assert_eq!(micros_to_amount(&json!(5_000_000)), 5.0);
        assert_eq!(micros_to_amount(&json!(1_500_000)), 1.5);
        assert_eq!(micros_to_amount(&json!("abc")), 0.0);
        assert_eq!(micros_to_amount(&Value::Null), 0.0);
    }

    #[test]
    fn a_text_message_becomes_a_chat_message() {
        let item = json!({
            "snippet": { "type": "textMessageEvent", "textMessageDetails": { "messageText": "привет" } },
            "authorDetails": { "displayName": "Зритель", "channelId": "UCabc", "isChatOwner": true, "isChatSponsor": true },
        });
        let message = chat_message_from_item(&item);
        assert_eq!(message["user"], json!("Зритель"));
        assert_eq!(message["message"], json!("привет"));
        assert_eq!(message["source"], json!("youtube"));
        assert_eq!(message["badges"], json!(["broadcaster", "subscriber"]));
        assert_eq!(message["emotes"], json!({}));
        assert_eq!(message["color"], json!(nick_color(&json!("UCabc"))));
    }

    #[test]
    fn a_missing_author_falls_back_to_viewer_and_display_message() {
        let item = json!({ "snippet": { "displayMessage": "привет" } });
        let message = chat_message_from_item(&item);
        assert_eq!(message["user"], json!("viewer"));
        assert_eq!(message["message"], json!("привет"));
        assert_eq!(message["badges"], json!([]));
    }

    #[test]
    fn a_super_chat_becomes_a_donation_alert() {
        let item = json!({
            "snippet": {
                "type": "superChatEvent",
                "superChatDetails": { "amountMicros": "5000000", "currency": "RUB", "userComment": "Молодец!" },
            },
            "authorDetails": { "displayName": "Фанат" },
        });
        let alert = event_alert_from_item(&item).expect("алерт");
        assert_eq!(alert["kind"], json!("donation"));
        assert_eq!(alert["user"], json!("Фанат"));
        assert_eq!(alert["amount"], json!(5));
        assert_eq!(alert["currency"], json!("RUB"));
        assert_eq!(alert["message"], json!("Молодец!"));
    }

    #[test]
    fn a_super_sticker_without_a_comment_gets_a_title() {
        let item = json!({
            "snippet": { "type": "superStickerEvent", "superStickerDetails": { "amountMicros": 2000000 } },
            "authorDetails": {},
        });
        let alert = event_alert_from_item(&item).expect("алерт");
        assert_eq!(alert["message"], json!("Super Sticker"));
        // Пустая валюта в JSON не попадает.
        assert!(alert.get("currency").is_none());
    }

    #[test]
    fn a_new_member_becomes_a_sub_alert() {
        let item = json!({
            "snippet": { "type": "newSponsorEvent", "newSponsorDetails": { "memberLevelName": "Gold" } },
            "authorDetails": { "displayName": "Новичок" },
        });
        let alert = event_alert_from_item(&item).expect("алерт");
        assert_eq!(alert["kind"], json!("sub"));
        assert_eq!(alert["user"], json!("Новичок"));
        assert_eq!(alert["tier"], json!("Gold"));
        // Обычное сообщение — не событие.
        assert!(
            event_alert_from_item(&json!({ "snippet": { "type": "textMessageEvent" } })).is_none()
        );
    }

    #[test]
    fn the_poll_interval_respects_the_floor() {
        assert_eq!(
            polling_interval(&json!({ "pollingIntervalMillis": 5000 })),
            5000
        );
        assert_eq!(
            polling_interval(&json!({ "pollingIntervalMillis": 500 })),
            MIN_POLL_MS
        );
        assert_eq!(polling_interval(&json!({})), FALLBACK_POLL_MS);
    }
}
