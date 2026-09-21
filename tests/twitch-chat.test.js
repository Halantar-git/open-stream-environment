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
  Разбор IRC-тегов Twitch в сообщение для шины.

  Проверяем то, что нельзя увидеть глазами без живого чата: цвет берётся из тега
  `color`, а если тег пустой — считается по идентификатору зрителя, а не падает в
  общий серый. Остальные поля (имя, бейджи, эмоуты) переносятся как есть.
*/

const { chatMessageFromTags, sendTwitchChatMessage, moderateUser } = require("../server/integrations/twitch-chat");
const { nickColor, DEFAULT_NICK_COLOR } = require("../server/nick-color");
const EventBus = require("../overlay/event-bus");

describe("chatMessageFromTags", () => {
  test("цвет берётся из тега color", () => {
    const msg = chatMessageFromTags({ "display-name": "Зритель", "user-id": "42", color: "#1e90ff" }, "привет");

    expect(msg.color).toBe("#1e90ff");
    expect(msg.user).toBe("Зритель");
    expect(msg.userId).toBe("42");
    expect(msg.message).toBe("привет");
  });

  test("пустой тег color заменяется цветом по user-id", () => {
    const msg = chatMessageFromTags({ "display-name": "Зритель", "user-id": "42", color: "" }, "привет");

    expect(msg.color).toBe(nickColor("42"));
    expect(msg.color).not.toBe(DEFAULT_NICK_COLOR);
  });

  test("без user-id цвет считается по логину", () => {
    const msg = chatMessageFromTags({ "display-name": "Зритель", username: "zritel" }, "привет");

    expect(msg.color).toBe(nickColor("zritel"));
  });

  test("совсем без автора остаётся прежний единый цвет", () => {
    const msg = chatMessageFromTags({}, "привет");

    expect(msg.user).toBe("viewer");
    expect(msg.userId).toBe("");
    expect(msg.color).toBe(DEFAULT_NICK_COLOR);
  });

  test("бейджи и эмоуты переносятся из тегов", () => {
    const msg = chatMessageFromTags({ badges: { moderator: "1", subscriber: "12" }, emotes: { 25: ["0-4"] } }, "hi");

    expect(msg.badges).toEqual(["moderator", "subscriber"]);
    expect(msg.emotes).toEqual({ 25: ["0-4"] });
  });

  test("теги могут быть пустыми: сообщение собирается без падения", () => {
    expect(chatMessageFromTags(null, "hi")).toEqual({
      user: "viewer",
      userId: "",
      color: DEFAULT_NICK_COLOR,
      badges: [],
      message: "hi",
      emotes: {},
    });
  });
});

/*
  Сетевой сбой (DNS, таймаут, разрыв) не должен реджектить промис: вызывающие
  (панель, чат-бот) ждут объект с ошибкой, иначе падение всплывает как
  unhandledRejection и ответа не видит никто.
*/
describe("twitch-chat: сетевой сбой fetch", () => {
  function makeState() {
    return {
      config: {
        twitch: {
          channel: "chan",
          clientId: "cid",
          userAccessToken: "tok",
          broadcasterId: "bid",
        },
      },
      saveTwitchTokens: () => {},
    };
  }

  beforeEach(() => {
    global.fetch = jest.fn(() => Promise.reject(new Error("offline")));
  });

  afterEach(() => {
    delete global.fetch;
  });

  test("sendTwitchChatMessage возвращает { ok:false, error:'network' }", async () => {
    const bus = new EventBus();

    await expect(sendTwitchChatMessage({ bus, state: makeState(), message: "привет" })).resolves.toEqual({
      ok: false,
      error: "network",
    });
  });

  test("moderateUser возвращает { ok:false, error:'network' }", async () => {
    const bus = new EventBus();

    await expect(
      moderateUser({ bus, state: makeState(), userId: "42", duration: 60, reason: "test" })
    ).resolves.toEqual({ ok: false, error: "network" });
  });
});
