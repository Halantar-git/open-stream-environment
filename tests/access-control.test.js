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
  Правила доступа к серверу: локальные клиенты без кода, сетевые — с кодом,
  плюс ограничитель частоты команд. Проверяются решения, а не сокеты: подменить
  адрес клиента в живом соединении нельзя, а именно от адреса зависит ответ
  «пустить или нет».
*/

const {
  isLoopbackAddress,
  isLoopbackRequest,
  presentedToken,
  checkUpgrade,
  createCommandLimiter,
} = require("../server/access-control");

// Запрос-заготовка: адрес клиента, источник и URL — то, что читают правила.
function request(address, { url = "/ws?role=test", origin } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  return { socket: { remoteAddress: address }, headers, url };
}

describe("access-control: локальный или сетевой клиент", () => {
  test("loopback в разных видах распознаётся", () => {
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].forEach((address) => {
      expect(isLoopbackAddress(address)).toBe(true);
      expect(isLoopbackRequest(request(address))).toBe(true);
    });
  });

  test("адреса локальной сети и пустой адрес — не loopback", () => {
    ["192.168.1.42", "10.0.0.7", "172.16.0.1", "::ffff:192.168.1.42", "", undefined].forEach((address) => {
      expect(isLoopbackAddress(address)).toBe(false);
      expect(isLoopbackRequest(request(address))).toBe(false);
    });
  });
});

describe("access-control: код доступа", () => {
  test("код берётся из query или заголовка", () => {
    expect(presentedToken(request("192.168.1.5", { url: "/ws?role=remote&token=abc" }))).toBe("abc");
    expect(presentedToken({ headers: { "x-ose-token": "hdr" }, url: "/ws" })).toBe("hdr");
    expect(presentedToken({ headers: { "x-ose-code": "legacy" }, url: "/ws" })).toBe("legacy");
  });

  test("без кода и с чужим URL — пустая строка, а не исключение", () => {
    expect(presentedToken(request("192.168.1.5", { url: "/ws" }))).toBe("");
    expect(presentedToken({ headers: {}, url: "/ws?role=remote" })).toBe("");
    expect(presentedToken(null)).toBe("");
    expect(presentedToken({ headers: {}, url: "%" })).toBe("");
  });
});

describe("access-control: решение по подключению к шине", () => {
  const allowedOrigin = () => true;
  const deniedOrigin = () => false;
  const tokenIs = (expected) => (given) => given === expected;

  test("локальный клиент проходит без кода", () => {
    const decision = checkUpgrade(request("127.0.0.1"), { port: 8710, isAllowedOrigin: allowedOrigin, matchesToken: tokenIs("secret") });

    expect(decision).toEqual({ ok: true, reason: null, external: false });
  });

  test("сетевой клиент без кода не проходит", () => {
    const decision = checkUpgrade(request("192.168.1.5", { origin: "http://192.168.1.5:8710" }), {
      port: 8710,
      isAllowedOrigin: allowedOrigin,
      matchesToken: tokenIs("secret"),
    });

    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("token");
    expect(decision.external).toBe(true);
  });

  test("сетевой клиент с верным кодом проходит", () => {
    const decision = checkUpgrade(request("192.168.1.5", { url: "/ws?role=remote&token=secret" }), {
      port: 8710,
      isAllowedOrigin: allowedOrigin,
      matchesToken: tokenIs("secret"),
    });

    expect(decision.ok).toBe(true);
    expect(decision.external).toBe(true);
  });

  test("сетевой клиент с неверным кодом не проходит", () => {
    const decision = checkUpgrade(request("192.168.1.5", { url: "/ws?role=remote&token=guess" }), {
      port: 8710,
      isAllowedOrigin: allowedOrigin,
      matchesToken: tokenIs("secret"),
    });

    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("token");
  });

  test("чужой источник отсекается раньше кода", () => {
    const decision = checkUpgrade(request("192.168.1.5", { url: "/ws?role=remote&token=secret" }), {
      port: 8710,
      isAllowedOrigin: deniedOrigin,
      matchesToken: tokenIs("secret"),
    });

    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("origin");
  });

  test("пустой код у сервера не открывает шину сети", () => {
    // Семантика как у state.checkRemoteToken: пустое ожидание не совпадает ни с
    // чем, поэтому подстановка «token=» в адрес (или пустой заголовок) доступа
    // не даёт.
    const matches = (expected) => (given) => !!expected && !!given && expected === given;
    const decision = checkUpgrade(request("192.168.1.5", { url: "/ws?role=remote&token=" }), {
      port: 8710,
      isAllowedOrigin: allowedOrigin,
      matchesToken: matches(""),
    });

    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("token");
  });
});

describe("access-control: ограничитель частоты", () => {
  test("пропускает до лимита и отсекает остальное в окне", () => {
    let now = 1000;
    const limiter = createCommandLimiter({ windowMs: 1000, max: 3, clock: () => now });
    const socket = {};

    expect([1, 2, 3].map(() => limiter.allow(socket))).toEqual([true, true, true]);
    expect(limiter.allow(socket)).toBe(false);
    expect(limiter.allow(socket)).toBe(false);
    expect(limiter.counters()).toEqual({ allowed: 3, limited: 2, windows: 1 });
  });

  test("новое окно снова пропускает", () => {
    let now = 1000;
    const limiter = createCommandLimiter({ windowMs: 1000, max: 2, clock: () => now });
    const socket = {};

    limiter.allow(socket);
    limiter.allow(socket);
    expect(limiter.allow(socket)).toBe(false);

    now += 1000;
    expect(limiter.allow(socket)).toBe(true);
    expect(limiter.counters().windows).toBe(2);
  });

  test("лимит считается на клиента, а не общий", () => {
    const limiter = createCommandLimiter({ windowMs: 1000, max: 1, clock: () => 5 });
    const first = {};
    const second = {};

    expect(limiter.allow(first)).toBe(true);
    expect(limiter.allow(first)).toBe(false);
    expect(limiter.allow(second)).toBe(true);
  });

  test("без объекта клиента не падает (учёт тогда невозможен)", () => {
    // В приложении allow() всегда получает сокет; вызов без него — «теоретический»,
    // и здесь важно только то, что он не бросает и не копит состояние.
    const limiter = createCommandLimiter({ windowMs: 1000, max: 1, clock: () => 5 });

    expect(() => {
      for (let i = 0; i < 50; i++) limiter.allow(null);
    }).not.toThrow();
    expect(limiter.counters().limited).toBe(0);
  });

  test("значения по умолчанию — разумный запас к человеческому темпу", () => {
    const limiter = createCommandLimiter();
    expect(limiter.windowMs).toBe(1000);
    expect(limiter.max).toBe(60);
  });
});
