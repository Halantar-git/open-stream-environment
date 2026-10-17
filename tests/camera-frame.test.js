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

const CameraFrame = require("../shared/camera-frame");

function jpeg(length = 12) {
  const bytes = new Uint8Array(length);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  return bytes;
}

function frame(payload) {
  return CameraFrame.encode(payload);
}

describe("shared/camera-frame", () => {
  test("encode добавляет магию перед JPEG", () => {
    const payload = jpeg();
    const encoded = frame(payload);

    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded).toHaveLength(CameraFrame.HEADER_LEN + payload.length);
    expect(encoded[0]).toBe(CameraFrame.MAGIC0);
    expect(encoded[1]).toBe(CameraFrame.MAGIC1);
    expect(encoded[2]).toBe(0xff);
    expect(encoded[3]).toBe(0xd8);
  });

  test("isFrame принимает валидный кадр и ArrayBuffer", () => {
    const encoded = frame(jpeg());
    expect(CameraFrame.isFrame(encoded)).toBe(true);
    expect(CameraFrame.isFrame(encoded.buffer)).toBe(true);
  });

  test("isFrame отсекает мусор, чужую магию и не-JPEG", () => {
    expect(CameraFrame.isFrame(null)).toBe(false);
    expect(CameraFrame.isFrame(new Uint8Array(0))).toBe(false);
    expect(CameraFrame.isFrame(new TextEncoder().encode('{"type":"state"}'))).toBe(false);

    const wrongMagic = frame(jpeg());
    wrongMagic[1] = 0x00;
    expect(CameraFrame.isFrame(wrongMagic)).toBe(false);

    const notJpeg = frame(jpeg());
    notJpeg[2] = 0x42;
    expect(CameraFrame.isFrame(notJpeg)).toBe(false);
  });

  test("decode отдаёт JPEG-Blob без заголовка", async () => {
    const payload = jpeg(16);
    payload[4] = 0x7f;

    const decoded = CameraFrame.decode(frame(payload));
    expect(decoded).toBeTruthy();
    expect(decoded.blob.type).toBe("image/jpeg");

    const bytes = new Uint8Array(await decoded.blob.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(payload));
  });

  test("decode возвращает null для не-кадра", () => {
    expect(CameraFrame.decode(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test("слишком большой кадр не считается кадром", () => {
    // Голова валидная, но длина выше лимита: не гоняем такое по шине.
    const oversized = new Uint8Array(CameraFrame.MAX_FRAME_LEN + 1);
    oversized[0] = CameraFrame.MAGIC0;
    oversized[1] = CameraFrame.MAGIC1;
    oversized[2] = 0xff;
    oversized[3] = 0xd8;
    expect(CameraFrame.isFrame(oversized)).toBe(false);
  });
});
