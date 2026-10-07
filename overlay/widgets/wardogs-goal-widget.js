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
  WidgetWardogsGoal — donation goal as the WARDOGS HUD progress/loading bar.

  The game's HUD readouts are flat and squared: a dark track divided into
  blocks, with a warm amber fill that grows toward a bright leading edge. This
  widget reuses that language — a segmented bar, an amber fill with a sweeping
  loading shimmer and a bright head line — and keeps the panel surface on the
  theme's own tokens (panel-bg/border/radius/glow), like the Recent events
  widget.

  The progress is driven only by the goal state (never by chat): the widget
  subscribes to GOAL_UPDATE / LOCALES and runs a self-contained render loop.
  It is bound to the Wardogs theme (see shared/themes.js) with a hard internal
  gate — no canvas, loop or subscriptions on any other theme.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetWardogsGoal = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetWardogsGoal;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetWardogsGoal = WidgetWardogsGoal;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  // Fallbacks repeat the Wardogs theme tokens (shared/themes.js) so the widget
  // still draws sensibly if the CSS variables are not applied yet.
  const FALLBACK = {
    primary: "#f0a92c",
    primaryContainer: "#7a4d00",
    onSurface: "#e8e5dd",
    onSurfaceVariant: "#b6b3a7",
  };
  const TRACK = "rgba(255, 255, 255, 0.08)"; // empty bar
  const DIVIDER = "rgba(0, 0, 0, 0.55)"; // segment separators over the fill
  const SEGMENT_PX = 26; // one divider roughly every 26px → HUD-style blocks

  // The HUD uses a narrow technical sans for labels and a mono for numbers.
  const FONT_DISPLAY = "'Rajdhani', 'Segoe UI', sans-serif";
  const FONT_MONO = "'JetBrains Mono', 'Consolas', monospace";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  class WidgetWardogsGoal extends BaseWidget {
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
    }

    // The bar animates even though the root element is a <div> (2D).
    _isAnimated() {
      return true;
    }

    // Live theme colours so the widget follows the Wardogs palette (including
    // a colour the streamer retuned in a custom theme based on it).
    _readColors() {
      const read = this.context.readCssVar;
      const get = (name, fallback) => (read && read(name)) || fallback;
      return {
        primary: get("--md-primary", FALLBACK.primary),
        primaryContainer: get("--md-primary-container", FALLBACK.primaryContainer),
        onSurface: get("--md-on-surface", FALLBACK.onSurface),
        onSurfaceVariant: get("--md-on-surface-variant", FALLBACK.onSurfaceVariant),
      };
    }

    onMount() {
      // HARD theme gate: no canvas, no loop, no events on a non-Wardogs theme.
      if (this.theme !== "wardogs") return;

      this.layoutEl = document.createElement("div");
      this.layoutEl.className = "wardogs-goal";
      this.layoutEl.style.cssText =
        "position:absolute;inset:0;display:flex;flex-direction:column;box-sizing:border-box;padding:12px 14px;";
      this.element.appendChild(this.layoutEl);

      // Title + amounts row, mirroring the game's cash readout.
      this.contentEl = document.createElement("div");
      this.contentEl.className = "wardogs-goal__content";
      this.contentEl.style.cssText =
        "display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-shrink:0;padding:0 2px;";
      this.layoutEl.appendChild(this.contentEl);

      // Bar area (canvas fills it).
      this.barWrap = document.createElement("div");
      this.barWrap.className = "wardogs-goal__bar";
      this.barWrap.style.cssText = "position:relative;flex:1;min-height:0;margin-top:6px;";
      this.layoutEl.appendChild(this.barWrap);

      this.canvas = document.createElement("canvas");
      this.canvas.className = "wardogs-goal__canvas";
      Object.assign(this.canvas.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
      });
      this.barWrap.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");

      this.element.classList.add("wardogs-surface");
      this._applySurface();
      this._updateDom();

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.GOAL_UPDATE, () => this._updateDom());
      this.subscribe(EVENT_TYPES.LOCALES, () => this._updateDom());

      this.startRenderLoop(30); // strictly 30 FPS
    }

    onUnmount() {
      if (this.element) this.element.innerHTML = "";
      this.layoutEl = null;
      this.contentEl = null;
      this.barWrap = null;
      this.ctx = null;
      this.canvas = null;
    }

    // React to config/layout patches pushed through update() (the "Показывать %"
    // and "Фон" toggles in the inspector).
    onUpdate(prev, next) {
      if (prev.showPercentage !== next.showPercentage) this._updateDom();
      if (prev.showBackground !== next.showBackground) this._applySurface();
    }

    // Panel surface matching the Recent events widget: filled panel, border,
    // radius and drop shadow/glow from the active theme. Cleared entirely when
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

      const bg = (read && read("--panel-bg")) || "rgba(18, 17, 14, 0.88)";
      const blur = (read && read("--panel-blur")) || "0px";
      const border = (read && read("--panel-border")) || `1px solid ${FALLBACK.primary}`;
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow = (read && read("--panel-glow")) || "0 0 12px rgba(240, 169, 44, 0.18)";

      // Set only backgroundColor so the scanline background-image from the HUD
      // decoration ([data-decoration]) can layer on top, like Recent events.
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
      const colors = this._readColors();
      const goal = (state && state.goal) || {};
      const pct = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
      this._pct = pct;

      const pctStr = this.config.showPercentage
        ? `<span style="color:${colors.primary};"> ${pct}%</span>`
        : "";

      this.contentEl.innerHTML =
        `<span style="color:${colors.onSurface};font-family:${FONT_DISPLAY};font-size:15px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(goal.title || t("preview.goalTitle"))}</span>` +
        `<span style="color:${colors.onSurfaceVariant};font-family:${FONT_MONO};font-size:12px;white-space:nowrap;"><b style="color:${colors.primary};">${formatMoney(goal.current)}</b> / ${formatMoney(goal.target)} ${escapeHtml(currencySymbol(goal.currency))}${pctStr}</span>`;
    }

    // ---- rendering ----

    render() {
      if (this.theme !== "wardogs") return;
      this._drawBarLayer(performance.now());
    }

    _drawBarLayer(now) {
      const ctx = this.ctx;
      if (!ctx || !this.canvas) return;

      const colors = this._readColors();
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

      const x = 0;
      const y = 0;
      const w = Math.max(1, cw);
      const h = Math.max(1, ch);
      const fillW = (w * pct) / 100;

      // Empty track (flat, squared corners).
      ctx.save();
      ctx.fillStyle = TRACK;
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.restore();

      if (fillW > 0.5) {
        // Amber fill, darker at the tail and bright at the head, with a soft
        // glow — the "loading" look of the HUD.
        const grad = ctx.createLinearGradient(x, y, x + fillW, y);
        grad.addColorStop(0, colors.primaryContainer);
        grad.addColorStop(1, colors.primary);
        ctx.save();
        ctx.fillStyle = grad;
        ctx.shadowColor = colors.primary;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.rect(x, y, fillW, h);
        ctx.fill();
        ctx.restore();

        // A sweeping shimmer band inside the filled part (loading animation).
        const period = 2200;
        const phase = (now % period) / period;
        const bandW = Math.max(24, fillW * 0.22);
        const bandX = x + (fillW + bandW) * phase - bandW;
        const band = ctx.createLinearGradient(bandX, y, bandX + bandW, y);
        band.addColorStop(0, "rgba(255, 255, 255, 0)");
        band.addColorStop(0.5, "rgba(255, 255, 255, 0.28)");
        band.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, fillW, h);
        ctx.clip();
        ctx.fillStyle = band;
        ctx.fillRect(bandX, y, bandW, h);
        ctx.restore();

        // Bright head line at the fill edge.
        ctx.save();
        ctx.fillStyle = colors.onSurface;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x + Math.max(0, fillW - 2), y, 2, h);
        ctx.restore();
      }

      // Segment dividers across the whole bar (HUD-style blocks).
      ctx.save();
      ctx.strokeStyle = DIVIDER;
      ctx.lineWidth = 1;
      for (let sx = SEGMENT_PX; sx < w; sx += SEGMENT_PX) {
        ctx.beginPath();
        ctx.moveTo(Math.round(sx) + 0.5, y);
        ctx.lineTo(Math.round(sx) + 0.5, y + h);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  return WidgetWardogsGoal;
});
