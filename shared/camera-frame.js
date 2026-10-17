/*
 * Copyright (C) 2026  Halantar
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://gnu.org>.
 */

/*
  Binary codec for one camera frame (control -> server -> overlay).

  Камера захватывается панелью управления: странице оверлея в OBS Browser
  Source браузер не выдаёт камеру (та же причина, по которой микрофон
  захватывает панель). Кадры идут по тому же бинарному каналу, что и
  микрокадры, — без base64 и JSON, двумя форматами:

    * JPEG — запасной путь:
        байт 0    магия 'C' (0x43)
        байт 1    магия 'M' (0x4D)
        байты 2.. JPEG целиком

    * H.264-чанк из WebCodecs:
        байт 0      магия 'C' (0x43)
        байт 1      магия 'H' (0x48)
        байт 2      флаги (бит 0 — ключевой кадр)
        байты 3..10 timestamp, микросекунды, little-endian u64
        байты 11..  чанк Annex B

  Длина переменная, поэтому сервер проверяет магию и верхнюю границу размера,
  но само изображение не разбирает.
*/

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.CameraFrame = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const MAGIC0 = 0x43; // 'C'
  const MAGIC1 = 0x4d; // 'M'
  const HEADER_LEN = 2;
  // H.264-чанк идёт тем же каналом, но с другой магией: оверлей различает
  // JPEG-кадр и сжатый чанк до того, как трогать данные.
  const H264_MAGIC0 = 0x43; // 'C'
  const H264_MAGIC1 = 0x48; // 'H'
  const H264_HEADER_LEN = 11; // магия (2) + флаги (1) + timestamp µs (8)
  const H264_KEYFRAME = 0x01;
  const H264_MAX_FRAME_LEN = 4 * 1024 * 1024;
  // Ограничение защищает шину от случайно гигантского кадра: 4 МБ с запасом
  // покрывают 1920×1080 при высоком качестве.
  const MAX_FRAME_LEN = 4 * 1024 * 1024;

  function asBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) return new Uint8Array(data);
    return null;
  }

  // JPEG всегда начинается с маркера SOI (FF D8). Проверка отсекает мусор,
  // который случайно совпал с магией.
  function isJpegAt(bytes, offset) {
    return bytes.length >= offset + 2 && bytes[offset] === 0xff && bytes[offset + 1] === 0xd8;
  }

  function encode(jpeg) {
    const bytes = asBytes(jpeg);
    if (!bytes || bytes.length < 2) return null;
    const out = new Uint8Array(HEADER_LEN + bytes.length);
    out[0] = MAGIC0;
    out[1] = MAGIC1;
    out.set(bytes, HEADER_LEN);
    return out;
  }

  function isFrame(data) {
    const bytes = asBytes(data);
    if (!bytes) return false;
    return (
      bytes.length > HEADER_LEN + 1 &&
      bytes.length <= MAX_FRAME_LEN &&
      bytes[0] === MAGIC0 &&
      bytes[1] === MAGIC1 &&
      isJpegAt(bytes, HEADER_LEN)
    );
  }

  function encodeH264(chunk, options) {
    const bytes = asBytes(chunk);
    if (!bytes || !bytes.length) return null;
    const keyframe = !!(options && options.keyframe);
    const timestamp = Math.max(0, Math.round(Number(options && options.timestamp) || 0));
    if (bytes.length + H264_HEADER_LEN > H264_MAX_FRAME_LEN) return null;

    const out = new Uint8Array(H264_HEADER_LEN + bytes.length);
    out[0] = H264_MAGIC0;
    out[1] = H264_MAGIC1;
    out[2] = keyframe ? H264_KEYFRAME : 0;
    new DataView(out.buffer).setBigUint64(3, BigInt(timestamp), true);
    out.set(bytes, H264_HEADER_LEN);
    return out;
  }

  function isH264Frame(data) {
    const bytes = asBytes(data);
    if (!bytes) return false;
    return (
      bytes.length > H264_HEADER_LEN &&
      bytes.length <= H264_MAX_FRAME_LEN &&
      bytes[0] === H264_MAGIC0 &&
      bytes[1] === H264_MAGIC1
    );
  }

  function decodeH264(data) {
    if (!isH264Frame(data)) return null;
    const bytes = asBytes(data);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      h264: true,
      keyframe: (bytes[2] & H264_KEYFRAME) !== 0,
      timestamp: Number(view.getBigUint64(3, true)),
      data: bytes.subarray(H264_HEADER_LEN),
    };
  }

  // Отдаём готовый Blob: оверлей декодирует его браузерными средствами
  // (`Image` / `createImageBitmap`), не собирая base64.
  function decode(data) {
    if (!isFrame(data)) return null;
    const bytes = asBytes(data);
    return { blob: new Blob([bytes.subarray(HEADER_LEN)], { type: "image/jpeg" }) };
  }

  return {
    MAGIC0,
    MAGIC1,
    HEADER_LEN,
    MAX_FRAME_LEN,
    H264_MAGIC0,
    H264_MAGIC1,
    H264_HEADER_LEN,
    H264_KEYFRAME,
    H264_MAX_FRAME_LEN,
    encode,
    isFrame,
    decode,
    encodeH264,
    isH264Frame,
    decodeH264,
  };
});
