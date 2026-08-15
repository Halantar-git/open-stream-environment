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

  const canvas = document.getElementById("canvas");
  const mounted = new Map(); // widget instance id -> { el, inner, type, config, ...typeState }

  let goal = { title: "Цель", current: 0, target: 1, currency: "RUB" };
  let recentEvents = [];
  let stats = { followerCount: null, subscriberCount: null };
  let topDonation = { user: "", amount: 0, currency: "RUB" };
  let deathCount = 0;

  let ws;
  let wheelSectors = [];
  let wheelRotation = 0;
  let wheelSpinning = false;
  let wheelVisible = false;
  let participantsConfig = { maxNames: 10, marquee: false, fontSize: 16, textColor: "#e8e1f0", backgroundOpacity: 82 };
  let participantsState = { count: 0, participants: [] };
  let wheelConfig = { musicVolume: 50 };
  let wheelSpeedConfig = { speed: 3 };
  let micConfig = { sensitivity: 1.5, lineWidth: 2, color: "#0060A8", opacity: 0.9, visualizer_mode: "sine", barCount: 32, barGap: 2 };
  let spinAudioEl = null;
  let spinFallback = null;

  // ---------------- rendering / reconciliation ----------------

  function render(layout) {
    const seen = new Set();
    [...layout]
      .sort((a, b) => (a.z || 0) - (b.z || 0))
      .forEach((inst) => {
        seen.add(inst.id);
        let entry = mounted.get(inst.id);
        if (!entry || entry.type !== inst.type) {
          if (entry) unmountEntry(entry);
          entry = mountInstance(inst);
          mounted.set(inst.id, entry);
        }
        entry.config = inst.config || {};
        entry.visible = !!inst.visible;
        applyGeometry(entry.el, inst);
        // Alerts are a priority layer: they must render above the overlay chrome
        // (the wheel sits at z-index 1000), so the wheel marker never overlaps them.
        entry.el.style.zIndex = entry.type === "alerts" ? 2000 + (inst.z || 0) : (inst.z || 0);
        if (entry.type === "participants") {
          entry.el.style.display = entry.visible && wheelVisible ? "" : "none";
        } else {
          entry.el.style.display = entry.visible ? "" : "none";
        }
        if (entry.type === "goal") renderGoal(entry);
        if (entry.type === "recent") renderRecent(entry);
        if (entry.type === "custom") renderCustom(entry);
        if (entry.type === "stat") renderStat(entry);
        if (entry.type === "social") maybeStartSocialRotation(entry, inst.config || {});
        if (entry.type === "participants") renderParticipantsEntry(entry);
        if (entry.type === "mic") renderMic(entry);
        if (entry.type === "death") renderDeath(entry);
        if (entry.type === "chat" && typeof inst.config.maxMessages === "number") {
          trimChat(entry);
        }
      });

    for (const [id, entry] of mounted) {
      if (!seen.has(id)) {
        unmountEntry(entry);
        mounted.delete(id);
      }
    }
  }

  function unmountEntry(entry) {
    if (entry.socialTimer) clearInterval(entry.socialTimer);
    if (entry.type === "mic") stopMicVisualizer(entry);
    entry.el.remove();
  }

  function applyGeometry(el, inst) {
    el.style.left = inst.x + "%";
    el.style.top = inst.y + "%";
    el.style.width = inst.w + "%";
    el.style.height = inst.h + "%";
  }

  function mountInstance(inst) {
    const el = document.createElement("div");
    el.className = "widget-instance";
    el.dataset.type = inst.type;
    canvas.appendChild(el);

    const inner = document.createElement("div");
    el.appendChild(inner);

    const entry = { el, inner, type: inst.type, config: inst.config || {} };

    switch (inst.type) {
      case "alerts":
        inner.className = "widget-alerts-host";
        entry.queue = [];
        entry.playing = false;
        break;
      case "goal":
        inner.className = "widget-goal";
        break;
      case "chat":
        inner.className = "widget-chat";
        break;
      case "recent":
        inner.className = "widget-recent";
        break;
      case "custom":
        inner.className = "widget-custom";
        break;
      case "stat":
        inner.className = "widget-stat";
        break;
      case "social":
        inner.className = "widget-social";
        entry.socialIndex = 0;
        entry.socialTimer = null;
        entry.socialKey = "";
        break;
      case "participants":
        inner.className = "widget-participants";
        break;
      case "mic":
        inner.className = "widget-mic";
        break;
      case "death":
        inner.className = "widget-death";
        break;
      default:
        break;
    }
    return entry;
  }

  // ---------------- alerts ----------------

  function kindLabel(alert) {
    switch (alert.kind) {
      case "follow":
        return t("alert.follow");
      case "sub":
        return t("alert.sub");
      case "gift_sub":
        return t("alert.giftSub", { count: alert.count || 1 });
      case "cheer":
        return t("alert.cheer");
      case "donation":
        return t("alert.donation");
      case "wheel_start":
        return t("alert.wheelStart");
      case "wheel_winner":
        return t("alert.wheelWinner");
      default:
        return "";
    }
  }

  function formatAmount(alert) {
    if (alert.kind === "cheer") return t("alert.cheerBits", { amount: alert.amount });
    if (alert.kind === "donation") return `${formatMoney(alert.amount)} ${currencySymbol(alert.currency || "RUB")}`;
    return "";
  }

  function buildAlertCard(alert) {
    const card = document.createElement("div");
    card.className = "widget-alert";
    card.dataset.kind = alert.kind;

    const showAmount = alert.kind === "donation" || alert.kind === "cheer";
    let icon = ICONS[alert.kind] || "";
    if (alert.kind === "wheel_start") icon = "🎉";

    let nameHtml = escapeHtml(alert.user || "");
    let messageHtml = "";

    if (alert.kind === "wheel_start") {
      nameHtml = escapeHtml(t("alert.wheelStartMessage", { command: alert.command || "" }));
    } else if (alert.kind === "wheel_winner") {
      const elimination = !!alert.isElimination;
      const finalWinner = !!alert.isFinalWinner;
      icon = "";
      const name = escapeHtml(alert.user || "");
      if (elimination) {
        nameHtml = t("alert.eliminated", { name });
      } else if (finalWinner) {
        nameHtml = t("alert.finalWinner", { name });
      } else {
        nameHtml = t("alert.winner", { name });
      }
      messageHtml = "";
    } else if (alert.kind === "donation" || alert.kind === "cheer") {
      if (alert.message) messageHtml = `<div class="widget-alert__message">«${escapeHtml(alert.message)}»</div>`;
    }

    card.innerHTML = `
      <div class="widget-alert__spark">${"<span></span>".repeat(6)}</div>
      ${icon ? `<div class="widget-alert__icon">${icon}</div>` : ""}
      <div class="widget-alert__body">
        <div class="widget-alert__status"><span class="widget-alert__dot"></span><span class="widget-alert__kicker">${kindLabel(alert)}</span></div>
        <div class="widget-alert__name">${nameHtml}</div>
        ${showAmount ? `<div class="widget-alert__amount">${formatAmount(alert)}</div>` : ""}
        ${messageHtml}
      </div>
      <div class="widget-alert__lockbar"><div class="widget-alert__lockbar-fill"></div></div>`;
    return card;
  }

  function queueAlert(alert) {
    if (alert.kind === "wheel_winner") {
      if (alert.isElimination) playEliminationAudio();
      else playWinSound();
    }
    for (const entry of mounted.values()) {
      if (entry.type !== "alerts") continue;
      entry.queue.push(alert);
      if (!entry.playing) drainAlertQueue(entry);
    }
  }

  function drainAlertQueue(entry) {
    const alert = entry.queue.shift();
    if (!alert) {
      entry.playing = false;
      return;
    }
    entry.playing = true;
    const card = buildAlertCard(alert);
    entry.inner.appendChild(card);
    requestAnimationFrame(() => card.classList.add("alert-enter-active"));
    const holdMs = alert.durationMs || 5000;
    setTimeout(() => {
      card.classList.add("alert-exit");
      setTimeout(() => {
        card.remove();
        drainAlertQueue(entry);
      }, 280);
    }, holdMs);
  }

  // ---------------- goal ----------------

  function renderGoal(entry) {
    const pct = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
    entry.inner.innerHTML = `
      <div class="widget-goal__row">
        <span class="widget-goal__title">${escapeHtml(goal.title || t("preview.goalTitle"))}</span>
        <span class="widget-goal__amounts"><b>${formatMoney(goal.current)}</b> / ${formatMoney(goal.target)} ${escapeHtml(currencySymbol(goal.currency))}</span>
      </div>
      <div class="md-linear-progress"><div class="md-linear-progress__bar" style="width:${pct}%"></div></div>
      ${entry.config.showPercentage ? `<div class="widget-goal__percent">${pct}%</div>` : ""}`;
  }

  function renderAllGoals() {
    for (const entry of mounted.values()) if (entry.type === "goal") renderGoal(entry);
  }

  // ---------------- chat ----------------

  function buildChatRow(msg, config) {
    const row = document.createElement("div");
    row.className = "widget-chat__msg";
    const badges =
      config && config.showBadges === false
        ? ""
        : (msg.badges || [])
            .slice(0, 3)
            .map((b) => `<span class="widget-chat__badge" data-role="${escapeAttr(String(b))}">${escapeHtml(String(b).slice(0, 1).toUpperCase())}</span>`)
            .join("");
    row.innerHTML = `${badges}<span class="widget-chat__user" style="color:${escapeAttr(msg.color || "#c9c1d6")}">${escapeHtml(msg.user)}</span><span class="widget-chat__colon">:</span><span class="widget-chat__text">${TwitchEmotes.renderEmotes(msg.message, msg.emotes)}</span>`;
    return row;
  }

  function pushChat(msg) {
    for (const entry of mounted.values()) {
      if (entry.type !== "chat") continue;
      entry.inner.appendChild(buildChatRow(msg, entry.config));
      trimChat(entry);
    }
  }

  function trimChat(entry) {
    const max = entry.config.maxMessages || 8;
    while (entry.inner.children.length > max) entry.inner.removeChild(entry.inner.firstChild);
  }

  // ---------------- recent events ----------------

  function recentText(evt) {
    const user = `<b>${escapeHtml(evt.user || "")}</b>`;
    switch (evt.kind) {
      case "follow":
        return t("recent.follow", { user });
      case "sub":
        return t("recent.sub", { user });
      case "gift_sub":
        return t("recent.giftSub", { user, amount: evt.amount || "" });
      case "cheer":
        return t("recent.cheer", { user, amount: evt.amount || 0 });
      case "donation":
        return t("recent.donation", { user, amount: formatMoney(evt.amount || 0) });
      default:
        return user;
    }
  }

  function renderRecent(entry) {
    const max = entry.config.maxItems || 5;
    const items = recentEvents.slice(0, max);
    entry.inner.innerHTML =
      `<div class="widget-recent__title">${t("preview.recentTitle")}</div>` +
      (items.length
        ? `<div class="widget-recent__list">${items
            .map((e) => `<div class="widget-recent__item"><span class="widget-recent__dot" data-kind="${e.kind}"></span><span>${recentText(e)}</span></div>`)
            .join("")}</div>`
        : `<div class="widget-recent__empty">${t("recent.empty")}</div>`);
  }

  function renderAllRecent() {
    for (const entry of mounted.values()) if (entry.type === "recent") renderRecent(entry);
  }

  // ---------------- stat pill ----------------

  function statContent(config) {
    const metric = config.metric || "followers";
    if (metric === "subscribers") {
      return {
        icon: ICONS.sub,
        label: config.label || t("preview.subscribers"),
        value: stats.subscriberCount != null ? formatMoney(stats.subscriberCount) : "—",
      };
    }
    if (metric === "latestFollower") {
      const e = recentEvents.find((ev) => ev.kind === "follow");
      return { icon: ICONS.follow, label: config.label || t("preview.latestFollower"), value: e ? e.user : t("scene.notYet") };
    }
    if (metric === "latestSubscriber") {
      const e = recentEvents.find((ev) => ev.kind === "sub" || ev.kind === "gift_sub");
      return { icon: ICONS.sub, label: config.label || t("preview.latestSubscriber"), value: e ? e.user : t("scene.notYet") };
    }
    if (metric === "topDonation") {
      return {
        icon: ICONS.donation,
        label: config.label || t("preview.topDonation"),
        value: topDonation.amount > 0 ? `${topDonation.user} (${formatMoney(topDonation.amount)} ${currencySymbol(topDonation.currency)})` : t("scene.notYet"),
      };
    }
    return {
      icon: ICONS.follow,
      label: config.label || t("preview.followers"),
      value: stats.followerCount != null ? formatMoney(stats.followerCount) : "—",
    };
  }

  function renderStat(entry) {
    const { icon, label, value } = statContent(entry.config || {});
    entry.inner.innerHTML = `<div class="widget-stat__icon">${icon}</div><div class="widget-stat__info"><span class="widget-stat__label">${escapeHtml(label)}</span><span class="widget-stat__value">${escapeHtml(value)}</span></div>`;
  }

  function renderAllStats() {
    for (const entry of mounted.values()) if (entry.type === "stat") renderStat(entry);
  }

  function renderDeath(entry) {
    const cfg = entry.config || {};
    const label = cfg.label || t("preview.death");
    const color = cfg.color || "#ff4d4d";
    entry.inner.innerHTML = `<div class="widget-death__label">${escapeHtml(label)}</div><div class="widget-death__value" style="color:${escapeAttr(color)}">${deathCount}</div>`;
  }

  function renderAllDeaths() {
    for (const entry of mounted.values()) if (entry.type === "death") renderDeath(entry);
  }

  // ---------------- rotating social banner ----------------

  function maybeStartSocialRotation(entry, config) {
    const socials = config.socials || [];
    const key = JSON.stringify(socials) + "|" + (config.rotateIntervalSec || 8);
    if (entry.socialKey === key) return; // config unchanged, leave the running rotation alone
    entry.socialKey = key;
    if (entry.socialTimer) clearInterval(entry.socialTimer);
    entry.socialIndex = 0;
    renderSocialFrame(entry, socials);
    if (socials.length > 1) {
      const intervalMs = Math.max(2, config.rotateIntervalSec || 8) * 1000;
      entry.socialTimer = setInterval(() => {
        const contentEl = entry.inner.querySelector(".widget-social__content");
        if (contentEl) contentEl.classList.add("is-fading");
        setTimeout(() => {
          entry.socialIndex = (entry.socialIndex + 1) % socials.length;
          renderSocialFrame(entry, socials);
        }, 300);
      }, intervalMs);
    }
  }

  function renderSocialFrame(entry, socials) {
    const s = socials[entry.socialIndex] || { platform: "", text: "" };
    entry.inner.innerHTML = `<div class="widget-social__content"><span class="widget-social__icon">${escapeHtml(s.platform)}</span><div class="widget-social__info"><span class="widget-social__platform">${escapeHtml(s.platform)}</span><span class="widget-social__handle">${escapeHtml(s.text)}</span></div></div>`;
  }

  // ---------------- custom widget ----------------

  function renderCustom(entry) {
    const cfg = entry.config || {};
    const mode = cfg.mode || "text";
    const withCard = mode !== "image" && cfg.showBackground !== false;
    entry.inner.className = "widget-custom" + (withCard ? " has-card" : "");

    if (mode === "image") {
      entry.customCodeKey = null;
      entry.inner.innerHTML = cfg.imageUrl
        ? `<img class="widget-custom__image" src="${escapeAttr(cfg.imageUrl)}" style="object-fit:${escapeAttr(cfg.imageFit || "contain")}" alt="">`
        : "";
    } else if (mode === "html") {
      const key = `${cfg.html || ""}\u0000${cfg.css || ""}\u0000${cfg.js || ""}`;
      if (entry.customCodeKey !== key) {
        entry.customCodeKey = key;
        entry.inner.innerHTML = "";
        const iframe = document.createElement("iframe");
        iframe.className = "widget-custom__html";
        iframe.srcdoc = buildCustomWidgetDocument(cfg);
        entry.inner.appendChild(iframe);
      }
    } else {
      entry.customCodeKey = null;
      const title = cfg.textTitle ? `<div class="widget-custom__title">${escapeHtml(cfg.textTitle)}</div>` : "";
      const colorStyle = cfg.textColor ? ` style="color:${escapeAttr(cfg.textColor)}"` : "";
      entry.inner.innerHTML = `<div class="widget-custom__text" data-align="${escapeAttr(cfg.textAlign || "center")}">${title}<div class="widget-custom__body" data-size="${escapeAttr(cfg.textSize || "medium")}"${colorStyle}>${escapeHtml(cfg.text || "")}</div></div>`;
    }
  }

  function buildCustomWidgetDocument(cfg) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#e8e1f0;font-family:sans-serif;}${cfg.css || ""}</style></head><body>${cfg.html || ""}<script>${cfg.js || ""}</script></body></html>`;
  }

  // ---------------- theme ----------------

  function applyTheme(appearance) {
    if (!appearance || !appearance.tokens) return;
    const root = document.documentElement;
    Object.entries(appearance.tokens).forEach(([k, v]) => root.style.setProperty(k, v));
    document.body.dataset.decoration = appearance.tokens["--panel-decoration"] || "none";
    document.body.dataset.theme = appearance.activeThemeId || "";
    if (wheelSectors.length) drawWheel();
  }

  // ---------------- utils ----------------

  function formatMoney(n) {
    return Number(n || 0).toLocaleString("ru-RU");
  }
  const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", UAH: "₴", KZT: "₸", GBP: "£" };
  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || code || "";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }

  // ---------------- socket ----------------

  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE:
        goal = msg.payload.goal;
        recentEvents = msg.payload.recentEvents || [];
        stats = msg.payload.stats || stats;
        topDonation = msg.payload.topDonation || topDonation;
        deathCount = msg.payload.deathCount || 0;
        if (msg.payload.giveaway) {
          participantsState = {
            count: msg.payload.giveaway.count || 0,
            participants: Array.isArray(msg.payload.giveaway.participants) ? msg.payload.giveaway.participants : [],
          };
        }
        applyTheme(msg.payload.appearance);
        render(msg.payload.layout || []);
        break;
      case EVENT_TYPES.LAYOUT_UPDATE:
        render(msg.payload.layout || []);
        break;
      case EVENT_TYPES.THEME_UPDATE:
        applyTheme(msg.payload);
        break;
      case EVENT_TYPES.STAT_UPDATE:
        stats = msg.payload;
        renderAllStats();
        break;
      case EVENT_TYPES.DEATH_COUNT_UPDATE:
        deathCount = (msg.payload && msg.payload.count) || 0;
        renderAllDeaths();
        break;
      case EVENT_TYPES.TOP_DONATION_UPDATE:
        topDonation = msg.payload;
        renderAllStats();
        break;
      case EVENT_TYPES.ALERT:
        queueAlert(msg.payload);
        break;
      case EVENT_TYPES.CHAT_MESSAGE:
        pushChat(msg.payload);
        break;
      case EVENT_TYPES.RECENT_EVENT:
        recentEvents = [msg.payload, ...recentEvents].slice(0, 15);
        renderAllRecent();
        renderAllStats();
        break;
      case EVENT_TYPES.GOAL_UPDATE:
        goal = msg.payload;
        renderAllGoals();
        break;
      case EVENT_TYPES.GIVEAWAY_WHEEL:
        showWheel((msg.payload && msg.payload.sectors) || []);
        break;
      case EVENT_TYPES.GIVEAWAY_SPIN:
        spinWheel((msg.payload && msg.payload.winner) || null);
        break;
      case EVENT_TYPES.GIVEAWAY_PARTICIPANTS:
        participantsState = {
          count: (msg.payload && msg.payload.count) || 0,
          participants: Array.isArray(msg.payload && msg.payload.participants) ? msg.payload.participants : [],
        };
        renderAllParticipants();
        break;
      case EVENT_TYPES.OVERLAY_PARTICIPANTS_CONFIG:
        participantsConfig = (msg.payload && msg.payload.config) || participantsConfig;
        renderAllParticipants();
        break;
      case EVENT_TYPES.WHEEL_CONFIG:
        wheelConfig = (msg.payload && msg.payload.config) || wheelConfig;
        break;
      case EVENT_TYPES.WHEEL_SPEED_CONFIG:
        wheelSpeedConfig = (msg.payload && msg.payload.config) || wheelSpeedConfig;
        break;
      case EVENT_TYPES.OVERLAY_MIC_CONFIG:
        micConfig = (msg.payload && msg.payload.config) || micConfig;
        break;
      case EVENT_TYPES.LOCALES:
        if (window.I18n) {
          window.I18n.setLocales(msg.payload && msg.payload.locales);
          window.I18n.setLang(msg.payload && msg.payload.lang);
          window.I18n.apply();
        }
        renderAllGoals();
        renderAllRecent();
        renderAllStats();
        renderAllDeaths();
        renderAllParticipants();
        break;
      default:
        break;
    }
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
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

  function send(type, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
  }

  function showWheel(sectors) {
    wheelSectors = Array.isArray(sectors) ? sectors : [];
    wheelVisible = wheelSectors.length > 0;
    const wheelEl = document.getElementById("wheel");
    wheelEl.hidden = !wheelVisible;
    applyParticipantsVisibility();
    if (!wheelVisible) {
      return;
    }
    wheelRotation = 0;
    wheelSpinning = false;
    resizeWheel();
    drawWheel();
  }

  function applyParticipantsVisibility() {
    for (const entry of mounted.values()) {
      if (entry.type !== "participants") continue;
      entry.el.style.display = entry.visible && wheelVisible ? "" : "none";
    }
  }

  function resizeWheel() {
    const wheelEl = document.getElementById("wheel");
    if (!wheelEl) return;
    const base = 640;
    const pad = 48;
    const s = Math.max(0.32, Math.min(1.15, (Math.min(window.innerWidth, window.innerHeight) - pad) / base));
    wheelEl.style.setProperty("--wheel-scale", String(s));
  }

  window.addEventListener("resize", resizeWheel);

  function readCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function shade(hex, amt) {
    const h = String(hex || "").replace("#", "");
    const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
    const n = parseInt(full, 16);
    if (Number.isNaN(n)) return "#888";
    let r = (n >> 16) & 255;
    let g = (n >> 8) & 255;
    let b = n & 255;
    const t = amt < 0 ? 0 : 255;
    const p = Math.abs(amt);
    r = Math.round((t - r) * p + r);
    g = Math.round((t - g) * p + g);
    b = Math.round((t - b) * p + b);
    return `rgb(${r},${g},${b})`;
  }

  function themeSectorPairs() {
    return [
      ["--md-primary", "--md-on-primary"],
      ["--md-secondary", "--md-on-secondary"],
      ["--md-tertiary", "--md-on-tertiary"],
      ["--md-error", "--md-on-error"],
      ["--md-primary-container", "--md-on-primary-container"],
      ["--md-secondary-container", "--md-on-secondary-container"],
      ["--md-tertiary-container", "--md-on-tertiary-container"],
    ].map(([bg, fg]) => ({ bg: readCssVar(bg) || "#888888", fg: readCssVar(fg) || "#14101c" }));
  }

  function drawWheel() {
    const canvas = document.getElementById("wheelCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2 - 12;
    ctx.clearRect(0, 0, w, h);

    const n = wheelSectors.length;
    if (!n) return;
    const slice = (Math.PI * 2) / n;
    const pairs = themeSectorPairs();

    for (let i = 0; i < n; i++) {
      const start = wheelRotation + i * slice;
      const end = start + slice;
      const pair = pairs[i % pairs.length];

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, end);
      ctx.closePath();

      const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      grad.addColorStop(0, shade(pair.bg, 0.28));
      grad.addColorStop(0.5, pair.bg);
      grad.addColorStop(1, shade(pair.bg, -0.22));
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.strokeStyle = "rgba(0,0,0,0.28)";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(start + slice / 2);
      ctx.textAlign = "right";
      ctx.fillStyle = pair.fg;
      ctx.font = "600 15px Roboto, sans-serif";
      ctx.fillText(truncate(wheelSectors[i], 18), r - 14, 6);
      ctx.restore();
    }
  }

  function truncate(s, max) {
    const str = String(s || "");
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
  }

  function spinWheel(winner) {
    if (!wheelSectors.length || wheelSpinning) return;
    const wheelEl = document.getElementById("wheel");
    if (wheelEl) wheelEl.classList.add("is-spinning");
    wheelSpinning = true;
    startSpinAudio();
    const n = wheelSectors.length;
    let winnerIndex = wheelSectors.indexOf(winner || "");
    if (winnerIndex < 0) winnerIndex = Math.floor(Math.random() * n);
    const slice = (Math.PI * 2) / n;
    const pointer = -Math.PI / 2;
    const speed = Math.max(1, Math.min(5, Number(wheelSpeedConfig.speed) || 3));
    let target = pointer - (winnerIndex * slice + slice / 2);
    while (target <= wheelRotation) target += Math.PI * 2;
    target += Math.PI * 2 * (2 + speed);

    const startRotation = wheelRotation;
    const startTime = performance.now();
    const duration = Math.max(2600, 6800 - speed * 700);

    function frame(now) {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      wheelRotation = startRotation + (target - startRotation) * eased;
      drawWheel();
      const spinFade = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
      setSpinVolume(((wheelConfig.musicVolume ?? 50) / 100) * spinFade);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        wheelRotation = target;
        drawWheel();
        wheelSpinning = false;
        stopSpinAudio();
        if (wheelEl) wheelEl.classList.remove("is-spinning");
        send(EVENT_TYPES.CMD_SET_GIVEAWAY_WINNER, { username: wheelSectors[winnerIndex] });
      }
    }
    requestAnimationFrame(frame);
  }

  function renderParticipantsEntry(entry) {
    const count = participantsState.count || 0;
    const all = participantsState.participants || [];

    entry.inner.style.setProperty("--pw-font-size", participantsConfig.fontSize + "px");
    entry.inner.style.setProperty("--pw-text", participantsConfig.textColor);
    entry.inner.style.setProperty("--pw-bg-opacity", participantsConfig.backgroundOpacity + "%");

    if (!count) {
      entry.inner.innerHTML = "";
      return;
    }

    let listHtml = "";
    if (participantsConfig.marquee) {
      const text = all.join(" • ");
      listHtml = `<div class="widget-participants__marquee"><span>${escapeHtml(text)}</span><span>${escapeHtml(text)}</span></div>`;
    } else {
      const max = Math.max(1, Number(participantsConfig.maxNames) || 10);
      const names = all.slice(0, max);
      const extra = count - names.length;
      listHtml = `<div class="widget-participants__list">${names.map((n) => `<span class="widget-participants__chip">${escapeHtml(n)}</span>`).join("")}${extra > 0 ? `<span class="widget-participants__more">+${extra}</span>` : ""}</div>`;
    }

    entry.inner.innerHTML = `
      <div class="widget-participants__title">${t("wheelScene.participantsTitle", { count })}</div>
      ${listHtml}`;
  }

  function renderAllParticipants() {
    for (const entry of mounted.values()) {
      if (entry.type === "participants") renderParticipantsEntry(entry);
    }
  }

  // ---------------- microphone audio visualizer ----------------

  function renderMic(entry) {
    if (!entry.canvas) {
      const canvas = document.createElement("canvas");
      canvas.className = "widget-mic__canvas";
      entry.inner.appendChild(canvas);
      entry.canvas = canvas;
      entry.ctx = canvas.getContext("2d");
      entry.t0 = performance.now();
      entry.analyser = null;
      entry.dataArray = null;
      entry.rafId = null;
      entry.audioCtx = null;
      entry.stream = null;
      startMicAudio(entry);
    }
    if (!entry.rafId) {
      const loop = (now) => {
        if (!entry.canvas.isConnected) {
          entry.rafId = null;
          return;
        }
        drawMic(entry, now);
        entry.rafId = requestAnimationFrame(loop);
      };
      entry.rafId = requestAnimationFrame(loop);
    }
  }

  function startMicAudio(entry) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (!entry.canvas || !entry.canvas.isConnected) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const ctx = new Ctx();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        entry.stream = stream;
        entry.audioCtx = ctx;
        entry.analyser = analyser;
        entry.dataArray = new Uint8Array(analyser.fftSize);
        entry.freqArray = new Uint8Array(analyser.frequencyBinCount);
      })
      .catch(() => {
        /* mic unavailable — keep the idle wobble */
      });
  }

  function stopMicVisualizer(entry) {
    if (entry.rafId) cancelAnimationFrame(entry.rafId);
    entry.rafId = null;
    if (entry.stream) {
      entry.stream.getTracks().forEach((t) => t.stop());
      entry.stream = null;
    }
    if (entry.audioCtx) {
      entry.audioCtx.close().catch(() => {});
      entry.audioCtx = null;
    }
    entry.analyser = null;
    entry.dataArray = null;
    entry.freqArray = null;
  }

  function drawMic(entry, now) {
    const canvas = entry.canvas;
    const host = entry.inner;
    const cw = host.clientWidth || 320;
    const ch = host.clientHeight || 96;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const ctx = entry.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const cfg = micConfig || {};
    const color = cfg.color || readCssVar("--md-primary") || "#0060A8";
    const sensitivity = clampNum(cfg.sensitivity, 0.2, 6, 1.5);
    const lineWidth = clampNum(cfg.lineWidth, 1, 12, 2);
    const opacity = clampNum(cfg.opacity, 0.05, 1, 0.9);
    const mode = cfg.visualizer_mode || "sine";

    const amp = (ch / 2) * 0.92 * sensitivity;
    const t = (now - entry.t0) / 1000;

    let level = 0;
    if (entry.analyser && entry.dataArray) {
      entry.analyser.getByteTimeDomainData(entry.dataArray);
      let sum = 0;
      for (let i = 0; i < entry.dataArray.length; i++) {
        const v = (entry.dataArray[i] - 128) / 128;
        sum += v * v;
      }
      level = Math.sqrt(sum / entry.dataArray.length);
    }
    entry.level = level;

    if (mode !== "sine" && entry.analyser && entry.freqArray) {
      entry.analyser.getByteFrequencyData(entry.freqArray);
    }

    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = opacity;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    if (mode === "bars") {
      drawMicBars(ctx, cw, ch, entry);
    } else if (mode === "ring") {
      drawMicRing(ctx, cw, ch, entry);
    } else {
      drawMicSine(ctx, cw, ch, entry, t, amp, level);
    }

    ctx.globalAlpha = 1;
  }

  function drawMicSine(ctx, cw, ch, entry, t, amp, level) {
    const live = level > 0.02;
    const POINTS = 240;
    const midY = ch / 2;
    ctx.beginPath();
    for (let i = 0; i <= POINTS; i++) {
      const x = (i / POINTS) * cw;
      let y = midY;
      if (live && entry.dataArray && entry.dataArray.length) {
        const idx = Math.floor((i / POINTS) * (entry.dataArray.length - 1));
        const v = (entry.dataArray[idx] - 128) / 128;
        y = midY + v * amp;
      } else {
        y = midY + Math.sin(x * 0.02 + t * 1.6) * (amp * 0.05) + Math.sin(x * 0.006 - t * 0.9) * (amp * 0.03);
      }
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function drawMicBars(ctx, cw, ch, entry) {
    const freq = entry.freqArray;
    if (!freq || !freq.length) return;
    const barCount = Math.round(clampNum(micConfig.barCount, 10, 64, 32));
    const gap = Math.max(0, Number(micConfig.barGap) || 0);
    const usable = Math.max(8, Math.floor(freq.length * 0.8));
    const slotW = cw / barCount;
    const barW = Math.max(1, slotW - gap);
    for (let i = 0; i < barCount; i++) {
      const idx = Math.floor((i / (barCount - 1)) * (usable - 1));
      const v = freq[idx] / 255;
      const h = Math.max(1, v * ch * 0.96);
      const x = i * slotW + (slotW - barW) / 2;
      const y = (ch - h) / 2;
      ctx.fillRect(x, y, barW, h);
    }
  }

  function drawMicRing(ctx, cw, ch, entry) {
    const freq = entry.freqArray;
    if (!freq || !freq.length) return;
    const barCount = Math.round(clampNum(micConfig.barCount, 10, 64, 32));
    const cx = cw / 2;
    const cy = ch / 2;
    const maxR = Math.min(cw, ch) / 2 - 2;
    const minR = maxR * 0.35;
    const usable = Math.max(8, Math.floor(freq.length * 0.8));
    for (let i = 0; i < barCount; i++) {
      const idx = Math.floor((i / (barCount - 1)) * (usable - 1));
      const v = freq[idx] / 255;
      const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
      const r = minR + (maxR - minR) * v;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * minR, cy + Math.sin(angle) * minR);
      ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      ctx.stroke();
    }
  }

  function clampNum(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function playFanfare() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.value = freq;
        const t = ctx.currentTime + i * 0.14;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.22, t + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.55);
      });
      setTimeout(() => ctx.close().catch(() => {}), 1700);
    } catch {
      /* audio unavailable */
    }
  }

  function playEliminationSound() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(330, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(140, ctx.currentTime + 0.4);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.55);
      setTimeout(() => ctx.close().catch(() => {}), 700);
    } catch {
      /* audio unavailable */
    }
  }

  function setSpinVolume(v) {
    if (spinAudioEl) spinAudioEl.volume = v;
    if (spinFallback && spinFallback.gain) spinFallback.gain.gain.value = v;
  }

  function startSpinAudio() {
    const vol = Math.max(0, Math.min(1, (wheelConfig.musicVolume ?? 50) / 100));
    if (!spinAudioEl) {
      spinAudioEl = new Audio("/assets/audio/wheel-spin.mp3");
      spinAudioEl.loop = true;
    }
    spinAudioEl.volume = vol;
    spinAudioEl.currentTime = 0;
    const p = spinAudioEl.play();
    if (p && p.catch) {
      p.catch(() => {
        spinAudioEl = null;
        startSpinFallback(vol);
      });
    }
  }

  function startSpinFallback(vol) {
    stopSpinFallback();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const gain = ctx.createGain();
    gain.gain.value = vol;
    gain.connect(ctx.destination);

    const timer = setInterval(() => {
      const time = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = 170;
      g.gain.setValueAtTime(0.14, time);
      g.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
      osc.connect(g).connect(gain);
      osc.start(time);
      osc.stop(time + 0.05);
    }, 90);

    spinFallback = { ctx, gain, timer };
  }

  function stopSpinFallback() {
    if (spinFallback) {
      clearInterval(spinFallback.timer);
      if (spinFallback.ctx) spinFallback.ctx.close().catch(() => {});
      spinFallback = null;
    }
  }

  function stopSpinAudio() {
    if (spinAudioEl) {
      try { spinAudioEl.pause(); spinAudioEl.currentTime = 0; } catch {}
      spinAudioEl = null;
    }
    stopSpinFallback();
  }

  function playWinSound() {
    try {
      const a = new Audio("/assets/audio/win.mp3");
      a.volume = 0.9;
      const p = a.play();
      if (p && p.catch) p.catch(() => playFanfare());
    } catch {
      playFanfare();
    }
  }

  function playEliminationAudio() {
    try {
      const a = new Audio("/assets/audio/elimination.mp3");
      a.volume = 0.9;
      const p = a.play();
      if (p && p.catch) p.catch(() => playEliminationSound());
    } catch {
      playEliminationSound();
    }
  }

  connect();
})();
