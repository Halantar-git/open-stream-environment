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
  WidgetPixelCube — rotating isometric wireframe cube for the Pixel Perfect theme.

  A transparent cube drawn only by its edges: no filled faces, just 1-2px gold
  lines with depth cueing (front edges brighter and thicker than back edges).
  The active alert's icon is decaled onto every face and spins with the cube;
  the cube is hidden while no alert is playing and appears on the first alert,
  like the alerts backdrop. Donations also trigger a quick "pop".
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetPixelCube = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetPixelCube;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetPixelCube = WidgetPixelCube;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  const DEFAULT_GOLD = "#d6b675";

  // Cube vertices (half-size 1).
  const VERTICES = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];

  // The 12 cube edges as pairs of vertex indices (bottom, top, verticals).
  const EDGES = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  // The 6 cube faces for decaling the alert icon: center + two in-plane
  // tangent vectors (face-local x/y axes). Front/back/left/right/top/bottom.
  const ICON_FACES = [
    { c: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] },   // front
    { c: [0, 0, 1],  u: [-1, 0, 0], v: [0, 1, 0] },  // back
    { c: [-1, 0, 0], u: [0, 0, 1],  v: [0, 1, 0] },  // left
    { c: [1, 0, 0],  u: [0, 0, -1], v: [0, 1, 0] },  // right
    { c: [0, 1, 0],  u: [1, 0, 0],  v: [0, 0, -1] }, // top
    { c: [0, -1, 0], u: [1, 0, 0],  v: [0, 0, 1] },  // bottom
  ];

  class WidgetPixelCube extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";
      this.gold = DEFAULT_GOLD;
      this._popUntil = 0;
      this._iconQueue = [];
      this._iconKind = null;
      this._iconUntil = 0;
      this._iconImages = {};
    }

    onMount() {
      if (this.theme !== "pixel") return;
      this._readColors();
      this._applyPerspective();
      this.bindEvents();
      // Hidden until the first alert — like the alerts backdrop.
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
      this.gold = (read && read("--md-primary")) || DEFAULT_GOLD;
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

    bindEvents() {
      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.ALERT, (a) => this.queueAlert(a));
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

    // Lazy-loads the alert icon (shared/icons.js) as a gold-coloured 24x24 SVG
    // raster so it can be drawn onto the cube canvas. Cached per kind + colour.
    _iconImage(kind) {
      const icons = this.context.ICONS || {};
      const svg = icons[kind];
      if (!svg || typeof Image === "undefined") return null;
      const key = kind + "|" + this.gold;
      if (this._iconImages[key]) return this._iconImages[key];
      const colored = svg.split("currentColor").join(this.gold);
      const sized = colored.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ');
      const img = new Image();
      img.src = "data:image/svg+xml," + encodeURIComponent(sized);
      this._iconImages[key] = img;
      return img;
    }

    render() {
      if (this.theme !== "pixel") return;
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

      // Draw back-to-front so nearer edges sit on top of farther ones.
      edges.sort((a, b) => a.depth - b.depth);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      ctx.strokeStyle = this.gold;
      ctx.lineCap = "square";
      ctx.lineJoin = "miter";

      for (const e of edges) {
        const d = clamp((e.depth - minDepth) / span, 0, 1); // 0 = back, 1 = front
        // Front edges are thicker and brighter; back edges fade to 1px.
        ctx.lineWidth = d > 0.55 ? 2 : 1;
        ctx.globalAlpha = 0.3 + d * 0.7;
        ctx.beginPath();
        ctx.moveTo(e.x1, e.y1);
        ctx.lineTo(e.x2, e.y2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Alert icon decaled onto every cube face so it spins with the cube.
      // Fades out over the last 400ms of the alert.
      if (this._iconKind && now < this._iconUntil) {
        const img = this._iconImage(this._iconKind);
        if (img && img.complete && img.naturalWidth) {
          const remaining = this._iconUntil - now;
          const alpha = Math.max(0, Math.min(1, remaining / 400));
          const h = 0.58; // icon half-size in face-local units (face spans -1..1)

          // Project each face's center + tangents, then draw back-to-front
          // (same depth order as the edges).
          const faces = ICON_FACES.map((f) => {
            const pc = project(f.c);
            const pu = project(f.u);
            const pv = project(f.v);
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

  return WidgetPixelCube;
});
