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
  WidgetRetrowaveGoal — donation goal as a neon synthwave bar.

  A chamfered track (the theme's slanted leading edge in miniature) fills with
  a cyan→magenta→sunset gradient, cut by horizontal scanlines so the fill reads
  as the striped sun of the genre. The leading edge glows and carries a bright
  head; the title takes the display face, amounts stay monospaced. Like the
  other themed goals it is bound to Retrowave (see shared/themes.js) and guarded
  inside the widget, so no canvas, loop or subscriptions start on another theme.

  The panel surface comes from the theme's own panel tokens: every Retrowave
  widget shares one background, and the CSS decoration adds the inner grid.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetRetrowaveGoal = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetRetrowaveGoal;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetRetrowaveGoal = WidgetRetrowaveGoal;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  // Fallbacks mirror the Retrowave tokens in shared/themes.js; the live values
  // are read from CSS so a custom theme reusing this set keeps its palette.
  const DEFAULT_PRIMARY = "#ff2d95";
  const DEFAULT_SECONDARY = "#2de2e6";
  const DEFAULT_TERTIARY = "#ffa24c";
  const DEFAULT_TEXT = "#f3e8ff";
  const DEFAULT_MUTED = "#c3b0e0";

  const DEFAULT_PANEL_BG = "rgba(13, 7, 25, 0.88)";
  const DEFAULT_PANEL_BORDER = "2px solid rgba(255, 45, 149, 0.8)";
  const DEFAULT_PANEL_GLOW = "0 0 18px rgba(255,45,149,0.35), 0 0 46px rgba(45,226,230,0.12)";

  const FONT_DISPLAY = "'Orbitron', 'Segoe UI', sans-serif";
  const FONT_MONO = "'JetBrains Mono', 'Consolas', monospace";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  class WidgetRetrowaveGoal extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.primary = DEFAULT_PRIMARY;
      this.secondary = DEFAULT_SECONDARY;
      this.tertiary = DEFAULT_TERTIARY;
      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;

      this.canvas = null;
      this.ctx = null;
      this.layoutEl = null;
      this.contentEl = null;
      this.barWrap = null;

      this._pct = 0; // target progress (from the goal state)
      this._displayPct = 0; // smoothed progress, so a donation glides in
    }

    // The bar animates although the root element is a plain <div>.
    _isAnimated() {
      return true;
    }

    onMount() {
      // HARD theme gate: no canvas, no loop, no events on a foreign theme.
      if (this.theme !== "retrowave") return;

      this._readColors();
      this._applyPerspective();

      this.layoutEl = document.createElement("div");
      this.layoutEl.className = "retrowave-goal";
      this.layoutEl.style.cssText =
        "position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;box-sizing:border-box;padding:8px 16px 9px 26px;";
      this.element.appendChild(this.layoutEl);

      this.contentEl = document.createElement("div");
      this.contentEl.className = "retrowave-goal__content";
      this.contentEl.style.cssText =
        "display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-shrink:0;margin-bottom:6px;";
      this.layoutEl.appendChild(this.contentEl);

      this.barWrap = document.createElement("div");
      this.barWrap.className = "retrowave-goal__bar";
      this.barWrap.style.cssText = "position:relative;flex:0 0 auto;height:24px;min-height:0;";
      this.layoutEl.appendChild(this.barWrap);

      this.canvas = document.createElement("canvas");
      this.canvas.className = "retrowave-goal__canvas";
      Object.assign(this.canvas.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
      });
      this.barWrap.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");

      this.element.classList.add("retrowave-surface");
      this._applySurface();
      this._updateDom();

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.GOAL_UPDATE, () => this._updateDom());
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
      if (prev.perspective !== next.perspective || prev.perspectiveDirection !== next.perspectiveDirection) this._applyPerspective();
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.primary = (read && read("--md-primary")) || DEFAULT_PRIMARY;
      this.secondary = (read && read("--md-secondary")) || DEFAULT_SECONDARY;
      this.tertiary = (read && read("--md-tertiary")) || DEFAULT_TERTIARY;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
    }

    // Perspective tilt (0-100) from the inspector, matching the other themed
    // 3D widgets. `perspectiveDirection` picks the axis; `left` is the default.
    _applyPerspective() {
      const v = clamp(Number(this.config.perspective) || 0, 0, 100);
      if (v > 0) {
        const magnitude = v * 0.15; // 0..15deg
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

    // Panel surface from the theme tokens so the goal shares one background
    // with the chat and alert. The grid itself comes from `.retrowave-surface`.
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
        this.element.classList.remove("retrowave-surface");
        return;
      }

      this.element.classList.add("retrowave-surface");
      const bg = (read && read("--panel-bg")) || DEFAULT_PANEL_BG;
      const blur = (read && read("--panel-blur")) || "0px";
      const border = (read && read("--panel-border")) || DEFAULT_PANEL_BORDER;
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow = (read && read("--panel-glow")) || DEFAULT_PANEL_GLOW;

      // An empty backgroundImage drops the inline value, letting the theme
      // grid from the class through — same trick as the Wardogs widgets.
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

      const pctHtml = this.config.showPercentage
        ? `<b style="color:${this.primary};font-weight:700;">[${pct}%]</b>`
        : "";

      this.contentEl.innerHTML =
        `<span style="color:${this.textColor};font-family:${FONT_DISPLAY};font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1.6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(goal.title || t("preview.goalTitle"))}</span>` +
        `<span style="color:${this.mutedColor};font-family:${FONT_MONO};font-size:12px;white-space:nowrap;">${formatMoney(goal.current)} / ${formatMoney(goal.target)} ${escapeHtml(currencySymbol(goal.currency))} ${pctHtml}</span>`;
    }

    // ---- rendering ----

    render() {
      if (this.theme !== "retrowave") return;
      this._drawBar();
    }

    _drawBar() {
      const ctx = this.ctx;
      if (!ctx || !this.canvas) return;

      const cw = this.canvas.clientWidth || 300;
      const ch = this.canvas.clientHeight || 24;
      const dpr = window.devicePixelRatio || 1;

      const bw = Math.max(1, Math.round(cw * dpr));
      const bh = Math.max(1, Math.round(ch * dpr));
      if (this.canvas.width !== bw || this.canvas.height !== bh) {
        this.canvas.width = bw;
        this.canvas.height = bh;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      // Glide the fill towards the new percentage instead of snapping — a goal
      // update usually lands mid-stream and a jump reads as a glitch.
      this._displayPct += (this._pct - this._displayPct) * 0.12;
      if (Math.abs(this._pct - this._displayPct) < 0.05) this._displayPct = this._pct;
      const pct = clamp(this._displayPct, 0, 100);

      const pad = 1;
      const x = pad;
      const y = pad;
      const w = Math.max(1, cw - pad * 2);
      const h = Math.max(1, ch - pad * 2);
      const slant = Math.min(10, h * 0.5);

      const barPath = () => {
        ctx.beginPath();
        ctx.moveTo(x + slant, y);
        ctx.lineTo(x + w, y);
        ctx.lineTo(x + w - slant, y + h);
        ctx.lineTo(x, y + h);
        ctx.closePath();
      };

      // Track: dark glass with a cyan hairline; the chamfer echoes the panel.
      ctx.save();
      barPath();
      ctx.fillStyle = "rgba(5, 2, 11, 0.82)";
      ctx.fill();
      // Неоновый кант дорожки: без ореола шкала терялась на тёмном фоне.
      ctx.shadowColor = "rgba(45, 226, 230, 0.55)";
      ctx.shadowBlur = 8;
      ctx.strokeStyle = "rgba(45, 226, 230, 0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      // Faint cell separators keep the empty part from reading as a solid slab.
      ctx.save();
      barPath();
      ctx.clip();
      ctx.strokeStyle = "rgba(45, 226, 230, 0.14)";
      ctx.lineWidth = 1;
      for (let gx = x + 14; gx < x + w; gx += 14) {
        ctx.beginPath();
        ctx.moveTo(gx, y);
        ctx.lineTo(gx, y + h);
        ctx.stroke();
      }

      // Fill: cyan on the left hand of to sunset orange on the right, with the
      // horizontal cuts that make it read as the genre's striped sun.
      if (pct > 0) {
        const head = x + (w * pct) / 100;
        const fillW = Math.max(1, head - x);
        const grad = ctx.createLinearGradient(x, 0, Math.max(x + w, x + 1), 0);
        grad.addColorStop(0, this.secondary);
        grad.addColorStop(0.55, this.primary);
        grad.addColorStop(1, this.tertiary);

        ctx.fillStyle = grad;
        ctx.shadowColor = "rgba(255, 45, 149, 0.5)";
        ctx.shadowBlur = 10;
        ctx.fillRect(x, y, fillW, h);
        ctx.shadowBlur = 0;

        // Horizontal stripes over the fill only, so the unfilled track stays
        // clean and the bar keeps the "sunset disc" look.
        ctx.fillStyle = "rgba(5, 2, 11, 0.30)";
        for (let sy = y + 4; sy < y + h; sy += 5) {
          ctx.fillRect(x, sy, fillW, 1);
        }

        // Leading edge: a bright hairline plus a soft glow at the head.
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.shadowColor = "rgba(255, 45, 149, 0.9)";
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.moveTo(head, y + 1);
        ctx.lineTo(head, y + h - 1);
        ctx.stroke();

        ctx.fillStyle = this.primary;
        ctx.beginPath();
        ctx.shadowColor = "rgba(45, 226, 230, 0.9)";
        ctx.shadowBlur = 16;
        ctx.arc(head, y + h / 2, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  return WidgetRetrowaveGoal;
});
