//! Наблюдатель за долгим прогоном: память, клиенты и переподключения.
//!
//! Порт `server/longrun-monitor.js`. Стрим идёт часами, и вопросы «не течёт ли
//! память», «сколько раз ночью падал чат», «стало ли хуже к концу эфира»
//! юнит-тестами не ловятся — для них нужен след по времени. Раз в интервал
//! (по умолчанию 10 минут) снимается один образец: время работы, память, клиенты
//! WebSocket, число переподключений и пик задержки. Образцы копятся в кольцевом
//! буфере (последние 24 — это четыре часа), а из них считается скорость роста.
//!
//! Строка `[longrun] …` пишется только когда что-то заслуживает внимания:
//! заметный рост памяти на последних образцах или новые переподключения. В
//! простое журнал молчит, как и остальная телеметрия.
//!
//! Модуль не знает, откуда берутся цифры: их приносит `sample()`. Кто и как часто
//! зовёт `report` — забота вызывающего (у нас это цикл на tokio), поэтому таймера
//! внутри нет и останавливать нечего.
//!
//! Ориентир для «роста»: долгие сессии в десятках мегабайт — норма, но устойчивые
//! +150 МБ в час означают утечку или накопление подписок, и это уже повод
//! разбираться.

use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use super::crash_guard;
use super::history::{js_number_or_zero, number_value};
use super::logger::LogFn;

/// Как часто снимаем образец, если вызывающий не сказал иначе.
pub const DEFAULT_EVERY_MS: u64 = 10 * 60 * 1000;

/// Сколько образцов держим — четыре часа при десятиминутном интервале.
pub const DEFAULT_HISTORY: usize = 24;

/// Порог, с которого рост памяти считается тревожным (МБ в час).
pub const GROWTH_WARN_MB_PER_HOUR: f64 = 150.0;

/// Замер памяти в байтах — как `process.memoryUsage()`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MemoryBytes {
    pub rss: u64,
    /// Управляемой кучи, как в Node, в Rust нет: сюда попадает тот же рабочий
    /// набор, чтобы окно диагностики не показывало ноль. Отдельная метрика
    /// появится, только если понадобится аллокатор со своим учётом.
    pub heap_used: u64,
}

/// Что монитор берёт извне: клиентов, переподключения и пик задержки.
#[derive(Debug, Clone, Default)]
pub struct SampleExtra {
    pub ws_clients: u64,
    pub reconnects: Map<String, Value>,
    pub lag_max_ms: f64,
}

pub type SampleFn = dyn Fn() -> SampleExtra + Send + Sync + 'static;
pub type MemoryFn = dyn Fn() -> MemoryBytes + Send + Sync + 'static;
/// Часы — подменяются в тестах, чтобы образцы были предсказуемыми.
pub type ClockFn = dyn Fn() -> i64 + Send + Sync + 'static;

/// Настройки наблюдателя. `None` у любого поля — умолчание; так вызывающему не
/// нужно знать про каждый параметр, который ему не важен.
#[derive(Default)]
pub struct LongRunOptions {
    pub every_ms: Option<u64>,
    pub history: Option<usize>,
    /// Что приносит данные извне: клиенты, переподключения, пик задержки.
    pub sample: Option<Arc<SampleFn>>,
    pub memory: Option<Arc<MemoryFn>>,
    pub clock: Option<Arc<ClockFn>>,
    pub log: Option<Arc<LogFn>>,
    pub growth_warn_mb_per_hour: Option<f64>,
}

/// Один образец: когда снят и что показал.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Sample {
    pub at: i64,
    pub uptime_sec: i64,
    pub rss_mb: u64,
    pub heap_used_mb: u64,
    pub ws_clients: u64,
    pub reconnects: Map<String, Value>,
    pub lag_max_ms: f64,
}

impl Sample {
    pub fn to_json(&self) -> Value {
        json!({
            "at": self.at,
            "uptimeSec": self.uptime_sec,
            "rssMb": self.rss_mb,
            "heapUsedMb": self.heap_used_mb,
            "wsClients": self.ws_clients,
            "reconnects": Value::Object(self.reconnects.clone()),
            "lagMaxMs": number_value(self.lag_max_ms),
        })
    }

    /// Сумма переподключений по всем сервисам.
    pub fn reconnects_total(&self) -> f64 {
        reconnects_total(Some(&self.reconnects))
    }
}

