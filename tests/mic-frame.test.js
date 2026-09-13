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

const MicFrame = require("../shared/mic-frame");

describe("shared/mic-frame", () => {
  test("encode/decode — round-trip без потерь по волне и спектру", () => {
    const wave = new Uint8Array(MicFrame.WAVE_LEN);
    const freq = new Uint8Array(MicFrame.FREQ_LEN);
    for (let i = 0; i < wave.length; i++) wave[i] = (i * 7) % 256;
    for (let i = 0; i < freq.length; i++) freq[i] = (i * 13) % 256;

    const buf = MicFrame.encode(0.5, wave, freq);
    expect(buf).toHaveLength(MicFrame.FRAME_LEN);
    expect(buf).toHaveLength(371);
    expect(buf[0]).toBe(0x4d);
    expect(buf[1]).toBe(0x53);

    const decoded = MicFrame.decode(buf);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded.wave)).toEqual(Array.from(wave));
    expect(Array.from(decoded.freq)).toEqual(Array.from(freq));
    expect(decoded.level).toBeCloseTo(128 / 255, 5);
  });

  test("encode квантует уровень в 0..255 с ограничением", () => {
    expect(MicFrame.encode(-1, null, null)[2]).toBe(0);
    expect(MicFrame.encode(0, null, null)[2]).toBe(0);
    expect(MicFrame.encode(1, null, null)[2]).toBe(255);
    expect(MicFrame.encode(2, null, null)[2]).toBe(255);
  });

  test("encode переиспользует переданный буфер", () => {
    const out = new Uint8Array(MicFrame.FRAME_LEN);
    expect(MicFrame.encode(0.1, null, null, out)).toBe(out);
    // Буфер короче нужного — создаётся новый.
    expect(MicFrame.encode(0.1, null, null, new Uint8Array(4))).not.toHaveLength(4);
  });

  test("isFrame отличает кадр от JSON-строки и мусора", () => {
    const valid = MicFrame.encode(0.3, new Uint8Array(MicFrame.WAVE_LEN), new Uint8Array(MicFrame.FREQ_LEN));
    expect(MicFrame.isFrame(valid)).toBe(true);
    expect(MicFrame.isFrame(Buffer.from(valid))).toBe(true);
    expect(MicFrame.isFrame(valid.buffer)).toBe(true);

    expect(MicFrame.isFrame(Buffer.from('{"type":"state"}'))).toBe(false);
    expect(MicFrame.isFrame(new Uint8Array(10))).toBe(false);
    expect(MicFrame.isFrame(null)).toBe(false);
    expect(MicFrame.isFrame(undefined)).toBe(false);

    const wrongMagic = MicFrame.encode(0.3, null, null);
    wrongMagic[1] = 0x00;
    expect(MicFrame.isFrame(wrongMagic)).toBe(false);
  });

  test("decode возвращает null для не-кадра", () => {
    expect(MicFrame.decode(Buffer.from("not a frame"))).toBeNull();
    expect(MicFrame.decode(new Uint8Array(MicFrame.FRAME_LEN))).toBeNull(); // нулевая магия
  });

  test("decode работает с ArrayBuffer (binaryType=arraybuffer в оверлее)", () => {
    const wave = new Uint8Array(MicFrame.WAVE_LEN).fill(200);
    const buf = MicFrame.encode(1, wave, null);
    const decoded = MicFrame.decode(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    expect(decoded).not.toBeNull();
    expect(decoded.wave[0]).toBe(200);
  });
});
