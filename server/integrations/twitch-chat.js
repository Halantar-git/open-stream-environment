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

const tmi = require("tmi.js");

const { createLogger } = require("../logger");
const { createTokenRefresher } = require("../token-refresh");

/**
 * Reads chat as an anonymous viewer (tmi.js's "justinfan" mode) — no
 * Twitch app or token required, just the channel name. This only lets us
 * read; follows/subs/cheers need EventSub (see twitch-eventsub.js).
 */
function startTwitchChat({ bus, channel }) {
  const logger = createLogger(bus, "twitch-chat");

  if (!channel) {
    logger.warn("no channel configured");
    bus.emit("connection_status", { service: "twitchChat", status: "not_configured" });
    return { stop() {} };
  }

  const client = new tmi.Client({
    options: { skipMembership: true },
    connection: { reconnect: true, secure: true },
    channels: [channel],
  });

  client.on("message", (_channel, tags, message, self) => {
    if (self) return;
    bus.emit("chat_message", {
      user: tags["display-name"] || tags.username || "viewer",
      color: tags.color || "#c9c1d6",
      badges: Object.keys(tags.badges || {}),
      message,
      emotes: tags.emotes || {},
    });
  });

  client.on("connected", () => {
    logger.success("connected to chat", { channel });
    bus.emit("connection_status", { service: "twitchChat", status: "connected" });
  });
  client.on("disconnected", () => {
    logger.warn("chat disconnected", { channel });
    bus.emit("connection_status", { service: "twitchChat", status: "disconnected" });
  });

  logger.info("connecting to chat", { channel });
  bus.emit("connection_status", { service: "twitchChat", status: "connecting" });
  client.connect().catch((err) => {
    logger.error("chat connect failed", { message: err.message });
    bus.emit("connection_status", { service: "twitchChat", status: "error" });
  });

  return {
    stop() {
      client.disconnect().catch(() => {});
    },
  };
}

const CHAT_SEND_URL = "https://api.twitch.tv/helix/chat/messages";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";

// Twitch silently throttles after ~20 messages/30s. Space outgoing messages
// by at least this interval so manual sends (and any future auto-replies) stay
// well under the limit. Reservations are made before each send so concurrent
// calls are serialized.
const CHAT_SEND_INTERVAL_MS = 1600;
let chatSendReservedUntil = 0;

/**
 * Sends a message to the configured channel via Twitch Helix
 * (POST /helix/chat/messages). Unlike IRC, this returns a message id
 * synchronously and does not depend on the anonymous read socket staying up.
 * Requires a User Access Token with the user:write:chat scope and the
 * broadcaster id (both stored by the existing "Connect Twitch" OAuth flow).
 */
async function sendTwitchChatMessage({ bus, state, message }) {
  const logger = createLogger(bus, "twitch-chat");
  const twitch = state.config.twitch;
  const text = String(message || "").trim();

  if (!text) return { ok: false, error: "empty_message" };

  if (!twitch.clientId || !twitch.userAccessToken || !twitch.broadcasterId) {
    logger.warn("cannot send chat — Twitch is not authorized for chat", {
      hasClientId: !!twitch.clientId,
      hasToken: !!twitch.userAccessToken,
      hasBroadcasterId: !!twitch.broadcasterId,
    });
    return { ok: false, error: "not_configured" };
  }

  const refresher = createTokenRefresher({
    tokenUrl: TOKEN_URL,
    logger,
    label: "twitch",
    getConfig: () => state.config.twitch,
    buildParams: (cfg) => ({
      grant_type: "refresh_token",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
    }),
    accessTokenKey: "userAccessToken",
    saveTokens: (json, expiresAt) => {
      const cfg = state.config.twitch;
      state.saveTwitchTokens({
        userAccessToken: json.access_token,
        refreshToken: json.refresh_token ?? cfg.refreshToken,
        broadcasterId: cfg.broadcasterId,
        expiresAt,
      });
    },
  });

  let token;
  try {
    token = await refresher.ensureAccessToken();
  } catch (err) {
    logger.error("chat send token refresh failed", { message: err.message });
    return { ok: false, error: "auth" };
  }

  const doSend = async (accessToken) => {
    const res = await fetch(CHAT_SEND_URL, {
      method: "POST",
      headers: {
        "Client-Id": twitch.clientId,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        broadcaster_id: twitch.broadcasterId,
        sender_id: twitch.broadcasterId,
        message: text,
      }),
    });
    const json = await res.json().catch(() => ({}));
    return { res, json };
  };

  // Rate-limit: reserve a slot and wait until the previous send's cooldown
  // elapses before hitting the Helix endpoint.
  const now = Date.now();
  const waitMs = Math.max(0, chatSendReservedUntil - now);
  chatSendReservedUntil = Math.max(now, chatSendReservedUntil) + CHAT_SEND_INTERVAL_MS;
  if (waitMs > 0) {
    logger.debug("chat send throttled", { waitMs });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  let result = await doSend(token);
  if (result.res.status === 401) {
    logger.warn("chat send returned 401 — refreshing and retrying once");
    try {
      token = await refresher.refreshAccessToken();
    } catch (err) {
      logger.error("chat send token refresh failed", { message: err.message });
      return { ok: false, error: "auth" };
    }
    result = await doSend(token);
  }

  if (!result.res.ok) {
    const apiMessage = result.json && result.json.message;
    logger.error("chat send failed", { status: result.res.status, message: apiMessage });
    return { ok: false, error: apiMessage || `http_${result.res.status}` };
  }

  const sent = result.json && result.json.data && result.json.data[0];
  const messageId = sent && sent.message_id;
  logger.success("chat message sent", { messageId, isSent: sent ? !!sent.is_sent : true });
  return { ok: true, messageId, isSent: sent ? !!sent.is_sent : true };
}

module.exports = { startTwitchChat, sendTwitchChatMessage };
