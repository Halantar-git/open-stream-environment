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
  Диагностика по-настоящему, через HTTP: поднимаем express-приложение сервера на
  свободном порту и дёргаем /healthz и /support-bundle так, как это сделает
  мониторинг или человек из браузера. Интеграции (Twitch/OBS/YouTube) не
  запускаются: слушаем `server` напрямую, без start().
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { configureStorage } = require("../server/storage-paths");
const { createDatabase } = require("../server/db");
const { createServer } = require("../server");
const { WebSocket } = require("ws");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ose-http-"));
}

// Ждём условия: команда доходит до журнала асинхронно (сокет-событие).
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

// Запрос к локальному серверу: возвращает { status, headers, text }.
function request(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") })
      );
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
}

describe("server: HTTP-диагностика", () => {
  let dir;
  let db;
  let handle;
  let port;

  beforeAll(async () => {
    dir = tmpDir();
    configureStorage({ configDir: dir });
    db = createDatabase(path.join(dir, "local-db.json"));
    db.appendStreamEvent({ type: "donation", username: "viewer", amount: 100 });
    await db.flush(); // индексы истории видны только после сброса очереди
    handle = createServer({ db, appName: "OSE Test", version: "9.9.9" });

    await new Promise((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
    port = handle.server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    handle.perfMonitor.stop();
    await db.flush();
  });

  test("/healthz отвечает 200 и валидным JSON о состоянии", async () => {
    const res = await request(port, "/healthz");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");

    const report = JSON.parse(res.text);
    expect(report.ok).toBe(true);
    expect(report.app).toBe("OSE Test");
    expect(report.version).toBe("9.9.9");
    // Порт берётся из конфига (в тесте слушаем случайный, поэтому сравниваем с ним).
    expect(report.port).toBe(handle.state.config.port);
    expect(report.listening).toBe(true);
    expect(report.server).toEqual({ clients: 0, byRole: {} });
    expect(report.storage.history.count).toBe(1);
    expect(report.writes.database.writes).toBeGreaterThanOrEqual(0);
    expect(report.problems).toEqual([]);
  });

  test("/healthz не отдаёт пути к файлам и каталогам", async () => {
    const res = await request(port, "/healthz");

    expect(res.text).not.toContain(dir);
    expect(res.text).not.toContain("local-db.json");
    expect(res.text).not.toContain(path.sep);
  });

  test("/support-bundle отдаётся локальному запросу как файл-вложение", async () => {
    const res = await request(port, "/support-bundle");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["content-disposition"]).toContain("ose-support-");
    expect(res.text).toContain("отчёт для поддержки");
    expect(res.text).toContain("== Настройки (без секретов) ==");
    expect(res.text).toContain("== Лог");
  });

  test("отчёт для поддержки описывает то же состояние, что и /healthz", async () => {
    const health = JSON.parse((await request(port, "/healthz")).text);
    const bundle = (await request(port, "/support-bundle")).text;

    expect(bundle).toContain("== Состояние ==");
    expect(bundle).toMatch(/Работает:\s+да/);
    // Порт — из того же отчёта, но без привязки к выравниванию подписей.
    expect(bundle).toMatch(new RegExp(`Порт:\\s+${health.port}`));
  });

  test("/healthz отдаёт числа по доступу из сети, а не флаги", async () => {
    const health = JSON.parse((await request(port, "/healthz")).text);

    expect(health.security.tokenRequired).toBe(true);
    expect(health.security.deniedUpgrade).toBe(0);
    expect(typeof health.security.rateLimited).toBe("number");
    expect(health.security.audit.total).toBeGreaterThanOrEqual(0);
  });

  test("локальный WebSocket подключается без кода доступа", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=test`);
    const opened = await new Promise((resolve) => {
      socket.on("open", () => resolve(true));
      socket.on("error", () => resolve(false));
    });

    expect(opened).toBe(true);
    socket.close();
  });

  test("команда клиента попадает в журнал как локальная", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=test`);
    await new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
    socket.send(JSON.stringify({ type: "cmd_set_language", payload: { lang: "ru" } }));

    const recorded = await waitFor(() => handle.recentAudit(20).some((entry) => entry.type === "cmd_set_language"));
    socket.close();

    expect(recorded).toBe(true);
    const entry = handle.recentAudit(20).find((item) => item.type === "cmd_set_language");
    expect(entry.role).toBe("test");
    expect(entry.external).toBe(false);
    expect(entry.limited).toBe(false);
    expect(entry.details).toEqual({ lang: "ru" });
  });

  test("журнал команд попадает в отчёт для поддержки без payload", async () => {
    const bundle = (await request(port, "/support-bundle")).text;
    // Берём только секцию журнала: дальше идут настройки и хвост лога.
    const section = (bundle.split("== Журнал команд")[1] || "").split("\n== ")[0];

    expect(bundle).toContain("== Журнал команд");
    expect(section).toContain("cmd_set_language");
    expect(section).toContain('"lang":"ru"');
    expect(section).not.toContain("payload");
  });

  test("ротация кода меняет адрес пульта и отключает старый код", () => {
    const before = handle.state.remoteToken();

    const result = handle.rotateRemoteToken();

    expect(result.ok).toBe(true);
    expect(result.remoteUrl).toMatch(/\/remote\?token=[a-f0-9]{32}$/);
    expect(result.remoteUrl).toContain(handle.state.remoteToken());
    expect(handle.state.remoteToken()).not.toBe(before);
    expect(handle.state.checkRemoteToken(before)).toBe(false);
    expect(handle.state.checkRemoteToken(handle.state.remoteToken())).toBe(true);
  });
});
