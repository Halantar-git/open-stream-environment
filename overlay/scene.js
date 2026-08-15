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
  const { ICONS } = window.SharedIcons;
  const t = (key, params) => (window.I18n ? window.I18n.t(key, params) : key);

  const params = new URLSearchParams(location.search);
  const sceneType = params.get("type") || "brb";
  const isTalk = sceneType === "talk";
  const MAX_CHAT = 50;

  let recentEvents = [];
  let topDonation = { user: "", amount: 0, currency: "RUB" };
  let timerInterval = null;
  let timeLeft = 0;
  let totalDuration = 0;
  let doneText = "";
  let currentScene = null;

  const els = {
    statusLabel: document.getElementById("statusLabel"),
    title: document.getElementById("sceneTitle"),
    subtitle: document.getElementById("sceneSubtitle"),
    timerBox: document.getElementById("timerBox"),
    timerDisplay: document.getElementById("timerDisplay"),
    timerProgress: document.getElementById("timerProgress"),
    eventsGrid: document.getElementById("eventsGrid"),
    evFollower: document.getElementById("evFollower"),
    evSubscriber: document.getElementById("evSubscriber"),
    evTopDonation: document.getElementById("evTopDonation"),
    socialsFooter: document.getElementById("socialsFooter"),
    sceneCard: document.querySelector(".scene-card"),
    sceneChat: document.getElementById("sceneChat"),
    sceneChatTitle: document.getElementById("sceneChatTitle"),
    sceneChatList: document.getElementById("sceneChatList"),
    sceneAlerts: document.getElementById("sceneAlerts"),
  };

  document.querySelectorAll(".event-icon[data-icon]").forEach((el) => {
    el.innerHTML = ICONS[el.dataset.icon] || "";
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }
  function formatMoney(n) {
    const locale = (window.I18n && window.I18n.getLang() === "ru") ? "ru-RU" : "en-US";
    return Number(n || 0).toLocaleString(locale);
  }
  const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", UAH: "₴", KZT: "₸", GBP: "£" };
  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || code || "";
  }

  function applyTheme(appearance) {
    if (!appearance || !appearance.tokens) return;
    const root = document.documentElement;
    Object.entries(appearance.tokens).forEach(([k, v]) => root.style.setProperty(k, v));
    document.body.dataset.decoration = appearance.tokens["--panel-decoration"] || "none";
  }

  // Scene content lives in config as editable text, but its defaults come from
  // the (Russian) catalog. Localize the default values, but keep any user edits.
  function localizedField(field, value) {
    const defaults = window.SceneCatalog ? window.SceneCatalog.defaultScenes()[sceneType] : null;
    const def = defaults ? defaults[field] : undefined;
    if (value === undefined || value === null || value === "" || value === def) {
      return t("sceneContent." + sceneType + "." + field);
    }
    return value;
  }

  function renderSceneText(scene) {
    els.statusLabel.textContent = localizedField("statusLabel", scene.statusLabel);
    els.title.textContent = localizedField("title", scene.title);
    els.subtitle.textContent = localizedField("subtitle", scene.subtitle);
    if (isTalk) els.sceneChatTitle.textContent = localizedField("title", scene.title);
  }

  function renderScene(scene) {
    if (!scene) return;
    currentScene = scene;
    renderSceneText(scene);

    if (isTalk) {
      els.sceneCard.hidden = true;
      els.sceneChat.hidden = false;
      stopTimer();
      return;
    }

    els.sceneChat.hidden = true;
    els.sceneCard.hidden = false;
    els.eventsGrid.hidden = !scene.showEvents;
    els.socialsFooter.hidden = !scene.showSocials;
    els.timerBox.hidden = !scene.showTimer;

    renderSocials(scene.socials || []);
    renderEvents();

    if (scene.showTimer) startTimer(scene.timerDuration || 0, localizedField("timerDoneText", scene.timerDoneText));
    else stopTimer();
  }

  function renderSocials(socials) {
    els.socialsFooter.innerHTML = socials
      .map((s) => `<div class="social-pill"><span class="pill-icon">${escapeHtml(s.platform)}</span><span class="pill-text">${escapeHtml(s.text)}</span></div>`)
      .join("");
  }

  function renderEvents() {
    const follow = recentEvents.find((e) => e.kind === "follow");
    const sub = recentEvents.find((e) => e.kind === "sub" || e.kind === "gift_sub");
    els.evFollower.textContent = follow ? follow.user : t("scene.notYet");
    els.evSubscriber.textContent = sub ? sub.user : t("scene.notYet");
    els.evTopDonation.textContent = topDonation.amount > 0 ? `${topDonation.user} (${formatMoney(topDonation.amount)} ${currencySymbol(topDonation.currency)})` : t("scene.notYet");
  }

  function pushChat(msg) {
    const row = document.createElement("div");
    row.className = "scene-chat__msg";
    const badges = (msg.badges || [])
      .slice(0, 3)
      .map((b) => `<span class="scene-chat__badge" data-role="${escapeAttr(String(b))}">${escapeHtml(String(b).slice(0, 1).toUpperCase())}</span>`)
      .join("");
    const text = window.TwitchEmotes && window.TwitchEmotes.renderEmotes
      ? window.TwitchEmotes.renderEmotes(msg.message, msg.emotes)
      : escapeHtml(msg.message);
    row.innerHTML = `${badges}<span class="scene-chat__user" style="color:${escapeAttr(msg.color || "#c9c1d6")}">${escapeHtml(msg.user)}</span><span class="scene-chat__colon">:</span><span class="scene-chat__text">${text}</span>`;
    els.sceneChatList.appendChild(row);
    while (els.sceneChatList.children.length > MAX_CHAT) els.sceneChatList.removeChild(els.sceneChatList.firstChild);
    els.sceneChatList.scrollTop = els.sceneChatList.scrollHeight;
  }

  function kindLabel(alert) {
    switch (alert.kind) {
      case "follow": return t("alert.follow");
      case "sub": return t("alert.sub");
      case "gift_sub": return t("alert.giftSub", { count: alert.count || 1 });
      case "cheer": return t("alert.cheer");
      case "donation": return t("alert.donation");
      case "wheel_start": return t("alert.wheelStart");
      case "wheel_winner": return t("alert.wheelWinner");
      default: return "";
    }
  }

  function formatAmount(alert) {
    if (alert.kind === "cheer") return t("alert.cheerBits", { amount: alert.amount });
    if (alert.kind === "donation") return `${formatMoney(alert.amount)} ${currencySymbol(alert.currency || "RUB")}`;
    return "";
  }

  function showAlert(alert) {
    const card = document.createElement("div");
    card.className = "scene-alert";
    card.dataset.kind = alert.kind || "";

    let icon = ICONS[alert.kind] || "";
    let nameHtml = escapeHtml(alert.user || "");

    if (alert.kind === "wheel_start") {
      icon = "🎉";
      nameHtml = escapeHtml(t("alert.wheelStartMessage", { command: alert.command || "" }));
    } else if (alert.kind === "wheel_winner") {
      icon = "";
      const name = escapeHtml(alert.user || "");
      if (alert.isElimination) nameHtml = t("alert.eliminated", { name });
      else if (alert.isFinalWinner) nameHtml = t("alert.finalWinner", { name });
      else nameHtml = t("alert.winner", { name });
    }

    const amount = formatAmount(alert);
    const messageHtml = (alert.kind === "donation" || alert.kind === "cheer") && alert.message
      ? `<div class="scene-alert__message">«${escapeHtml(alert.message)}»</div>`
      : "";

    card.innerHTML = `
      ${icon ? `<div class="scene-alert__icon">${icon}</div>` : ""}
      <div class="scene-alert__body">
        <div class="scene-alert__kicker">${kindLabel(alert)}</div>
        <div class="scene-alert__name">${nameHtml}</div>
        ${amount ? `<div class="scene-alert__amount">${amount}</div>` : ""}
        ${messageHtml}
      </div>`;

    els.sceneAlerts.prepend(card);
    requestAnimationFrame(() => card.classList.add("scene-alert--in"));

    const holdMs = alert.durationMs || 5000;
    setTimeout(() => {
      card.classList.add("scene-alert--out");
      setTimeout(() => card.remove(), 300);
    }, holdMs);
  }

  function startTimer(duration, doneMsg) {
    stopTimer();
    totalDuration = duration;
    timeLeft = duration;
    doneText = doneMsg;
    updateTimerDisplay();
    if (duration <= 0) return;
    timerInterval = setInterval(() => {
      timeLeft = Math.max(0, timeLeft - 1);
      updateTimerDisplay();
      if (timeLeft <= 0) {
        if (doneText) els.subtitle.textContent = doneText;
        stopTimer();
      }
    }, 1000);
  }
  function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
  }
  function updateTimerDisplay() {
    const m = Math.floor(timeLeft / 60);
    const s = timeLeft % 60;
    els.timerDisplay.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    const pct = totalDuration ? (timeLeft / totalDuration) * 100 : 0;
    els.timerProgress.style.width = pct + "%";
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE:
        applyTheme(msg.payload.appearance);
        recentEvents = msg.payload.recentEvents || [];
        topDonation = msg.payload.topDonation || topDonation;
        renderScene(msg.payload.scenes && msg.payload.scenes[sceneType]);
        break;
      case EVENT_TYPES.THEME_UPDATE:
        applyTheme(msg.payload);
        break;
      case EVENT_TYPES.SCENES_UPDATE:
        renderScene(msg.payload[sceneType]);
        break;
      case EVENT_TYPES.RECENT_EVENT:
        recentEvents = [msg.payload, ...recentEvents].slice(0, 15);
        renderEvents();
        break;
      case EVENT_TYPES.CHAT_MESSAGE:
        if (isTalk) pushChat(msg.payload);
        break;
      case EVENT_TYPES.ALERT:
        if (isTalk) showAlert(msg.payload);
        break;
      case EVENT_TYPES.TOP_DONATION_UPDATE:
        topDonation = msg.payload;
        renderEvents();
        break;
      case EVENT_TYPES.LOCALES:
        if (window.I18n) {
          window.I18n.setLocales(msg.payload && msg.payload.locales);
          window.I18n.setLang(msg.payload && msg.payload.lang);
          window.I18n.apply();
        }
        if (currentScene) {
          renderSceneText(currentScene);
          doneText = localizedField("timerDoneText", currentScene.timerDoneText);
        }
        renderEvents();
        break;
      default:
        break;
    }
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
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

  connect();
})();
