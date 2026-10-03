//! Синхронизация таймеров Longshot (Executive Hangar).
//!
//! Порт `server/longshot-sync.js`. Живой анкер цикла берётся из API Longshot
//! (`api-longshot.longshotrelay.com/api/hangar-config`, с кэш-бастером `?v=`),
//! статический `timers.longshotrelay.com/timer-config.json` — только запасной
//! путь (он отстаёт на недели). Оверлею нужны анкер и длительности; саму
//! математику цикла считает `hangar-cycle` на фронте, поэтому сбой загрузки
//! деградирует мягко.
//!
//! `fetch` инжектируется, поэтому разбор и пути ошибки/фолбэка проверяются без
//! сети. Опрос ленивый: пока видимого таймера в раскладке нет, в сеть не ходим.
//!
//! Отличие от JS одно и то же во всех перенесённых частях: таймер ставит
//! вызывающий. Скрипт в JS сам заводит `setInterval`, здесь `set_active`
//! переключает флаг, а частоту задаёт тот, кто умеет ставить интервалы (в
//! приложении — цикл на `tokio`).

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::storage::history::{js_number, js_truthy, number_value};

/// Живой источник конфига.
pub const API_URL: &str = "https://api-longshot.longshotrelay.com/api/hangar-config";
/// Запасной статический конфиг.
pub const FALLBACK_URL: &str = "https://timers.longshotrelay.com/timer-config.json";
/// Как часто тянем конфиг, если не сказано иное.
pub const DEFAULT_INTERVAL_MS: i64 = 5 * 60 * 1000;
/// Ниже этого интервал не опускаем.
pub const MIN_INTERVAL_MS: i64 = 30 * 1000;

/// Часы — подменяются в тестах.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Результат запроса: разобранный JSON или текст ошибки.
pub type FetchResult = Result<Value, String>;
/// Будущее запроса — так `fetch` остаётся асинхронным без внешних крейтов.
pub type FetchFuture = std::pin::Pin<Box<dyn std::future::Future<Output = FetchResult> + Send>>;
/// Загрузчик: URL (уже с кэш-бастером) → JSON.
pub type FetchFn = Arc<dyn Fn(&str) -> FetchFuture + Send + Sync>;
/// Обратный вызов на каждый новый снимок.
pub type UpdateFn = Arc<dyn Fn(&Value) + Send + Sync>;

/// Пустой снимок — как `emptySnapshot()`.
pub fn empty_snapshot() -> Value {
    json!({
        "ok": false,
        "operational": false,
        "anchorAt": "",
        "updateMessage": "",
        "phases": Value::Null,
        "lightIntervals": Value::Null,
        "remoteUpdatedAt": "",
        "fetchedAt": 0,
        "error": "",
    })
}

/// Привести дату к UTC-ISO с миллисекундами; пусто — если разобрать не вышло.
///
/// Сайт разбирает анкер через `Date.parse`, но дописывает `Z`, когда в строке
/// нет зоны, — иначе наивная дата прочиталась бы как местное время.
pub fn to_utc_iso(value: &Value) -> String {
    let raw = match value {
        Value::String(text) => text.trim().to_string(),
        Value::Null => return String::new(),
        other => {
            if js_truthy(Some(other)) {
                crate::state::js_string(other).trim().to_string()
            } else {
                return String::new();
            }
        }
    };
    if raw.is_empty() {
        return String::new();
    }

    // Сначала пробуем разобрать как есть (строка с зоной). Если не вышло —
    // пробел на `T` и дописать `Z`, как это делает сайт.
    let parsed = chrono::DateTime::parse_from_rfc3339(&raw)
        .map(|date| date.with_timezone(&chrono::Utc))
        .or_else(|_| {
            let with_t = raw.replace(' ', "T");
            chrono::DateTime::parse_from_rfc3339(&format!("{with_t}Z"))
                .map(|date| date.with_timezone(&chrono::Utc))
        });
    match parsed {
        Ok(date) => date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        Err(_) => String::new(),
    }
}

