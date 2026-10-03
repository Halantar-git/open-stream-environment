//! Глобальные обработчики падений: отчёт на диск, сброс состояния, выход.
//!
//! Порт `server/crash-guard.js`. Смысл тот же: падение не должно уносить с собой
//! несохранённое состояние и не должно оставлять пользователя с исчезнувшим окном
//! без единой записи о причине. Порядок такой:
//!
//! * ошибка уходит в консоль, в отчёт `logs/crash-<метка>.log` (с версиями,
//!   платформой и памятью — это то, что просят в баг-репорте) и в диалог;
//! * перед выходом вызывается сброс состояния на диск;
//! * выход только контролируемый: диалог и `exit(1)`. Продолжать работу после
//!   непойманной ошибки нельзя — состояние процесса может быть каким угодно.
//!
//! Отличия от JS там, где отличается сама среда, а не правила:
//!
//! * «непойманная ошибка» — это паника: в Rust её перехватывает `panic::set_hook`,
//!   а не `process.on("uncaughtException")`. Поэтому `install` ставит хук, а
//!   `uninstall` возвращает прежний;
//! * «непойманное обещание» — это упавшая фоновая задача (обрыв чата, таймаут
//!   запроса). Такое падение не должно ронять прямой эфир, поэтому оно пишется в
//!   журнал громко, но процесс не завершает; строгий режим для отладки —
//!   `OSE_STRICT_REJECTIONS=1`;
//! * `errorText` из JS не нужен: ошибка приходит текстом, а превратить её в текст
//!   — забота вызывающего. У паники это делает хук (сообщение и место).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{SecondsFormat, Utc};

/// Сколько файлов-отчётов держим: они нужны для свежего разбора, а не как архив.
pub const MAX_CRASH_REPORTS: usize = 20;

/// Первым подряд отчётам о непойманных обещаниях — верим, дальше не чаще раза
/// в минуту: шторм отвалившегося сервиса не должен залить диск.
pub const MAX_REJECTION_REPORTS: u64 = 5;
pub const REJECTION_REPORT_MIN_INTERVAL_MS: i64 = 60_000;

/// Два падения в одну миллисекунду должны дать два разных имени отчёта.
static CRASH_REPORT_SEQ: AtomicU64 = AtomicU64::new(0);

/// Что показать в диалоге о фатальной ошибке.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FatalReport {
    pub app_name: String,
    /// `uncaught` (паника) или `unhandledRejection` (упавшая фоновая задача).
    pub kind: &'static str,
    pub error: String,
    pub report_path: Option<PathBuf>,
}

/// Что вернул обработчик фатальной ошибки.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FatalOutcome {
    /// Процесс завершается (или уже завершился).
    pub stopped: bool,
    /// Повторное падение во время обработки: счётчик не растёт.
    pub repeated: bool,
    pub report_path: Option<PathBuf>,
}

/// Что вернул обработчик упавшей фоновой задачи.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskFailureOutcome {
    /// Строгий режим сделал отказ фатальным.
    pub fatal: bool,
    /// Отчёт написан (в шторме — не для каждого отказа).
    pub report_path: Option<PathBuf>,
}

