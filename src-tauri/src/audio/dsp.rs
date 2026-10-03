//! Конвейер микрофона: что именно видит оверлей — уровень, осциллограмма, спектр.
//!
//! Порт из `control.js` (`micBridge.tick`) вместе с настройками `AnalyserNode`:
//! `fftSize` 2048, сглаживание спектра 0.6, шкала −100…−30 дБ, окно Блэкмана.
//!
//! Точность по частям разная, и это важно понимать:
//!
//! - **Уровень, осциллограмма и нарезка спектра** совпадают с Electron-версией
//!   точно: это арифметика над байтами, и её значения сверены с JS (см. тесты и
//!   `matches_electron_reference_values` в `super`).
//! - **Сам спектр** (преобразование Фурье) — приближение к `AnalyserNode`: окно,
//!   нормировка и сглаживание повторены по спецификации Web Audio, но побитового
//!   совпадения с реализацией Blink не обещаем. Оверлей рисует по спектру полосы,
//!   и одна и та же музыка даёт один и тот же «рисунок», а не одни и те же байты.

use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};

use super::frame::{FREQ_LEN, WAVE_LEN};

/// Размер преобразования — `analyser.fftSize` из `control.js`.
pub const FFT_SIZE: usize = 2048;
/// Сколько бинов отдаёт анализатор (`frequencyBinCount`).
pub const BINS: usize = FFT_SIZE / 2;
/// Постоянная сглаживания — `analyser.smoothingTimeConstant`.
pub const SMOOTHING: f32 = 0.6;
/// Нижняя граница шкалы `AnalyserNode` (значение по умолчанию Web Audio).
pub const MIN_DB: f32 = -100.0;
/// Верхняя граница шкалы `AnalyserNode` (значение по умолчанию Web Audio).
pub const MAX_DB: f32 = -30.0;

/// Доля спектра, которая считается «рабочей» (в JS: `floor(fl * 0.8)`).
fn usable_bins() -> usize {
    (BINS * 8 / 10).max(8)
}

/// Осциллограмма: 240 байт из кадра — как `w[i] = d[floor((i / 240) * dl)]`.
pub fn wave_bytes(time: &[u8], out: &mut [u8; WAVE_LEN]) {
    if time.is_empty() {
        out.fill(128); // нет данных — ровная середина, как у пустого кадра
        return;
    }
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = time[i * time.len() / WAVE_LEN];
    }
}

/// Уровень: среднеквадратичное по всему кадру — как в `micBridge.tick`.
///
/// Считается по **байтам** (не по отсчётам) — ровно как в JS, иначе значения
/// разъехались бы с Electron-версией.
pub fn level(time: &[u8]) -> f32 {
    if time.is_empty() {
        return 0.0;
    }
    let sum: f64 = time
        .iter()
        .map(|&byte| {
            let value = (f64::from(byte) - 128.0) / 128.0;
            value * value
        })
        .sum();
    (sum / time.len() as f64).sqrt() as f32
}

/// Спектр: 128 байт из «рабочей» части — как `fr[i] = f[floor((i / fn) * (usable - 1))]`.
pub fn freq_bytes(spectrum: &[u8], out: &mut [u8; FREQ_LEN]) {
    if spectrum.is_empty() {
        out.fill(0);
        return;
    }
    let usable = usable_bins().min(spectrum.len());
    let last = usable - 1;
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = spectrum[i * last / FREQ_LEN];
    }
}

/// Отсчёты звука 0..1 → байты осциллограммы, как `getByteTimeDomainData`.
///
/// Значение — `128 * (отсчёт + 1)` с усечением: так же считает Blink (не
/// округление: 0.5 даёт ровно 192, а 0.004 — 128, а не 129).
pub fn time_bytes(samples: &[f32], out: &mut [u8; FFT_SIZE]) {
    for (i, slot) in out.iter_mut().enumerate() {
        let sample = samples.get(i).copied().unwrap_or(0.0);
        *slot = (128.0 * (sample + 1.0)).clamp(0.0, 255.0) as u8;
    }
}

