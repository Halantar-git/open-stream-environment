//! Append-only история событий (JSON Lines) с ленивым индексом.
//!
//! Порт `server/history-store.js`. На диске — одна JSON-строка на запись: каждое
//! событие дописывается в конец, а не перезаписывает весь файл. Это принципиально:
//! за стрим набегают десятки тысяч сообщений чата, и перезапись всего файла на
//! каждое событие была бы квадратичной работой.
//!
//! В памяти держим НЕ записи, а лёгкий индекс: смещение и длину строки, время,
//! признак теста, интернированные тип и sessionId, карту id→позиция. Содержимое
//! читается из файла по требованию — при выдаче страницы (`query`), по
//! `get_by_id` или в `all()`. Поэтому 20 000 событий стоят в памяти единицы
//! мегабайт вместо десятков.
//!
//! Индекс строится ЛЕНИВО: при открытии файл не читается, запоминается только его
//! размер. Первое реальное чтение («История», настройки, статистика) один раз
//! сканирует файл и заполняет метаданные. Исключение — дописывание при заданном
//! лимите: решение об уплотнении считается по числу записей, а его знает только
//! индекс, поэтому он строится на первом же событии.
//!
//! Рост ограничен: видимыми считаются последние `max_records` записей. Файл
//! уплотняется с гистерезисом (перезаписывается атомарно, temp+rename), так что
//! одна полная перезапись приходится на `max_records` дописываний.
//!
//! Устойчивость к краху: повреждённые и частичные строки при индексации
//! пропускаются — теряется максимум последняя запись.
//!
//! Отличие от JS-версии — потоки. Там запись уезжает в микротаски того же
//! event-loop, здесь — в отдельный поток, который будит `Condvar`. Поэтому
//! состояние (индекс, очередь, «pending») лежит под одним `Mutex`, а ввод-вывод
//! идёт уже без замка: иначе чтения истории вставали бы на время записи файла.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering as AtomicOrdering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::Value;

use super::atomic;

/// Сколько последних записей храним по умолчанию.
pub const DEFAULT_MAX_RECORDS: usize = 20_000;

/// Во сколько раз файл может превысить лимит, прежде чем уплотниться.
const COMPACT_FACTOR: usize = 2;

/// Пауза перед повтором после сбоя записи.
const RETRY_DELAY: Duration = Duration::from_millis(500);

/// Сколько сбоев подряд терпим, прежде чем ждать следующего события: постоянная
/// ошибка (нет прав, диск переполнен) не должна крутить запись без пользы.
const RETRY_LIMIT: u32 = 3;

/// Повторы переименования при уплотнении: на Windows файл на мгновение занимает
/// антивирус или индексатор, и `rename` падает с «занято».
const RENAME_RETRIES: u32 = 4;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(30);

/// Смещение записи, которая лежит только в памяти (ещё не на диске).
const NO_OFFSET: u64 = u64::MAX;

/// Нумерация временных файлов уплотнения внутри процесса.
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Куда жаловаться на ошибку записи.
pub type LoggerFn = dyn Fn(&str) + Send + Sync + 'static;

/// Как записать содержимое: `(файл, текст)`. Подменяется в тестах, чтобы
/// воспроизвести сбой диска.
pub type FileWriteFn = dyn Fn(&Path, &str) -> io::Result<()> + Send + Sync + 'static;

/// Настройки истории.
#[derive(Default)]
pub struct HistoryOptions {
    /// Лимит хранимых записей: `None` — умолчание, `Some(0)` — без лимита.
    pub max_records: Option<usize>,
    /// Пауза перед повтором после сбоя (в тестах её уменьшают, чтобы не ждать).
    pub retry_delay: Option<Duration>,
    pub logger: Option<Arc<LoggerFn>>,
    /// Своё дописывание строк — для тестов.
    pub append: Option<Arc<FileWriteFn>>,
    /// Своя перезапись файла — для тестов.
    pub replace: Option<Arc<FileWriteFn>>,
}

/// Что искать в истории. Поля повторяют `opts` из JS (`sessionId`, `type`,
/// `includeTest`, `search`, `since`, `limit`, `offset`); `type` в Rust —
/// ключевое слово, поэтому здесь это `kind`.
#[derive(Debug, Clone, Default)]
pub struct QueryOptions {
    pub session_id: Option<Value>,
    pub kind: Option<Value>,
    pub include_test: Option<bool>,
    pub search: Option<String>,
    /// Нижняя граница по времени; ноль и меньше — «ограничения нет».
    pub since: Option<f64>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

impl QueryOptions {
    /// Разобрать запрос, пришедший как JSON: ровно то, что делает JS-версия,
    /// передавая объект из сети прямо в `query`.
    pub fn from_json(options: &Value) -> Self {
        let number = |key: &str| options.get(key).map(|value| js_number(Some(value)));
        let truthy_text = |key: &str| match options.get(key) {
            Some(value) if js_truthy(Some(value)) => Some(js_key(value)),
            _ => None,
        };
        let limit = match number("limit") {
            Some(value) if value > 0.0 && value.is_finite() => Some(value.floor() as usize),
            _ => None,
        };
        let offset = match number("offset") {
            Some(value) if value > 0.0 && value.is_finite() => Some(value.floor() as usize),
            _ => None,
        };

        Self {
            session_id: options.get("sessionId").cloned(),
            kind: options.get("type").cloned(),
            // Скрывает тестовые только явный `false` — как `includeTest === false`.
            include_test: match options.get("includeTest") {
                Some(Value::Bool(flag)) => Some(*flag),
                _ => None,
            },
            search: truthy_text("search"),
            since: number("since"),
            limit,
            offset,
        }
    }
}

/// Страница истории: записи и общее число подходящих (до пагинации).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Page {
    pub items: Vec<Value>,
    pub total: usize,
}

/// Метаданные строки в файле: где лежит, когда случилась, что за событие.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Entry {
    off: u64,
    len: usize,
    ts: f64,
    test: bool,
    type_id: i32,
    sess_id: i32,
}

/// Запись, лежащая в памяти: ещё не ушла в файл (`pending`) или заменяет файл
/// целиком после перезаписи (`rewrite`).
struct Memory {
    /// Сквозной номер: по нему операция записи находит свою запись в памяти.
    /// В JS это делает сравнение ссылок (`Set` + `has`), в Rust — сравнение
    /// значений, а одинаковые события там не редкость.
    seq: u64,
    record: Value,
    entry: Entry,
}

/// Одна дописываемая запись с готовым текстом строки: JSON собирается один раз,
/// при постановке в очередь.
struct AppendItem {
    seq: u64,
    record: Value,
    text: String,
}

/// Операция очереди записи.
enum Op {
    Append { items: Vec<AppendItem> },
    Truncate { records: Vec<Value> },
}

/// Индекс, очередь и всё изменяемое состояние хранилища.
#[derive(Default)]
struct State {
    built: bool,
    index: Vec<Entry>,
    id_map: HashMap<String, usize>,
    type_dict: HashMap<String, i32>,
    type_list: Vec<String>,
    sess_dict: HashMap<String, i32>,
    sess_list: Vec<String>,
    /// Записи, поставленные в очередь, но ещё не подтверждённые на диске: их
    /// содержимое доступно сразу (в памяти), пока не уйдёт в файл.
    pending: Vec<Memory>,
    /// Очередь полной перезаписи (миграция, уплотнение, очистка). Пока не
    /// записана, видимым считается её содержимое плюс дописанное после.
    rewrite: Option<Vec<Memory>>,
    ops: VecDeque<Op>,
    seq: u64,
    /// Воркеру разрешено писать: очередь пополнилась или запрошен повтор.
    ready: bool,
    /// Воркер сейчас пишет (или переписывает) файл.
    working: bool,
    /// Синхронный сброс на выходе: воркер не должен лезть в тот же файл.
    syncing: bool,
    stopping: bool,
    stopped: bool,
    /// Сколько проходов записи завершено — на этом стоит `flush`.
    passes: u64,
    failed_attempts: u32,
    last_error: Option<String>,
    file_bytes: u64,
}

