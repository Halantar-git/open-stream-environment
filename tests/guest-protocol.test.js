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
  Приглашение гостевой камеры: разбор, сборка и проверка полей.

  Строка приходит из мессенджера, поэтому проверяется целиком: недопустимый
  порт или токен не должны доехать до сетевого запроса. Имя слота — короткий
  идентификатор (`cam2`…`cam5`), а не подпись: подпись локализует интерфейс.
*/

const {
  SCHEME,
  CLOUD_SCHEME,
  SLOTS,
  createInvite,
  createCloudInvite,
  parseInvite,
  inviteWsUrl,
  normalizeSlot,
  normalizeHost,
  normalizePort,
  normalizeToken,
  normalizeSignal,
  normalizeRoom,
  DEFAULT_STUN,
  iceServers,
  splitIceUrls,
} = require("../shared/guest-protocol");

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("guest-protocol: приглашение", () => {
  test("собирается и разбирается без потерь", () => {
    const invite = createInvite({ host: "192.168.1.10", port: 8710, slot: "cam2", token: TOKEN, name: "Аня" });
    expect(invite.startsWith(`${SCHEME}?`)).toBe(true);
    expect(parseInvite(invite)).toEqual({
      mode: "lan",
      host: "192.168.1.10",
      port: 8710,
      slot: "cam2",
      token: TOKEN,
      name: "Аня",
    });
  });

  test("имя необязательно и обрезается по длине", () => {
    const invite = createInvite({ host: "ose.local", port: 8710, slot: "cam3", token: TOKEN, name: "  " });
    expect(parseInvite(invite).name).toBe("");

    const long = createInvite({ host: "ose.local", port: 8710, slot: "cam3", token: TOKEN, name: "я".repeat(80) });
    expect(parseInvite(long).name.length).toBe(40);
  });

  test("облачное приглашение несёт адрес сервиса и комнату", () => {
    const invite = createCloudInvite({
      signal: "wss://signal.ose-overlay.ru/",
      room: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      slot: "cam3",
      token: TOKEN,
      name: "Боря",
    });
    expect(invite.startsWith(`${CLOUD_SCHEME}?`)).toBe(true);
    expect(parseInvite(invite)).toEqual({
      mode: "cloud",
      signal: "wss://signal.ose-overlay.ru",
      room: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      slot: "cam3",
      token: TOKEN,
      name: "Боря",
    });
  });

  test("адрес signaling и комната проверяются", () => {
    expect(normalizeSignal("wss://signal.ose-overlay.ru/")).toBe("wss://signal.ose-overlay.ru");
    expect(normalizeSignal("http://signal.ose-overlay.ru")).toBe("");
    expect(normalizeSignal("wss://signal.ose-overlay.ru?x=1")).toBe("");
    expect(normalizeRoom("a1b2c3d4e5f60718")).toBe("a1b2c3d4e5f60718");
    expect(normalizeRoom("short")).toBe("");
    expect(
      createCloudInvite({ signal: "https://x", room: "a1b2c3d4e5f60718", slot: "cam2", token: TOKEN })
    ).toBe("");
  });

  test("чужой или повреждённый текст не принимается", () => {
    expect(parseInvite("")).toBeNull();
    expect(parseInvite("https://ose-overlay.ru")).toBeNull();
    expect(parseInvite(`${SCHEME}?host=192.168.1.10&port=8710&slot=cam2`)).toBeNull();
    expect(parseInvite(`${SCHEME}?host=192.168.1.10&port=8710&slot=cam9&token=${TOKEN}`)).toBeNull();
    expect(parseInvite(`${SCHEME}?host=192.168.1.10&port=99999&slot=cam2&token=${TOKEN}`)).toBeNull();
    expect(parseInvite(`${SCHEME}?host=bad host&port=8710&slot=cam2&token=${TOKEN}`)).toBeNull();
    expect(parseInvite(`${SCHEME}?host=192.168.1.10&port=8710&slot=cam2&token=short`)).toBeNull();
  });

  test("недопустимые поля не дают собрать приглашение", () => {
    expect(createInvite({ host: "", port: 8710, slot: "cam2", token: TOKEN })).toBe("");
    expect(createInvite({ host: "192.168.1.10", port: 0, slot: "cam2", token: TOKEN })).toBe("");
    expect(createInvite({ host: "192.168.1.10", port: 8710, slot: "cam1", token: TOKEN })).toBe("");
    expect(createInvite({ host: "192.168.1.10", port: 8710, slot: "cam2", token: "<script>" })).toBe("");
  });

  test("нормализация терпима к регистру и пробелам, но не к мусору", () => {
    expect(normalizeSlot(" CAM2 ")).toBe("cam2");
    expect(normalizeSlot("cam1")).toBe("");
    expect(normalizeHost(" MyPC.Local ")).toBe("mypc.local");
    expect(normalizeHost("http://192.168.1.10")).toBe("");
    expect(normalizePort("8710")).toBe(8710);
    expect(normalizePort("8710.5")).toBe(0);
    expect(normalizeToken(` ${TOKEN} `)).toBe(TOKEN);
    expect(normalizeToken("токен")).toBe("");
    expect(SLOTS).toEqual(["cam2", "cam3", "cam4", "cam5"]);
  });

  test("адрес шины собирается из разобранного приглашения", () => {
    const invite = parseInvite(
      createInvite({ host: "192.168.1.10", port: 8710, slot: "cam2", token: TOKEN })
    );
    const url = inviteWsUrl(invite);
    expect(url).toBe(`ws://192.168.1.10:8710/ws?role=guest&slot=cam2&token=${TOKEN}`);
    expect(inviteWsUrl(null)).toBe("");
  });
});

describe("guest-protocol: ICE", () => {
  test("без настроек берутся встроенные STUN-серверы", () => {
    // Пустой список — не «без STUN»: иначе через интернет остаются только
    // локальные кандидаты и соединение не поднимается.
    expect(iceServers(null)).toEqual([{ urls: DEFAULT_STUN }]);
    expect(iceServers({})).toEqual([{ urls: DEFAULT_STUN }]);
    expect(iceServers({ stunUrls: "" })).toEqual([{ urls: DEFAULT_STUN }]);
  });

  test("свои STUN и TURN попадают в конфигурацию", () => {
    const servers = iceServers({
      stunUrls: "stun:stun.example.org:3478, stun:stun.example.org:3478",
      turnUrls: "turn:turn.example.org:3478",
      turnUser: " guest ",
      turnPassword: "secret",
    });
    expect(servers).toEqual([
      { urls: ["stun:stun.example.org:3478"] },
      { urls: ["turn:turn.example.org:3478"], username: "guest", credential: "secret" },
    ]);
  });

  test("мусор и чужие схемы отбрасываются", () => {
    expect(splitIceUrls("http://example.org, ws://x, stun:ok:3478")).toEqual(["stun:ok:3478"]);
    expect(splitIceUrls(["turns:ok:5349", 42, null, "stun: with space"])).toEqual(["turns:ok:5349"]);
    expect(splitIceUrls("x".repeat(300)).length).toBe(0);
  });

  test("TURN без логина тоже допустим и не тащит пустые поля", () => {
    const servers = iceServers({ turnUrls: "turn:turn.example.org:3478" });
    expect(servers[1]).toEqual({ urls: ["turn:turn.example.org:3478"] });
    expect(servers[1]).not.toHaveProperty("username");
    expect(servers[1]).not.toHaveProperty("credential");
  });
});
