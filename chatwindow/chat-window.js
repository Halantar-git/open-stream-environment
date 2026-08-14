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

  const chatListEl = document.getElementById("chatList");
  const channelLabelEl = document.getElementById("channelLabel");
  const statusChipEl = document.getElementById("statusChip");
  const statusLabelEl = document.getElementById("statusLabel");
  const jumpBtn = document.getElementById("jumpToLatest");

  const MAX_ROWS = 300;
  let atBottom = true;
  let currentStatus = null;

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
    return ({ connected: t("status.connected"), connecting: t("status.connecting"), disconnected: t("status.disconnected"), error: t("status.error"), not_configured: t("status.notConfigured") }[status] || status || "—");
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
        channelLabelEl.textContent = msg.payload.twitchChannel || "—";
        setStatus((msg.payload.connectionStatus || {}).twitchChat);
        break;
      case EVENT_TYPES.CHAT_MESSAGE:
        pushMessage(msg.payload);
        break;
      case EVENT_TYPES.CONNECTION_STATUS:
        if (msg.payload.service === "twitchChat") setStatus(msg.payload.status);
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
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
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

  chatListEl.innerHTML = '<div class="chat-list__empty">' + t("chatWindow.noMessages") + '</div>';
  connect();
})();