struct Inner {
    file: PathBuf,
    retry_delay: Duration,
    /// Лимит хранимых записей; 0 — без лимита. Меняется на лету.
    max_records: AtomicUsize,
    logger: Option<Arc<LoggerFn>>,
    append: Arc<FileWriteFn>,
    replace: Arc<FileWriteFn>,
    state: Mutex<State>,
    /// Будит воркер: появилась работа, повтор или остановка.
    work: Condvar,
    /// Воркер закончил проход записи — на этом стоит `flush`.
    done: Condvar,
}

impl Inner {
    fn max_records(&self) -> usize {
        self.max_records.load(AtomicOrdering::Relaxed)
    }

    fn log(&self, message: &str) {
        if let Some(logger) = &self.logger {
            logger(message);
        }
    }
}

/// Append-only история событий одного вида (события стрима или чат).
pub struct HistoryStore {
    inner: Arc<Inner>,
    worker: Option<JoinHandle<()>>,
}

impl HistoryStore {
    /// Открыть историю: убрать осиротевшие временные файлы и запустить поток записи.
    pub fn open(file: PathBuf, options: HistoryOptions) -> Self {
        // Остатки прошлых запусков (убили между записью и переименованием) убираем
        // сразу, а не копим.
        atomic::sweep_stale_temp_files(&file, atomic::TEMP_MAX_AGE);
        if let Some(dir) = file.parent() {
            // Каталог может ещё не существовать: запись создаст файл, но не каталог.
            let _ = fs::create_dir_all(dir);
        }

        let inner = Arc::new(Inner {
            retry_delay: options.retry_delay.unwrap_or(RETRY_DELAY),
            max_records: AtomicUsize::new(resolve_max_records(options.max_records)),
            logger: options.logger.clone(),
            append: options.append.unwrap_or_else(|| Arc::new(append_file)),
            replace: options.replace.unwrap_or_else(|| Arc::new(replace_file)),
            state: Mutex::new(State {
                file_bytes: current_file_size(&file),
                ..State::default()
            }),
            work: Condvar::new(),
            done: Condvar::new(),
            file,
        });

        let worker = {
            let inner = Arc::clone(&inner);
            thread::Builder::new()
                .name("ose-history".to_string())
                .spawn(move || worker(inner))
                .expect("поток истории должен создаваться")
        };

        Self {
            inner,
            worker: Some(worker),
        }
    }

    /// Файл, в котором лежит история.
    pub fn path(&self) -> &Path {
        &self.inner.file
    }

    /// Дописать событие. Возвращает ту же запись — как JS-версия.
    pub fn append(&self, record: Value) -> Value {
        let mut state = self.lock_idle();
        let seq = {
            state.seq += 1;
            state.seq
        };
        let entry = state.meta_of(Some(&record));
        state.pending.push(Memory {
            seq,
            record: record.clone(),
            entry,
        });
        state.ops.push_back(Op::Append {
            items: vec![AppendItem {
                seq,
                record: record.clone(),
                text: to_json(&record),
            }],
        });

        let max_records = self.inner.max_records();
        if max_records > 0 && state.rewrite.is_none() {
            // Уплотнение решается по числу записей, а его знает только индекс:
            // размер файла о числе строк ничего не говорит. Поэтому с лимитом
            // индекс строится уже на первом событии (в приложении он и так
            // строится на старте — миграцией в `db.js`).
            state.ensure_built(&self.inner.file);
            if state.index.len() + state.pending.len() > max_records * COMPACT_FACTOR {
                // Файл вдвое превысил лимит — уплотняем видимое содержимое
                // (включая ещё не записанное) в новый файл.
                let records = visible_records(&state, &self.inner.file, max_records);
                enqueue_rewrite(&mut state, records);
            }
        }

        state.ready = true;
        drop(state);
        self.inner.work.notify_all();
        record
    }

    /// Заменить историю целиком (миграция из старого файла).
    pub fn replace_all(&self, next: Vec<Value>) {
        let mut state = self.lock_idle();
        let mut records = next;
        cap_records(&mut records, self.inner.max_records());
        enqueue_rewrite(&mut state, records);
        state.ready = true;
        drop(state);
        self.inner.work.notify_all();
    }

    /// Очистить историю (файл станет пустым после сброса).
    pub fn clear(&self) {
        self.replace_all(Vec::new());
    }

    /// Страница истории: фильтры, сортировка по времени (свежие вперёд), пагинация.
    pub fn query(&self, opts: &QueryOptions) -> Page {
        let inner = &self.inner;
        let mut state = self.lock_idle();
        state.ensure_built(&inner.file);
        let filters = state.filters(opts);

        let limit = opts.limit.filter(|value| *value > 0).unwrap_or(50).max(1);
        let offset = opts.offset.unwrap_or(0);
        let need_parse = !filters.search.is_empty();
        let items = visible(&state, inner.max_records());

        // Пары «индекс видимой записи → разобранное содержимое»: при поиске
        // разбор нужен сразу, иначе читаем только страницу.
        let mut matched: Vec<(usize, Option<Value>)> = Vec::new();
        if need_parse {
            let escaped = json_escaped_lower(&filters.search);
            let mut raw: Option<Vec<u8>> = None;
            for (position, slot) in items.iter().enumerate() {
                let record = match slot.record {
                    Some(record) => record.clone(),
                    None => {
                        if raw.is_none() {
                            raw = fs::read(&inner.file).ok();
                        }
                        let Some(bytes) = raw.as_deref() else {
                            break; // файл мог исчезнуть — отдаём то, что успели
                        };
                        let text = String::from_utf8_lossy(line_bytes(bytes, slot.entry));
                        // Дешёвый предфильтр: без совпадения подстроки (или её
                        // JSON-формы) в сырой строке разбор не нужен.
                        if !raw_may_match(&text.to_lowercase(), &filters.search, &escaped) {
                            continue;
                        }
                        match serde_json::from_str::<Value>(&text) {
                            Ok(record) => record,
                            Err(_) => continue, // повреждённая строка — как при индексации
                        }
                    }
                };
                if match_entry(slot.entry, Some(&record), &filters) {
                    matched.push((position, Some(record)));
                }
            }
        } else {
            for (position, slot) in items.iter().enumerate() {
                if match_entry(slot.entry, None, &filters) {
                    matched.push((position, None));
                }
            }
        }

        // Сортировка по времени по убыванию; при равном времени — порядок
        // добавления (сортировка устойчивая, как `Array.prototype.sort`).
        matched.sort_by(|a, b| {
            items[b.0]
                .entry
                .ts
                .partial_cmp(&items[a.0].entry.ts)
                .unwrap_or(Ordering::Equal)
        });

        let total = matched.len();
        let page: Vec<(usize, Option<Value>)> =
            matched.into_iter().skip(offset).take(limit).collect();
        let records = if need_parse {
            page.into_iter()
                .map(|(_, record)| record.unwrap_or(Value::Null))
                .collect()
        } else {
            let mut on_disk: Option<File> = None;
            let mut out = Vec::with_capacity(page.len());
            for (position, _) in page {
                let slot = &items[position];
                match slot.record {
                    Some(record) => out.push(record.clone()),
                    None => {
                        if on_disk.is_none() {
                            on_disk = File::open(&inner.file).ok();
                        }
                        if let Some(handle) = on_disk.as_mut() {
                            if let Some(record) = read_entry(handle, slot.entry) {
                                out.push(record);
                            }
                        }
                    }
                }
            }
            out
        };

        Page {
            items: records,
            total,
        }
    }

