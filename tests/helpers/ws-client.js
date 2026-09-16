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
  Общие инструменты для тестов, которые поднимают настоящий сервер и
  подключаются к нему как клиенты (сквозные сценарии и бюджеты
  производительности).

  Файл лежит в tests/helpers/ и тестом не считается: jest собирает только
  *.test.js.
*/

const net = require("net");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Свободный порт: сервер поднимается на своём конфиге, но не занимает чужой.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForListening(server, timeoutMs = 3000) {
  if (server.listening) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("сервер не начал слушать порт")), timeoutMs);
    server.once("listening", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/*
  Клиент шины: собирает всё, что пришло, и умеет ждать нужное событие.
  Роль важна — микрокадры уходят только оверлею, поэтому «кто что получил» —
  часть проверки в сценариях.
*/
function createClient(WebSocket, port, role) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=${role}`);
  const messages = [];
  const binary = [];

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      binary.push(Buffer.from(data));
      return;
    }
    try {
      messages.push(JSON.parse(data.toString()));
    } catch {
      /* мусорный кадр в тест не пускаем */
    }
  });

  const opened = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  return {
    role,
    ws,
    messages,
    binary,
    opened,
    send(type, payload) {
      ws.send(JSON.stringify({ type, payload }));
    },
    sendBinary(buffer) {
      ws.send(buffer, { binary: true });
    },
    async waitFor(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) return found;
        await sleep(15);
      }
      throw new Error(
        `не дождались события за ${timeoutMs} мс; пришли: ${messages.map((msg) => msg.type).join(", ") || "ничего"}`
      );
    },
    async waitForBinary(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (binary.length) return binary[binary.length - 1];
        await sleep(15);
      }
      return null;
    },
    close() {
      try {
        ws.close();
      } catch {
        /* уже закрыт */
      }
    },
  };
}

module.exports = { sleep, freePort, waitForListening, createClient };