/// Сброс состояния на диск перед выходом.
pub type FlushFn = dyn Fn() + Send + Sync;
/// Показ диалога о фатальной ошибке.
pub type FatalFn = dyn Fn(&FatalReport) + Send + Sync;
/// Завершение процесса: по умолчанию — `std::process::exit`.
pub type ExitFn = dyn Fn(i32) + Send + Sync;
/// Куда пишет сообщения сам обработчик падений.
pub type LogFn = dyn Fn(&str) + Send + Sync;
/// Прежний хук паники — чтобы `uninstall` вернул всё как было.
type PanicHook = dyn Fn(&std::panic::PanicHookInfo<'_>) + Send + Sync + 'static;

/// Настройки обработчика. Всё, что в JS бралось извне (каталог логов, сброс
/// состояния, диалог, `exit`, флаги окружения), здесь передаётся явно —
/// иначе это не проверить тестами.
#[derive(Clone)]
pub struct CrashGuardOptions {
    pub app_name: String,
    pub version: String,
    /// Каталог отчётов; `None` — отчёты не пишем.
    pub logs_dir: Option<PathBuf>,
    pub flush: Option<Arc<FlushFn>>,
    pub on_fatal: Option<Arc<FatalFn>>,
    pub exit: Option<Arc<ExitFn>>,
    pub log: Option<Arc<LogFn>>,
    /// `OSE_KEEP_RUNNING_ON_UNCAUGHT=1`: логировать панику и жить дальше.
    pub keep_running: bool,
    /// `OSE_STRICT_REJECTIONS=1`: упавшая задача = баг, процесс завершается.
    pub strict_rejections: bool,
}

impl Default for CrashGuardOptions {
    fn default() -> Self {
        Self {
            app_name: "Open Stream Environment".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            logs_dir: None,
            flush: None,
            on_fatal: None,
            exit: None,
            log: None,
            keep_running: false,
            strict_rejections: false,
        }
    }
}

impl CrashGuardOptions {
    /// Настройки по умолчанию с флагами из окружения — как в JS-версии.
    pub fn from_env() -> Self {
        Self {
            keep_running: env_flag("OSE_KEEP_RUNNING_ON_UNCAUGHT"),
            strict_rejections: env_flag("OSE_STRICT_REJECTIONS"),
            ..Self::default()
        }
    }
}

#[derive(Default)]
struct State {
    fatal: u64,
    rejections: u64,
    /// Идёт обработка падения: повторное падение только выходит.
    stopped: bool,
    last_report_path: Option<PathBuf>,
    last_rejection_report_at: i64,
}

/// Обработчик падений.
pub struct CrashGuard {
    options: CrashGuardOptions,
    state: Mutex<State>,
    /// Прежний хук паники — чтобы `uninstall_panic_hook` вернул всё как было.
    previous_hook: Mutex<Option<Box<PanicHook>>>,
}

impl CrashGuard {
    pub fn new(options: CrashGuardOptions) -> Self {
        Self {
            options,
            state: Mutex::new(State::default()),
            previous_hook: Mutex::new(None),
        }
    }

    pub fn app_name(&self) -> &str {
        &self.options.app_name
    }

    /// Счётчики: падений и упавших фоновых задач.
    pub fn counts(&self) -> (u64, u64) {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        (state.fatal, state.rejections)
    }

    /// Путь последнего отчёта.
    pub fn last_report_path(&self) -> Option<PathBuf> {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .last_report_path
            .clone()
    }

    /// Фатальная ошибка: отчёт, сброс состояния, диалог, выход.
    pub fn handle_fatal(&self, error: &str) -> FatalOutcome {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());

        // Падение во время обработки падения: дальше только аварийный выход,
        // иначе получим рекурсию из обработчиков.
        if state.stopped {
            drop(state);
            self.log("[crash-guard] повторная ошибка во время обработки — аварийный выход");
            self.exit(1);
            return FatalOutcome {
                stopped: true,
                repeated: true,
                report_path: None,
            };
        }

        state.stopped = true;
        state.fatal += 1;
        drop(state);

        let report_path = self.report("uncaught", error);
        self.safe_flush();

        if self.options.keep_running {
            self.log("[crash-guard] OSE_KEEP_RUNNING_ON_UNCAUGHT=1 — процесс продолжает работу");
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.stopped = false;
            return FatalOutcome {
                stopped: false,
                repeated: false,
                report_path,
            };
        }

        self.show_dialog("uncaught", error, report_path.as_deref());
        self.exit(1);
        FatalOutcome {
            stopped: true,
            repeated: false,
            report_path,
        }
    }

    /// Упавшая фоновая задача: громко в журнал, отчёт — по бюджету, но не выход.
    pub fn handle_task_failure(&self, error: &str) -> TaskFailureOutcome {
        let (rejections, detailed) = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.rejections += 1;
            let now = now_ms();
            let due_by_time =
                now - state.last_rejection_report_at >= REJECTION_REPORT_MIN_INTERVAL_MS;
            let detailed = state.rejections <= MAX_REJECTION_REPORTS || due_by_time;
            if detailed {
                state.last_rejection_report_at = now;
            }
            (state.rejections, detailed)
        };

        let report_path = if detailed {
            self.report("unhandledRejection", error)
        } else {
            None
        };

        // Строгий режим — для тестов и отладки: упавшая задача = баг.
        if self.options.strict_rejections {
            self.log("[crash-guard] OSE_STRICT_REJECTIONS=1 — завершаем процесс");
            self.safe_flush();
            self.show_dialog("unhandledRejection", error, report_path.as_deref());
            self.exit(1);
            return TaskFailureOutcome {
                fatal: true,
                report_path,
            };
        }

        if detailed {
            self.log(
                "[crash-guard] непойманное обещание проигнорировано (процесс продолжает работу; \
                 подробности в отчёте и в логе)",
            );
        } else {
            let first_line = error.lines().next().unwrap_or_default();
            self.log(&format!(
                "[crash-guard] непойманных обещаний уже {rejections} — отчёт для каждого не пишем, \
                 чтобы не залить диск; последний: {first_line}"
            ));
        }

        TaskFailureOutcome {
            fatal: false,
            report_path,
        }
    }

    /// Поставить хук паники (аналог `install()` в JS).
    pub fn install_panic_hook(self: &Arc<Self>) {
        let guard = Arc::clone(self);
        let hook = std::panic::take_hook();
        {
            let mut previous = self
                .previous_hook
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if previous.is_none() {
                *previous = Some(hook);
            }
        }

        std::panic::set_hook(Box::new(move |info| {
            guard.handle_fatal(&panic_text(info));
        }));
    }

    /// Вернуть прежний хук (аналог `uninstall()`).
    pub fn uninstall_panic_hook(&self) {
        let mut previous = self
            .previous_hook
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(hook) = previous.take() {
            std::panic::set_hook(hook);
        }
    }

    fn report(&self, kind: &'static str, error: &str) -> Option<PathBuf> {
        let path = write_crash_report(
            self.options.logs_dir.as_deref(),
            kind,
            error,
            &CrashReportInfo {
                app_name: &self.options.app_name,
                version: &self.options.version,
            },
        );
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.last_report_path = path.clone();
        drop(state);

        let where_ = match &path {
            Some(path) => format!(", отчёт: {}", path.display()),
            None => String::new(),
        };
        self.log(&format!("[crash-guard] {kind}: {error}{where_}"));
        path
    }

    /// Сброс состояния перед выходом: сбой сброса не должен мешать отчёту и выходу.
    fn safe_flush(&self) {
        let Some(flush) = &self.options.flush else {
            return;
        };
        if let Err(error) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| flush())) {
            let text = match error.downcast_ref::<&str>() {
                Some(text) => (*text).to_string(),
                None => match error.downcast_ref::<String>() {
                    Some(text) => text.clone(),
                    None => "ошибка без описания".to_string(),
                },
            };
            self.log(&format!(
                "[crash-guard] не удалось сбросить состояние на диск: {text}"
            ));
        }
    }

    fn show_dialog(&self, kind: &'static str, error: &str, report_path: Option<&Path>) {
        let Some(on_fatal) = &self.options.on_fatal else {
            return;
        };
        let report = FatalReport {
            app_name: self.options.app_name.clone(),
            kind,
            error: error.to_string(),
            report_path: report_path.map(Path::to_path_buf),
        };
        if let Err(panic) =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_fatal(&report)))
        {
            let text = match panic.downcast_ref::<&str>() {
                Some(text) => (*text).to_string(),
                None => "ошибка без описания".to_string(),
            };
            self.log(&format!(
                "[crash-guard] диалог об ошибке не показан: {text}"
            ));
        }
    }

    fn exit(&self, code: i32) {
        match &self.options.exit {
            Some(exit) => exit(code),
            None => std::process::exit(code),
        }
    }

    fn log(&self, message: &str) {
        match &self.options.log {
            Some(log) => log(message),
            None => eprintln!("{message}"),
        }
    }
}

