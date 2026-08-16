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

/**
 * YouTube Live integration via YouTube Data API v3.
 *
 *  1. The broadcaster authorizes with Google OAuth (scope
 *     `https://www.googleapis.com/auth/youtube.readonly`).
 *  2. We resolve the active live broadcast's `liveChatId`.
 *  3. We poll `liveChatMessages.list` and emit text messages as
 *     `chat_message`, and Super Chat / Super Sticker / members as `alert`.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const LIVE_BROADCASTS_URL = "https://www.googleapis.com/youtube/v3/liveBroadcasts";
const LIVE_CHAT_URL = "https://www.googleapis.com/youtube/v3/liveChatMessages";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

const MIN_POLL_MS = 1000;
const FALLBACK_POLL_MS = 4000;
const RETRY_DELAY_MS = 10000;
const QUOTA_BACKOFF_MS = 30000;

function startYoutube({ bus, state }) {
  const logger = createLogger(bus, "youtube");

  let stopped = false;
  let pollTimer = null;
  let liveChatId = null;
  let nextPageToken = null;

  function setStatus(status) {
    bus.emit("connection_status", { service: "youtube", status });
  }

  function scheduleTick(delayMs) {
    if (stopped) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => tick(), delayMs);
  }

  const { ensureAccessToken, refreshAccessToken } = createTokenRefresher({
    tokenUrl: TOKEN_URL,
    logger,
    label: "youtube",
    getConfig: () => state.config.youtube,
    buildParams: (yt) => ({
      grant_type: "refresh_token",
      client_id: yt.clientId,
      client_secret: yt.clientSecret,
      refresh_token: yt.refreshToken,
    }),
    accessTokenKey: "accessToken",
    saveTokens: (json, expiresAt) => {
      const yt = state.config.youtube;
      state.saveYoutubeTokens({
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? yt.refreshToken,
        expiresAt,
      });
    },
  });

  async function resolveLiveChatId(accessToken) {
    const yt = state.config.youtube;
    let token = accessToken;

    // `mine=true` несовместим с `broadcastStatus` (даёт 400 Bad Request),
    // поэтому запрашиваем `mine=true` и фильтруем по status.lifeCycleStatus.
    let res = await fetch(`${LIVE_BROADCASTS_URL}?part=snippet,status&mine=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      logger.warn("liveBroadcasts returned 401 — refreshing token");
      token = await refreshAccessToken();
      res = await fetch(`${LIVE_BROADCASTS_URL}?part=snippet,status&mine=true`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`liveBroadcasts: ${res.status} ${body}`);
    }

    const json = await res.json();
    const live = (json.items || []).find((it) => {
      const status = it.status && it.status.lifeCycleStatus;
      return status === "live" || status === "testing" || status === "ready";
    });
    if (live && live.snippet && live.snippet.liveChatId) {
      return live.snippet.liveChatId;
    }

    // Fallback: ищем activeLiveChatId по конкретному videoId из конфига.
    if (yt.videoId) {
      logger.info("no active broadcast via mine=true — trying videos.list fallback", { videoId: yt.videoId });
      return await resolveLiveChatIdFromVideo(token, yt.videoId);
    }

    throw new Error("no active live broadcast with liveChatId");
  }

  async function resolveLiveChatIdFromVideo(accessToken, videoId) {
    const url = `${VIDEOS_URL}?part=liveStreamingDetails&id=${encodeURIComponent(videoId)}`;
    let res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    if (res.status === 401) {
      logger.warn("videos.list returned 401 — refreshing token");
      const token = await refreshAccessToken();
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`videos.list: ${res.status} ${body}`);
    }

    const json = await res.json();
    const item = (json.items || [])[0];
    const chatId = item && item.liveStreamingDetails && item.liveStreamingDetails.activeLiveChatId;
    if (!chatId) throw new Error("video has no activeLiveChatId (stream may not be live)");
    return chatId;
  }

  function microsToAmount(micros) {
    const n = Number(micros);
    if (!Number.isFinite(n)) return 0;
    return n / 1000000;
  }

  function emitChat(item) {
    const snippet = item.snippet || {};
    const author = item.authorDetails || {};
    const badges = [];
    if (author.isChatOwner) badges.push("broadcaster");
    if (author.isChatModerator) badges.push("moderator");
    if (author.isChatSponsor) badges.push("subscriber");

    bus.emit("chat_message", {
      user: author.displayName || "viewer",
      message: (snippet.textMessageDetails && snippet.textMessageDetails.messageText) || snippet.displayMessage || "",
      color: "#e8e1f0",
      badges,
      emotes: {},
    });
  }

  function emitEvent(item) {
    const snippet = item.snippet || {};
    const author = item.authorDetails || {};
    const type = snippet.type;

    if (type === "superChatEvent" || type === "superStickerEvent") {
      const details = type === "superChatEvent" ? snippet.superChatDetails : snippet.superStickerDetails;
      const amount = microsToAmount(details && details.amountMicros);
      const currency = details && details.currency;
      const message = (details && details.userComment) || (details && details.amountDisplayString) || "";
      bus.emit("alert", {
        kind: "donation",
        user: author.displayName || "viewer",
        amount,
        currency: currency || undefined,
        message: message || (type === "superStickerEvent" ? "Super Sticker" : "Super Chat"),
      });
    } else if (type === "newSponsorEvent" || type === "memberMilestoneChatEvent") {
      const details = type === "newSponsorEvent" ? snippet.newSponsorDetails : snippet.memberMilestoneDetails;
      bus.emit("alert", {
        kind: "sub",
        user: author.displayName || "viewer",
        tier: (details && details.memberLevelName) || "Member",
      });
    }
  }

  async function tick() {
    if (stopped) return;
    try {
      const accessToken = await ensureAccessToken();
      if (stopped) return;

      if (!accessToken) {
        setStatus("not_configured");
        scheduleTick(RETRY_DELAY_MS);
        return;
      }

      if (!liveChatId) {
        liveChatId = await resolveLiveChatId(accessToken);
        logger.success("resolved live chat id", { liveChatId });
        setStatus("connected");
      }

      const params = new URLSearchParams({
        part: "snippet,authorDetails",
        liveChatId,
      });
      if (nextPageToken) params.set("pageToken", nextPageToken);

      const res = await fetch(`${LIVE_CHAT_URL}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.status === 401) {
        logger.warn("liveChatMessages returned 401 — refreshing token");
        await refreshAccessToken();
        scheduleTick(MIN_POLL_MS);
        return;
      }

      // Чат завершён или не существует (404 Not Found) — сбрасываем liveChatId,
      // чтобы на следующем тике заново найти активный эфир.
      if (res.status === 404) {
        logger.warn("liveChatMessages returned 404 (chat ended or invalid) — reset liveChatId");
        liveChatId = null;
        nextPageToken = null;
        setStatus("connecting");
        scheduleTick(RETRY_DELAY_MS);
        return;
      }

      if (res.status === 403) {
        logger.warn("liveChatMessages returned 403 (rate limit/quota) — backing off");
        scheduleTick(QUOTA_BACKOFF_MS);
        return;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`liveChatMessages: ${res.status} ${body}`);
      }

      const json = await res.json();
      nextPageToken = json.nextPageToken || null;

      for (const item of json.items || []) {
        const type = item.snippet && item.snippet.type;
        if (type === "textMessageEvent") {
          emitChat(item);
        } else if (
          type === "superChatEvent" ||
          type === "superStickerEvent" ||
          type === "newSponsorEvent" ||
          type === "memberMilestoneChatEvent"
        ) {
          emitEvent(item);
        }
      }

      const interval = Number(json.pollingIntervalMillis) || FALLBACK_POLL_MS;
      scheduleTick(Math.max(MIN_POLL_MS, interval));
    } catch (err) {
      if (stopped) return;
      logger.error("poll failed", { message: err.message });

      // Если в ошибку пришел 404, сбрасываем ID чата, чтобы на следующем тике искать новый эфир
      if (err.message && err.message.includes("404")) {
        liveChatId = null;
        nextPageToken = null;
      }

      setStatus("error");
      scheduleTick(RETRY_DELAY_MS);
    }
  }

  function connect() {
    if (stopped) return;
    clearTimeout(pollTimer);
    setStatus("connecting");
    logger.info("connecting…");
    liveChatId = null;
    nextPageToken = null;
    tick();
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearTimeout(pollTimer);
    },
  };
}

module.exports = { startYoutube };
