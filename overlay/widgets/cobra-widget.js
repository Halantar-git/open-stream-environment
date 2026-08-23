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
  WidgetCobra — animated Cobra Mk II ship hologram for the Elite Dangerous
  "Cobra Mk II" theme.

  A stylized top-down silhouette of the iconic Cobra Mk II rendered as a
  glowing orange hologram: layered additive neon strokes (outer halo, mid glow,
  crisp core) with a slow hover sway and a soft roll. On chat messages and
  donations the hologram briefly glitches (horizontal slice offset), echoing the
  cockpit HUD's interference.

  Runs on the built-in 30 FPS loop and tears down to 0% GPU in onUnmount().

  Theme isolation: hard-gated to "cobra" in onMount() and via the manager.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetCobra = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetCobra;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetCobra = WidgetCobra;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  // Top-down Cobra Mk II silhouette in a 100x100 unit space, nose up.
  // Nose at top, wide swept delta wings, twin rear hull notches.
  const SHIP_OUTLINE =
    "M50 4 L74 34 L88 52 L74 66 L58 62 L50 72 L42 62 L26 66 L12 52 L26 34 Z";

  // Shape bounds (derived from the outline) for tight centering.
  const SHIP_MIN_X = 12;
  const SHIP_MAX_X = 88;
  const SHIP_MIN_Y = 4;
  const SHIP_MAX_Y = 72;
  const SHIP_W = SHIP_MAX_X - SHIP_MIN_X;
  const SHIP_H = SHIP_MAX_Y - SHIP_MIN_Y;
  const SHIP_CX = (SHIP_MIN_X + SHIP_MAX_X) / 2;
  const SHIP_CY = (SHIP_MIN_Y + SHIP_MAX_Y) / 2;

  // Neon layers — outer halo, mid glow, crisp warm core.
  const LAYERS = [
    { color: "#ff7605", blurR: 0.24, alpha: 0.55 },
    { color: "#ff7605", blurR: 0.1, alpha: 0.9 },
    { color: "#ffd9b0", blurR: 0.02, alpha: 1 },
  ];

  class WidgetCobra extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this._path = typeof Path2D !== "undefined" ? new Path2D(SHIP_OUTLINE) : null;

      this._nextFlickerAt = 0;
      this._flickerUntil = 0;
      this._glitchUntil = 0;
    }

    onMount() {
      // HARD theme gate: never spin up the loop or draw on a non-Cobra Mk II theme.
      if (this.theme !== "cobra-mk2") return;

      this._applyPerspective();
      this._nextFlickerAt = performance.now() + 2000 + Math.random() * 3000;
      this.bindEvents();
      this.startRenderLoop(30); // strictly 30 FPS
    }

    onUnmount() {
      this._glitchUntil = 0;
      this._flickerUntil = 0;
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective) this._applyPerspective();
    }

    // Perspective tilt (0-100), adjustable from the inspector (same as the
    // Star Citizen sign widgets).
    _applyPerspective() {
      const v = Math.max(0, Math.min(100, Number(this.config.perspective) || 0));
      if (v > 0) {
        const ry = -(v * 0.15); // 0 .. -15deg
        const rx = v * 0.03; // 0 .. 3deg
        this.element.style.transform = `perspective(1200px) rotateY(${ry}deg) rotateX(${rx}deg)`;
        this.element.style.transformStyle = "preserve-3d";
      } else {
        this.element.style.transform = "";
        this.element.style.transformStyle = "";
      }
    }

    // ---- interactivity: glitch on chat / donation ----

    bindEvents() {
      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.CHAT_MESSAGE, () => this.glitch());
      this.subscribe(EVENT_TYPES.ALERT, (alert) => {
        if (alert && alert.kind === "donation") this.glitch();
      });
    }

    glitch() {
      this._glitchUntil = performance.now() + 500;
    }

    // ---- rendering ----

    render() {
      if (this.theme !== "cobra-mk2") return;
      const ctx = this.ctx;
      if (!ctx) return;

      const canvas = this.canvas;
      const cw = canvas.clientWidth || 320;
      const ch = canvas.clientHeight || 160;
      const dpr = window.devicePixelRatio || 1;

      const bw = Math.max(1, Math.round(cw * dpr));
      const bh = Math.max(1, Math.round(ch * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }

      const now = performance.now();
      const t = now / 1000;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      // --- flicker state machine ---
      if (now >= this._nextFlickerAt) {
        this._flickerUntil = now + 120 + Math.random() * 200;
        this._nextFlickerAt = now + 2000 + Math.random() * 3000;
      }
      const glitching = now < this._glitchUntil;
      let intensity = 0.82 + 0.18 * Math.sin(t * 2.4) * Math.sin(t * 1.15);
      if (now < this._flickerUntil) intensity *= 0.35 + 0.65 * Math.abs(Math.sin(now * 0.055));
      if (glitching) intensity = 0.3 + 0.7 * Math.abs(Math.sin(now * 0.09));
      intensity = clamp(intensity, 0.12, 1);

      // --- hover sway + soft roll ---
      const swayX = Math.sin(t * 0.5) * 4;
      const swayY = Math.cos(t * 0.4) * 3;
      const rot = Math.sin(t * 0.22) * 0.05;
      const dx = glitching ? (Math.random() * 2 - 1) * 7 : 0;

      const cx = cw / 2 + swayX + dx;
      const cy = ch / 2 + swayY;

      // Fit the ship (not the padded 100x100 space) to the widget. 0.84 leaves
      // room for the outer neon halo.
      const scale = Math.min((cw * 0.84) / SHIP_W, (ch * 0.84) / SHIP_H);
      const R = Math.min(cw, ch) * 0.42; // reference radius for glow blur math

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.scale(scale, scale);
      ctx.translate(-SHIP_CX, -SHIP_CY);

      // --- neon fill layers (additive bloom) ---
      for (const layer of LAYERS) {
        ctx.save();
        if (layer.blurR > 0) ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = layer.color;
        ctx.globalAlpha = layer.alpha * intensity;
        if (layer.blurR > 0) {
          ctx.shadowColor = layer.color;
          ctx.shadowBlur = layer.blurR * R * dpr * intensity;
        }
        if (this._path) ctx.fill(this._path);
        else this._fillOutline(ctx);
        ctx.restore();
      }

      // --- crisp hull detail lines ---
      ctx.strokeStyle = "#ffd9b0";
      ctx.globalAlpha = 0.85 * intensity;
      ctx.lineWidth = 1.6 / scale;
      ctx.shadowBlur = 0;
      ctx.beginPath();
      // fuselage spine
      ctx.moveTo(50, 6);
      ctx.lineTo(50, 70);
      // cockpit marker
      ctx.moveTo(50, 34);
      ctx.lineTo(50, 46);
      ctx.stroke();

      ctx.strokeStyle = "#ff7605";
      ctx.globalAlpha = 0.5 * intensity;
      ctx.lineWidth = 1.1 / scale;
      ctx.beginPath();
      // wing panel lines
      ctx.moveTo(30, 38);
      ctx.lineTo(16, 52);
      ctx.moveTo(70, 38);
      ctx.lineTo(84, 52);
      ctx.stroke();

      ctx.restore();

      // Analog horizontal glitch: shift a few random slices of the finished frame.
      if (glitching) this._glitchBands(ctx, bw, bh, dpr);
    }

    // Fallback when Path2D is unavailable.
    _fillOutline(ctx) {
      ctx.beginPath();
      ctx.moveTo(50, 4);
      ctx.lineTo(74, 34);
      ctx.lineTo(88, 52);
      ctx.lineTo(74, 66);
      ctx.lineTo(58, 62);
      ctx.lineTo(50, 72);
      ctx.lineTo(42, 62);
      ctx.lineTo(26, 66);
      ctx.lineTo(12, 52);
      ctx.lineTo(26, 34);
      ctx.closePath();
      ctx.fill();
    }

    // ---- analog horizontal glitch (shifted slices via drawImage) ----

    _glitchBands(ctx, bw, bh, dpr) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0); // device pixels
      const count = 2 + Math.floor(Math.random() * 2); // 2..3 slices
      for (let i = 0; i < count; i++) {
        const h = (0.03 + Math.random() * 0.12) * bh;
        const y = Math.random() * (bh - h);
        const offset = (Math.random() * 2 - 1) * 8 * dpr;
        ctx.drawImage(this.canvas, 0, y, bw, h, offset, y, bw, h);
      }
      ctx.restore();
    }
  }

  return WidgetCobra;
});
