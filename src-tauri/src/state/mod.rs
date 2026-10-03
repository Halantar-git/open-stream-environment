//! Состояние приложения: настройки, раскладка, сессии, розыгрыш и опрос.
//!
//! Порт `server/state.js`. Модуль большой, поэтому переносится частями, и каждая
//! часть живёт своим подмодулем:
//!
//! * [`layout`] — раскладка оверлея (виджеты) и её пресеты — сделано;
//! * [`runtime`] — счётчики рантайма (переподключения, сцена, камера, фильтры,
//!   розыгрыш, статистика, касса стрима) — сделано;
//! * [`poll`] — голосование зрителей и его пресеты — сделано;
//! * [`appearance`] — темы, свои темы, редактор и HUD — сделано;
//! * [`config`] — цель, очередь алертов, интеграции, звук, бот, уведомления —
//!   сделано;
//! * [`scenes`] — полноэкранные сцены, сплеш и крупный донат — сделано;
//! * [`snapshot`] — сборка `STATE` из всех частей — сделано.
//!
//! `state.js` перенесён целиком: снимок уходит клиентам первым кадром шины, а
//! команды панели разбирает `server/commands.rs`.
//!
//! Общее для всех частей — не «объект с полями», а данные: настройки лежат в
//! [`ConfigFile`], раскладка и пресеты — в [`Database`]. Функции модуля читают и
//! пишут именно их, поэтому второй копии состояния (как `this.config` и
//! `this._layout` в JS) не заводится: меньше мест, где одно и то же может
//! разъехаться.
//!
//! Исключение — [`runtime`]: это состояние принципиально живёт в памяти и на диск
//! не попадает (сколько раз интеграция переподключалась, кто сейчас на колесе).
//! Его и держит [`runtime::Runtime`], а не настройки.

pub mod appearance;
pub mod config;
pub mod layout;
pub mod poll;
pub mod runtime;
pub mod scenes;
pub mod snapshot;

use serde_json::Value;

use crate::storage::config_file::ConfigFile;
use crate::storage::history::js_truthy;
use crate::themes;

/// Своя тема пользователя по идентификатору.
///
/// Встроенные темы здесь не ищутся: для них есть [`themes::builtin_theme`].
pub fn find_custom_theme(config: &ConfigFile, id: &str) -> Option<Value> {
    config
        .get("appearance")?
        .get("customThemes")?
        .as_array()?
        .iter()
        .find(|theme| theme.get("id").and_then(Value::as_str) == Some(id))
        .cloned()
}

/// `String(value)` по правилам JS — в отличие от `Value::to_string`, который
/// печатал бы строку в кавычках.
///
/// Нужно там, где значение приходит извне (команда пульта, поле чата) и по
/// контракту превращается в строку: сцена, ник, идентификатор камеры.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `String(value || "").trim()`: ложное значение даёт пустую строку.
///
/// Нужно там, где значение приходит извне и должно стать обрезанным именем:
/// ник участника розыгрыша, имя пресета.
pub(crate) fn string_trim(value: &Value) -> String {
    if !js_truthy(Some(value)) {
        return String::new();
    }
    js_string(value).trim().to_string()
}

/// Размерность темы: `2d` или `3d` у встроенной, `2d` у своей, `None` — темы нет.
///
/// По этому значению `applyLayoutPreset` решает, можно ли вернуть тему из пресета.
pub fn theme_dimension(config: &ConfigFile, id: &str) -> Option<String> {
    if let Some(theme) = themes::builtin_theme(id) {
        return Some(
            theme
                .get("dimension")
                .and_then(Value::as_str)
                .unwrap_or("2d")
                .to_string(),
        );
    }
    if find_custom_theme(config, id).is_some() {
        return Some("2d".to_string());
    }
    None
}
