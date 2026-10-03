//! База приложения: раскладка оверлея, пресеты, сессии и настройки виджетов.
//!
//! Порт `server/db.js`. Здесь живут два разных хранилища:
//!
//! * `local-db.json` — снапшот состояния (раскладка, пресеты, сессии, настройки
//!   виджетов, счётчики). Пишется целиком, асинхронно и со схлопыванием
//!   ([`AtomicStore`]);
//! * `local-db.jsonl` и `local-db.chat.jsonl` — append-only истории событий и чата
//!   ([`HistoryStore`]). Они вынесены из снапшота именно потому, что перезапись
//!   всего файла на каждое сообщение чата — квадратичная работа на ровном месте.
//!
//! Контракт совместимости: те же файлы, те же ключи, те же форматы записей и тот
//! же набор операций. Документ снапшота — `Map`, а не структура с полями, поэтому
//! ключи, которых эта версия не знает (настройки будущих версий, чужие правки
//! руками), не теряются при записи.
//!
//! Отличие от JS: там значения «пусто» (`undefined`, отсутствие поля) проходят
//! сквозь код и пропадают при `JSON.stringify`. В Rust поля нет — значит, её не
//! надо писать в JSON. Поэтому сборка строк событий и чата местами выглядит
//! громоздко: она повторяет именно правила JS, а не «очевидное» заполнение.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use super::async_store::{AtomicStore, StatsSnapshot, StoreOptions};
use super::history::{self, HistoryOptions, HistoryStore, Page, QueryOptions};
use super::logger;
use super::paths::Storage;
use super::{atomic, integrity};

/// Лимит истории чата: сообщений куда больше, чем событий, поэтому он скромнее.
pub const CHAT_MAX_RECORDS: usize = 10_000;

/// Значения по умолчанию для пустой базы — как `defaultData()` в JS.
///
/// Порядок ключей здесь часть контракта: файл пишется с `preserve_order`, и от
/// него зависит, как выглядит `local-db.json` пользователя.
pub fn default_data() -> Map<String, Value> {
    let mut data = Map::new();
    // Единый источник истины для раскладки оверлея.
    data.insert("overlay".to_string(), json!({ "widgets": [] }));
    // Сохранённые пользовательские пресеты раскладки (виджеты + геометрия).
    data.insert("layout_presets".to_string(), json!([]));
    // Сохранённые пресеты голосования (команда, тип диаграммы и пункты).
    data.insert("poll_presets".to_string(), json!([]));
    // Сессии стрима.
    data.insert("sessions".to_string(), json!([]));
    // История чата хранится отдельно (`local-db.chat.jsonl`); массив оставлен
    // пустым для обратной совместимости и методов очистки истории.
    data.insert("chatMessages".to_string(), json!([]));
    // Писать ли историю чата (настройка в панели управления).
    data.insert("chat_history_enabled".to_string(), json!(true));
    // Сколько последних стрим-событий хранить (0 — без лимита).
    data.insert(
        "history_max_records".to_string(),
        json!(history::DEFAULT_MAX_RECORDS),
    );
    // Настройки виджета списка участников розыгрыша (пиксели сцены 1920×1080).
    data.insert(
        "overlay_participants_config".to_string(),
        json!({
            "maxNames": 10,
            "marquee": false,
            "fontSize": 16,
            "textColor": "#e8e1f0",
            "backgroundOpacity": 82,
            "x": 24,
            "y": 340,
            "w": 340,
            "h": 400,
        }),
    );
    // Настройки Колеса Фортуны (звук и позиция на сцене).
    data.insert(
        "wheel_config".to_string(),
        json!({ "musicVolume": 50, "x": 960, "y": 540 }),
    );
    // Скорость вращения Колеса Фортуны.
    data.insert("wheel_speed_config".to_string(), json!({ "speed": 3 }));
    // Голосование в чате: команда, тип диаграммы и пункты.
    data.insert(
        "poll_config".to_string(),
        json!({ "command": "!poll", "chartType": "bars", "options": [] }),
    );
    // Аудио-визуализатор микрофона: дефолты отображения и захвата.
    data.insert(
        "overlay_mic_config".to_string(),
        json!({
            "sensitivity": 1.5,
            "lineWidth": 2,
            "color": "",
            "opacity": 0.9,
            "visualizer_mode": "sine",
            "barCount": 32,
            "barGap": 2,
            "peakFall": 2.5,
            "freqScale": "log",
            "smoothing": 0.35,
            "gain": 1,
            "noiseGate": 0,
            "deviceId": "",
            "echoCancellation": true,
            "noiseSuppression": true,
            "autoGainControl": true,
        }),
    );
    // Накопительные предупреждения автомодерации чата: userId → число варнов.
    data.insert("moderation_warns".to_string(), json!({}));
    // Язык интерфейса ("en" | "ru").
    data.insert("language".to_string(), json!("en"));
    data
}

/// `deepDefaults` из JS (аналог `_.defaultsDeep` из lowdb v1): дополняет данные
/// умолчаниями, не затирая сохранённое. Объекты сливаются рекурсивно, массивы и
/// примитивы берутся из данных, если они уже есть.
///
/// Отдельно стоит помнить про `null`: в JS `cur == null` (и `undefined`, и `null`)
/// означает «значения нет» — умолчание подставляется и вместо явного `null`.
pub fn deep_defaults(
    defaults: &Map<String, Value>,
    data: Option<&Map<String, Value>>,
) -> Map<String, Value> {
    let mut out = data.cloned().unwrap_or_default();
    for (key, fallback) in defaults {
        match out.get(key) {
            None | Some(Value::Null) => {
                out.insert(key.clone(), fallback.clone());
            }
            Some(Value::Object(current)) => {
                if let Some(fallback) = fallback.as_object() {
                    let merged = deep_defaults(fallback, Some(current));
                    out.insert(key.clone(), Value::Object(merged));
                }
            }
            Some(_) => {}
        }
    }
    out
}

/// База приложения.
pub struct Database {
    path: PathBuf,
    history_path: PathBuf,
    chat_path: PathBuf,
    /// Документ снапшота: пишется целиком, поэтому под замком.
    data: Mutex<Map<String, Value>>,
    store: AtomicStore,
    history: HistoryStore,
    chat: HistoryStore,
    /// Случай порчи при открытии — для отчёта для поддержки.
    recovery: Option<integrity::RecoveryEvent>,
}

impl Database {
    /// Открыть базу рядом с настройками (`local-db.json`) и её истории.
    ///
    /// Порча снапшота не роняет запуск: файл уходит в карантин, значение
    /// поднимается из последней удачной копии, а если поднимать нечего — берутся
    /// умолчания (см. `integrity`).
    pub fn open(storage: &Storage) -> Self {
        let path = storage.db_path();
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }

        let recovered = integrity::recover_json_file(
            &path,
            "local-db.json",
            integrity::default_backup_slots(),
            &storage.logs_dir(),
        );
        let mut data = deep_defaults(
            &default_data(),
            recovered.value.as_ref().and_then(Value::as_object),
        );

        let history_path = sibling_path(&path, ".jsonl");
        let chat_path = sibling_path(&path, ".chat.jsonl");