/// Сводка для отчёта о состоянии и экспорта.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LongRunSnapshot {
    pub uptime_sec: i64,
    pub every_ms: u64,
    pub samples: usize,
    pub rss_mb: u64,
    pub heap_used_mb: u64,
    pub peak_rss_mb: u64,
    pub peak_heap_used_mb: u64,
    pub ws_clients: u64,
    pub reconnects: Map<String, Value>,
    pub reconnects_total: f64,
    pub growth_mb_per_hour: f64,
    pub lag_max_ms: f64,
    pub history: Vec<Sample>,
}

impl LongRunSnapshot {
    pub fn to_json(&self) -> Value {
        json!({
            "uptimeSec": self.uptime_sec,
            "everyMs": self.every_ms,
            "samples": self.samples,
            "rssMb": self.rss_mb,
            "heapUsedMb": self.heap_used_mb,
            "peakRssMb": self.peak_rss_mb,
            "peakHeapUsedMb": self.peak_heap_used_mb,
            "wsClients": self.ws_clients,
            "reconnects": Value::Object(self.reconnects.clone()),
            "reconnectsTotal": number_value(self.reconnects_total),
            "growthMbPerHour": number_value(self.growth_mb_per_hour),
            "lagMaxMs": number_value(self.lag_max_ms),
            "history": self.history.iter().map(Sample::to_json).collect::<Vec<_>>(),
        })
    }
}

/// Наблюдатель за долгим прогоном.
pub struct LongRunMonitor {
    every_ms: u64,
    history_size: usize,
    growth_warn: f64,
    started_at: i64,
    sample: Option<Arc<SampleFn>>,
    memory: Arc<MemoryFn>,
    clock: Arc<ClockFn>,
    log: Option<Arc<LogFn>>,
    samples: Mutex<Vec<Sample>>,
    peaks: Mutex<(u64, u64)>,
    last_report: Mutex<Option<Sample>>,
}

impl LongRunMonitor {
    pub fn new(options: LongRunOptions) -> Self {
        let clock: Arc<ClockFn> = options
            .clock
            .unwrap_or_else(|| Arc::new(|| chrono::Utc::now().timestamp_millis()));
        Self {
            every_ms: options
                .every_ms
                .filter(|value| *value > 0)
                .unwrap_or(DEFAULT_EVERY_MS),
            history_size: options
                .history
                .filter(|value| *value > 0)
                .unwrap_or(DEFAULT_HISTORY),
            growth_warn: options
                .growth_warn_mb_per_hour
                .filter(|value| value.is_finite())
                .unwrap_or(GROWTH_WARN_MB_PER_HOUR),
            started_at: clock(),
            sample: options.sample,
            memory: options.memory.unwrap_or_else(|| Arc::new(default_memory)),
            clock,
            log: options.log,
            samples: Mutex::new(Vec::new()),
            peaks: Mutex::new((0, 0)),
            last_report: Mutex::new(None),
        }
    }

    /// Текущее время по подменяемым часам.
    fn now(&self) -> i64 {
        (self.clock)()
    }

    /// Снять образец, записать строку при поводе и запомнить его как последний.
    ///
    /// `force` — писать всегда (отчёт по кнопке): тогда строка появляется и в
    /// благополучном состоянии.
    pub fn report(&self, force: bool) -> Sample {
        let entry = self.take_sample();
        let previous = {
            let samples = self.samples();
            if samples.len() > 1 {
                Some(samples[samples.len() - 2].clone())
            } else {
                None
            }
        };

        let reasons = self.evaluate(&entry, previous.as_ref());
        if !reasons.is_empty() || force {
            let line = format!(
                "[longrun] {:.1} ч, rss {} MB (пик {}), heap {} MB, WS {}, переподключений {}",
                entry.uptime_sec as f64 / 3600.0,
                entry.rss_mb,
                self.peaks().0,
                entry.heap_used_mb,
                entry.ws_clients,
                entry.reconnects_total() as u64
            );
            let line = if reasons.is_empty() {
                line
            } else {
                format!("{line} — {}", reasons.join("; "))
            };
            self.log(&line);
        }

        *self
            .last_report
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(entry.clone());
        entry
    }

