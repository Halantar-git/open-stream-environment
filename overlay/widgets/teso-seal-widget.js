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
  WidgetTesoSeal — animated gold sign of the TESO emblem (dragon ouroboros)
  for the TESO "Ouroboros Seal" 3D theme.

  Reproduces the reference emblem (TESO.svg): a single filled silhouette,
  rendered as layered additive gold neon (outer halo, mid glow, crisp warm
  core) with a slow clockwise spin and a gentle hover sway. On chat messages
  the sign briefly glitches (horizontal slice offset). On a donation it takes
  the ESO item-quality colour for the amount and pops slightly larger.

  Runs on the built-in 30 FPS loop and tears down to 0% GPU in onUnmount().

  Theme isolation: hard-gated to "teso-seal" in onMount() and via the manager
  (shouldMount / resolveRenderType using the catalog `theme` field).
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const emblem =
    typeof module !== "undefined" && module.exports
      ? require("../../shared/teso-emblem")
      : (root.SharedTesoEmblem || { d: "" });
  const WidgetTesoSeal = factory(BaseWidget, emblem);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetTesoSeal;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetTesoSeal = WidgetTesoSeal;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget, emblem) {
  "use strict";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  // ESO item-quality tiers for donations, 200₽ wide, from 0 to 1000₽.
  function donationQualityColor(amount) {
    const a = Number(amount) || 0;
    if (a < 200) return "#ffffff";   // White (Trash)
    if (a < 400) return "#2dc50e";   // Green (Fine)
    if (a < 600) return "#3a92ff";   // Blue (Superior)
    if (a < 800) return "#a02dc5";   // Purple (Epic)
    if (a < 1000) return "#e5a823";  // Gold (Legendary)
    return "#ee6a00";                // Orange (Mythic)
  }

  // Blend two #rrggbb colours for the donation tint fade.
  function hexToRgb(hex) {
    const h = String(hex || "").replace("#", "");
    if (h.length !== 6) return null;
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return null;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mixHex(a, b, t) {
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    if (!ca || !cb) return b;
    const k = clamp(t, 0, 1);
    const r = Math.round(ca[0] + (cb[0] - ca[0]) * k);
    const g = Math.round(ca[1] + (cb[1] - ca[1]) * k);
    const bl = Math.round(ca[2] + (cb[2] - ca[2]) * k);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }

  // The TESO emblem path and its viewBox, from shared/teso-emblem.js.
  const EMBLEM_D = emblem && emblem.d ? emblem.d : "";
  const SVG_W = (emblem && emblem.w) || 652.32001;
  const SVG_H = (emblem && emblem.h) || 626.40002;

  // Gold neon layers — TESO HUD palette (--md-primary gold + bright-gold core).
  // `blurR` is the glow radius as a fraction of the reference radius R.
  const LAYERS = [
    { color: "#c7a75c", blurR: 0.18, alpha: 0.55 },
    { color: "#c7a75c", blurR: 0.07, alpha: 0.9 },
    { color: "#e2c47e", blurR: 0.015, alpha: 1 },
  ];

  class WidgetTesoSeal extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this._path = typeof Path2D !== "undefined" && EMBLEM_D ? new Path2D(EMBLEM_D) : null;

      this._nextFlickerAt = 0;
      this._flickerUntil = 0;
      this._glitchUntil = 0;
      this._popUntil = 0;
      this._donationColor = "";
      this._donationUntil = 0;
      this._donationStartedAt = 0;
    }

    onMount() {
      // HARD theme gate: never spin up the loop or draw on a non-TESO theme.
      if (this.theme !== "teso-seal") return;

      this._applyPerspective();
      this._nextFlickerAt = performance.now() + 2000 + Math.random() * 3000;
      this.bindEvents();
      this.startRenderLoop(30); // strictly 30 FPS
    }

    onUnmount() {
      this._glitchUntil = 0;
      this._flickerUntil = 0;
      this._popUntil = 0;
      this._donationColor = "";
      this._donationUntil = 0;
      this._donationStartedAt = 0;
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective) this._applyPerspective();
    }

    // Perspective tilt (0-100), adjustable from the inspector (same as the
    // Star Citizen / Cobra sign widgets).
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

    // ---- interactivity: glitch on chat, tint + pop on donations ----

    bindEvents() {
      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.CHAT_MESSAGE, () => this.glitch());
      this.subscribe(EVENT_TYPES.ALERT, (alert) => {
        if (alert && alert.kind === "donation") this.onDonation(alert);
      });
    }

    glitch() {
      this._glitchUntil = performance.now() + 500;
    }

    // On donation the seal takes the ESO item-quality colour for the amount
    // and pops slightly larger; no icon is drawn (see the alerts widget).
    onDonation(alert) {
      const amount = Number(alert.amount) || 0;
      this._donationColor = donationQualityColor(amount);
      this._donationStartedAt = performance.now();
      this._donationUntil = this._donationStartedAt + (alert.durationMs || 5000);
      this.pop();
    }

    pop() {
      this._popUntil = performance.now() + 450;
    }

    // ---- rendering ----

    render() {
      if (this.theme !== "teso-seal") return;
      const ctx = this.ctx;
      if (!ctx) return;
      const path = this._path;
      if (!path) return;

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

      // --- slow clockwise spin (fixed in place, no drift) ---
      const rot = (t * 0.12) % (Math.PI * 2); // continuous clockwise rotation

      const cx = cw / 2;
      const cy = ch / 2;

      // Fit the emblem to the widget. 0.86 leaves room for the outer neon halo.
      let scale = Math.min((cw * 0.86) / SVG_W, (ch * 0.86) / SVG_H);
      if (now < this._popUntil) {
        const k = 1 - (this._popUntil - now) / 450;
        scale *= 1 + 0.12 * Math.sin(Math.PI * k); // donation pop
      }
      const R = Math.min(cw, ch) * 0.42; // reference radius for glow blur math

      // Donation tint: shift the gold neon toward the item-quality colour for
      // the amount, fading in/out around the donation duration.
      let tintMix = 0;
      if (this._donationColor && now < this._donationUntil) {
        const fadeIn = clamp((now - this._donationStartedAt) / 200, 0, 1);
        const fadeOut = clamp((this._donationUntil - now) / 400, 0, 1);
        tintMix = Math.min(fadeIn, fadeOut);
      }

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.scale(scale, scale);
      ctx.translate(-SVG_W / 2, -SVG_H / 2);

      // --- neon fill layers (additive bloom) ---
      for (const layer of LAYERS) {
        const color = tintMix > 0 ? mixHex(layer.color, this._donationColor, tintMix) : layer.color;
        ctx.save();
        if (layer.blurR > 0) ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = color;
        ctx.globalAlpha = layer.alpha * intensity;
        if (layer.blurR > 0) {
          ctx.shadowColor = color;
          ctx.shadowBlur = layer.blurR * R * dpr * intensity;
        }
        ctx.fill(path);
        ctx.restore();
      }

      ctx.restore();

      // Analog horizontal glitch: shift a few random slices of the finished frame.
      if (glitching) this._glitchBands(ctx, bw, bh, dpr);
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

  return WidgetTesoSeal;
});
