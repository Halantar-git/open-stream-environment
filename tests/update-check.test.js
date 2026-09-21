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
  Ответ electron-updater на проверку обновления.

  Отдельным тестом, потому что ошибка тут не видна глазами: когда обновления
  нет, `checkForUpdates()` всё равно отдаёт `updateInfo` — с версией из манифеста,
  то есть текущей. Если за признак «есть обновление» принять наличие `updateInfo`,
  панель на 3.2.6 показывает «доступно обновление 3.2.6» и зажигает кнопку.
*/

const { parseUpdateCheckResult } = require("../server/update-check");

describe("parseUpdateCheckResult", () => {
  test("нет обновления: updateInfo заполнен, но isUpdateAvailable = false", () => {
    const result = { isUpdateAvailable: false, versionInfo: { version: "3.2.6" }, updateInfo: { version: "3.2.6" } };
    expect(parseUpdateCheckResult(result)).toEqual({ updateAvailable: false, version: null });
  });

  test("обновление есть: берётся версия из updateInfo", () => {
    const result = { isUpdateAvailable: true, updateInfo: { version: "3.2.7" } };
    expect(parseUpdateCheckResult(result)).toEqual({ updateAvailable: true, version: "3.2.7" });
  });

  test("пустой ответ и ответ без версии обновлением не считаются", () => {
    expect(parseUpdateCheckResult(null)).toEqual({ updateAvailable: false, version: null });
    expect(parseUpdateCheckResult(undefined)).toEqual({ updateAvailable: false, version: null });
    expect(parseUpdateCheckResult({ isUpdateAvailable: true, updateInfo: {} })).toEqual({
      updateAvailable: false,
      version: null,
    });
  });
});
