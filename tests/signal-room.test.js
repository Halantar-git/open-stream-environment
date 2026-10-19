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
  Комната публичного signaling (signal/room.js): кто создаёт, кто входит,
  что происходит при обрыве и истечении срока.
*/

const { RoomState, ROOM_TTL_MS } = require("../signal/room");

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("signal/room: участники", () => {
  test("хост создаёт комнату, гость входит по тому же токену", () => {
    const room = new RoomState();
    expect(room.attach("host", TOKEN, "Хост", 1000)).toEqual({
      ok: true,
      created: true,
      peer: null,
    });
    expect(room.attach("guest", TOKEN, "Аня", 1100)).toEqual({
      ok: true,
      created: false,
      peer: { role: "host", name: "Хост" },
    });
    expect(room.peer("host")).toEqual({ role: "guest", name: "Аня" });
    expect(room.peer("guest")).toEqual({ role: "host", name: "Хост" });
  });

  test("гость не может создать комнату первым", () => {
    const room = new RoomState();
    expect(room.attach("guest", TOKEN, "Аня", 1000)).toEqual({ ok: false, error: "missing" });
  });

  test("чужой токен, занятое место и неизвестная роль отклоняются", () => {
    const room = new RoomState();
    room.attach("host", TOKEN, "Хост", 1000);
    expect(room.attach("guest", "ffffffffffffffffffffffffffffffff", "Аня", 1100)).toEqual({
      ok: false,
      error: "token",
    });
    expect(room.attach("guest", TOKEN, "Аня", 1100).ok).toBe(true);
    expect(room.attach("guest", TOKEN, "Боря", 1200)).toEqual({ ok: false, error: "busy" });
    expect(room.attach("viewer", TOKEN, "Кто-то", 1200)).toEqual({ ok: false, error: "role" });
    expect(room.attach("host", "short", "Хост", 1200)).toEqual({ ok: false, error: "token" });
  });

  test("уход одного оставляет второго и сообщает о нём", () => {
    const room = new RoomState();
    room.attach("host", TOKEN, "Хост", 1000);
    room.attach("guest", TOKEN, "Аня", 1100);
    expect(room.detach("guest")).toEqual({ role: "host", name: "Хост" });
    expect(room.peer("host")).toBeNull();
    // Гость может вернуться в ту же комнату: токен ещё жив.
    expect(room.attach("guest", TOKEN, "Аня", 1200).ok).toBe(true);
  });

  test("имена обрезаются до сорока символов", () => {
    const room = new RoomState();
    room.attach("host", TOKEN, "я".repeat(80), 1000);
    room.attach("guest", TOKEN, "Аня", 1100);
    expect(room.peer("guest").name.length).toBe(40);
  });

  test("пустая комната истекает, занятая — нет", () => {
    const room = new RoomState();
    room.attach("host", TOKEN, "Хост", 1000);
    expect(room.expired(1000 + ROOM_TTL_MS + 1)).toBe(false);
    room.detach("host");
    expect(room.expired(1000 + ROOM_TTL_MS - 1)).toBe(false);
    expect(room.expired(1000 + ROOM_TTL_MS + 1)).toBe(true);
  });
});
