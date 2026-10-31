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
  WidgetTerminalCube — объёмный куб темы Terminal.

  Геометрия та же, что у кубов Pixel Perfect, Wardogs и Super Four, но грань
  нарисована как панель терминала: тёмное стекло с зелёным контуром и свечением
  по кромке, а за кубом идёт «цифровой дождь» из глифов. Иконка активного
  алерта наклеена на все грани и вращается вместе с кубом.

  Куба нет на экране, пока не играет алерт; алерты идут по одному, донат даёт
  короткий «поп». Тема изолирована жёстко: на чужой теме цикл не поднимается.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetTerminalCube = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetTerminalCube;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetTerminalCube = WidgetTerminalCube;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  // Запасные цвета — палитра Terminal; живые значения читаются из токенов.
  const DEFAULT_FACE = "#161b22";
  const DEFAULT_EDGE = "#00ff66";
  const DEFAULT_GLOW = "rgba(0, 255, 102, 0.25)";
  const DEFAULT_DIM = "#0d1117";
  const DEFAULT_INK = "#00ff66";

  // Глифы дождя: латиница, цифры и катакана — как в «Матрице».
  const GLYPHS = "01アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789";

  // Вершины куба (полуразмер 1).
  const VERTICES = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];

  // Шесть граней: обход вершин, центр и два касательных вектора для иконки.
  const FACES = [
    { q: [0, 1, 2, 3], c: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] }, // передняя
    { q: [4, 5, 6, 7], c: [0, 0, 1], u: [-1, 0, 0], v: [0, 1, 0] }, // задняя
    { q: [0, 3, 7, 4], c: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, // левая
    { q: [1, 2, 6, 5], c: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, // правая
    { q: [3, 2, 6, 7], c: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, // верхняя
    { q: [0, 1, 5, 4], c: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }, // нижняя
  ];

  class WidgetTerminalCube extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.faceColor = DEFAULT_FACE;
      this.edgeColor = DEFAULT_EDGE;
      this.glowColor = DEFAULT_GLOW;
      this.dimColor = DEFAULT_DIM;
      this.inkColor = DEFAULT_INK;

      this._popUntil = 0;
      this._iconQueue = [];
      this._iconKind = null;
      this._iconUntil = 0;
      this._iconImages = {};
      this._rain = null;
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не тратим ни canvas, ни подписки.
      if (this.theme !== "terminal") return;
      this._readColors();
      this._applyPerspective();
      this.bindEvents();
      // Скрыт до первого алерта — как фон алертов.
      this._setVisible(false);
      this.startRenderLoop(30);
    }

    onUnmount() {
      this._popUntil = 0;
      this._iconQueue = [];
      this._iconKind = null;
      this._iconUntil = 0;
      this._rain = null;
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective) this._applyPerspective();
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.faceColor = (read && read("--term-panel")) || DEFAULT_FACE;
      this.edgeColor = (read && read("--term-prompt")) || DEFAULT_EDGE;
      this.glowColor = (read && read("--term-glow")) || DEFAULT_GLOW;
      this.dimColor = (read && read("--term-bg")) || DEFAULT_DIM;
      this.inkColor = (read && read("--term-prompt")) || DEFAULT_INK;
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

    bindEvents() {
      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.ALERT, (alert) => this.queueAlert(alert));
    }

    // Алерты идут по одному, как карточки виджета алертов: иконки не
    // перекрывают друг друга.
    queueAlert(alert) {
      if (!alert) return;
      this._iconQueue.push(alert);
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
      this.later(() => this._drainIcon(), duration);
    }

    _setVisible(visible) {
      if (this.element) this.element.style.opacity = visible ? "1" : "0";
      this.setIdle(!visible);
    }

    pop() {
      this._popUntil = performance.now() + 450;
    }

    // Иконку алерта (shared/icons.js) растрируем в зелёный фосфор и кэшируем
    // по виду события: SVG красят currentColor, подставляем чернила темы.
    _iconImage(kind) {
      const icons = this.context.ICONS || {};
      const svg = icons[kind];
      if (!svg || typeof Image === "undefined") return null;
      const key = kind + "|" + this.inkColor;
      if (this._iconImages[key]) return this._iconImages[key];
      const colored = svg.split("currentColor").join(this.inkColor);
      const sized = colored.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ');
      const img = new Image();
      img.src = "data:image/svg+xml," + encodeURIComponent(sized);
      this._iconImages[key] = img;
      return img;
    }

    // Цифровой дождь: колонки глифов, падающие сверху вниз за кубом.
    _drawRain(ctx, cw, ch, now) {
      if (!this._rain) {
        const columns = Math.max(6, Math.round(cw / 26));
        this._rain = [];
        for (let i = 0; i < columns; i += 1) {
          this._rain.push({
            x: (i + 0.5) * (cw / columns),
            y: Math.random() * ch,
            speed: 40 + Math.random() * 90,
            glyphs: Array.from({ length: 8 }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]),
          });
        }
      }

      const dt = 1 / 30;
      ctx.font = "12px var(--font-mono, monospace)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const column of this._rain) {
        column.y += column.speed * dt;
        if (column.y - column.glyphs.length * 14 > ch) column.y = -14;
        for (let i = 0; i < column.glyphs.length; i += 1) {
          const y = column.y - i * 14;
          if (y < -14 || y > ch + 14) continue;
          const fade = 1 - i / column.glyphs.length;
          ctx.fillStyle = this.edgeColor;
          ctx.globalAlpha = 0.06 + fade * 0.2;
          ctx.fillText(column.glyphs[i], column.x, y);
        }
        // Голова колонки — ярче остальных.
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = this.edgeColor;
        ctx.fillText("█", column.x, column.y);
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
      void now;
    }

    render() {
      if (this.theme !== "terminal") return;
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

      let scale = 1 + 0.03 * Math.sin(t * 1.7);
      if (now < this._popUntil) {
        const k = 1 - (this._popUntil - now) / 450;
        scale *= 1 + 0.16 * Math.sin(Math.PI * k);
      }
      scale = clamp(scale, 0.8, 1.25);

      const cx = cw / 2 + Math.sin(t * 0.6) * 4;
      const cy = ch / 2 + Math.cos(t * 0.5) * 3 + Math.sin(t * 1.4) * 2;
      const size = Math.min(cw, ch) * 0.28 * scale;

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

      const faces = FACES.map((face) => {
        const pts3 = face.q.map((i) => project(VERTICES[i]));
        const pts = pts3.map((p) => ({ x: cx + p.x * size, y: cy - p.y * size }));
        const depth = pts3.reduce((sum, p) => sum + p.z, 0) / pts3.length;
        const center3 = project(face.c);
        return { face, pts, depth, center3 };
      });

      let minDepth = Infinity;
      let maxDepth = -Infinity;
      for (const f of faces) {
        if (f.depth < minDepth) minDepth = f.depth;
        if (f.depth > maxDepth) maxDepth = f.depth;
      }
      const span = maxDepth - minDepth || 1;

      // Дальние грани рисуются первыми, ближние закрывают их.
      faces.sort((a, b) => a.depth - b.depth);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      // Дождь идёт за кубом: сначала он, потом грани.
      this._drawRain(ctx, cw, ch, now);

      for (const f of faces) {
        const d = clamp((f.depth - minDepth) / span, 0, 1);

        ctx.beginPath();
        f.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.fillStyle = this.faceColor;
        ctx.globalAlpha = 0.35 + d * 0.35;
        ctx.fill();
        ctx.globalAlpha = 1;

        // Зелёный контур с мягким свечением — грань читается как экран.
        ctx.beginPath();
        f.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.strokeStyle = this.edgeColor;
        ctx.globalAlpha = 0.35 + d * 0.55;
        ctx.lineWidth = d >= 0.5 ? 1.6 : 1;
        ctx.shadowColor = this.glowColor;
        ctx.shadowBlur = 10 * d;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;

        // Иконка события на грани, гаснет с глубиной.
        if (this._iconKind && now < this._iconUntil) {
          const img = this._iconImage(this._iconKind);
          if (img && img.complete && img.naturalWidth) {
            const face = f.face;
            const pu = project(face.u);
            const pv = project(face.v);
            const remaining = this._iconUntil - now;
            const fade = Math.max(0, Math.min(1, remaining / 400));
            const half = 0.52;

            ctx.save();
            ctx.globalAlpha = fade * (0.18 + d * 0.82);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.transform(
              size * pu.x,
              -size * pu.y,
              size * pv.x,
              -size * pv.y,
              cx + size * f.center3.x,
              cy - size * f.center3.y
            );
            ctx.drawImage(img, -half, -half, 2 * half, 2 * half);
            ctx.restore();
          }
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  return WidgetTerminalCube;
});