    /// Сводка: последние значения, пики, рост и вся история образцов.
    pub fn snapshot(&self) -> LongRunSnapshot {
        let samples = self.samples();
        let latest = samples.last().cloned();
        let current = (self.memory)();
        let peaks = self.peaks();
        let reconnects = latest
            .as_ref()
            .map(|sample| sample.reconnects.clone())
            .unwrap_or_default();

        LongRunSnapshot {
            uptime_sec: (self.now() - self.started_at) / 1000,
            every_ms: self.every_ms,
            samples: samples.len(),
            // Образцов нет — показываем, сколько памяти занято сейчас.
            rss_mb: latest
                .as_ref()
                .map(|sample| sample.rss_mb)
                .unwrap_or_else(|| mb(current.rss)),
            heap_used_mb: latest
                .as_ref()
                .map(|sample| sample.heap_used_mb)
                .unwrap_or_else(|| mb(current.heap_used)),
            peak_rss_mb: peaks.0,
            peak_heap_used_mb: peaks.1,
            ws_clients: latest.as_ref().map(|sample| sample.ws_clients).unwrap_or(0),
            reconnects_total: reconnects_total(Some(&reconnects)),
            reconnects,
            growth_mb_per_hour: memory_growth_mb_per_hour(&samples),
            lag_max_ms: latest
                .as_ref()
                .map(|sample| sample.lag_max_ms)
                .unwrap_or(0.0),
            history: samples,
        }
    }

