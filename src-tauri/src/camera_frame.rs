//! Бинарный кадр камеры — порт `shared/camera-frame.js`.
//!
//! Панель управления захватывает камеру, кодирует кадр в JPEG и отправляет
//! серверу по бинарному каналу (как микрокадры). Сервер пересылает его
//! оверлеям, не разбирая изображение, поэтому раскладку менять нельзя:
//!
//! ```text
//! байт 0     магия 'C' (0x43)
//! байт 1     магия 'M' (0x4D)
//! байты 2..  JPEG целиком
//! ```
//!
//! Длина переменная, поэтому проверяются магия, маркер начала JPEG и верхняя
//! граница: случайный или слишком большой кадр не должен попасть на шину.

/// Магия кадра: первый байт.
pub const MAGIC0: u8 = 0x43;
/// Магия JPEG-кадра: второй байт ('M').
pub const MAGIC1: u8 = 0x4d;
/// Магия H.264-чанка: второй байт ('H').
pub const H264_MAGIC1: u8 = 0x48;
/// Заголовок JPEG-кадра: две магии.
pub const HEADER_LEN: usize = 2;
/// Заголовок H.264-чанка: магия (2) + флаги (1) + timestamp (8).
pub const H264_HEADER_LEN: usize = 11;
/// Максимальный размер кадра: 4 МБ.
pub const MAX_FRAME_LEN: usize = 4 * 1024 * 1024;

/// Кадр ли это: магия, маркер JPEG и разумная длина.
pub fn is_frame(data: &[u8]) -> bool {
    data.len() > HEADER_LEN + 1
        && data.len() <= MAX_FRAME_LEN
        && data[0] == MAGIC0
        && data[1] == MAGIC1
        && data[HEADER_LEN] == 0xff
        && data[HEADER_LEN + 1] == 0xd8
}

/// H.264-чанк из WebCodecs: магия и разумная длина.
///
/// Содержимое не разбирается: серверу достаточно отличить чанк от JPEG и
/// микрокадра и переслать его оверлею как есть.
pub fn is_h264_frame(data: &[u8]) -> bool {
    data.len() > H264_HEADER_LEN
        && data.len() <= MAX_FRAME_LEN
        && data[0] == MAGIC0
        && data[1] == H264_MAGIC1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(len: usize) -> Vec<u8> {
        let mut body = vec![0u8; len];
        body[0] = 0xff;
        body[1] = 0xd8;
        body
    }

    fn frame(jpeg: &[u8]) -> Vec<u8> {
        let mut out = vec![MAGIC0, MAGIC1];
        out.extend_from_slice(jpeg);
        out
    }

    #[test]
    fn a_jpeg_frame_is_recognized() {
        assert!(is_frame(&frame(&jpeg(64))));
    }

    #[test]
    fn junk_and_wrong_magic_are_rejected() {
        assert!(!is_frame(&[]));
        assert!(!is_frame(b"{\"type\":\"state\"}"));
        assert!(!is_frame(&[MAGIC0, MAGIC1]));
        assert!(!is_frame(&[MAGIC0, MAGIC1, 0x00, 0x00]));

        let mut wrong = frame(&jpeg(64));
        wrong[1] = 0x00;
        assert!(!is_frame(&wrong));
    }

    #[test]
    fn a_frame_without_a_jpeg_marker_is_rejected() {
        // Магия совпала, но внутри не JPEG: не пересылаем.
        assert!(!is_frame(&[MAGIC0, MAGIC1, 0x42, 0x43, 0x44]));
    }

    #[test]
    fn oversized_frames_are_rejected() {
        let mut payload = jpeg(MAX_FRAME_LEN);
        assert!(!is_frame(&frame(&payload)));
        payload.truncate(MAX_FRAME_LEN - HEADER_LEN);
        assert!(is_frame(&frame(&payload)));
    }

    #[test]
    fn an_h264_chunk_is_recognized() {
        let mut chunk = vec![MAGIC0, H264_MAGIC1, 0x01];
        chunk.extend_from_slice(&[0u8; 8]); // timestamp
        chunk.extend_from_slice(&[0x00, 0x00, 0x00, 0x01, 0x67]);
        assert!(is_h264_frame(&chunk));
        // Чанк не должен считаться JPEG-кадром.
        assert!(!is_frame(&chunk));
    }

    #[test]
    fn an_h264_chunk_needs_a_payload() {
        let mut header_only = vec![MAGIC0, H264_MAGIC1];
        header_only.resize(H264_HEADER_LEN, 0);
        assert!(!is_h264_frame(&header_only));
    }

    #[test]
    fn an_h264_chunk_is_bounded() {
        let oversized = vec![0u8; MAX_FRAME_LEN + 1];
        let mut chunk = oversized;
        chunk[0] = MAGIC0;
        chunk[1] = H264_MAGIC1;
        assert!(!is_h264_frame(&chunk));
    }
}
