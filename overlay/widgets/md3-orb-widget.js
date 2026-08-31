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
  WidgetMd3Orb — soft 3D sphere for the Material You theme.

  A floating tonal sphere (Material 3 depth) drawn with a diagonal light→dark
  gradient, a specular highlight, a secondary-colored orbiting dot and a
  tertiary elliptical ring. It breathes, sways and "pops" on chat/donations.

  Unlike the neon Star Citizen / Nuclear signs, this one keeps the MD3
  language: soft tonal shading, no additive glow, no glitch.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetMd3Orb = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetMd3Orb;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetMd3Orb = WidgetMd3Orb;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  function hexToRgb(hex) {
    const m = String(hex).replace("#", "").match(/^([0-9a-f]{6})$/i);
    const h = m ? m[1] : "888888";
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgba(hex, a) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  function shade(hex, amt) {
    // amt > 0 lightens toward white, amt < 0 darkens toward black.
    const target = amt >= 0 ? [255, 255, 255] : [0, 0, 0];
    const k = Math.abs(amt);
    const [r, g, b] = hexToRgb(hex);
    const m = (v, tv) => Math.round(v + (tv - v) * k);
    return `rgb(${m(r, target[0])}, ${m(g, target[1])}, ${m(b, target[2])})`;
  }

  const DEFAULT_PRIMARY = "#d0bcff";
  const DEFAULT_SECONDARY = "#ccc2dc";
  const DEFAULT_TERTIARY = "#efb8c8";

  class WidgetMd3Orb extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      // Active theme id, injected by the manager via context.
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.colors = { primary: DEFAULT_PRIMARY, secondary: DEFAULT_SECONDARY, tertiary: DEFAULT_TERTIARY };
      this._popUntil = 0;
    }

    onMount() {
      // HARD theme gate: never spin up the loop or draw on a non-MD3 theme.
      if (this.theme !== "nebula") return;

      this._readColors();
      this._applyPerspective();
      this.bindEvents();
      this.startRenderLoop(30); // strictly 30 FPS
    }

    onUnmount() {
      this._popUntil = 0;
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective) this._applyPerspective();
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.colors.primary = (read && read("--md-primary")) || DEFAULT_PRIMARY;
      this.colors.secondary = (read && read("--md-secondary")) || DEFAULT_SECONDARY;
      this.colors.tertiary = (read && read("--md-tertiary")) || DEFAULT_TERTIARY;
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

    bindEvents() {
      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.CHAT_MESSAGE, () => this.pop());
      this.subscribe(EVENT_TYPES.ALERT, (alert) => {
        if (alert && alert.kind === "donation") this.pop();
      });
    }

    pop() {
      this._popUntil = performance.now() + 450;
    }

    render() {
      if (this.theme !== "nebula") return;
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
      const { primary, secondary, tertiary } = this.colors;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      // Breathing scale + a quick "pop" on donations/chat.
      let scale = 1 + 0.035 * Math.sin(t * 1.6);
      if (now < this._popUntil) {
        const k = 1 - (this._popUntil - now) / 450;
        scale *= 1 + 0.18 * Math.sin(Math.PI * k);
      }
      scale = clamp(scale, 0.8, 1.25);

      // Gentle sway.
      const swayX = Math.sin(t * 0.5) * 4;
      const swayY = Math.cos(t * 0.4) * 3;
      const cx = cw / 2 + swayX;
      const cy = ch / 2 + swayY;
      const R = Math.min(cw, ch) * 0.4 * scale;

      // Soft outer halo.
      ctx.save();
      ctx.fillStyle = rgba(primary, 0.16);
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Sphere body — diagonal light (top-left) → dark (bottom-right).
      ctx.save();
      const grad = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      grad.addColorStop(0, shade(primary, 0.5));
      grad.addColorStop(0.45, primary);
      grad.addColorStop(1, shade(primary, -0.55));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Specular highlight.
      ctx.save();
      ctx.fillStyle = "rgba(255, 255, 255, 0.42)";
      ctx.beginPath();
      ctx.arc(cx - R * 0.36, cy - R * 0.4, R * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Tertiary elliptical ring (pseudo-3D orbit plane).
      ctx.save();
      ctx.strokeStyle = rgba(tertiary, 0.55);
      ctx.lineWidth = Math.max(1, R * 0.03);
      ctx.beginPath();
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, 0.36);
      ctx.arc(0, 0, R * 1.12, 0, Math.PI * 2);
      ctx.restore();
      ctx.stroke();
      ctx.restore();

      // Secondary orbiting dot (depth via the elliptical path).
      const orbitA = t * 1.1;
      const ox = cx + Math.cos(orbitA) * R * 1.12;
      const oy = cy + Math.sin(orbitA) * R * 0.36 * 1.12;
      ctx.save();
      ctx.fillStyle = secondary;
      ctx.shadowColor = secondary;
      ctx.shadowBlur = 12 * dpr;
      ctx.beginPath();
      ctx.arc(ox, oy, Math.max(1.5, R * 0.09), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  return WidgetMd3Orb;
});
