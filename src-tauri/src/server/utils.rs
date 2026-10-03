//! Мелкие помощники протокола: тестовые алерты и запись события в историю.
//!
//! Порт четырёх функций из `server/index.js` (`buildTestAlert`,
//! `eventTypeForKind`, `toStreamEvent`, `shouldHideWheelAfterSpin`) — их проверяет
//! `tests/server-utils.test.js`. Живут отдельно от транспорта не ради красоты:
//! это чистые преобразования одних данных в другие, и проверяются они без
//! сокета, настроек и оверлея.
//!
//! Связь с историей: [`to_stream_event`] собирает запись в том самом виде, в
//! котором её хранит `local-db.jsonl` (`storage::history`), — ключи менять
//! нельзя, иначе старые записи и новые перестанут читаться одинаково.

use serde_json::{json, Map, Value};

use crate::storage::history::{js_key, js_truthy, number_value};

/// Имена тестовых зрителей — те же, что в JS-версии.
const TEST_NAMES: [&str; 4] = ["nova_viewer", "star_gazer", "orbit_fan", "comet_watcher"];

/// Длинный текст для проверки переноса строк в алерте (~200 символов).
///
/// В JS это конкатенация трёх строк с `.slice(0, 200)`; здесь — тот же текст,
/// обрезанный по символам (кириллица в UTF-16 и в Rust занимает по одному
/// символу, так что граница совпадает).
const LONG_DONATION_TEXT: &str = "Спасибо за поддержку канала и за уютную атмосферу на каждом стриме! Твой вклад очень важен, он помогает каналу расти и развиваться дальше. Желаю тебе удачи, вдохновения, здоровья и как можно больше позитивных эмоций!";

/// Сколько символов оставлять в длинном тестовом тексте.
const LONG_DONATION_LIMIT: usize = 200;

/// Тестовый алерт для кнопки «проверить алерт».
///
/// `kind` — вид события; всё, что не опознано (в том числе пустая строка),
/// ведёт себя как `follow` — так же, как ветка `default` в JS.
pub fn build_test_alert(kind: &str) -> Value {
    let user = test_viewer();
    match kind {
        "sub" => json!({ "kind": "sub", "user": user, "tier": "1000" }),
        "gift_sub" => json!({ "kind": "gift_sub", "user": user, "count": 3 }),
        "cheer" => json!({ "kind": "cheer", "user": user, "amount": 250 }),
        "donation" => json!({
            "kind": "donation",
            "user": user,
            "amount": 300,
            "currency": "RUB",
            "message": "Удачного стрима!",
        }),
        "donation_long" => {
            let message: String = LONG_DONATION_TEXT
                .chars()
                .take(LONG_DONATION_LIMIT)
                .collect();
            json!({
                "kind": "donation",
                "user": user,
                "amount": 750,
                "currency": "RUB",
                "message": message,
            })
        }
        _ => json!({ "kind": "follow", "user": user }),
    }
}

/// Случайное имя из списка.
///
/// В JS это `Math.floor(Math.random() * names.length)`. Отдельного источника
/// случайности ради одного имени заводить не хочется, а `uuid` уже есть в
/// зависимостях: берём байт из v4-идентификатора — распределение ровное, а
/// предсказуемость здесь не важна.
fn test_viewer() -> String {
    let byte = uuid::Uuid::new_v4().as_bytes()[0] as usize;
    TEST_NAMES[byte % TEST_NAMES.len()].to_string()
}

/// Тип события для записи истории: `follow`, `subscription`, `donation`.
///
/// Незнакомый вид остаётся собой — так же, как `kind || "unknown"` в JS.
pub fn event_type_for_kind(kind: &str) -> &str {
    match kind {
        "follow" => "follow",
        "sub" | "gift_sub" => "subscription",
        "donation" => "donation",
        "" => "unknown",
        other => other,
    }
}

/// Скрывать ли колесо после показа победителя.
///
/// Цикл закончен, если это обычный режим или финальный победитель в режиме на
/// выбывание. В остальных случаях следующий спин запускается автоматически, и
/// колесо должно остаться на экране.
pub fn should_hide_wheel_after_spin(giveaway: &Value) -> bool {
    // `giveaway || {}`: не объект и `null` — то же, что пусто.
    let elimination = js_truthy(giveaway.get("eliminationMode"));
    let final_winner = js_truthy(giveaway.get("isFinalWinner"));
    !(elimination && !final_winner)
}

