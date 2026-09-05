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

(function () {
  const { EVENT_TYPES } = window.SharedEvents;
  const t = (key, params) => (window.I18n ? window.I18n.t(key, params) : key);
  const params = new URLSearchParams(location.search);
  const port = params.get("port") || "8710";
  const isHud = params.get("hud") === "1";
  if (isHud) {
    document.documentElement.classList.add("is-hud");
    document.body.classList.add("is-hud");
  }

  // Настройки чата HUD (прозрачность фона и размер шрифта). Передаются через
  // query при создании окна и обновляются вживую через WebSocket.
  function applyHudStyle(opacity, fontSize) {
    const o = Number(opacity);
    if (Number.isFinite(o)) document.body.style.setProperty("--chat-hud-opacity", String(Math.min(1, Math.max(0, o / 100))));
    const f = Number(fontSize);
    if (Number.isFinite(f)) document.body.style.setProperty("--chat-hud-font-size", `${Math.min(48, Math.max(10, f))}px`);
  }
  if (isHud) applyHudStyle(params.get("opacity"), params.get("fontSize"));

  const chatListEl = document.getElementById("chatList");
  const channelLabelEl = document.getElementById("channelLabel");
  const statusChipEl = document.getElementById("statusChip");
  const statusLabelEl = document.getElementById("statusLabel");
  const jumpBtn = document.getElementById("jumpToLatest");
  const composerEl = document.getElementById("chatComposer");
  const chatInputEl = document.getElementById("chatInput");
  const chatSendBtn = document.getElementById("chatSendBtn");

  const MAX_ROWS = 300;
  const ECHO_MATCH_MS = 20000;
  const SEND_COOLDOWN_MS = 1600;
  let atBottom = true;
  let currentStatus = null;
  let currentChannel = "";
  let ws = null;
  const pendingSends = new Map(); // clientId -> { el, text, at, confirmed }

  function sendCommand(type, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload: payload || {} }));
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }
  function formatTime(d) {
    const locale = (window.I18n && window.I18n.getLang() === "ru") ? "ru-RU" : "en-US";
    return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }

  function isNearBottom() {
    return chatListEl.scrollHeight - chatListEl.scrollTop - chatListEl.clientHeight < 60;
  }
  chatListEl.addEventListener("scroll", () => {
    atBottom = isNearBottom();
    if (atBottom) jumpBtn.hidden = true;
  });
  jumpBtn.addEventListener("click", () => {
    chatListEl.scrollTop = chatListEl.scrollHeight;
    jumpBtn.hidden = true;
    atBottom = true;
  });

  const pinBtn = document.getElementById("pinBtn");
  function syncPinState(pinned) {
    if (!pinBtn) return;
    pinBtn.classList.toggle("is-active", pinned);
    pinBtn.setAttribute("aria-pressed", String(pinned));
    pinBtn.title = pinned ? t("chatWindow.pinOff") : t("chatWindow.pinOn");
  }
  if (pinBtn && window.chatDesktop) {
    window.chatDesktop.getAlwaysOnTop().then(syncPinState).catch(() => {});
    if (typeof window.chatDesktop.onAlwaysOnTopChanged === "function") {
      window.chatDesktop.onAlwaysOnTopChanged(syncPinState);
    }
    pinBtn.addEventListener("click", () => {
      window.chatDesktop.toggleAlwaysOnTop().then(syncPinState).catch(() => {});
    });
  }

  function clearEmptyState() {
    const empty = chatListEl.querySelector(".chat-list__empty");
    if (empty) empty.remove();
  }

  function setOutgoingStatus(entry, statusClass, symbol) {
    if (!entry || !entry.el) return;
    entry.el.classList.remove("is-pending", "is-sent", "is-error");
    if (statusClass) entry.el.classList.add(statusClass);
    const statusEl = entry.el.querySelector(".chat-row__status");
    if (statusEl) statusEl.textContent = symbol;
  }

  function pushOutgoing(text) {
    clearEmptyState();
    const row = document.createElement("div");
    row.className = "chat-row is-pending";
    const user = currentChannel || t("chatWindow.you");
    row.innerHTML = `<span class="chat-row__user" style="color:${escapeAttr("#7ee0d6")}">${escapeHtml(user)}</span><span class="chat-row__colon">:</span><span class="chat-row__text">${escapeHtml(text)}</span><span class="chat-row__status">…</span><span class="chat-row__time">${formatTime(new Date())}</span>`;
    chatListEl.appendChild(row);
    while (chatListEl.children.length > MAX_ROWS) chatListEl.removeChild(chatListEl.firstChild);
    if (atBottom) {
      chatListEl.scrollTop = chatListEl.scrollHeight;
    } else {
      jumpBtn.hidden = false;
    }
    return { el: row, text, at: Date.now(), confirmed: false };
  }

  function consumeOutgoingEcho(payload) {
    const text = String((payload && payload.message) || "").trim();
    if (!text) return false;
    const now = Date.now();
    for (const [clientId, entry] of pendingSends) {
      if (entry.text === text && now - entry.at < ECHO_MATCH_MS) {
        pendingSends.delete(clientId);
        setOutgoingStatus(entry, "is-sent", "✓");
        return true;
      }
    }
    return false;
  }

  function sendChatMessage() {
    const text = (chatInputEl.value || "").trim();
    if (!text) return;
    chatInputEl.value = "";

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setOutgoingStatus(pushOutgoing(text), "is-error", "!");
      return;
    }

    const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    pendingSends.set(clientId, pushOutgoing(text));
    sendCommand(EVENT_TYPES.CMD_SEND_CHAT, { message: text, clientId });
    cooldownSend();
  }

  function cooldownSend() {
    if (!chatSendBtn) return;
    chatSendBtn.disabled = true;
    setTimeout(() => {
      if (chatSendBtn) chatSendBtn.disabled = false;
    }, SEND_COOLDOWN_MS);
  }

  function pushMessage(msg) {
    clearEmptyState();
    const row = document.createElement("div");
    row.className = "chat-row";
    const badges = (msg.badges || [])
      .slice(0, 3)
      .map((b) => `<span class="chat-row__badge" data-role="${escapeAttr(String(b))}">${escapeHtml(String(b).slice(0, 1).toUpperCase())}</span>`)
      .join("");
    row.innerHTML = `${badges}<span class="chat-row__user" style="color:${escapeAttr(msg.color || "#c9c1d6")}">${escapeHtml(msg.user)}</span><span class="chat-row__colon">:</span><span class="chat-row__text">${TwitchEmotes.renderEmotes(msg.message, msg.emotes)}</span><span class="chat-row__time">${formatTime(new Date())}</span>`;
    chatListEl.appendChild(row);
    while (chatListEl.children.length > MAX_ROWS) chatListEl.removeChild(chatListEl.firstChild);

    if (atBottom) {
      chatListEl.scrollTop = chatListEl.scrollHeight;
    } else {
      jumpBtn.hidden = false;
    }
  }

  function statusText(status) {
    return ({ connected: t("status.connected"), connecting: t("status.connecting"), disconnected: t("status.disconnected"), error: t("status.error"), not_configured: t("status.notConfigured"), disabled: t("status.disabled") }[status] || status || "—");
  }
  function statusClass(status) {
    if (status === "connected") return "is-connected";
    if (status === "error") return "is-error";
    if (status === "connecting") return "is-pending";
    return "";
  }
  function setStatus(status) {
    currentStatus = status;
    statusChipEl.className = "md-chip " + statusClass(status);
    statusLabelEl.textContent = statusText(status);
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE:
        currentChannel = msg.payload.twitchChannel || "";
        channelLabelEl.textContent = currentChannel || "—";
        setStatus((msg.payload.connectionStatus || {}).twitchChat);
        break;
      case EVENT_TYPES.CHAT_MESSAGE: {
        const payload = msg.payload || {};
        if (!consumeOutgoingEcho(payload)) pushMessage(payload);
        break;
      }
      case EVENT_TYPES.CHAT_SENT: {
        const p = msg.payload || {};
        const entry = p.clientId ? pendingSends.get(p.clientId) : null;
        if (!entry) break;
        if (p.ok) {
          entry.confirmed = true;
          setOutgoingStatus(entry, "is-sent", "✓");
        } else {
          pendingSends.delete(p.clientId);
          setOutgoingStatus(entry, "is-error", "!");
        }
        break;
      }
      case EVENT_TYPES.CONNECTION_STATUS:
        if (msg.payload.service === "twitchChat") setStatus(msg.payload.status);
        break;
      case EVENT_TYPES.CHAT_HUD_CONFIG_UPDATE:
        if (isHud && msg.payload && msg.payload.config) {
          applyHudStyle(msg.payload.config.opacity, msg.payload.config.fontSize);
        }
        break;
      case EVENT_TYPES.LOCALES:
        if (window.I18n) {
          window.I18n.setLocales(msg.payload && msg.payload.locales);
          window.I18n.setLang(msg.payload && msg.payload.lang);
          window.I18n.apply();
        }
        setStatus(currentStatus);
        if (!chatListEl.querySelector(".chat-row")) {
          chatListEl.innerHTML = '<div class="chat-list__empty">' + t("chatWindow.noMessages") + '</div>';
        }
        break;
      default:
        break;
    }
  }

  function connect() {
    ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.onmessage = (ev) => {
      try {
        handleMessage(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws.close();
  }

  if (composerEl) {
    composerEl.addEventListener("submit", (ev) => {
      ev.preventDefault();
      sendChatMessage();
    });
  }

  chatListEl.innerHTML = '<div class="chat-list__empty">' + t("chatWindow.noMessages") + '</div>';
  connect();
})();
