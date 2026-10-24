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
  Документация API не должна расходиться с шиной.

  Список кадров в docs/api.md снимается с shared/events.js генератором. Тест
  запускает его в режиме --check: добавили команду и забыли пересобрать
  документацию — здесь это видно, а не у стороннего разработчика пакета.
*/

const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

describe("docs/api.md", () => {
  test("таблица кадров совпадает с shared/events.js", () => {
    expect(() =>
      execFileSync(process.execPath, ["src-tauri/tools/build-api-events.mjs", "--check"], {
        cwd: ROOT,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