        let history = HistoryStore::open(
            history_path.clone(),
            HistoryOptions {
                // Лимит из настроек: он же решает, когда уплотнять файл.
                max_records: history::max_records_from_json(data.get("history_max_records")),
                logger: Some(write_logger("history")),
                ..Default::default()
            },
        );
        let chat = HistoryStore::open(
            chat_path.clone(),
            HistoryOptions {
                max_records: Some(CHAT_MAX_RECORDS),
                logger: Some(write_logger("chat")),
                ..Default::default()
            },
        );

        // Одноразовая миграция прежних `stream_events` из снапшота в JSONL:
        // они перестали быть частью снапшота, но у пользователя уже накоплены.
        if let Some(legacy) = data.get("stream_events").and_then(Value::as_array).cloned() {
            data.remove("stream_events");
            if history.count() == 0 {
                history.replace_all(legacy);
            } else {
                for event in legacy {
                    if !history::js_truthy(event.get("id")) {
                        continue;
                    }
                    if history.get_by_id(event.get("id")).is_none() {
                        history.append(event);
                    }
                }
            }
        }

        // То же для прежних `chatMessages`.
        if let Some(legacy) = data
            .get("chatMessages")
            .and_then(Value::as_array)
            .filter(|list| !list.is_empty())
            .cloned()
        {
            if chat.count() == 0 {
                chat.replace_all(legacy);
            } else {
                for message in legacy {
                    if !history::js_truthy(message.get("id")) {
                        continue;
                    }
                    if chat.get_by_id(message.get("id")).is_none() {
                        chat.append(message);
                    }
                }
            }
            data.insert("chatMessages".to_string(), json!([]));
        }

        // Файл приводим к текущему виду сразу, синхронно: так первая же запись
        // идёт поверх дополненного умолчаниями документа, а миграция выше
        // становится видна на диске даже если приложение тут же закроют.
        let _ = atomic::write_file_sync(&path, pretty(&Value::Object(data.clone())).as_bytes());

