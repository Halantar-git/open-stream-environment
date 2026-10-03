//! Асинхронная запись файла состояния: схлопывание частых записей, повторы
//! переименования, резервные копии по времени и учёт телеметрии.
//!
//! Порт `AsyncAtomicStore` из `server/atomic-write.js`. Зачем асинхронно: панель
//! меняет состояние десятками мелких правок, и ждать диск на каждой — значит
//! подвешивать интерфейс. Поэтому запись уходит в отдельный поток, а частые
//! снимки **схлопываются**: пока предыдущий пишется, следующий просто заменяет
//! его в очереди — на диск уходит последнее состояние, а не вся очередь.
//!
//! Переименование повторяется: на Windows антивирус или индексатор держат файл
//! открытым, и `rename` падает с «занято» — это лечится паузой и повтором.
//!
//! Резервная копия берётся **до** подмены файла: в слот должен попасть прежний,
//! заведомо целый снимок, а не следствие текущей записи.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;

use super::atomic::{self, DEFAULT_BACKUP_MAX_BYTES, DEFAULT_BACKUP_SLOTS};

/// Как часто кладём резервную копию (не на каждую запись: копия — лишний ввод-вывод).
pub const DEFAULT_BACKUP_EVERY: Duration = Duration::from_secs(5 * 60);

/// Сколько раз пробуем переименовать и с какой паузой (пауза растёт с попыткой).
const DEFAULT_RENAME_RETRIES: u32 = 4;
const DEFAULT_RENAME_RETRY_DELAY: Duration = Duration::from_millis(30);

/// Функция переименования — подменяется в тестах, чтобы удержать запись в полёте.
pub type RenameFn = dyn Fn(&Path, &Path) -> io::Result<()> + Send + Sync + 'static;

/// Куда жаловаться на ошибку записи.
pub type LoggerFn = dyn Fn(&str) + Send + Sync + 'static;

/// Настройки стора.
pub struct StoreOptions {
    /// Сбрасывать данные на носитель до переименования (`fsync`).
    pub fsync: bool,
    /// Своё переименование — для тестов.
    pub rename: Option<Arc<RenameFn>>,
    pub rename_retries: u32,
    pub rename_retry_delay: Duration,
    /// Сколько резервных копий держим; 0 — не бэкапить вовсе.
    pub backup_slots: usize,
    pub backup_every: Duration,
    pub backup_max_bytes: u64,
    /// Метка для отчёта (по умолчанию — имя файла).
    pub label: Option<String>,
    /// Куда пожаловаться на ошибку записи.
    pub logger: Option<Arc<LoggerFn>>,
}

impl Default for StoreOptions {
    fn default() -> Self {
        Self {
            fsync: false,
            rename: None,
            rename_retries: DEFAULT_RENAME_RETRIES,
            rename_retry_delay: DEFAULT_RENAME_RETRY_DELAY,
            backup_slots: DEFAULT_BACKUP_SLOTS,
            backup_every: DEFAULT_BACKUP_EVERY,
            backup_max_bytes: DEFAULT_BACKUP_MAX_BYTES,
            label: None,
            logger: None,
        }
    }
}

/// Счётчики записи: за текущий интервал отчёта и за всё время.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Stats {
    pub writes: u64,
    pub bytes: u64,
    pub coalesced: u64,
    pub failed: u64,
    pub backups: u64,
    pub total_ms: f64,
    pub max_ms: f64,
}

impl Stats {
    fn record_write(&mut self, bytes: u64, ms: f64) {
        self.writes += 1;
        self.bytes += bytes;
        self.total_ms += ms;
        if ms > self.max_ms {
            self.max_ms = ms;
        }
    }
}

/// Снимок счётчиков.
#[derive(Debug, Clone)]
pub struct StatsSnapshot {
    pub label: String,
    pub window: Stats,
    pub total: Stats,
}