    /// Найти запись по id (как `getById`); `None` — не найдена.
    pub fn get_by_id(&self, id: Option<&Value>) -> Option<Value> {
        let mut state = self.lock_idle();
        state.ensure_built(&self.inner.file);

        // `String(id)` в JS: null и пустая строка означают «искать нечего».
        let key = match id {
            Some(value) if !value.is_null() => js_key(value),
            _ => return None,
        };
        if key.is_empty() {
            return None;
        }

        if let Some(records) = &state.rewrite {
            // По перезаписи ищем по «сырому» String(record.id): в JS это тоже
            // `String`, а не `!= null`-проверка, как при построении индекса.
            return records
                .iter()
                .find(|memory| loose_id_key(&memory.record).as_deref() == Some(key.as_str()))
                .map(|memory| memory.record.clone());
        }
        if let Some(memory) = state
            .pending
            .iter()
            .find(|memory| loose_id_key(&memory.record).as_deref() == Some(key.as_str()))
        {
            return Some(memory.record.clone());
        }

        let position = *state.id_map.get(&key)?;
        let entry = state.index[position];
        drop(state);
        let mut handle = File::open(&self.inner.file).ok()?;
        read_entry(&mut handle, &entry)
    }

    /// Все видимые записи в порядке добавления (для агрегатов по сессиям).
    pub fn all(&self) -> Vec<Value> {
        let mut state = self.lock_idle();
        state.ensure_built(&self.inner.file);
        visible_records(&state, &self.inner.file, self.inner.max_records())
    }

    /// Сколько записей видно (с учётом лимита).
    pub fn count(&self) -> usize {
        let mut state = self.lock_idle();
        state.ensure_built(&self.inner.file);
        let total = match &state.rewrite {
            Some(records) => records.len(),
            None => state.index.len(),
        } + state.pending.len();
        let max_records = self.inner.max_records();
        if max_records > 0 && total > max_records {
            max_records
        } else {
            total
        }
    }

    /// Удалить записи, подходящие под фильтр; возвращает число удалённых.
    pub fn remove_by(&self, filter: &QueryOptions) -> usize {
        let mut state = self.lock_idle();
        state.ensure_built(&self.inner.file);
        let filters = state.filters(filter);
        let mut records = visible_records(&state, &self.inner.file, self.inner.max_records());

        let mut kept = Vec::with_capacity(records.len());
        let mut removed = 0;
        for record in records.drain(..) {
            let entry = state.meta_of(Some(&record));
            if match_entry(&entry, Some(&record), &filters) {
                removed += 1;
            } else {
                kept.push(record);
            }
        }

        if removed > 0 {
            enqueue_rewrite(&mut state, kept);
            state.ready = true;
            drop(state);
            self.inner.work.notify_all();
        }
        removed
    }

    /// Сменить лимит хранимых записей и сразу уплотнить файл под него.
    pub fn set_max_records(&self, value: Option<usize>) -> usize {
        let max_records = resolve_max_records(value);
        self.inner
            .max_records
            .store(max_records, AtomicOrdering::Relaxed);

        let mut state = self.lock_idle();
        state.ensure_built(&self.inner.file);
        // `all()` уже обрезает по новому лимиту — так же ведёт себя JS-версия.
        let records = visible_records(&state, &self.inner.file, max_records);
        enqueue_rewrite(&mut state, records);
        state.ready = true;
        drop(state);
        self.inner.work.notify_all();
        max_records
    }

    /// Текущий лимит; 0 — без лимита.
    pub fn max_records(&self) -> usize {
        self.inner.max_records()
    }

    /// Последняя ошибка записи; `None` — всё писалось успешно.
    pub fn last_error(&self) -> Option<String> {
        self.inner.state.lock().unwrap().last_error.clone()
    }

    /// Взять замок состояния, дождавшись, что воркер не пишет файл.
    ///
    /// Ждать и брать замок нужно одним действием: если между ожиданием и работой
    /// замок отпустить, воркер успеет начать новый проход, и мы либо прочитаем
    /// файл в середине записи, либо вернёмся раньше, чем данные окажутся на диске.
    fn lock_idle(&self) -> std::sync::MutexGuard<'_, State> {
        let mut state = self.inner.state.lock().unwrap();
        while state.working {
            state = self.inner.done.wait(state).unwrap();
        }
        state
    }

    /// Дождаться, пока всё поставленное окажется на диске.
    ///
    /// Ждём не только текущий проход, но и отложенный повтор после сбоя: иначе
    /// `flush` вернулся бы раньше, чем записи попали в файл. Число проходов
    /// ограничено бюджетом повторов — недоступный диск не превращает `flush`
    /// в бесконечное ожидание.
    pub fn flush(&self) {
        for _ in 0..=RETRY_LIMIT + 1 {
            let mut state = self.inner.state.lock().unwrap();
            if state.stopped || (state.ops.is_empty() && !state.working) {
                return;
            }
            let seen = state.passes;
            // Разрешаем проход (в JS это `ensureDrain`).
            state.ready = true;
            drop(state);
            self.inner.work.notify_all();

            let mut state = self.inner.state.lock().unwrap();
            while state.passes == seen && !state.stopped {
                if state.ops.is_empty() && !state.working {
                    return;
                }
                state = self.inner.done.wait(state).unwrap();
            }
        }
    }

    /// Синхронный сброс недописанных строк — для выхода из приложения.
    ///
    /// Best-effort: ошибку отдаём наружу, но выход не роняем.
    pub fn flush_sync(&self) -> bool {
        // Смещения в индексе считаются от текущего размера файла, поэтому писать
        // одновременно с проходом воркера нельзя.
        let mut state = self.lock_idle();
        if state.ops.is_empty() {
            return false;
        }
        // Пока идёт синхронный сброс, воркер в файл не лезет.
        state.syncing = true;
        let batch: Vec<Op> = state.ops.drain(..).collect();
        drop(state);

        let result = write_batch(&self.inner, &batch);
        let mut state = self.inner.state.lock().unwrap();
        state.syncing = false;
        if let Err(error) = &result {
            state.last_error = Some(error.to_string());
        }
        drop(state);
        self.inner.work.notify_all();

        match result {
            Ok(written) => written,
            Err(error) => {
                self.inner.log(&error.to_string());
                false
            }
        }
    }

    /// Остановить поток записи. Остаток очереди сбрасывается синхронно.
    pub fn stop(&mut self) {
        let Some(worker) = self.worker.take() else {
            return;
        };
        let _ = self.flush_sync();
        {
            let mut state = self.inner.state.lock().unwrap();
            state.stopping = true;
        }
        self.inner.work.notify_all();
        let _ = worker.join();
    }
}

impl Drop for HistoryStore {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Видимая запись: либо строка в файле (читается по смещению), либо содержимое в
/// памяти. Записи идут в порядке добавления.
struct Slot<'a> {
    entry: &'a Entry,
    record: Option<&'a Value>,
}

/// Видимые записи: индекс плюс ещё не записанное, обрезанные по лимиту.
fn visible(state: &State, max_records: usize) -> Vec<Slot<'_>> {
    let mut items: Vec<Slot<'_>> = Vec::with_capacity(state.index.len() + state.pending.len());
    match &state.rewrite {
        Some(records) => {
            items.extend(records.iter().map(|memory| Slot {
                entry: &memory.entry,
                record: Some(&memory.record),
            }));
            items.extend(state.pending.iter().map(|memory| Slot {
                entry: &memory.entry,
                record: Some(&memory.record),
            }));
        }
        None => {
            items.extend(state.index.iter().map(|entry| Slot {
                entry,
                record: None,
            }));
            items.extend(state.pending.iter().map(|memory| Slot {
                entry: &memory.entry,
                record: Some(&memory.record),
            }));
        }
    }
    if max_records > 0 && items.len() > max_records {
        items.drain(..items.len() - max_records);
    }
    items
}

/// Материализовать видимые записи: из памяти как есть, остальные — из файла.
fn visible_records(state: &State, file: &Path, max_records: usize) -> Vec<Value> {
    let items = visible(state, max_records);
    let mut out = Vec::with_capacity(items.len());
    let mut on_disk: Option<File> = None;
    for slot in items {
        match slot.record {
            Some(record) => out.push(record.clone()),
            None => {
                if on_disk.is_none() {
                    on_disk = File::open(file).ok();
                }
                // Файл мог исчезнуть или укоротиться — тогда запись просто
                // пропускаем: пусть лучше история короче, чем паника.
                if let Some(handle) = on_disk.as_mut() {
                    if let Some(record) = read_entry(handle, slot.entry) {
                        out.push(record);
                    }
                }
            }
        }
    }
    out
}

