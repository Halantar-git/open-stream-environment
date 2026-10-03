//! Выгрузка истории событий в CSV.
//!
//! Порт `server/export-events.js`. Вынесено из общей сборки экспорта, потому что
//! форматирование (и особенно экранирование) проще проверять тестами отдельно,
//! чем через файл, который руками открывает пользователь.
//!
//! Экранирование — по RFC 4180: значение с запятой, кавычкой, точкой с запятой
//! или переводом строки заворачивается в кавычки, внутренние кавычки удваиваются.
//! Точка с запятой экранируется тоже, хотя разделитель — запятая: так файл
//! открывается и в русском Excel, где разделителем списка служит `;`.

use serde_json::Value;

use super::history::{js_key, js_truthy};
use super::logger;

/// Шапка файла — имена колонок, как их ждёт пользователь в таблице.
pub const CSV_HEADER: [&str; 10] = [
    "id",
    "timestamp",
    "date",
    "type",
    "kind",
    "username",
    "amount",
    "currency",
    "message",
    "is_test",
];

/// Одно значение как ячейка CSV.
pub fn csv_cell(value: Option<&Value>) -> String {
    let text = match value {
        // `value == null` в JS — это и `null`, и `undefined`.
        None | Some(Value::Null) => String::new(),
        Some(value) => js_key(value),
    };
    if text.contains(['"', ',', '\n', ';']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

/// История событий целиком: шапка и по строке на событие.
pub fn events_to_csv(items: &[Value]) -> String {
    let mut out = CSV_HEADER.join(",");
    out.push('\n');
    for item in items {
        out.push_str(&row(item));
        out.push('\n');
    }
    out
}

/// Строка одного события.
fn row(event: &Value) -> String {
    let timestamp = event.get("timestamp");
    let cells = [
        csv_cell(event.get("id")),
        csv_cell(timestamp),
        csv_cell(iso_or_blank(timestamp).as_ref()),
        csv_cell(event.get("type")),
        csv_cell(event.get("kind")),
        csv_cell(event.get("username")),
        match event.get("amount") {
            Some(value @ Value::Number(_)) => csv_cell(Some(value)),
            _ => String::new(),
        },
        csv_cell(event.get("currency")),
        csv_cell(event.get("message")),
        if js_truthy(event.get("is_test")) {
            "1".to_string()
        } else {
            "0".to_string()
        },
    ];
    cells.join(",")
}

/// Время события в ISO; пусто, если времени нет или оно не число.
///
/// Отличие от JS осознанное: там `new Date("мусор").toISOString()` бросает
/// исключение и роняет выгрузку целиком, а `new Date("1000")` разбирается как
/// **год 1000**. Для выгрузки полезнее пустая ячейка, чем сломанный файл.
fn iso_or_blank(timestamp: Option<&Value>) -> Option<Value> {
    let ms = timestamp?.as_f64()?;
    if !js_truthy(timestamp) {
        return None; // ноль — это «времени нет»
    }
    let moment = logger::iso_from_unix_ms(ms as i64)?;
    Some(Value::from(moment))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lines(csv: &str) -> Vec<&str> {
        csv.trim_end_matches('\n').split('\n').collect()
    }

    #[test]
    fn cell_escapes_quotes_commas_and_newlines() {
        assert_eq!(csv_cell(Some(&json!("plain"))), "plain");
        assert_eq!(csv_cell(None), "");
        assert_eq!(csv_cell(Some(&Value::Null)), "");
        assert_eq!(csv_cell(Some(&json!(42))), "42");
        assert_eq!(csv_cell(Some(&json!(true))), "true");
        assert_eq!(csv_cell(Some(&json!("say \"hi\""))), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_cell(Some(&json!("a,b"))), "\"a,b\"");
        assert_eq!(csv_cell(Some(&json!("a;b"))), "\"a;b\"");
        assert_eq!(csv_cell(Some(&json!("line\nbreak"))), "\"line\nbreak\"");
    }

    #[test]
    fn csv_has_the_header_and_a_row_per_event() {
        let csv = events_to_csv(&[json!({
            "id": "e1",
            "timestamp": 1000,
            "type": "donation",
            "kind": "donation",
            "username": "bob",
            "amount": 100,
            "currency": "RUB",
            "message": "hi",
            "is_test": false,
        })]);

        let lines = lines(&csv);
        assert_eq!(lines[0], CSV_HEADER.join(","));
        assert_eq!(
            lines[1],
            "e1,1000,1970-01-01T00:00:01.000Z,donation,donation,bob,100,RUB,hi,0"
        );
    }

    #[test]
    fn missing_fields_become_empty_cells_and_tests_are_marked() {
        let csv = events_to_csv(&[
            json!({ "id": "e2", "type": "follow", "is_test": true, "message": "a,b" }),
        ]);

        let lines = lines(&csv);
        assert_eq!(lines[1], "e2,,,follow,,,,,\"a,b\",1");
    }

    #[test]
    fn empty_history_gives_only_the_header() {
        let expected = format!("{}\n", CSV_HEADER.join(","));
        assert_eq!(events_to_csv(&[]), expected);
    }

    #[test]
    fn zero_and_broken_timestamps_leave_the_date_empty() {
        let csv = events_to_csv(&[
            json!({ "id": "zero", "timestamp": 0 }),
            json!({ "id": "text", "timestamp": "мусор" }),
            json!({ "id": "none" }),
        ]);

        let lines = lines(&csv);
        assert_eq!(lines[1], "zero,0,,,,,,,,0");
        assert_eq!(lines[2], "text,мусор,,,,,,,,0");
        assert_eq!(lines[3], "none,,,,,,,,,0");
    }
}