#[derive(Default)]
struct State {
    pending: Option<Value>,
    last_data: Option<Value>,
    last_good_json: Option<String>,
    last_backup_at: Option<SystemTime>,
    seq: u64,
    last_error: Option<String>,
    /// Очередь не пуста или запись в полёте — на этом стоит `flush`.
    in_flight: bool,
    window: Stats,
    total: Stats,
}

struct Shared {
    file: PathBuf,
    options: StoreOptions,
    state: Mutex<State>,
    work: Condvar,
    done: Condvar,
    stopping: AtomicBool,
}

/// Файл состояния, который пишется в отдельном потоке.
pub struct AtomicStore {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}

impl AtomicStore {
    /// Открыть стор: убрать осиротевшие временные файлы и запустить поток записи.
    pub fn open(file: PathBuf, options: StoreOptions) -> Self {
        // Остатки прошлых запусков (убили ровно между записью и переименованием)
        // убираем сразу, а не копим.
        atomic::sweep_stale_temp_files(&file, atomic::TEMP_MAX_AGE);

        let shared = Arc::new(Shared {
            file,
            options,
            state: Mutex::new(State::default()),
            work: Condvar::new(),
            done: Condvar::new(),
            stopping: AtomicBool::new(false),
        });

        let worker = {
            let shared = Arc::clone(&shared);
            thread::Builder::new()
                .name("ose-atomic-write".to_string())
                .spawn(move || drain(shared))
                .expect("поток записи должен создаваться")
        };

        Self {
            shared,
            worker: Some(worker),
        }
    }

    /// Поставить снимок в очередь: побеждает последний.
    ///
    /// Не блокирует: если предыдущий снимок ещё не ушёл на диск, он будет схлопнут
    /// этим, и в счётчики попадёт «схлопнуто».
    pub fn write(&self, value: Value) {
        {
            let mut state = self.shared.state.lock().unwrap();
            state.last_data = Some(value.clone());
            if state.pending.is_some() {
                state.window.coalesced += 1;
                state.total.coalesced += 1;
            }
            state.pending = Some(value);
            state.in_flight = true;
        }
        // Будим всегда, а не только когда поток спит: проверка очереди идёт под
        // тем же замком, поэтому «потерянного пробуждения» здесь быть не может.
        self.shared.work.notify_one();
    }

    /// Дождаться, пока всё поставленное окажется на диске.
    pub fn flush(&self) {
        let mut state = self.shared.state.lock().unwrap();
        while state.in_flight {
            state = self.shared.done.wait(state).unwrap();
        }
    }

    /// Синхронно записать последний снимок — для выхода, когда ждать нельзя.
    ///
    /// Best-effort: ошибку отдаём наружу, но выход из приложения не роняем —
    /// каталог мог быть уже убран.
    pub fn flush_sync(&self) -> bool {
        let data = {
            let state = self.shared.state.lock().unwrap();
            state.last_data.clone()
        };
        let Some(data) = data else {
            return false;
        };

        let json = to_json(&data);
        let started = Instant::now();
        match atomic::write_file_sync(&self.shared.file, json.as_bytes()) {
            Ok(()) => {
                let ms = started.elapsed().as_secs_f64() * 1000.0;
                let mut state = self.shared.state.lock().unwrap();
                state.window.record_write(json.len() as u64, ms);
                state.total.record_write(json.len() as u64, ms);
                true
            }
            Err(error) => {
                let mut state = self.shared.state.lock().unwrap();
                state.window.failed += 1;
                state.total.failed += 1;
                state.last_error = Some(error.to_string());
                drop(state);
                self.log(&error.to_string());
                false
            }
        }
    }

    /// Последняя ошибка записи; `None` — всё писалось успешно.
    pub fn last_error(&self) -> Option<String> {
        self.shared.state.lock().unwrap().last_error.clone()
    }

