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

describe("shared/camera-frame: H.264", () => {
  const chunk = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]);

  test("encodeH264 упаковывает ключевой кадр, timestamp и данные", () => {
    const encoded = CameraFrame.encodeH264(chunk, { keyframe: true, timestamp: 123456 });

    expect(CameraFrame.isH264Frame(encoded)).toBe(true);
    expect(CameraFrame.isFrame(encoded)).toBe(false);

    const decoded = CameraFrame.decodeH264(encoded);
    expect(decoded.h264).toBe(true);
    expect(decoded.keyframe).toBe(true);
    expect(decoded.timestamp).toBe(123456);
    expect(Array.from(decoded.data)).toEqual(Array.from(chunk));
  });

  test("дельта-чанк не помечается ключевым", () => {
    const decoded = CameraFrame.decodeH264(CameraFrame.encodeH264(chunk, { keyframe: false, timestamp: 7 }));
    expect(decoded.keyframe).toBe(false);
    expect(decoded.timestamp).toBe(7);
  });

  test("H.264-детектор отсекает чужую магию и пустые данные", () => {
    expect(CameraFrame.isH264Frame(null)).toBe(false);
    expect(CameraFrame.isH264Frame(new Uint8Array(0))).toBe(false);

    const jpegFrame = CameraFrame.encode(jpeg());
    expect(CameraFrame.isH264Frame(jpegFrame)).toBe(false);
    expect(CameraFrame.decodeH264(jpegFrame)).toBeNull();
  });

  test("слишком большой H.264-чанк не кодируется и не принимается", () => {
    const oversized = new Uint8Array(CameraFrame.H264_MAX_FRAME_LEN);
    expect(CameraFrame.encodeH264(oversized)).toBeNull();

    const frame = new Uint8Array(CameraFrame.H264_MAX_FRAME_LEN + 1);
    frame[0] = CameraFrame.H264_MAGIC0;
    frame[1] = CameraFrame.H264_MAGIC1;
    expect(CameraFrame.isH264Frame(frame)).toBe(false);
  });
});
