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
  WidgetSfCube — каркасный куб темы Super Four.

  Тот же изометрический куб, что у Pixel Perfect и Wardogs: только рёбра,
  иконка активного алерта наклеена на все шесть граней и вращается вместе с
  кубом. В Super Four рёбра светятся неоновым glowColor темы, а близкие линии
  получают мягкий ореол — так куб читается на ночном фоне бака и не выглядит
  чужой геометрией рядом с тахометром.

  Куба нет на экране, пока не играет алерт; алерты идут по одному, донат даёт
  короткий «поп». Тема изолирована жёстко: на чужой теме цикл не поднимается.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetSfCube = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetSfCube;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetSfCube = WidgetSfCube;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  // Неоновый glowColor темы; в приложении берётся из `--sf-glow`.
  const DEFAULT_ACCENT = "#9d4edd";

  // Вершины куба (полуразмер 1).
  const VERTICES = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];

  // Двенадцать рёбер как пары индексов вершин (низ, верх, вертикали).
  const EDGES = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  // Шесть граней для наклейки иконки: центр и два касательных вектора в
  // плоскости грани (локальные оси x/y). Передняя/задняя/левая/правая/верх/низ.
  const ICON_FACES = [
    { c: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] }, // передняя
    { c: [0, 0, 1], u: [-1, 0, 0], v: [0, 1, 0] }, // задняя
    { c: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, // левая
    { c: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, // правая
    { c: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, // верхняя
    { c: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }, // нижняя
  ];

  class WidgetSfCube extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";
      this.accent = DEFAULT_ACCENT;
      this._popUntil = 0;
      this._iconQueue = [];
      this._iconKind = null;
      this._iconUntil = 0;
      this._iconImages = {};
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не тратим ни canvas, ни подписки.
      if (this.theme !== "sf") return;
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
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective) this._applyPerspective();
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.accent = (read && read("--sf-glow")) || (read && read("--md-primary")) || DEFAULT_ACCENT;
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

    // Иконку алерта (shared/icons.js) растрируем в цвет рёбер и кэшируем по
    // виду события: SVG красят currentColor, подставляем акцент темы.
    _iconImage(kind) {
      const icons = this.context.ICONS || {};
      const svg = icons[kind];
      if (!svg || typeof Image === "undefined") return null;
      const key = kind + "|" + this.accent;
      if (this._iconImages[key]) return this._iconImages[key];
      const colored = svg.split("currentColor").join(this.accent);
      const sized = colored.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ');
      const img = new Image();
      img.src = "data:image/svg+xml," + encodeURIComponent(sized);
      this._iconImages[key] = img;
      return img;
    }

    render() {
      if (this.theme !== "sf") return;
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

      const pts = VERTICES.map(project);

      const edges = EDGES.map(([a, b]) => {
        const pa = pts[a];
        const pb = pts[b];
        return {
          x1: cx + pa.x * size,
          y1: cy - pa.y * size,
          x2: cx + pb.x * size,
          y2: cy - pb.y * size,
          depth: (pa.z + pb.z) / 2,
        };
      });

      let minDepth = Infinity;
      let maxDepth = -Infinity;
      for (const e of edges) {
        if (e.depth < minDepth) minDepth = e.depth;
        if (e.depth > maxDepth) maxDepth = e.depth;
      }
      const span = maxDepth - minDepth || 1;

      // Ближние рёбра поверх дальних.
      edges.sort((a, b) => a.depth - b.depth);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      ctx.strokeStyle = this.accent;
      ctx.lineCap = "square";
      ctx.lineJoin = "miter";

      for (const e of edges) {
        const d = clamp((e.depth - minDepth) / span, 0, 1); // 0 = сзади, 1 = спереди
        // Передние рёбра толще и ярче, задние гаснут до 1px.
        ctx.lineWidth = d > 0.55 ? 2 : 1;
        ctx.globalAlpha = 0.3 + d * 0.7;
        // Неоновый ореол только у передних рёбер: так куб светится, но не
        // размывается в облако.
        ctx.shadowColor = this.accent;
        ctx.shadowBlur = d > 0.55 ? 8 : 0;
        ctx.beginPath();
        ctx.moveTo(e.x1, e.y1);
        ctx.lineTo(e.x2, e.y2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;

      // Иконка алерта на каждой грани — вращается вместе с кубом и гаснет на
      // последних 400 мс показа.
      if (this._iconKind && now < this._iconUntil) {
        const img = this._iconImage(this._iconKind);
        if (img && img.complete && img.naturalWidth) {
          const remaining = this._iconUntil - now;
          const alpha = Math.max(0, Math.min(1, remaining / 400));
          const h = 0.58; // половина иконки в локальных единицах грани (-1..1)

          const faces = ICON_FACES.map((face) => {
            const pc = project(face.c);
            const pu = project(face.u);
            const pv = project(face.v);
            return {
              a: size * pu.x,
              b: -size * pu.y,
              c: size * pv.x,
              d: -size * pv.y,
              e: cx + size * pc.x,
              f: cy - size * pc.y,
              depth: pc.z,
            };
          });
          faces.sort((p, q) => p.depth - q.depth);

          ctx.save();
          ctx.globalAlpha = alpha;
          for (const face of faces) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.transform(face.a, face.b, face.c, face.d, face.e, face.f);
            ctx.drawImage(img, -h, -h, 2 * h, 2 * h);
          }
          ctx.restore();
        }
      }
    }
  }

  return WidgetSfCube;
});
