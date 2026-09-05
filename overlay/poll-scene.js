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
  Poll scene — full-screen chat voting diagram (bars or pie).

  Viewers vote in chat with "<command> <N>" (e.g. "!poll 2"). The scene
  subscribes to the shared WebSocket and re-renders live on every vote.
*/
(function () {
  const { EVENT_TYPES } = window.SharedEvents;
  const t = (key, params) => (window.I18n ? window.I18n.t(key, params) : key);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let ws;
  let poll = { active: false, command: "!poll", chartType: "bars", options: [], votes: {}, total: 0 };

  // ---------------- theme ----------------

  function applyTheme(appearance) {
    if (!appearance || !appearance.tokens) return;
    const root = document.documentElement;
    Object.entries(appearance.tokens).forEach(([k, v]) => root.style.setProperty(k, v));
    document.body.dataset.decoration = appearance.tokens["--panel-decoration"] || "none";
    document.body.dataset.theme = appearance.activeThemeId || "";
    renderPoll();
  }

  function readCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ---------------- palette ----------------

  function palette() {
    const pairs = [
      ["--md-primary", "--md-primary-container"],
      ["--md-secondary", "--md-secondary-container"],
      ["--md-tertiary", "--md-tertiary-container"],
      ["--md-error", "--md-error-container"],
    ];
    return pairs.map(([fg]) => readCssVar(fg) || "#888888");
  }

  function optionVotes() {
    return (poll.options || []).map((o) => ({
      id: o.id,
      label: o.label,
      count: (poll.votes && poll.votes[o.id]) || 0,
    }));
  }

  // ---------------- render ----------------

  function renderPoll() {
    const root = document.getElementById("poll");
    const chartEl = document.getElementById("pollChart");
    const statusEl = document.getElementById("pollStatus");
    const titleEl = document.getElementById("pollTitle");
    const footerEl = document.getElementById("pollFooter");
    if (!root || !chartEl) return;

    const options = optionVotes();
    if (!options.length) {
      root.hidden = true;
      return;
    }
    root.hidden = false;

    if (titleEl) titleEl.textContent = t("poll.title");
    if (statusEl) statusEl.textContent = poll.active ? t("poll.live") : t("poll.waiting");
    root.classList.toggle("is-live", !!poll.active);

    if (poll.chartType === "pie") {
      chartEl.innerHTML = "";
      drawPie(chartEl, options);
    } else {
      drawBars(chartEl, options);
    }

    if (footerEl) {
      const total = poll.total || 0;
      footerEl.innerHTML = `
        <span class="poll__command">${escapeHtml(poll.command || "!poll")} <span>1…${options.length}</span></span>
        <span class="poll__total">${t("poll.total", { count: total })}</span>`;
    }
  }

  function drawBars(chartEl, options) {
    const colors = palette();
    const total = options.reduce((sum, o) => sum + o.count, 0);
    const rows = options
      .map((o, i) => {
        const pct = total ? (o.count / total) * 100 : 0;
        const color = colors[i % colors.length];
        return `
          <div class="poll-bar">
            <div class="poll-bar__head">
              <span class="poll-bar__label">${escapeHtml(o.label)}</span>
              <span class="poll-bar__count">${o.count} · ${Math.round(pct)}%</span>
            </div>
            <div class="poll-bar__track">
              <div class="poll-bar__fill" style="width:${Math.max(0, pct)}%;background:${color}"></div>
            </div>
          </div>`;
      })
      .join("");
    chartEl.innerHTML = `<div class="poll-bars">${rows}</div>`;
  }

  function drawPie(chartEl, options) {
    const colors = palette();
    const total = options.reduce((sum, o) => sum + o.count, 0);

    const canvas = document.createElement("canvas");
    canvas.width = 440;
    canvas.height = 440;
    const ctx = canvas.getContext("2d");
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const r = Math.min(cx, cy) - 8;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!total) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = readCssVar("--md-surface-container-highest") || "#333";
      ctx.fill();
    } else {
      let start = -Math.PI / 2;
      options.forEach((o, i) => {
        const angle = (o.count / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, start, start + angle);
        ctx.closePath();
        ctx.fillStyle = colors[i % colors.length];
        ctx.fill();
        start += angle;
      });
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = readCssVar("--md-surface-container") || "#1b1826";
      ctx.fill();
      ctx.fillStyle = readCssVar("--md-on-surface") || "#fff";
      ctx.font = "700 54px " + (readCssVar("--font-mono") || "'JetBrains Mono', 'IBM Plex Mono', monospace");
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(total), cx, cy);
    }

    const legend = options
      .map((o, i) => {
        const pct = total ? Math.round((o.count / total) * 100) : 0;
        const color = colors[i % colors.length];
        return `
          <div class="poll-legend">
            <span class="poll-legend__dot" style="background:${color}"></span>
            <span class="poll-legend__label">${escapeHtml(o.label)}</span>
            <span class="poll-legend__count">${o.count} (${pct}%)</span>
          </div>`;
      })
      .join("");

    chartEl.innerHTML = `<div class="poll-pie"><div class="poll-pie__canvas"></div><div class="poll-pie__legend">${legend}</div></div>`;
    chartEl.querySelector(".poll-pie__canvas").appendChild(canvas);
  }

  // ---------------- socket ----------------

  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE:
        applyTheme(msg.payload.appearance);
        if (msg.payload.poll) {
          poll = msg.payload.poll;
          renderPoll();
        }
        break;
      case EVENT_TYPES.THEME_UPDATE:
        applyTheme(msg.payload);
        break;
      case EVENT_TYPES.POLL_UPDATE:
        if (msg.payload && msg.payload.poll) {
          poll = msg.payload.poll;
          renderPoll();
        }
        break;
      case EVENT_TYPES.LOCALES:
        if (window.I18n) {
          window.I18n.setLocales((msg.payload && msg.payload.locales) || {});
          window.I18n.setLang(msg.payload && msg.payload.lang);
          window.I18n.apply();
        }
        renderPoll();
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
