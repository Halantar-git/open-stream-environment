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
  Журнал DonationAlerts: что видно в панели сервиса, а что уходит в «Отладку».

  Панель «DA» отвечает на вопрос «почему донаты не приходят», поэтому в неё
  попадает только то, что человек может поправить или чему обрадуется: состояние
  подключения, донаты и цели, ошибки и повторы. Шаги протокола (какой кадр ушёл,
  что ответил Centrifugo) и «сырой» кадр доната — это разбор для поддержки: они
  должны быть видны в панели «Отладка» и в файле журнала, но не вытеснять из
  панели события сервиса. Иначе при живом подключении экран заполняется
  служебными строками, а служебный кадр подписки выглядит как полученный донат
  без доната.
*/

jest.mock("ws", () => {
  const { EventEmitter } = require("events");

  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1; // OPEN
      this.sentFrames = [];
    }

    send(frame) {
      this.sentFrames.push(String(frame).trim());
    }

    close() {
      this.readyState = 3;
    }

    terminate() {
      this.readyState = 3;
    }

    ping() {}
  }

  const createSocket = function () {
    const socket = new FakeSocket();
    createSocket.instances.push(socket);
    return socket;
  };
  createSocket.instances = [];
  createSocket.OPEN = 1;
  return createSocket;
});

const { EventEmitter } = require("events");

const WebSocket = require("ws");
const { startDonationAlerts } = require("../server/integrations/donationalerts");

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function jsonResponse(payload, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe("donationalerts: журнал сервиса и панель «Отладка»", () => {
  let bus;
  let terminal;
  let debugLog;
  let controller;
  let state;

  function daMessages() {
    return terminal.filter((entry) => entry.service === "donationalerts");
  }

  function socket() {
    return WebSocket.instances[WebSocket.instances.length - 1];
  }

  beforeEach(async () => {
    WebSocket.instances.length = 0;
    bus = new EventEmitter();
    terminal = [];
    debugLog = [];
    bus.on("terminal_log", (entry) => terminal.push(entry));
    bus.on("debug_log", (entry) => debugLog.push(entry));

    state = {
      config: {
        port: 8710,
        donationAlerts: {
          clientId: "20511",
          clientSecret: "client-secret",
          accessToken: "access-token",
          refreshToken: "refresh-token",
          userId: 4242,
          expiresAt: Date.now() + 60 * 60 * 1000,
        },
      },
      saveDonationAlertsTokens: () => {},
    };

    global.fetch = async (url) => {
      const href = String(url);
      if (href.includes("/api/v1/user/oauth")) {
        return jsonResponse({ data: { id: 4242, socket_connection_token: "socket-token" } });
      }
      if (href.includes("/centrifuge/subscribe")) {
        return jsonResponse({ channels: [{ channel: "$alerts:donation_4242", token: "subscribe-token" }] });
      }
      return jsonResponse({});
    };

    // Подключение как в жизни: запрос профиля, открытие сокета, ответ на connect.
    controller = startDonationAlerts({ bus, state });
    await tick();
    socket().emit("open");
    socket().emit("message", JSON.stringify({ id: 1, result: { client: "centrifuge-client" } }));
    await tick();
  });

  afterEach(() => {
    if (controller) controller.stop();
    delete global.fetch;
  });

  test("подключение в журнале — две строки, а не шесть", () => {
    const messages = daMessages().map((entry) => entry.message);

    expect(messages).toContain("connecting…");
    expect(messages).toContain("connected and subscribed");

    // Шаги протокола в панель сервиса не попадают.
    const noise = [
      "user/oauth parsed",
      "opening Centrifugo socket",
      "sending connect frame",
      "centrifugo connected",
      "subscribing to channels",
    ];
    noise.forEach((message) => expect(messages).not.toContain(message));
  });

  test("шаги протокола не пропадают — они в «Отладке»", () => {
    const debugMessages = debugLog.map((entry) => entry.message);

    expect(debugMessages).toContain("sending connect frame");
    expect(debugMessages).toContain("subscribing to channels");
  });

  test("донат виден в журнале, а его «сырой» кадр — только в «Отладке»", () => {
    socket().emit(
      "message",
      JSON.stringify({
        push: {
          channel: "$alerts:donation_4242",
          pub: { data: { data: { username: "viewer", amount: 250, currency: "RUB", message: "gg" } } },
        },
      })
    );

    const messages = daMessages();
    const alert = messages.find((entry) => entry.message === "alert received");

    expect(alert).toBeTruthy();
    expect(alert.level).toBe("success");
    expect(alert.data).toMatchObject({ user: "viewer", amount: 250, currency: "RUB" });
    // Тот самый кадр, из-за которого в журнале появлялся «донат» без доната.
    expect(messages.map((entry) => entry.message)).not.toContain("raw donation frame");
    expect(debugLog.map((entry) => entry.message)).toContain("raw donation frame");
  });
});
