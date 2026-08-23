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

/*
  Overlay composition root.

  Responsibilities (and nothing else):
    * own the WebSocket connection and turn incoming frames into typed bus events
      (Twitch / YouTube / OBS data arrives here — the data layer is untouched);
    * hold the shared mutable `state` that widgets read;
    * own the WidgetManager, which reconciles the layout into BaseWidget instances;
    * keep the overlay "chrome" that is not a widget: the giveaway wheel and the
      alert/winner audio helpers.

  Widgets live in ./widgets/*.js and communicate only through the EventBus.
*/
(function () {
  "use strict";

  const { EVENT_TYPES } = window.SharedEvents;
  const { ICONS } = window.SharedIcons;
  const { WIDGET_TYPES } = window.WidgetCatalog || {};
  const t = (key, params) => (window.I18n ? window.I18n.t(key, params) : key);
  const renderEmotes =
    window.TwitchEmotes && window.TwitchEmotes.renderEmotes
      ? window.TwitchEmotes.renderEmotes.bind(window.TwitchEmotes)
      : (msg) => escapeHtml(msg);

  const canvas = document.getElementById("canvas");
  const bus = new window.OSEWidgets.EventBus();

  // ---- shared mutable state (widgets read from here via context.state) ----
  const state = {
    goal: { title: "Цель", current: 0, target: 1, currency: "RUB" },
    recentEvents: [],
    stats: { followerCount: null, subscriberCount: null },
    topDonation: { user: "", amount: 0, currency: "RUB" },
    deathCount: 0,
    soundboardConfig: { volume: 0.8, queueMode: false },
    participantsState: { count: 0, participants: [] },
    participantsConfig: { maxNames: 10, marquee: false, fontSize: 16, textColor: "#e8e1f0", backgroundOpacity: 82 },
    micConfig: { sensitivity: 1.5, lineWidth: 2, color: "", opacity: 0.9, visualizer_mode: "sine", barCount: 32, barGap: 2, peakFall: 2.5 },
    remoteMicData: null,
  };

  let ws;

  // ---- wheel (overlay chrome, not a widget) ----
  let wheelSectors = [];
  let wheelRotation = 0;
  let wheelSpinning = false;
  let wheelVisible = false;
  let wheelConfig = { musicVolume: 50, x: 960, y: 540 };
  let wheelSpeedConfig = { speed: 3 };
  let spinAudioEl = null;
  let spinFallback = null;

  // Длительность wheel-spin.mp3 (roulettevision) в мс — вращение подгоняется под неё.
  const WHEEL_SPIN_MS = 5300;

  // ---- pure utils ----
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
  function resolveMediaUrl(path) {
    if (!path) return "";
    if (/^(https?:)?\/\//i.test(path)) return path;
    return "/" + String(path).replace(/^\/+/, "");
  }
  function readCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ---- alert / winner audio helpers ----
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
        const time = ctx.currentTime + i * 0.14;
        gain.gain.setValueAtTime(0.0001, time);
        gain.gain.exponentialRampToValueAtTime(0.22, time + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(time);
        osc.stop(time + 0.55);
      });
      setTimeout(() => ctx.close().catch(() => {}), 1700);
    } catch (_) {
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
    } catch (_) {
      /* audio unavailable */
    }
  }

  function playWinSound() {
    try {
      const a = new Audio("/assets/audio/win.wav");
      a.volume = 0.9;
      const p = a.play();
      if (p && p.catch) p.catch(() => playFanfare());
    } catch (_) {
      playFanfare();
    }
  }

  function playEliminationAudio() {
    try {
      const a = new Audio("/assets/audio/elimination.wav");
      a.volume = 0.9;
      const p = a.play();
      if (p && p.catch) p.catch(() => playEliminationSound());
    } catch (_) {
      playEliminationSound();
    }
  }

  // ---- wheel helpers ----
  function shade(hex, amt) {
    const h = String(hex || "").replace("#", "");
    const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
    const n = parseInt(full, 16);
    if (Number.isNaN(n)) return "#888";
    let r = (n >> 16) & 255;
    let g = (n >> 8) & 255;
    let b = n & 255;
    const target = amt < 0 ? 0 : 255;
    const p = Math.abs(amt);
    r = Math.round((target - r) * p + r);
    g = Math.round((target - g) * p + g);
    b = Math.round((target - b) * p + b);
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

  function truncate(s, max) {
    const str = String(s || "");
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
  }

  function resizeWheel() {
    const wheelEl = document.getElementById("wheel");
    if (!wheelEl) return;
    const base = 640;
    const pad = 48;
    const scale = Math.max(0.32, Math.min(1.15, (Math.min(window.innerWidth, window.innerHeight) - pad) / base));
    wheelEl.style.setProperty("--wheel-scale", String(scale));
  }

  function applyWheelLayout() {
    const wheelEl = document.getElementById("wheel");
    if (!wheelEl) return;
    wheelEl.style.left = (wheelConfig.x ?? 960) + "px";
    wheelEl.style.top = (wheelConfig.y ?? 540) + "px";
  }

  function drawWheel() {
    const wheelCanvas = document.getElementById("wheelCanvas");
    if (!wheelCanvas) return;
    const ctx = wheelCanvas.getContext("2d");
    const w = wheelCanvas.width;
    const h = wheelCanvas.height;
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
      ctx.font = "600 15px Manrope, sans-serif";
      ctx.fillText(truncate(wheelSectors[i], 18), r - 14, 6);
      ctx.restore();
    }
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
    const duration = WHEEL_SPIN_MS;

    function frame(now) {
      const progress = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
      wheelRotation = startRotation + (target - startRotation) * eased;
      drawWheel();
      if (spinFallback) {
        const spinFade = progress < 0.7 ? 1 : Math.max(0, 1 - (progress - 0.7) / 0.3);
        setSpinVolume(((wheelConfig.musicVolume ?? 50) / 100) * spinFade);
      }
      if (progress < 1) {
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

  function showWheel(sectors) {
    wheelSectors = Array.isArray(sectors) ? sectors : [];
    wheelVisible = wheelSectors.length > 0;
    const wheelEl = document.getElementById("wheel");
    wheelEl.hidden = !wheelVisible;
    bus.emit("wheel_visibility", { visible: wheelVisible });
    if (!wheelVisible) return;
    wheelRotation = 0;
    wheelSpinning = false;
    resizeWheel();
    applyWheelLayout();
    drawWheel();
  }

  function setSpinVolume(v) {
    if (spinAudioEl) spinAudioEl.volume = v;
    if (spinFallback && spinFallback.gain) spinFallback.gain.gain.value = v;
  }

  function startSpinAudio() {
    const vol = Math.max(0, Math.min(1, (wheelConfig.musicVolume ?? 50) / 100));
    if (!spinAudioEl) {
      spinAudioEl = new Audio("/assets/audio/wheel-spin.mp3");
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
      try {
        spinAudioEl.pause();
        spinAudioEl.currentTime = 0;
      } catch (_) {
        /* ignore */
      }
      spinAudioEl = null;
    }
    stopSpinFallback();
  }

  // ---- shared widget context (theme is updated in applyTheme) ----
  const context = {
    bus,
    EVENT_TYPES,
    state,
    t,
    ICONS,
    renderEmotes,
    escapeHtml,
    escapeAttr,
    formatMoney,
    currencySymbol,
    resolveMediaUrl,
    readCssVar,
    audio: { playWinSound, playEliminationAudio },
    theme: "nebula",
  };

  // Current layout, kept so a theme change can re-run syncLayout (and thus
  // re-evaluate shouldMount/resolveRenderType) without a fresh STATE frame.
  let currentLayout = [];

  // ---- theme ----
  function applyTheme(appearance) {
    if (!appearance || !appearance.tokens) return;
    const root = document.documentElement;
    Object.entries(appearance.tokens).forEach(([k, v]) => root.style.setProperty(k, v));
    document.body.dataset.decoration = appearance.tokens["--panel-decoration"] || "none";
    document.body.dataset.theme = appearance.activeThemeId || "";
    // `context.theme` gates the 3D (Star Citizen) widgets only. When the 3D
    // theme is active the global tokens above are already the Star Citizen
    // HUD token set (3D overrides the base 2D theme), so 2D and 3D widgets
    // share one coherent look.
    context.theme = appearance.activeThemeId3d || "";
    context.activeThemeId = appearance.activeThemeId || "";
    if (wheelSectors.length) drawWheel();
  }

  // ---- render mode + theme isolation -------
  // A widget may declare a `theme` in the catalog; 3D widgets are bound to their
  // theme and render on a canvas only while that theme is active. Everything
  // else is plain 2D DOM/CSS (zero GPU in idle).
  function widgetDef(item) {
    return (WIDGET_TYPES && WIDGET_TYPES[item && item.type]) || null;
  }

  function resolveRenderType(item) {
    const def = widgetDef(item);
    const theme = def && def.theme ? def.theme : null;
    if (theme && context.theme === theme) return def.renderType || "canvas";
    return "2d";
  }

  // Manager-level guard: a theme-bound widget is only created for its theme.
  function shouldMount(item) {
    const def = widgetDef(item);
    const theme = def && def.theme ? def.theme : null;
    if (theme) return context.theme === theme;
    return true;
  }

  // ---- widget manager ----
  const OW = window.OSEWidgets;
  const manager = new OW.WidgetManager(canvas, {
    resolveRenderType,
    shouldMount,
    context,
  });

  manager.register("alerts", OW.AlertsWidget);
  manager.register("goal", OW.GoalWidget);
  manager.register("chat", OW.ChatWidget);
  manager.register("recent", OW.RecentWidget);
  manager.register("stat", OW.StatWidget);
  manager.register("social", OW.SocialWidget);
  manager.register("participants", OW.ParticipantsWidget);
  manager.register("mic", OW.MicWidget);
  manager.register("death", OW.DeathWidget);
  manager.register("soundboard", OW.SoundboardWidget);
  manager.register("custom", OW.CustomWidget);
  manager.register("grimhex", OW.WidgetGrimHex);
  manager.register("musain", OW.WidgetMusain);
  manager.register("grimhex-chat", OW.WidgetStarCitizenChat);
  manager.register("grimhex-goal", OW.WidgetStarCitizenGoal);
  manager.register("grimhex-holo-alert", OW.WidgetStarCitizenHoloAlert);
  manager.register("nuclear", OW.WidgetNuclear);
  manager.register("nuclear-chat", OW.WidgetNuclearChat);
  manager.register("nuclear-goal", OW.WidgetNuclearGoal);
  manager.register("nuclear-holo-alert", OW.WidgetNuclearHoloAlert);
  manager.register("cobra", OW.WidgetCobra);
  manager.register("cobra-chat", OW.WidgetCobraChat);
  manager.register("cobra-goal", OW.WidgetCobraGoal);
  manager.register("cobra-holo-alert", OW.WidgetCobraHoloAlert);
  manager.register("cobra-shield", OW.WidgetCobraShield);
  manager.register("cobra-radar", OW.WidgetCobraRadar);

  // ---- socket ----
  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE: {
        const p = msg.payload || {};
        state.goal = p.goal || state.goal;
        state.recentEvents = p.recentEvents || [];
        state.stats = p.stats || state.stats;
        state.topDonation = p.topDonation || state.topDonation;
        state.deathCount = p.deathCount || 0;
        state.soundboardConfig = p.soundboard || state.soundboardConfig;
        if (p.giveaway) {
          state.participantsState = {
            count: p.giveaway.count || 0,
            participants: Array.isArray(p.giveaway.participants) ? p.giveaway.participants : [],
          };
        }
        currentLayout = p.layout || [];
        applyTheme(p.appearance);
        manager.syncLayout(currentLayout);
        break;
      }
      case EVENT_TYPES.LAYOUT_UPDATE:
        currentLayout = (msg.payload && msg.payload.layout) || [];
        manager.syncLayout(currentLayout);
        break;
      case EVENT_TYPES.THEME_UPDATE:
        applyTheme(msg.payload);
        manager.syncLayout(currentLayout);
        break;
      case EVENT_TYPES.STAT_UPDATE:
        state.stats = msg.payload || state.stats;
        bus.emit(EVENT_TYPES.STAT_UPDATE, msg.payload);
        break;
      case EVENT_TYPES.DEATH_COUNT_UPDATE:
        state.deathCount = (msg.payload && msg.payload.count) || 0;
        bus.emit(EVENT_TYPES.DEATH_COUNT_UPDATE, msg.payload);
        break;
      case EVENT_TYPES.TOP_DONATION_UPDATE:
        state.topDonation = msg.payload || state.topDonation;
        bus.emit(EVENT_TYPES.TOP_DONATION_UPDATE, msg.payload);
        break;
      case EVENT_TYPES.ALERT:
        bus.emit(EVENT_TYPES.ALERT, msg.payload);
        break;
      case EVENT_TYPES.CHAT_MESSAGE:
        bus.emit(EVENT_TYPES.CHAT_MESSAGE, msg.payload);
        break;
      case EVENT_TYPES.SOUNDBOARD_PLAY:
        bus.emit(EVENT_TYPES.SOUNDBOARD_PLAY, msg.payload);
        break;
      case EVENT_TYPES.RECENT_EVENT:
        state.recentEvents = [msg.payload, ...state.recentEvents].slice(0, 15);
        bus.emit(EVENT_TYPES.RECENT_EVENT, msg.payload);
        break;
      case EVENT_TYPES.GOAL_UPDATE:
        state.goal = msg.payload || state.goal;
        bus.emit(EVENT_TYPES.GOAL_UPDATE, msg.payload);
        break;
      case EVENT_TYPES.GIVEAWAY_WHEEL:
        showWheel((msg.payload && msg.payload.sectors) || []);
        break;
      case EVENT_TYPES.GIVEAWAY_SPIN:
        spinWheel((msg.payload && msg.payload.winner) || null);
        break;
      case EVENT_TYPES.GIVEAWAY_PARTICIPANTS:
        state.participantsState = {
          count: (msg.payload && msg.payload.count) || 0,
          participants: Array.isArray(msg.payload && msg.payload.participants) ? msg.payload.participants : [],
        };
        bus.emit(EVENT_TYPES.GIVEAWAY_PARTICIPANTS, msg.payload);
        break;
      case EVENT_TYPES.OVERLAY_PARTICIPANTS_CONFIG:
        state.participantsConfig = (msg.payload && msg.payload.config) || state.participantsConfig;
        bus.emit(EVENT_TYPES.OVERLAY_PARTICIPANTS_CONFIG, msg.payload);
        break;
      case EVENT_TYPES.WHEEL_CONFIG:
        wheelConfig = (msg.payload && msg.payload.config) || wheelConfig;
        applyWheelLayout();
        break;
      case EVENT_TYPES.WHEEL_SPEED_CONFIG:
        wheelSpeedConfig = (msg.payload && msg.payload.config) || wheelSpeedConfig;
        break;
      case EVENT_TYPES.OVERLAY_MIC_CONFIG:
        state.micConfig = (msg.payload && msg.payload.config) || state.micConfig;
        bus.emit(EVENT_TYPES.OVERLAY_MIC_CONFIG, msg.payload);
        break;
      case EVENT_TYPES.MIC_AUDIO_DATA:
        state.remoteMicData = msg.payload || null;
        break;
      case EVENT_TYPES.LOCALES:
        if (window.I18n) {
          window.I18n.setLocales(msg.payload && msg.payload.locales);
          window.I18n.setLang(msg.payload && msg.payload.lang);
          window.I18n.apply();
        }
        bus.emit(EVENT_TYPES.LOCALES, msg.payload);
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
      } catch (_) {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws.close();
  }

  function send(type, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
  }

  window.addEventListener("resize", resizeWheel);
  connect();
})();
