//! GoodGame: разбор кадров чата v2 и событий канала.
//!
//! Порт публичного API `GoodGame/API` в той части, что только *решает*:
//! сообщение чата, фоллоу, донат, премиум и подарочный премиум превращаются в
//! те же события шины, что приходят из Twitch и YouTube. Транспорт — в
//! [`crate::integrations::goodgame_control`].
//!
//! Чат GoodGame отдаёт текст уже с экранированной HTML-разметкой, поэтому здесь
//! есть обратное преобразование: дальше по конвейеру сообщение экранируется
//! заново при отрисовке, и без этого пользователь увидел бы `&lt;` вместо `<`.

use serde_json::{json, Map, Value};

use crate::integrations::nick_color::nick_color;
use crate::storage::history::{js_number, js_number_or_zero, js_truthy, number_value};

/// Адрес чата v2.
pub const CHAT_WS_URL: &str = "wss://chat-1.goodgame.ru/chat2/";
/// Статус канала по имени или числовому id: из ответа берётся `channel_id`.
pub const CHANNEL_STATUS_URL: &str = "https://goodgame.ru/api/getchannelstatus";

/// Адрес поиска канала по имени или id.
pub fn status_url(channel: &str) -> String {
    format!(
        "{CHANNEL_STATUS_URL}?id={}&fmt=json",
        encode_component(channel.trim())
    )
}

/// `encodeURIComponent`: не трогает `A-Za-z0-9-_.!~*'()`, остальное — `%XX`.
fn encode_component(text: &str) -> String {
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

/// Числовой `channel_id` из ответа `getchannelstatus`.
///
/// Ответ — объект, ключ которого и есть id канала (`{"5": {...}}`). Пустой
/// массив `[]` означает, что канала нет. Символьный ключ в ответе (`key`)
/// оставлен для справки; доверяем именно ключу объекта, потому что чат ждёт
/// числовой идентификатор.
pub fn channel_id_from_status(body: &Value) -> Option<String> {
    let object = body.as_object()?;
    object
        .keys()
        .find(|id| !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()))
        .cloned()
}

/// Сообщение чата для шины.
///
/// `text` приходит с экранированными `&`, `<`, `>`; ники и текст — как есть.
/// Цвет платформы (`color`) — это категория (`moderator`, `silver`), а не hex,
/// поэтому оттенок считается по `user_id`, как у YouTube.
pub fn chat_message(data: &Value) -> Option<Value> {
    let text = unescape_html(&text_of(data.get("text")));
    let user = text_of(
        data.get("user_name")
            .or_else(|| data.get("userName"))
            .or_else(|| data.get("username")),
    );
    if user.is_empty() && text.is_empty() {
        return None;
    }
    let seed = match data.get("user_id") {
        Some(value) if js_truthy(Some(value)) => value.clone(),
        _ => Value::from(user.clone()),
    };

    Some(json!({
        "user": if user.is_empty() { "GG".to_string() } else { user },
        "message": text,
        "source": "goodgame",
        "color": nick_color(&seed),
        "badges": badges(data),
        "emotes": {},
    }))
}

/// Значки автора. Коды прав — из протокола (`user_rights`): 10 — помощник
/// стримера, 20 — стример, 30–50 — модерация. `premium` — платная подписка на
/// канал, её показываем тем же значком, что саб Twitch.
fn badges(data: &Value) -> Vec<Value> {
    let rights = js_number_or_zero(data.get("user_rights"));
    let mut out = Vec::new();
    if (20.0..30.0).contains(&rights) {
        out.push(Value::from("broadcaster"));
    } else if rights >= 10.0 {
        out.push(Value::from("moderator"));
    }
    if js_truthy(data.get("premium")) || !premiums_of(data).is_empty() {
        out.push(Value::from("subscriber"));
    }
    if js_truthy(data.get("staff")) {
        out.push(Value::from("staff"));
    }
    out
}

