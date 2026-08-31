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
  WidgetEliteSign — animated neon sign of the Elite Dangerous emblem (the eagle)
  for the Elite "Cobra Mk II" theme.

  Reproduces the reference emblem (Elite Dangerous Logo Vector.svg): the eagle
  mark filled with the cockpit-orange HUD accent, rendered as layered additive
  neon (outer halo, mid glow, crisp warm core) with a slow hover sway and a soft
  roll. On chat messages and donations the sign briefly glitches (horizontal
  slice offset), echoing the cockpit HUD's interference.

  Runs on the built-in 30 FPS loop and tears down to 0% GPU in onUnmount().

  Theme isolation: hard-gated to "cobra-mk2" in onMount() and via the manager
  (shouldMount / resolveRenderType using the catalog `theme` field).
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetEliteSign = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetEliteSign;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetEliteSign = WidgetEliteSign;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  // The Elite Dangerous emblem (eagle), extracted verbatim from the reference
  // SVG (viewBox 0 0 500 500). Each sub-path is a solid orange fill; combined
  // here into a single Path2D string. Polygons are expressed as closed paths.
  const EMBLEM_PATHS = [
    "M250,257.283c0.168-5.212,4.763-17.149,5.379-26.228c2.13-1.345,4.26-2.69,6.389-4.035c-0.967-13.187-2.507-26.098-4.372-38.838c-2.13,9.359-1.569,20.736-2.354,31.104c-1.681-0.953-3.362-1.905-5.043-2.858c-1.681,0.953-3.362,1.905-5.043,2.858c-0.785-10.368-0.224-21.745-2.354-31.104c-1.865,12.74-3.404,25.651-4.372,38.838c2.13,1.345,4.26,2.69,6.389,4.035C245.237,240.134,249.832,252.071,250,257.283",
    "M250.067,257.481l11.795-8.435h20.587l-5.433-4.432l-14.297-1.644v-3.288c0-3.17,6.231,0.072,9.507-1.287c-2.788-1.644-5.131-5.078-8.364-4.932c-2.694,0.121-4.796,3.099-5.861,5.576L250.067,257.481z",
    "M249.933,257.481l-11.795-8.435h-20.587l5.433-4.432l14.297-1.644v-3.288c0-3.17-6.231,0.072-9.507-1.287c2.788-1.644,5.131-5.078,8.364-4.932c2.693,0.121,4.796,3.099,5.861,5.576L249.933,257.481z",
    "M250,302.702L258.17,265.39L267.283,256.169L250,262.066L232.717,256.169L241.83,265.39Z",
    "M251.395,318.734l11.655-49.867l9.442-11.655c10.18-0.688,19.254,0.842,27.884-3.983c3.893-2.176,5.755-9.217,4.279-13.426c-2.215-6.316-6.541-11.016-12.836-15.934l0.295-12.098l84.243-66.981c-0.443,15.491-2.669,33.876-14.606,43.375l-28.179,22.425c-5.282,4.203-8.189,14.885-3.688,19.918l11.213,12.54c1.969,2.202,1.921,7.082-0.443,8.852L251.395,318.734z",
    "M248.605,318.734l-11.655-49.867l-9.442-11.655c-10.18-0.688-19.254,0.842-27.884-3.983c-3.893-2.176-5.755-9.217-4.279-13.426c2.215-6.316,6.541-11.016,12.836-15.934l-0.295-12.098l-84.243-66.981c0.443,15.491,2.669,33.876,14.606,43.375l28.179,22.425c5.282,4.203,8.189,14.885,3.688,19.918l-11.213,12.54c-1.969,2.202-1.921,7.082,0.443,8.852L248.605,318.734z",
    "M362.436,193.352l0.195,15.971c0.033,2.749-1.064,5.883-3.214,7.596l-21.132,16.847l-5.259-6.914c-2.337-3.073-1.573-9.102,1.461-11.491L362.436,193.352z",
    "M137.564,193.352l-0.195,15.971c-0.033,2.749,1.064,5.883,3.214,7.596l21.132,16.847l5.259-6.914c2.337-3.073,1.573-9.102-1.461-11.491L137.564,193.352z",
    "M380.581,149.159l94.402-73.042c0.413,18.191-6.93,37.905-20.672,49.2l-34.04,27.976l-0.138,5.65l21.361-16.675c0.092,15.252-5.118,31.519-16.262,41.206l-32.661,28.39v5.237l17.916-14.333c1.795,14.91-5.352,28.966-15.987,37.348l-76.762,60.5c-4.212,3.319-7.729,8.834-7.58,14.195l0.276,9.923c0.087,3.142-1.829,6.43-4.272,8.407l-33.902,27.425l-18.33-37.072l91.233-69.459l1.93-10.749l-5.65-6.615l18.88-14.333l6.339-11.439l0.276-21.913C374.778,182.453,380.462,171.504,380.581,149.159",
    "M119.419,149.159L25.017,76.117c-0.413,18.191,6.929,37.905,20.672,49.2l34.04,27.976l0.138,5.65l-21.361-16.675c-0.092,15.252,5.118,31.519,16.262,41.206l32.662,28.39v5.237l-17.916-14.333c-1.795,14.91,5.352,28.966,15.987,37.348l76.762,60.5c4.212,3.319,7.729,8.834,7.58,14.195l-0.276,9.923c-0.087,3.142,1.829,6.43,4.272,8.407l33.902,27.425l18.329-37.072l-91.233-69.459l-1.93-10.749l5.65-6.615l-18.88-14.333l-6.339-11.439l-0.276-21.913C125.222,182.453,119.538,171.504,119.419,149.159",
    "M362.584,271.079l-43.445,33.879c-2.625,2.047-4.783,5.44-4.783,8.769v13.153l42.382-34.145c2.917-2.35,5.321-6.087,5.447-9.832L362.584,271.079z",
    "M137.416,271.079l43.445,33.879c2.625,2.047,4.783,5.44,4.783,8.769v13.153l-42.382-34.145c-2.917-2.35-5.321-6.087-5.447-9.832L137.416,271.079z",
    "M250,346.347L244.632,353.033L239.738,377.624L228.516,369.029L250,327.605L271.484,369.029L260.262,377.624L255.368,353.033Z",
    "M242.967,419.406c-0.94-2.144-0.582-6.982,0.233-8.65c0.815-1.668,1.673-2.349,2.859-3.174c-4.113-3.312-8.009-6.793-6.076-16.072l7.515-36.089l2.503-4.058l2.503,4.058l7.515,36.089c1.933,9.28-1.964,12.761-6.076,16.072c1.186,0.825,2.044,1.506,2.859,3.174c0.815,1.668,1.173,6.506,0.233,8.65C254.417,425.375,245.583,425.375,242.967,419.406",
  ].join(" ");

  // viewBox 0 0 500 500, no internal SVG transform to apply.
  const SVG_W = 500;
  const SVG_H = 500;

  // Bounds of the emblem within the viewBox (derived from the reference path),
  // used to fill the widget instead of the padded 500x500 viewBox.
  const EMB_MIN_X = 25;
  const EMB_MAX_X = 475;
  const EMB_MIN_Y = 76;
  const EMB_MAX_Y = 426;
  const EMB_W = EMB_MAX_X - EMB_MIN_X;
  const EMB_H = EMB_MAX_Y - EMB_MIN_Y;
  const EMB_CX = (EMB_MIN_X + EMB_MAX_X) / 2;
  const EMB_CY = (EMB_MIN_Y + EMB_MAX_Y) / 2;

  // Neon layers — cockpit-orange HUD palette (Elite's --md-primary). `blurR`
  // is the glow radius as a fraction of R.
  const LAYERS = [
    { color: "#ff7605", blurR: 0.22, alpha: 0.55 },
    { color: "#ff7605", blurR: 0.09, alpha: 0.9 },
    { color: "#ffb066", blurR: 0.02, alpha: 1 },
  ];

  class WidgetEliteSign extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this._path = typeof Path2D !== "undefined" ? new Path2D(EMBLEM_PATHS) : null;

      this._nextFlickerAt = 0;
      this._flickerUntil = 0;
      this._glitchUntil = 0;
    }

    onMount() {
      // HARD theme gate: never spin up the loop or draw on a non-Cobra Mk II theme.
      if (this.theme !== "cobra-mk2") return;

      this._applyPerspective();
      this._nextFlickerAt = performance.now() + 2000 + Math.random() * 3000;
      this.bindEvents();
      this.startRenderLoop(30); // strictly 30 FPS
    }

    onUnmount() {
      this._glitchUntil = 0;
      this._flickerUntil = 0;
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

    // ---- interactivity: glitch on chat / donation ----

    bindEvents() {
      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.CHAT_MESSAGE, () => this.glitch());
      this.subscribe(EVENT_TYPES.ALERT, (alert) => {
        if (alert && alert.kind === "donation") this.glitch();
      });
    }

    glitch() {
      this._glitchUntil = performance.now() + 500;
    }

    // ---- rendering ----

    render() {
      if (this.theme !== "cobra-mk2") return;
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

      // --- hover sway + soft roll ---
      const swayX = Math.sin(t * 0.5) * 4;
      const swayY = Math.cos(t * 0.4) * 3;
      const rot = Math.sin(t * 0.22) * 0.05;
      const dx = glitching ? (Math.random() * 2 - 1) * 7 : 0;

      const cx = cw / 2 + swayX + dx;
      const cy = ch / 2 + swayY;

      // Fit the emblem (not the padded 500x500 viewBox) to the widget. 0.84
      // leaves room for the outer neon halo.
      const scale = Math.min((cw * 0.84) / EMB_W, (ch * 0.84) / EMB_H);
      const R = Math.min(cw, ch) * 0.42; // reference radius for glow blur math

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.scale(scale, scale);
      ctx.translate(-EMB_CX, -EMB_CY);

      // --- neon fill layers (additive bloom) ---
      for (const layer of LAYERS) {
        ctx.save();
        if (layer.blurR > 0) ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = layer.color;
        ctx.globalAlpha = layer.alpha * intensity;
        if (layer.blurR > 0) {
          ctx.shadowColor = layer.color;
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

  return WidgetEliteSign;
});
