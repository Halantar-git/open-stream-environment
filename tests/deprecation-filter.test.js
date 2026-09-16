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
  Фильтр устаревших предупреждений.

  Проверяем главное свойство: глушится ровно один код (DEP0040 — встроенный
  `punycode`, который требует код вне node_modules), а всё остальное доходит.
  Молчаливое «выключить предупреждения целиком» было бы проще, но так прячутся
  настоящие проблемы, поэтому точечность здесь — не деталь, а суть.

  Проверок две, и они про разное:

    * модульная — что фильтр не пропускает DEP0040 дальше и пропускает остальное
      (запускается в Jest, где `process.emitWarning` уже подменён самим Jest);
    * в отдельном процессе — что предупреждение действительно не печатается в
      stderr, то есть что симптом, ради которого фильтр и появился, уходит.
*/

const path = require("path");
const { spawnSync } = require("child_process");

const { installDeprecationFilter, IGNORED_CODES } = require("../server/deprecation-filter");

const FILTER_PATH = path.join(__dirname, "..", "server", "deprecation-filter.js");

describe("фильтр устаревших предупреждений", () => {
  const originalEmitWarning = process.emitWarning;
  let markerBefore;

  beforeEach(() => {
    markerBefore = originalEmitWarning.__oseDeprecationFilter;
  });

  afterEach(() => {
    process.emitWarning = originalEmitWarning;
    originalEmitWarning.__oseDeprecationFilter = markerBefore;
  });

  test("DEP0040 не пропускается дальше, остальные коды — пропускаются", () => {
    // Ставим на место «настоящего» emitWarning заглушку: так видно ровно то, что
    // фильтр решает пропустить, без печати в stderr.
    const passthrough = jest.fn();
    process.emitWarning = passthrough;

    expect(installDeprecationFilter()).toBe(true);
    // Повторная установка (модуль подключается из нескольких мест) ничего не
    // оборачивает второй раз.
    expect(installDeprecationFilter()).toBe(false);

    process.emitWarning("punycode is deprecated", "DeprecationWarning", "DEP0040");
    process.emitWarning("another deprecation", "DeprecationWarning", "DEP0000");
    // Форма вызова с объектом опций — тоже мимо фильтра, если код чужой.
    process.emitWarning("punycode again", { type: "DeprecationWarning", code: "DEP0040" });
    process.emitWarning("other thing", { type: "DeprecationWarning", code: "DEP0001" });

    expect(passthrough).toHaveBeenCalledTimes(2);
    // Позиционная форма: (warning, type, code).
    expect(passthrough.mock.calls[0][2]).toBe("DEP0000");
    // Форма с опциями: код лежит в объекте.
    expect(passthrough.mock.calls[1][1]).toMatchObject({ code: "DEP0001" });
  });

  test("в реальном процессе предупреждение не печатается, а чужие — печатаются", () => {
    const script = `
      const { installDeprecationFilter } = require(${JSON.stringify(FILTER_PATH)});
      installDeprecationFilter();
      process.emitWarning("punycode is deprecated", "DeprecationWarning", "DEP0040");
      process.emitWarning("другое предупреждение", "DeprecationWarning", "DEP0000");
    `;

    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    const stderr = String(result.stderr || "");

    // Чужое предупреждение видно — значит мы не выключили их все.
    expect(stderr).toContain("DEP0000");
    expect(stderr).toContain("другое предупреждение");
    // А то, ради которого фильтр и появился, не печатается.
    expect(stderr).not.toContain("DEP0040");
    expect(stderr).not.toContain("punycode is deprecated");
  });

  test("список игнорируемых кодов не разрастается незаметно", () => {
    // Один чужой код — осознанное исключение, а не привычка: если список начнёт
    // расти, это должно быть видно в правке, а не проходить незамеченным.
    expect([...IGNORED_CODES]).toEqual(["DEP0040"]);
  });
});
