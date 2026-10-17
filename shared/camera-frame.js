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
  захватывает панель). Готовый JPEG идёт по тому же бинарному каналу, что и
  микрокадры, — без base64 и JSON:

    байт 0    магия 'C' (0x43)
    байт 1    магия 'M' (0x4D)
    байты 2.. JPEG целиком

  Кадр переменной длины, поэтому сервер проверяет магию, маркер начала JPEG и
  верхнюю границу размера, но само изображение не разбирает.
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

  // Отдаём готовый Blob: оверлей декодирует его браузерными средствами
  // (`Image` / `createImageBitmap`), не собирая base64.
  function decode(data) {
    if (!isFrame(data)) return null;
    const bytes = asBytes(data);
    return { blob: new Blob([bytes.subarray(HEADER_LEN)], { type: "image/jpeg" }) };
  }

  return { MAGIC0, MAGIC1, HEADER_LEN, MAX_FRAME_LEN, encode, isFrame, decode };
});