/// Реквизиты приложения для шапки отчёта.
pub struct CrashReportInfo<'a> {
    pub app_name: &'a str,
    pub version: &'a str,
}

/// Написать отчёт о падении; `None` — каталога нет или записать не удалось.
///
/// Своя запись, а не через журнал: обработчик должен работать и до того, как
/// поднят сервер и включено файловое логирование.
pub fn write_crash_report(
    dir: Option<&Path>,
    kind: &str,
    error: &str,
    info: &CrashReportInfo<'_>,
) -> Option<PathBuf> {
    let dir = dir?;
    if dir.as_os_str().is_empty() {
        return None;
    }

    if fs::create_dir_all(dir).is_err() {
        return None;
    }

    let seq = CRASH_REPORT_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let tag = Utc::now()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
        .replace([':', '.'], "-");
    let file = dir.join(format!("crash-{tag}-{seq}-{kind}.log"));

    let application = format!("{} {}", info.app_name, info.version);
    let memory = match memory_rss_mb() {
        Some(mb) => format!("rss {mb} MB"),
        // Честное «нет данных» лучше выдуманного нуля.
        None => "нет данных".to_string(),
    };
    let lines = [
        format!(
            "Время:      {}",
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
        ),
        format!("Тип:        {kind}"),
        format!("Приложение: {}", application.trim()),
        format!(
            "Платформа:  {} {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
        format!("Rust:       {}", env!("CARGO_PKG_RUST_VERSION")),
        format!("Память:     {memory}"),
        String::new(),
        "--- ошибка ---".to_string(),
        error.to_string(),
        String::new(),
    ];

    fs::write(&file, lines.join("\n")).ok()?;
    prune_crash_reports(dir, MAX_CRASH_REPORTS);
    Some(file)
}

/// Оставить только свежие отчёты о падениях.
pub fn prune_crash_reports(dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    let mut reports: Vec<(PathBuf, std::time::SystemTime)> = entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with("crash-") && name.ends_with(".log")
        })
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((entry.path(), modified))
        })
        .collect();

    // Свежие вперёд; при равном времени порядок не важен — важно лишь, что
    // лишние уходят.
    reports.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
    for (path, _) in reports.into_iter().skip(keep) {
        let _ = fs::remove_file(path);
    }
}