/// Алерт из события канала; `None` — событие нам неизвестно.
pub fn event_alert(kind: &str, data: &Value) -> Option<Value> {
    match kind {
        "follower" => Some(json!({
            "kind": "follow",
            "user": user_of(data),
        })),
        "payment" => Some(json!({
            "kind": "donation",
            "user": user_of(data),
            "amount": amount_of(data.get("amount")),
            "currency": "RUB",
            "message": text_of(data.get("message")),
        })),
        "premium" => {
            let months = js_number_or_zero(data.get("resub")).round().max(0.0);
            Some(json!({
                "kind": "sub",
                "user": user_of(data),
                "tier": "premium",
                "months": number_value(if months > 0.0 { months } else { 1.0 }),
                "resub": months > 0.0,
            }))
        }
        "gifted_premiums" => {
            let count = data
                .get("users")
                .and_then(Value::as_array)
                .map(|users| users.len())
                .filter(|count| *count > 0)
                .unwrap_or(1);
            let payer = text_of(data.get("payer"));
            Some(json!({
                "kind": "gift_sub",
                "user": if payer.is_empty() { "Аноним".to_string() } else { payer },
                "count": count,
            }))
        }
        _ => None,
    }
}

/// Сумма доната: `"1111.00"` → `1111`, мусор → `0`.
fn amount_of(value: Option<&Value>) -> Value {
    let amount = js_number(value);
    number_value(if amount.is_finite() { amount } else { 0.0 })
}

/// Ник автора события: у разных событий он в `userName` или `username`.
fn user_of(data: &Value) -> String {
    let user = text_of(
        data.get("userName")
            .or_else(|| data.get("username"))
            .or_else(|| data.get("user_name")),
    );
    if user.is_empty() {
        "Аноним".to_string()
    } else {
        user
    }
}

fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(value) if js_truthy(Some(value)) => crate::state::js_string(value),
        _ => String::new(),
    }
}

