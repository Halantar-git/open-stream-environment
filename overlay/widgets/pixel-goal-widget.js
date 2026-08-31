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
  WidgetPixelGoal — donation goal as a blocky pixel health-bar for the
  Pixel Perfect theme.

  Ten flat square cells fill with the muted gold accent as the goal grows, like
  a retro HP bar. No rounding, no gradients — hard edges only. The fill is
  smoothed and driven only by the goal state (never by chat).
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetPixelGoal = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetPixelGoal;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetPixelGoal = WidgetPixelGoal;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const CELLS = 10;
  const DEFAULT_GOLD = "#d6b675";
  const DEFAULT_TEXT = "#e6e6e6";
  const DEFAULT_MUTED = "#b8b8b8";
  const TRACK = "#19191c";
  const TRACK_EDGE = "#3a3a3e";
  const FONT = "'PT Sans Caption', 'Segoe UI', sans-serif";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  class WidgetPixelGoal extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.canvas = null;
      this.ctx = null;
      this.layoutEl = null;
      this.contentEl = null;
      this.barWrap = null;

      this.gold = DEFAULT_GOLD;
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
      if (this.theme !== "pixel") return;

      this._readColors();

      this.layoutEl = document.createElement("div");
      this.layoutEl.className = "pixel-goal";
      this.layoutEl.style.cssText =
        "position:absolute;inset:0;display:flex;flex-direction:column;box-sizing:border-box;padding:12px 14px;";
      this.element.appendChild(this.layoutEl);

      this.contentEl = document.createElement("div");
      this.contentEl.className = "pixel-goal__content";
      this.contentEl.style.cssText =
        "display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-shrink:0;padding:0 2px;";
      this.layoutEl.appendChild(this.contentEl);

      this.barWrap = document.createElement("div");
      this.barWrap.className = "pixel-goal__bar";
      this.barWrap.style.cssText = "position:relative;flex:1;min-height:0;";
      this.layoutEl.appendChild(this.barWrap);

      this.canvas = document.createElement("canvas");
      this.canvas.className = "pixel-goal__canvas";
      Object.assign(this.canvas.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
      });
      this.barWrap.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");

      this.element.classList.add("pixel-goal-surface");
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
      this.gold = (read && read("--md-primary")) || DEFAULT_GOLD;
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

      const bg = (read && read("--panel-bg")) || "rgba(16, 16, 18, 0.95)";
      const border = (read && read("--panel-border")) || "1px solid rgba(138, 138, 141, 0.35)";
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const glow = (read && read("--panel-glow")) || "0 0 0 1px rgba(214, 182, 117, 0.15)";

      s.backgroundColor = bg;
      s.backgroundImage = "";
      s.backdropFilter = "none";
      s.webkitBackdropFilter = "none";
      s.border = border;
      s.borderRadius = radius;
      s.clipPath = clip;
      s.boxShadow = glow;
    }

    _updateDom() {
      if (!this.contentEl) return;
      const { escapeHtml, formatMoney, currencySymbol, t, state } = this.context;
      const goal = (state && state.goal) || {};
      const pct = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
      this._pct = pct;

      const pctStr = this.config.showPercentage
        ? `<span style="color:${this.gold};"> ${pct}%</span>`
        : "";

      this.contentEl.innerHTML =
        `<span style="color:${this.textColor};font-family:${FONT};font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(goal.title || t("preview.goalTitle"))}</span>` +
        `<span style="color:${this.mutedColor};font-family:${FONT};font-size:12px;white-space:nowrap;"><b style="color:${this.gold};">${formatMoney(goal.current)}</b> / ${formatMoney(goal.target)} ${escapeHtml(currencySymbol(goal.currency))}${pctStr}</span>`;
    }

    render() {
      if (this.theme !== "pixel") return;
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

      const now = performance.now();
      let glow = 6;
      if (now < this._pulseUntil) {
        const k = 1 - (this._pulseUntil - now) / 600;
        glow = 6 + 10 * Math.sin(Math.PI * k);
      }

      const pad = 4;
      const gap = 3;
      const x = pad;
      const y = pad;
      const w = Math.max(1, cw - pad * 2);
      const h = Math.max(1, ch - pad * 2);
      const cellW = Math.max(1, (w - gap * (CELLS - 1)) / CELLS);

      for (let i = 0; i < CELLS; i++) {
        const cx = x + i * (cellW + gap);
        const segStart = (i * 100) / CELLS;
        const segSize = 100 / CELLS;
        const fill = clamp((pct - segStart) / segSize, 0, 1);

        // Empty track cell.
        ctx.fillStyle = TRACK;
        ctx.fillRect(cx, y, cellW, h);
        ctx.strokeStyle = TRACK_EDGE;
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + 0.5, y + 0.5, cellW - 1, h - 1);

        if (fill > 0.01) {
          const fw = Math.max(1, Math.round(cellW * fill));
          ctx.fillStyle = this.gold;
          ctx.shadowColor = this.gold;
          ctx.shadowBlur = glow * dpr;
          ctx.fillRect(cx, y, fw, h);
          ctx.shadowBlur = 0;
        }
      }
    }
  }

  return WidgetPixelGoal;
});
