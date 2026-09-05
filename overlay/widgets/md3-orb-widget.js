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
  tertiary elliptical ring. It breathes, sways and "pops" on donations.

  Like the Pixel Perfect cube, it is alert-driven: hidden until the first alert,
  the active alert's icon is decaled onto the sphere and spins with it (a
  billboard badge in the MD3 language — soft tonal shading, no additive glow, no
  glitch). Alerts are queued and drained one at a time; donations also pop.
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

  const DEFAULT_PRIMARY = "#94cbf9";
  const DEFAULT_SECONDARY = "#aac6e3";
  const DEFAULT_TERTIARY = "#94e9f9";
  const DEFAULT_ON_PRIMARY = "#0f283d";

  class WidgetMd3Orb extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      // Active theme id, injected by the manager via context.
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.colors = {
        primary: DEFAULT_PRIMARY,
        secondary: DEFAULT_SECONDARY,
        tertiary: DEFAULT_TERTIARY,
        onPrimary: DEFAULT_ON_PRIMARY,
      };
      this._popUntil = 0;
      this._iconQueue = [];
      this._iconKind = null;
      this._iconUntil = 0;
      this._iconImages = {};
    }

    onMount() {
      // HARD theme gate: never spin up the loop or draw on a non-MD3 theme.
      if (this.theme !== "nebula") return;

      this._readColors();
      this._applyPerspective();
      this.bindEvents();
      // Hidden until the first alert — like the Pixel Perfect cube.
      this._setVisible(false);
      this.startRenderLoop(30); // strictly 30 FPS
    }

    onUnmount() {
      this._popUntil = 0;
      this._iconQueue = [];
      this._iconKind = null;
      this._iconUntil = 0;
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective) this._applyPerspective();
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.colors.primary = (read && read("--md-primary")) || DEFAULT_PRIMARY;
      this.colors.secondary = (read && read("--md-secondary")) || DEFAULT_SECONDARY;
      this.colors.tertiary = (read && read("--md-tertiary")) || DEFAULT_TERTIARY;
      this.colors.onPrimary = (read && read("--md-on-primary")) || DEFAULT_ON_PRIMARY;

      // Smooth MD3 fade in/out while staying hidden between alerts.
      if (this.element) {
        const easing =
          (read && read("--alert-enter-easing")) || "cubic-bezier(0.05, 0.7, 0.1, 1)";
        this.element.style.transition = `opacity 260ms ${easing}`;
      }
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
      this.subscribe(EVENT_TYPES.ALERT, (alert) => this.queueAlert(alert));
    }

    // Queue alerts so their icons are shown one at a time, like the alerts
    // widget drains its cards. Icons never overwrite each other.
    queueAlert(alert) {
      if (!alert) return;
      this._iconQueue.push(alert);
      // Start draining only when no icon is currently displayed.
      if (!this._iconKind || performance.now() >= this._iconUntil) this._drainIcon();
    }

    _drainIcon() {
      const alert = this._iconQueue.shift();
      if (!alert) {
        this._iconKind = null;
        this._iconUntil = 0;
        this._setVisible(false);
        return;
      }
      const duration = alert.durationMs || 5000;
      this._iconKind = alert.kind || null;
      this._iconUntil = performance.now() + duration;
      this._setVisible(true);
      if (alert.kind === "donation") this.pop();
      // Advance to the next queued icon once this one has finished.
      this.later(() => this._drainIcon(), duration);
    }

    _setVisible(visible) {
      if (this.element) this.element.style.opacity = visible ? "1" : "0";
      this.setIdle(!visible);
    }

    pop() {
      this._popUntil = performance.now() + 450;
    }

    // Lazy-loads the alert icon (shared/icons.js) as an on-primary-coloured
    // 24x24 SVG raster so it can be drawn onto the orb canvas. Cached per
    // kind + colour.
    _iconImage(kind) {
      const icons = this.context.ICONS || {};
      const svg = icons[kind];
      if (!svg || typeof Image === "undefined") return null;
      const key = kind + "|" + this.colors.onPrimary;
      if (this._iconImages[key]) return this._iconImages[key];
      const colored = svg.split("currentColor").join(this.colors.onPrimary);
      const sized = colored.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ');
      const img = new Image();
      img.src = "data:image/svg+xml," + encodeURIComponent(sized);
      this._iconImages[key] = img;
      return img;
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

      // Breathing scale + a quick "pop" on donations.
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
      const R = Math.min(cw, ch) * 0.33 * scale;

      // Soft outer halo.
      ctx.save();
      ctx.fillStyle = rgba(primary, 0.16);
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.2, 0, Math.PI * 2);
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
      ctx.arc(0, 0, R * 1.08, 0, Math.PI * 2);
      ctx.restore();
      ctx.stroke();
      ctx.restore();

      // Secondary orbiting dot (depth via the elliptical path).
      const orbitA = t * 1.1;
      const ox = cx + Math.cos(orbitA) * R * 1.08;
      const oy = cy + Math.sin(orbitA) * R * 0.36 * 1.08;
      ctx.save();
      ctx.fillStyle = secondary;
      ctx.shadowColor = secondary;
      ctx.shadowBlur = 12 * dpr;
      ctx.beginPath();
      ctx.arc(ox, oy, Math.max(1.5, R * 0.09), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Alert icon decaled onto the sphere, spinning like a 3D badge. Fades
      // out over the last 400ms of the alert.
      if (this._iconKind && now < this._iconUntil) {
        const img = this._iconImage(this._iconKind);
        if (img && img.complete && img.naturalWidth) {
          const remaining = this._iconUntil - now;
          const alpha = Math.max(0, Math.min(1, remaining / 400));
          // Billboard spin around the vertical axis, kept front-facing with a
          // minimum width so the glyph never fully disappears.
          const sx = Math.max(0.12, Math.abs(Math.cos(t * 1.3)));
          const tilt = Math.sin(t * 0.5) * 0.08;
          const h = R * 0.55;
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(cx, cy);
          ctx.rotate(tilt);
          ctx.scale(sx, 1);
          ctx.drawImage(img, -h, -h, h * 2, h * 2);
          ctx.restore();
        }
      }
    }
  }

  return WidgetMd3Orb;
});
