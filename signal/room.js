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
  Состояние комнаты signaling: ровно два места — «хост» и «гость».

  Медиа через сервис не идёт: здесь только пара сокетов и пересылка SDP/ICE.
  Логика отделена от Cloudflare Durable Object, чтобы её можно было проверить
  тестами без сети и без платформы.

  Комната создаётся хостом: он первым приносит токен. Гость обязан принести
  тот же токен. Токен живёт в памяти Durable Object и в его хранилище — этого
  достаточно, чтобы пережить перезапуск изолята, который не рвёт открытые
  сокеты.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OSESignalRoom = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ROOM_PATTERN = /^[a-z0-9_-]{16,64}$/i;
  const TOKEN_PATTERN = /^[a-z0-9_-]{16,64}$/i;
  const ROLES = ["host", "guest"];

  /// Сколько комната ждёт возвращения после обрыва.
  const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

  class RoomState {
    constructor() {
      this.token = "";
      this.createdAt = 0;
      this.peers = { host: null, guest: null };
    }

    /*
      Занять место. `token` — секрет из приглашения; пустая комната создаётся
      только хостом. Возвращает ошибку строкой или сведения о втором участнике.
    */
    attach(role, token, name, now) {
      if (!ROLES.includes(role)) return { ok: false, error: "role" };
      if (!TOKEN_PATTERN.test(String(token || ""))) return { ok: false, error: "token" };
      if (this.token && this.token !== token) return { ok: false, error: "token" };
      if (this.peers[role]) return { ok: false, error: "busy" };
      const creating = !this.token;
      if (creating) {
        if (role !== "host") return { ok: false, error: "missing" };
        this.token = token;
        this.createdAt = now || Date.now();
      }
      this.peers[role] = { name: String(name || "").slice(0, 40) };
      return { ok: true, created: creating, peer: this.peer(role) };
    }

    detach(role) {
      if (!ROLES.includes(role)) return null;
      this.peers[role] = null;
      return this.peer(role);
    }

    peer(role) {
      const otherRole = role === "host" ? "guest" : "host";
      return this.peers[otherRole] ? { role: otherRole, name: this.peers[otherRole].name } : null;
    }

    expired(now, ttl = ROOM_TTL_MS) {
      return (
        !this.peers.host &&
        !this.peers.guest &&
        this.createdAt > 0 &&
        (now || Date.now()) - this.createdAt > ttl
      );
    }
  }

  return { RoomState, ROOM_PATTERN, TOKEN_PATTERN, ROOM_TTL_MS, ROLES };
});