    /// Снимок счётчиков.
    pub fn stats(&self) -> StatsSnapshot {
        let state = self.shared.state.lock().unwrap();
        StatsSnapshot {
            label: self.label(),
            window: state.window,
            total: state.total,
        }
    }

    /// Одна строка отчёта за интервал; `None` — за интервал ничего не было.
    ///
    /// Молчание в простое намеренное: журнал не должен шуметь каждый интервал.
    /// Интервал задаёт вызывающий (в Electron-версии — `setInterval`).
    pub fn flush_report(&self) -> Option<String> {
        let mut state = self.shared.state.lock().unwrap();
        let w = state.window;
        if w.writes == 0 && w.coalesced == 0 && w.failed == 0 {
            return None;
        }

        let kb = |bytes: u64| format!("{} KB", bytes as f64 / 1024.0);
        let avg = if w.writes > 0 {
            format!("{:.2}", w.total_ms / w.writes as f64)
        } else {
            "0".to_string()
        };
        let t = state.total;
        let total_avg = t.total_ms / t.writes.max(1) as f64;
        let backups = if w.backups > 0 {
            format!(", бэкапов {}", w.backups)
        } else {
            String::new()
        };

        let line = format!(
            "[atomic-write] {}: записей {} ({}), схлопнуто {}, ошибок {}, avg {} ms, max {:.1} ms\
             {} | всего: {} записей, {}, avg {:.2} ms",
            self.label(),
            w.writes,
            kb(w.bytes),
            w.coalesced,
            w.failed,
            avg,
            w.max_ms,
            backups,
            t.writes,
            kb(t.bytes),
            total_avg
        );

        state.window = Stats::default();
        Some(line)
    }

    /// Остановить поток записи (остаток очереди дописывается).
    pub fn stop(&mut self) {
        let Some(worker) = self.worker.take() else {
            return;
        };
        self.shared.stopping.store(true, Ordering::SeqCst);
        self.shared.work.notify_all();
        let _ = worker.join();
    }

