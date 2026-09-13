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
  Binary codec for one microphone frame (control -> server -> overlay).

  The mic bridge used to send { level, wave[240], freq[128] } as JSON — about
  1.4 KB per frame, twice stringified (control, server) and twice parsed
  (server, overlay). This packs the exact same data into a fixed 371-byte
  binary frame, so the server can forward it without touching JSON at all:

    byte 0      magic 'M' (0x4D)
    byte 1      magic 'S' (0x53)
    byte 2      level, quantized to 0..255 (level * 255)
    bytes 3..242    wave    (240 bytes, 0..255)
    bytes 243..370  freq    (128 bytes, 0..255)

  `decode()` returns typed-array views into the incoming buffer (zero-copy);
  consumers only index them and read `.length`, which works the same as with
  the plain arrays the JSON path produced.
*/

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.MicFrame = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const MAGIC0 = 0x4d; // 'M'
  const MAGIC1 = 0x53; // 'S'
  const WAVE_LEN = 240;
  const FREQ_LEN = 128;
  const HEADER_LEN = 3; // magic0, magic1, level
  const FRAME_LEN = HEADER_LEN + WAVE_LEN + FREQ_LEN; // 371

  function clampByte(n) {
    const v = Math.round(Number(n) || 0);
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  // `out` lets the caller reuse one Uint8Array across frames (no allocation
  // per tick). When omitted a fresh buffer is returned.
  function encode(level, wave, freq, out) {
    const buf = out instanceof Uint8Array && out.length >= FRAME_LEN ? out : new Uint8Array(FRAME_LEN);
    buf[0] = MAGIC0;
    buf[1] = MAGIC1;
    buf[2] = clampByte(level * 255);
    if (wave) buf.set(wave.subarray(0, WAVE_LEN), HEADER_LEN);
    if (freq) buf.set(freq.subarray(0, FREQ_LEN), HEADER_LEN + WAVE_LEN);
    return buf;
  }

  // Accepts Uint8Array / Buffer / ArrayBuffer. Cheap magic + length check, so
  // the server can tell a mic frame from a JSON text frame without parsing.
  function isFrame(data) {
    if (!data) return false;
    if (data instanceof Uint8Array) {
      return data.length === FRAME_LEN && data[0] === MAGIC0 && data[1] === MAGIC1;
    }
    if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) {
      if (data.byteLength !== FRAME_LEN) return false;
      const view = new Uint8Array(data);
      return view[0] === MAGIC0 && view[1] === MAGIC1;
    }
    return false;
  }

  function decode(data) {
    if (!isFrame(data)) return null;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return {
      level: bytes[2] / 255,
      wave: bytes.subarray(HEADER_LEN, HEADER_LEN + WAVE_LEN),
      freq: bytes.subarray(HEADER_LEN + WAVE_LEN, FRAME_LEN),
    };
  }

  return { MAGIC0, MAGIC1, WAVE_LEN, FREQ_LEN, HEADER_LEN, FRAME_LEN, encode, decode, isFrame };
});
