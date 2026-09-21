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
  Консоль панели и живой OBS.

  Обработчик консоли получает контроллер OBS один раз, при создании, а сам
  контроллер пересоздаётся в restartObs(). Из-за этого команды scene/cam/filter/obs
  отвечали «OBS offline» даже при подключённом OBS: обработчик держал значение,
  равное null на момент старта. Проверяется это по-настоящему — по запросу, который
  уходит в сторону OBS после команды из консоли.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const { WebSocket, WebSocketServer } = require("ws");
const { EVENT_TYPES } = require("../shared/events");

const { configureStorage } = require("../server/storage-paths");
const { createDatabase } = require("../server/db");
const { createServer } = require("../server");
const { freePort, sleep, waitForListening, createClient: makeClient } = require("./helpers/ws-client");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ose-cli-obs-"));
}

/*
  Минимальный OBS WebSocket v5: приветствие, подтверждение Identify и ответы на
  запросы. Для проверки консоли большего и не нужно.
*/
function startFakeObs() {
  const requests = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let resolveIdentified;
  const identified = new Promise((resolve) => {
    resolveIdentified = resolve;
  });

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ op: 0, d: { rpcVersion: 1 } }));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.op === 1) {
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        resolveIdentified();
        return;
      }
      if (msg.op === 6) {
        const d = msg.d || {};
        requests.push(d.requestType);
        ws.send(
          JSON.stringify({
            op: 7,
            d: {
              requestType: d.requestType,
              requestId: d.requestId,
              requestStatus: { result: true },
              responseData: { sceneItemId: 1 },
            },
          })
        );
      }
    });
  });

  return { wss, requests, identified };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe("консоль панели видит подключённый OBS", () => {
  let dir;
  let db;
  let handle;
  let obs;
  let control;
  let port;

  beforeAll(async () => {
    dir = tmpDir();
    configureStorage({ configDir: dir });
    port = await freePort();
    obs = startFakeObs();
    await new Promise((resolve) => obs.wss.once("listening", resolve));

    // Конфиг как у пользователя, но без сети: только OBS, и он «включён».
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        port,
        language: "ru",
        twitch: { channel: "", enabled: false },
        donationAlerts: { enabled: false },
        youtube: { enabled: false },
        obs: { enabled: true, host: "127.0.0.1", port: obs.wss.address().port, password: "", sceneMap: { main: "Main" } },
        appearance: { activeThemeId: "nebula", customThemes: [] },
      })
    );

    db = createDatabase(path.join(dir, "local-db.json"));
    handle = createServer({ db, appName: "OSE CLI", version: "9.9.9" });
    handle.start();
    await waitForListening(handle.server);

    control = makeClient(WebSocket, port, "control");
    await control.opened;
    // Команда должна уйти уже подключённому OBS.
    await obs.identified;
  });

  afterAll(async () => {
    if (control) {
      /*
        Гасим интеграцию OBS, пока открыт фейковый OBS: иначе её контроллер уйдёт
        в переподключение (stop() сервера его не останавливает) и таймер не даст
        jest завершиться.
      */
      control.send(EVENT_TYPES.CMD_SET_INTEGRATION_ENABLED, { service: "obs", enabled: false });
      await sleep(50);
      control.close();
    }
    if (handle) handle.stop();
    if (obs) obs.wss.close();
    await db.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("команда scene доходит до OBS, а не отвечает «OBS offline»", async () => {
    control.send(EVENT_TYPES.EXEC_CLI_COMMAND, { command: "scene main" });

    expect(await waitFor(() => obs.requests.includes("SetCurrentProgramScene"))).toBe(true);
    expect(obs.requests).toEqual(["SetCurrentProgramScene"]);
  });
});
