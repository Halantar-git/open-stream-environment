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

const { createLogger } = require("../logger");
const { createTokenRefresher } = require("../token-refresh");

/**
 * Follows/subs/cheers via Twitch EventSub over WebSocket:
 * https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
 *
 * Requires a User Access Token (not an app token — EventSub's WebSocket
 * transport only accepts subscriptions authorized by the connecting
 * user) with scopes: moderator:read:followers, channel:read:subscriptions,
 * bits:read. Obtained via Settings -> Connect Twitch in the control panel.
 *
 * Reliability additions over the previous implementation:
 *   - automatic access-token refresh via refresh_token
 *   - keepalive watchdog (reconnect when Twitch stops sending keepalives)
 *   - no duplicate reconnect when handling a session_reconnect URL
 *   - structured logging of connect/welcome/reconnect/socket events
 */

const SUBSCRIPTIONS = [
  { type: "channel.follow", version: "2", condition: (id) => ({ broadcaster_user_id: id, moderator_user_id: id }) },
  { type: "channel.subscribe", version: "1", condition: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.subscription.gift", version: "1", condition: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.cheer", version: "1", condition: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.channel_points_custom_reward_redemption.add", version: "1", condition: (id) => ({ broadcaster_user_id: id }) },
];

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const RECONNECT_DELAY_MS = 3000;
const AUTH_RECONNECT_DELAY_MS = 15000;
const KEEPALIVE_TIMEOUT_MS = 35000; // keepalive_timeout_seconds=30 + buffer
const KEEPALIVE_CHECK_MS = 5000;

// Ищет ракурс камеры по названию награды Twitch (без учёта регистра и пробелов).
function matchCameraAngle(angles, rewardTitle) {
  const title = String(rewardTitle || "").trim().toLowerCase();
  if (!title) return null;
  return (Array.isArray(angles) ? angles : []).find(
    (a) => a.twitchRewardTitle && a.twitchRewardTitle.trim().toLowerCase() === title
  ) || null;
}

function matchCameraFilter(filters, rewardTitle) {
  const title = String(rewardTitle || "").trim().toLowerCase();
  if (!title) return null;
  return (Array.isArray(filters) ? filters : []).find(
    (f) => f.twitchRewardTitle && f.twitchRewardTitle.trim().toLowerCase() === title
  ) || null;
}

function startTwitchEvents({ bus, state }) {
  const logger = createLogger(bus, "twitch-eventsub");

  let ws = null;
  let stopped = false;
  let keepaliveTimer = null;
  let lastMessageAt = 0;
  let authFailure = false;
  let isReconnecting = false;

  const initialUrl = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";

  function setStatus(status) {
    bus.emit("connection_status", { service: "twitchEvents", status });
  }

  function clearKeepaliveWatchdog() {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }

  function startKeepaliveWatchdog() {
    clearKeepaliveWatchdog();
    lastMessageAt = Date.now();
    keepaliveTimer = setInterval(() => {
      if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastMessageAt > KEEPALIVE_TIMEOUT_MS) {
        logger.warn("keepalive timeout — closing socket");
        ws.close();
      }
    }, KEEPALIVE_CHECK_MS);
  }

  const { ensureAccessToken, refreshAccessToken } = createTokenRefresher({
    tokenUrl: TOKEN_URL,
    logger,
    label: "twitch",
    getConfig: () => state.config.twitch,
    buildParams: (twitch) => ({
      grant_type: "refresh_token",
      client_id: twitch.clientId,
      client_secret: twitch.clientSecret,
      refresh_token: twitch.refreshToken,
    }),
    accessTokenKey: "userAccessToken",
    saveTokens: (json, expiresAt) => {
      const twitch = state.config.twitch;
      state.saveTwitchTokens({
        userAccessToken: json.access_token,
        refreshToken: json.refresh_token ?? twitch.refreshToken,
        broadcasterId: twitch.broadcasterId,
        expiresAt,
      });
    },
  });

  async function subscribeAll(twitchConfig, sessionId, accessToken) {
    if (!twitchConfig.broadcasterId) throw new Error("no broadcasterId — reconnect via Settings");

    for (const sub of SUBSCRIPTIONS) {
      const res = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
        method: "POST",
        headers: {
          "Client-Id": twitchConfig.clientId,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: sub.type,
          version: sub.version,
          condition: sub.condition(twitchConfig.broadcasterId),
          transport: { method: "websocket", session_id: sessionId },
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(`${sub.type}: ${res.status} ${body.message || ""}`);
        err.status = res.status;
        throw err;
      }
    }
  }

  async function subscribeWithRetry(twitchConfig, sessionId) {
    let token = await ensureAccessToken();
    try {
      await subscribeAll(twitchConfig, sessionId, token);
    } catch (err) {
      if (err.status === 401) {
        logger.warn("subscribe returned 401 — refreshing and retrying once");
        token = await refreshAccessToken();
        await subscribeAll(twitchConfig, sessionId, token);
      } else {
        throw err;
      }
    }
    return token;
  }

  function connect(url) {
    if (stopped) return;
    setStatus("connecting");
    logger.info("connecting", { url });

    const socket = new WebSocket(url);
    ws = socket;
    startKeepaliveWatchdog();

    socket.on("message", async (raw) => {
      if (ws !== socket) return; // superseded by a session_reconnect
      lastMessageAt = Date.now();

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const type = msg.metadata && msg.metadata.message_type;

      if (type === "session_welcome") {
        const sessionId = msg.payload.session.id;
        logger.info("session_welcome", { sessionId, isReconnecting });

        if (isReconnecting) {
          // При session_reconnect Twitch сохраняет подписки; повторный subscribe
          // вернул бы 409 Conflict.
          isReconnecting = false;
          authFailure = false;
          setStatus("connected");
          logger.success("reconnected (subscriptions preserved by Twitch)");
        } else {
          try {
            const token = await subscribeWithRetry(state.config.twitch, sessionId);
            authFailure = false;
            setStatus("connected");
            logger.success("subscribed and connected");
            fetchInitialStats(state.config.twitch, token, bus);
          } catch (err) {
            logger.error("subscribe failed", { message: err.message });
            authFailure = /401|refresh_token|unauthorized|invalid_grant/i.test(err.message);
            setStatus("error");
            if (ws === socket) socket.close();
          }
        }
      } else if (type === "session_reconnect") {
        const reconnectUrl = msg.payload.session.reconnect_url;
        logger.info("session_reconnect", { reconnectUrl });
        isReconnecting = true;
        const old = socket;
        connect(reconnectUrl);
        if (old) setTimeout(() => { try { old.close(); } catch {} }, 5000);
      } else if (type === "notification") {
        handleNotification(msg.payload, bus, state);
      }
      // session_keepalive: no action needed; lastMessageAt is refreshed above.
    });

    socket.on("close", (code, reason) => {
      logger.warn("websocket closed", { code, reason: String(reason || "") });
      clearKeepaliveWatchdog();
      if (stopped) return;
      if (ws !== socket) return; // superseded by a session_reconnect
      isReconnecting = false; // полный реконнект: потребуется переподписка
      setStatus("disconnected");
      const delay = authFailure ? AUTH_RECONNECT_DELAY_MS : RECONNECT_DELAY_MS;
      setTimeout(() => connect(initialUrl), delay);
    });

    socket.on("error", (err) => {
      logger.error("socket error", { code: err.code || "", message: err.message });
    });
  }

  connect(initialUrl);

  return {
    stop() {
      stopped = true;
      clearKeepaliveWatchdog();
      if (ws) {
        ws.close();
        ws = null;
      }
    },
  };
}

