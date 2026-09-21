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
  Защитные помощники панели управления (control/modules/guards.js): значение
  цвета для инлайнового стиля и счётчик поколений захвата микрофона.
  Логика чистая, DOM не нужен — поэтому тесты обычные, без jsdom.
*/

const { safeCssColor, createCaptureGeneration } = require("../control/modules/guards");

describe("control/modules/guards: safeCssColor", () => {
  test("пропускает hex и ссылку на токен темы", () => {
    expect(safeCssColor("#fff")).toBe("#fff");
    expect(safeCssColor("#FF7605")).toBe("#FF7605");
    expect(safeCssColor("#c6b8ff80")).toBe("#c6b8ff80");
    expect(safeCssColor("var(--md-primary)")).toBe("var(--md-primary)");
    expect(safeCssColor("  #123456  ")).toBe("#123456");
  });

  test("подменяет всё, что может вырваться из атрибута style", () => {
    const evil = '#fff"></span><img src=x onerror="alert(1)">';
    expect(safeCssColor(evil)).toBe("#888");
    expect(safeCssColor("red;background:url(http://example.com/x.png)")).toBe("#888");
    expect(safeCssColor("url(#gradient)")).toBe("#888");
    expect(safeCssColor("var(--md-primary); color: red")).toBe("#888");
    expect(safeCssColor("expression(alert(1))")).toBe("#888");
  });

  test("не-строки и пустое значение дают безопасный дефолт", () => {
    expect(safeCssColor(undefined)).toBe("#888");
    expect(safeCssColor(null)).toBe("#888");
    expect(safeCssColor("")).toBe("#888");
    expect(safeCssColor(42)).toBe("#888");
    expect(safeCssColor({ toString: () => "#000" })).toBe("#888");
    expect(safeCssColor("#1234", "#000")).toBe("#1234"); // 4 знака — валидный hex с альфой
  });

  test("дефолт задаётся вызывающим", () => {
    expect(safeCssColor("nope", "#c6b8ff")).toBe("#c6b8ff");
    expect(safeCssColor("nope", "")).toBe("#888");
  });
});

describe("control/modules/guards: createCaptureGeneration", () => {
  test("результат текущего поколения актуален", () => {
    const capture = createCaptureGeneration();
    const generation = capture.begin();
    expect(capture.isStale(generation)).toBe(false);
  });

  test("stop инвалидирует незавершённый захват", () => {
    const capture = createCaptureGeneration();
    const first = capture.begin(); // start()
    capture.invalidate(); // stop()
    expect(capture.isStale(first)).toBe(true);
  });

  test("рестарт: старый поток отбрасывается, новый остаётся актуальным", () => {
    const capture = createCaptureGeneration();
    const first = capture.begin();
    capture.invalidate(); // stop() внутри restartIfRunning
    const second = capture.begin(); // start()

    expect(capture.isStale(first)).toBe(true);
    expect(capture.isStale(second)).toBe(false);
  });

  test("поколения не повторяются", () => {
    const capture = createCaptureGeneration();
    const seen = new Set();
    for (let i = 0; i < 5; i += 1) {
      seen.add(capture.begin());
      capture.invalidate();
    }
    expect(seen.size).toBe(5);
  });
});