/// Нормализовать payload Longshot; `None` — пользоваться нечем.
pub fn map_config(json: &Value) -> Option<Value> {
    let hangar = json.get("executiveHangar")?.as_object()?;
    let anchor_at = to_utc_iso(hangar.get("hangarAnchorAt")?);
    if anchor_at.is_empty() {
        return None;
    }

    let minutes = 60.0;
    let num = |value: Option<&Value>, fallback: f64| -> f64 {
        let rounded = js_number(value).round();
        if rounded.is_finite() && rounded > 0.0 {
            rounded
        } else {
            fallback
        }
    };
    let phases = hangar.get("phases");
    let red = num(phases.and_then(|phases| phases.get("redMinutes")), 120.0) * minutes;
    let green = num(phases.and_then(|phases| phases.get("greenMinutes")), 60.0) * minutes;
    let black = num(phases.and_then(|phases| phases.get("blackMinutes")), 5.0) * minutes;

    let intervals = hangar.get("lightIntervals");
    let red_step = num(
        intervals.and_then(|intervals| intervals.get("redTurnGreenMinutes")),
        red / minutes / 5.0,
    ) * minutes;
    let green_step = num(
        intervals.and_then(|intervals| intervals.get("greenTurnOffMinutes")),
        green / minutes / 5.0,
    ) * minutes;

    let mut mapped = Map::new();
    mapped.insert("ok".to_string(), Value::Bool(true));
    mapped.insert(
        "operational".to_string(),
        Value::Bool(hangar.get("operational") != Some(&Value::Bool(false))),
    );
    mapped.insert("anchorAt".to_string(), Value::from(anchor_at));
    mapped.insert(
        "updateMessage".to_string(),
        Value::from(match hangar.get("updateMessage") {
            Some(value) if js_truthy(Some(value)) => crate::state::js_string(value),
            _ => String::new(),
        }),
    );
    mapped.insert(
        "phases".to_string(),
        json!({
            "redSec": number_value(red),
            "greenSec": number_value(green),
            "blackSec": number_value(black),
        }),
    );
    mapped.insert(
        "lightIntervals".to_string(),
        json!({
            "redStepSec": number_value(red_step),
            "greenStepSec": number_value(green_step),
        }),
    );
    mapped.insert(
        "remoteUpdatedAt".to_string(),
        Value::from(match hangar.get("updatedAt") {
            Some(value) if js_truthy(Some(value)) => crate::state::js_string(value),
            _ => String::new(),
        }),
    );
    mapped.insert("fetchedAt".to_string(), Value::Null);
    mapped.insert("error".to_string(), Value::from(""));
    Some(Value::Object(mapped))
}

/// Дописать кэш-бастер `?v=`/`&v=`.
pub fn with_cache_buster(url: &str, now_ms: i64) -> String {
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}v={now_ms}")
}

/// Ленивая синхронизация с инжектируемым загрузчиком.
pub struct LongshotSync {
    url: String,
    fallback_url: Option<String>,
    interval_ms: i64,
    fetch: Option<FetchFn>,
    on_update: Option<UpdateFn>,
    now: Clock,
    snapshot: Mutex<Value>,
    active: Mutex<bool>,
}

impl Default for LongshotSync {
    fn default() -> Self {
        Self::new()
    }
}

impl LongshotSync {
    /// Синхронизация с живым API и запасным статическим адресом.
    pub fn new() -> Self {
        Self {
            url: API_URL.to_string(),
            fallback_url: Some(FALLBACK_URL.to_string()),
            interval_ms: DEFAULT_INTERVAL_MS,
            fetch: None,
            on_update: None,
            now: Arc::new(|| chrono::Utc::now().timestamp_millis()),
            snapshot: Mutex::new(empty_snapshot()),
            active: Mutex::new(false),
        }
    }

    pub fn with_fetch(mut self, fetch: FetchFn) -> Self {
        self.fetch = Some(fetch);
        self
    }

    pub fn with_urls(mut self, url: &str, fallback_url: Option<String>) -> Self {
        self.url = url.to_string();
        self.fallback_url = fallback_url;
        self
    }

    pub fn with_interval(mut self, interval_ms: i64) -> Self {
        self.interval_ms = interval_ms.max(MIN_INTERVAL_MS);
        self
    }

    pub fn with_on_update(mut self, on_update: UpdateFn) -> Self {
        self.on_update = Some(on_update);
        self
    }

    pub fn with_clock(mut self, now: Clock) -> Self {
        self.now = now;
        self
    }

    pub fn interval_ms(&self) -> i64 {
        self.interval_ms
    }

    /// Текущий снимок.
    pub fn get(&self) -> Value {
        self.lock(&self.snapshot).clone()
    }

    pub fn is_active(&self) -> bool {
        *self.lock(&self.active)
    }

    /// Включить/выключить опрос; возвращает новое состояние.
    ///
    /// Сам интервал ставит вызывающий: движок только помнит, нужен ли опрос.
    pub fn set_active(&self, active: bool) -> bool {
        let mut current = self.lock(&self.active);
        *current = active;
        active
    }

    pub fn start(&self) -> bool {
        self.set_active(true)
    }

    pub fn stop(&self) -> bool {
        self.set_active(false)
    }