    /// Последний снятый образец.
    pub fn last_report(&self) -> Option<Sample> {
        self.last_report
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn take_sample(&self) -> Sample {
        let memory = (self.memory)();
        let extra = match &self.sample {
            Some(sample) => sample(),
            None => SampleExtra::default(),
        };
        let entry = Sample {
            at: self.now(),
            uptime_sec: (self.now() - self.started_at) / 1000,
            rss_mb: mb(memory.rss),
            heap_used_mb: mb(memory.heap_used),
            ws_clients: extra.ws_clients,
            reconnects: extra.reconnects,
            lag_max_ms: round(extra.lag_max_ms),
        };

        {
            let mut samples = self
                .samples
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            samples.push(entry.clone());
            while samples.len() > self.history_size {
                samples.remove(0);
            }
        }
        {
            let mut peaks = self.peaks.lock().unwrap_or_else(|error| error.into_inner());
            peaks.0 = peaks.0.max(entry.rss_mb);
            peaks.1 = peaks.1.max(entry.heap_used_mb);
        }
        entry
    }

    /// Что стоит записать в журнал и почему.
    fn evaluate(&self, entry: &Sample, previous: Option<&Sample>) -> Vec<String> {
        let mut reasons = Vec::new();
        let samples = self.samples();
        let growth = memory_growth_mb_per_hour(&samples);
        // По одному-двум образцам вывода о росте не сделать.
        if samples.len() >= 3 && growth >= self.growth_warn {
            reasons.push(format!(
                "рост памяти {growth} MB/ч (порог {})",
                self.growth_warn
            ));
        }

        let total = entry.reconnects_total();
        if let Some(previous) = previous {
            let previous_total = previous.reconnects_total();
            if total - previous_total > 0.0 {
                reasons.push(format!(
                    "переподключений всего {} (+{})",
                    total as u64,
                    (total - previous_total) as u64
                ));
            }
        }
        reasons
    }

    fn samples(&self) -> Vec<Sample> {
        self.samples
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn peaks(&self) -> (u64, u64) {
        *self.peaks.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn log(&self, line: &str) {
        match &self.log {
            Some(log) => log(line),
            None => println!("{line}"),
        }
    }
}

/// Скорость роста памяти по образцам, МБ в час.
///
/// Берём самый ранний и самый поздний образец: разницу делим на прошедшее время.
/// Считаем по рабочему набору — он не прыгает так, как это делает куча с
/// сборщиком мусора. Отрицательный рост (память вернулась) — тоже ответ.
pub fn memory_growth_mb_per_hour(samples: &[Sample]) -> f64 {
    let Some(first) = samples.first() else {
        return 0.0;
    };
    if samples.len() < 2 {
        return 0.0;
    }
    let last = samples.last().unwrap_or(first);
    let hours = (last.at - first.at) as f64 / 3_600_000.0;
    if hours <= 0.0 {
        return 0.0;
    }
    round((last.rss_mb as f64 - first.rss_mb as f64) / hours)
}

/// Сумма переподключений по всем сервисам.
pub fn reconnects_total(reconnects: Option<&Map<String, Value>>) -> f64 {
    reconnects
        .map(|fields| {
            fields
                .values()
                .map(|value| js_number_or_zero(Some(value)))
                .sum()
        })
        .unwrap_or(0.0)
}

/// Память процесса: рабочий набор из обработчика падений (там же платформенный код).
fn default_memory() -> MemoryBytes {
    let rss = crash_guard::memory_rss_mb()
        .map(|mb| mb * 1_048_576)
        .unwrap_or(0);
    MemoryBytes {
        rss,
        heap_used: rss,
    }
}

/// Байты в мегабайты, как `mb()` в JS: `Math.round(bytes / 1048576)`.
fn mb(bytes: u64) -> u64 {
    (bytes as f64 / 1_048_576.0).round() as u64
}

/// Округление до десятых, как `Number(x.toFixed(1))`.
fn round(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn sample_at(minutes: i64, rss_mb: u64) -> Sample {
        Sample {
            at: minutes * 60_000,
            rss_mb,
            ..Sample::default()
        }
    }

    /// Монитор с подменёнными часами и измерением памяти и предсказуемым `sample()`.
    struct Harness {
        monitor: LongRunMonitor,
        lines: Arc<Mutex<Vec<String>>>,
        rss: Arc<AtomicU64>,
        reconnects: Arc<AtomicU64>,
    }

    fn harness(history: Option<usize>, rss_mb: u64, reconnects: u64) -> Harness {
        let rss = Arc::new(AtomicU64::new(rss_mb));
        let reconnects = Arc::new(AtomicU64::new(reconnects));
        let lines = Arc::new(Mutex::new(Vec::new()));

        let memory: Arc<MemoryFn> = {
            let rss = Arc::clone(&rss);
            Arc::new(move || MemoryBytes {
                rss: rss.load(Ordering::SeqCst) * 1_048_576,
                heap_used: rss.load(Ordering::SeqCst) * 1_048_576 / 2,
            })
        };
        let sample: Arc<SampleFn> = {
            let reconnects = Arc::clone(&reconnects);
            Arc::new(move || SampleExtra {
                ws_clients: 2,
                reconnects: Map::from_iter([(
                    "twitchChat".to_string(),
                    json!(reconnects.load(Ordering::SeqCst)),
                )]),
                lag_max_ms: 12.0,
            })
        };
        let log: Arc<LogFn> = {
            let lines = Arc::clone(&lines);
            Arc::new(move |line: &str| lines.lock().unwrap().push(line.to_string()))
        };
        // Часы идут по 10 минут вперёд на каждый замер: так рост памяти
        // считается в мегабайтах в час без зависимости от скорости машины.
        let ticks = Arc::new(AtomicU64::new(0));
        let clock: Arc<ClockFn> = {
            let ticks = Arc::clone(&ticks);
            Arc::new(move || (ticks.fetch_add(1, Ordering::SeqCst) * 600_000) as i64)
        };

        Harness {
            monitor: LongRunMonitor::new(LongRunOptions {
                every_ms: Some(600_000),
                history,
                sample: Some(sample),
                memory: Some(memory),
                clock: Some(clock),
                log: Some(log),
                growth_warn_mb_per_hour: None,
            }),
            lines,
            rss,
            reconnects,
        }
    }

    impl Harness {
        fn lines(&self) -> Vec<String> {
            self.lines.lock().unwrap().clone()
        }
    }

    #[test]
    fn growth_needs_two_points_and_counts_megabytes_per_hour() {
        assert_eq!(memory_growth_mb_per_hour(&[]), 0.0);
        assert_eq!(memory_growth_mb_per_hour(&[sample_at(0, 100)]), 0.0);
        // 60 МБ за полчаса = 120 МБ/ч.
        assert_eq!(
            memory_growth_mb_per_hour(&[sample_at(0, 100), sample_at(30, 160)]),
            120.0
        );
        // Стабильная память и её снижение — тоже ответ.
        assert_eq!(
            memory_growth_mb_per_hour(&[sample_at(0, 120), sample_at(60, 120)]),
            0.0
        );
        assert_eq!(
            memory_growth_mb_per_hour(&[sample_at(0, 200), sample_at(60, 150)]),
            -50.0
        );
        // Нулевой интервал — не повод делить на ноль.
        assert_eq!(
            memory_growth_mb_per_hour(&[sample_at(10, 100), sample_at(10, 300)]),
            0.0
        );
    }

    #[test]
    fn the_first_sample_is_taken_by_the_report_call() {
        let harness = harness(None, 100, 1);
        harness.monitor.report(true);

        let snapshot = harness.monitor.snapshot();
        assert_eq!(snapshot.samples, 1);
        assert_eq!(snapshot.rss_mb, 100);
        assert_eq!(snapshot.ws_clients, 2);
        assert_eq!(snapshot.reconnects["twitchChat"], json!(1));
        assert_eq!(snapshot.reconnects_total, 1.0);
        assert_eq!(snapshot.lag_max_ms, 12.0);
        assert_eq!(snapshot.every_ms, 600_000);
    }

    #[test]
    fn silence_while_nothing_happens_and_a_line_on_force() {
        let harness = harness(None, 100, 0);

        harness.monitor.report(false);
        // Первый образец — предыдущего нет, поводов писать нет.
        assert!(harness.lines().is_empty(), "{:?}", harness.lines());

        harness.monitor.report(true);
        let lines = harness.lines();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("[longrun]"), "{}", lines[0]);
        assert!(lines[0].contains("rss"), "{}", lines[0]);
    }

    #[test]
    fn reconnects_show_up_in_the_line_and_in_the_snapshot() {
        let harness = harness(None, 100, 3);

        harness.monitor.report(false);
        harness.reconnects.store(9, Ordering::SeqCst);
        harness.monitor.report(false);

        let lines = harness.lines();
        assert!(!lines.is_empty());
        assert!(
            lines[lines.len() - 1].contains("переподключений всего 9"),
            "{}",
            lines[lines.len() - 1]
        );
        assert_eq!(harness.monitor.snapshot().reconnects_total, 9.0);
    }

    #[test]
    fn memory_growth_is_reported_only_from_three_samples() {
        let harness = harness(None, 100, 0);

        harness.monitor.report(false);
        harness.rss.store(200, Ordering::SeqCst);
        harness.monitor.report(false);
        // Два образца — это ещё не тенденция.
        assert!(harness.lines().is_empty(), "{:?}", harness.lines());

        harness.monitor.report(false);
        let lines = harness.lines();
        assert!(
            lines.iter().any(|line| line.contains("рост памяти")),
            "{lines:?}"
        );
    }

    #[test]
    fn sample_history_is_bounded_by_the_buffer() {
        let harness = harness(Some(3), 100, 0);
        for _ in 0..6 {
            harness.monitor.report(false);
        }

        let snapshot = harness.monitor.snapshot();
        assert_eq!(snapshot.samples, 3);
        assert_eq!(snapshot.history.len(), 3);
    }

    #[test]
    fn the_peak_is_remembered_even_when_memory_goes_down() {
        let harness = harness(None, 100, 0);
        harness.monitor.report(false);
        harness.rss.store(120, Ordering::SeqCst);
        harness.monitor.report(false);
        harness.rss.store(90, Ordering::SeqCst);
        harness.monitor.report(false);

        let snapshot = harness.monitor.snapshot();
        assert_eq!(snapshot.rss_mb, 90);
        assert_eq!(snapshot.peak_rss_mb, 120);
        assert_eq!(snapshot.peak_heap_used_mb, 60);
    }

    #[test]
    fn snapshot_and_last_report_are_json_ready() {
        let harness = harness(None, 100, 2);
        let entry = harness.monitor.report(false);

        assert_eq!(harness.monitor.last_report().map(|s| s.at), Some(entry.at));
        let json = harness.monitor.snapshot().to_json();
        assert_eq!(json["reconnectsTotal"], json!(2));
        assert_eq!(json["wsClients"], json!(2));
        assert_eq!(json["history"].as_array().map(Vec::len), Some(1));
        assert!(json["uptimeSec"].is_number());
    }

    #[test]
    fn reconnects_total_sums_all_services() {
        let fields = Map::from_iter([
            ("twitchChat".to_string(), json!(3)),
            ("donationAlerts".to_string(), json!("2")),
            ("obs".to_string(), json!(null)),
        ]);
        assert_eq!(reconnects_total(Some(&fields)), 5.0);
        assert_eq!(reconnects_total(None), 0.0);
    }
}
