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

const WebSocket = require("ws");

const { redirectUri } = require("../oauth");
const { createLogger } = require("../logger");
const { createTokenRefresher } = require("../token-refresh");

/**
 * DonationAlerts real-time donations over Centrifugo, following:
 * https://www.donationalerts.com/apidoc#introduction__centrifugo
 *
 *   1. GET /api/v1/user/oauth  -> user id + socket_connection_token
 *   2. Open Centrifugo WebSocket and "connect" with that token
 *   3. POST /api/v1/centrifuge/subscribe -> per-channel subscription tokens
 *   4. "subscribe" over the WebSocket; donations/goal updates arrive as pushes
 *
 * Reliability additions over the previous implementation:
 *   - automatic access-token refresh via refresh_token (with redirect_uri)
 *   - heartbeat (WebSocket ping/pong watchdog) to detect half-open connections
 *   - deterministic reconnect with backoff for auth vs. network failures
 *   - structured logging of connect/subscribe/donation/socket events
 */

const CENTRIFUGO_WS = "wss://centrifugo.donationalerts.com/connection/websocket";
const OAUTH_URL = "https://www.donationalerts.com/oauth/token";
const USER_URL = "https://www.donationalerts.com/api/v1/user/oauth";
const SUBSCRIBE_URL = "https://www.donationalerts.com/api/v1/centrifuge/subscribe";
// Список донатов (scope oauth-donation-index). Нужен, чтобы подтянуть то, что
// пришло пока приложение было выключено: Centrifugo отдаёт только живые события.
const DONATIONS_URL = "https://www.donationalerts.com/api/v1/alerts/donations";

const RECONNECT_DELAY_MS = 5000;
const AUTH_ERROR_RECONNECT_MS = 15000;
const HEARTBEAT_MS = 25000;
const PONG_TIMEOUT_MS = 10000;

// Опция подписки по WebSocket:
//   "method" — отправлять Centrifugo v2 RPC-кадры { method: "subscribe", params, id }.
//   "http"   — не отправлять subscribe в сокет: HTTP /centrifuge/subscribe уже
//              регистрирует подписку на стороне DA, только ставим connected.
const SUBSCRIBE_MODE = "method";

/*
  Стоит ли переподключаться после такой ошибки.

  invalid_client — сервис не узнал пару client_id/client_secret. Это не сетевой
  сбой и не протухший токен: повторы ничего не изменят, а будут только
  стучаться в сервис каждые 15 секунд и засорять журнал. Самый частый путь к
  этой ошибке — приложение в кабинете DonationAlerts пересоздали: ключи новые,
  а в настройках остались старые. Интеграция поднимется заново сама, когда
  ключи поправят и нажмут «Подключить DonationAlerts» (restartDonationAlerts).

  Вынесено отдельной функцией, а не условием внутри catch: это правило, которое
  должно быть видно и проверяться тестом, а не теряться в обработчике.
*/
function isUnrecoverableAuthError(message) {
  return /invalid_client/i.test(String(message || ""));
}

function donationAlertFromPayload(payload) {
  // Озвучка от сервиса (готовый аудиофайл доната). Точное имя поля DonationAlerts
  // не задокументировано — кандидаты сведены здесь, при необходимости поправить.
  const firstDefined = (...keys) => {
    for (const key of keys) {
      const value = payload && payload[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  const voiceUrl = firstDefined("voiceUrl", "voice_url", "voice", "audioUrl", "audio_url", "soundUrl", "ttsUrl", "voiceFile", "messageAudio");
  return {
    kind: "donation",
    user: (payload && (payload.username || payload.name)) || "Аноним",
    amount: Number(payload && payload.amount) || 0,
    currency: (payload && payload.currency) || "RUB",
    message: (payload && payload.message) || "",
    // id доната на стороне DonationAlerts: по нему отличаем уже показанный донат
    // от пропущенного (см. db.knownSourceIds).
    ...(payload && payload.id != null ? { sourceId: String(payload.id) } : {}),
    ...(voiceUrl ? { voiceUrl } : {}),
  };
}

/*
  Разбор ответа /api/v1/alerts/donations в наш формат.

  Даты приходят строкой "YYYY-MM-DD HH.MM.SS" без часового пояса (так в apidoc):
  трактуем как UTC — это влияет только на показ времени и на фильтр «новее
  запуска», а пропуски определяются по id донатов, а не по времени.
*/
function parseDonationDate(value) {
  const text = String(value || "");
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2})[.:](\d{2})[.:](\d{2})/);
  if (!match) return 0;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

function normalizeDonationRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    sourceId: row.id != null ? String(row.id) : null,
    kind: "donation",
    user: String(row.username || "Аноним"),
    amount: Number(row.amount) || 0,
    currency: String(row.currency || "RUB"),
    message: String(row.message || ""),
    createdAt: parseDonationDate(row.created_at),
    shown: Number(row.is_shown) === 1 || !!row.shown_at,
  };
}

