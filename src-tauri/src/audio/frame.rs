//! Бинарный кадр микрофона — порт `shared/mic-frame.js`.
//!
//! Один кадр — 371 байт: панель отдаёт его серверу, сервер пересылает оверлею,
//! не разбирая, поэтому раскладка менять нельзя.
//!
//! ```text
//! байт 0          магия 'M' (0x4D)
//! байт 1          магия 'S' (0x53)
//! байт 2          уровень, квантованный в 0..255 (level * 255)
//! байты 3..242    волна   (240 байт)
//! байты 243..370  спектр  (128 байт)
//! ```

/// Магия кадра: первый байт.
pub const MAGIC0: u8 = 0x4d;
/// Магия кадра: второй байт.
pub const MAGIC1: u8 = 0x53;
/// Длина осциллограммы в кадре.
pub const WAVE_LEN: usize = 240;
/// Длина спектра в кадре.
pub const FREQ_LEN: usize = 128;
/// Заголовок: две магии и уровень.
pub const HEADER_LEN: usize = 3;
/// Полная длина кадра.
pub const FRAME_LEN: usize = HEADER_LEN + WAVE_LEN + FREQ_LEN;

/// Кадр с буфером внутри.
///
/// Кадры собираются 30 раз в секунду, поэтому память под них выделяется один раз:
/// в JS для этого в `encode` передают переиспользуемый `Uint8Array`.
#[derive(Clone)]
pub struct Frame {
    buf: [u8; FRAME_LEN],
}

impl Default for Frame {
    fn default() -> Self {
        Self::new()
    }
}

impl Frame {
    pub fn new() -> Self {
        Self {
            buf: [0; FRAME_LEN],
        }
    }

    /// Собрать кадр и вернуть его байты.
    ///
    /// Короткая волна или спектр дополняются нулями, длинная — обрезается: в JS
    /// это `buf.set(value.subarray(0, len))`. Нули, а не «что осталось от прошлого
    /// кадра»: так содержимое кадра зависит только от входных данных.
    pub fn encode(&mut self, level: f32, wave: &[u8], freq: &[u8]) -> &[u8; FRAME_LEN] {
        self.buf[0] = MAGIC0;
        self.buf[1] = MAGIC1;
        self.buf[2] = quantize_level(level);
        copy_into(&mut self.buf[HEADER_LEN..HEADER_LEN + WAVE_LEN], wave);
        copy_into(&mut self.buf[HEADER_LEN + WAVE_LEN..FRAME_LEN], freq);
        &self.buf
    }

    /// Байты последнего собранного кадра.
    pub fn bytes(&self) -> &[u8; FRAME_LEN] {
        &self.buf
    }
}

/// Уровень 0..1 → байт: `clampByte(level * 255)` из JS (округление, затем зажим).
///
/// Отдельно про `NaN`: в JS `Number(NaN) || 0` даёт ноль, поэтому и здесь ноль, а
/// не «насыщенный» байт, который вышел бы из простого приведения типов.
pub fn quantize_level(level: f32) -> u8 {
    if level.is_nan() {
        return 0;
    }
    (level * 255.0).round().clamp(0.0, 255.0) as u8
}

/// Кадр ли это: магия и длина — как `isFrame` в JS.
///
/// Сервер так отличает бинарный кадр от текстового JSON, не разбирая содержимое.
pub fn is_frame(data: &[u8]) -> bool {
    data.len() == FRAME_LEN && data[0] == MAGIC0 && data[1] == MAGIC1
}

/// Разобранный кадр: ссылки внутрь исходного буфера, без копирования.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Decoded<'a> {
    pub level: f32,
    pub wave: &'a [u8],
    pub freq: &'a [u8],
}

/// Разобрать кадр; `None` — это не кадр.
pub fn decode(data: &[u8]) -> Option<Decoded<'_>> {
    if !is_frame(data) {
        return None;
    }
    Some(Decoded {
        level: f32::from(data[2]) / 255.0,
        wave: &data[HEADER_LEN..HEADER_LEN + WAVE_LEN],
        freq: &data[HEADER_LEN + WAVE_LEN..FRAME_LEN],
    })
}

/// Скопировать в приёмник столько, сколько помещается, остальное заполнить нулями.
fn copy_into(target: &mut [u8], source: &[u8]) {
    let copied = target.len().min(source.len());
    target[..copied].copy_from_slice(&source[..copied]);
    target[copied..].fill(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Осциллограмма «с рисунком» — чтобы round-trip что-то проверял.
    fn wave_pattern() -> Vec<u8> {
        (0..WAVE_LEN).map(|i| ((i * 7) % 256) as u8).collect()
    }

    fn freq_pattern() -> Vec<u8> {
        (0..FREQ_LEN).map(|i| ((i * 13) % 256) as u8).collect()
    }

    #[test]
    fn encode_and_decode_round_trip() {
        let wave = wave_pattern();
        let freq = freq_pattern();

        let mut frame = Frame::new();
        let bytes = frame.encode(0.5, &wave, &freq).to_vec();

        assert_eq!(bytes.len(), FRAME_LEN);
        assert_eq!(bytes[0], MAGIC0);
        assert_eq!(bytes[1], MAGIC1);

        let decoded = decode(&bytes).expect("кадр должен разбираться");
        assert_eq!(decoded.wave, wave.as_slice());
        assert_eq!(decoded.freq, freq.as_slice());
        // Уровень в кадре — байт, поэтому обратно он выходит квантованным: 0.5 →
        // 128 → 128/255. Ровно то же делает JS-версия.
        assert_eq!(decoded.level, f32::from(quantize_level(0.5)) / 255.0);
    }

    #[test]
    fn encode_quantizes_level_with_clamping() {
        assert_eq!(quantize_level(-1.0), 0);
        assert_eq!(quantize_level(0.0), 0);
        assert_eq!(quantize_level(1.0), 255);
        assert_eq!(quantize_level(2.0), 255);
        // В JS `Number(NaN) || 0` — ноль.
        assert_eq!(quantize_level(f32::NAN), 0);
    }

    #[test]
    fn encode_zero_fills_short_input() {
        let mut frame = Frame::new();
        // Сначала кадр с данными, потом — с короткими входами: «хвост» прошлого
        // кадра не должен просачиваться.
        frame.encode(1.0, &[7; WAVE_LEN], &[9; FREQ_LEN]);
        let bytes = frame.encode(0.0, &[1, 2], &[3]).to_vec();

        assert_eq!(bytes[HEADER_LEN], 1);
        assert_eq!(bytes[HEADER_LEN + 1], 2);
        assert_eq!(bytes[HEADER_LEN + 2], 0);
        assert_eq!(bytes[HEADER_LEN + WAVE_LEN], 3);
        assert_eq!(bytes[HEADER_LEN + WAVE_LEN + 1], 0);
    }

    #[test]
    fn is_frame_rejects_junk_and_wrong_magic() {
        let mut frame = Frame::new();
        let valid = frame.encode(0.3, &wave_pattern(), &freq_pattern()).to_vec();
        assert!(is_frame(&valid));

        assert!(!is_frame(b"{\"type\":\"state\"}"));
        assert!(!is_frame(&[0; 10]));
        assert!(!is_frame(&[]));

        let mut wrong_magic = valid.clone();
        wrong_magic[1] = 0x00;
        assert!(!is_frame(&wrong_magic));
    }
}
