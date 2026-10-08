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
  WidgetWardogsCube — rotating isometric wireframe cube for the Wardogs theme.

  A transparent cube drawn only by its edges: no filled faces, just 1-2px gray
  lines with depth cueing (front edges brighter and thicker than back edges).
  The whole readout is monochrome gray, matching the goal bar.

  It is a sign: always visible, with a "motion" toggle that freezes the rotation
  in the inspector. It reacts to alerts like the Pixel cube — a quick pop on
  every alert, a harder one on donations.
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

  const EDGE = "#dcdcdc"; // monochrome gray, like the goal bar fill

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

  class WidgetWardogsCube extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";
      this._popUntil = 0; // active "pop" window (alert reaction)
      this._popAmp = 0; // pop strength (donations hit harder)
    }

    onMount() {
      // HARD theme gate: no canvas, no loop, no events on a non-Wardogs theme.
      if (this.theme !== "wardogs") return;

      this._applyPerspective();
      // React to alerts like the Pixel cube: a quick pop each time (donations
      // hit harder). The cube stays a visible sign — it is not alert-gated.
      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this._onAlert(alert));
      this.startRenderLoop(30);
    }

    onUnmount() {
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

    // A short scale pop on every alert; a donation pops noticeably harder.
    _onAlert(alert) {
      if (!alert) return;
      this._popUntil = performance.now() + 450;
      this._popAmp = alert.kind === "donation" ? 0.16 : 0.08;
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

      let scale = 1 + 0.03 * Math.sin(t * 1.7);
      let popGlow = 0;
      if (now < this._popUntil) {
        const k = 1 - (this._popUntil - now) / 450; // 0..1 over the pop
        popGlow = Math.sin(Math.PI * k);
        scale += this._popAmp * popGlow;
      }
      scale = clamp(scale, 0.8, 1.4);

      const cx = cw / 2 + Math.sin(t * 0.6) * 4;
      const cy = ch / 2 + Math.cos(t * 0.5) * 3 + Math.sin(t * 1.4) * 2;
      const size = Math.min(cw, ch) * 0.3 * scale;

      // Freeze the spin when motion is off (a sign still breathing, not still).
      const angle = this.config.motion === false ? 0.6 : t * 0.7;
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

      ctx.strokeStyle = EDGE;
      ctx.lineCap = "square";
      ctx.lineJoin = "miter";

      for (const e of edges) {
        const d = clamp((e.depth - minDepth) / span, 0, 1); // 0 = back, 1 = front
        // Front edges are thicker and brighter; back edges fade to 1px.
        ctx.lineWidth = d > 0.55 ? 2 : 1;
        ctx.globalAlpha = Math.min(1, 0.3 + d * 0.7 + popGlow * 0.35);
        ctx.beginPath();
        ctx.moveTo(e.x1, e.y1);
        ctx.lineTo(e.x2, e.y2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  return WidgetWardogsCube;
});
