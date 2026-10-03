//! Журнал изменяющих команд.
//!
//! Порт `server/audit-log.js`. Приложение слушает порт, и на вопрос «а что вообще
//! происходило?» должен быть ответ: кто переключил сцену, откуда пришла команда,
//! не долбится ли кто-то в шину. Каждая команда оставляет запись в кольцевом
//! буфере — время, тип, роль клиента, признак «из сети» и пара безопасных деталей
//! (идентификаторы виджета или сцены, а **не** содержимое).
//!
//! Чего здесь сознательно нет и не должно быть:
//!
//! * полного payload — в сообщениях чата и настройках бывают личные данные и
//!   секреты, а журнал уходит в отчёт для поддержки;
//! * адресов клиентов — роли и признака «из сети» для разбора достаточно;
//! * записи в файловый журнал на каждое локальное действие — панель и оверлей
//!   шлют команды постоянно, и журнал превратился бы в шум. В файл уходят только
//!   события, интересные и после перезапуска: действия из сети и срабатывания
//!   ограничителя частоты (это решает вызывающий через `on_entry`).

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use super::history::{js_key, js_truthy};

/// Поля, которые безопасно показать в журнале: это идентификаторы и
/// переключатели, а не тексты.
pub const SAFE_FIELDS: [&str; 24] = [
    "id",
    "widgetId",
    "sceneId",
    "scene",
    "action",
    "type",
    "port",
    "lang",
    "level",
    "themeId",
    "index",
    "direction",
    "enabled",
    "visible",
    "soundId",
    "imageId",
    "cameraAngleId",
    "cameraFilterId",
    "presetId",
    "optionId",
    "rewardId",
    "hotkey",
    "target",
    "displayId",
];

/// Длинные строки в журнале обрезаются: там не место целым сообщениям.
pub const MAX_STRING: usize = 60;

/// По умолчанию храним 200 последних записей.
pub const DEFAULT_LIMIT: usize = 200;

/// Куда отдать запись: так вызывающий решает, что из журнала попадает в файл.
pub type EntryFn = dyn Fn(&Value) + Send + Sync + 'static;

/// Часы — подменяются в тестах, чтобы время записей было предсказуемым.
pub type ClockFn = dyn Fn() -> i64 + Send + Sync + 'static;

/// Значение, безопасное для журнала.
///
/// Числа и переключатели проходят как есть, `null` — тоже, всё остальное
/// приводится к строке и обрезается: идентификатор нужен целиком, а текст — нет.
pub fn safe_value(value: Option<&Value>) -> Value {
    match value {
        None => Value::Null,
        Some(Value::Null) => Value::Null,
        Some(value @ (Value::Number(_) | Value::Bool(_))) => value.clone(),
        Some(value) => {
            let text = js_key(value);
            if text.chars().count() > MAX_STRING {
                let head: String = text.chars().take(MAX_STRING).collect();
                Value::from(format!("{head}…"))
            } else {
                Value::from(text)
            }
        }
    }
}

