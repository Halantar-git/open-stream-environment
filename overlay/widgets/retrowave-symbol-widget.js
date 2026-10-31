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
  axial tilt; front segments glow cyan, back segments fade to magenta, and the
  icon of the active event travels along the equator. There is no solid fill
  and no backdrop: the sign is light on top of the stream, not a panel, so the
  scene stays transparent behind it.

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
      this._iconKind = null;
      this._iconImages = {};
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
      this._iconKind = null;
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
        this._setTilt(`perspective(1200px) rotateY(${ry}deg) rotateX(${rx}deg)`);
      } else {
        this._setTilt("");
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
        this._iconKind = null;
        this._setVisible(false);
        return;
      }
      const duration = alert.durationMs || DEFAULT_ALERT_MS;
      this._visibleUntil = performance.now() + duration;
      this._iconKind = alert.kind || null;
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

    // Иконка активного события — тот же приём, что у кубов: SVG красим
    // currentColor в цвет темы и кэшируем растровую копию по виду события.
    _iconImage(kind) {
      const icons = this.context.ICONS || {};
      const svg = icons[kind];
      if (!svg || typeof Image === "undefined") return null;
      const key = kind + "|" + this.secondary;
      if (this._iconImages[key]) return this._iconImages[key];
      const colored = svg.split("currentColor").join(this.secondary);
      const sized = colored.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ');
      const img = new Image();
      img.src = "data:image/svg+xml," + encodeURIComponent(sized);
      this._iconImages[key] = img;
      return img;
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

      // Никакой подложки: знак — только неоновые линии поверх игры. Раньше
      // здесь был радиальный градиент, и на светлой игре он читался как
      // цветное пятно за сферой.
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

      // Три полосы глубины вместо двух: ближняя сетка светится ярче средней,
      // а задняя почти гаснет — сфера читается объёмной и без подложки.
      const back = [];
      const mid = [];
      const near = [];
      const pushSegment = (a, b) => {
        const z = (a.z + b.z) / 2;
        if (z < 0) back.push([a, b]);
        else if (z < 0.55) mid.push([a, b]);
        else near.push([a, b]);
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

      // Сетка тремя полосами глубины; большого кольца вокруг сферы больше
      // нет — оно вылезало за силуэт и читалось как лишний фон.
      this._strokeSegments(ctx, back, this._rgba(this.primary, 0.18), 0.8, 0);
      this._strokeSegments(ctx, mid, this._rgba(this.secondary, 0.5), 0.9, 4);
      this._strokeSegments(ctx, near, this._rgba(this.secondary, 0.9), 1, 9);

      this._drawLimb(ctx, cx, cy, radius);
      this._drawEquator(ctx, project, radius, t);
      this._drawPoles(ctx, project, radius);
    }

    // Силуэт сферы: тонкий градиентный обод. Он держит форму даже когда сетка
    // на дальней стороне почти погасла.
    _drawLimb(ctx, cx, cy, radius) {
      const grad = ctx.createLinearGradient(cx, cy - radius, cx, cy + radius);
      grad.addColorStop(0, this._rgba(this.secondary, 0.85));
      grad.addColorStop(1, this._rgba(this.primary, 0.85));
      ctx.save();
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.4;
      ctx.shadowColor = this.secondary;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.05, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Экватор — яркий шов знака; по нему бежит иконка события, а не точка:
    // тип события читается прямо со знака. Без иконки остаётся свечение.
    _drawEquator(ctx, project, radius, t) {
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

      const a = t * 1.1;
      const p = project(Math.cos(a), 0, Math.sin(a), radius);
      const behind = p.z < 0;
      const img = this._iconKind ? this._iconImage(this._iconKind) : null;

      if (img && img.complete && img.naturalWidth) {
        // Иконка не вращается вместе с сеткой — она висит по экватору
        // ровно, как маркер на карте.
        const size = Math.max(12, radius * 0.46);
        ctx.save();
        ctx.globalAlpha = behind ? 0.4 : 1;
        ctx.shadowColor = this.secondary;
        ctx.shadowBlur = behind ? 8 : 16;
        ctx.drawImage(img, p.x - size / 2, p.y - size / 2, size, size);
        ctx.restore();
        return;
      }

      ctx.save();
      ctx.globalAlpha = behind ? 0.35 : 1;
      ctx.fillStyle = behind ? this.primary : this.secondary;
      ctx.shadowColor = this.secondary;
      ctx.shadowBlur = behind ? 6 : 16;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.4, radius * 0.045), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Полюса — две неоновые точки на оси: без них сетка выглядит обрезанной.
    _drawPoles(ctx, project, radius) {
      [1, -1].forEach((sign) => {
        const p = project(0, sign, 0, radius);
        ctx.save();
        ctx.fillStyle = this.secondary;
        ctx.shadowColor = this.secondary;
        ctx.shadowBlur = 10;
        ctx.globalAlpha = p.z < 0 ? 0.4 : 0.95;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1.2, radius * 0.03), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
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