/// Прочитать строку записи по смещению и разобрать её.
fn read_entry(handle: &mut File, entry: &Entry) -> Option<Value> {
    if entry.off == NO_OFFSET {
        return None;
    }
    handle.seek(SeekFrom::Start(entry.off)).ok()?;
    let mut buffer = vec![0u8; entry.len];
    handle.read_exact(&mut buffer).ok()?;
    serde_json::from_slice(&buffer).ok()
}

/// Байты строки записи внутри прочитанного файла.
fn line_bytes<'a>(bytes: &'a [u8], entry: &Entry) -> &'a [u8] {
    let start = entry.off as usize;
    let end = start.saturating_add(entry.len);
    bytes.get(start..end).unwrap_or(&[])
}

fn match_entry(entry: &Entry, record: Option<&Value>, filters: &Filters) -> bool {
    if let Some(sess) = filters.sess {
        if entry.sess_id != sess {
            return false;
        }
    }
    if let Some(kind) = filters.type_id {
        if entry.type_id != kind {
            return false;
        }
    }
    if filters.include_test == Some(false) && entry.test {
        return false;
    }
    if let Some(since) = filters.since {
        if entry.ts < since {
            return false;
        }
    }
    if !filters.search.is_empty() {
        let user = field_lower(record, "username");
        let message = field_lower(record, "message");
        if !user.contains(&filters.search) && !message.contains(&filters.search) {
            return false;
        }
    }
    true
}

/// JSON-экранированная форма подстроки (ровно так её пишет `JSON.stringify`):
/// кавычки → `\"`, слэши → `\\`, переводы строк → `\n`. Нужна, чтобы предфильтр
/// не пропустил совпадение из-за экранирования.
fn json_escaped_lower(needle: &str) -> String {
    match serde_json::to_string(needle) {
        Ok(text) => text
            .strip_prefix('"')
            .and_then(|text| text.strip_suffix('"'))
            .unwrap_or_default()
            .to_lowercase(),
        Err(_) => String::new(),
    }
}

/// Дешёвый предфильтр поиска: если ни подстроки, ни её JSON-формы нет в сырой
/// строке, разбор не нужен. Ложные срабатывания отсеет `match_entry`, ложные
/// пропуски исключены: совпадение по username/message всегда есть в сырой строке
/// хотя бы в экранированном виде.
fn raw_may_match(lower_line: &str, needle: &str, escaped: &str) -> bool {
    if lower_line.contains(needle) {
        return true;
    }
    !escaped.is_empty() && escaped != needle && lower_line.contains(escaped)
}

/// Разобранные фильтры: интернированные идентификаторы и подготовленный поиск.
struct Filters {
    sess: Option<i32>,
    type_id: Option<i32>,
    include_test: Option<bool>,
    search: String,
    since: Option<f64>,
}

impl State {
    /// Интернировать тип и sessionId, запомнить время и признак теста.
    fn meta_of(&mut self, record: Option<&Value>) -> Entry {
        // `Number(record.timestamp) || 0` и `record.is_test ? 1 : 0`: у записей не
        // всегда есть эти поля, а иногда они приходят строками.
        let (ts, test) = match record.and_then(Value::as_object) {
            Some(object) => (
                js_number_or_zero(object.get("timestamp")),
                js_truthy(object.get("is_test")),
            ),
            None => (0.0, false),
        };
        Entry {
            off: NO_OFFSET,
            len: 0,
            ts,
            test,
            type_id: intern(
                &mut self.type_dict,
                &mut self.type_list,
                record.and_then(|value| value.get("type")),
            ),
            sess_id: intern(
                &mut self.sess_dict,
                &mut self.sess_list,
                record.and_then(|value| value.get("sessionId")),
            ),
        }
    }

    /// Разобрать фильтры запроса. Интернирование здесь может добавить новые
    /// значения в словари: идентификатор, которого нет в индексе, не найдёт
    /// ничего — это и есть нужное поведение.
    fn filters(&mut self, opts: &QueryOptions) -> Filters {
        let sess = opts
            .session_id
            .as_ref()
            .filter(|value| js_truthy(Some(value)))
            .map(|value| intern(&mut self.sess_dict, &mut self.sess_list, Some(value)));
        let type_id = opts
            .kind
            .as_ref()
            .filter(|value| js_truthy(Some(value)))
            .map(|value| intern(&mut self.type_dict, &mut self.type_list, Some(value)));
        Filters {
            sess,
            type_id,
            include_test: opts.include_test,
            search: opts
                .search
                .as_deref()
                .map(|search| search.trim().to_lowercase())
                .unwrap_or_default(),
            // Ноль и мусор означают «ограничения нет»; граница включительна.
            since: opts.since.filter(|value| *value > 0.0),
        }
    }

    /// Ленивая индексация файла: строим метаданные по строкам один раз.
    fn ensure_built(&mut self, file: &Path) {
        if self.built {
            return;
        }
        self.built = true;
        self.index.clear();
        self.id_map.clear();
        if self.rewrite.is_some() {
            return; // перезапись сама задаёт видимое содержимое
        }
        let Ok(raw) = fs::read(file) else {
            return;
        };

        let mut start = 0usize;
        let mut position = 0usize;
        // Идём до длины включительно: последняя строка может быть без перевода
        // строки (файл могут дописать извне или оборвать на сбое).
        for index in 0..=raw.len() {
            if index < raw.len() && raw[index] != b'\n' {
                continue;
            }
            let len = index - start;
            if len > 0 {
                let text = String::from_utf8_lossy(&raw[start..index]);
                if !text.trim().is_empty() {
                    if let Ok(record) = serde_json::from_str::<Value>(&text) {
                        let mut entry = self.meta_of(Some(&record));
                        entry.off = start as u64;
                        entry.len = len;
                        if let Some(key) = record_id_key(&record) {
                            self.id_map.insert(key, position);
                        }
                        self.index.push(entry);
                        position += 1;
                    }
                    // Повреждённая или частичная строка — пропускаем.
                }
            }
            start = index + 1;
        }
        self.file_bytes = raw.len() as u64;
    }

    /// Пересобрать индекс по только что записанному файлу: содержимое известно,
    /// поэтому смещения считаем без чтения с диска. Записи, дописанные уже после
    /// постановки перезаписи, остаются в `pending`.
    fn apply_rewrite(&mut self, records: &[Value], content_bytes: u64, consumed: &[u64]) {
        self.index.clear();
        self.id_map.clear();
        let mut offset = 0u64;
        for (position, record) in records.iter().enumerate() {
            let text = to_json(record);
            let mut entry = self.meta_of(Some(record));
            entry.off = offset;
            entry.len = text.len();
            if let Some(key) = record_id_key(record) {
                self.id_map.insert(key, position);
            }
            self.index.push(entry);
            offset += entry.len as u64 + 1; // + "\n"
        }
        self.file_bytes = content_bytes;
        self.rewrite = None;
        if !consumed.is_empty() {
            let written: HashSet<u64> = consumed.iter().copied().collect();
            self.pending.retain(|memory| !written.contains(&memory.seq));
        }
    }

    /// Дописать метаданные записанных строк в индекс (если он построен).
    fn apply_append(&mut self, items: &[&AppendItem], base: u64) {
        if !items.is_empty() {
            let written: HashSet<u64> = items.iter().map(|item| item.seq).collect();
            self.pending.retain(|memory| !written.contains(&memory.seq));
        }
        if !self.built || self.rewrite.is_some() {
            return; // индекс пересоберётся из файла / из rewrite
        }

        // Пока пишет воркер, в файл никто не читает (`lock_idle`), поэтому
        // индекс всегда отстаёт ровно на этот батч.
        let mut offset = base;
        for item in items {
            let mut entry = self.meta_of(Some(&item.record));
            entry.off = offset;
            entry.len = item.text.len();
            if let Some(key) = record_id_key(&item.record) {
                let position = self.index.len();
                self.id_map.insert(key, position);
            }
            self.index.push(entry);
            offset += entry.len as u64 + 1;
        }
    }
}