        Self {
            store: AtomicStore::open(
                path.clone(),
                StoreOptions {
                    label: Some("local-db.json".to_string()),
                    logger: Some(write_logger("db")),
                    ..Default::default()
                },
            ),
            path,
            history_path,
            chat_path,
            data: Mutex::new(data),
            history,
            chat,
            recovery: recovered.event,
        }
    }

    /// Путь файла снапшота.
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn history_path(&self) -> &Path {
        &self.history_path
    }

    pub fn chat_path(&self) -> &Path {
        &self.chat_path
    }

    /// Случай порчи снапшота при открытии — для отчёта для поддержки.
    ///
    /// Событие отдаётся вызывающему, а не хранится в общем списке: так функция
    /// остаётся чистой, а собирает события тот, кому они нужны (см. документацию
    /// `integrity`).
    pub fn recovery_event(&self) -> Option<&integrity::RecoveryEvent> {
        self.recovery.as_ref()
    }

    /// Значение верхнего уровня.
    pub fn get(&self, key: &str) -> Option<Value> {
        self.data.lock().unwrap().get(key).cloned()
    }

    /// Значение по пути с точками: `get_path("overlay.widgets")`.
    pub fn get_path(&self, path: &str) -> Option<Value> {
        let data = self.data.lock().unwrap();
        path_value(&data, path).cloned()
    }

    /// Записать значение по пути с точками, создавая промежуточные объекты.
    pub fn set_path(&self, path: &str, value: Value) {
        {
            let mut data = self.data.lock().unwrap();
            set_value(&mut data, path, value);
        }
        self.persist();
    }

    // ---- раскладка и пресеты ----

    pub fn widgets(&self) -> Vec<Value> {
        array_at(self.get_path("overlay.widgets"))
    }

    pub fn save_widgets(&self, widgets: Vec<Value>) -> Vec<Value> {
        self.set_path("overlay.widgets", Value::Array(widgets));
        self.widgets()
    }

    pub fn layout_presets(&self) -> Vec<Value> {
        array_at(self.get_path("layout_presets"))
    }

    pub fn save_layout_presets(&self, presets: Vec<Value>) -> Vec<Value> {
        self.set_path("layout_presets", Value::Array(presets));
        self.layout_presets()
    }

    pub fn poll_presets(&self) -> Vec<Value> {
        array_at(self.get_path("poll_presets"))
    }

    pub fn save_poll_presets(&self, presets: Vec<Value>) -> Vec<Value> {
        self.set_path("poll_presets", Value::Array(presets));
        self.poll_presets()
    }

    // ---- сессии стрима ----

    pub fn sessions(&self) -> Vec<Value> {
        array_at(self.get_path("sessions"))
    }

    /// Открыть сессию стрима.
    pub fn start_session(&self, channel: &str) -> Value {
        let session = json!({
            "id": Uuid::new_v4().to_string(),
            "channel": channel,
            "startedAt": now_ms(),
            "endedAt": Value::Null,
        });
        {
            let mut data = self.data.lock().unwrap();
            let sessions = ensure_array(&mut data, "sessions");
            sessions.push(session.clone());
        }
        self.persist();
        session
    }

    /// Закрыть сессию; `None` — такой сессии нет.
    pub fn end_session(&self, session_id: &Value) -> Option<Value> {
        let ended = {
            let mut data = self.data.lock().unwrap();
            let sessions = ensure_array(&mut data, "sessions");
            let session = sessions
                .iter_mut()
                .find(|session| session.get("id") == Some(session_id))?;
            if let Some(object) = session.as_object_mut() {
                object.insert("endedAt".to_string(), json!(now_ms()));
            }
            session.clone()
        };
        self.persist();
        Some(ended)
    }

    pub fn clear_sessions(&self) -> bool {
        self.set_path("sessions", json!([]));
        true
    }

    /// Сессии с агрегатами по времени: сколько событий, донатов и сообщений чата
    /// пришлось на каждую сессию (по диапазону `startedAt..endedAt`).
    pub fn sessions_with_stats(&self) -> Vec<Value> {
        let events = self.history.all();
        let messages = self.chat.all();
        let now = now_ms() as f64;

        let mut out: Vec<Value> = self
            .sessions()
            .iter()
            .map(|session| {
                let started = number_field(session, "startedAt");
                // `s.startedAt || 0` и `s.endedAt || Date.now()`.
                let from = if started == 0.0 { 0.0 } else { started };
                let ended = number_field(session, "endedAt");
                let to = if ended == 0.0 { now } else { ended };

                let in_session: Vec<&Value> = events
                    .iter()
                    .filter(|event| in_range(event, from, to))
                    .collect();
                let donations = in_session
                    .iter()
                    .filter(|event| event.get("type").and_then(Value::as_str) == Some("donation"))
                    .count();

                json!({
                    "id": session.get("id").cloned().unwrap_or(Value::Null),
                    "channel": session.get("channel").cloned().unwrap_or_else(|| json!("")),
                    "startedAt": if started == 0.0 { Value::Null } else { session.get("startedAt").cloned().unwrap_or(Value::Null) },
                    "endedAt": if ended == 0.0 { Value::Null } else { session.get("endedAt").cloned().unwrap_or(Value::Null) },
                    "durationMs": if started == 0.0 { Value::Null } else { num(to - started) },
                    "events": in_session.len(),
                    "donations": donations,
                    "chat": messages.iter().filter(|message| in_range(message, from, to)).count(),
                })
            })
            .collect();

        // Свежие сессии сверху; при равном времени порядок сохраняется.
        out.sort_by(|a, b| {
            let left = number_field(a, "startedAt");
            let right = number_field(b, "startedAt");
            right
                .partial_cmp(&left)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out
    }

    // ---- история событий стрима ----

    /// Дописать событие стрима (донат, фоллоу, саб и т.п.).
    pub fn append_stream_event(&self, event: &Value) -> Value {
        let mut row = Map::new();
        row.insert(
            "id".to_string(),
            or_default(event.get("id"), json!(Uuid::new_v4().to_string())),
        );
        row.insert(
            "timestamp".to_string(),
            or_default(event.get("timestamp"), json!(now_ms())),
        );
        // `type` пишется как есть; если поля не было, в JS ключ не создаётся.
        if let Some(kind) = event.get("type") {
            row.insert("type".to_string(), kind.clone());
        }
        let kind = match event.get("kind") {
            Some(value) if history::js_truthy(Some(value)) => Some(value.clone()),
            _ => event.get("type").cloned(),
        };
        if let Some(kind) = kind {
            row.insert("kind".to_string(), kind);
        }
        row.insert(
            "username".to_string(),
            or_default(event.get("username"), json!("Аноним")),
        );
        row.insert("amount".to_string(), number_or_null(event.get("amount")));
        row.insert(
            "currency".to_string(),
            or_default(event.get("currency"), Value::Null),
        );
        row.insert(
            "message".to_string(),
            or_default(event.get("message"), json!("")),
        );
        row.insert(
            "is_test".to_string(),
            json!(history::js_truthy(event.get("is_test"))),
        );
        row.insert("count".to_string(), number_or_null(event.get("count")));
        row.insert(
            "tier".to_string(),
            or_default(event.get("tier"), Value::Null),
        );
        // Идентификатор события на стороне сервиса (например донат в
        // DonationAlerts): по нему «пропущенные» донаты не добавляются дважды.
        row.insert(
            "source_id".to_string(),
            match event.get("source_id") {
                Some(value) if !value.is_null() => json!(history::js_key(value)),
                _ => Value::Null,
            },
        );

        let row = Value::Object(row);
        self.history.append(row.clone());
        row
    }

    pub fn stream_events(&self, options: &QueryOptions) -> Page {
        self.history.query(options)
    }

    pub fn stream_event_by_id(&self, id: Option<&Value>) -> Option<Value> {
        self.history.get_by_id(id)
    }

    /// Идентификаторы событий сервиса, о которых уже знаем. Нужны при подтягивании
    /// донатов, пришедших пока приложение было выключено.
    pub fn known_source_ids(&self, limit: Option<usize>) -> HashSet<String> {
        let limit = limit.filter(|value| *value > 0).unwrap_or(2000).max(1);
        let page = self.history.query(&QueryOptions {
            limit: Some(limit),
            ..Default::default()
        });
        page.items
            .iter()
            .filter_map(|item| item.get("source_id"))
            .filter(|value| history::js_truthy(Some(value)))
            .map(history::js_key)
            .collect()
    }

    /// Удалить события по фильтру; возвращает число удалённых.
    pub fn remove_stream_events(&self, filter: &QueryOptions) -> usize {
        self.history.remove_by(filter)
    }

    pub fn clear_stream_events(&self) -> bool {
        self.history.clear();
        true
    }

    /// Лимит истории событий; 0 — без лимита.
    pub fn history_limit(&self) -> usize {
        self.history.max_records()
    }

    /// Сменить лимит истории (0 — без лимита) и сохранить его в настройках.
    pub fn set_history_limit(&self, value: Option<usize>) -> usize {
        let next = self.history.set_max_records(value);
        self.set_path("history_max_records", json!(next));
        next
    }

    // ---- история чата ----

    /// Дописать сообщение чата; `None` — история выключена настройкой.
    pub fn append_chat(&self, message: &Value) -> Option<Value> {
        if !history::js_truthy(Some(message)) {
            return None;
        }
        if matches!(self.get("chat_history_enabled"), Some(Value::Bool(false))) {
            return None;
        }

        let mut row = Map::new();
        row.insert(
            "id".to_string(),
            or_default(message.get("id"), json!(Uuid::new_v4().to_string())),
        );
        row.insert(
            "timestamp".to_string(),
            or_default(message.get("timestamp"), json!(now_ms())),
        );
        row.insert(
            "username".to_string(),
            or_default(
                message.get("user"),
                or_default(message.get("username"), json!("Аноним")),
            ),
        );
        row.insert(
            "message".to_string(),
            or_default(message.get("message"), json!("")),
        );
        row.insert(
            "isTest".to_string(),
            json!(history::js_truthy(message.get("isTest"))),
        );
        row.insert(
            "sessionId".to_string(),
            or_default(message.get("sessionId"), Value::Null),
        );

        let row = Value::Object(row);
        self.chat.append(row.clone());
        Some(row)
    }

    /// Вся история чата (или только одна сессия).
    pub fn chat(&self, session_id: Option<&Value>) -> Vec<Value> {
        let all = self.chat.all();
        match session_id {
            Some(session_id) => all
                .into_iter()
                .filter(|message| message.get("sessionId") == Some(session_id))
                .collect(),
            None => all,
        }
    }

    pub fn chat_page(&self, options: &QueryOptions) -> Page {
        self.chat.query(options)
    }

    pub fn clear_chat(&self) -> bool {
        self.chat.clear();
        true
    }

    pub fn chat_history_enabled(&self) -> bool {
        !matches!(self.get("chat_history_enabled"), Some(Value::Bool(false)))
    }

    pub fn set_chat_history_enabled(&self, on: bool) -> bool {
        self.set_path("chat_history_enabled", json!(on));
        on
    }

    // ---- настройки виджетов ----

    pub fn participants_config(&self) -> Value {
        let raw = self
            .get("overlay_participants_config")
            .unwrap_or(Value::Null);
        json!({
            "maxNames": number_or(raw.get("maxNames"), 10.0),
            "marquee": history::js_truthy(raw.get("marquee")),
            "fontSize": number_or(raw.get("fontSize"), 16.0),
            "textColor": string_or(raw.get("textColor"), "#e8e1f0"),
            "backgroundOpacity": number_or(raw.get("backgroundOpacity"), 82.0),
            "x": number_or(raw.get("x"), 24.0),
            "y": number_or(raw.get("y"), 340.0),
            "w": number_or(raw.get("w"), 340.0),
            "h": number_or(raw.get("h"), 400.0),
        })
    }

    pub fn save_participants_config(&self, config: Option<&Value>) -> Value {
        let next = merge(self.participants_config(), config);
        self.set_path("overlay_participants_config", next.clone());
        next
    }

    pub fn wheel_config(&self) -> Value {
        let raw = self.get("wheel_config").unwrap_or(Value::Null);
        json!({
            "musicVolume": number_or(raw.get("musicVolume"), 50.0),
            "x": number_or(raw.get("x"), 960.0),
            "y": number_or(raw.get("y"), 540.0),
        })
    }

    pub fn save_wheel_config(&self, config: Option<&Value>) -> Value {
        let next = merge(self.wheel_config(), config);
        self.set_path("wheel_config", next.clone());
        next
    }

    pub fn wheel_speed_config(&self) -> Value {
        let raw = self.get("wheel_speed_config").unwrap_or(Value::Null);
        json!({ "speed": number_or(raw.get("speed"), 3.0) })
    }

    pub fn save_wheel_speed_config(&self, config: Option<&Value>) -> Value {
        let next = merge(self.wheel_speed_config(), config);
        self.set_path("wheel_speed_config", next.clone());
        next
    }

    pub fn poll_config(&self) -> Value {
        let raw = self.get("poll_config").unwrap_or(Value::Null);
        // Пункты голосования чистим от мусора: нужны и id, и подпись строками.
        let options: Vec<Value> = raw
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(|option| {
                        let id = option.get("id")?.as_str()?;
                        let label = option.get("label")?.as_str()?;
                        Some(json!({ "id": id, "label": label }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let command = raw
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|command| !command.is_empty())
            .unwrap_or("!poll");
        json!({
            "command": command,
            "chartType": if raw.get("chartType").and_then(Value::as_str) == Some("pie") { "pie" } else { "bars" },
            "options": options,
        })
    }

    pub fn save_poll_config(&self, config: Option<&Value>) -> Value {
        let mut next = merge(self.poll_config(), config);
        if !next.get("options").map(Value::is_array).unwrap_or(false) {
            if let Some(object) = next.as_object_mut() {
                object.insert("options".to_string(), json!([]));
            }
        }
        self.set_path("poll_config", next.clone());
        next
    }

    pub fn mic_config(&self) -> Value {
        let raw = self.get("overlay_mic_config").unwrap_or(Value::Null);
        // Известные режимы проходят как есть, всё прочее — «волна».
        let mode = match raw.get("visualizer_mode").and_then(Value::as_str) {
            Some("bars") => "bars",
            Some("ring") => "ring",
            Some("equalizer") => "equalizer",
            _ => "sine",
        };
        json!({
            "sensitivity": number_or(raw.get("sensitivity"), 1.5),
            "lineWidth": number_or(raw.get("lineWidth"), 2.0),
            "color": string_or(raw.get("color"), ""),
            "opacity": number_or(raw.get("opacity"), 0.9),
            "visualizer_mode": mode,
            // `Math.round(Number(raw.barCount) || 32)` в пределах 10…64 — как JS.
            "barCount": num(clamp(coerced_number(raw.get("barCount"), 32.0).round(), 10.0, 64.0)),
            "barGap": number_or(raw.get("barGap"), 2.0),
            "peakFall": num(clamp(coerced_number(raw.get("peakFall"), 2.5), 0.5, 10.0)),
            "freqScale": if raw.get("freqScale").and_then(Value::as_str) == Some("linear") { "linear" } else { "log" },
            "smoothing": num(clamp(raw_number(raw.get("smoothing"), 0.35), 0.0, 1.0)),
            "gain": num(clamp(raw_number(raw.get("gain"), 1.0), 0.1, 5.0)),
            "noiseGate": num(clamp(raw_number(raw.get("noiseGate"), 0.0), 0.0, 0.5)),
            "deviceId": string_or(raw.get("deviceId"), ""),
            // Отсутствие поля означает «включено»: `!== false`, а не `=== true`.
            "echoCancellation": raw.get("echoCancellation") != Some(&Value::Bool(false)),
            "noiseSuppression": raw.get("noiseSuppression") != Some(&Value::Bool(false)),
            "autoGainControl": raw.get("autoGainControl") != Some(&Value::Bool(false)),
        })
    }

    pub fn save_mic_config(&self, config: Option<&Value>) -> Value {
        let next = merge(self.mic_config(), config);
        self.set_path("overlay_mic_config", next.clone());
        next
    }

    /// Накопительные варны автомодерации: `userId -> число`.
    pub fn moderation_warns(&self) -> Value {
        match self.get("moderation_warns") {
            Some(value @ Value::Object(_)) => value,
            _ => json!({}),
        }
    }

    /// Сохранить варны, оставив только положительные целые — как в JS.
    pub fn save_moderation_warns(&self, warns: Option<&Value>) -> Value {
        let mut clean = Map::new();
        if let Some(Value::Object(warns)) = warns {
            for (key, value) in warns {
                let count = history::js_number_or_zero(Some(value));
                if count.is_finite() && count > 0.0 {
                    clean.insert(key.clone(), num(count.round()));
                }
            }
        }
        let clean = Value::Object(clean);
        self.set_path("moderation_warns", clean.clone());
        clean
    }

    pub fn language(&self) -> &'static str {
        match self.get("language").and_then(|value| match value {
            Value::String(text) => Some(text),
            _ => None,
        }) {
            Some(text) if text == "ru" => "ru",
            _ => "en",
        }
    }

    pub fn save_language(&self, language: &str) -> &'static str {
        let next = if language == "ru" { "ru" } else { "en" };
        self.set_path("language", json!(next));
        next
    }

    // ---- очистка ----

    pub fn clear_history(&self) -> bool {
        {
            let mut data = self.data.lock().unwrap();
            data.insert("sessions".to_string(), json!([]));
            data.insert("chatMessages".to_string(), json!([]));
        }
        self.history.clear();
        self.chat.clear();
        self.persist();
        true
    }

    pub fn clear_all(&self) -> bool {
        {
            let mut data = self.data.lock().unwrap();
            *data = default_data();
        }
        self.history.clear();
        self.chat.clear();
        self.persist();
        true
    }

    // ---- состояние хранилища ----

    /// Отчёт о состоянии: пути, размеры, счётчики и последние ошибки записи.
    pub fn storage_stats(&self) -> Value {
        json!({
            "dir": dirname(&self.path),
            "database": {
                "path": path_text(&self.path),
                "bytes": file_size(&self.path),
                "lastError": self.store.last_error(),
            },
            "history": {
                "path": path_text(&self.history_path),
                "bytes": file_size(&self.history_path),
                "count": self.history.count(),
                "limit": self.history.max_records(),
                "lastError": self.history.last_error(),
            },
            "chat": {
                "path": path_text(&self.chat_path),
                "bytes": file_size(&self.chat_path),
                "count": self.chat.count(),
                "limit": self.chat.max_records(),
                "lastError": self.chat.last_error(),
            },
            "sessions": self.sessions().len(),
        })
    }

    /// Счётчики записи снапшота (для отчёта о состоянии и журнала).
    pub fn write_stats(&self) -> StatsSnapshot {
        self.store.stats()
    }

    /// Список резервных копий снапшота — для списка «Резервные копии».
    pub fn list_backups(&self) -> Vec<Value> {
        integrity::describe_backups(&self.path, atomic::DEFAULT_BACKUP_SLOTS)
            .into_iter()
            .map(|slot| {
                json!({
                    "slot": slot.slot,
                    "file": path_text(&slot.file),
                    "name": slot.name,
                    "bytes": slot.bytes,
                    "mtime": slot.mtime_ms,
                    "valid": slot.valid,
                    "error": slot.error,
                })
            })
            .collect()
    }

    /// Откатиться к резервной копии слота; в ответе — признак и причина отказа.
    ///
    /// Раскладка, пресеты и сессии лежат в снапшоте, а история событий и чата — в
    /// отдельных append-only JSONL, поэтому откат снапшота историю не трогает.
    pub fn restore_from_backup(&self, slot: usize) -> Value {
        let candidate = atomic::backup_path(&self.path, slot);
        match integrity::try_read_json(&candidate) {
            integrity::JsonRead::Value(value) => {
                {
                    let mut data = self.data.lock().unwrap();
                    *data = deep_defaults(&default_data(), value.as_object());
                }
                self.persist();
                json!({ "ok": true, "slot": slot })
            }
            integrity::JsonRead::Missing => json!({
                "ok": false,
                "error": "резервная копия недоступна",
            }),
            integrity::JsonRead::Invalid(reason) => json!({ "ok": false, "error": reason }),
        }
    }

    /// Дождаться, пока отложенные записи окажутся на диске.
    pub fn flush(&self) {
        self.store.flush();
        self.history.flush();
        self.chat.flush();
    }

    /// Синхронно сбросить недописанное — для выхода из приложения.
    ///
    /// Каждое хранилище сбрасывается своим вызовом (в JS это три отдельных
    /// выражения): короткое замыкание `||` пропустило бы часть работы.
    pub fn flush_sync(&self) -> bool {
        let database = self.store.flush_sync();
        let history = self.history.flush_sync();
        let chat = self.chat.flush_sync();
        database || history || chat
    }

    /// Поставить снапшот в очередь на запись (схлопывается с соседними).
    fn persist(&self) {
        let snapshot = Value::Object(self.data.lock().unwrap().clone());
        self.store.write(snapshot);
    }
}

/// Куда пожаловаться на сбой записи — как `console.warn` в JS: это сообщение идёт
/// в stderr, а не в шину журнала (в Electron там тоже стоял `console.warn`),
/// потому что база открывается раньше, чем поднимается сервер с шиной.
fn write_logger(label: &'static str) -> Arc<logger::LogFn> {
    Arc::new(move |message: &str| eprintln!("[{label}] {message}"))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Путь «брата» файла: `local-db.json` → `local-db.jsonl`.
///
/// Повторяет `dbPath.replace(/\.json$/i, "") + ".jsonl"` — расширение отрезается
/// только в конце имени и без учёта регистра.
fn sibling_path(file: &Path, suffix: &str) -> PathBuf {
    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let base = if name.len() >= 5 {
        match name.get(name.len() - 5..) {
            Some(tail) if tail.eq_ignore_ascii_case(".json") => &name[..name.len() - 5],
            _ => &name[..],
        }
    } else {
        &name[..]
    };
    file.with_file_name(format!("{base}{suffix}"))
}

/// Значение по пути с точками: `overlay.widgets`.
fn path_value<'a>(data: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    let mut keys = path.split('.');
    let mut current = data.get(keys.next()?)?;
    for key in keys {
        current = current.get(key)?;
    }
    Some(current)
}

/// Записать значение по пути, создавая промежуточные объекты: `set("overlay.widgets")`.
fn set_value(data: &mut Map<String, Value>, path: &str, value: Value) {
    let keys: Vec<&str> = path.split('.').collect();
    let Some((last, parents)) = keys.split_last() else {
        return;
    };
    let mut node = data;
    for key in parents {
        node = child_object(node, key);
    }
    node.insert((*last).to_string(), value);
}

/// Спуститься в подобъект, заменив не-объект пустым (как `node[key] = {}` в JS).
fn child_object<'a>(node: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    if !matches!(node.get(key), Some(Value::Object(_))) {
        node.insert(key.to_string(), Value::Object(Map::new()));
    }
    match node.get_mut(key) {
        Some(Value::Object(child)) => child,
        _ => unreachable!("объект только что записан"),
    }
}