async function fetchInitialStats(twitchConfig, accessToken, bus) {
  const logger = createLogger(bus, "twitch-eventsub");
  const headers = { "Client-Id": twitchConfig.clientId, Authorization: `Bearer ${accessToken}` };
  const snapshot = {};
  try {
    const res = await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${twitchConfig.broadcasterId}&first=1`, { headers });
    if (res.ok) snapshot.followerCount = (await res.json()).total;
  } catch (err) {
    logger.warn("followers total fetch failed", { message: err.message });
  }
  try {
    const res = await fetch(`https://api.twitch.tv/helix/subscriptions?broadcaster_id=${twitchConfig.broadcasterId}&first=1`, { headers });
    if (res.ok) snapshot.subscriberCount = (await res.json()).total;
  } catch (err) {
    logger.warn("subscribers total fetch failed", { message: err.message });
  }
  if (Object.keys(snapshot).length) bus.emit("stat_snapshot", snapshot);
}

function handleNotification(payload, bus, state) {
  const type = payload.subscription.type;
  const event = payload.event;
  switch (type) {
    case "channel.follow":
      bus.emit("alert", { kind: "follow", user: event.user_name });
      bus.emit("stat_delta", { followerDelta: 1 });
      break;
    case "channel.subscribe":
      if (event.is_gift) return; // gift recipients also fire this; the gifter is reported via channel.subscription.gift
      bus.emit("alert", { kind: "sub", user: event.user_name, tier: event.tier });
      bus.emit("stat_delta", { subscriberDelta: 1 });
      break;
    case "channel.subscription.gift":
      bus.emit("alert", {
        kind: "gift_sub",
        user: event.is_anonymous ? "Аноним" : event.user_name,
        count: event.total,
        tier: event.tier,
      });
      bus.emit("stat_delta", { subscriberDelta: event.total || 1 });
      break;
    case "channel.cheer":
      bus.emit("alert", {
        kind: "cheer",
        user: event.is_anonymous ? "Аноним" : event.user_name,
        amount: event.bits,
      });
      break;
    case "channel.channel_points_custom_reward_redemption.add": {
      const rewardTitle = (event.reward && event.reward.title) || "";
      const rewardId = (event.reward && event.reward.id) || "";
      const user = event.user_name || "Зритель";
      const sounds = (state.config.soundboard && state.config.soundboard.sounds) || [];
      const sound = sounds.find((s) =>
        (s.rewardId && s.rewardId === rewardId) ||
        (s.rewardTitle && rewardTitle && s.rewardTitle.toLowerCase() === rewardTitle.toLowerCase())
      );
      if (sound) {
        bus.emit("soundboard_play", {
          soundId: sound.id,
          title: sound.title || sound.rewardTitle || sound.id,
          user,
          audioFile: sound.audioFile,
          imageFile: sound.imageFile,
        });
      }

      const angle = matchCameraAngle((state.config.obs && state.config.obs.cameraAngles) || [], rewardTitle);
      if (angle) {
        bus.emit("camera_angle_request", { angleId: angle.id, user });
      }

      const filter = matchCameraFilter((state.config.obs && state.config.obs.cameraFilters) || [], rewardTitle);
      if (filter) {
        bus.emit("camera_filter_request", { filterId: filter.id, user });
      }
      break;
    }
    default:
      break;
  }
}

module.exports = { startTwitchEvents, matchCameraAngle, matchCameraFilter };