/// Из payload берём только безопасные поля верхнего уровня.
///
/// Не объект (строка, число, массив) — это не payload, а мусор: `None`.
/// Ничего безопасного не нашлось — тоже `None`, чтобы в журнале не появлялись
/// пустые объекты.
pub fn summarize_payload(payload: &Value) -> Option<Value> {
    let fields = payload.as_object()?;
    let mut out = Map::new();
    for key in SAFE_FIELDS {
        if let Some(value) = fields.get(key) {
            // В JS поле с `undefined` не попадает в результат; в JSON такого
            // значения нет, поэтому значимо только «поля нет».
            out.insert(key.to_string(), safe_value(Some(value)));
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

/// Журнал изменяющих команд: кольцевой буфер и счётчики.
pub struct AuditLog {
    limit: usize,
    entries: Mutex<Vec<Value>>,
    on_entry: Option<Arc<EntryFn>>,
    clock: Arc<ClockFn>,
    counters: Mutex<(u64, u64, u64)>,
}

impl AuditLog {
    pub fn new(
        limit: Option<usize>,
        on_entry: Option<Arc<EntryFn>>,
        clock: Option<Arc<ClockFn>>,
    ) -> Self {
        Self {
            limit: limit.filter(|value| *value > 0).unwrap_or(DEFAULT_LIMIT),
            entries: Mutex::new(Vec::new()),
            on_entry,
            clock: clock.unwrap_or_else(|| Arc::new(|| chrono::Utc::now().timestamp_millis())),
            counters: Mutex::new((0, 0, 0)),
        }
    }

    pub fn limit(&self) -> usize {
        self.limit
    }

    /// Записать команду. Возвращает саму запись — её же отправляют в файл.
    pub fn record(&self, entry: &Value) -> Value {
        let item = json!({
            "at": (self.clock)(),
            "type": or_text(entry.get("type"), "unknown"),
            "role": or_text(entry.get("role"), "other"),
            "external": js_truthy(entry.get("external")),
            "limited": js_truthy(entry.get("limited")),
            "details": match entry.get("details") {
                Some(value) if js_truthy(Some(value)) => value.clone(),
                _ => Value::Null,
            },
        });

        {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            entries.push(item.clone());
            // Кольцевой буфер: старые записи уходят, как только упёрлись в лимит.
            while entries.len() > self.limit {
                entries.remove(0);
            }
        }

        {
            let mut counters = self
                .counters
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            counters.0 += 1;
            if js_truthy(item.get("external")) {
                counters.1 += 1;
            }
            if js_truthy(item.get("limited")) {
                counters.2 += 1;
            }
        }

        if let Some(on_entry) = &self.on_entry {
            // Журнал не должен мешать обработке команд: падение обработчика
            // записи гасим здесь же.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_entry(&item)));
        }

        item
    }

    /// Свежие записи: сначала новые — так их читает и человек, и отчёт.
    pub fn recent(&self, count: Option<usize>) -> Vec<Value> {
        let size = count.unwrap_or(50);
        if size == 0 {
            // Пусто именно по нулю: иначе «последние нуль» вернули бы всё.
            return Vec::new();
        }
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let from = entries.len().saturating_sub(size);
        entries[from..].iter().rev().cloned().collect()
    }

    /// Счётчики: всего записей, из сети, ограничено частотой и сколько храним.
    pub fn counters(&self) -> Value {
        let counters = *self
            .counters
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let kept = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len();
        json!({
            "total": counters.0,
            "external": counters.1,
            "limited": counters.2,
            "kept": kept,
        })
    }
}

/// `String(entry.type || "unknown")`: пустое значение заменяется умолчанием.
fn or_text(value: Option<&Value>, fallback: &str) -> Value {
    match value {
        Some(value) if js_truthy(Some(value)) => Value::from(js_key(value)),
        _ => Value::from(fallback),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn clock(start: i64) -> (Arc<ClockFn>, Arc<AtomicI64>) {
        let now = Arc::new(AtomicI64::new(start));
        let tick = Arc::clone(&now);
        let clock: Arc<ClockFn> = Arc::new(move || tick.fetch_add(1, Ordering::SeqCst));
        (clock, now)
    }

    #[test]
    fn entry_keeps_time_type_role_and_flags() {
        let (clock, _) = clock(1000);
        let log = AuditLog::new(None, None, Some(clock));

        let item = log.record(&json!({
            "type": "overlay:widget:update",
            "role": "overlay",
            "external": true,
            "limited": false,
            "details": { "widgetId": "w1" },
        }));

        assert_eq!(item["at"], json!(1000));
        assert_eq!(item["type"], json!("overlay:widget:update"));
        assert_eq!(item["role"], json!("overlay"));
        assert_eq!(item["external"], json!(true));
        assert_eq!(item["limited"], json!(false));
        assert_eq!(item["details"], json!({ "widgetId": "w1" }));

        assert_eq!(
            log.counters(),
            json!({ "total": 1, "external": 1, "limited": 0, "kept": 1 })
        );
    }

    #[test]
    fn empty_entry_gets_defaults() {
        let (clock, _) = clock(1);
        let log = AuditLog::new(None, None, Some(clock));

        let item = log.record(&Value::Null);

        assert_eq!(item["type"], json!("unknown"));
        assert_eq!(item["role"], json!("other"));
        assert_eq!(item["external"], json!(false));
        assert_eq!(item["limited"], json!(false));
        assert_eq!(item["details"], Value::Null);
    }

    #[test]
    fn ring_buffer_drops_the_oldest_entries() {
        let (clock, _) = clock(1);
        let log = AuditLog::new(Some(3), None, Some(clock));

        for index in 0..5 {
            log.record(&json!({ "type": format!("cmd{index}") }));
        }

        assert_eq!(log.limit(), 3);
        let recent = log.recent(None);
        assert_eq!(recent.len(), 3);
        // Свежие впереди, старые вытеснены.
        assert_eq!(recent[0]["type"], json!("cmd4"));
        assert_eq!(recent[2]["type"], json!("cmd2"));
        assert_eq!(log.counters()["total"], json!(5));
        assert_eq!(log.counters()["kept"], json!(3));
    }

    #[test]
    fn recent_zero_asks_for_nothing() {
        let (clock, _) = clock(1);
        let log = AuditLog::new(None, None, Some(clock));
        log.record(&json!({ "type": "x" }));

        assert!(log.recent(Some(0)).is_empty());
        assert_eq!(log.recent(Some(1)).len(), 1);
    }

    #[test]
    fn payload_summary_keeps_only_safe_fields_and_cuts_long_text() {
        let summary = summarize_payload(&json!({
            "widgetId": "w1",
            "scene": "intro",
            "enabled": true,
            "index": 3,
            "message": "секретный текст",
            "password": "hunter2",
            "nested": { "deep": 1 },
        }))
        .expect("безопасные поля есть");

        assert_eq!(summary["widgetId"], json!("w1"));
        assert_eq!(summary["scene"], json!("intro"));
        assert_eq!(summary["enabled"], json!(true));
        assert_eq!(summary["index"], json!(3));
        // Тексты и чужие поля не попадают в журнал.
        assert!(summary.get("message").is_none());
        assert!(summary.get("password").is_none());
        assert!(summary.get("nested").is_none());

        let long = "я".repeat(MAX_STRING + 10);
        let cut = safe_value(Some(&Value::from(long)));
        let text = cut.as_str().unwrap_or_default();
        assert_eq!(
            text.chars().count(),
            MAX_STRING + 1,
            "обрезка со многоточием"
        );
        assert!(text.ends_with('…'));
    }

    #[test]
    fn payload_summary_needs_an_object_with_something_safe() {
        assert!(summarize_payload(&json!("строка")).is_none());
        assert!(summarize_payload(&json!(5)).is_none());
        assert!(summarize_payload(&json!([1, 2])).is_none());
        assert!(summarize_payload(&json!({ "password": "x" })).is_none());
        assert!(summarize_payload(&json!({})).is_none());
    }

    #[test]
    fn on_entry_receives_the_record_and_its_failure_is_swallowed() {
        let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
        let collector = Arc::clone(&seen);
        let log = AuditLog::new(
            None,
            Some(Arc::new(move |item: &Value| {
                collector.lock().unwrap().push(item.clone());
            })),
            None,
        );

        log.record(&json!({ "type": "a" }));
        assert_eq!(seen.lock().unwrap().len(), 1);

        // Обработчик падает — запись всё равно сделана и вернулась.
        let log = AuditLog::new(
            None,
            Some(Arc::new(|_item: &Value| panic!("файл недоступен"))),
            None,
        );
        let item = log.record(&json!({ "type": "b" }));
        assert_eq!(item["type"], json!("b"));
        assert_eq!(log.counters()["total"], json!(1));
    }
}