    /// Сходить за конфигом: API, при сбое — фолбэк; при полном сбое сохраняется
    /// прежний анкер и меняется только признак ошибки.
    pub async fn refresh(&self) -> Value {
        let Some(fetch) = self.fetch.clone() else {
            let mut snapshot = self.lock(&self.snapshot).clone();
            set(&mut snapshot, "ok", Value::Bool(false));
            set(&mut snapshot, "error", Value::from("fetch unavailable"));
            return self.finish(snapshot);
        };

        let mut mapped = None;
        let mut error = None;
        match self.load_one(&fetch, &self.url).await {
            Ok(value) => mapped = Some(value),
            Err(message) => error = Some(message),
        }
        if mapped.is_none() {
            if let Some(fallback) = self.fallback_url.clone() {
                if fallback != self.url {
                    match self.load_one(&fetch, &fallback).await {
                        Ok(value) => {
                            mapped = Some(value);
                            error = None;
                        }
                        Err(message) => {
                            if error.is_none() {
                                error = Some(message);
                            }
                        }
                    }
                }
            }
        }

        let result = match mapped {
            Some(mut value) => {
                set(&mut value, "fetchedAt", number_value((self.now)() as f64));
                value
            }
            None => {
                let mut snapshot = self.lock(&self.snapshot).clone();
                set(&mut snapshot, "ok", Value::Bool(false));
                set(
                    &mut snapshot,
                    "fetchedAt",
                    number_value((self.now)() as f64),
                );
                set(
                    &mut snapshot,
                    "error",
                    Value::from(error.unwrap_or_default()),
                );
                snapshot
            }
        };
        self.finish(result)
    }

    async fn load_one(&self, fetch: &FetchFn, target: &str) -> Result<Value, String> {
        let url = with_cache_buster(target, (self.now)());
        let json = fetch(&url).await?;
        map_config(&json).ok_or_else(|| "unexpected payload".to_string())
    }

    fn finish(&self, snapshot: Value) -> Value {
        *self.lock(&self.snapshot) = snapshot.clone();
        if let Some(callback) = &self.on_update {
            callback(&snapshot);
        }
        snapshot
    }