/// Массив по ключу в общем документе (создаётся при необходимости).
fn ensure_array<'a>(data: &'a mut Map<String, Value>, key: &str) -> &'a mut Vec<Value> {
    if !matches!(data.get(key), Some(Value::Array(_))) {
        data.insert(key.to_string(), Value::Array(Vec::new()));
    }
    match data.get_mut(key) {
        Some(Value::Array(items)) => items,
        _ => unreachable!("массив только что записан"),
    }
}

/// Массив из значения: не массив — пустой список (в JS так делают `|| []` и
/// проверки `Array.isArray`).
fn array_at(value: Option<Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

/// `value || fallback` по правилам JS: пустая строка, ноль и `false` тоже ложны.
fn or_default(value: Option<&Value>, fallback: Value) -> Value {
    match value {
        Some(value) if history::js_truthy(Some(value)) => value.clone(),
        _ => fallback,
    }
}

/// `typeof x === "number" ? x : null`.
fn number_or_null(value: Option<&Value>) -> Value {
    match value {
        Some(value @ Value::Number(_)) => value.clone(),
        _ => Value::Null,
    }
}

/// Числовое поле значения; всё непонятное — ноль (`Number(x) || 0`).
fn number_field(value: &Value, key: &str) -> f64 {
    history::js_number_or_zero(value.get(key))
}

/// Число из сырого поля с подстановкой умолчания (проверка `typeof === "number"`).
fn raw_number(value: Option<&Value>, fallback: f64) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(fallback),
        _ => fallback,
    }
}

