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
  Обмен OAuth2-кода GoodGame и выдача токенов приложению.

  Секрет приложения (client_secret) живёт только в Worker: приложение получает
  готовые токены по одноразовому state и verifier, которые не попадают в
  адресную строку. Чистые части вынесены сюда, чтобы их проверяли тесты без
  Cloudflare и без сети; маршруты и хранилище — в worker.js.
*/

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OSESignalOauth = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STATE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
  const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
  const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,96}$/;

  const CALLBACK_PATHS = ["/oauth/goodgame/callback", "/oauth/goodgame/callback/"];
  const PREPARE_PATH = "/oauth/goodgame/prepare";
  const TICKET_PATH = "/oauth/goodgame/ticket";
  const REFRESH_PATH = "/oauth/goodgame/refresh";

  // Куда Worker возвращает браузер после обмена кода. Порт по умолчанию — как
  // у локального сервера приложения; приложение присылает свой, если порт
  // поменяли в настройках.
  const LOCAL_PORT = 8710;
  const LOCAL_CALLBACK = `http://127.0.0.1:${LOCAL_PORT}/oauth/goodgame/callback`;
  const GOODGAME_TOKEN_URL = "https://goodgame.ru/oauth2/token";
  const GOODGAME_AUTHORIZE_URL = "https://goodgame.ru/oauth2/authorize";

  // Сколько живёт подготовленный state и выданный тикет с токенами.
  const PREPARE_TTL_MS = 15 * 60 * 1000;
  const TICKET_TTL_MS = 5 * 60 * 1000;

  // Адрес возврата, который зарегистрирован в кабинете GoodGame. Слэш в конце
  // важен: сервис сверяет строку целиком. Свой домен подставляется через
  // переменную окружения воркера.
  const DEFAULT_REDIRECT_URI =
    "https://ose-signal.halantar.workers.dev/oauth/goodgame/callback/";

  function isCallbackPath(path) {
    return CALLBACK_PATHS.includes(path);
  }

  function isPreparePath(path) {
    return path === PREPARE_PATH;
  }

  function isTicketPath(path) {
    return path === TICKET_PATH;
  }

  function isRefreshPath(path) {
    return path === REFRESH_PATH;
  }

  /*
    Одноразовый адрес возврата в приложение. В него попадают только известные
    поля: произвольные параметры из запроса наружу не уходят, чтобы Worker не
    стал открытым редиректом.
  */
  function localCallbackUrl(params, port) {
    const target = validPort(port) ? port : LOCAL_PORT;
    const url = new URL(`http://127.0.0.1:${target}/oauth/goodgame/callback`);
    const known = ["state", "ticket", "error", "error_description"];
    for (const key of known) {
      const value = params && params[key];
      if (typeof value === "string" && value) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  function validPort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1024 && port <= 65535;
  }

  /// Адрес авторизации: `redirect_uri` — ровно тот, что в кабинете GoodGame.
  function authorizeUrl(env, state) {
    const params = new URLSearchParams({
      state: String(state || ""),
      scope: "",
      response_type: "code",
      approval_prompt: "auto",
      redirect_uri: redirectUri(env),
      client_id: String((env && env.GOODGAME_CLIENT_ID) || ""),
    });
    return `${GOODGAME_AUTHORIZE_URL}?${params.toString()}`;
  }

  function redirectUri(env) {
    const configured = env && env.GOODGAME_REDIRECT_URI;
    return typeof configured === "string" && configured.trim()
      ? configured.trim()
      : DEFAULT_REDIRECT_URI;
  }

  function tokenForm(env, code) {
    return new URLSearchParams({
      grant_type: "authorization_code",
      client_id: String((env && env.GOODGAME_CLIENT_ID) || ""),
      client_secret: String((env && env.GOODGAME_CLIENT_SECRET) || ""),
      redirect_uri: redirectUri(env),
      code: String(code || ""),
    });
  }

  function refreshForm(env, refreshToken) {
    return new URLSearchParams({
      grant_type: "refresh_token",
      client_id: String((env && env.GOODGAME_CLIENT_ID) || ""),
      client_secret: String((env && env.GOODGAME_CLIENT_SECRET) || ""),
      redirect_uri: redirectUri(env),
      refresh_token: String(refreshToken || ""),
    });
  }

  function validState(value) {
    return STATE_PATTERN.test(String(value || ""));
  }

  function validVerifier(value) {
    return VERIFIER_PATTERN.test(String(value || ""));
  }

  function validTicket(value) {
    return TICKET_PATTERN.test(String(value || ""));
  }

  function keyFor(prefix, value) {
    return `${prefix}:${value}`;
  }

  /*
    Что именно хешируется, чтобы приложение доказало, что state выдало оно:
    state известен из адресной строки, verifier не покидал приложение. В
    хранилище воркера лежит только SHA-256 от этой строки.
  */
  function proofInput(state, verifier) {
    return `${state}:${verifier}`;
  }

  return {
    CALLBACK_PATHS,
    PREPARE_PATH,
    TICKET_PATH,
    REFRESH_PATH,
    LOCAL_PORT,
    LOCAL_CALLBACK,
    PREPARE_TTL_MS,
    TICKET_TTL_MS,
    DEFAULT_REDIRECT_URI,
    GOODGAME_TOKEN_URL,
    GOODGAME_AUTHORIZE_URL,
    isCallbackPath,
    isPreparePath,
    isTicketPath,
    isRefreshPath,
    localCallbackUrl,
    validPort,
    authorizeUrl,
    redirectUri,
    tokenForm,
    refreshForm,
    validState,
    validVerifier,
    validTicket,
    keyFor,
    proofInput,
  };
});