/// Поставить перезапись: очередь схлопывается в одну операцию, а видимым
/// становится её содержимое. Раньше поставленные дописывания уже учтены в
/// переданных записях, поэтому их можно выбросить из очереди.
fn enqueue_rewrite(state: &mut State, records: Vec<Value>) {
    let mut memory = Vec::with_capacity(records.len());
    for record in records {
        let entry = state.meta_of(Some(&record));
        let seq = {
            state.seq += 1;
            state.seq
        };
        memory.push(Memory { seq, record, entry });
    }

    state.ops.clear();
    state.ops.push_back(Op::Truncate {
        records: memory.iter().map(|memory| memory.record.clone()).collect(),
    });
    state.pending.clear();
    // Индекс пересоберётся после успешной записи; пока читаем из `rewrite`.
    state.built = true;
    state.index.clear();
    state.id_map.clear();
    state.rewrite = Some(memory);
}

/// Обрезать список до последних `max_records` записей (0 — без лимита).
fn cap_records(records: &mut Vec<Value>, max_records: usize) {
    if max_records > 0 && records.len() > max_records {
        records.drain(..records.len() - max_records);
    }
}

/// Записать один батч операций. `Ok(false)` — писать было нечего.
///
/// Вызывается и из воркера, и из синхронного сброса: логика записи у них общая,
/// различается только ожидание повторов.
fn write_batch(inner: &Inner, batch: &[Op]) -> io::Result<bool> {
    if batch.is_empty() {
        return Ok(false);
    }

    match batch
        .iter()
        .rposition(|op| matches!(op, Op::Truncate { .. }))
    {
        Some(at) => {
            // Записи из всех append-операций после последнего truncate в батче:
            // они уезжают в тот же атомарный файл, чтобы ничего не потерять.
            let mut records = match &batch[at] {
                Op::Truncate { records } => records.clone(),
                Op::Append { .. } => Vec::new(),
            };
            let mut consumed = Vec::new();
            for op in &batch[at + 1..] {
                if let Op::Append { items } = op {
                    for item in items {
                        records.push(item.record.clone());
                        consumed.push(item.seq);
                    }
                }
            }
            cap_records(&mut records, inner.max_records());
            let content = lines_of(&records);

            (inner.replace)(&inner.file, &content)?;
            let mut state = inner.state.lock().unwrap();
            state.apply_rewrite(&records, content.len() as u64, &consumed);
            Ok(true)
        }
        None => {
            let items = append_items(batch);
            if items.is_empty() {
                return Ok(false);
            }
            let mut content = String::new();
            for item in &items {
                content.push_str(&item.text);
                content.push('\n');
            }

            let base = inner.state.lock().unwrap().file_bytes;
            (inner.append)(&inner.file, &content)?;
            let mut state = inner.state.lock().unwrap();
            state.file_bytes = base + content.len() as u64;
            state.apply_append(&items, base);
            Ok(true)
        }
    }
}

/// Дописываемые записи батча (в порядке постановки).
fn append_items(batch: &[Op]) -> Vec<&AppendItem> {
    let mut out = Vec::new();
    for op in batch {
        if let Op::Append { items } = op {
            out.extend(items.iter());
        }
    }
    out
}

/// Содержимое файла: по строке на запись, с переводом строки в конце.
fn lines_of(records: &[Value]) -> String {
    let mut out = String::new();
    for record in records {
        out.push_str(&to_json(record));
        out.push('\n');
    }
    out
}

/// Поток записи: ждёт разрешения, пишет батч, повторяет после сбоя.
fn worker(inner: Arc<Inner>) {
    loop {
        // --- ожидание работы ---
        let mut state = inner.state.lock().unwrap();
        while !state.stopping && !(state.ready && !state.ops.is_empty() && !state.syncing) {
            state = inner.work.wait(state).unwrap();
        }
        if state.stopping {
            // Остаток очереди уже сброшен `flush_sync` в `stop()`.
            break;
        }

        // --- проход записи ---
        state.working = true;
        state.ready = false;
        let batch: Vec<Op> = state.ops.drain(..).collect();
        drop(state);

        let result = write_batch(&inner, &batch);
        if let Err(error) = &result {
            // Батч возвращаем в начало очереди: в памяти записи и так видны
            // (pending), а так они ещё и попадут в файл, как только запись
            // станет возможной. Если запись успела положить часть байт, повтор
            // продублирует строку — это лечится, а вот молчаливая потеря
            // записей при перезапуске не лечится никак.
            let mut state = inner.state.lock().unwrap();
            state.last_error = Some(error.to_string());
            for op in batch.into_iter().rev() {
                state.ops.push_front(op);
            }
            drop(state);
            inner.log(&error.to_string());
        }

        // --- итог прохода ---
        let mut state = inner.state.lock().unwrap();
        state.working = false;
        state.passes += 1;
        if result.is_ok() {
            state.failed_attempts = 0;
        } else {
            state.failed_attempts += 1;
        }
        let retry = result.is_err()
            && !state.stopping
            && state.failed_attempts <= RETRY_LIMIT
            && !state.ops.is_empty();
        inner.done.notify_all();
        drop(state);

        if retry {
            // Пауза повтора. Любой сигнал (новые данные, `flush`, остановка)
            // прерывает её — это и есть `ensureDrain` из JS.
            let state = inner.state.lock().unwrap();
            let (mut state, _) = inner.work.wait_timeout(state, inner.retry_delay).unwrap();
            if !state.stopping {
                state.ready = true;
            }
            drop(state);
        }
    }

    let mut state = inner.state.lock().unwrap();
    state.stopped = true;
    inner.done.notify_all();
}

/// Дописать строки в конец файла (создавая его при необходимости).
fn append_file(file: &Path, content: &str) -> io::Result<()> {
    let mut handle = OpenOptions::new().create(true).append(true).open(file)?;
    handle.write_all(content.as_bytes())
}

/// Атомарно перезаписать файл: temp рядом с целевым плюс переименование, чтобы
/// краш во время уплотнения не оставил полупустой файл.
fn replace_file(file: &Path, content: &str) -> io::Result<()> {
    let temp = temp_path(file);
    fs::write(&temp, content)?;
    match rename_with_retry(&temp, file) {
        Ok(()) => Ok(()),
        Err(error) => {
            // Убираем временный файл, но наружу отдаём исходную ошибку: она важнее.
            let _ = fs::remove_file(&temp);
            Err(error)
        }
    }
}

/// Временный файл уплотнения: `.имя.<pid>.<номер>.tmp` (такие же имена подметает
/// `atomic::sweep_stale_temp_files`).
fn temp_path(file: &Path) -> PathBuf {
    let seq = TEMP_SEQ.fetch_add(1, AtomicOrdering::Relaxed) + 1;
    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    file.with_file_name(format!(".{name}.{}.{seq}.tmp", std::process::id()))
}

/// Переименовать, повторяя при «файл занят».
fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt: u32 = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if !retryable(&error) || attempt >= RENAME_RETRIES {
                    return Err(error);
                }
                attempt += 1;
                thread::sleep(RENAME_RETRY_DELAY * attempt);
            }
        }
    }
}

/// Стоит ли повторять: «нет доступа» и «занято» на обеих платформах.
fn retryable(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(16 | 32 | 33))
}

fn current_file_size(file: &Path) -> u64 {
    fs::metadata(file).map(|data| data.len()).unwrap_or(0)
}

/// Снимок записи — компактно, как `JSON.stringify(record)`.
fn to_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

/// `resolveMaxRecords` из JS: отсутствие значения — умолчание, явный ноль —
/// отключение лимита (в тестах его пишут как 0, в настройках — как 0 или `null`).
fn resolve_max_records(value: Option<usize>) -> usize {
    match value {
        None => DEFAULT_MAX_RECORDS,
        Some(limit) => limit,
    }
}

