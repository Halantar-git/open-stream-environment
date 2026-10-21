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
  Публичный signaling OSE для Cloudflare Workers.

  Медиа здесь нет: Worker сводит две стороны комнаты и пересылает кадры
  как есть. Комната живёт в Durable Object, по одному на идентификатор из
  приглашения; токен комнаты проверяется до upgrade.

  Деплой и настройка домена — в signal/README.md.
*/

import roomApi from "./room.js";

const { RoomState, ROOM_PATTERN, TOKEN_PATTERN, ROOM_TTL_MS } = roomApi;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/healthz") {
      return new Response("OSE signal", { status: 200 });
    }
    if (url.pathname !== "/ws") {
      return new Response("not found", { status: 404 });
    }
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("websocket required", { status: 426 });
    }
    const room = url.searchParams.get("room") || "";
    if (!ROOM_PATTERN.test(room)) {
      return new Response("bad room", { status: 400 });
    }
    const id = env.ROOMS.idFromName(room);
    return env.ROOMS.get(id).fetch(request);
  },
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = new RoomState();
    this.sockets = { host: null, guest: null };
    this.loaded = null;
  }

  /*
    Токен комнаты переживает перезапуск изолята: Durable Object может быть
    выгружен, а приглашение к этому моменту ещё действительно.
  */
  async load() {
    if (!this.loaded) {
      this.loaded = (async () => {
        const token = await this.state.storage.get("token");
        const createdAt = await this.state.storage.get("createdAt");
        if (typeof token === "string" && TOKEN_PATTERN.test(token)) {
          this.room.token = token;
          this.room.createdAt = Number(createdAt) || Date.now();
        }
      })();
    }
    return this.loaded;
  }

  async fetch(request) {
    await this.load();

    const url = new URL(request.url);
    const role = url.searchParams.get("role") || "";
    const token = url.searchParams.get("token") || "";
    const name = (url.searchParams.get("name") || "").slice(0, 40);
    if (!["host", "guest"].includes(role) || !TOKEN_PATTERN.test(token)) {
      return new Response("forbidden", { status: 403 });
    }
    if (this.sockets[role]) {
      return new Response("busy", { status: 409 });
    }

    const attached = this.room.attach(role, token, name, Date.now());
    if (!attached.ok) {
      return new Response(attached.error, { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets[role] = server;

    if (attached.created) {
      await this.state.storage.put("token", token);
      await this.state.storage.put("createdAt", this.room.createdAt);
    }
    // Пока кто-то в комнате, срок не идёт: длинный эфир не должен обрываться.
    await this.state.storage.deleteAlarm();

    const otherRole = role === "host" ? "guest" : "host";
    const send = (frame) => {
      try {
        if (server.readyState === 1) server.send(JSON.stringify(frame));
      } catch (_) {
        /* сокет уже закрыт */
      }
    };
    send({ type: "joined", payload: { role } });
    const other = this.sockets[otherRole];
    if (other && other.readyState === 1 && attached.peer) {
      send({ type: "peer_joined", payload: { role: otherRole, name: attached.peer.name } });
      try {
        other.send(JSON.stringify({ type: "peer_joined", payload: { role, name } }));
      } catch (_) {
        /* сокет уже закрыт */
      }
    }

    server.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const target = this.sockets[otherRole];
      if (target && target.readyState === 1) {
        try {
          target.send(event.data);
        } catch (_) {
          /* сокет уже закрыт */
        }
      }
    });

    const leave = async () => {
      if (this.sockets[role] !== server) return;
      this.sockets[role] = null;
      this.room.detach(role);
      const target = this.sockets[otherRole];
      if (target && target.readyState === 1) {
        try {
          target.send(JSON.stringify({ type: "peer_left", payload: { role } }));
        } catch (_) {
          /* сокет уже закрыт */
        }
      }
      if (!this.sockets.host && !this.sockets.guest) {
        // Пустая комната ждёт возвращения, но не вечно.
        await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      }
    };
    server.addEventListener("close", leave);
    server.addEventListener("error", leave);

    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    for (const role of ["host", "guest"]) {
      const socket = this.sockets[role];
      if (socket) {
        try {
          socket.close(1000, "room expired");
        } catch (_) {
          /* сокет уже закрыт */
        }
      }
      this.sockets[role] = null;
    }
    this.room = new RoomState();
    await this.state.storage.deleteAll();
  }
}
