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
  WidgetNuclear — animated neon radiation trefoil sign (Nuclear theme).

  The classic ionizing-radiation symbol is drawn procedurally: a thin outer
  ring, a central dot and three 60° blades spaced 120° apart. It renders in
  four additive glow layers (green halo, mid glow, near-white core, crisp
  white) and slowly rotates for a pseudo-3D presence, with the same flicker +
  glitch + perspective language as the Star Citizen signs.

  Runs on the built-in 30 FPS loop and tears down to 0% GPU in onUnmount().
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetNuclear = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetNuclear;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetNuclear = WidgetNuclear;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  // Normalized trefoil proportions (outer ring radius = 1).
  const RING_R = 1;
  const RING_W = 0.05; // ring stroke, as a fraction of R
  const DOT_R = 0.16; // central dot radius
  const DOT_GAP = 0.06; // dark ring separating the central dot from the blades
  const BLADE_OFFSET = 0; // blade apex sits at the symbol centre so the tips reach the middle
  const BLADE_R = 0.99; // blade circle radius — outer arc reaches the outer ring
  const BLADE_HALF = Math.PI / 6; // 30° half-angle -> 60° blades

  // Neon glow layers — deep green halo, mid glow, bright green core and a
  // faint white sparkle. The white is kept subtle so the sign stays green
  // instead of blowing out to near-white.
  const LAYERS = [
    { color: "#1f8f00", blur: 0.34, alpha: 0.55 },
    { color: "#5be000", blur: 0.13, alpha: 0.85 },
    { color: "#8dff6a", blur: 0.03, alpha: 0.55 },
    { color: "#ffffff", blur: 0, alpha: 0.2 },
  ];

  class WidgetNuclear extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      // Active theme id, injected by the manager via context.
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this._nextFlickerAt = 0;
      this._flickerUntil = 0;
      this._glitchUntil = 0;
    }

    onMount() {
      // HARD theme gate: never spin up the loop or draw on a non-nuclear theme.
      if (this.theme !== "nuclear") return;

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

    // Perspective tilt (0-100), adjustable from the inspector.
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
      if (this.theme !== "nuclear") return;
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
      ctx.lineJoin = "miter";
      ctx.lineCap = "square";

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

      // --- pseudo-3D motion: slow rotation + sway + glitch jitter ---
      const rot = t * 0.22; // continuous spin, unlike the static Grim HEX sign
      const swayX = Math.sin(t * 0.5) * 3;
      const swayY = Math.cos(t * 0.4) * 2;
      const dx = glitching ? (Math.random() * 2 - 1) * 7 : 0;

      const cx = cw / 2 + swayX + dx;
      const cy = ch / 2 + swayY;

      // Fit the symbol (a square) to the widget, leaving room for the glow.
      const R = Math.min(cw, ch) * 0.42;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);

      // --- neon glow pass ---
      for (const layer of LAYERS) {
        ctx.save();
        if (layer.blur > 0) ctx.globalCompositeOperation = "lighter"; // additive glow
        ctx.globalAlpha = layer.alpha * intensity;
        if (layer.blur > 0) {
          ctx.shadowColor = layer.color;
          ctx.shadowBlur = layer.blur * R * dpr * intensity;
        }
        ctx.fillStyle = layer.color;
        ctx.strokeStyle = layer.color;
        ctx.lineWidth = RING_W * R;

        // Filled body: three blades (the central dot is drawn separately).
        ctx.beginPath();
        this._traceBody(ctx, R);
        ctx.fill();

        // Thin outer ring (stroke only, so it stays a ring not a disc).
        ctx.beginPath();
        ctx.arc(0, 0, RING_R * R, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();
      }

      ctx.restore();

      // --- central dot ---
      // Carve a small gap ring out of the blades, then draw the glowing dot on
      // top so the centre reads as a distinct "o" instead of melting into them.
      ctx.save();
      ctx.translate(cx, cy);

      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(0, 0, (DOT_R + DOT_GAP) * R, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalCompositeOperation = "source-over";
      for (const layer of LAYERS) {
        ctx.save();
        if (layer.blur > 0) ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = layer.alpha * intensity;
        if (layer.blur > 0) {
          ctx.shadowColor = layer.color;
          ctx.shadowBlur = layer.blur * R * dpr * intensity;
        }
        ctx.fillStyle = layer.color;
        ctx.beginPath();
        ctx.arc(0, 0, DOT_R * R, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      // Analog horizontal glitch: shift a few random slices of the finished frame.
      if (glitching) this._glitchBands(ctx, bw, bh, dpr);
    }

    // Trace the three blades into the current path (fill body). The central
    // dot is drawn separately in render() so it can sit on a cleared gap.
    _traceBody(ctx, R) {
      // Three blades, pointing up first, spaced 120° apart.
      for (let i = 0; i < 3; i++) {
        const phi = -Math.PI / 2 + i * ((Math.PI * 2) / 3);
        const bx = Math.cos(phi) * BLADE_OFFSET * R;
        const by = Math.sin(phi) * BLADE_OFFSET * R;
        ctx.moveTo(bx, by);
        ctx.arc(bx, by, BLADE_R * R, phi - BLADE_HALF, phi + BLADE_HALF);
        ctx.closePath();
      }
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

  return WidgetNuclear;
});