/// Лимит из настроек, где он записан как JSON: `0`, `false` и `null` значат
/// «без лимита», отсутствие и мусор — умолчание.
pub fn max_records_from_json(value: Option<&Value>) -> Option<usize> {
    match value {
        None => None,
        Some(Value::Null) => Some(0),
        Some(Value::Bool(false)) => Some(0),
        Some(Value::Bool(true)) => None,
        Some(Value::Number(number)) => number.as_f64().and_then(max_records_limit),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok().and_then(max_records_limit),
        Some(_) => None,
    }
}

/// Положительное число — лимит, ноль (в том числе `-0`) — «без лимита»,
/// отрицательное и мусор — умолчание.
fn max_records_limit(value: f64) -> Option<usize> {
    if value > 0.0 && value.is_finite() {
        return Some(value.floor() as usize);
    }
    if value == 0.0 {
        return Some(0);
    }
    None
}

/// `intern` из JS: типы и sessionId повторяются тысячами, поэтому в индексе
/// лежит их номер, а не строка.
fn intern(dict: &mut HashMap<String, i32>, list: &mut Vec<String>, value: Option<&Value>) -> i32 {
    let Some(value) = value else {
        return -1;
    };
    if value.is_null() {
        return -1;
    }
    let key = js_key(value);
    if key.is_empty() {
        return -1;
    }
    if let Some(id) = dict.get(&key) {
        return *id;
    }
    let id = list.len() as i32;
    dict.insert(key.clone(), id);
    list.push(key);
    id
}

/// `record && record.id != null ? String(record.id) : None` — ключ карты id.
fn record_id_key(record: &Value) -> Option<String> {
    if !js_truthy(Some(record)) {
        return None;
    }
    let id = record.get("id")?;
    if id.is_null() {
        return None;
    }
    Some(js_key(id))
}

/// `String(record.id)` без проверки на null — так ищет JS по очереди перезаписи.
fn loose_id_key(record: &Value) -> Option<String> {
    if !js_truthy(Some(record)) {
        return None;
    }
    Some(match record.get("id") {
        Some(id) => js_key(id),
        None => "undefined".to_string(),
    })
}

