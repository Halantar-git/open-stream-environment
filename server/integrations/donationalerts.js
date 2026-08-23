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

const RECONNECT_DELAY_MS = 5000;
const AUTH_ERROR_RECONNECT_MS = 15000;
const HEARTBEAT_MS = 25000;
const PONG_TIMEOUT_MS = 10000;

// Опция подписки по WebSocket:
//   "method" — отправлять Centrifugo v2 RPC-кадры { method: "subscribe", params, id }.
//   "http"   — не отправлять subscribe в сокет: HTTP /centrifuge/subscribe уже
//              регистрирует подписку на стороне DA, только ставим connected.
const SUBSCRIBE_MODE = "method";

function donationAlertFromPayload(payload) {
  return {
    kind: "donation",
    user: (payload && (payload.username || payload.name)) || "Аноним",
    amount: Number(payload && payload.amount) || 0,
    currency: (payload && payload.currency) || "RUB",
    message: (payload && payload.message) || "",
  };
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
  // Высокочастотные отладочные события (ping/pong) не засоряют терминал,
  // а уходят в панель «Отладка» отдельным потоком debug_log.
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

    logger.info("user/oauth parsed", {
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

    logger.info("opening Centrifugo socket", {
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

    logger.info("sending connect frame", {
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
        logger.success("centrifugo connected", { client });
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
        logger.info("retrying connect with action format", { id: connectRequestId });
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
      const alert = donationAlertFromPayload(payload);
      logger.success("donation received", alert);
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
      logger.info("subscribing to channels", { channels });

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

module.exports = { startDonationAlerts, extractPayload, donationAlertFromPayload };
