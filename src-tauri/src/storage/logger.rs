//! Единый журнал приложения: консоль, шина и файл.
//!
//! Порт `server/logger.js`. Каждая служба берёт свой [`Logger`] и зовёт
//! `info`/`success`/`warn`/`error`/`debug`; запись уходит в консоль, в шину
//! (`terminal_log` и `debug_log` — из них живут окна «Терминал» и «Отладка»
//! в панели) и, если включено файловое логирование, в суточный файл
//! `logs/ose-YYYY-MM-DD.log`.
//!
//! Шина здесь — трейт, а не конкретный объект: журнал не должен знать, как
//! устроен транспорт (у панели это WebSocket, у CLI — просто консоль). В
//! Electron-версии ровно то же самое делал `bus.emit`.
//!
//! Файловое состояние — глобальное, как в JS (`enableFileLogging` вызывается
//! один раз при старте). Поэтому его трогают под общим замком: запись из
//! нескольких потоков не должна мешать ротации по дате.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};

/// Сколько дней держим файлы журнала.
pub const LOG_RETENTION_DAYS: i64 = 7;

/// Куда журнал отдаёт записи, кроме консоли и файла.
pub trait LogBus: Send + Sync {
    /// `terminal_log` — обычная запись, `debug_log` — отладочная.
    fn emit(&self, event: &str, entry: &Value);
}

/// Куда пишет сообщения тот, кто ведёт наблюдение (журнал, консоль).
pub type LogFn = dyn Fn(&str) + Send + Sync;

/// Уровень записи.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Success,
    Warn,
    Error,
    Debug,
}

impl Level {
    fn name(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Success => "success",
            Level::Warn => "warn",
            Level::Error => "error",
            Level::Debug => "debug",
        }
    }

    /// Отладочные записи идут в отдельное событие шины.
    fn event(self) -> &'static str {
        match self {
            Level::Debug => "debug_log",
            _ => "terminal_log",
        }
    }
}

/// Журнал одной службы.
#[derive(Clone)]
pub struct Logger {
    service: String,
    bus: Option<Arc<dyn LogBus>>,
}

impl Logger {
    /// Завести журнал службы; `bus` — если записи нужны ещё и в панели.
    pub fn new(service: &str, bus: Option<Arc<dyn LogBus>>) -> Self {
        Self {
            service: service.to_string(),
            bus,
        }
    }

    pub fn service(&self) -> &str {
        &self.service
    }

    pub fn info(&self, message: &str, data: Option<&Value>) {
        self.write(Level::Info, message, data);
    }

    pub fn success(&self, message: &str, data: Option<&Value>) {
        self.write(Level::Success, message, data);
    }

    pub fn warn(&self, message: &str, data: Option<&Value>) {
        self.write(Level::Warn, message, data);
    }

    pub fn error(&self, message: &str, data: Option<&Value>) {
        self.write(Level::Error, message, data);
    }

    pub fn debug(&self, message: &str, data: Option<&Value>) {
        self.write(Level::Debug, message, data);
    }

    /// Запись с готовым уровнем: нужно там, где уровень приходит извне.
    pub fn write(&self, level: Level, message: &str, data: Option<&Value>) {
        let timestamp = now_ms();
        let entry = json!({
            "timestamp": timestamp,
            "service": self.service,
            "level": level.name(),
            "message": message,
            "data": data.cloned().unwrap_or(Value::Null),
        });

        let label = format!("[{}] [{}]", self.service, level.name());
        let suffix = serialize_data(data);
        match level {
            Level::Error | Level::Warn => eprintln!("{label} {message}{suffix}"),
            // «Терминал» панели показывает то же, что консоль.
            _ => println!("{label} {message}{suffix}"),
        }

        if let Some(bus) = &self.bus {
            bus.emit(level.event(), &entry);
        }

        // Файловое логирование не должно ронять приложение.
        append_file_line(&format!(
            "[{}] [{}] [{}] {message}{suffix}\n",
            iso(timestamp),
            self.service,
            level.name()
        ));
    }
}

/// Включить файловое логирование в каталоге (и сразу подчистить старое).
pub fn enable_file_logging(dir: &Path) {
    let mut state = file_log().lock().unwrap_or_else(|error| error.into_inner());
    state.dir = Some(dir.to_path_buf());
    state.file = None;
    state.day.clear();
    drop(state);
    prune_old_logs(dir);
}

/// Выключить файловое логирование.
pub fn close_file_logging() {
    let mut state = file_log().lock().unwrap_or_else(|error| error.into_inner());
    state.dir = None;
    state.file = None;
    state.day.clear();
}

