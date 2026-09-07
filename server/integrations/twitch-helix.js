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

const { createLogger } = require("../logger");
const { createTokenRefresher } = require("../token-refresh");

/*
  Twitch Helix actions that require a User Access Token beyond EventSub:
    * create clip      — POST /helix/clips                    (scope: clips:edit)
    * stream marker    — POST /helix/streams/markers           (scope: channel:manage:broadcast)

  Both reuse the same token-refresher pattern as twitch-chat.js so expired
  access tokens are transparently refreshed and 401s retried once.
*/

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const CLIPS_URL = "https://api.twitch.tv/helix/clips";
const MARKERS_URL = "https://api.twitch.tv/helix/streams/markers";

function makeRefresher({ bus, state, logger }) {
  return createTokenRefresher({
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
}

function isAuthorized(twitch) {
  return !!(twitch.clientId && twitch.userAccessToken && twitch.broadcasterId);
}

async function createTwitchClip({ bus, state }) {
  const logger = createLogger(bus, "twitch-clip");
  const twitch = state.config.twitch;

  if (!isAuthorized(twitch)) {
    logger.warn("cannot create clip — Twitch is not authorized", {
      hasClientId: !!twitch.clientId,
      hasToken: !!twitch.userAccessToken,
      hasBroadcasterId: !!twitch.broadcasterId,
    });
    return { ok: false, error: "not_configured" };
  }

  const refresher = makeRefresher({ bus, state, logger });
  let token;
  try {
    token = await refresher.ensureAccessToken();
  } catch (err) {
    logger.error("clip token refresh failed", { message: err.message });
    return { ok: false, error: "auth" };
  }

  const doCreate = async (accessToken) => {
    const res = await fetch(CLIPS_URL, {
      method: "POST",
      headers: {
        "Client-Id": twitch.clientId,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ broadcaster_id: twitch.broadcasterId, has_delay: false }),
    });
    const json = await res.json().catch(() => ({}));
    return { res, json };
  };

  let result = await doCreate(token);
  if (result.res.status === 401) {
    logger.warn("clip creation returned 401 — refreshing and retrying once");
    try {
      token = await refresher.refreshAccessToken();
    } catch (err) {
      logger.error("clip token refresh failed", { message: err.message });
      return { ok: false, error: "auth" };
    }
    result = await doCreate(token);
  }

  if (!result.res.ok) {
    const apiMessage = result.json && result.json.message;
    logger.error("clip creation failed", { status: result.res.status, message: apiMessage });
    return { ok: false, error: apiMessage || `http_${result.res.status}` };
  }

  const clip = result.json && result.json.data && result.json.data[0];
  const editUrl = clip && clip.edit_url;
  logger.success("clip created", { id: clip && clip.id, editUrl });
  return { ok: true, id: clip && clip.id, editUrl };
}

async function createStreamMarker({ bus, state, description }) {
  const logger = createLogger(bus, "twitch-marker");
  const twitch = state.config.twitch;

  if (!isAuthorized(twitch)) {
    logger.warn("cannot create stream marker — Twitch is not authorized", {
      hasClientId: !!twitch.clientId,
      hasToken: !!twitch.userAccessToken,
      hasBroadcasterId: !!twitch.broadcasterId,
    });
    return { ok: false, error: "not_configured" };
  }

  const refresher = makeRefresher({ bus, state, logger });
  let token;
  try {
    token = await refresher.ensureAccessToken();
  } catch (err) {
    logger.error("marker token refresh failed", { message: err.message });
    return { ok: false, error: "auth" };
  }

  const doCreate = async (accessToken) => {
    const res = await fetch(MARKERS_URL, {
      method: "POST",
      headers: {
        "Client-Id": twitch.clientId,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: twitch.broadcasterId,
        description: String(description || "").slice(0, 140),
      }),
    });
    const json = await res.json().catch(() => ({}));
    return { res, json };
  };

  let result = await doCreate(token);
  if (result.res.status === 401) {
    logger.warn("stream marker returned 401 — refreshing and retrying once");
    try {
      token = await refresher.refreshAccessToken();
    } catch (err) {
      logger.error("marker token refresh failed", { message: err.message });
      return { ok: false, error: "auth" };
    }
    result = await doCreate(token);
  }

  if (!result.res.ok) {
    const apiMessage = result.json && result.json.message;
    logger.error("stream marker failed", { status: result.res.status, message: apiMessage });
    return { ok: false, error: apiMessage || `http_${result.res.status}` };
  }

  const marker = result.json && result.json.data && result.json.data[0];
  logger.success("stream marker created", { id: marker && marker.id });
  return { ok: true, id: marker && marker.id };
}

module.exports = { createTwitchClip, createStreamMarker };
