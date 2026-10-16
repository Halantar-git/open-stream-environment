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
  WidgetWardogsCube — rotating isometric cube for the Wardogs theme, built
  entirely from the emblem (assets/themes/wardogs/logo.png) decaled onto all six
  faces in the emblem's own colours, on solid faces — no wireframe.

  Each face is filled with the theme's panel background before the emblem goes
  on, so the cube is dense: nearer faces hide the farther ones. The fill is
  lit by the face normal, otherwise a cube of identical panels would read as a
  flat blob.

  Like the Pixel cube it is hidden while nothing is happening and appears on an
  alert, one alert at a time; donations also make it pop. Between alerts it only
  spins in place — no drift or breathing, so it stays put in the scene.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetWardogsCube = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetWardogsCube;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetWardogsCube = WidgetWardogsCube;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  const LOGO_PATH = "/assets/themes/wardogs/logo.png";
  const DEFAULT_ALERT_MS = 5000;

  const PANEL_FALLBACK = [9, 9, 9]; // rgba(9, 9, 9, 0.90) из темы
  const LIT_FALLBACK = [44, 42, 36]; // #2c2a24 (--md-surface-bright)

  // Свет сверху-слева: грань тем светлее, чем сильнее её нормаль смотрит на
  // источник. Направление задано в экранных координатах (как у проекции).
  const LIGHT = (() => {
    const v = [-0.35, 0.7, 0.62];
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  })();

  // "rgb()", "rgba()" или "#hex" -> [r, g, b]; null, если не разобрать.
  function toRgb(color) {
    const text = String(color || "").trim();
    const rgb = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!hex) return null;
    const full = hex[1].length === 3
      ? hex[1].split("").map((ch) => ch + ch).join("")
      : hex[1];
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }

  // Цвет грани между тенью и светом.
  function mixColor(from, to, t) {
    const channel = (i) => Math.round(from[i] + (to[i] - from[i]) * t);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
  }

  // The 6 cube faces for decaling the emblem: center + two in-plane tangent
  // vectors (face-local x/y axes). Front/back/left/right/top/bottom. The emblem
  // is drawn with a further 180° turn (see render), since these axes come from
  // the symmetric Pixel icon and leave the emblem upside down.
  const LOGO_FACES = [
    { c: [0, 0, -1], u: [1, 0, 0],  v: [0, 1, 0] },  // front
    { c: [0, 0, 1],  u: [-1, 0, 0], v: [0, 1, 0] },  // back
    { c: [-1, 0, 0], u: [0, 0, 1],  v: [0, 1, 0] },  // left
    { c: [1, 0, 0],  u: [0, 0, -1], v: [0, 1, 0] },  // right
    { c: [0, 1, 0],  u: [1, 0, 0],  v: [0, 0, -1] }, // top
    { c: [0, -1, 0], u: [1, 0, 0],  v: [0, 0, -1] }, // bottom
  ];

  class WidgetWardogsCube extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";
      this._logo = null; // source <img>, loaded once
      this._shadow = PANEL_FALLBACK; // unlit face colour (panel background)
      this._lit = LIT_FALLBACK; // fully lit face colour
      this._queue = []; // alerts waiting for their turn
      this._visibleUntil = 0; // while > now the cube is shown
      this._popUntil = 0; // active "pop" window (alert reaction)
      this._popAmp = 0; // pop strength (donations hit harder)
    }

    onMount() {
      // HARD theme gate: no canvas, no loop, no events on a non-Wardogs theme.
      if (this.theme !== "wardogs") return;

      this._ensureLogo();
      this._readFaceColors();
      this._applyPerspective();
      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this._queueAlert(alert));
      // Hidden until the first alert, like the Pixel cube.
      this._setVisible(false);
      this.startRenderLoop(30);
    }

    onUnmount() {
      this._logo = null;
      this._queue = [];
      this._visibleUntil = 0;
      this._popUntil = 0;
      this._popAmp = 0;
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective) this._applyPerspective();
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

    // Alerts are shown one at a time, like the Pixel cube drains its icons, so
    // they never overwrite each other. Only an alert brings the cube on screen.
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
      this._popAmp = kind === "donation" ? 0.16 : 0.08;
    }

    _ensureLogo() {
      if (this._logo || typeof Image === "undefined") return;
      const img = new Image();
      img.src = LOGO_PATH;
      this._logo = img;
    }

    // Faces are filled with the theme's panel background (shared with every
    // Wardogs widget) and lit up to the bright surface; the panel colour is
    // semi-transparent, which the dense cube cannot use, so alpha is dropped.
    _readFaceColors() {
      const read = this.context.readCssVar;
      this._shadow = toRgb(read && read("--panel-bg")) || PANEL_FALLBACK;
      this._lit = toRgb(read && read("--md-surface-bright")) || LIT_FALLBACK;
    }

    // The emblem is drawn in its own colours (black shield, white wolf) exactly
    // as the game uses it, so it reads over whatever gameplay sits behind.
    _logoImage() {
      const img = this._logo;
      if (!img || !img.complete || !img.naturalWidth) return null;
      return img;
    }

    render() {
      if (this.theme !== "wardogs") return;
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

      let scale = 1;
      if (now < this._popUntil) {
        const k = 1 - (this._popUntil - now) / 450; // 0..1 over the pop
        scale += this._popAmp * Math.sin(Math.PI * k);
      }
      scale = clamp(scale, 0.8, 1.4);

      const cx = cw / 2;
      const cy = ch / 2;
      const size = Math.min(cw, ch) * 0.3 * scale;

      // Спин всегда включён — куб только вращается, а не плавает по холсту.
      const angle = t * 0.7;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const tilt = -0.55;
      const cosT = Math.cos(tilt);
      const sinT = Math.sin(tilt);

      const project = (v) => {
        const x = v[0] * cosA + v[2] * sinA;
        const y = v[1];
        const z = -v[0] * sinA + v[2] * cosA;
        return { x, y: y * cosT - z * sinT, z: y * sinT + z * cosT };
      };

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      // Every face is a solid panel with the emblem on it, drawn back to front
      // so nearer faces cover the farther ones.
      const logo = this._logoImage();
      const faces = LOGO_FACES.map((f) => {
        const pc = project(f.c);
        const pu = project(f.u);
        const pv = project(f.v);
        const light = clamp(pc.x * LIGHT[0] + pc.y * LIGHT[1] + pc.z * LIGHT[2], 0, 1);
        return {
          a: size * pu.x,
          b: -size * pu.y,
          c: size * pv.x,
          d: -size * pv.y,
          e: cx + size * pc.x,
          f: cy - size * pc.y,
          depth: pc.z,
          fill: mixColor(this._shadow, this._lit, light),
        };
      }).sort((p, q) => p.depth - q.depth);

      for (const face of faces) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.transform(face.a, face.b, face.c, face.d, face.e, face.f);
        // Face spans -1..1 in its own axes; the panel fills it, the emblem sits on top.
        ctx.fillStyle = face.fill;
        ctx.fillRect(-1, -1, 2, 2);
        if (!logo) continue;
        // Эмблему разворачиваем на 180°: оси граней рассчитаны на симметричный
        // значок Pixel, и без разворота лого встаёт вверх ногами. Логотип при
        // этом лежит в плоскости грани и крутится вместе с кубом.
        ctx.rotate(Math.PI);
        ctx.drawImage(logo, -1, -1, 2, 2);
      }
    }
  }

  return WidgetWardogsCube;
});