    fn lock<'a, T>(&self, mutex: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
        mutex.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn set(target: &mut Value, key: &str, value: Value) {
    if let Some(object) = target.as_object_mut() {
        object.insert(key.to_string(), value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!({
            "executiveHangar": {
                "operational": true,
                "hangarAnchorAt": "2026-09-11T02:13:01Z",
                "phases": { "redMinutes": 120, "greenMinutes": 60, "blackMinutes": 5 },
                "lightIntervals": { "redTurnGreenMinutes": 24, "greenTurnOffMinutes": 12 },
                "updateMessage": "Timer updated for Alpha 4.10 LIVE",
                "updatedAt": "2026-09-11 04:39:29",
            }
        })
    }

    /// Загрузчик, отвечающий по адресу; `seen` собирает запрошенные URL.
    fn fetch_ok(sample: Value, seen: Arc<Mutex<Vec<String>>>) -> FetchFn {
        Arc::new(move |url: &str| {
            let url = url.to_string();
            let sample = sample.clone();
            let seen = seen.clone();
            Box::pin(async move {
                seen.lock().unwrap().push(url);
                Ok(sample)
            })
        })
    }

    #[test]
    fn map_config_normalizes_seconds_and_the_utc_anchor() {
        let mapped = map_config(&sample()).expect("разобран");
        assert_eq!(mapped["ok"], json!(true));
        assert_eq!(mapped["operational"], json!(true));
        assert_eq!(mapped["anchorAt"], json!("2026-09-11T02:13:01.000Z"));
        assert_eq!(
            mapped["phases"],
            json!({ "redSec": 7200, "greenSec": 3600, "blackSec": 300 })
        );
        assert_eq!(
            mapped["lightIntervals"],
            json!({ "redStepSec": 1440, "greenStepSec": 720 })
        );
        assert!(mapped["updateMessage"]
            .as_str()
            .unwrap()
            .contains("Alpha 4.10"));
        assert_eq!(mapped["remoteUpdatedAt"], json!("2026-09-11 04:39:29"));
    }

    #[test]
    fn an_anchor_without_a_timezone_reads_as_utc() {
        let mapped =
            map_config(&json!({ "executiveHangar": { "hangarAnchorAt": "2026-09-11 02:13:01" } }))
                .expect("разобран");
        assert_eq!(mapped["anchorAt"], json!("2026-09-11T02:13:01.000Z"));
    }

    #[test]
    fn map_config_returns_nothing_on_garbage() {
        assert!(map_config(&Value::Null).is_none());
        assert!(map_config(&json!({})).is_none());
        assert!(map_config(&json!({ "executiveHangar": {} })).is_none());
        assert!(
            map_config(&json!({ "executiveHangar": { "hangarAnchorAt": "not-a-date" } })).is_none()
        );
    }

    #[tokio::test]
    async fn refresh_takes_the_api_with_a_cache_buster_and_notifies() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let updates = Arc::new(Mutex::new(Vec::new()));
        let sync = LongshotSync::new()
            .with_fetch(fetch_ok(sample(), seen.clone()))
            .with_on_update({
                let updates = updates.clone();
                Arc::new(move |snapshot: &Value| updates.lock().unwrap().push(snapshot.clone()))
            });

        let snapshot = sync.refresh().await;
        assert_eq!(snapshot["ok"], json!(true));
        let seen = seen.lock().unwrap();
        assert!(seen[0].starts_with(API_URL));
        assert!(seen[0].contains("v="));
        assert_eq!(sync.get()["phases"]["redSec"], json!(7200));
        assert_eq!(updates.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_failing_api_falls_back_to_the_static_url() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let fetch: FetchFn = {
            let seen = seen.clone();
            Arc::new(move |url: &str| {
                let url = url.to_string();
                let seen = seen.clone();
                Box::pin(async move {
                    seen.lock().unwrap().push(url.clone());
                    if url.starts_with(API_URL) {
                        return Err("api down".to_string());
                    }
                    Ok(json!({ "executiveHangar": { "hangarAnchorAt": "2026-05-23T17:23:24Z" } }))
                })
            })
        };
        let sync = LongshotSync::new().with_fetch(fetch);

        let snapshot = sync.refresh().await;
        assert_eq!(snapshot["ok"], json!(true));
        let seen = seen.lock().unwrap();
        assert!(seen[0].starts_with(API_URL));
        assert!(seen[1].starts_with(FALLBACK_URL));
        assert_eq!(
            snapshot["phases"],
            json!({ "redSec": 7200, "greenSec": 3600, "blackSec": 300 })
        );
    }

    #[tokio::test]
    async fn a_total_failure_keeps_the_previous_anchor() {
        let mode = Arc::new(Mutex::new(true));
        let fetch: FetchFn = {
            let mode = mode.clone();
            Arc::new(move |_url: &str| {
                let ok = *mode.lock().unwrap();
                Box::pin(async move {
                    if ok {
                        Ok(sample())
                    } else {
                        Err("network down".to_string())
                    }
                })
            })
        };
        let sync = LongshotSync::new()
            .with_urls(API_URL, None)
            .with_fetch(fetch);

        sync.refresh().await;
        *mode.lock().unwrap() = false;
        let snapshot = sync.refresh().await;

        assert_eq!(snapshot["ok"], json!(false));
        assert!(snapshot["error"].as_str().unwrap().contains("network down"));
        // Прежний анкер сохранён.
        assert_eq!(snapshot["anchorAt"], json!("2026-09-11T02:13:01.000Z"));
    }

    #[tokio::test]
    async fn an_http_error_is_marked_as_an_error() {
        let fetch: FetchFn =
            Arc::new(|_url: &str| Box::pin(async move { Err("HTTP 503".to_string()) }));
        let sync = LongshotSync::new()
            .with_urls(API_URL, None)
            .with_fetch(fetch);
        let snapshot = sync.refresh().await;
        assert_eq!(snapshot["ok"], json!(false));
        assert!(snapshot["error"].as_str().unwrap().contains("503"));
    }

    #[tokio::test]
    async fn without_a_fetcher_nothing_happens() {
        let sync = LongshotSync::new();
        let snapshot = sync.refresh().await;
        assert_eq!(snapshot["ok"], json!(false));
        assert_eq!(snapshot["error"], json!("fetch unavailable"));
    }

    #[test]
    fn polling_is_toggled_and_the_interval_is_clamped() {
        let sync = LongshotSync::new().with_interval(1000);
        assert_eq!(sync.interval_ms(), MIN_INTERVAL_MS);
        assert!(!sync.is_active());
        assert!(sync.start());
        assert!(sync.is_active());
        assert!(!sync.stop());
        assert!(!sync.is_active());
    }

    #[test]
    fn the_cache_buster_uses_the_right_separator() {
        assert_eq!(with_cache_buster("https://x/api", 5), "https://x/api?v=5");
        assert_eq!(
            with_cache_buster("https://x/api?a=1", 5),
            "https://x/api?a=1&v=5"
        );
    }
}
