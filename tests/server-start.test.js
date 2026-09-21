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
  Запуск сервера, когда порт занят.

  Раньше `server.listen()` вызывался без обработчика `error`: занятый порт (второй
  экземпляр приложения или посторонняя программа) давал непойманное исключение —
  диалог «критическая ошибка» и выход. Теперь это понятная строка в журнале, а
  интеграции не поднимаются: иначе приложение выглядело бы работающим (Twitch
  подключён, алерты идут), хотя панель и оверлей не смогли бы подключиться.
*/

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { configureStorage } = require("../server/storage-paths");
const { createDatabase } = require("../server/db");
const { createServer } = require("../server");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function occupyPort() {
  const blocker = net.createServer();
  return new Promise((resolve, reject) => {
    blocker.once("error", reject);
    // Слушаем все интерфейсы: сервер приложения тоже занимает адрес целиком,
    // поэтому порт должен быть занят ровно так же, как у второй копии приложения.
    blocker.listen(0, () => resolve(blocker));
  });
}

async function waitForEntry(entries, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = entries.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `в журнал ничего не попало; записей: ${entries.map((e) => `${e.service}/${e.level}: ${e.message}`).join(" | ")}`
  );
}

describe("запуск сервера при занятом порте", () => {
  let dir;
  let blocker;
  let handle;

  beforeAll(async () => {
    dir = tmpDir("ose-start-");
    configureStorage({ configDir: dir });
    blocker = await occupyPort();
  });

  afterAll(() => {
    if (handle) handle.stop();
    if (blocker) blocker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("понятная запись в журнале, процесс жив, интеграции не подняты", async () => {
    const db = createDatabase(path.join(dir, "local-db.json"));
    handle = createServer({ db, appName: "OSE Start", version: "9.9.9" });
    handle.state.setAppConfig({ port: blocker.address().port });

    const entries = [];
    handle.bus.on("terminal_log", (entry) => entries.push(entry));
    // Сессия стрима создаётся вместе с интеграциями — по ней и видно, что
    // «наполовину поднятого» приложения не случилось.
    const startSession = jest.spyOn(db, "startSession");

    handle.start();
    const error = await waitForEntry(entries, (entry) => entry.level === "error" && entry.service === "server");

    expect(error.message).toContain(String(blocker.address().port));
    expect(error.message).toContain("занят");
    expect(handle.server.listening).toBe(false);
    expect(startSession).not.toHaveBeenCalled();

    // Выход не должен падать на закрытии сервера, который так и не начал слушать.
    expect(() => handle.stop()).not.toThrow();
  });
});
