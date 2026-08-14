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

function log(...args) {
  console.log(`[donationalerts] ${new Date().toISOString()}`, ...args);
}

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
  let refreshPromise = null;
  let tokenExpiresAt = 0;
  let connectRequestId = 1;
  let nextCommandId = 1;

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
      log("sending heartbeat ping");
      ws.ping();
      clearTimeout(pongTimeoutTimer);
      pongTimeoutTimer = setTimeout(() => {
        log("heartbeat pong timeout — terminating socket");
        if (ws) ws.terminate();
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_MS);
  }

  function refreshAccessToken() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = doRefreshAccessToken().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  async function doRefreshAccessToken() {
    const da = state.config.donationAlerts;
    if (!da.refreshToken) throw new Error("no refreshToken available");

    log("refreshing access token…");
    const res = await fetch(OAUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: da.clientId,
        client_secret: da.clientSecret,
        refresh_token: da.refreshToken,
        redirect_uri: redirectUri(state.config.port, "donationalerts"),
      }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new Error(`refresh_token: ${res.status} ${JSON.stringify(json)}`);
    }

    state.saveDonationAlertsTokens({
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? da.refreshToken,
      userId: json.user_id ?? da.userId,
    });

    if (json.expires_in) {
      tokenExpiresAt = Date.now() + (Number(json.expires_in) - 60) * 1000;
    }
    log("access token refreshed");
    return json.access_token;
  }

  async function ensureAccessToken() {
    const da = state.config.donationAlerts;
    if (tokenExpiresAt && Date.now() < tokenExpiresAt) return da.accessToken;
    if (da.refreshToken) return await refreshAccessToken();
    return da.accessToken;
  }

  function parseUserOauth(json) {
    const user = json.data || json;
    const userId = user.id;
    const connectionToken = user.socket_connection_token;
    if (!userId || !connectionToken) throw new Error("no socket_connection_token in user/oauth response");
    return { userId, connectionToken };
  }

  async function fetchUserOauth(accessToken) {
    const res = await fetch(USER_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 401) {
      log("user/oauth returned 401 — refreshing token and retrying once");
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
    nextCommandId = 1;
    connectRequestId = nextCommandId++;

    ws = new WebSocket(CENTRIFUGO_WS, {
      headers: {
        Origin: "https://www.donationalerts.com",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
    });

    ws.on("open", () => {
      startHeartbeat();
      log("websocket opened — sending connect");
      ws.send(JSON.stringify({ connect: { token: connectionToken }, id: connectRequestId }));
    });

    ws.on("pong", () => {
      clearTimeout(pongTimeoutTimer);
      log("heartbeat pong received");
    });

    ws.on("message", (raw) => handleMessage(raw, userId));

    ws.on("close", (code, reason) => {
      log("websocket closed", code, String(reason || ""));
      clearHeartbeat();
      if (stopped) return;
      setStatus("disconnected");
      scheduleReconnect(RECONNECT_DELAY_MS);
    });

    ws.on("error", (err) => {
      log("socket error:", err.code || "", err.message);
    });
  }

  function handleMessage(raw, userId) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Reply to our "connect" command -> now subscribe to donation + goal channels.
    if (msg.id === connectRequestId && (msg.connect || msg.result)) {
      const client = (msg.connect && msg.connect.client) || (msg.result && msg.result.client);
      subscribe(client, userId);
      return;
    }

    if (msg.error) {
      log("server error frame:", JSON.stringify(msg));
      return;
    }

    const payload = extractPayload(msg);
    if (!payload) return;

    const channel = (msg.push && msg.push.channel) || (msg.result && msg.result.channel) || "";

    if (channel.startsWith("$alerts:donation")) {
      const alert = donationAlertFromPayload(payload);
      log("donation received:", JSON.stringify(alert));
      bus.emit("alert", alert);
    } else if (channel.startsWith("$goals:goal")) {
      if (payload.raised !== undefined || payload.current_amount !== undefined) {
        const update = {
          current: Number(payload.raised ?? payload.current_amount) || 0,
          target: Number(payload.goal ?? payload.target_amount) || undefined,
        };
        log("goal update received:", JSON.stringify(update));
        bus.emit("goal_external_update", update);
      }
    }
  }

  async function subscribe(client, userId) {
    try {
      const channels = [`$alerts:donation_${userId}`, `$goals:goal_${userId}`];
      log("subscribing to channels:", channels.join(", "));

      const subRes = await fetch(SUBSCRIBE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.config.donationAlerts.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ channels, client }),
      });

      if (!subRes.ok) {
        const body = await subRes.text().catch(() => "");
        throw new Error(`subscribe: ${subRes.status} ${body}`);
      }

      const subJson = await subRes.json();
      const subChannels = subJson.channels || (subJson.data && subJson.data.channels) || [];
      if (!subChannels.length) log("subscribe response had no channels:", JSON.stringify(subJson));

      subChannels.forEach((ch) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ subscribe: { channel: ch.channel, token: ch.token }, id: nextCommandId++ }));
        }
      });

      setStatus("connected");
      log("connected and subscribed");
    } catch (err) {
      log("subscribe failed:", err.message);
      setStatus("error");
      if (ws) ws.close();
    }
  }

  async function connect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    clearHeartbeat();
    setStatus("connecting");
    log("connecting…");

    try {
      const accessToken = await ensureAccessToken();
      if (stopped) return;

      if (!accessToken) {
        setStatus("not_configured");
        log("no access token — configure DonationAlerts in Settings");
        return;
      }

      const { userId, connectionToken } = await fetchUserOauth(accessToken);
      if (stopped) return;

      openSocket(userId, connectionToken);
    } catch (err) {
      if (stopped) return;
      log("connect failed:", err.message);
      setStatus("error");
      const authError = /401|refresh_token|unauthorized|invalid_grant/i.test(err.message);
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
