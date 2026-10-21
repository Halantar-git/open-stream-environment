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

  Там же живёт обмен OAuth2-кода GoodGame: секрет приложения остаётся в
  воркере, а приложение получает токены по одноразовому state и verifier.
  Подробности — в signal/README.md, чистые правила — в signal/oauth.js.
*/

import roomApi from "./room.js";
import oauthApi from "./oauth.js";

const { RoomState, ROOM_PATTERN, TOKEN_PATTERN, ROOM_TTL_MS } = roomApi;
const {
  PREPARE_TTL_MS,
  TICKET_TTL_MS,
  isCallbackPath,
  isPreparePath,
  isTicketPath,
  isRefreshPath,
  localCallbackUrl,
  authorizeUrl,
  tokenForm,
  refreshForm,
  validState,
  validVerifier,
  validTicket,
  keyFor,
  proofInput,
} = oauthApi;

/// Сколько живёт подготовленный state и сколько — выданный тикет с токенами.
const PREPARE_MS = PREPARE_TTL_MS || 15 * 60 * 1000;
const TICKET_MS = TICKET_TTL_MS || 5 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/healthz") {
      return new Response("OSE signal", { status: 200 });
    }
    if (isCallbackPath(url.pathname)) {
      return oauthCallback(request, env, url);
    }
    if (isPreparePath(url.pathname) || isTicketPath(url.pathname) || isRefreshPath(url.pathname)) {
      return oauthPost(request, env, url);
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

/*
  OAuth2 GoodGame.

  Приложение присылает state и verifier в `/prepare`; в хранилище остаётся
  только хеш от пары — так утечка Durable Object не даёт забрать токены.
  GoodGame возвращает браузер на `/callback` с кодом, воркер меняет код на
  токены и отдаёт браузеру одноразовый тикет. Токены забирает приложение по
  `ticket` + `verifier`, и только на localhost: в адресную строку они не
  попадают.
*/

async function oauthPost(request, env, url) {
  if (request.method !== "POST") {
    return oauthJson({ error: "method_not_allowed" }, 405);
  }
  const fields = await readForm(request);
  if (isPreparePath(url.pathname)) return oauthPrepare(fields, env);
  if (isTicketPath(url.pathname)) return oauthTakeTicket(fields, env);
  return oauthRefresh(fields, env);
}

async function oauthPrepare(fields, env) {
  const state = String(fields.state || "");
  const verifier = String(fields.verifier || "");
  if (!validState(state) || !validVerifier(verifier)) {
    return oauthJson({ error: "bad_request" }, 400);
  }
  if (!env.GOODGAME_CLIENT_ID) {
    // Без ключа приложения сервис вернёт отказ уже после браузера, поэтому
    // честнее сказать об этом сразу.
    return oauthJson({ error: "not_configured" }, 503);
  }
  const port = fields.port;
  await storePut(env, keyFor("prepare", state), {
    proof: await sha256Hex(proofInput(state, verifier)),
    port: oauthApi.validPort(port) ? Number(port) : oauthApi.LOCAL_PORT,
  }, PREPARE_MS);
  return oauthJson({ ok: true, authorize_url: authorizeUrl(env, state) });
}

async function oauthCallback(request, env, url) {
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error") || "";
  const description = url.searchParams.get("error_description") || "";

  const prepare = validState(state) ? await storeGet(env, keyFor("prepare", state)) : null;
  const port = prepare && oauthApi.validPort(prepare.port) ? prepare.port : oauthApi.LOCAL_PORT;
  if (error) {
    return redirect(localCallbackUrl({ state, error, error_description: description }, port));
  }
  if (!prepare) {
    return redirect(localCallbackUrl({ state: validState(state) ? state : "", error: "unknown_state" }, port));
  }
  const code = url.searchParams.get("code") || "";
  if (!code) {
    return redirect(localCallbackUrl({ state, error: "missing_code" }, port));
  }

  const outcome = await postToken(env, tokenForm(env, code));
  if (!outcome.ok || !outcome.body.access_token) {
    // Текст ошибки GoodGame не содержит секретов: код обмена и токены сюда не
    // попадают.
    const reason = String(outcome.body.error || outcome.body.message || "token_exchange_failed");
    return redirect(localCallbackUrl({ state, error: "token_exchange_failed", error_description: reason }, port));
  }

  const ticket = randomToken(24);
  await storePut(env, keyFor("ticket", ticket), outcome.body, TICKET_MS);
  return redirect(localCallbackUrl({ state, ticket }, port));
}

async function oauthTakeTicket(fields, env) {
  const state = String(fields.state || "");
  const verifier = String(fields.verifier || "");
  const ticket = String(fields.ticket || "");
  if (!validState(state) || !validVerifier(verifier) || !validTicket(ticket)) {
    return oauthJson({ error: "bad_request" }, 400);
  }
  const prepare = await storeGet(env, keyFor("prepare", state));
  if (!prepare) return oauthJson({ error: "expired_state" }, 410);
  if (prepare.proof !== (await sha256Hex(proofInput(state, verifier)))) {
    return oauthJson({ error: "forbidden" }, 403);
  }
  const tokens = await storeTake(env, keyFor("ticket", ticket));
  if (!tokens) return oauthJson({ error: "expired_ticket" }, 410);
  await storeDelete(env, keyFor("prepare", state));
  return oauthJson(tokens);
}

async function oauthRefresh(fields, env) {
  const refresh = String(fields.refresh_token || "");
  if (refresh.length < 16 || refresh.length > 512) {
    return oauthJson({ error: "bad_request" }, 400);
  }
  const outcome = await postToken(env, refreshForm(env, refresh));
  return oauthJson(outcome.body, outcome.status || 502);
}

async function postToken(env, form) {
  try {
    const response = await fetch(oauthApi.GOODGAME_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    let body = {};
    try {
      body = await response.json();
    } catch (_) {
      body = {};
    }
    return { ok: response.ok, status: response.status, body };
  } catch (_) {
    return { ok: false, status: 0, body: {} };
  }
}

async function readForm(request) {
  try {
    const contentType = request.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      return (await request.json()) || {};
    }
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  } catch (_) {
    return {};
  }
}

function oauthJson(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function store(env) {
  return env.TICKETS.get(env.TICKETS.idFromName("oauth"));
}

async function storeCall(env, body) {
  const response = await store(env).fetch("https://oauth-store/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    return await response.json();
  } catch (_) {
    return { ok: false };
  }
}

async function storePut(env, key, value, ttl) {
  await storeCall(env, { op: "put", key, value, ttl });
}

async function storeGet(env, key) {
  const result = await storeCall(env, { op: "get", key });
  return result.ok ? result.value : null;
}

async function storeTake(env, key) {
  const result = await storeCall(env, { op: "take", key });
  return result.ok ? result.value : null;
}

async function storeDelete(env, key) {
  await storeCall(env, { op: "delete", key });
}

/*
  Короткоживущее хранилище OAuth-состояний. Durable Object выбран вместо KV,
  чтобы деплой не требовал ручного создания пространства имён: миграция
  создаёт класс сама. Записей мало (один вход на пользователя), поэтому один
  экземпляр на всех достаточен.
*/
export class TicketStore {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    let body;
    try {
      body = (await request.json()) || {};
    } catch (_) {
      return oauthJson({ ok: false }, 400);
    }
    const key = String(body.key || "");
    const now = Date.now();
    if (body.op === "put") {
      const ttl = Math.max(1, Number(body.ttl) || 1);
      await this.state.storage.put(key, { value: body.value, expiresAt: now + ttl });
      return oauthJson({ ok: true });
    }
    if (body.op === "delete") {
      await this.state.storage.delete(key);
      return oauthJson({ ok: true });
    }
    const entry = await this.state.storage.get(key);
    if (!entry || entry.expiresAt <= now) {
      if (entry) await this.state.storage.delete(key);
      return oauthJson({ ok: false });
    }
    if (body.op === "take") await this.state.storage.delete(key);
    return oauthJson({ ok: true, value: entry.value });
  }
}

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