    fn label(&self) -> String {
        self.shared.options.label.clone().unwrap_or_else(|| {
            self.shared
                .file
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
    }

    fn log(&self, message: &str) {
        if let Some(logger) = &self.shared.options.logger {
            logger(message);
        }
    }
}

impl Drop for AtomicStore {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Цикл потока записи: ждёт работы и опустошает очередь.
fn drain(shared: Arc<Shared>) {
    loop {
        let mut state = shared.state.lock().unwrap();
        while state.pending.is_none() && !shared.stopping.load(Ordering::SeqCst) {
            state = shared.work.wait(state).unwrap();
        }

        if state.pending.is_none() {
            // Остановка: очередь пуста, писать нечего.
            state.in_flight = false;
            shared.done.notify_all();
            return;
        }

        // Внутренний цикл — «сброс очереди»: пока есть что писать, пишем.
        loop {
            let Some(snapshot) = state.pending.take() else {
                break;
            };
            // Диск занят не под замком: иначе `write()` из панели ждал бы его.
            drop(state);

            let started = Instant::now();
            let result = write_snapshot(&shared, &snapshot);
            let ms = started.elapsed().as_secs_f64() * 1000.0;

            state = shared.state.lock().unwrap();
            match result {
                Ok(outcome) => {
                    state.last_error = None;
                    state.window.record_write(outcome.bytes, ms);
                    state.total.record_write(outcome.bytes, ms);
                    if outcome.backup {
                        state.window.backups += 1;
                        state.total.backups += 1;
                    }
                }
                Err(error) => {
                    state.window.failed += 1;
                    state.total.failed += 1;
                    state.last_error = Some(error.to_string());
                    let message = error.to_string();
                    drop(state);
                    if let Some(logger) = &shared.options.logger {
                        logger(&message);
                    }
                    state = shared.state.lock().unwrap();
                }
            }
        }

        state.in_flight = false;
        shared.done.notify_all();
    }
}

struct WriteOutcome {
    bytes: u64,
    backup: bool,
}

/// Записать один снимок: временный файл, `fsync` по желанию, переименование.
fn write_snapshot(shared: &Shared, snapshot: &Value) -> io::Result<WriteOutcome> {
    let json = to_json(snapshot);
    let file = &shared.file;

    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }

    // Источник бэкапа — до подмены файла.
    let backup_source = if backup_due(shared) {
        backup_source(shared)
    } else {
        None
    };

    let seq = {
        let mut state = shared.state.lock().unwrap();
        state.seq += 1;
        state.seq
    };
    let tmp = file.with_file_name(format!(
        ".{}.{}.{}.tmp",
        file.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        std::process::id(),
        seq
    ));

    let written = (|| -> io::Result<()> {
        let mut handle = fs::File::create(&tmp)?;
        handle.write_all(json.as_bytes())?;
        if shared.options.fsync {
            handle.sync_all()?;
        }
        handle.flush()?;
        drop(handle);
        rename_with_retry(shared, &tmp, file)
    })();

    if let Err(error) = written {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }

    {
        let mut state = shared.state.lock().unwrap();
        state.last_good_json = Some(json.clone());
    }

    let mut backup = false;
    if let Some(source) = backup_source {
        backup = atomic::rotate_backups(
            file,
            shared.options.backup_slots,
            Some(&source),
            shared.options.backup_max_bytes,
        );
        if backup {
            let mut state = shared.state.lock().unwrap();
            state.last_backup_at = Some(SystemTime::now());
        }
    }

    Ok(WriteOutcome {
        bytes: json.len() as u64,
        backup,
    })
}

/// Пора ли класть резервную копию.
fn backup_due(shared: &Shared) -> bool {
    if shared.options.backup_slots == 0 {
        return false;
    }
    let state = shared.state.lock().unwrap();
    match state.last_backup_at {
        // Копий ещё не делали — самая первая запись как раз и повод.
        None => true,
        Some(at) => at
            .elapsed()
            .map(|elapsed| elapsed >= shared.options.backup_every)
            .unwrap_or(true),
    }
}

/// Что положить в копию: последний удачный снимок из памяти, а если его нет
/// (первая запись в этом процессе) — то, что сейчас лежит на диске.
fn backup_source(shared: &Shared) -> Option<String> {
    if let Some(json) = shared.state.lock().unwrap().last_good_json.clone() {
        return Some(json);
    }
    fs::read_to_string(&shared.file).ok()
}

/// Переименовать, повторяя при «файл занят».
///
/// На Windows так выглядит работа антивируса или индексатора: файл открыт на
/// мгновение, и переименование падает. Это не ошибка данных — помогает пауза.
fn rename_with_retry(shared: &Shared, from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt: u32 = 0;
    loop {
        let result = match &shared.options.rename {
            Some(rename) => rename(from, to),
            None => fs::rename(from, to),
        };

        match result {
            Ok(()) => return Ok(()),
            Err(error) => {
                if !retryable(&error) || attempt >= shared.options.rename_retries {
                    return Err(error);
                }
                attempt += 1;
                thread::sleep(shared.options.rename_retry_delay * attempt);
            }
        }
    }
}

/// Стоит ли повторять: «нет доступа» и «занято» на обеих платформах.
///
/// Числа — коды системных ошибок: 1/13 (`EPERM`/`EACCES`), 16 (`EBUSY`) на
/// POSIX; 5/32/33 (`ACCESS_DENIED`/`SHARING_VIOLATION`/`LOCK_VIOLATION`) на Windows.
fn retryable(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(16 | 32 | 33))
}

/// Снимок в JSON — с отступом в два пробела, как `JSON.stringify(data, null, 2)`.
fn to_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("ose-store-{}-{label}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            Self(dir)
        }

        fn file(&self) -> PathBuf {
            self.0.join("config.json")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    fn read_json(file: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(file).expect("файл должен читаться"))
            .expect("должен быть JSON")
    }