/// Память процесса в мегабайтах; `None` — для этой платформы не знаем.
pub fn memory_rss_mb() -> Option<u64> {
    rss_bytes().map(|bytes| (bytes as f64 / 1_048_576.0).round() as u64)
}

#[cfg(unix)]
fn rss_bytes() -> Option<u64> {
    // Linux отдаёт размер резидента в страницах; на macOS такого файла нет.
    let text = fs::read_to_string("/proc/self/statm").ok()?;
    let pages: u64 = text.split_whitespace().nth(1)?.parse().ok()?;
    let page_size = 4096;
    Some(pages * page_size)
}

#[cfg(windows)]
fn rss_bytes() -> Option<u64> {
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size) };
    if ok == 0 {
        return None;
    }
    Some(counters.WorkingSetSize as u64)
}

#[cfg(not(any(unix, windows)))]
fn rss_bytes() -> Option<u64> {
    None
}

/// Текст паники: сообщение и место — то, что в JS давал `error.stack`.
fn panic_text(info: &std::panic::PanicHookInfo<'_>) -> String {
    let message = match info.payload().downcast_ref::<&str>() {
        Some(text) => (*text).to_string(),
        None => match info.payload().downcast_ref::<String>() {
            Some(text) => text.clone(),
            None => "паника без описания".to_string(),
        },
    };
    match info.location() {
        Some(location) => format!(
            "{message}\nв {}:{}:{}",
            location.file(),
            location.line(),
            location.column()
        ),
        None => message,
    }
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| value == "1")
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("ose-crash-{}-{label}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            Self(dir)
        }

        fn reports(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.0)
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .filter(|name| name.starts_with("crash-") && name.ends_with(".log"))
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            names
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    /// Что запомнили заглушки: сколько было сбросов, выходов и диалогов.
    #[derive(Default)]
    struct Calls {
        flush: AtomicU64,
        exit_codes: Mutex<Vec<i32>>,
        fatal: Mutex<Vec<FatalReport>>,
        messages: Mutex<Vec<String>>,
    }

    impl Calls {
        fn flushes(&self) -> u64 {
            self.flush.load(Ordering::SeqCst)
        }

        fn exits(&self) -> Vec<i32> {
            self.exit_codes.lock().unwrap().clone()
        }

        fn fatals(&self) -> Vec<FatalReport> {
            self.fatal.lock().unwrap().clone()
        }

        fn text(&self) -> String {
            self.messages.lock().unwrap().join("\n")
        }
    }

    fn options(dir: Option<&Path>, calls: &Arc<Calls>) -> CrashGuardOptions {
        let flush_calls = Arc::clone(calls);
        let exit_calls = Arc::clone(calls);
        let fatal_calls = Arc::clone(calls);
        let log_calls = Arc::clone(calls);
        CrashGuardOptions {
            logs_dir: dir.map(Path::to_path_buf),
            flush: Some(Arc::new(move || {
                flush_calls.flush.fetch_add(1, Ordering::SeqCst);
            })),
            exit: Some(Arc::new(move |code| {
                exit_calls.exit_codes.lock().unwrap().push(code);
            })),
            on_fatal: Some(Arc::new(move |report: &FatalReport| {
                fatal_calls.fatal.lock().unwrap().push(report.clone());
            })),
            log: Some(Arc::new(move |message: &str| {
                log_calls.messages.lock().unwrap().push(message.to_string());
            })),
            ..CrashGuardOptions::default()
        }
    }

    #[test]
    fn uncaught_error_writes_report_flushes_shows_dialog_and_exits() {
        let dir = TempDir::new("uncaught");
        let calls = Arc::new(Calls::default());
        let guard = CrashGuard::new(options(Some(&dir.0), &calls));

        let outcome = guard.handle_fatal("boom");

        assert!(outcome.stopped);
        assert_eq!(calls.flushes(), 1);
        let fatals = calls.fatals();
        assert_eq!(fatals.len(), 1);
        assert_eq!(fatals[0].kind, "uncaught");
        assert_eq!(calls.exits(), vec![1]);
        assert_eq!(dir.reports().len(), 1);
        assert_eq!(guard.counts().0, 1);

        let report = fs::read_to_string(dir.0.join(&dir.reports()[0])).unwrap();
        assert!(report.contains("boom"), "{report}");
        assert!(report.contains(env!("CARGO_PKG_RUST_VERSION")), "{report}");
        assert!(report.contains("--- ошибка ---"), "{report}");
        assert!(report.contains(std::env::consts::OS), "{report}");
    }

    #[test]
    fn failed_flush_does_not_prevent_report_and_exit() {
        let dir = TempDir::new("flush-failed");
        let calls = Arc::new(Calls::default());
        let log_calls = Arc::clone(&calls);
        let mut settings = options(Some(&dir.0), &calls);
        settings.flush = Some(Arc::new(|| panic!("диск отвалился")));
        settings.log = Some(Arc::new(move |message: &str| {
            log_calls.messages.lock().unwrap().push(message.to_string());
        }));
        let guard = CrashGuard::new(settings);

        guard.handle_fatal("boom");

        assert_eq!(calls.exits(), vec![1]);
        assert_eq!(dir.reports().len(), 1);
        assert!(calls.text().contains("диск отвалился"), "{}", calls.text());
    }

    #[test]
    fn second_failure_during_handling_exits_without_recursion() {
        let calls = Arc::new(Calls::default());
        let mut settings = options(None, &calls);
        settings.on_fatal = Some(Arc::new(|_report| panic!("диалог не открылся")));
        let guard = CrashGuard::new(settings);

        guard.handle_fatal("первое");
        assert_eq!(calls.exits(), vec![1]);

        let second = guard.handle_fatal("второе");
        assert!(second.repeated);
        assert_eq!(calls.exits(), vec![1, 1]);
        // Второй раз уже не считаем как новый отказ.
        assert_eq!(guard.counts().0, 1);
    }

    #[test]
    fn keep_running_flag_leaves_the_process_alive() {
        let dir = TempDir::new("keep-running");
        let calls = Arc::new(Calls::default());
        let mut settings = options(Some(&dir.0), &calls);
        settings.keep_running = true;
        let guard = CrashGuard::new(settings);

        let outcome = guard.handle_fatal("терпимо");

        assert!(!outcome.stopped);
        assert!(calls.exits().is_empty());
        assert!(calls.fatals().is_empty());
        assert_eq!(calls.flushes(), 1);
        assert_eq!(dir.reports().len(), 1);
        // Флаг снят: следующее падение обрабатывается как первое.
        assert!(!outcome.repeated);
    }

    #[test]
    fn task_failure_is_logged_but_does_not_stop_the_process() {
        let dir = TempDir::new("task-failure");
        let calls = Arc::new(Calls::default());
        let guard = CrashGuard::new(options(Some(&dir.0), &calls));

        let outcome = guard.handle_task_failure("сеть отвалилась");

        assert!(!outcome.fatal);
        assert!(calls.exits().is_empty());
        assert!(calls.fatals().is_empty());
        assert_eq!(guard.counts().1, 1);
        assert_eq!(dir.reports().len(), 1);
        assert!(
            calls.text().contains("непойманное обещание"),
            "{}",
            calls.text()
        );
    }

    #[test]
    fn strict_mode_makes_a_task_failure_fatal() {
        let calls = Arc::new(Calls::default());
        let mut settings = options(None, &calls);
        settings.strict_rejections = true;
        let guard = CrashGuard::new(settings);

        let outcome = guard.handle_task_failure("баг");

        assert!(outcome.fatal);
        assert_eq!(calls.flushes(), 1);
        assert_eq!(calls.exits(), vec![1]);
        assert_eq!(calls.fatals()[0].kind, "unhandledRejection");
    }

    #[test]
    fn storm_of_task_failures_writes_only_a_few_reports() {
        let dir = TempDir::new("storm");
        let calls = Arc::new(Calls::default());
        let guard = CrashGuard::new(options(Some(&dir.0), &calls));

        for index in 0..30 {
            guard.handle_task_failure(&format!("отвал сети {index}"));
        }

        assert_eq!(guard.counts().1, 30);
        // Счётчик растёт на всё, а файлов — только первые несколько.
        assert!(!dir.reports().is_empty());
        assert!(
            dir.reports().len() <= MAX_REJECTION_REPORTS as usize,
            "{:?}",
            dir.reports()
        );
    }

    #[test]
    fn panic_hook_is_installed_and_removed() {
        let dir = TempDir::new("hook");
        let calls = Arc::new(Calls::default());
        let guard = Arc::new(CrashGuard::new(options(Some(&dir.0), &calls)));

        guard.install_panic_hook();
        // Паника внутри теста: хук пишет отчёт, сбрасывает состояние и «выходит».
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            panic!("из процесса");
        }));
        guard.uninstall_panic_hook();

        assert!(panicked.is_err());
        assert!(guard.counts().0 >= 1);
        assert!(calls.exits().contains(&1));
        assert!(!dir.reports().is_empty());

        // Хук глобальный: падай в этот момент другой тест, отчётов было бы больше
        // одного. Поэтому свой отчёт ищем по содержанию, а не по счёту.
        let ours = dir
            .reports()
            .into_iter()
            .map(|name| fs::read_to_string(dir.0.join(name)).unwrap_or_default())
            .find(|text| text.contains("из процесса"))
            .expect("отчёт с текстом паники");
        // Место паники — то, чем в JS был `error.stack`.
        assert!(ours.contains("crash_guard.rs"), "{ours}");
        assert!(ours.contains("--- ошибка ---"), "{ours}");
    }

    #[test]
    fn missing_directory_is_not_a_reason_to_fail() {
        assert!(write_crash_report(
            None,
            "uncaught",
            "x",
            &CrashReportInfo {
                app_name: "OSE",
                version: "1"
            }
        )
        .is_none());
        assert!(write_crash_report(
            Some(Path::new("")),
            "uncaught",
            "x",
            &CrashReportInfo {
                app_name: "OSE",
                version: "1"
            }
        )
        .is_none());
    }

    #[test]
    fn old_reports_do_not_pile_up() {
        let dir = TempDir::new("prune");
        let info = CrashReportInfo {
            app_name: "OSE",
            version: "1",
        };
        for index in 0..25 {
            write_crash_report(Some(&dir.0), "uncaught", &format!("ошибка {index}"), &info);
        }

        assert_eq!(dir.reports().len(), MAX_CRASH_REPORTS);
    }

    #[test]
    fn environment_flags_are_read_as_in_the_script() {
        // Значение по умолчанию — «нет»; проверяем сам разбор флага.
        assert!(!env_flag("OSE_DEFINITELY_NOT_SET_12345"));
        let settings = CrashGuardOptions::from_env();
        assert_eq!(settings.app_name, "Open Stream Environment");
        assert_eq!(settings.version, env!("CARGO_PKG_VERSION"));
    }
}