/*
  Последние донаты через REST.

  Токен передаётся геттером: интеграция сама обновляет его при необходимости, а
  здесь важно только получить актуальный. Ошибки возвращаются объектом, а не
  исключением: вызывающий код показывает понятное сообщение (в том числе «нужно
  переподключить DonationAlerts» при 401/403 — токен выдан без scope
  oauth-donation-index).
*/
async function fetchRecentDonations({ getAccessToken, limit = 30, page = 1, fetchImpl } = {}) {
  const token = typeof getAccessToken === "function" ? await getAccessToken() : getAccessToken;
  if (!token) return { ok: false, error: "not_authorized", donations: [] };
  const doFetch = fetchImpl || globalThis.fetch;
  const url = `${DONATIONS_URL}?page=${Math.max(1, Math.floor(Number(page) || 1))}`;
  try {
    const res = await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "insufficient_scope", status: res.status, donations: [] };
    if (!res.ok) return { ok: false, error: `http_${res.status}`, status: res.status, donations: [] };
    const body = await res.json();
    const rows = Array.isArray(body && body.data) ? body.data : [];
    return { ok: true, donations: rows.map(normalizeDonationRow).filter(Boolean).slice(0, Math.max(1, Number(limit) || 30)) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), donations: [] };
  }
}

/*
 * DonationAlerts доставляет ВСЕ типы алертов по одному каналу
 * `$alerts:donation_<user_id>`; поле `name` в payload — это тип алерта
 * (см. https://www.donationalerts.com/apidoc, раздел Donations → name).
 *
 * Донаты приходят с name="donation". Подписки Boosty — с name, содержащим
 * "boosty" (например "subscription_boosty" / "subscription_boosty_renewal").
 * Точные строки Boosty не задокументированы публично, поэтому определение
 * сделано через "boosty" + маркер продления; сырой payload логируется выше.
 */
function boostyAlertFromPayload(payload) {
  return {
    kind: "boosty_sub",
    user: (payload && payload.username) || "Аноним",
    amount: Number(payload && payload.amount) || 0,
    currency: (payload && payload.currency) || "RUB",
  };
}

function boostyRenewalAlertFromPayload(payload) {
  const alert = boostyAlertFromPayload(payload);
  alert.kind = "boosty_resub";
  return alert;
}

function alertFromPayload(payload) {
  const name = String((payload && payload.name) || "").toLowerCase();
  if (name.includes("boosty")) {
    const isRenewal = /renewal|resub|renew|продлен|продл/i.test(name);
    return isRenewal ? boostyRenewalAlertFromPayload(payload) : boostyAlertFromPayload(payload);
  }
  return donationAlertFromPayload(payload);
}