    #[test]
    fn writes_the_snapshot_and_keeps_key_order() {
        let dir = TempDir::new("write");
        let file = dir.file();
        let store = AtomicStore::open(file.clone(), StoreOptions::default());

        // Порядок ключей должен остаться таким, каким его задали: с сортировкой
        // (`preserve_order` выключен) файл разошёлся бы с Electron-версией.
        store.write(json!({ "port": 8710, "alpha": 1, "beta": 2 }));
        store.flush();

        assert_eq!(
            read_json(&file),
            json!({ "port": 8710, "alpha": 1, "beta": 2 })
        );
        let text = fs::read_to_string(&file).unwrap();
        assert!(
            text.find("\"port\"").unwrap() < text.find("\"alpha\"").unwrap(),
            "порядок ключей поехал: {text}"
        );
        assert!(
            text.starts_with("{\n  \"port\""),
            "отступ должен быть в два пробела"
        );
    }

    #[test]
    fn coalesces_snapshots_while_the_disk_is_busy() {
        let dir = TempDir::new("coalesce");
        let file = dir.file();

        // Первое переименование задерживаем: пока поток занят, очередь копится.
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        // Приёмник — под мьютексом: замыкание переименования живёт в `Arc`, и ему
        // мало `Send`, нужен ещё `Sync`.
        let release_rx = Arc::new(Mutex::new(release_rx));
        let rename: Arc<RenameFn> = {
            let calls = Arc::clone(&calls);
            let release_rx = Arc::clone(&release_rx);
            Arc::new(move |from: &Path, to: &Path| {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    let _ = entered_tx.send(());
                    let _ = release_rx.lock().unwrap().recv();
                }
                fs::rename(from, to)
            })
        };

        let store = AtomicStore::open(
            file.clone(),
            StoreOptions {
                rename: Some(rename),
                backup_slots: 0,
                ..StoreOptions::default()
            },
        );

        store.write(json!({ "step": 1 }));
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("первая запись должна дойти до переименования");

        store.write(json!({ "step": 2 }));
        store.write(json!({ "step": 3 }));
        release_tx.send(()).expect("запись должна отпуститься");
        store.flush();

