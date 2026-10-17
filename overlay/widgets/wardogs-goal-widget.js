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
  WidgetWardogsGoal — donation goal as the WARDOGS loading bar.

  A thin framed bar made of dense vertical ticks: the empty part reads as dim
  gray stripes, the filled part lights up to light gray, and the boundary falls
  on a cell edge — like a game's "loading / compiling" readout. Above the bar
  sits an uppercase title on the left and a bracketed percentage "[43%]" on the
  right. The whole readout is monochrome gray (the game's loading screen), not
  the theme accent.

  The progress is driven only by the goal state (never by chat): the widget
  subscribes to GOAL_UPDATE / LOCALES and runs a self-contained render loop. It
  is bound to the Wardogs theme (see shared/themes.js) with a hard internal
  gate — no canvas, loop or subscriptions on any other theme. The panel surface
  comes from the theme's own panel tokens, so every Wardogs widget shares one
  background.
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

  // Monochrome grays of the loading readout (the game's shader-compile screen):
  // light filled cells on dim gray track, a hairline frame and gray labels.
  const FILL = "#dcdcdc"; // filled cells
  const TRACK = "rgba(255, 255, 255, 0.20)"; // empty cell stripes
  const FRAME = "rgba(220, 220, 220, 0.45)"; // bar hairline
  const TEXT = "#e2e2e2"; // title + "[43%]"
  const MUTED = "#8f8f8f"; // amounts

  const CELL_PITCH = 7; // stripe every ~7px → the dense barcode look
  const CELL_GAP = 1; // 1px gap between stripes

  const FONT_DISPLAY = "'Roboto Condensed', 'Segoe UI', sans-serif";
  const FONT_MONO = "'JetBrains Mono', 'Consolas', monospace";

  // Fallbacks for the panel surface, used only before the theme CSS variables
  // are applied (they mirror the Wardogs tokens in shared/themes.js).
  const PANEL_BG = "rgba(10, 10, 10, 0.90)";
  const PANEL_BORDER = "1px solid rgba(255, 255, 255, 0.16)";
  const PANEL_GLOW = "0 8px 24px rgba(0, 0, 0, 0.5)";

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

    onMount() {
      // HARD theme gate: no canvas, no loop, no events on a non-Wardogs theme.
      if (this.theme !== "wardogs") return;

      this._applyPerspective();

      this.layoutEl = document.createElement("div");
      this.layoutEl.className = "wardogs-goal";
      this.layoutEl.style.cssText =
        "position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;box-sizing:border-box;padding:10px 14px;";
      this.element.appendChild(this.layoutEl);

      // Title + amounts + "[43%]" row, mirroring the game's loading readout.
      this.contentEl = document.createElement("div");
      this.contentEl.className = "wardogs-goal__content";
      this.contentEl.style.cssText =
        "display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-shrink:0;padding:0 2px;margin-bottom:7px;";
      this.layoutEl.appendChild(this.contentEl);

      // Bar area (canvas fills it).
      this.barWrap = document.createElement("div");
      this.barWrap.className = "wardogs-goal__bar";
      this.barWrap.style.cssText = "position:relative;flex:0 0 auto;height:22px;min-height:0;";
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
      if (prev.perspective !== next.perspective || prev.perspectiveDirection !== next.perspectiveDirection) this._applyPerspective();
    }

    // Perspective tilt (0-100) from the widget inspector — the same transform
    // the themed 3D chat and sign widgets use. `perspectiveDirection` picks
    // which way the bar leans; `left` keeps the historical look.
    _applyPerspective() {
      const v = Math.max(0, Math.min(100, Number(this.config.perspective) || 0));
      if (v > 0) {
        const magnitude = v * 0.15; // 0 .. 15deg
        const direction = this.config.perspectiveDirection || "left";
        let ry = -magnitude;
        let rx = magnitude * 0.2;
        if (direction === "right") {
          ry = magnitude;
        } else if (direction === "up") {
          ry = 0;
          rx = magnitude;
        } else if (direction === "down") {
          ry = 0;
          rx = -magnitude;
        }
        this.element.style.transform = `perspective(1200px) rotateY(${ry}deg) rotateX(${rx}deg)`;
        this.element.style.transformStyle = "preserve-3d";
      } else {
        this.element.style.transform = "";
        this.element.style.transformStyle = "";
      }
    }

    // Panel surface from the theme's tokens, so the goal bar shares one
    // background with every other Wardogs widget. Cleared entirely when
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

      const bg = (read && read("--panel-bg")) || PANEL_BG;
      const blur = (read && read("--panel-blur")) || "0px";
      const border = (read && read("--panel-border")) || PANEL_BORDER;
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow = (read && read("--panel-glow")) || PANEL_GLOW;

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
      const goal = (state && state.goal) || {};
      const pct = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
      this._pct = pct;

      const pctStr = this.config.showPercentage ? `<b style="color:${TEXT};"> [${pct}%]</b>` : "";

      this.contentEl.innerHTML =
        `<span style="color:${TEXT};font-family:${FONT_DISPLAY};font-size:15px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(goal.title || t("preview.goalTitle"))}</span>` +
        `<span style="color:${MUTED};font-family:${FONT_MONO};font-size:12px;white-space:nowrap;">${formatMoney(goal.current)} / ${formatMoney(goal.target)} ${escapeHtml(currencySymbol(goal.currency))}${pctStr}</span>`;
    }

    // ---- rendering ----

    render() {
      if (this.theme !== "wardogs") return;
      this._drawBarLayer();
    }

    _drawBarLayer() {
      const ctx = this.ctx;
      if (!ctx || !this.canvas) return;

      const cw = this.canvas.clientWidth || 300;
      const ch = this.canvas.clientHeight || 22;
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
      this._displayPct += (this._pct - this._displayPct) * 0.12;
      if (Math.abs(this._pct - this._displayPct) < 0.05) this._displayPct = this._pct;
      const pct = clamp(this._displayPct, 0, 100);

      // Hairline frame around the whole bar.
      ctx.save();
      ctx.strokeStyle = FRAME;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, Math.max(1, cw - 1), Math.max(1, ch - 1));
      ctx.restore();

      // Dense vertical stripes inside the frame; the filled cells light up.
      const pad = 2;
      const x = pad;
      const y = pad;
      const w = Math.max(1, cw - pad * 2);
      const h = Math.max(1, ch - pad * 2);

      const count = Math.max(1, Math.round((w + CELL_GAP) / (CELL_PITCH + CELL_GAP)));
      const gap = count > 1 ? CELL_GAP : 0;
      const cellW = Math.max(1, (w - gap * (count - 1)) / count);
      const cellPct = 100 / count;

      for (let i = 0; i < count; i++) {
        const cx = x + i * (cellW + gap);
        const fill = clamp((pct - i * cellPct) / cellPct, 0, 1);

        ctx.fillStyle = TRACK;
        ctx.fillRect(cx, y, cellW, h);

        if (fill > 0.001) {
          ctx.fillStyle = FILL;
          ctx.fillRect(cx, y, Math.max(1, cellW * fill), h);
        }
      }
    }
  }

  return WidgetWardogsGoal;
});