/// `String(value)`: ровно то, что нужно ключам (тип, sessionId, id, source_id).
pub(crate) fn js_key(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_key(number),
        Value::String(text) => text.clone(),
        Value::Array(_) => value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| match item {
                        // В массиве null печатается пустым — так работает join.
                        Value::Null => String::new(),
                        other => js_key(other),
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default(),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// Число в том виде, в каком его печатает JS: `1`, а не `1.0`.
fn number_key(number: &serde_json::Number) -> String {
    if let Some(integer) = number.as_i64() {
        return integer.to_string();
    }
    if let Some(integer) = number.as_u64() {
        return integer.to_string();
    }
    match number.as_f64() {
        Some(value) if value.is_finite() => format!("{value}"),
        _ => "null".to_string(),
    }
}

/// `Number(value)`: строка разбирается, массив из одного числа — как это число,
/// всё остальное непонятное — NaN.
pub(crate) fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::Bool(flag)) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Some(Value::Array(items)) => match items.len() {
            0 => 0.0,
            1 => js_number(items.first()),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `Number(value) || 0`: NaN и ноль одинаково дают ноль.
pub(crate) fn js_number_or_zero(value: Option<&Value>) -> f64 {
    let number = js_number(value);
    if number.is_nan() || number == 0.0 {
        0.0
    } else {
        number
    }
}

/// Число так, как его напечатал бы JS: `10`, а не `10.0`.
///
/// Нужно там, где значение уезжает в JSON: `serde_json` печатает `f64` в том
/// виде, в каком он пришёл, а `JSON.stringify` у целых дробную часть не пишет.
/// Без этого файлы и ответы расходились бы с Electron-версией буквально в
/// каждом числовом поле.
pub(crate) fn number_value(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15 {
        return Value::from(value as i64);
    }
    Value::from(value)
}

/// Правдивость значения по правилам JS: пустая строка, ноль, `null` и `false`
/// ложны, массивы и объекты — истинны.
pub(crate) fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number
            .as_f64()
            .map(|value| value != 0.0 && !value.is_nan())
            .unwrap_or(false),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// Поле записи в нижнем регистре — так его сравнивает поиск: `String(x || "")`.
fn field_lower(record: Option<&Value>, key: &str) -> String {
    let Some(value) = record.and_then(|record| record.get(key)) else {
        return String::new();
    };
    if !js_truthy(Some(value)) {
        return String::new();
    }
    js_key(value).to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    /// Временный каталог под один тест; имя — по имени теста, чтобы не пересекались.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("ose-history-{}-{label}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            Self(dir)
        }

        fn file(&self) -> PathBuf {
            self.0.join("local-db.jsonl")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    fn open(file: &Path, options: HistoryOptions) -> HistoryStore {
        HistoryStore::open(file.to_path_buf(), options)
    }

    /// Непустые строки файла — как их читает тест в JS-версии.
    fn read_lines(file: &Path) -> Vec<String> {
        match fs::read_to_string(file) {
            Ok(text) => text
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(str::to_string)
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// `id` записей из файла — в порядке строк.
    fn line_ids(file: &Path) -> Vec<String> {
        read_lines(file)
            .iter()
            .map(|line| {
                let record: Value = serde_json::from_str(line).expect("строка должна быть JSON");
                record
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            })
            .collect()
    }

    fn ids(page: &Page) -> Vec<String> {
        page.items
            .iter()
            .map(|item| {
                item.get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            })
            .collect()
    }

    fn event(id: &str, timestamp: i64) -> Value {
        serde_json::json!({ "id": id, "timestamp": timestamp })
    }

    fn query_ids(store: &HistoryStore, opts: QueryOptions) -> Vec<String> {
        ids(&store.query(&opts))
    }

    fn search(needle: &str) -> QueryOptions {
        QueryOptions {
            search: Some(needle.to_string()),
            ..Default::default()
        }
    }

    /// Временные файлы уплотнения, оставшиеся рядом с историей.
    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .filter(|name| name.ends_with(".tmp"))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn append_writes_lines_and_keeps_order() {
        let dir = TempDir::new("append");
        let file = dir.file();
        let history = open(&file, HistoryOptions::default());

        history.append(serde_json::json!({ "id": "a", "timestamp": 1, "username": "one" }));
        history.append(serde_json::json!({ "id": "b", "timestamp": 2, "username": "two" }));
        history.flush();

        assert_eq!(history.count(), 2);
        assert_eq!(line_ids(&file), ["a", "b"]);
    }

    #[test]
    fn index_is_built_lazily() {
        let dir = TempDir::new("lazy");
        let file = dir.file();
        let content = "{\"id\":\"a\",\"timestamp\":1}\n";
        fs::write(&file, content).unwrap();

        let history = open(&file, HistoryOptions::default());
        // При открытии файл не читается — запоминается только его размер.
        assert!(!history.inner.state.lock().unwrap().built);
        assert_eq!(
            history.inner.state.lock().unwrap().file_bytes,
            content.len() as u64
        );

        // Первое обращение к содержимому строит индекс.
        assert_eq!(history.count(), 1);
        assert!(history.inner.state.lock().unwrap().built);
        assert_eq!(history.inner.state.lock().unwrap().index.len(), 1);
    }

    #[test]
    fn query_sorts_filters_and_paginates() {
        let dir = TempDir::new("query");
        let file = dir.file();
        let history = open(&file, HistoryOptions::default());

        for index in 1..=5 {
            history.append(serde_json::json!({
                "id": format!("e{index}"),
                "timestamp": index,
                "type": if index % 2 == 1 { "donation" } else { "follow" },
                "username": format!("u{index}"),
            }));
        }
        history.flush();

        let page = history.query(&QueryOptions {
            limit: Some(2),
            offset: Some(1),
            ..Default::default()
        });
        assert_eq!(page.total, 5);
        assert_eq!(ids(&page), ["e4", "e3"]);

        let only_follow = history.query(&QueryOptions {
            kind: Some(Value::from("follow")),
            ..Default::default()
        });
        assert_eq!(ids(&only_follow), ["e4", "e2"]);

        assert_eq!(query_ids(&history, search("u1")), ["e1"]);

        // Нулевой лимит означает умолчание (50), а не пустую страницу.
        let zero_limit = history.query(&QueryOptions {
            limit: Some(0),
            ..Default::default()
        });
        assert_eq!(zero_limit.items.len(), 5);
    }

    #[test]
    fn query_searches_username_and_message_with_json_escaping() {
        let dir = TempDir::new("search");
        let file = dir.file();
        let history = open(&file, HistoryOptions::default());

        history.append(serde_json::json!({ "id": "a", "timestamp": 1, "username": "Alice", "message": "hello" }));
        history.append(serde_json::json!({ "id": "b", "timestamp": 2, "username": "Bob", "message": "say \"hi\"" }));
        history.append(serde_json::json!({ "id": "c", "timestamp": 3, "username": "carol", "message": "back\\slash" }));
        history.append(serde_json::json!({ "id": "d", "timestamp": 4, "type": "specialkind", "username": "dave" }));
        history.flush();

        // Регистронезависимо и по нику, и по тексту.
        assert_eq!(query_ids(&history, search("ALICE")), ["a"]);
        assert_eq!(query_ids(&history, search("hi")), ["b"]);

        // Кавычки и обратный слэш в запросе находятся через JSON-экранирование.
        assert_eq!(query_ids(&history, search("say \"hi\"")), ["b"]);
        assert_eq!(query_ids(&history, search("back\\slash")), ["c"]);

        // Совпадение в неиндексируемом поле (type) не считается: сырой
        // предфильтр пропустил строку, но `match_entry` её отсеял.
        assert!(query_ids(&history, search("specialkind")).is_empty());
        assert!(query_ids(&history, search("nope")).is_empty());
    }

    #[test]
    fn query_includes_test_events_until_asked_otherwise() {
        let dir = TempDir::new("tests-flag");
        let file = dir.file();
        let history = open(&file, HistoryOptions::default());

        history.append(serde_json::json!({ "id": "real", "timestamp": 1, "is_test": false }));
        history.append(serde_json::json!({ "id": "test", "timestamp": 2, "is_test": true }));
        history.flush();

        assert_eq!(
            query_ids(&history, QueryOptions::default()),
            ["test", "real"]
        );
        assert_eq!(
            query_ids(
                &history,
                QueryOptions {
                    include_test: Some(false),
                    ..Default::default()
                }
            ),
            ["real"]
        );
    }

    #[test]
    fn get_by_id_finds_record_and_clear_empties_the_file() {
        let dir = TempDir::new("by-id");
        let file = dir.file();
        let history = open(&file, HistoryOptions::default());

        history.append(serde_json::json!({ "id": "x", "timestamp": 1 }));
        // Запись видна сразу, ещё до записи на диск.
        assert!(history.get_by_id(Some(&Value::from("x"))).is_some());
        history.flush();

        let found = history
            .get_by_id(Some(&Value::from("x")))
            .expect("запись есть");
        assert_eq!(found["id"], Value::from("x"));
        assert!(history.get_by_id(Some(&Value::from("nope"))).is_none());

        history.clear();
        history.flush();
        assert_eq!(history.count(), 0);
        assert!(read_lines(&file).is_empty());
    }

    #[test]
    fn replace_all_rewrites_the_file() {
        let dir = TempDir::new("replace-all");
        let file = dir.file();
        let history = open(&file, HistoryOptions::default());

        history.append(event("old", 1));
        history.flush();

        history.replace_all(vec![event("m1", 2), event("m2", 3)]);
        history.flush();

        let reopened = open(&file, HistoryOptions::default());
        assert_eq!(reopened.count(), 2);
        assert_eq!(line_ids(&file), ["m1", "m2"]);
    }

    #[test]
    fn corrupt_and_partial_lines_are_skipped() {
        let dir = TempDir::new("corrupt");
        let file = dir.file();
        fs::write(
            &file,
            "{\"id\":\"ok1\",\"timestamp\":1}\n{broken json\n{\"id\":\"ok2\",\"timestamp\":2}\n{\"id\":\"partial\"",
        )
        .unwrap();

        let history = open(&file, HistoryOptions::default());
        assert_eq!(history.count(), 2);
        assert_eq!(query_ids(&history, QueryOptions::default()), ["ok2", "ok1"]);
        // Смещения прочитанных строк считаются по байтам, а не по символам.
        assert!(history.get_by_id(Some(&Value::from("ok1"))).is_some());
        assert!(history.get_by_id(Some(&Value::from("ok2"))).is_some());
    }

    #[test]
    fn flush_sync_writes_the_queue_and_then_has_nothing_to_do() {
        let dir = TempDir::new("flush-sync");
        let file = dir.file();
        let history = open(&file, HistoryOptions::default());

        history.append(event("sync", 1));
        // Воркер может успеть записать сам — важно, что после сброса запись на диске.
        history.flush_sync();
        assert_eq!(line_ids(&file), ["sync"]);

        assert!(!history.flush_sync(), "очередь уже пуста");
    }

    #[test]
    fn max_records_bounds_the_memory_history() {
        let dir = TempDir::new("max-records");
        let file = dir.file();
        let history = open(
            &file,
            HistoryOptions {
                max_records: Some(3),
                ..Default::default()
            },
        );

        for index in 1..=5 {
            history.append(event(&format!("e{index}"), index));
        }
        history.flush();

        assert_eq!(history.count(), 3);
        assert_eq!(
            query_ids(&history, QueryOptions::default()),
            ["e5", "e4", "e3"]
        );
    }

    #[test]
    fn file_is_compacted_when_the_limit_is_exceeded() {
        let dir = TempDir::new("compact");
        let file = dir.file();
        let history = open(
            &file,
            HistoryOptions {
                max_records: Some(3),
                ..Default::default()
            },
        );

        for index in 1..=20 {
            history.append(event(&format!("e{index}"), index));
        }
        history.flush();

        // Файл не растёт линейно: держится в пределах max_records * 2.
        assert!(read_lines(&file).len() <= 6, "{:?}", read_lines(&file));
        assert_eq!(history.count(), 3);
        assert_eq!(
            query_ids(&history, QueryOptions::default()),
            ["e20", "e19", "e18"]
        );
        assert!(leftovers(&dir.0).is_empty());
    }

    #[test]
    fn reload_after_compaction_gives_the_same_tail() {
        let dir = TempDir::new("reload");
        let file = dir.file();
        let history = open(
            &file,
            HistoryOptions {
                max_records: Some(3),
                ..Default::default()
            },
        );
        for index in 1..=20 {
            history.append(event(&format!("e{index}"), index));
        }
        history.flush();

        let reopened = open(
            &file,
            HistoryOptions {
                max_records: Some(3),
                ..Default::default()
            },
        );
        assert_eq!(reopened.count(), 3);
        assert_eq!(
            query_ids(&reopened, QueryOptions::default()),
            ["e20", "e19", "e18"]
        );

        // Перезапись под тот же лимит оставляет в файле ровно хвост.
        reopened.set_max_records(Some(3));
        reopened.flush();
        assert_eq!(line_ids(&file), ["e18", "e19", "e20"]);
    }

    #[test]
    fn flush_sync_compacts_by_threshold() {
        let dir = TempDir::new("flush-sync-compact");
        let file = dir.file();
        let history = open(
            &file,
            HistoryOptions {
                max_records: Some(2),
                ..Default::default()
            },
        );

        for index in 1..=5 {
            history.append(event(&format!("e{index}"), index));
        }
        history.flush_sync();
        history.flush();

        assert!(read_lines(&file).len() <= 4, "{:?}", read_lines(&file));
        assert_eq!(history.count(), 2);
        assert!(leftovers(&dir.0).is_empty());
    }

    #[test]
    fn zero_max_records_disables_the_limit() {
        let dir = TempDir::new("no-limit");
        let file = dir.file();
        let history = open(
            &file,
            HistoryOptions {
                max_records: Some(0),
                ..Default::default()
            },
        );

        for index in 1..=50 {
            history.append(event(&format!("e{index}"), index));
        }
        history.flush();

        assert_eq!(history.count(), 50);
        assert_eq!(read_lines(&file).len(), 50);
    }

    #[test]
    fn remove_by_deletes_by_filter_and_rewrites_the_file() {
        let dir = TempDir::new("remove-by");
        let file = dir.file();
        let history = open(&file, HistoryOptions::default());

        history.append(serde_json::json!({ "id": "a", "timestamp": 1, "type": "donation" }));
        history.append(serde_json::json!({ "id": "b", "timestamp": 2, "type": "follow" }));
        history.append(serde_json::json!({ "id": "c", "timestamp": 3, "type": "donation" }));
        history.flush();

        let filter = QueryOptions {
            kind: Some(Value::from("donation")),
            ..Default::default()
        };
        assert_eq!(history.remove_by(&filter), 2);
        history.flush();
        assert_eq!(history.count(), 1);
        assert_eq!(line_ids(&file), ["b"]);

        assert_eq!(history.remove_by(&filter), 0);
    }

    #[test]
    fn set_max_records_applies_on_the_fly() {
        let dir = TempDir::new("set-max");
        let file = dir.file();
        let history = open(
            &file,
            HistoryOptions {
                max_records: Some(0),
                ..Default::default()
            },
        );
        for index in 1..=10 {
            history.append(event(&format!("e{index}"), index));
        }
        history.flush();
        assert_eq!(history.count(), 10);

        assert_eq!(history.set_max_records(Some(4)), 4);
        assert_eq!(history.count(), 4);
        assert_eq!(
            query_ids(&history, QueryOptions::default()),
            ["e10", "e9", "e8", "e7"]
        );
        history.flush();
        assert_eq!(read_lines(&file).len(), 4);
        assert_eq!(history.max_records(), 4);
    }

    /*
      Сбой записи (нет прав, диск кончился, файл занят) не должен терять события:
      они остаются видимыми в памяти и уходят в файл, как только диск вернётся.
    */
    #[test]
    fn failed_writes_do_not_lose_records() {
        let dir = TempDir::new("failed-writes");
        let file = dir.file();

        let broken = Arc::new(AtomicBool::new(true));
        let append: Arc<FileWriteFn> = {
            let broken = Arc::clone(&broken);
            Arc::new(move |file: &Path, content: &str| {
                if broken.load(AtomicOrdering::SeqCst) {
                    return Err(io::Error::other("диск недоступен"));
                }
                append_file(file, content)
            })
        };
        let history = open(
            &file,
            HistoryOptions {
                append: Some(append),
                retry_delay: Some(Duration::from_millis(5)),
                ..Default::default()
            },
        );

        history.append(event("a", 1));
        history.append(event("b", 2));
        history.flush();

        // Записи не потеряны: файл пуст, но из памяти они видны полностью.
        assert!(read_lines(&file).is_empty());
        assert_eq!(history.count(), 2);
        assert_eq!(query_ids(&history, QueryOptions::default()), ["b", "a"]);
        assert!(history.last_error().is_some());

        // Файл снова доступен — очередь доходит до диска.
        broken.store(false, AtomicOrdering::SeqCst);
        history.flush();
        assert_eq!(line_ids(&file), ["a", "b"]);
    }

    #[test]
    fn query_filters_by_session_id() {
        let dir = TempDir::new("session");
        let file = dir.file();
        let history = open(&file, HistoryOptions::default());

        history.append(serde_json::json!({ "id": "m1", "timestamp": 1, "sessionId": "s1" }));
        history.append(serde_json::json!({ "id": "m2", "timestamp": 2, "sessionId": "s2" }));
        history.append(serde_json::json!({ "id": "m3", "timestamp": 3, "sessionId": "s1" }));
        history.flush();

        let page = history.query(&QueryOptions {
            session_id: Some(Value::from("s1")),
            ..Default::default()
        });
        assert_eq!(ids(&page), ["m3", "m1"]);
        assert_eq!(history.all().len(), 3);
    }

    #[test]
    fn query_filters_by_time_boundary() {
        let dir = TempDir::new("since");
        let file = dir.file();
        let history = open(&file, HistoryOptions::default());

        history.append(serde_json::json!({ "id": "old-1", "timestamp": 1000, "type": "donation" }));
        history.append(serde_json::json!({ "id": "old-2", "timestamp": 2000, "type": "donation" }));
        history.append(serde_json::json!({ "id": "new-1", "timestamp": 3000, "type": "donation" }));
        history.append(serde_json::json!({ "id": "new-2", "timestamp": 4000, "type": "donation" }));
        history.flush();

        let page = history.query(&QueryOptions {
            kind: Some(Value::from("donation")),
            since: Some(2500.0),
            ..Default::default()
        });
        assert_eq!(ids(&page), ["new-2", "new-1"]);
        // total — это число записей под фильтром, а не всей истории.
        assert_eq!(page.total, 2);

        // Граница включительна, а ноль означает «ограничения нет».
        assert_eq!(
            query_ids(
                &history,
                QueryOptions {
                    since: Some(3000.0),
                    ..Default::default()
                }
            ),
            ["new-2", "new-1"]
        );
        assert_eq!(
            history
                .query(&QueryOptions {
                    since: Some(0.0),
                    ..Default::default()
                })
                .total,
            4
        );
    }

    #[test]
    fn drop_writes_the_queue_before_leaving() {
        let dir = TempDir::new("drop");
        let file = dir.file();
        {
            let history = open(&file, HistoryOptions::default());
            history.append(event("bye", 1));
            // Без flush: остаток должен уйти на диск при остановке.
        }
        assert_eq!(line_ids(&file), ["bye"]);
    }

    #[test]
    fn compaction_temp_file_is_named_for_the_sweep() {
        let path = temp_path(Path::new("C:/app/config/local-db.jsonl"));
        assert_eq!(path.parent(), Some(Path::new("C:/app/config")));
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(".local-db.jsonl."), "{name}");
        assert!(name.ends_with(".tmp"), "{name}");
    }

    #[test]
    fn max_records_from_json_matches_the_js_rule() {
        // Явный ноль и `false`/`null` из настроек отключают лимит.
        assert_eq!(max_records_from_json(Some(&Value::from(0))), Some(0));
        assert_eq!(max_records_from_json(Some(&Value::Bool(false))), Some(0));
        assert_eq!(max_records_from_json(Some(&Value::Null)), Some(0));
        assert_eq!(max_records_from_json(Some(&Value::from(1500))), Some(1500));
        assert_eq!(
            max_records_from_json(Some(&Value::from(1500.7))),
            Some(1500)
        );
        // Отсутствие значения и мусор — умолчание.
        assert_eq!(max_records_from_json(None), None);
        assert_eq!(max_records_from_json(Some(&Value::from(-5))), None);
        assert_eq!(max_records_from_json(Some(&Value::from("abc"))), None);
        assert_eq!(resolve_max_records(None), DEFAULT_MAX_RECORDS);
    }

    #[test]
    fn js_helpers_follow_the_script_semantics() {
        // `String(number)` печатает целое без дробной части.
        assert_eq!(js_key(&Value::from(1.0)), "1");
        assert_eq!(js_key(&Value::from(1.5)), "1.5");
        // `Number(x) || 0`: строка разбирается, а время из мусора — ноль.
        assert_eq!(js_number_or_zero(Some(&Value::from("12"))), 12.0);
        assert_eq!(js_number_or_zero(Some(&Value::from("abc"))), 0.0);
        assert_eq!(js_number_or_zero(None), 0.0);
        // Правдивость: пустая строка и ноль ложны, объекты истинны.
        assert!(!js_truthy(Some(&Value::from(""))));
        assert!(!js_truthy(Some(&Value::from(0))));
        assert!(js_truthy(Some(&serde_json::json!({}))));
    }
}
