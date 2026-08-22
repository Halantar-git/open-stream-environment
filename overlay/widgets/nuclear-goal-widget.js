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
  WidgetNuclearGoal — donation goal as a five-segment radioactive bar for the
  Nuclear theme.

  Each segment is a dim lead-glass tube while empty and turns glowing
  radioactive green as it fills, like a bank of reactor-core charge cells. The
  fill is smoothed and driven only by the goal state (never by chat): the
  widget subscribes to GOAL_UPDATE / LOCALES and runs a self-contained flicker.

  The background matches the Recent events widget: a filled panel surface
  (var(--panel-bg) + border + radius + shadow), with no neon HUD frame.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetNuclearGoal = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetNuclearGoal;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetNuclearGoal = WidgetNuclearGoal;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const SECTOR_COUNT = 5;
  const GREEN = "#39ff14"; // filled sector (green accent)
  const TRACK = "#0d100e"; // empty sector (neutral metal)
  const TRACK_EDGE = "#242a26";

  // Terminal monospace (matching the Nuclear theme tokens).
  const FONT_DISPLAY = "'IBM Plex Mono', 'JetBrains Mono', 'Consolas', monospace";
  const FONT_MONO = "'IBM Plex Mono', 'JetBrains Mono', 'Consolas', monospace";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  class WidgetNuclearGoal extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.canvas = null; // bar canvas
      this.ctx = null;
      this.layoutEl = null;
      this.contentEl = null;
      this.barWrap = null;

      this._pct = 0; // target progress (from goal state)
      this._displayPct = 0; // smoothed progress
      this._nextFlickerAt = 0;
      this._flickerUntil = 0;
    }

    // The bar animates even though the root element is a <div> (2D).
    _isAnimated() {
      return true;
    }

    onMount() {
      // HARD theme gate: no canvas, no loop, no events on a non-nuclear theme.
      if (this.theme !== "nuclear") return;

      // Inner flex layout (keeps the BaseWidget geometry untouched).
      this.layoutEl = document.createElement("div");
      this.layoutEl.className = "nuclear-goal";
      this.layoutEl.style.cssText =
        "position:absolute;inset:0;display:flex;flex-direction:column;box-sizing:border-box;padding:12px 14px;";
      this.element.appendChild(this.layoutEl);

      // Title + amounts row.
      this.contentEl = document.createElement("div");
      this.contentEl.className = "nuclear-goal__content";
      this.contentEl.style.cssText =
        "display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-shrink:0;padding:0 4px;";
      this.layoutEl.appendChild(this.contentEl);

      // Bar area (canvas fills it).
      this.barWrap = document.createElement("div");
      this.barWrap.className = "nuclear-goal__bar";
      this.barWrap.style.cssText = "position:relative;flex:1;min-height:0;";
      this.layoutEl.appendChild(this.barWrap);

      this.canvas = document.createElement("canvas");
      this.canvas.className = "nuclear-goal__canvas";
      Object.assign(this.canvas.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
      });
      this.barWrap.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");

      // Scanlines/hazard stripes driven by the active theme's --panel-decoration
      // token (same decoration language as the Recent events widget).
      this.element.classList.add("nuclear-goal-surface");
      this._applySurface();
      this._updateDom();
      this._nextFlickerAt = performance.now() + 1500 + Math.random() * 2500;

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.GOAL_UPDATE, () => this._updateDom());
      this.subscribe(EVENT_TYPES.LOCALES, () => this._updateDom());

      this.startRenderLoop(30); // strictly 30 FPS
    }

    onUnmount() {
      this._flickerUntil = 0;
      if (this.element) this.element.innerHTML = "";
      this.layoutEl = null;
      this.contentEl = null;
      this.barWrap = null;
      this.ctx = null;
      this.canvas = null;
    }

    // React to config/layout patches pushed through update() (e.g. the
    // "Показывать %" and "Фон" toggles in the inspector).
    onUpdate(prev, next) {
      if (prev.showPercentage !== next.showPercentage) this._updateDom();
      if (prev.showBackground !== next.showBackground) this._applySurface();
    }

    // Panel surface matching the Recent events widget. Cleared entirely when
    // showBackground is false.
    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      if (this.config.showBackground === false) {
        s.backgroundColor = "transparent";
        s.backgroundImage = "none";
        s.backdropFilter = "none";
        s.webkitBackdropFilter = "none";
        s.border = "none";
        s.borderRadius = "0";
        s.clipPath = "none";
        s.boxShadow = "none";
        return;
      }

      const bg = (read && read("--panel-bg")) || "rgba(13, 16, 14, 0.92)";
      const blur = (read && read("--panel-blur")) || "0px";
      const border = (read && read("--panel-border")) || "1px solid rgba(167, 173, 168, 0.18)";
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow =
        (read && read("--panel-glow")) ||
        "0 8px 24px rgba(0, 0, 0, 0.5)";

      s.backgroundColor = bg;
      s.backgroundImage = "";
      s.backdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.webkitBackdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.border = border;
      s.borderRadius = radius;
      s.clipPath = clip;
      s.boxShadow = `${elev}, ${glow}`;
    }

    // ---- data -> DOM ----

    _updateDom() {
      if (!this.contentEl) return;
      const { escapeHtml, formatMoney, currencySymbol, t, state } = this.context;
      const goal = (state && state.goal) || {};
      const pct = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
      this._pct = pct;

      const pctStr = this.config.showPercentage
        ? `<span style="color:${GREEN};"> ${pct}%</span>`
        : "";

      this.contentEl.innerHTML =
        `<span style="color:#a7ada8;font-family:${FONT_DISPLAY};font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(goal.title || t("preview.goalTitle"))}</span>` +
        `<span style="color:#59615b;font-family:${FONT_MONO};font-size:12px;white-space:nowrap;"><b style="color:${GREEN};">${formatMoney(goal.current)}</b> / ${formatMoney(goal.target)} ${escapeHtml(currencySymbol(goal.currency))}${pctStr}</span>`;
    }

    // ---- rendering ----

    render() {
      if (this.theme !== "nuclear") return;

      const now = performance.now();
      const t = now / 1000;

      // --- Flicker State Machine (drives the radioactive sectors) ---
      if (now >= this._nextFlickerAt) {
        this._flickerUntil = now + 100 + Math.random() * 180;
        this._nextFlickerAt = now + 1800 + Math.random() * 2800;
      }
      let flicker = 0.85 + 0.15 * Math.sin(t * 2.2) * Math.sin(t * 1.1);
      if (now < this._flickerUntil) flicker *= 0.4 + 0.6 * Math.abs(Math.sin(now * 0.06));
      flicker = clamp(flicker, 0.15, 1);

      this._drawBarLayer(flicker);
    }

    _drawBarLayer(flicker) {
      const ctx = this.ctx;
      if (!ctx || !this.canvas) return;

      const cw = this.canvas.clientWidth || 300;
      const ch = this.canvas.clientHeight || 40;
      const dpr = window.devicePixelRatio || 1;

      const bw = Math.max(1, Math.round(cw * dpr));
      const bh = Math.max(1, Math.round(ch * dpr));
      if (this.canvas.width !== bw || this.canvas.height !== bh) {
        this.canvas.width = bw;
        this.canvas.height = bh;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      // Smoothly approach the target progress on each donation.
      this._displayPct += (this._pct - this._displayPct) * 0.08;
      const pct = clamp(this._displayPct, 0, 100);

      // Five equal sectors with a small gap between them.
      const pad = 6;
      const gap = 4;
      const x = pad;
      const y = pad;
      const w = Math.max(1, cw - pad * 2);
      const h = Math.max(1, ch - pad * 2);
      const sectorW = Math.max(1, (w - gap * (SECTOR_COUNT - 1)) / SECTOR_COUNT);

      for (let i = 0; i < SECTOR_COUNT; i++) {
        const sx = x + i * (sectorW + gap);
        const segStart = (i * 100) / SECTOR_COUNT;
        const segSize = 100 / SECTOR_COUNT;
        const fill = clamp((pct - segStart) / segSize, 0, 1);
        this._drawSector(ctx, sx, y, sectorW, h, fill, flicker);
      }
    }

    _drawSector(ctx, x, y, w, h, fill, flicker) {
      const r = Math.min(4, h / 2);

      // Dim lead-glass base (empty).
      ctx.save();
      ctx.fillStyle = TRACK;
      ctx.shadowColor = TRACK_EDGE;
      ctx.shadowBlur = 3 * flicker;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fill();
      ctx.restore();

      if (fill <= 0.01) return;

      const fw = Math.max(r * 2, w * fill);

      // Radioactive green fill (from the left), uniform colour.
      ctx.save();
      ctx.fillStyle = GREEN;
      ctx.shadowColor = GREEN;
      ctx.shadowBlur = 14 * flicker;
      ctx.globalAlpha = fill;
      ctx.beginPath();
      ctx.roundRect(x, y, fw, h, r);
      ctx.fill();
      ctx.restore();
    }
  }

  return WidgetNuclearGoal;
});
