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
  Приглашение гостевой камеры — одна строка, которую хост копирует и
  отправляет гостю любым мессенджером.

  Формат намеренно похож на ссылку, но открывается не браузером, а OSE:
  гость вставляет строку в панель. Так в приглашение помещаются адрес хоста,
  слот и одноразовый токен, и ничего не нужно диктовать по частям.

  Разбор строгий: строка приходит из чужого мессенджера, поэтому всё, что
  пойдёт дальше в сетевой запрос, проверяется здесь, а не по месту.

  Формат UMD, как у остальных shared-модулей: страницы берут его из window,
  Jest — через require.
*/
(function (root) {
  "use strict";

  const SCHEME = "ose-join://v1";
  const CLOUD_SCHEME = "ose-join://v2";
  const SLOTS = ["cam2", "cam3", "cam4"];
  const HOST_PATTERN = /^[a-z0-9.-]+$/i;
  const TOKEN_PATTERN = /^[a-z0-9_-]{16,64}$/i;
  const SIGNAL_PATTERN = /^wss?:\/\/[a-z0-9.:[\]-]+(?:\/[a-z0-9._~/-]*)?$/i;
  const ROOM_PATTERN = /^[a-z0-9_-]{16,64}$/i;

  function normalizeSlot(value) {
    const slot = String(value == null ? "" : value)
      .trim()
      .toLowerCase();
    return SLOTS.includes(slot) ? slot : "";
  }

  function normalizeName(value) {
    // Имя показывает хост в списке слотов; ограничиваем длину, чтобы оно не
    // разъехалось по интерфейсу, но оставляем кириллицу и эмодзи.
    return String(value == null ? "" : value)
      .trim()
      .slice(0, 40);
  }

  function normalizeHost(value) {
    const host = String(value == null ? "" : value)
      .trim()
      .toLowerCase();
    if (!host || host.length > 253) return "";
    if (!HOST_PATTERN.test(host)) return "";
    if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return "";
    return host;
  }

  function normalizePort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
  }

  function normalizeToken(value) {
    const token = String(value == null ? "" : value).trim();
    return TOKEN_PATTERN.test(token) ? token : "";
  }

  /*
    Собрать приглашение. Возвращает пустую строку, если хотя бы одно поле не
    прошло проверку: вызывающий код показывает ошибку, а не отправляет гостю
    строку, которая заведомо не подключится.
  */
  function createInvite(fields) {
    const input = fields || {};
    const host = normalizeHost(input.host);
    const port = normalizePort(input.port);
    const slot = normalizeSlot(input.slot);
    const token = normalizeToken(input.token);
    if (!host || !port || !slot || !token) return "";
    const params = new URLSearchParams();
    params.set("host", host);
    params.set("port", String(port));
    params.set("slot", slot);
    params.set("token", token);
    const name = normalizeName(input.name);
    if (name) params.set("name", name);
    return `${SCHEME}?${params.toString()}`;
  }

  /*
    Приглашение через публичный signaling: адрес сервиса, комната и токен.
    Хост и гость подключаются к сервису сами, поэтому адрес хоста в ссылке не
    нужен — это и делает интернет-приглашение независимым от NAT.
  */
  function normalizeSignal(value) {
    const signal = String(value == null ? "" : value).trim();
    if (!signal || signal.length > 200) return "";
    return SIGNAL_PATTERN.test(signal) ? signal.replace(/\/+$/, "") : "";
  }

  function normalizeRoom(value) {
    const room = String(value == null ? "" : value).trim();
    return ROOM_PATTERN.test(room) ? room : "";
  }

  function createCloudInvite(fields) {
    const input = fields || {};
    const signal = normalizeSignal(input.signal);
    const room = normalizeRoom(input.room);
    const slot = normalizeSlot(input.slot);
    const token = normalizeToken(input.token);
    if (!signal || !room || !slot || !token) return "";
    const params = new URLSearchParams();
    params.set("signal", signal);
    params.set("room", room);
    params.set("slot", slot);
    params.set("token", token);
    const name = normalizeName(input.name);
    if (name) params.set("name", name);
    return `${CLOUD_SCHEME}?${params.toString()}`;
  }

  /*
    Разобрать приглашение. `null` — строка не наша, повреждена или содержит
    недопустимые поля; частично валидные приглашения не принимаем, иначе
    ошибка всплывёт уже в сетевом соединении.
  */
  function parseInvite(text) {
    const raw = String(text == null ? "" : text).trim();
    const lower = raw.toLowerCase();
    const cloud = lower.startsWith(`${CLOUD_SCHEME}?`);
    if (!cloud && !lower.startsWith(`${SCHEME}?`)) return null;
    let params;
    try {
      params = new URLSearchParams(raw.slice(raw.indexOf("?") + 1));
    } catch (_) {
      return null;
    }
    const slot = normalizeSlot(params.get("slot"));
    const token = normalizeToken(params.get("token"));
    if (!slot || !token) return null;
    const name = normalizeName(params.get("name"));
    if (cloud) {
      const signal = normalizeSignal(params.get("signal"));
      const room = normalizeRoom(params.get("room"));
      if (!signal || !room) return null;
      return { mode: "cloud", signal, room, slot, token, name };
    }
    const host = normalizeHost(params.get("host"));
    const port = normalizePort(params.get("port"));
    if (!host || !port) return null;
    return { mode: "lan", host, port, slot, token, name };
  }

  /*
    Адрес шины хоста. Схема зависит от того, как открыт гость: страница на
    https не может ходить на ws, поэтому такие приглашения пойдут через wss
    (нужен публичный signaling), а локальная сеть остаётся на ws.
  */
  function inviteWsUrl(invite) {
    const data = invite && invite.host ? invite : null;
    if (!data) return "";
    const secure = typeof location !== "undefined" && location.protocol === "https:";
    const scheme = secure ? "wss" : "ws";
    const query = new URLSearchParams();
    query.set("role", "guest");
    query.set("slot", data.slot);
    query.set("token", data.token);
    return `${scheme}://${data.host}:${data.port}/ws?${query.toString()}`;
  }

  const api = {
    SCHEME,
    CLOUD_SCHEME,
    SLOTS,
    createInvite,
    createCloudInvite,
    parseInvite,
    normalizeSignal,
    normalizeRoom,
    inviteWsUrl,
    normalizeSlot,
    normalizeName,
    normalizeHost,
    normalizePort,
    normalizeToken,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GuestProtocol = api;
})(typeof window !== "undefined" ? window : globalThis);