/// Аналог `AnalyserNode`: помнит сглаженный спектр между кадрами.
pub struct Analyser {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    buffer: Vec<Complex<f32>>,
    smoothed: Vec<f32>,
    bytes: Vec<u8>,
}

impl Default for Analyser {
    fn default() -> Self {
        Self::new()
    }
}

impl Analyser {
    pub fn new() -> Self {
        let mut planner = FftPlanner::new();
        // Окно Блэкмана — то же, что применяет AnalyserNode (α = 0.16).
        let window = (0..FFT_SIZE)
            .map(|i| {
                let x = std::f32::consts::TAU * i as f32 / FFT_SIZE as f32;
                0.42 - 0.5 * x.cos() + 0.08 * (2.0 * x).cos()
            })
            .collect();

        Self {
            fft: planner.plan_fft_forward(FFT_SIZE),
            window,
            buffer: vec![Complex::new(0.0, 0.0); FFT_SIZE],
            smoothed: vec![0.0; BINS],
            bytes: vec![0; BINS],
        }
    }

    /// Байты спектра из кадра отсчётов — как `getByteFrequencyData`.
    pub fn frequency_bytes(&mut self, samples: &[f32]) -> &[u8] {
        for (i, slot) in self.buffer.iter_mut().enumerate() {
            let sample = samples.get(i).copied().unwrap_or(0.0);
            *slot = Complex::new(sample * self.window[i], 0.0);
        }
        self.fft.process(&mut self.buffer);

        for k in 0..BINS {
            // Нормировка Web Audio: амплитуда бина делится на размер преобразования.
            let magnitude = self.buffer[k].norm() / FFT_SIZE as f32;
            let smoothed = SMOOTHING * self.smoothed[k] + (1.0 - SMOOTHING) * magnitude;
            self.smoothed[k] = smoothed;

            // Децибелы и шкала −100…−30 дБ; тишина уходит в минус бесконечность и
            // зажимается в ноль (логарифм нуля не считаем).
            let db = 20.0 * smoothed.max(1e-12).log10();
            let scaled = 255.0 * (db - MIN_DB) / (MAX_DB - MIN_DB);
            self.bytes[k] = scaled.clamp(0.0, 255.0) as u8;
        }

        &self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::frame::{self, Frame};

    /// Отсчёты для эталонов: те же, что сняты с JS-версии.
    fn golden_time() -> Vec<u8> {
        (0..FFT_SIZE).map(|i| ((i * 7 + 13) % 256) as u8).collect()
    }

    fn golden_spectrum() -> Vec<u8> {
        (0..BINS).map(|i| ((i * 11) % 256) as u8).collect()
    }

    /// Синус заданной амплитуды на бине `bin` — для проверок спектра.
    fn tone(bin: usize, amplitude: f32) -> Vec<f32> {
        (0..FFT_SIZE)
            .map(|i| {
                let phase = std::f32::consts::TAU * bin as f32 * i as f32 / FFT_SIZE as f32;
                amplitude * phase.sin()
            })
            .collect()
    }

    #[test]
    fn time_bytes_maps_samples_to_bytes() {
        let mut out = [0u8; FFT_SIZE];
        let mut samples = vec![0.0f32; FFT_SIZE];
        samples[0] = -1.0;
        samples[1] = 0.0;
        samples[2] = 0.5;
        samples[3] = 1.0;
        samples[4] = 5.0; // за верхней границей — зажимается

        time_bytes(&samples, &mut out);
        assert_eq!(out[0], 0);
        assert_eq!(out[1], 128);
        assert_eq!(out[2], 192);
        assert_eq!(out[3], 255);
        assert_eq!(out[4], 255);
    }

    #[test]
    fn wave_bytes_picks_every_nth_sample() {
        let time: Vec<u8> = (0..FFT_SIZE).map(|i| (i % 256) as u8).collect();
        let mut out = [0u8; WAVE_LEN];
        wave_bytes(&time, &mut out);

        // Те же индексы, что берёт JS: floor((i / 240) * 2048).
        assert_eq!(out[0], time[0]);
        assert_eq!(out[1], time[8]); // floor(2048 / 240) = 8
        assert_eq!(out[239], time[239 * FFT_SIZE / WAVE_LEN]);
    }

    #[test]
    fn freq_bytes_picks_from_usable_part() {
        let spectrum: Vec<u8> = (0..BINS).map(|i| (i % 256) as u8).collect();
        let mut out = [0u8; FREQ_LEN];
        freq_bytes(&spectrum, &mut out);

        let usable = usable_bins();
        assert_eq!(usable, 819);
        assert_eq!(out[0], spectrum[0]);
        assert_eq!(
            out[FREQ_LEN - 1],
            spectrum[(FREQ_LEN - 1) * (usable - 1) / FREQ_LEN]
        );
    }

    /// Сверка с Electron-версией: значения сняты с `control.js` и
    /// `shared/mic-frame.js` (те же входные данные).
    #[test]
    fn matches_electron_reference_values() {
        let time = golden_time();
        let spectrum = golden_spectrum();

        let level = level(&time);
        assert!(
            (f64::from(level) - 0.5773590787883871).abs() < 1e-7,
            "уровень разошёлся: {level}"
        );

        let mut wave = [0u8; WAVE_LEN];
        wave_bytes(&time, &mut wave);
        assert_eq!(
            [wave[0], wave[1], wave[2], wave[119], wave[120], wave[238], wave[239]],
            [13, 69, 132, 206, 13, 143, 206]
        );

        let mut freq = [0u8; FREQ_LEN];
        freq_bytes(&spectrum, &mut freq);
        assert_eq!(
            [freq[0], freq[1], freq[63], freq[64], freq[126], freq[127]],
            [0, 66, 70, 147, 151, 217]
        );

        let mut frame = Frame::new();
        let bytes = frame.encode(level, &wave, &freq);
        assert_eq!(frame::FRAME_LEN, 371);
        assert_eq!(
            [
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[242], bytes[243],
                bytes[370]
            ],
            [77, 83, 147, 13, 69, 206, 0, 217]
        );
    }

    #[test]
    fn spectrum_of_silence_is_zero() {
        let mut analyser = Analyser::new();
        let silence = vec![0.0f32; FFT_SIZE];
        let bytes = analyser.frequency_bytes(&silence);
        assert_eq!(bytes.len(), BINS);
        assert!(bytes.iter().all(|&b| b == 0));
    }

    #[test]
    fn spectrum_puts_tone_into_its_bin() {
        let mut analyser = Analyser::new();
        let bytes = analyser.frequency_bytes(&tone(100, 0.8));

        let (peak, value) = bytes
            .iter()
            .enumerate()
            .max_by_key(|(_, &value)| value)
            .map(|(index, &value)| (index, value))
            .expect("спектр не пуст");

        assert!(
            (99..=101).contains(&peak),
            "тон встал в бин {peak}, ожидали около 100"
        );
        assert!(value > 128, "бин тона слишком тихий: {value}");
    }

    #[test]
    fn louder_tone_is_not_quieter() {
        let mut loud = Analyser::new();
        let loud_peak = loud
            .frequency_bytes(&tone(200, 0.8))
            .iter()
            .copied()
            .max()
            .unwrap_or(0);

        let mut quiet = Analyser::new();
        let quiet_peak = quiet
            .frequency_bytes(&tone(200, 0.2))
            .iter()
            .copied()
            .max()
            .unwrap_or(0);

        assert!(
            loud_peak >= quiet_peak,
            "громкий тон ({loud_peak}) оказался тише тихого ({quiet_peak})"
        );
    }

    #[test]
    fn level_grows_with_amplitude() {
        let mut time = [0u8; FFT_SIZE];
        time_bytes(&vec![0.0f32; FFT_SIZE], &mut time);
        let silence = level(&time);

        time_bytes(&tone(50, 0.5), &mut time);
        let loud = level(&time);

        assert!(silence < 1e-6, "тишина дала уровень {silence}");
        assert!(loud > 0.2, "уровень тона слишком мал: {loud}");
    }
}