/// Число для JSON: целое печатается без дробной части — как в JS.
fn number_or(value: Option<&Value>, fallback: f64) -> Value {
    num(raw_number(value, fallback))
}

/// `Number(x) || fallback`: строка разбирается, мусор считается пустым.
fn coerced_number(value: Option<&Value>, fallback: f64) -> f64 {
    match value {
        None => fallback,
        Some(value) => {
            let number = history::js_number_or_zero(Some(value));
            if number == 0.0 {
                fallback
            } else {
                number
            }
        }
    }
}

/// Число так, как его напечатал бы JS: `10`, а не `10.0`.
///
/// Это важно, потому что такие значения уезжают в `local-db.json` и во
/// фронтенд; само правило живёт рядом с остальной семантикой JS (см. `history`).
fn num(value: f64) -> Value {
    history::number_value(value)
}

fn string_or(value: Option<&Value>, fallback: &str) -> Value {
    match value {
        Some(Value::String(text)) => json!(text),
        _ => json!(fallback),
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value.is_nan() {
        return min;
    }
    value.max(min).min(max)
}

/// Событие попадает в диапазон сессии: `ts >= from && ts <= to`.
fn in_range(record: &Value, from: f64, to: f64) -> bool {
    let ts = number_field(record, "timestamp");
    ts >= from && ts <= to
}

/// Слияние настроек с правкой: `{ ...current, ...patch }`.
fn merge(current: Value, patch: Option<&Value>) -> Value {
    let mut merged = match current {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if let Some(Value::Object(patch)) = patch {
        for (key, value) in patch {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `path.dirname` из JS: у файла без каталога — текущий каталог.
fn dirname(path: &Path) -> String {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => path_text(parent),
        _ => ".".to_string(),
    }
}

fn file_size(file: &Path) -> u64 {
    fs::metadata(file).map(|data| data.len()).unwrap_or(0)
}

/// Снимок в JSON с отступом в два пробела — как `JSON.stringify(data, null, 2)`.
fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Временный каталог под один тест; имя — по имени теста, чтобы не пересекались.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("ose-db-{}-{label}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            Self(dir)
        }

        fn storage(&self) -> Storage {
            Storage::beside_sources(self.0.clone())
        }

        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn open(&self) -> Database {
            Database::open(&self.storage())
        }

        /// Документ снапшота с диска.
        fn snapshot(&self) -> Value {
            let text = fs::read_to_string(self.file("local-db.json")).expect("снапшот есть");
            serde_json::from_str(&text).expect("снапшот — JSON")
        }

        fn history_lines(&self) -> Vec<Value> {
            lines_of(&self.file("local-db.jsonl"))
        }

        fn chat_lines(&self) -> Vec<Value> {
            lines_of(&self.file("local-db.chat.jsonl"))
        }

        /// Временные файлы, оставшиеся рядом с базой.
        fn leftovers(&self) -> Vec<String> {
            fs::read_dir(&self.0)
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .filter(|name| name.ends_with(".tmp"))
                        .collect()
                })
                .unwrap_or_default()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    fn lines_of(file: &Path) -> Vec<Value> {
        match fs::read_to_string(file) {
            Ok(text) => text
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| serde_json::from_str(line).expect("строка файла — JSON"))
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    fn ids_of(lines: &[Value]) -> Vec<Value> {
        lines.iter().map(|line| line["id"].clone()).collect()
    }

    fn limited(limit: usize) -> QueryOptions {
        QueryOptions {
            limit: Some(limit),
            ..Default::default()
        }
    }

    #[test]
    fn creates_default_collections() {
        let dir = TempDir::new("defaults");
        let db = dir.open();

        assert!(db.widgets().is_empty());
        assert!(db.sessions().is_empty());
        assert!(db.chat(None).is_empty());
        assert_eq!(
            db.stream_events(&limited(50)),
            Page {
                items: Vec::new(),
                total: 0
            }
        );
        // Умолчания сразу оказываются на диске — как синхронная запись в JS.
        assert_eq!(dir.snapshot()["language"], json!("en"));
    }

    #[test]
    fn saves_and_reads_layout_presets() {
        let dir = TempDir::new("presets");
        let db = dir.open();

        assert!(db.layout_presets().is_empty());
        let saved = db.save_layout_presets(vec![
            json!({ "id": "p1", "name": "Основной", "widgets": [{ "id": "w1" }] }),
        ]);
        assert_eq!(saved.len(), 1);
        assert_eq!(db.layout_presets()[0]["name"], json!("Основной"));

        let polls = db.save_poll_presets(vec![
            json!({ "id": "pp1", "name": "Опрос", "command": "!poll", "chartType": "bars" }),
        ]);
        assert_eq!(polls.len(), 1);
        assert_eq!(db.poll_presets()[0]["name"], json!("Опрос"));
    }

    #[test]
    fn writes_and_reads_donation_from_history() {
        let dir = TempDir::new("donation");
        let db = dir.open();

        let row = db.append_stream_event(&json!({
            "type": "donation",
            "kind": "donation",
            "username": "viewer",
            "amount": 100,
            "currency": "RUB",
            "message": "hello",
            "is_test": false,
        }));
        // Идентификатор выдаётся, если своего нет.
        assert!(!row["id"].as_str().unwrap_or_default().is_empty());
        assert_eq!(row["username"], json!("viewer"));

        let page = db.stream_events(&limited(10));
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0]["username"], json!("viewer"));
        assert_eq!(page.items[0]["amount"], json!(100));
    }

    #[test]
    fn clear_history_keeps_settings() {
        let dir = TempDir::new("clear-history");
        let db = dir.open();

        db.append_stream_event(&json!({ "type": "donation", "username": "a", "amount": 1 }));
        db.append_chat(&json!({ "user": "a", "message": "hi" }));
        db.start_session("test");
        db.save_wheel_config(Some(&json!({ "musicVolume": 70 })));

        db.clear_history();

        assert_eq!(db.stream_events(&limited(10)).total, 0);
        assert!(db.chat(None).is_empty());
        assert!(db.sessions().is_empty());
        assert_eq!(db.wheel_config()["musicVolume"], json!(70));
    }

    #[test]
    fn clear_all_resets_to_defaults() {
        let dir = TempDir::new("clear-all");
        let db = dir.open();

        db.save_widgets(vec![json!({ "id": "x" })]);
        db.save_wheel_config(Some(&json!({ "musicVolume": 70 })));
        db.append_stream_event(&json!({ "type": "donation", "username": "a", "amount": 1 }));

        db.clear_all();

        assert!(db.widgets().is_empty());
        assert_eq!(db.wheel_config()["musicVolume"], json!(50));
        assert_eq!(db.stream_events(&limited(10)).total, 0);
    }

    #[test]
    fn writes_and_reads_chat_with_pagination() {
        let dir = TempDir::new("chat");
        let db = dir.open();

        db.append_chat(
            &json!({ "user": "alice", "message": "hi", "sessionId": "s1", "timestamp": 1 }),
        );
        db.append_chat(
            &json!({ "user": "bob", "message": "yo", "sessionId": "s1", "timestamp": 2 }),
        );
        db.append_chat(&json!({ "user": "carol", "message": "hey", "timestamp": 3 }));

        assert_eq!(db.chat(None).len(), 3);
        assert_eq!(db.chat(Some(&json!("s1"))).len(), 2);
        assert!(db.chat(Some(&json!("nope"))).is_empty());

        let page = db.chat_page(&limited(2));
        assert_eq!(page.total, 3);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0]["username"], json!("carol"));
    }

    #[test]
    fn chat_history_can_be_disabled() {
        let dir = TempDir::new("chat-off");
        let db = dir.open();

        assert!(db.chat_history_enabled());
        assert!(!db.set_chat_history_enabled(false));
        assert!(!db.chat_history_enabled());
        assert!(db
            .append_chat(&json!({ "user": "a", "message": "hi" }))
            .is_none());
        assert!(db.chat(None).is_empty());

        assert!(db.set_chat_history_enabled(true));
        assert!(db
            .append_chat(&json!({ "user": "a", "message": "hi" }))
            .is_some());
    }

    #[test]
    fn clear_chat_and_clear_sessions_touch_only_their_area() {
        let dir = TempDir::new("clear-parts");
        let db = dir.open();

        db.append_stream_event(&json!({ "type": "donation", "username": "a", "amount": 1 }));
        db.append_chat(&json!({ "user": "a", "message": "hi" }));
        db.start_session("test");

        db.clear_chat();
        assert!(db.chat(None).is_empty());
        assert_eq!(db.stream_events(&limited(10)).total, 1);
        assert_eq!(db.sessions().len(), 1);

        db.clear_sessions();
        assert!(db.sessions().is_empty());
        assert_eq!(db.stream_events(&limited(10)).total, 1);
    }

    #[test]
    fn sessions_with_stats_aggregate_events_and_chat() {
        let dir = TempDir::new("stats");
        let db = dir.open();

        let session = db.start_session("chan");
        db.append_stream_event(&json!({ "type": "donation", "username": "a", "amount": 5 }));
        db.append_stream_event(&json!({ "type": "follow", "username": "b" }));
        db.append_chat(&json!({ "user": "a", "message": "hi", "sessionId": session["id"] }));

        let stats = db.sessions_with_stats();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0]["id"], session["id"]);
        assert_eq!(stats[0]["channel"], json!("chan"));
        assert_eq!(stats[0]["events"], json!(2));
        assert_eq!(stats[0]["donations"], json!(1));
        assert_eq!(stats[0]["chat"], json!(1));
        assert!(stats[0]["durationMs"].as_f64().unwrap() >= 0.0);
        assert_eq!(stats[0]["endedAt"], Value::Null);
    }

    #[test]
    fn ends_session_and_keeps_unknown_session_untouched() {
        let dir = TempDir::new("sessions");
        let db = dir.open();

        let session = db.start_session("x");
        assert!(db.end_session(&json!("чужой")).is_none());
        let ended = db.end_session(&session["id"]).expect("сессия есть");
        assert!(ended["endedAt"].is_number());
        assert!(db.sessions()[0]["endedAt"].is_number());
    }

    #[test]
    fn remove_stream_events_deletes_by_filter() {
        let dir = TempDir::new("remove");
        let db = dir.open();

        db.append_stream_event(&json!({ "type": "donation", "username": "a", "amount": 1 }));
        db.append_stream_event(&json!({ "type": "follow", "username": "b" }));

        let filter = QueryOptions {
            kind: Some(json!("donation")),
            ..Default::default()
        };
        assert_eq!(db.remove_stream_events(&filter), 1);
        assert_eq!(db.stream_events(&limited(10)).total, 1);
        assert_eq!(db.remove_stream_events(&filter), 0);
    }

    #[test]
    fn history_limit_applies_and_persists() {
        let dir = TempDir::new("limit");
        let db = dir.open();

        assert_eq!(db.history_limit(), history::DEFAULT_MAX_RECORDS);
        assert_eq!(db.set_history_limit(Some(5)), 5);
        assert_eq!(db.history_limit(), 5);
        db.flush();
        assert_eq!(dir.snapshot()["history_max_records"], json!(5));

        for index in 0..10 {
            db.append_stream_event(&json!({ "type": "follow", "username": format!("u{index}") }));
        }
        assert_eq!(db.stream_events(&limited(100)).total, 5);

        // Ноль — это «без лимита», а не «ничего не хранить».
        assert_eq!(db.set_history_limit(Some(0)), 0);
        assert_eq!(db.stream_events(&limited(100)).total, 10);
    }

    #[test]
    fn known_source_ids_collects_service_ids() {
        let dir = TempDir::new("source-ids");
        let db = dir.open();

        db.append_stream_event(&json!({ "type": "donation", "username": "a", "source_id": 777 }));
        db.append_stream_event(&json!({ "type": "follow", "username": "b" }));

        let known = db.known_source_ids(None);
        // `source_id` в записи — строка, даже если пришло число.
        assert!(known.contains("777"), "{known:?}");
        assert_eq!(known.len(), 1);
    }

    #[test]
    fn storage_stats_reports_paths_sizes_and_counters() {
        let dir = TempDir::new("stats-paths");
        let db = dir.open();

        db.start_session("x");
        db.append_stream_event(&json!({ "type": "follow", "username": "a" }));
        db.append_chat(&json!({ "user": "a", "message": "hi" }));

        let stats = db.storage_stats();
        assert_eq!(stats["dir"], json!(dir.0.to_string_lossy().into_owned()));
        assert_eq!(
            stats["database"]["path"],
            json!(dir.file("local-db.json").to_string_lossy().into_owned())
        );
        assert!(stats["history"]["path"]
            .as_str()
            .unwrap()
            .contains(".jsonl"));
        assert!(stats["chat"]["path"]
            .as_str()
            .unwrap()
            .contains(".chat.jsonl"));
        assert_eq!(stats["sessions"], json!(1));
        assert_eq!(stats["history"]["count"], json!(1));
        assert_eq!(stats["chat"]["count"], json!(1));
        assert!(stats["history"]["bytes"].is_number());
        assert!(stats["database"]["lastError"].is_null());
    }

    #[test]
    fn persist_and_flush_write_all_events_without_temp_files() {
        let dir = TempDir::new("persist");
        let db = dir.open();

        for index in 0..200 {
            db.append_stream_event(
                &json!({ "type": "donation", "username": format!("u{index}"), "amount": index }),
            );
        }
        db.flush();

        assert_eq!(dir.history_lines().len(), 200);
        assert!(dir.leftovers().is_empty(), "{:?}", dir.leftovers());
    }

    #[test]
    fn flush_sync_writes_the_last_state() {
        let dir = TempDir::new("flush-sync");
        let db = dir.open();

        db.append_stream_event(&json!({ "type": "follow", "username": "sync_user" }));
        // Воркер мог записать и сам — важно, что после сброса запись на диске.
        db.flush_sync();

        let rows = dir.history_lines();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["username"], json!("sync_user"));
    }

    #[test]
    fn legacy_stream_events_move_to_jsonl() {
        let dir = TempDir::new("legacy-events");
        fs::write(
            dir.file("local-db.json"),
            json!({
                "overlay": { "widgets": [] },
                "sessions": [],
                "stream_events": [
                    { "id": "leg1", "timestamp": 1, "type": "donation", "username": "legacy" },
                    { "id": "leg2", "timestamp": 2, "type": "follow", "username": "old" },
                ],
            })
            .to_string(),
        )
        .unwrap();

        let db = dir.open();
        assert_eq!(db.stream_events(&limited(10)).total, 2);
        assert_eq!(
            db.stream_event_by_id(Some(&json!("leg2"))).unwrap()["username"],
            json!("old")
        );

        db.flush();
        assert_eq!(
            ids_of(&dir.history_lines()),
            vec![json!("leg1"), json!("leg2")]
        );
        // Прежнее поле из снапшота убрано.
        assert!(dir.snapshot().get("stream_events").is_none());
    }

    #[test]
    fn legacy_chat_messages_move_to_jsonl() {
        let dir = TempDir::new("legacy-chat");
        fs::write(
            dir.file("local-db.json"),
            json!({
                "sessions": [],
                "chatMessages": [
                    { "id": "c1", "timestamp": 1, "username": "old", "message": "hi" },
                    { "id": "c2", "timestamp": 2, "username": "old2", "message": "yo" },
                ],
            })
            .to_string(),
        )
        .unwrap();

        let db = dir.open();
        assert_eq!(db.chat(None).len(), 2);

        db.flush();
        assert_eq!(ids_of(&dir.chat_lines()), vec![json!("c1"), json!("c2")]);
        assert_eq!(dir.snapshot()["chatMessages"], json!([]));
    }

    #[test]
    fn legacy_events_are_not_duplicated_when_history_already_has_them() {
        let dir = TempDir::new("legacy-merge");
        // История уже есть, и в снапшоте лежит одна из тех же записей.
        fs::write(
            dir.file("local-db.jsonl"),
            "{\"id\":\"leg1\",\"timestamp\":1,\"type\":\"donation\",\"username\":\"legacy\"}\n",
        )
        .unwrap();
        fs::write(
            dir.file("local-db.json"),
            json!({
                "stream_events": [
                    { "id": "leg1", "timestamp": 1, "type": "donation", "username": "legacy" },
                    { "id": "leg2", "timestamp": 2, "type": "follow", "username": "old" },
                ],
            })
            .to_string(),
        )
        .unwrap();

        let db = dir.open();
        db.flush();

        // Дубль не добавлен, новое — добавлено.
        assert_eq!(
            ids_of(&dir.history_lines()),
            vec![json!("leg1"), json!("leg2")]
        );
    }

    #[test]
    fn unknown_snapshot_keys_survive_writes() {
        let dir = TempDir::new("unknown-keys");
        fs::write(
            dir.file("local-db.json"),
            json!({ "sessions": [], "setting_from_2027": 42 }).to_string(),
        )
        .unwrap();

        let db = dir.open();
        db.save_language("ru");
        db.flush();

        let saved = dir.snapshot();
        assert_eq!(saved["setting_from_2027"], json!(42));
        assert_eq!(saved["language"], json!("ru"));
    }

    #[test]
    fn numbers_are_written_as_the_script_would() {
        let dir = TempDir::new("numbers");
        let db = dir.open();

        db.save_participants_config(None);
        db.flush();

        // Целые не должны превращаться в 10.0: файл читает и правит в том числе
        // Electron-версия, а `serde_json` печатает f64 как есть.
        let text = fs::read_to_string(dir.file("local-db.json")).unwrap();
        assert!(text.contains("\"maxNames\": 10"), "{text}");
        assert!(text.contains("\"backgroundOpacity\": 82"), "{text}");
        assert!(!text.contains(".0,"), "{text}");
    }

    #[test]
    fn mic_config_defaults_and_normalizes_on_read() {
        let dir = TempDir::new("mic");
        let db = dir.open();

        let defaults = db.mic_config();
        assert_eq!(defaults["visualizer_mode"], json!("sine"));
        assert_eq!(defaults["barCount"], json!(32));
        assert_eq!(defaults["echoCancellation"], json!(true));

        // Запись возвращает то, что передали, — как `{...current, ...patch}` в JS.
        let saved = db.save_mic_config(Some(&json!({
            "barCount": 1000,
            "smoothing": 5,
            "visualizer_mode": "bars",
            "echoCancellation": false,
        })));
        assert_eq!(saved["barCount"], json!(1000));
        assert_eq!(saved["visualizer_mode"], json!("bars"));

        // А чтение приводит значения к допустимым.
        let normalized = db.mic_config();
        assert_eq!(normalized["barCount"], json!(64));
        assert_eq!(normalized["smoothing"], json!(1));
        assert_eq!(normalized["echoCancellation"], json!(false));
        // Мусор в режиме подменяется умолчанием.
        db.set_path(
            "overlay_mic_config",
            json!({ "visualizer_mode": "чужое", "freqScale": "linear" }),
        );
        assert_eq!(db.mic_config()["visualizer_mode"], json!("sine"));
        assert_eq!(db.mic_config()["freqScale"], json!("linear"));
    }

    #[test]
    fn poll_config_cleans_options_and_command() {
        let dir = TempDir::new("poll");
        let db = dir.open();

        assert_eq!(db.poll_config()["command"], json!("!poll"));
        assert_eq!(db.poll_config()["options"], json!([]));

        db.set_path(
            "poll_config",
            json!({
                "command": "   ",
                "chartType": "pie",
                "options": [
                    { "id": "o1", "label": "Да" },
                    { "id": 2, "label": "Нет" },
                    { "label": "Без id" },
                ],
            }),
        );
        let config = db.poll_config();
        assert_eq!(config["command"], json!("!poll"));
        assert_eq!(config["chartType"], json!("pie"));
        assert_eq!(config["options"], json!([{ "id": "o1", "label": "Да" }]));
    }

    #[test]
    fn moderation_warns_keep_only_positive_whole_numbers() {
        let dir = TempDir::new("warns");
        let db = dir.open();

        let saved = db.save_moderation_warns(Some(&json!({
            "u1": 3,
            "u2": "2",
            "u3": 0,
            "u4": -1,
            "u5": "мусор",
        })));
        assert_eq!(saved, json!({ "u1": 3, "u2": 2 }));
        assert_eq!(db.moderation_warns(), json!({ "u1": 3, "u2": 2 }));
        assert_eq!(db.save_moderation_warns(None), json!({}));
    }

    #[test]
    fn deep_defaults_fills_missing_and_keeps_saved() {
        let defaults = default_data();
        let data = json!({
            "language": "ru",
            "overlay": { "widgets": [{ "id": "w" }] },
            "moderation_warns": null,
            "setting_from_2027": 42,
        });
        let merged = deep_defaults(&defaults, data.as_object());

        assert_eq!(merged["language"], json!("ru"));
        assert_eq!(merged["overlay"]["widgets"], json!([{ "id": "w" }]));
        // `null` — это «значения нет»: подставляется умолчание.
        assert_eq!(merged["moderation_warns"], json!({}));
        // Ключи, которых нет в умолчаниях, остаются.
        assert_eq!(merged["setting_from_2027"], json!(42));
        // Пропущенное — появляется.
        assert_eq!(merged["wheel_speed_config"]["speed"], json!(3));
    }

    #[test]
    fn sibling_paths_replace_the_extension() {
        assert_eq!(
            sibling_path(Path::new("C:/app/local-db.json"), ".jsonl"),
            PathBuf::from("C:/app/local-db.jsonl")
        );
        assert_eq!(
            sibling_path(Path::new("C:/app/local-db.JSON"), ".chat.jsonl"),
            PathBuf::from("C:/app/local-db.chat.jsonl")
        );
        // Не наше расширение — не трогаем: имя просто получает хвост.
        assert_eq!(
            sibling_path(Path::new("C:/app/db"), ".jsonl"),
            PathBuf::from("C:/app/db.jsonl")
        );
    }

    #[test]
    fn dotted_paths_write_through_nested_objects() {
        let dir = TempDir::new("paths");
        let db = dir.open();

        assert_eq!(db.get_path("overlay.widgets"), Some(json!([])));
        assert_eq!(db.get_path("overlay.nope"), None);

        db.set_path("a.b.c", json!(1));
        assert_eq!(db.get_path("a.b.c"), Some(json!(1)));
        assert_eq!(db.get("a"), Some(json!({ "b": { "c": 1 } })));

        // Не-объект на пути заменяется объектом, как `node[key] = {}` в JS.
        db.set_path("language.inner", json!("x"));
        assert_eq!(db.get_path("language.inner"), Some(json!("x")));
    }

    #[test]
    fn list_backups_reports_slots() {
        let dir = TempDir::new("backups");
        let db = dir.open();

        assert!(db.list_backups().is_empty());
        fs::write(
            atomic::backup_path(&dir.file("local-db.json"), 0),
            "{\"from_backup\":true}",
        )
        .unwrap();
        fs::write(
            atomic::backup_path(&dir.file("local-db.json"), 1),
            "{ сломано",
        )
        .unwrap();

        let slots = db.list_backups();
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0]["slot"], json!(0));
        assert_eq!(slots[0]["valid"], json!(true));
        assert_eq!(slots[1]["valid"], json!(false));
        assert!(slots[1]["error"].is_string());
    }

    #[test]
    fn restore_from_backup_replaces_the_document() {
        let dir = TempDir::new("restore");
        let db = dir.open();
        db.save_language("ru");
        db.flush();

        fs::write(
            atomic::backup_path(&dir.file("local-db.json"), 0),
            json!({ "language": "en", "from_backup": true }).to_string(),
        )
        .unwrap();

        let answer = db.restore_from_backup(0);
        assert_eq!(answer["ok"], json!(true));
        assert_eq!(db.language(), "en");
        db.flush();
        assert_eq!(dir.snapshot()["from_backup"], json!(true));

        // Пустого слота нет — откат не удался.
        let failed = db.restore_from_backup(2);
        assert_eq!(failed["ok"], json!(false));
        assert!(failed["error"].is_string());
    }
}
