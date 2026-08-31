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
  WidgetMd3Goal — donation goal for the Material You theme.

  A single rounded progress bar with a primary→secondary gradient fill and a
  soft glow, sitting on the theme's glass panel surface. The fill is smoothed
  and driven only by the goal state (never by chat): the widget subscribes to
  GOAL_UPDATE / LOCALES.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetMd3Goal = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetMd3Goal;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetMd3Goal = WidgetMd3Goal;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_PRIMARY = "#d0bcff";
  const DEFAULT_SECONDARY = "#ccc2dc";
  const DEFAULT_TEXT = "#e6e1e5";
  const DEFAULT_MUTED = "#cac4d0";
  const FONT_DISPLAY = "'Manrope', 'Segoe UI', sans-serif";
  const FONT_MONO = "'JetBrains Mono', 'Consolas', monospace";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  class WidgetMd3Goal extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.canvas = null;
      this.ctx = null;
      this.layoutEl = null;
      this.contentEl = null;
      this.barWrap = null;

      this.primary = DEFAULT_PRIMARY;
      this.secondary = DEFAULT_SECONDARY;
      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;

      this._pct = 0;
      this._displayPct = 0;
      this._pulseUntil = 0;
    }

    _isAnimated() {
      return true;
    }

    onMount() {
      if (this.theme !== "nebula") return;

      this._readColors();

      this.layoutEl = document.createElement("div");
      this.layoutEl.className = "md3-goal";
      this.layoutEl.style.cssText =
        "position:absolute;inset:0;display:flex;flex-direction:column;box-sizing:border-box;padding:12px 16px;";
      this.element.appendChild(this.layoutEl);

      this.contentEl = document.createElement("div");
      this.contentEl.className = "md3-goal__content";
      this.contentEl.style.cssText =
        "display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-shrink:0;padding:0 2px;";
      this.layoutEl.appendChild(this.contentEl);

      this.barWrap = document.createElement("div");
      this.barWrap.className = "md3-goal__bar";
      this.barWrap.style.cssText = "position:relative;flex:1;min-height:0;";
      this.layoutEl.appendChild(this.barWrap);

      this.canvas = document.createElement("canvas");
      this.canvas.className = "md3-goal__canvas";
      Object.assign(this.canvas.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
      });
      this.barWrap.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");

      this.element.classList.add("md3-goal-surface");
      this._applySurface();
      this._updateDom();

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.GOAL_UPDATE, () => {
        this._pulseUntil = performance.now() + 600;
        this._updateDom();
      });
      this.subscribe(EVENT_TYPES.LOCALES, () => this._updateDom());

      this.startRenderLoop(30);
    }

    onUnmount() {
      if (this.element) this.element.innerHTML = "";
      this.layoutEl = null;
      this.contentEl = null;
      this.barWrap = null;
      this.ctx = null;
      this.canvas = null;
    }

    onUpdate(prev, next) {
      if (prev.showPercentage !== next.showPercentage) this._updateDom();
      if (prev.showBackground !== next.showBackground) this._applySurface();
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.primary = (read && read("--md-primary")) || DEFAULT_PRIMARY;
      this.secondary = (read && read("--md-secondary")) || DEFAULT_SECONDARY;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
    }

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

      const bg = (read && read("--panel-bg")) || "rgba(33, 31, 38, 0.82)";
      const blur = (read && read("--panel-blur")) || "20px";
      const border = (read && read("--panel-border")) || "1px solid rgba(255, 255, 255, 0.12)";
      const radius = (read && read("--panel-radius")) || "24px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) || "0 1px 3px rgba(0,0,0,0.45), 0 1px 2px rgba(0,0,0,0.3)";
      const glow = (read && read("--panel-glow")) || "0 24px 48px rgba(0,0,0,0.45)";

      s.backgroundColor = bg;
      s.backgroundImage = "";
      s.backdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.webkitBackdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.border = border;
      s.borderRadius = radius;
      s.clipPath = clip;
      s.boxShadow = `${elev}, ${glow}`;
    }

    _updateDom() {
      if (!this.contentEl) return;
      const { escapeHtml, formatMoney, currencySymbol, t, state } = this.context;
      const goal = (state && state.goal) || {};
      const pct = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
      this._pct = pct;

      const pctStr = this.config.showPercentage
        ? `<span style="color:${this.primary};"> ${pct}%</span>`
        : "";

      this.contentEl.innerHTML =
        `<span style="color:${this.textColor};font-family:${FONT_DISPLAY};font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(goal.title || t("preview.goalTitle"))}</span>` +
        `<span style="color:${this.mutedColor};font-family:${FONT_MONO};font-size:12px;white-space:nowrap;"><b style="color:${this.primary};">${formatMoney(goal.current)}</b> / ${formatMoney(goal.target)} ${escapeHtml(currencySymbol(goal.currency))}${pctStr}</span>`;
    }

    render() {
      if (this.theme !== "nebula") return;
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

      this._displayPct += (this._pct - this._displayPct) * 0.08;
      const pct = clamp(this._displayPct, 0, 100);

      // Pulse on goal update.
      const now = performance.now();
      let glow = 10;
      if (now < this._pulseUntil) {
        const k = 1 - (this._pulseUntil - now) / 600;
        glow = 10 + 16 * Math.sin(Math.PI * k);
      }

      const h = Math.max(8, Math.min(ch, 18));
      // Inset the pill horizontally so its rounded glow (shadowBlur) has room
      // to spread — flush against x=0/x=cw the shadow is clipped and the caps
      // read as flat, square-cut highlights instead of rounded ones.
      const glowPad = Math.min(14, cw / 4);
      const bx = glowPad;
      const barW = Math.max(1, cw - bx * 2);
      const y = (ch - h) / 2;
      const r = h / 2;

      // Track.
      ctx.save();
      ctx.fillStyle = "rgba(255, 255, 255, 0.10)";
      ctx.beginPath();
      ctx.roundRect(bx, y, barW, h, r);
      ctx.fill();
      ctx.restore();

      if (pct > 0.5) {
        const fw = Math.max(r * 2, (barW * pct) / 100);

        ctx.save();
        const grad = ctx.createLinearGradient(bx, 0, bx + barW, 0);
        grad.addColorStop(0, this.primary);
        grad.addColorStop(1, this.secondary);
        ctx.fillStyle = grad;
        ctx.shadowColor = this.primary;
        ctx.shadowBlur = glow * dpr;
        ctx.beginPath();
        ctx.roundRect(bx, y, fw, h, r);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  return WidgetMd3Goal;
});
