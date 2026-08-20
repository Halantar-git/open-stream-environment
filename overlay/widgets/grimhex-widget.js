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
  WidgetGrimHex — animated neon Grim HEX sign (Star Citizen).

  Reproduces the exact reference logo (hex_neon_logo_transparent.svg): a single
  outlined path (viewBox 1448x1086) rendered four times for the neon glow —
  red outer halo (blur 18), red mid glow (blur 7), pink-white core (blur 1.1)
  and a crisp near-white fill.

  Runs on the built-in 30 FPS loop and tears down to 0% GPU in onUnmount().
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetGrimHex = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetGrimHex;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetGrimHex = WidgetGrimHex;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  // Exact reference path (`<path id="hexShape" transform="translate(0,1086)
  // scale(0.1,-0.1)">`), embedded verbatim.
  const HEX_SHAPE_D =
    "M4634 10296 c-17 -8 -43 -29 -56 -47 -42 -57 -611 -975 -910 -1469 l-178 -294 52 -33 c29 -18 55 -33 58 -33 3 0 16 19 29 43 28 49 348 573 521 852 65 105 206 334 315 510 108 176 207 328 219 339 20 18 58 18 1206 15 l1185 -4 3 61 3 61 -407 6 c-224 4 -768 7 -1208 7 -652 -1 -807 -3 -832 -14z " +
    "M7320 10243 c0 -35 1 -64 3 -65 1 -2 546 -5 1212 -8 l1210 -5 62 -103 c58 -94 677 -1138 950 -1602 64 -107 117 -196 118 -198 4 -4 74 32 97 50 20 14 25 2 -112 233 -26 44 -94 159 -150 255 -200 341 -337 570 -606 1021 -219 366 -279 458 -301 468 -20 8 -366 12 -1256 13 l-1227 3 0 -62z " +
    "M6090 9590 c-889 -5 -978 -6 -1001 -22 -27 -17 -133 -188 -639 -1027 -220 -366 -288 -486 -278 -493 39 -27 91 -49 98 -41 4 4 29 44 55 88 130 215 546 904 660 1090 70 116 137 225 147 243 11 17 21 33 21 34 1 2 434 5 962 8 l960 5 0 58 c0 33 -2 60 -5 60 -3 1 -444 0 -980 -3z " +
    "M7310 9536 l0 -63 948 5 947 5 117 -199 c65 -109 135 -228 157 -264 21 -36 37 -68 35 -72 -3 -5 -284 -8 -625 -8 l-619 0 0 -60 0 -60 665 2 665 3 25 26 c14 14 28 41 31 61 6 32 -9 62 -177 348 -133 224 -192 316 -211 326 -23 12 -180 14 -993 14 l-965 0 0 -64z " +
    "M7508 8930 l-528 -5 -23 -25 c-13 -14 -83 -122 -154 -240 -72 -118 -206 -339 -298 -490 -342 -560 -386 -633 -388 -643 -1 -5 19 -22 46 -38 l47 -28 24 37 c13 20 84 136 158 257 74 121 215 351 313 510 98 160 212 346 254 415 l77 125 502 9 502 8 0 59 c0 33 -1 58 -2 57 -2 -2 -240 -5 -530 -8z " +
    "M9325 8590 c-3 -5 -4 -32 -3 -60 l3 -50 206 0 c149 0 209 -3 221 -12 8 -7 98 -155 198 -328 101 -173 207 -354 237 -403 29 -48 53 -91 53 -94 0 -4 -17 -34 -39 -67 -116 -181 -422 -678 -419 -681 9 -8 89 -45 97 -45 5 0 18 15 29 33 10 17 119 191 241 385 121 193 221 361 221 373 0 21 -5 30 -298 532 -246 419 -235 403 -273 416 -40 14 -465 15 -474 1z " +
    "M8568 8580 c-9 -6 -59 -79 -111 -163 -358 -578 -467 -761 -467 -781 0 -13 49 -108 108 -212 60 -104 184 -323 277 -488 148 -262 173 -300 201 -312 27 -11 118 -14 441 -14 l408 0 37 60 38 60 -437 2 -438 3 -118 210 c-263 465 -351 622 -371 656 l-20 36 70 114 c39 63 155 250 258 417 l188 302 132 0 c73 0 180 3 237 6 l104 7 0 53 0 54 -260 0 c-151 0 -267 -5 -277 -10z " +
    "M3271 8127 c-242 -399 -851 -1410 -1063 -1762 -142 -236 -228 -389 -228 -405 0 -17 102 -194 276 -481 152 -250 398 -656 547 -904 148 -247 303 -505 344 -572 l74 -122 52 31 c29 16 53 32 55 33 3 3 -378 641 -726 1215 -85 140 -229 378 -320 528 l-164 273 109 182 c61 100 289 479 508 842 484 802 746 1238 751 1247 4 5 -97 69 -107 68 -2 -1 -51 -78 -108 -173z " +
    "M11040 8104 c-25 -14 -47 -27 -49 -29 -4 -5 -18 20 305 -540 143 -247 359 -621 479 -830 120 -209 278 -484 352 -612 l134 -231 -254 -414 c-140 -227 -368 -600 -507 -828 -140 -228 -295 -482 -345 -565 -135 -221 -149 -246 -139 -254 5 -4 30 -20 56 -34 l46 -27 20 33 c137 230 1044 1711 1197 1955 42 68 58 103 58 130 1 39 -19 76 -331 612 -163 281 -202 348 -407 705 -95 165 -205 356 -245 425 -39 69 -124 216 -188 327 -65 112 -121 203 -127 203 -5 0 -30 -12 -55 -26z " +
    "M3945 7708 c-151 -250 -628 -1044 -853 -1420 -111 -185 -202 -344 -202 -353 0 -17 16 -46 180 -325 53 -91 220 -376 370 -635 150 -258 317 -545 372 -637 l98 -166 54 29 54 29 -100 173 c-55 94 -189 325 -298 512 -231 397 -440 755 -533 910 l-65 110 19 30 c46 71 1109 1844 1109 1849 0 5 -94 56 -103 56 -2 0 -47 -73 -102 -162z " +
    "M5964 7287 c-17 -28 -91 -149 -164 -267 -171 -277 -250 -409 -250 -416 0 -4 64 -115 141 -248 166 -281 195 -331 404 -691 86 -148 163 -276 170 -283 10 -11 20 -10 56 8 24 13 45 24 47 25 5 5 -21 53 -196 355 -91 157 -190 328 -220 380 -30 52 -101 175 -158 273 -57 98 -104 180 -104 183 0 3 90 152 201 331 110 179 203 331 205 338 4 9 -81 66 -97 65 -2 0 -18 -24 -35 -53z " +
    "M9987 6673 l-35 -58 426 -5 427 -5 118 -200 c249 -424 350 -598 354 -614 2 -10 -68 -135 -165 -293 -223 -363 -739 -1219 -746 -1238 -4 -10 10 -23 46 -42 28 -15 52 -27 54 -25 1 1 144 238 319 527 175 289 389 643 476 786 88 144 159 269 159 279 0 9 -61 121 -136 248 -75 128 -192 327 -261 443 -68 117 -133 220 -145 230 -19 18 -47 19 -437 22 l-418 3 -36 -58z " +
    "M9412 6363 c-11 -16 -59 -91 -107 -168 -49 -77 -115 -183 -148 -235 -129 -204 -147 -235 -147 -252 0 -10 71 -143 159 -296 87 -152 186 -327 220 -389 l62 -112 -29 -43 c-16 -24 -60 -92 -97 -153 -37 -60 -73 -113 -79 -117 -6 -4 -230 -8 -498 -8 l-488 0 0 -60 0 -61 519 3 c498 3 520 4 540 22 12 11 76 107 142 213 91 146 120 199 115 216 -5 20 -73 145 -238 437 -36 63 -95 168 -131 234 l-67 119 34 51 c79 120 366 579 364 581 -10 8 -89 45 -97 45 -5 0 -18 -12 -29 -27z " +
    "M6428 5212 c-27 -15 -48 -30 -48 -34 0 -4 29 -55 64 -115 35 -59 124 -211 198 -338 110 -188 141 -233 169 -248 32 -18 63 -18 569 -13 294 3 560 6 591 6 52 0 56 2 54 23 -1 12 -3 40 -4 61 l-1 39 -567 -7 c-459 -6 -571 -4 -585 6 -9 7 -95 146 -190 309 -95 163 -180 306 -188 317 l-15 21 -47 -27z " +
    "M9717 3183 c-289 -483 -537 -895 -551 -915 l-26 -38 -915 0 -915 0 0 -60 0 -60 944 0 945 0 24 23 c14 12 145 225 293 472 147 248 395 663 552 924 224 372 282 475 271 482 -19 13 -87 49 -93 49 -2 0 -240 -395 -529 -877z " +
    "M4075 4023 c-28 -14 -52 -27 -54 -29 -2 -1 171 -303 384 -671 715 -1233 684 -1180 713 -1191 17 -7 378 -13 995 -17 l968 -6 -3 63 -3 63 -940 3 c-517 2 -945 5 -951 7 -10 3 -60 85 -204 335 -37 63 -165 284 -284 490 -120 206 -293 503 -384 660 -91 157 -170 292 -176 301 -10 15 -16 14 -61 -8z " +
    "M5400 3240 l0 -680 130 0 130 0 0 259 c0 145 4 271 10 285 l10 26 195 0 c116 0 204 -4 216 -10 18 -10 19 -24 19 -285 l0 -275 128 0 129 0 6 233 c4 127 7 431 7 675 l0 442 -43 0 c-24 0 -85 3 -135 6 l-92 7 -2 -289 -3 -289 -217 -3 -218 -2 0 290 0 290 -135 0 -135 0 0 -680z " +
    "M6630 3230 l0 -679 415 -1 415 0 0 100 0 100 -275 0 -275 0 -5 23 c-3 12 -4 96 -3 187 l3 165 233 3 232 2 2 63 c1 34 2 78 2 97 l1 35 -235 5 -235 5 0 177 c0 97 3 180 7 184 5 4 131 8 280 8 l273 1 3 103 3 102 -421 0 -420 0 0 -680z " +
    "M7673 3888 c19 -26 64 -97 271 -427 l148 -233 -221 -332 c-122 -182 -221 -335 -221 -339 0 -4 70 -7 155 -7 l154 0 17 33 c63 125 289 507 298 504 6 -2 76 -123 156 -270 l145 -267 158 0 c86 0 157 3 157 6 0 3 -78 125 -173 272 -217 333 -257 397 -257 407 0 9 191 309 337 530 l93 140 -147 3 c-81 1 -152 1 -158 -2 -13 -5 -96 -152 -215 -378 -45 -87 -85 -158 -90 -158 -4 0 -62 102 -128 228 -66 125 -131 246 -144 269 l-23 43 -164 0 -163 0 15 -22z " +
    "M3390 3739 c-25 -16 -49 -30 -54 -32 -4 -1 28 -63 72 -137 153 -261 364 -615 392 -660 15 -25 161 -270 325 -545 164 -275 350 -587 414 -694 64 -107 127 -202 141 -212 24 -17 89 -18 1200 -21 l1175 -3 3 68 4 67 -1139 0 c-626 0 -1147 3 -1159 6 -14 4 -63 78 -154 232 -74 125 -194 326 -266 447 -72 121 -198 333 -279 470 -357 601 -608 1021 -619 1031 -8 9 -22 5 -56 -17z " +
    "M10829 3518 c-34 -57 -104 -170 -154 -253 -51 -82 -209 -343 -353 -580 -143 -236 -350 -578 -460 -760 -110 -181 -207 -338 -216 -347 -14 -16 -87 -17 -1176 -11 l-1160 6 0 -71 0 -72 1185 0 c1006 0 1190 2 1213 14 18 10 62 72 131 188 104 171 207 342 723 1188 392 645 442 730 432 739 -5 5 -30 20 -55 35 l-47 27 -63 -103z";

  // viewBox 1448x1086, with the SVG's internal transform applied to the path:
  //   translate(0,1086) scale(0.1,-0.1)
  const SVG_W = 1448;
  const SVG_H = 1086;

  // Bounds of the neon sign within the viewBox (derived from the reference
  // path), used to fill the widget instead of the padded 1448x1086 viewBox.
  const HEX_MIN_X = 198;
  const HEX_MAX_X = 1239;
  const HEX_MIN_Y = 55;
  const HEX_MAX_Y = 943;
  const HEX_W = HEX_MAX_X - HEX_MIN_X;
  const HEX_H = HEX_MAX_Y - HEX_MIN_Y;
  const HEX_CX = (HEX_MIN_X + HEX_MAX_X) / 2;
  const HEX_CY = (HEX_MIN_Y + HEX_MAX_Y) / 2;

  // Neon layers — exact reference colors + blur (stdDeviation) + base opacity.
  // Neon glow layers (all the same size, like the reference): saturated rusty
  // red halo + red mid glow + ultra-bright pink-white core + crisp white.
  // `blurR` is the glow radius as a fraction of R.
  const LAYERS = [
    { color: "#ff1800", blurR: 0.22, alpha: 0.6 },
    { color: "#ff1800", blurR: 0.09, alpha: 0.9 },
    { color: "#ffeeee", blurR: 0.02, alpha: 1 },
    { color: "#ffffff", blurR: 0, alpha: 1 },
  ];

  // Dark tube caps (unlit connection nodes). Placed by hand against the exact
  // reference logo (Hex_1.svg); each is a rounded rect in viewBox coordinates
  // (1448x1086) with an SVG rotate() applied around the origin, like the SVG.
  const CAPS = [
    { x: 805.80, y: 768.07, w: 16, h: 32, rx: 3, rot: -30.342 },
    { x: -236.55, y: 906.79, w: 16, h: 32, rx: 3, rot: -89.758 },
    { x: 941.26, y: 411.78, w: 20, h: 14, rx: 2, rot: 0 },
    { x: 138.23, y: 1042.79, w: 20, h: 14, rx: 2, rot: -59.471 },
    { x: 984.50, y: 411.94, w: 20, h: 14, rx: 2, rot: 0 },
    { x: 128.29, y: 1034.39, w: 20, h: 14, rx: 2, rot: -57.410 },
    { x: -202.92, y: 799.86, w: 16, h: 32, rx: 3, rot: -89.758 },
    { x: -137.69, y: 703.42, w: 16, h: 32, rx: 3, rot: -89.758 },
    { x: -67.84, y: 704.28, w: 16, h: 32, rx: 3, rot: -89.758 },
    { x: -1243.19, y: -55.59, w: 16, h: 32, rx: 3, rot: -148.826 },
    { x: -1321.82, y: -42.83, w: 16, h: 32, rx: 3, rot: -148.043 },
    { x: -637.95, y: 800.14, w: 16, h: 32, rx: 3, rot: -89.758 },
    { x: -874.23, y: 706.54, w: 16, h: 32, rx: 3, rot: -89.758 },
    { x: -941.26, y: 706.04, w: 16, h: 32, rx: 3, rot: -89.758 },
    { x: -2.66, y: 771.81, w: 16, h: 32, rx: 3, rot: -30.378 },
    { x: -96.57, y: 757.39, w: 16, h: 32, rx: 3, rot: -31.889 },
    { x: 693.28, y: -42.78, w: 16, h: 32, rx: 3, rot: 31.772 },
    { x: 265.43, y: 786.28, w: 16, h: 32, rx: 3, rot: -30.051 },
    { x: -515.69, y: -46.94, w: 16, h: 32, rx: 3, rot: -148.343 },
    { x: -436.11, y: -50.67, w: 16, h: 32, rx: 3, rot: -149.297 },
  ];

  class WidgetGrimHex extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      // Active theme id, injected by the manager via context.
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this._path = typeof Path2D !== "undefined" ? new Path2D(HEX_SHAPE_D) : null;

      this._nextFlickerAt = 0;
      this._flickerUntil = 0;
      this._glitchUntil = 0;
    }

    onMount() {
      // HARD theme gate: never spin up the 3D loop or draw on a non-grimhex theme.
      if (this.theme !== "grimhex") return;

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
    // Star Citizen chat widget).
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
      if (this.theme !== "grimhex") return;
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
      ctx.lineJoin = "miter";
      ctx.lineCap = "square";

      // --- flicker state machine (unchanged) ---
      if (now >= this._nextFlickerAt) {
        this._flickerUntil = now + 120 + Math.random() * 200;
        this._nextFlickerAt = now + 2000 + Math.random() * 3000;
      }
      const glitching = now < this._glitchUntil;
      let intensity = 0.82 + 0.18 * Math.sin(t * 2.4) * Math.sin(t * 1.15);
      if (now < this._flickerUntil) intensity *= 0.35 + 0.65 * Math.abs(Math.sin(now * 0.055));
      if (glitching) intensity = 0.3 + 0.7 * Math.abs(Math.sin(now * 0.09));
      intensity = clamp(intensity, 0.12, 1);

      // --- pseudo-3D sway + glitch jitter (unchanged) ---
      const swayX = Math.sin(t * 0.5) * 4;
      const swayY = Math.cos(t * 0.4) * 3;
      const rot = Math.sin(t * 0.22) * 0.06;
      const dx = glitching ? (Math.random() * 2 - 1) * 7 : 0;

      const cx = cw / 2 + swayX + dx;
      const cy = ch / 2 + swayY;

      // Fit the neon sign (not the padded viewBox) to the widget so it can sit
      // flush against a corner. 0.84 leaves room for the outer neon glow.
      const scale = Math.min((cw * 0.84) / HEX_W, (ch * 0.84) / HEX_H);
      const R = (scale * SVG_W) / 2; // kept for the glow radius math below

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      // SVG transform: translate(0,1086) scale(0.1,-0.1), then centre the
      // hexagon (HEX_CX, HEX_CY) instead of the padded viewBox centre.
      ctx.transform(0.1 * scale, 0, 0, -0.1 * scale, -HEX_CX * scale, (SVG_H - HEX_CY) * scale);

      // --- Layer 1: glowing neon tube (additive bloom) ---
      for (const layer of LAYERS) {
        ctx.save();
        if (layer.blurR > 0) ctx.globalCompositeOperation = "lighter"; // additive neon glow
        ctx.fillStyle = layer.color;
        ctx.globalAlpha = layer.alpha * intensity;
        if (layer.blurR > 0) {
          ctx.shadowColor = layer.color;
          ctx.shadowBlur = layer.blurR * R * dpr * intensity;
        }
        ctx.fill(path);
        ctx.restore();
      }

      // --- Layer 2: dark tube caps (unlit connection nodes) ---
      this._drawCaps(ctx);

      ctx.restore();

      // Analog horizontal glitch: shift a few random slices of the finished frame.
      if (glitching) this._glitchBands(ctx, bw, bh, dpr);
    }

    // ---- Layer 2: dark tube caps (unlit connection nodes) ----

    _drawCaps(ctx) {
      ctx.save();
      // Enter viewBox space (1448x1086) so the CAPS coordinates match the SVG.
      ctx.translate(0, SVG_H * 10);
      ctx.scale(10, -10);

      for (const c of CAPS) {
        ctx.save();
        if (c.rot) ctx.rotate((c.rot * Math.PI) / 180); // SVG rotate() -> canvas radians

        // Unlit glass gradient (vertical in the cap's local space, so it turns
        // together with the cap).
        const grad = ctx.createLinearGradient(c.x, c.y, c.x, c.y + c.h);
        grad.addColorStop(0, "#08080a");
        grad.addColorStop(0.5, "#1c1d22");
        grad.addColorStop(1, "#050507");

        ctx.fillStyle = grad;
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;

        if (typeof ctx.roundRect === "function") {
          ctx.beginPath();
          ctx.roundRect(c.x, c.y, c.w, c.h, c.rx);
          ctx.fill();
        } else {
          ctx.fillRect(c.x, c.y, c.w, c.h);
        }

        ctx.restore();
      }

      ctx.restore();
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

  return WidgetGrimHex;
});