/// `premiums` — список каналов, на которых у пользователя есть премиум.
fn premiums_of(data: &Value) -> Vec<Value> {
    data.get("premiums")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Обратное к экранированию протокола. `&amp;` последним, иначе `&amp;lt;`
/// превратилось бы в `<`, хотя это литеральный текст `&lt;`.
pub fn unescape_html(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Параметры `join` для чата v2.
pub fn join_frame(channel_id: &str) -> Value {
    json!({
        "type": "join",
        "data": {
            "channel_id": channel_id,
            "hidden": 0,
            "mobile": false,
            "reload": false,
        },
    })
}

/// Разбор одного кадра: `(type, data)`; не JSON — `None`.
pub fn parse_frame(frame: &str) -> Option<(String, Value)> {
    let value: Value = serde_json::from_str(frame).ok()?;
    let kind = value.get("type").and_then(Value::as_str)?.to_string();
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    Some((kind, data))
}

/// Сообщение для шины в форме `commands::broadcast`.
pub fn bus_event(kind: &str, payload: Value) -> Value {
    let mut out = Map::new();
    out.insert("type".to_string(), Value::from(kind));
    out.insert("payload".to_string(), payload);
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_channel_id_is_the_numeric_key_of_the_status_response() {
        let body = json!({ "5": { "key": "Miker", "status": "Live" } });
        assert_eq!(channel_id_from_status(&body), Some("5".to_string()));
        // Нет канала — пустой массив.
        assert_eq!(channel_id_from_status(&json!([])), None);
        // Ключ-не-число не подойдёт чату.
        assert_eq!(channel_id_from_status(&json!({ "abc": {} })), None);
    }

    #[test]
    fn a_chat_message_becomes_a_bus_message() {
        let data = json!({
            "user_id": 162675,
            "user_name": "Resmile",
            "user_rights": 10,
            "premium": 1,
            "text": "&lt;b&gt;привет&lt;/b&gt; &amp; как дела",
        });
        let message = chat_message(&data).expect("сообщение");
        assert_eq!(message["user"], json!("Resmile"));
        assert_eq!(message["message"], json!("<b>привет</b> & как дела"));
        assert_eq!(message["source"], json!("goodgame"));
        assert_eq!(message["badges"], json!(["moderator", "subscriber"]));
        assert_eq!(message["emotes"], json!({}));
        assert_eq!(message["color"], json!(nick_color(&json!(162675))));
    }

    #[test]
    fn a_streamer_gets_the_broadcaster_badge() {
        let data = json!({ "user_name": "Miker", "user_rights": 20, "text": "привет" });
        let message = chat_message(&data).expect("сообщение");
        assert_eq!(message["badges"], json!(["broadcaster"]));
    }

    #[test]
    fn a_system_message_without_a_user_still_arrives() {
        let message = chat_message(&json!({ "text": "запись чата включена", "isStatus": 1 }))
            .expect("системное сообщение");
        assert_eq!(message["user"], json!("GG"));
        assert_eq!(message["badges"], json!([]));
    }

    #[test]
    fn a_follow_becomes_a_follow_alert() {
        let alert = event_alert(
            "follower",
            &json!({ "userId": 58559, "username": "MyDream", "channel_id": 158456 }),
        )
        .expect("алерт");
        assert_eq!(alert["kind"], json!("follow"));
        assert_eq!(alert["user"], json!("MyDream"));
    }

    #[test]
    fn a_payment_becomes_a_donation_alert() {
        let alert = event_alert(
            "payment",
            &json!({
                "userId": "779436",
                "userName": "marked0ne",
                "amount": "1111.00",
                "message": "ну с ДР",
            }),
        )
        .expect("алерт");
        assert_eq!(alert["kind"], json!("donation"));
        assert_eq!(alert["user"], json!("marked0ne"));
        assert_eq!(alert["amount"], json!(1111));
        assert_eq!(alert["currency"], json!("RUB"));
        assert_eq!(alert["message"], json!("ну с ДР"));
    }

    #[test]
    fn a_premium_becomes_a_sub_alert() {
        let alert = event_alert(
            "premium",
            &json!({ "userName": "Agroshkolnik42", "payment": 0, "resub": "7" }),
        )
        .expect("алерт");
        assert_eq!(alert["kind"], json!("sub"));
        assert_eq!(alert["user"], json!("Agroshkolnik42"));
        assert_eq!(alert["months"], json!(7));
        assert_eq!(alert["resub"], json!(true));

        // Новый премиум — не продление.
        let alert =
            event_alert("premium", &json!({ "userName": "Новичок", "resub": "" })).expect("алерт");
        assert_eq!(alert["months"], json!(1));
        assert_eq!(alert["resub"], json!(false));
    }

    #[test]
    fn gifted_premiums_become_a_gift_alert() {
        let alert = event_alert(
            "gifted_premiums",
            &json!({
                "payer": "marked0ne",
                "users": [{ "id": 1, "username": "a" }, { "id": 2, "username": "b" }],
            }),
        )
        .expect("алерт");
        assert_eq!(alert["kind"], json!("gift_sub"));
        assert_eq!(alert["user"], json!("marked0ne"));
        assert_eq!(alert["count"], json!(2));

        // Без дарителя — «Аноним».
        let alert =
            event_alert("gifted_premiums", &json!({ "payer": "", "users": [] })).expect("алерт");
        assert_eq!(alert["user"], json!("Аноним"));
        assert_eq!(alert["count"], json!(1));
    }

    #[test]
    fn an_unknown_event_is_ignored() {
        assert!(event_alert("channel_counters", &json!({})).is_none());
    }

    #[test]
    fn html_escapes_are_decoded_once() {
        assert_eq!(unescape_html("&lt;b&gt;"), "<b>");
        assert_eq!(unescape_html("a &amp; b"), "a & b");
        // Двойное экранирование — это литеральный `&lt;`, а не тег.
        assert_eq!(unescape_html("&amp;lt;"), "&lt;");
    }

    #[test]
    fn the_status_url_encodes_the_channel_name() {
        assert_eq!(
            status_url("Miker"),
            "https://goodgame.ru/api/getchannelstatus?id=Miker&fmt=json"
        );
        assert!(status_url(" a b ").contains("id=a%20b&"));
    }

    #[test]
    fn a_frame_is_parsed_into_type_and_data() {
        let (kind, data) =
            parse_frame(r#"{"type":"message","data":{"text":"привет"}}"#).expect("кадр");
        assert_eq!(kind, "message");
        assert_eq!(data["text"], json!("привет"));
        assert!(parse_frame("junk").is_none());
    }

    #[test]
    fn a_join_frame_names_the_channel_and_does_not_hide_the_client() {
        let frame = join_frame("5");
        assert_eq!(frame["type"], json!("join"));
        assert_eq!(frame["data"]["channel_id"], json!("5"));
        assert_eq!(frame["data"]["hidden"], json!(0));
    }
}
