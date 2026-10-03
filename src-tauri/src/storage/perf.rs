//! Наблюдатель за задержками: лаг таймера и строки отчёта о нём.
//!
//! Порт `server/perf-monitor.js`. Вопрос, на который он отвечает, звучит так:
//! «почему отстал чат или оверлей?» — и ответ нужен данными, а не догадками.
//! В Electron мерили задержку event loop (`monitorEventLoopDelay`), здесь —
//! опоздание срабатывания таймера относительно расписания: это то же самое
//! «насколько процесс отвлёкся от своих дел», только измеренное снаружи.
//!
//! Здесь живёт **арифметика и формат**: накопление замеров, перцентили и строка
//! отчёта. Кто и когда ставит таймер и как считает опоздание — забота
//! вызывающего (у нас это цикл на tokio), потому что единственного event loop,
//! как в Node, в Rust нет.
//!
//! Строка пишется только когда за интервал был заметный затык: в простое журнал
//! не должен шуметь.

use std::time::Duration;

/// Как часто подводим итог, если вызывающий не сказал иначе.
pub const DEFAULT_INTERVAL_MS: u64 = 60_000;

/// С какого опоздания считаем, что был затык.
pub const DEFAULT_THRESHOLD_MS: f64 = 20.0;

/// Накопитель замеров за интервал.
#[derive(Debug, Default)]
pub struct LagMonitor {
    threshold_ms: f64,
    label: String,
    samples: Vec<f64>,
}

impl LagMonitor {
    pub fn new(label: &str, threshold_ms: Option<f64>) -> Self {
        Self {
            // Порог из настроек: отрицательный или мусорный смысла не имеет.
            threshold_ms: threshold_ms
                .filter(|value| value.is_finite() && *value >= 0.0)
                .unwrap_or(DEFAULT_THRESHOLD_MS),
            label: label.to_string(),
            samples: Vec::new(),
        }
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn threshold_ms(&self) -> f64 {
        self.threshold_ms
    }

    /// Записать опоздание одного срабатывания.
    pub fn record(&mut self, late: Duration) {
        self.samples.push(late.as_secs_f64() * 1000.0);
    }

    /// Записать опоздание в миллисекундах.
    pub fn record_ms(&mut self, late_ms: f64) {
        if late_ms.is_finite() && late_ms >= 0.0 {
            self.samples.push(late_ms);
        }
    }

    pub fn samples(&self) -> usize {
        self.samples.len()
    }

    /// Снимок за интервал: перцентили и максимум.
    ///
    /// Пустая выборка даёт нули — так же, как пустая гистограмма в JS отдавала
    /// `NaN`, который там приводили к нулю.
    pub fn snapshot(&self) -> LagSnapshot {
        LagSnapshot {
            p50: self.percentile(50.0),
            p99: self.percentile(99.0),
            max: self.maximum(),
            mean: self.mean(),
        }
    }

    /// Строка отчёта; `None` — затыка не было, писать нечего.
    ///
    /// Заодно очищает накопленное: строка пишется один раз на интервал.
    pub fn report(&mut self) -> Option<String> {
        let snapshot = self.snapshot();
        self.samples.clear();
        if snapshot.max < self.threshold_ms {
            return None;
        }
        Some(format!(
            "[perf] {}: p50 {:.1} ms, p99 {:.1} ms, max {:.1} ms (порог {} ms)",
            self.label, snapshot.p50, snapshot.p99, snapshot.max, self.threshold_ms
        ))
    }

    /// Перцентиль по накопленным замерам (0 — замеров нет).
    pub fn percentile(&self, percent: f64) -> f64 {
        if self.samples.is_empty() {
            return 0.0;
        }
        let mut sorted = self.samples.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let rank = (percent.clamp(0.0, 100.0) / 100.0) * (sorted.len() - 1) as f64;
        let index = rank.round() as usize;
        sorted[index.min(sorted.len() - 1)]
    }

    pub fn maximum(&self) -> f64 {
        self.samples.iter().copied().fold(0.0, f64::max)
    }

    pub fn mean(&self) -> f64 {
        if self.samples.is_empty() {
            return 0.0;
        }
        self.samples.iter().sum::<f64>() / self.samples.len() as f64
    }
}

/// Снимок замеров за интервал.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LagSnapshot {
    pub p50: f64,
    pub p99: f64,
    pub max: f64,
    pub mean: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_when_the_peak_is_below_the_threshold() {
        let mut monitor = LagMonitor::new("event loop", None);
        monitor.record_ms(1.0);
        monitor.record_ms(3.5);

        assert!(monitor.report().is_none());
        // Замеры за интервал сбрасываются даже тогда, когда строку не писали.
        assert_eq!(monitor.samples(), 0);
    }

    #[test]
    fn spike_above_the_threshold_produces_a_line() {
        let mut monitor = LagMonitor::new("event loop", Some(20.0));
        for value in [1.0, 2.0, 3.0, 120.0] {
            monitor.record_ms(value);
        }

        let line = monitor.report().expect("затык должен быть виден");
        assert!(line.contains("[perf] event loop:"), "{line}");
        assert!(line.contains("max 120.0 ms"), "{line}");
        assert!(line.contains("(порог 20 ms)"), "{line}");
        assert_eq!(monitor.samples(), 0);
    }

    #[test]
    fn snapshot_reports_percentiles_max_and_mean() {
        let mut monitor = LagMonitor::new("timer", None);
        for value in 1..=100 {
            monitor.record_ms(value as f64);
        }

        let snapshot = monitor.snapshot();
        assert!(snapshot.max == 100.0);
        assert!((snapshot.mean - 50.5).abs() < 0.001, "{snapshot:?}");
        // Перцентиль берётся по замеру рядом с медианой: важно, что «типичное»
        // опоздание отличается от затыка.
        assert!((49.0..=51.0).contains(&snapshot.p50), "{snapshot:?}");
        assert!((98.0..=100.0).contains(&snapshot.p99), "{snapshot:?}");
    }

    #[test]
    fn empty_monitor_gives_zeros_not_nan() {
        let monitor = LagMonitor::new("event loop", None);

        let snapshot = monitor.snapshot();
        assert_eq!(
            snapshot,
            LagSnapshot {
                p50: 0.0,
                p99: 0.0,
                max: 0.0,
                mean: 0.0
            }
        );
    }

    #[test]
    fn broken_threshold_and_samples_do_not_break_it() {
        let mut monitor = LagMonitor::new("event loop", Some(f64::NAN));
        assert_eq!(monitor.threshold_ms(), DEFAULT_THRESHOLD_MS);

        monitor.record_ms(f64::NAN);
        monitor.record_ms(-5.0);
        monitor.record(Duration::from_millis(30));

        assert_eq!(monitor.samples(), 1);
        assert!(monitor.report().is_some());
    }

    #[test]
    fn label_is_kept_as_given() {
        let monitor = LagMonitor::new("терминал", Some(10.0));
        assert_eq!(monitor.label(), "терминал");
        assert_eq!(monitor.threshold_ms(), 10.0);
    }
}
