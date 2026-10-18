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
  WidgetRetrowaveSymbol — rotating neon wireframe globe for the Retrowave theme.

  A sphere of meridians and parallels spins around its own axis with a slight
  axial tilt; front segments glow cyan, back segments fade to magenta, and a
  primary-coloured ring circles the equator. There is no solid fill: the sign is
  light on top of the stream, not a panel.

  Like the Wardogs and Pixel decorative signs it is invisible while nothing is
  happening and appears on an alert, one at a time, popping harder on donations.
  Between alerts it only spins in place — no drift — so the scene never shifts.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetRetrowaveSymbol = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetRetrowaveSymbol;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetRetrowaveSymbol = WidgetRetrowaveSymbol;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_PRIMARY = "#ff2d95";
  const DEFAULT_SECONDARY = "#2de2e6";
  const DEFAULT_ALERT_MS = 5000;

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  // Camera distance in sphere radii: larger values flatten the perspective,
  // smaller ones bulge the near hemisphere. 3.4 keeps the globe readable while
  // still giving the rotation visible depth.
  const CAMERA = 3.4;

  const TILT = -0.42; // axial tilt, radians
  const SPIN = 0.5; // radians per second

  const PARALLELS = [-67.5, -45, -22.5, 0, 22.5, 45, 67.5];
  const MERIDIANS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

  class WidgetRetrowaveSymbol extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.primary = DEFAULT_PRIMARY;
      this.secondary = DEFAULT_SECONDARY;

      this._queue = [];
      this._visibleUntil = 0;
      this._popUntil = 0;
      this._popAmp = 0;
    }

    onMount() {
      // HARD theme gate: no canvas, no loop, no events on a foreign theme.
      if (this.theme !== "retrowave") return;

      this._readColors();
      this._applyPerspective();
      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this._queueAlert(alert));
      // Hidden until the first alert, like the Pixel and Wardogs signs.
      this._setVisible(false);
      this.startRenderLoop(30);
    }

    onUnmount() {
      this._queue = [];
      this._visibleUntil = 0;
      this._popUntil = 0;
      this._popAmp = 0;
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective) this._applyPerspective();
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.primary = (read && read("--md-primary")) || DEFAULT_PRIMARY;
      this.secondary = (read && read("--md-secondary")) || DEFAULT_SECONDARY;
    }

    _applyPerspective() {
      const v = Math.max(0, Math.min(100, Number(this.config.perspective) || 0));
      if (v > 0) {
        const ry = -(v * 0.15);
        const rx = v * 0.03;
        this.element.style.transform = `perspective(1200px) rotateY(${ry}deg) rotateX(${rx}deg)`;
        this.element.style.transformStyle = "preserve-3d";
      } else {
        this.element.style.transform = "";
        this.element.style.transformStyle = "";
      }
    }

    // ---- visibility / reaction ----

    _queueAlert(alert) {
      if (!alert) return;
      this._queue.push(alert);
      if (performance.now() >= this._visibleUntil) this._drain();
    }

    _drain() {
      const alert = this._queue.shift();
      if (!alert) {
        this._visibleUntil = 0;
        this._setVisible(false);
        return;
      }
      const duration = alert.durationMs || DEFAULT_ALERT_MS;
      this._visibleUntil = performance.now() + duration;
      this._setVisible(true);
      this._pop(alert.kind);
      this.later(() => this._drain(), duration);
    }

    _setVisible(visible) {
      if (this.element) this.element.style.opacity = visible ? "1" : "0";
      this.setIdle(!visible);
    }

    // A short scale pop on every alert; a donation pops noticeably harder.
    _pop(kind) {
      this._popUntil = performance.now() + 450;
      this._popAmp = kind === "donation" ? 0.18 : 0.09;
    }

    // ---- rendering ----

    render() {
      if (this.theme !== "retrowave") return;
      const ctx = this.ctx;
      if (!ctx || !this.canvas) return;

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

      let scale = 1;
      if (now < this._popUntil) {
        const k = 1 - (this._popUntil - now) / 450; // 0..1 over the pop
        scale += this._popAmp * Math.sin(Math.PI * k);
      }
      scale = clamp(scale, 0.85, 1.5);

      const cx = cw / 2;
      const cy = ch / 2;
      const radius = Math.min(cw, ch) * 0.38 * scale;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      // Soft neon halo so the wireframe reads over bright gameplay.
      const halo = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 2.1);
      halo.addColorStop(0, this._rgba(this.primary, 0.22));
      halo.addColorStop(0.55, this._rgba(this.secondary, 0.10));
      halo.addColorStop(1, this._rgba(this.primary, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, cw, ch);

      const yaw = t * SPIN;
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const cosT = Math.cos(TILT);
      const sinT = Math.sin(TILT);

      // Project a unit-sphere point (or one scaled past the surface, for the
      // ring) into screen space with a simple perspective divide.
      const project = (x, y, z, r) => {
        const x1 = x * cosY + z * sinY;
        const z1 = -x * sinY + z * cosY;
        const y2 = y * cosT - z1 * sinT;
        const z2 = y * sinT + z1 * cosT;
        const persp = CAMERA / (CAMERA - z2);
        return { x: cx + x1 * r * persp, y: cy - y2 * r * persp, z: z2 };
      };

      const front = [];
      const back = [];
      const pushSegment = (a, b) => {
        ((a.z + b.z) / 2 >= 0 ? front : back).push([a, b]);
      };

      // Parallels.
      for (const lat of PARALLELS) {
        const phi = (lat * Math.PI) / 180;
        const ry = Math.sin(phi);
        const rr = Math.cos(phi);
        let prev = null;
        for (let i = 0; i <= 48; i++) {
          const lon = (i / 48) * Math.PI * 2;
          const p = project(Math.cos(lon) * rr, ry, Math.sin(lon) * rr, radius);
          if (prev) pushSegment(prev, p);
          prev = p;
        }
      }

      // Meridians.
      for (const lonDeg of MERIDIANS) {
        const lon = (lonDeg * Math.PI) / 180;
        const rx = Math.cos(lon);
        const rz = Math.sin(lon);
        let prev = null;
        for (let i = 0; i <= 24; i++) {
          const phi = -Math.PI / 2 + (i / 24) * Math.PI;
          const p = project(Math.cos(phi) * rx, Math.sin(phi), Math.cos(phi) * rz, radius);
          if (prev) pushSegment(prev, p);
          prev = p;
        }
      }

      // Equatorial ring, tilted with the globe: the ring gives the sphere an
      // unmistakable silhouette even when it is small in the layout.
      let prevRing = null;
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        const p = project(Math.cos(a) * 1.42, 0, Math.sin(a) * 1.42, radius);
        if (prevRing) pushSegment(prevRing, p);
        prevRing = p;
      }

      this._strokeSegments(ctx, back, this._rgba(this.primary, 0.22), 0.8, 0);
      this._strokeSegments(ctx, front, this._rgba(this.secondary, 0.62), 0.9, 7);

      // The equator is the bright seam of the sign: draw it on top, in the
      // theme's main accent, with a stronger bloom.
      ctx.save();
      ctx.strokeStyle = this.primary;
      ctx.lineWidth = 1.6;
      ctx.shadowBlur = 12;
      ctx.shadowColor = this.primary;
      ctx.beginPath();
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        const p = project(Math.cos(a), 0, Math.sin(a), radius);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    _strokeSegments(ctx, segments, color, width, blur) {
      if (!segments.length) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.shadowBlur = blur;
      ctx.shadowColor = color;
      ctx.beginPath();
      for (const [a, b] of segments) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // `#rrggbb` + alpha -> `rgba(...)`. Keeps theme colours intact while the
    // depth pass only varies opacity.
    _rgba(hex, alpha) {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
      if (!m) return `rgba(255, 45, 149, ${alpha})`;
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }
  }

  return WidgetRetrowaveSymbol;
});