/// Запись события для истории (`local-db.jsonl`).
///
/// Время передаётся снаружи: в JS внутри был `Date.now()`, здесь часы — забота
/// вызывающего, поэтому и запись проверяется точным значением, а не «числом».
pub fn to_stream_event(alert: &Value, is_test: bool, timestamp_ms: i64) -> Value {
    let kind = alert
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let mut out = Map::new();
    out.insert("timestamp".to_string(), Value::from(timestamp_ms));
    out.insert("type".to_string(), Value::from(event_type_for_kind(kind)));
    // В JS `kind: alert.kind` с `undefined` не доезжает до JSON — поля просто нет.
    if let Some(raw) = alert.get("kind") {
        out.insert("kind".to_string(), raw.clone());
    }
    out.insert("username".to_string(), text_or(alert.get("user"), "Аноним"));
    out.insert("amount".to_string(), number_or_null(alert.get("amount")));
    out.insert(
        "currency".to_string(),
        truthy(alert.get("currency")).unwrap_or(Value::Null),
    );
    out.insert("message".to_string(), text_or(alert.get("message"), ""));
    out.insert("is_test".to_string(), Value::from(is_test));
    out.insert("count".to_string(), number_or_null(alert.get("count")));
    out.insert(
        "tier".to_string(),
        truthy(alert.get("tier")).unwrap_or(Value::Null),
    );
    // Идентификатор доната на стороне сервиса: по нему «пропущенные» донаты не
    // попадают в историю второй раз (см. `Database::known_source_ids`).
    out.insert(
        "source_id".to_string(),
        alert
            .get("sourceId")
            .filter(|value| !value.is_null())
            .map(js_key)
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    Value::Object(out)
}

/// `String(value || fallback)`: пустое значение заменяется умолчанием.
fn text_or(value: Option<&Value>, fallback: &str) -> Value {
    if js_truthy(value) {
        Value::from(value.map(js_key).unwrap_or_default())
    } else {
        Value::from(fallback)
    }
}

/// `value || null`: пустое значение даёт `null`.
fn truthy(value: Option<&Value>) -> Option<Value> {
    if js_truthy(value) {
        value.cloned()
    } else {
        None
    }
}

/// `typeof value === "number" ? value : null`.
fn number_or_null(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Number(number)) => number.as_f64().map(number_value).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_test_alert_carries_the_fields_its_kind_needs() {
        let follow = build_test_alert("follow");
        assert_eq!(follow["kind"], json!("follow"));
        assert!(follow["user"].as_str().is_some_and(|user| !user.is_empty()));
        // Имя берётся из списка, а не выдумывается.
        assert!(TEST_NAMES.contains(&follow["user"].as_str().expect("имя")));

        let sub = build_test_alert("sub");
        assert_eq!(sub["kind"], json!("sub"));
        assert_eq!(sub["tier"], json!("1000"));

        let gift = build_test_alert("gift_sub");
        assert_eq!(gift["kind"], json!("gift_sub"));
        assert_eq!(gift["count"], json!(3));

        let cheer = build_test_alert("cheer");
        assert_eq!(cheer["amount"], json!(250));

        let donation = build_test_alert("donation");
        assert_eq!(donation["amount"], json!(300));
        assert_eq!(donation["currency"], json!("RUB"));
        assert_eq!(donation["message"], json!("Удачного стрима!"));

        // Незнакомый вид — обычный фоллоу, как ветка `default` в JS.
        assert_eq!(build_test_alert("")["kind"], json!("follow"));
        assert_eq!(build_test_alert("что-то")["kind"], json!("follow"));
    }

    #[test]
    fn a_long_test_alert_is_trimmed_to_two_hundred_characters() {
        let long = build_test_alert("donation_long");

        assert_eq!(long["kind"], json!("donation"));
        assert_eq!(long["amount"], json!(750));
        let message = long["message"].as_str().expect("сообщение");
        assert_eq!(message.chars().count(), LONG_DONATION_LIMIT);
        assert!(message.starts_with("Спасибо за поддержку канала"));
    }

    #[test]
    fn the_event_type_maps_kinds() {
        assert_eq!(event_type_for_kind("follow"), "follow");
        assert_eq!(event_type_for_kind("sub"), "subscription");
        assert_eq!(event_type_for_kind("gift_sub"), "subscription");
        assert_eq!(event_type_for_kind("donation"), "donation");
        assert_eq!(event_type_for_kind("cheer"), "cheer");
        assert_eq!(event_type_for_kind(""), "unknown");
    }

    #[test]
    fn a_stream_event_record_is_assembled() {
        let record = to_stream_event(
            &json!({ "kind": "sub", "user": "viewer", "count": 2, "tier": "1000" }),
            false,
            1_700_000_000_000,
        );

        assert_eq!(record["timestamp"], json!(1_700_000_000_000i64));
        assert_eq!(record["type"], json!("subscription"));
        assert_eq!(record["kind"], json!("sub"));
        assert_eq!(record["username"], json!("viewer"));
        assert_eq!(record["amount"], Value::Null);
        assert_eq!(record["currency"], Value::Null);
        assert_eq!(record["message"], json!(""));
        assert_eq!(record["is_test"], json!(false));
        assert_eq!(record["count"], json!(2));
        assert_eq!(record["tier"], json!("1000"));
        assert_eq!(record["source_id"], Value::Null);
    }

    #[test]
    fn a_stream_event_falls_back_to_anonymous_and_marks_tests() {
        let record = to_stream_event(&json!({ "kind": "donation", "amount": 10 }), true, 1000);

        assert_eq!(record["username"], json!("Аноним"));
        assert_eq!(record["is_test"], json!(true));
        assert_eq!(record["amount"], json!(10));
        assert_eq!(record["type"], json!("donation"));
        // Признак «пропущенный» едет строкой — конфиг и история хранят так же.
        let recovered =
            to_stream_event(&json!({ "kind": "donation", "sourceId": 42 }), false, 1000);
        assert_eq!(recovered["source_id"], json!("42"));
    }

    #[test]
    fn the_wheel_is_hidden_only_when_the_cycle_is_over() {
        // Обычный режим — прячем после любого победителя.
        assert!(should_hide_wheel_after_spin(
            &json!({ "eliminationMode": false, "isFinalWinner": false })
        ));
        // На выбывание, но победитель финальный — цикл закончен.
        assert!(should_hide_wheel_after_spin(
            &json!({ "eliminationMode": true, "isFinalWinner": true })
        ));
        // На выбывание, есть ещё участники — колесо остаётся для следующего спина.
        assert!(!should_hide_wheel_after_spin(
            &json!({ "eliminationMode": true, "isFinalWinner": false })
        ));
        // Защита от пустого значения.
        assert!(should_hide_wheel_after_spin(&Value::Null));
        assert!(should_hide_wheel_after_spin(&json!({})));
    }
}
