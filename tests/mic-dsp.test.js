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
  Unit tests for the microphone visualizer DSP (overlay/mic-dsp.js): band
  layout (log/linear), spectrum reduction, noise gate, gain and attack/release
  smoothing. DOM-free by design.
*/

const {
  buildBands,
  bandsFromSpectrum,
  applyGate,
  applyGain,
  smoothValue,
  smoothBands,
  smoothingTimes,
  createFrameGate,
} = require("../overlay/mic-dsp");

describe("mic-dsp", () => {
  test("buildBands (linear) покрывает usable-спектр без пустых полос", () => {
    const bands = buildBands(10, 4, "linear");
    const usable = Math.floor(10 * 0.8); // 8
    expect(bands).toHaveLength(4);
    bands.forEach((b, i) => {
      expect(b.start).toBeGreaterThanOrEqual(0);
      expect(b.end).toBeGreaterThan(b.start);
      expect(b.end).toBeLessThanOrEqual(usable);
      if (i > 0) expect(b.start).toBeGreaterThanOrEqual(bands[i - 1].end - 1);
    });
    expect(bands[0].start).toBe(0);
    expect(bands[bands.length - 1].end).toBe(usable);
  });

  test("buildBands (log) даёт более узкие низкие полосы и валидные границы", () => {
    const bands = buildBands(512, 16, "log");
    const usable = Math.floor(512 * 0.8);
    expect(bands).toHaveLength(16);
    bands.forEach((b) => {
      expect(b.start).toBeGreaterThanOrEqual(0);
      expect(b.end).toBeGreaterThan(b.start);
      expect(b.end).toBeLessThanOrEqual(usable);
    });
    // Логарифмическая шкала: последняя полоса шире первой.
    const first = bands[0].end - bands[0].start;
    const last = bands[bands.length - 1].end - bands[bands.length - 1].start;
    expect(last).toBeGreaterThan(first);
  });

  test("buildBands выдерживает больше полос, чем бинов", () => {
    const bands = buildBands(2, 8, "log");
    bands.forEach((b) => {
      expect(b.start).toBeGreaterThanOrEqual(0);
      expect(b.end).toBeGreaterThan(b.start);
      expect(b.end).toBeLessThanOrEqual(2);
    });
  });

  test("bandsFromSpectrum усредняет (mean) и берёт максимум (max)", () => {
    const freq = [0, 255, 0, 255, 0, 0, 0, 0];
    const bands = [{ start: 0, end: 2 }, { start: 2, end: 4 }];
    expect(bandsFromSpectrum(freq, bands, { reduce: "mean" })).toEqual([0.5, 0.5]);
    expect(bandsFromSpectrum(freq, bands, { reduce: "max" })).toEqual([1, 1]);
    // Пустой диапазон — 0, не NaN.
    expect(bandsFromSpectrum(freq, [{ start: 50, end: 60 }])).toEqual([0]);
  });

  test("applyGate отсекает шум и растягивает сигнал выше порога", () => {
    expect(applyGate(0.02, 0.05)).toBe(0);
    expect(applyGate(0.05, 0.05)).toBe(0);
    expect(applyGate(0.525, 0.05)).toBeCloseTo(0.5, 5);
    expect(applyGate(1, 0.05)).toBe(1);
    // Без гейта — только клампинг.
    expect(applyGate(0.3, 0)).toBe(0.3);
    expect(applyGate(2, 0)).toBe(1);
  });

  test("applyGain умножает и клампит в 0..1", () => {
    expect(applyGain(0.5, 2)).toBe(1);
    expect(applyGain(0.5, 0.5)).toBe(0.25);
    expect(applyGain(0.5, undefined)).toBe(0.5);
  });

  test("smoothValue: быстрый подъём (attack) и медленный спад (release)", () => {
    const opts = { attack: 0.01, release: 0.5 };
    // dt == attack → мгновенно ~ следующее значение.
    expect(smoothValue(0, 1, 0.01, opts)).toBeCloseTo(1, 5);
    // dt << release → лишь небольшой шаг вниз.
    const down = smoothValue(1, 0, 0.05, opts);
    expect(down).toBeGreaterThan(0.8);
    expect(down).toBeLessThan(1);
    // Отрицательный/нулевой dt не ломает.
    expect(smoothValue(1, 0, 0, opts)).toBe(1);
  });

  test("smoothBands инициализирует отсутствующую историю и сглаживает полинейно", () => {
    const opts = { attack: 1, release: 1 };
    const first = smoothBands(null, [0, 1], 0.5, opts);
    expect(first).toEqual([0, 1]);
    const second = smoothBands([0, 1], [1, 0], 0.5, opts);
    expect(second[0]).toBeCloseTo(0.5, 5);
    expect(second[1]).toBeCloseTo(0.5, 5);
  });

  test("smoothingTimes монотонно растёт с ползунком", () => {
    const snappy = smoothingTimes(0);
    const smooth = smoothingTimes(1);
    expect(smooth.attack).toBeGreaterThan(snappy.attack);
    expect(smooth.release).toBeGreaterThan(snappy.release);
    expect(smoothingTimes(0.5).release).toBeGreaterThan(snappy.release);
  });

  test("createFrameGate пропускает не чаще заданного FPS", () => {
    const allow = createFrameGate(30); // кадр каждые ~33.33 мс
    expect(allow(0)).toBe(true); // первый кадр всегда
    expect(allow(10)).toBe(false);
    expect(allow(33)).toBe(false);
    expect(allow(34)).toBe(true);
    expect(allow(50)).toBe(false);
    expect(allow(68)).toBe(true);
  });

  test("createFrameGate держит каденс без дрейфа", () => {
    const allow = createFrameGate(50); // 20 мс
    const passed = [];
    for (let t = 0; t <= 200; t += 1) if (allow(t)) passed.push(t);
    // ~1 кадр на 20 мс: 11 кадров на 200 мс (t=0..200).
    expect(passed.length).toBeGreaterThanOrEqual(10);
    expect(passed.length).toBeLessThanOrEqual(12);
    expect(passed[0]).toBe(0);
    for (let i = 1; i < passed.length; i++) {
      expect(passed[i] - passed[i - 1]).toBeGreaterThanOrEqual(20);
    }
  });
});