/// Строка, которая уходит в файл после текста сообщения: как `serializeData`.
fn serialize_data(data: Option<&Value>) -> String {
    match data {
        None => String::new(),
        Some(Value::String(text)) => format!(" {text}"),
        Some(value) => match serde_json::to_string(value) {
            Ok(text) => format!(" {text}"),
            Err(_) => " [unserializable]".to_string(),
        },
    }
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Время в ISO с миллисекундами — то же, что `new Date(ms).toISOString()`.
///
/// Живёт рядом с журналом не случайно: так время печатается в одном месте и
/// везде выглядит одинаково (журнал, отчёты, выгрузка истории).
pub fn iso_from_unix_ms(timestamp_ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(timestamp_ms)
        .map(|moment| moment.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn iso(timestamp_ms: i64) -> String {
    iso_from_unix_ms(timestamp_ms).unwrap_or_default()
}

/// Дописать строку в суточный файл журнала.
///
/// Файл открывается по требованию и переоткрывается при смене суток — как
/// `ensureFileStream` в JS. Ошибки глушим: журнал не должен мешать работе.
fn append_file_line(line: &str) {
    let mut state = file_log().lock().unwrap_or_else(|error| error.into_inner());
    let Some(dir) = state.dir.clone() else {
        return;
    };

    let day = local_day();
    if state.file.is_none() || state.day != day {
        state.file = None;
        if fs::create_dir_all(&dir).is_err() {
            return;
        }
        match OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(format!("ose-{day}.log")))
        {
            Ok(file) => {
                state.file = Some(file);
                state.day = day;
            }
            Err(error) => {
                eprintln!("[logger] failed to open log file: {error}");
                state.day.clear();
                return;
            }
        }
    }

    if let Some(file) = state.file.as_mut() {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Убрать файлы журнала старше срока хранения (по времени изменения).
pub fn prune_old_logs(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let cutoff = now_ms() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_daily_log_name(&name) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let mtime_ms = modified
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis() as i64)
            .unwrap_or(0);
        if mtime_ms < cutoff {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Имя суточного файла журнала: `ose-YYYY-MM-DD.log`.
///
/// Разбор руками вместо `/^ose-\d{4}-\d{2}-\d{2}\.log$/`: правило короткое, и
/// лишняя зависимость ради него не нужна.
fn is_daily_log_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("ose-") else {
        return false;
    };
    let Some(stamp) = rest.strip_suffix(".log") else {
        return false;
    };
    let bytes = stamp.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let expected_dash = index == 4 || index == 7;
        if expected_dash {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_digit() {
            return false;
        }
    }
    true
}

/// Локальная дата — по ней называется файл (пользователь ищет «сегодняшний»).
fn local_day() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

struct FileLogState {
    dir: Option<PathBuf>,
    file: Option<File>,
    day: String,
}

fn file_log() -> &'static Mutex<FileLogState> {
    static STATE: OnceLock<Mutex<FileLogState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(FileLogState {
            dir: None,
            file: None,
            day: String::new(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Файловое логирование глобальное, поэтому тесты этого модуля идут по
    /// очереди: иначе запись одного попадала бы в файл другого.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|error| error.into_inner())
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("ose-log-{}-{label}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            Self(dir)
        }

        fn logs(&self) -> PathBuf {
            self.0.join("logs")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            // Логирование могло остаться включённым — гасим, чтобы не писать в
            // удалённый каталог.
            close_file_logging();
            fs::remove_dir_all(&self.0).ok();
        }
    }

    /// Шина, которая запоминает события — как заглушка в тесте JS.
    #[derive(Default)]
    struct RecordingBus {
        events: Mutex<Vec<(String, Value)>>,
    }

    impl RecordingBus {
        fn events(&self) -> Vec<(String, Value)> {
            self.events.lock().unwrap().clone()
        }
    }

    impl LogBus for RecordingBus {
        fn emit(&self, event: &str, entry: &Value) {
            self.events
                .lock()
                .unwrap()
                .push((event.to_string(), entry.clone()));
        }
    }

    fn log_lines(dir: &Path) -> Vec<String> {
        let name = format!("ose-{}.log", local_day());
        fs::read_to_string(dir.join(name))
            .map(|text| text.lines().map(str::to_string).collect())
            .unwrap_or_default()
    }

    #[test]
    fn terminal_log_entry_has_the_expected_shape() {
        let _guard = serial();
        let bus = Arc::new(RecordingBus::default());
        let logger = Logger::new("obs", Some(bus.clone()));

        logger.info("connected", Some(&json!({ "host": "127.0.0.1" })));

        let events = bus.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "terminal_log");
        let entry = &events[0].1;
        assert_eq!(entry["service"], json!("obs"));
        assert_eq!(entry["level"], json!("info"));
        assert_eq!(entry["message"], json!("connected"));
        assert_eq!(entry["data"], json!({ "host": "127.0.0.1" }));
        assert!(entry["timestamp"].as_i64().unwrap_or_default() > 0);
    }

    #[test]
    fn data_is_null_when_there_is_nothing_to_show() {
        let _guard = serial();
        let bus = Arc::new(RecordingBus::default());
        let logger = Logger::new("server", Some(bus.clone()));

        logger.error("boom", None);

        let events = bus.events();
        assert_eq!(events[0].0, "terminal_log");
        assert_eq!(events[0].1["level"], json!("error"));
        assert_eq!(events[0].1["message"], json!("boom"));
        assert_eq!(events[0].1["data"], Value::Null);
    }

    #[test]
    fn works_without_a_bus() {
        let _guard = serial();
        let logger = Logger::new("test", None);

        logger.warn("hi", None);
        logger.debug("подробности", Some(&json!(1)));

        // Ничего не падает и ничего не эмитится — проверять нечего, кроме самого
        // факта вызова; но это и есть контракт «работает без шины».
        assert_eq!(logger.service(), "test");
    }

    #[test]
    fn debug_goes_to_its_own_event() {
        let _guard = serial();
        let bus = Arc::new(RecordingBus::default());
        let logger = Logger::new("chat", Some(bus.clone()));

        logger.debug("кадр", Some(&json!({ "bytes": 371 })));

        let events = bus.events();
        assert_eq!(events[0].0, "debug_log");
        assert_eq!(events[0].1["level"], json!("debug"));
    }

    #[test]
    fn every_level_has_its_name() {
        let _guard = serial();
        assert_eq!(Level::Info.name(), "info");
        assert_eq!(Level::Success.name(), "success");
        assert_eq!(Level::Warn.name(), "warn");
        assert_eq!(Level::Error.name(), "error");
        assert_eq!(Level::Debug.name(), "debug");
        assert_eq!(Level::Debug.event(), "debug_log");
        assert_eq!(Level::Success.event(), "terminal_log");
    }

    #[test]
    fn data_is_serialized_the_way_the_script_does() {
        let _guard = serial();
        assert_eq!(serialize_data(None), "");
        assert_eq!(serialize_data(Some(&json!("текст"))), " текст");
        assert_eq!(serialize_data(Some(&json!({ "a": 1 }))), " {\"a\":1}");
        assert_eq!(serialize_data(Some(&json!([1, 2]))), " [1,2]");
    }

    #[test]
    fn file_logging_appends_lines_with_time_and_service() {
        let _guard = serial();
        let dir = TempDir::new("file");
        enable_file_logging(&dir.logs());

        let logger = Logger::new("obs", None);
        logger.info("connected", Some(&json!({ "host": "127.0.0.1" })));
        logger.warn("без данных", None);

        let lines = log_lines(&dir.logs());
        assert_eq!(lines.len(), 2);
        // `[время] [служба] [уровень] сообщение + данные`.
        assert!(
            lines[0].contains("] [obs] [info] connected {\"host\":\"127.0.0.1\"}"),
            "{}",
            lines[0]
        );
        assert!(lines[0].starts_with('['), "{}", lines[0]);
        assert!(
            lines[1].ends_with("] [obs] [warn] без данных"),
            "{}",
            lines[1]
        );
    }

    #[test]
    fn file_logging_off_means_nothing_is_written() {
        let _guard = serial();
        let dir = TempDir::new("off");
        close_file_logging();

        Logger::new("any", None).info("в пустоту", None);

        assert!(log_lines(&dir.logs()).is_empty());
    }

    #[test]
    fn old_log_files_are_pruned_by_date_of_change() {
        let _guard = serial();
        let dir = TempDir::new("prune");
        let logs = dir.logs();
        fs::create_dir_all(&logs).expect("каталог должен создаваться");

        let old = logs.join("ose-2020-01-01.log");
        fs::write(&old, "старое").unwrap();
        let fresh = logs.join("ose-2026-09-28.log");
        fs::write(&fresh, "свежее").unwrap();
        // Не наш формат имени — чужой файл, его не трогаем (это журнал
        // восстановлений, он лежит рядом).
        let other = logs.join("recovery-2020-01-01.log");
        fs::write(&other, "чужое").unwrap();

        let backdated = fs::File::options().write(true).open(&old).unwrap();
        backdated
            .set_times(fs::FileTimes::new().set_modified(
                std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 24 * 60 * 60),
            ))
            .unwrap();
        drop(backdated);

        enable_file_logging(&logs);

        assert!(!old.exists(), "старый файл журнала должен быть убран");
        assert!(fresh.exists(), "свежий файл остаётся");
        assert!(other.exists(), "чужой файл не наша забота");
    }

    #[test]
    fn daily_log_names_are_recognized() {
        let _guard = serial();
        assert!(is_daily_log_name("ose-2026-09-28.log"));
        assert!(!is_daily_log_name("ose-2026-9-28.log"));
        assert!(!is_daily_log_name("ose-2026-09-28.log.1"));
        assert!(!is_daily_log_name("recovery-2026-09-28.log"));
        assert!(!is_daily_log_name("ose-2026-09-28.txt"));
        assert!(!is_daily_log_name("ose-202-09-28.log"));
    }
}
