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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let ws;
  let wheelSectors = [];
  let wheelRotation = 0;
  let wheelSpinning = false;
  let wheelConfig = { musicVolume: 50, x: 960, y: 540 };
  let wheelSpeedConfig = { speed: 3 };
  let resultTimer = null;
  let participantsConfig = { maxNames: 10, marquee: false, fontSize: 16, textColor: "#e8e1f0", backgroundOpacity: 82, x: 24, y: 340, w: 340, h: 400 };
  let participantsState = { count: 0, participants: [] };
  let spinAudioEl = null;
  let spinFallback = null;

  // Длительность wheel-spin.mp3 (roulettevision) в мс — вращение подгоняется под неё.
  const WHEEL_SPIN_MS = 5300;

  // ---------------- theme ----------------

  function applyTheme(appearance) {
    if (!appearance || !appearance.tokens) return;
    const root = document.documentElement;
    Object.entries(appearance.tokens).forEach(([k, v]) => root.style.setProperty(k, v));
    document.body.dataset.decoration = appearance.tokens["--panel-decoration"] || "none";
    document.body.dataset.theme = appearance.activeThemeId || "";
    if (wheelSectors.length) drawWheel();
  }

  // ---------------- wheel ----------------

  function showWheel(sectors) {
    wheelSectors = Array.isArray(sectors) ? sectors : [];
    const wheelEl = document.getElementById("wheel");
    wheelEl.hidden = wheelSectors.length === 0;
    if (!wheelSectors.length) {
      return;
    }
    wheelRotation = 0;
    wheelSpinning = false;
    resizeWheel();
    applyWheelLayout();
    drawWheel();
  }

  function resizeWheel() {
    const wheelEl = document.getElementById("wheel");
    if (!wheelEl) return;
    const base = 640;
    const pad = 48;
    const s = Math.max(0.32, Math.min(1.15, (Math.min(window.innerWidth, window.innerHeight) - pad) / base));
    wheelEl.style.setProperty("--wheel-scale", String(s));
  }

  function applyWheelLayout() {
    const wheelEl = document.getElementById("wheel");
    if (!wheelEl) return;
    wheelEl.style.left = (wheelConfig.x ?? 960) + "px";
    wheelEl.style.top = (wheelConfig.y ?? 540) + "px";
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

  function truncate(s, max) {
    const str = String(s || "");
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
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
      ctx.font = "600 15px " + (readCssVar("--font-body") || "Manrope, sans-serif");
      ctx.fillText(truncate(wheelSectors[i], 18), r - 14, 6);
      ctx.restore();
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
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      wheelRotation = startRotation + (target - startRotation) * eased;
      drawWheel();
      if (spinFallback) {
        const spinFade = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
        setSpinVolume(((wheelConfig.musicVolume ?? 50) / 100) * spinFade);
      }
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

  // ---------------- participants panel ----------------

  function renderParticipants() {
    const el = document.getElementById("wheel-participants");
    if (!el) return;
    const count = participantsState.count || 0;
    const all = participantsState.participants || [];

    el.style.setProperty("--pw-font-size", participantsConfig.fontSize + "px");
    el.style.setProperty("--pw-text", participantsConfig.textColor);
    el.style.setProperty("--pw-bg-opacity", participantsConfig.backgroundOpacity + "%");
    el.style.left = (participantsConfig.x ?? 24) + "px";
    el.style.top = (participantsConfig.y ?? 340) + "px";
    el.style.width = (participantsConfig.w ?? 340) + "px";
    el.style.height = (participantsConfig.h ?? 400) + "px";

    if (!count) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;

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

    el.innerHTML = `
      <div class="widget-participants__title">${t("wheelScene.participantsTitle", { count })}</div>
      ${listHtml}`;
  }

  // ---------------- winner result + audio --------------

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

  function playWinSound() {
    try {
      const a = new Audio("/assets/audio/win.wav");
      a.volume = 0.9;
      const p = a.play();
      if (p && p.catch) p.catch(() => playFanfare());
    } catch {
      playFanfare();
    }
  }

  function playEliminationAudio() {
    try {
      const a = new Audio("/assets/audio/elimination.wav");
      a.volume = 0.9;
      const p = a.play();
      if (p && p.catch) p.catch(() => playEliminationSound());
    } catch {
      playEliminationSound();
    }
  }

  function showWinnerResult(alert) {
    const el = document.getElementById("wheel-result");
    if (!el) return;

    let text = "";
    if (alert.isElimination) {
      text = t("alert.eliminated", { name: escapeHtml(alert.user || "") });
      playEliminationAudio();
    } else if (alert.isFinalWinner) {
      text = t("alert.finalWinner", { name: escapeHtml(alert.user || "") });
      playWinSound();
    } else {
      text = t("alert.winner", { name: escapeHtml(alert.user || "") });
      playWinSound();
    }

    el.innerHTML = text;
    el.hidden = false;
    el.classList.remove("is-showing");
    void el.offsetWidth;
    el.classList.add("is-showing");

    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => {
      el.classList.remove("is-showing");
      el.hidden = true;
    }, alert.durationMs || 8000);
  }

  // ---------------- socket ----------------

  function send(type, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE:
        applyTheme(msg.payload.appearance);
        if (msg.payload.giveaway) {
          participantsState = {
            count: msg.payload.giveaway.count || 0,
            participants: Array.isArray(msg.payload.giveaway.participants) ? msg.payload.giveaway.participants : [],
          };
        }
        renderParticipants();
        break;
      case EVENT_TYPES.THEME_UPDATE:
        applyTheme(msg.payload);
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
        renderParticipants();
        break;
      case EVENT_TYPES.OVERLAY_PARTICIPANTS_CONFIG:
        participantsConfig = (msg.payload && msg.payload.config) || participantsConfig;
        renderParticipants();
        break;
      case EVENT_TYPES.WHEEL_CONFIG:
        wheelConfig = (msg.payload && msg.payload.config) || wheelConfig;
        applyWheelLayout();
        break;
      case EVENT_TYPES.WHEEL_SPEED_CONFIG:
        wheelSpeedConfig = (msg.payload && msg.payload.config) || wheelSpeedConfig;
        break;
      case EVENT_TYPES.LOCALES:
        if (window.I18n) {
          window.I18n.setLocales(msg.payload && msg.payload.locales);
          window.I18n.setLang(msg.payload && msg.payload.lang);
          window.I18n.apply();
        }
        renderParticipants();
        break;
      case EVENT_TYPES.ALERT:
        if (msg.payload && msg.payload.kind === "wheel_winner") showWinnerResult(msg.payload);
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

  connect();
})();