        // На диск ушло последнее состояние — промежуточное схлопнуто.
        assert_eq!(read_json(&file), json!({ "step": 3 }));
        let stats = store.stats();
        assert_eq!(stats.total.writes, 2, "первый снимок и последний");
        // Схлопнулся ровно один: второй снимок застал очередь пустой (первый поток
        // уже забрал и писал), а третий — лег поверх второго. Так же считает JS.
        assert_eq!(stats.total.coalesced, 1);
        assert_eq!(stats.total.failed, 0);
    }

    #[test]
    fn flush_sync_writes_without_waiting_for_the_thread() {
        let dir = TempDir::new("flush-sync");
        let file = dir.file();
        let store = AtomicStore::open(file.clone(), StoreOptions::default());

        store.write(json!({ "mode": "exit" }));
        assert!(store.flush_sync());
        assert_eq!(read_json(&file), json!({ "mode": "exit" }));

        // Снимка не было — писать нечего.
        let empty = AtomicStore::open(dir.0.join("other.json"), StoreOptions::default());
        assert!(!empty.flush_sync());
    }

    #[test]
    fn backup_holds_the_previous_snapshot() {
        let dir = TempDir::new("backup");
        let file = dir.file();
        let store = AtomicStore::open(
            file.clone(),
            StoreOptions {
                // Копия на каждую запись: так проверка не зависит от времени.
                backup_every: Duration::ZERO,
                ..StoreOptions::default()
            },
        );

        store.write(json!({ "step": 1 }));
        store.flush();
        store.write(json!({ "step": 2 }));
        store.flush();

        // В слоте — прежний снимок, а не текущий: копия читается до подмены файла.
        let backup = atomic::backup_path(&file, 0);
        assert_eq!(read_json(&backup), json!({ "step": 1 }));
        assert_eq!(read_json(&file), json!({ "step": 2 }));
        assert!(store.stats().total.backups >= 1);
    }

    #[test]
    fn backup_is_skipped_when_slots_are_zero() {
        let dir = TempDir::new("no-backup");
        let file = dir.file();
        let store = AtomicStore::open(
            file.clone(),
            StoreOptions {
                backup_slots: 0,
                backup_every: Duration::ZERO,
                ..StoreOptions::default()
            },
        );

        store.write(json!({ "step": 1 }));
        store.flush();
        store.write(json!({ "step": 2 }));
        store.flush();

        assert!(!atomic::backup_path(&file, 0).exists());
        assert_eq!(store.stats().total.backups, 0);
    }

    #[test]
    fn rename_is_retried_while_the_file_is_busy() {
        let dir = TempDir::new("retry");
        let file = dir.file();

        // Первые две попытки падают как «файл занят» — как антивирус на Windows.
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let rename: Arc<RenameFn> = {
            let calls = Arc::clone(&calls);
            Arc::new(move |from: &Path, to: &Path| {
                if calls.fetch_add(1, Ordering::SeqCst) < 2 {
                    return Err(io::Error::from_raw_os_error(32));
                }
                fs::rename(from, to)
            })
        };

        let store = AtomicStore::open(
            file.clone(),
            StoreOptions {
                rename: Some(rename),
                rename_retry_delay: Duration::from_millis(1),
                backup_slots: 0,
                ..StoreOptions::default()
            },
        );

        store.write(json!({ "survived": true }));
        store.flush();

        assert_eq!(read_json(&file), json!({ "survived": true }));
        assert_eq!(store.stats().total.failed, 0, "повторы должны были помочь");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn report_is_silent_until_something_happens() {
        let dir = TempDir::new("report");
        let store = AtomicStore::open(dir.file(), StoreOptions::default());

        assert!(store.flush_report().is_none(), "в простое журнал молчит");

        store.write(json!({ "a": 1 }));
        store.flush();

        let line = store
            .flush_report()
            .expect("после записи строка должна быть");
        assert!(line.contains("config.json"), "{line}");
        assert!(line.contains("записей 1"), "{line}");
        assert!(store.flush_report().is_none(), "интервал сброшен");
    }

    #[test]
    fn failed_writes_are_counted_and_logged() {
        let dir = TempDir::new("failure");
        let file = dir.file();

        // Переименование не удаётся и не повторяется — запись обязана не «отравить»
        // очередь: следующая запись должна пройти.
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let rename: Arc<RenameFn> = {
            let calls = Arc::clone(&calls);
            Arc::new(move |from: &Path, to: &Path| {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Err(io::Error::from_raw_os_error(2)); // не «занято» — без повторов
                }
                fs::rename(from, to)
            })
        };
        let logged = Arc::new(Mutex::new(Vec::<String>::new()));
        let logger: Arc<LoggerFn> = {
            let logged = Arc::clone(&logged);
            Arc::new(move |message: &str| logged.lock().unwrap().push(message.to_string()))
        };

        let store = AtomicStore::open(
            file.clone(),
            StoreOptions {
                rename: Some(rename),
                backup_slots: 0,
                logger: Some(logger),
                ..StoreOptions::default()
            },
        );

        store.write(json!({ "attempt": 1 }));
        store.flush();
        store.write(json!({ "attempt": 2 }));
        store.flush();

        assert_eq!(read_json(&file), json!({ "attempt": 2 }));
        assert_eq!(store.stats().total.failed, 1);
        assert_eq!(store.stats().total.writes, 1);
        assert_eq!(logged.lock().unwrap().len(), 1);
        // Временного файла после неудачной попытки не осталось.
        assert_eq!(atomic::sweep_stale_temp_files(&file, Duration::ZERO), 0);
    }
}