function startDonationAlerts({ bus, state }) {
  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let pongTimeoutTimer = null;
  let connectRequestId = 1;
  let nextCommandId = 1;
  let connectToken = null;
  let connectFormat = "params";
  let subscribeMode = SUBSCRIBE_MODE;

  const logger = createLogger(bus, "donationalerts");
  /*
    Что видно в журнале «DA», а что — только в «Отладке».

    Журнал сервиса отвечает на вопрос «почему донаты не приходят», поэтому в
    него идёт только то, что человек может поправить или чему обрадуется:
    смена состояния, события сервиса, ошибки и повторы. Шаги протокола (какой
    кадр ушёл, что ответил Centrifugo) — это уже разбор для поддержки: их видно
    в панели «Отладка» и в файле журнала, но они не вытесняют из панели
    историю донатов. Иначе при живом подключении экран заполняется служебными
    строками, среди которых теряется то, за чем в него смотрят.
  */
  const debug = (message, data) => logger.debug(message, data);

  function setStatus(status) {
    bus.emit("connection_status", { service: "donationAlerts", status });
  }

  function scheduleReconnect(delayMs) {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect(), delayMs);
  }

  function clearHeartbeat() {
    clearInterval(heartbeatTimer);
    clearTimeout(pongTimeoutTimer);
    heartbeatTimer = null;
    pongTimeoutTimer = null;
  }

  function startHeartbeat() {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
      debug("sending heartbeat ping");
      ws.ping();
      clearTimeout(pongTimeoutTimer);
      pongTimeoutTimer = setTimeout(() => {
        logger.warn("heartbeat pong timeout — terminating socket");
        if (ws) ws.terminate();
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_MS);
  }

  const { ensureAccessToken, refreshAccessToken } = createTokenRefresher({
    tokenUrl: OAUTH_URL,
    logger,
    label: "donationalerts",
    getConfig: () => state.config.donationAlerts,
    /*
      Параметры обновления токена.

      `scope` здесь намеренно НЕ отправляется, хотя в apidoc DonationAlerts он
      помечен обязательным. По RFC 6749 §6 отсутствие `scope` означает «тот же
      набор прав, что был выдан изначально», а присланный scope не имеет права
      быть шире выданного. Наш список прав со временем растёт (так появился
      oauth-donation-index), и если слать его при обновлении, у тех, кто
      авторизовался раньше, обновление начнёт падать на invalid_scope.
    */
    buildParams: (da) => ({
      grant_type: "refresh_token",
      client_id: da.clientId,
      client_secret: da.clientSecret,
      refresh_token: da.refreshToken,
      redirect_uri: redirectUri(state.config.port, "donationalerts"),
    }),
    accessTokenKey: "accessToken",
    saveTokens: (json, expiresAt) => {
      const da = state.config.donationAlerts;
      state.saveDonationAlertsTokens({
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? da.refreshToken,
        userId: json.user_id ?? da.userId,
        expiresAt,
      });
    },
  });

  function parseUserOauth(json) {
    const user = (json && (json.data || json)) || {};
    const userId = user.id;
    const rawToken = user.socket_connection_token;

    debug("user/oauth parsed", {
      userId,
      tokenType: typeof rawToken,
      tokenIsNullish: rawToken === undefined || rawToken === null,
    });

    if (userId === undefined || userId === null) {
      throw new Error("user/oauth response is missing user.id");
    }

    const connectionToken = typeof rawToken === "string" ? rawToken.trim() : "";
    if (!connectionToken) {
      const received = rawToken === undefined ? "undefined" : rawToken === null ? "null" : typeof rawToken;
      throw new Error(`user/oauth response has no valid socket_connection_token (received ${received})`);
    }

    return { userId, connectionToken };
  }

  async function fetchUserOauth(accessToken) {
    const res = await fetch(USER_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 401) {
      logger.warn("user/oauth returned 401 — refreshing token and retrying once");
      const refreshed = await refreshAccessToken();
      const retryRes = await fetch(USER_URL, {
        headers: { Authorization: `Bearer ${refreshed}` },
      });
      if (!retryRes.ok) {
        const body = await retryRes.text().catch(() => "");
        throw new Error(`user/oauth after refresh: ${retryRes.status} ${body}`);
      }
      return parseUserOauth(await retryRes.json());
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`user/oauth: ${res.status} ${body}`);
    }

    return parseUserOauth(await res.json());
  }

  function openSocket(userId, connectionToken) {
    const token = String(connectionToken ?? "").trim();
    if (!token) {
      throw new Error("openSocket: connectionToken is empty (undefined/null/blank)");
    }

    nextCommandId = 1;
    connectRequestId = nextCommandId++;
    connectToken = token;
    connectFormat = "params";

    debug("opening Centrifugo socket", {
      userId,
      connectRequestId,
      tokenPresent: !!token,
      tokenLength: token.length,
    });

    ws = new WebSocket(CENTRIFUGO_WS, {
      headers: {
        Origin: "https://www.donationalerts.com",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
    });

    ws.on("open", () => {
      startHeartbeat();
      sendConnectFrame();
    });

    ws.on("pong", () => {
      clearTimeout(pongTimeoutTimer);
      debug("heartbeat pong received");
    });

    ws.on("message", (raw) => handleMessage(raw, userId));

    ws.on("close", (code, reason) => {
      logger.warn("websocket closed", { code, reason: String(reason || "") });
      clearHeartbeat();
      // Освобождаем ссылку на закрытый сокет сразу, чтобы не удерживать его
      // в памяти и не оставлять висячие слушатели до следующего реконнекта.
      ws = null;
      if (stopped) return;
      setStatus("disconnected");
      scheduleReconnect(RECONNECT_DELAY_MS);
    });

    ws.on("error", (err) => {
      logger.error("socket error", { code: err.code || "", message: err.message });
    });
  }

  function sendConnectFrame() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !connectToken) return;

    // Centrifugo v1/v2 RPC: кадр с полем `params`. Если сервер требует
    // action/method — используем fallback с `action: "connect"`.
    const frame = connectFormat === "action"
      ? { action: "connect", params: { token: connectToken }, id: connectRequestId }
      : { params: { token: connectToken }, id: connectRequestId };

    debug("sending connect frame", {
      id: connectRequestId,
      format: connectFormat,
      tokenLength: String(connectToken).length,
    });

    // Centrifugo использует JSON-lines: каждый кадр заканчивается переводом строки.
    ws.send(JSON.stringify(frame) + "\n");
  }

  function handleMessage(raw, userId) {
    let msg;
    try {
      msg = JSON.parse(raw.toString().trim());
    } catch {
      return;
    }

    // Ответ на connect: Centrifugo v2 возвращает result.client (или result.body.client).
    if (msg.id === connectRequestId && msg.result) {
      const client = msg.result.client || (msg.result.body && msg.result.body.client);
      if (client) {
        debug("centrifugo connected", { client });
        subscribe(client, userId);
        return;
      }
    }

    if (msg.error) {
      logger.warn("server error frame", msg);

      // 3003 = bad request.
      const code = msg.error && (msg.error.code !== undefined ? msg.error.code : msg.error);
      const isBadRequest = code === 3003 || String(code).includes("3003");

      // Connect: пробуем альтернативный формат кадра (action/method).
      if (msg.id === connectRequestId && connectFormat === "params" && isBadRequest) {
        connectFormat = "action";
        connectRequestId = nextCommandId++;
        debug("retrying connect with action format", { id: connectRequestId });
        sendConnectFrame();
      } else if (typeof msg.id === "number" && msg.id !== connectRequestId && isBadRequest && subscribeMode === "method") {
        // Subscribe: если HTTP /centrifuge/subscribe уже регистрирует подписку,
        // переключаемся на режим без отправки subscribe-кадров в сокет.
        subscribeMode = "http";
        setStatus("connected");
        logger.warn("subscribe rejected (3003) — switching to HTTP-only subscription mode");
      }
      return;
    }

    const payload = extractPayload(msg);
    if (!payload) return;

    const channel = (msg.push && msg.push.channel) || (msg.result && msg.result.channel) || "";

    if (channel.startsWith("$alerts:donation")) {
      // Кадр целиком — только в «Отладку»: сюда приходят и служебные кадры
      // подписки, и они выглядели в журнале как «донат» без доната.
      debug("raw donation frame", payload);
      const alert = alertFromPayload(payload);
      logger.success("alert received", alert);
      bus.emit("alert", alert);
    } else if (channel.startsWith("$goals:goal")) {
      if (payload.raised !== undefined || payload.current_amount !== undefined) {
        const update = {
          current: Number(payload.raised ?? payload.current_amount) || 0,
          target: Number(payload.goal ?? payload.target_amount) || undefined,
        };
        logger.success("goal update received", update);
        bus.emit("goal_external_update", update);
      }
    }
  }

  async function subscribe(client, userId) {
    try {
      const channels = [`$alerts:donation_${userId}`, `$goals:goal_${userId}`];
      debug("subscribing to channels", { channels });

      let accessToken = await ensureAccessToken();
      if (stopped) return;

      let subRes = await fetch(SUBSCRIBE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ channels, client }),
      });

      if (subRes.status === 401) {
        logger.warn("centrifuge/subscribe returned 401 — refreshing token and retrying once");
        accessToken = await refreshAccessToken();
        subRes = await fetch(SUBSCRIBE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ channels, client }),
        });
      }

      if (!subRes.ok) {
        const body = await subRes.text().catch(() => "");
        throw new Error(`subscribe: ${subRes.status} ${body}`);
      }

      const subJson = await subRes.json();
      const subChannels = subJson.channels || (subJson.data && subJson.data.channels) || [];
      if (!subChannels.length) logger.warn("subscribe response had no channels", subJson);

      if (subscribeMode === "http") {
        setStatus("connected");
        logger.success("connected (subscriptions registered via HTTP, socket subscribe skipped)");
        return;
      }

      subChannels.forEach((ch) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const subCommand = {
            method: "subscribe",
            params: {
              channel: ch.channel,
              token: ch.token,
            },
            id: nextCommandId++,
          };
          ws.send(JSON.stringify(subCommand) + "\n");
        }
      });

      setStatus("connected");
      logger.success("connected and subscribed");
    } catch (err) {
      logger.error("subscribe failed", { message: err.message });
      setStatus("error");
      if (ws) ws.close();
    }
  }

  async function connect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    clearHeartbeat();
    setStatus("connecting");
    logger.info("connecting…");

    try {
      const accessToken = await ensureAccessToken();
      if (stopped) return;

      if (!accessToken) {
        setStatus("not_configured");
        logger.warn("no access token — configure DonationAlerts in Settings");
        return;
      }

      const { userId, connectionToken } = await fetchUserOauth(accessToken);
      if (stopped) return;

      openSocket(userId, connectionToken);
    } catch (err) {
      if (stopped) return;
      logger.error("connect failed", { message: err.message });
      setStatus("error");

      // Отклонённые ключи приложения: повторять бессмысленно, ждём правки
      // Client ID/Secret и нового «Подключить DonationAlerts» (см. выше).
      if (isUnrecoverableAuthError(err.message)) {
        logger.error("donation alerts rejected the app credentials — check Client ID/Secret in Settings");
        return;
      }

      const authError = /401|refresh_token|unauthorized|invalid_grant|socket_connection_token|connectionToken/i.test(err.message);
      scheduleReconnect(authError ? AUTH_ERROR_RECONNECT_MS : RECONNECT_DELAY_MS);
    }
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearHeartbeat();
      if (ws) {
        ws.close();
        ws = null;
      }
    },
    /*
      Актуальный access token под конкретный запрос.

      Сокет отдаёт только живые донаты, а список уже прошедших — только REST
      (scope oauth-donation-index). Токен нужен именно на момент запроса: к этому
      времени он мог протухнуть, поэтому ensureAccessToken, а не поле конфига.
    */
    getAccessToken: () => ensureAccessToken(),
  };
}

function extractPayload(msg) {
  let d = null;

  // Modern Centrifugo bidirectional protocol: { push: { pub: { data } } }
  if (msg.push && msg.push.pub && msg.push.pub.data) d = msg.push.pub.data;
  // Older shape seen in some client libs: { result: { data: { data } } }
  else if (msg.result && msg.result.data) d = msg.result.data;

  if (!d) return null;

  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }

  return d.data || d;
}

module.exports = {
  startDonationAlerts,
  extractPayload,
  donationAlertFromPayload,
  alertFromPayload,
  fetchRecentDonations,
  normalizeDonationRow,
  parseDonationDate,
  isUnrecoverableAuthError,
  DONATIONS_URL,
};
