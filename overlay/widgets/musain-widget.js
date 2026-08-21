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
  WidgetMusain — animated neon "Café Musain" sign (Star Citizen / Levski).

  Reproduces the exact reference (cafe_musia_neon_with_caps.svg): 14 outlined
  tube segments (viewBox 1774x887) rendered through three neon glow layers —
  amber outer halo, brighter mid glow and a near-white core — matching the
  reference's three `feGaussianBlur` filters (stdDeviation 14 / 5.5 / 0.9).
  The amber base is accented with orange (É), pink and blue tube segments.

  Runs on the built-in 30 FPS loop and tears down to 0% GPU in onUnmount().
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetMusain = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetMusain;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetMusain = WidgetMusain;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  // viewBox 1774x887, with the sign's SVG transform applied per path:
  //   translate(tx,ty) translate(0,tz) scale(0.1,-0.1)
  const SVG_W = 1774;
  const SVG_H = 887;

  // Tight bounds of the neon tubes within the viewBox (sampled from the exact
  // reference paths), used to fill the widget instead of the padded viewBox.
  const SIGN_MIN_X = 41.22;
  const SIGN_MAX_X = 1742.41;
  const SIGN_MIN_Y = 32.21;
  const SIGN_MAX_Y = 760.5;
  const SIGN_W = SIGN_MAX_X - SIGN_MIN_X;
  const SIGN_H = SIGN_MAX_Y - SIGN_MIN_Y;
  const SIGN_CX = (SIGN_MIN_X + SIGN_MAX_X) / 2;
  const SIGN_CY = (SIGN_MIN_Y + SIGN_MAX_Y) / 2;

  // Three neon layers — exact reference blur (stdDeviation) + base opacity.
  // `blur` is in viewBox units; at draw time it is converted to device pixels.
  const LAYERS = [
    { key: "outer", blur: 14, alpha: 0.55 },
    { key: "mid", blur: 5.5, alpha: 0.85 },
    { key: "core", blur: 0.9, alpha: 1 },
  ];

  // Per-tube palette, matching the reference's three stacked <use> fills.
  const PALETTES = {
    amber: { outer: "#ffb300", mid: "#ffd23f", core: "#fff8dc" },
    orange: { outer: "#ff7a30", mid: "#ff9d5c", core: "#ffe9d6" },
    pink: { outer: "#ff1f8f", mid: "#ff5cb3", core: "#ffe3f3" },
    blue: { outer: "#2f7fff", mid: "#6fa8ff", core: "#e6f2ff" },
  };

  // 14 neon tube segments (one per letter/stroke). `d` is embedded verbatim
  // from the reference; transform = translate(tx,ty) translate(0,tz) scale(0.1,-0.1).
  const LETTERS = [
    { d: "M873 3199 c-154 -26 -299 -125 -389 -265 -91 -143 -120 -278 -130 -609 -4 -133 -4 -266 0 -298 9 -69 51 -130 110 -160 38 -20 46 -20 288 -9 268 12 293 9 304 -34 16 -65 -33 -94 -158 -94 -181 -1 -601 -30 -647 -45 -135 -44 -208 -198 -152 -320 21 -47 76 -99 128 -120 22 -10 68 -15 124 -15 l89 0 0 -525 c0 -590 -1 -583 66 -611 49 -21 93 -11 130 27 l29 30 -4 562 c-3 600 -4 601 -54 655 -12 13 -40 33 -62 44 -34 18 -52 20 -136 16 -53 -3 -104 -1 -113 4 -20 11 -20 32 -1 51 17 17 72 22 405 37 365 17 406 25 483 99 54 51 79 104 85 182 3 51 0 75 -15 110 -29 65 -67 105 -129 135 l-55 27 -246 -7 -246 -8 7 261 c7 282 20 361 72 468 34 71 103 139 172 171 48 23 71 27 142 27 76 0 91 -3 140 -30 42 -23 63 -43 88 -85 41 -70 51 -105 59 -210 6 -93 19 -128 58 -158 41 -32 78 -36 129 -14 64 29 80 65 72 162 -14 168 -71 305 -170 404 -125 126 -288 176 -473 145z", tx: 551, ty: 24, tz: 329, palette: "amber" },
    { d: "M720 3014 c-101 -19 -236 -68 -317 -115 -85 -50 -192 -161 -235 -244 -67 -130 -65 -95 -78 -1130 l-12 -940 26 -80 c30 -95 67 -154 141 -227 72 -71 160 -122 275 -160 91 -30 102 -32 265 -32 199 -1 259 11 400 79 183 89 314 242 359 420 9 37 18 136 22 257 l7 197 -37 37 c-35 35 -39 36 -88 32 -42 -4 -57 -11 -80 -37 -26 -29 -28 -37 -29 -124 0 -50 -4 -145 -8 -209 -7 -103 -12 -126 -40 -182 -92 -187 -360 -292 -620 -242 -161 30 -274 105 -331 219 l-30 60 0 241 c0 133 7 555 14 938 l14 697 28 61 c71 158 274 261 519 262 120 1 202 -15 282 -56 64 -32 101 -70 132 -136 25 -54 26 -60 31 -322 l5 -268 26 -25 c31 -31 88 -42 129 -25 16 7 39 27 50 45 19 30 20 49 20 292 0 280 -6 323 -57 431 -55 117 -200 226 -363 272 -103 28 -304 35 -420 14z", tx: 235, ty: 55, tz: 311, palette: "amber" },
    { d: "M572 2359 c-78 -12 -181 -50 -243 -90 -106 -68 -195 -195 -219 -313 -15 -77 -32 -1430 -19 -1502 12 -65 44 -135 86 -190 37 -49 140 -121 206 -143 118 -41 265 -51 397 -27 98 18 173 47 250 97 73 47 120 95 160 165 47 82 60 149 60 324 0 136 -2 159 -19 184 -50 75 -143 72 -191 -7 -18 -28 -20 -51 -20 -188 0 -147 -1 -158 -26 -207 -29 -59 -81 -102 -164 -134 -45 -18 -77 -22 -175 -22 -186 -1 -275 36 -327 137 -20 41 -20 43 -10 758 11 705 11 719 33 769 27 63 92 122 168 151 50 20 75 23 236 23 201 1 216 -3 255 -67 19 -30 20 -52 20 -307 0 -255 -1 -277 -20 -307 -34 -57 -67 -66 -240 -70 -192 -5 -212 -8 -249 -39 -58 -48 -47 -135 21 -170 28 -15 55 -16 208 -10 96 4 198 12 225 18 117 25 205 91 251 190 l29 63 3 310 c2 208 -1 323 -8 350 -16 56 -77 143 -127 181 -23 18 -68 42 -100 55 -50 19 -80 23 -223 25 -91 1 -193 -2 -228 -7z", tx: 701, ty: 98, tz: 245, palette: "orange" },
    { d: "M699 2212 c-129 -35 -229 -124 -298 -267 -44 -91 -121 -328 -121 -373 0 -39 32 -78 76 -92 29 -10 43 -9 79 4 51 20 68 43 82 111 18 82 94 277 126 322 36 50 97 83 155 83 95 0 125 -42 129 -180 2 -52 0 -324 -4 -604 -6 -393 -11 -510 -20 -514 -10 -3 -13 44 -13 214 0 133 -4 231 -11 255 -28 92 -118 153 -223 151 -72 -1 -197 -42 -281 -93 -114 -68 -207 -195 -261 -354 -36 -108 -45 -289 -19 -398 36 -153 120 -278 228 -341 97 -57 254 -71 390 -36 43 10 120 42 173 70 106 55 148 62 221 34 54 -21 101 -12 137 25 15 15 29 44 32 63 5 29 1 41 -25 70 -45 52 -145 82 -249 76 -71 -4 -87 -10 -197 -66 -148 -76 -202 -90 -287 -74 -88 16 -130 48 -170 129 -31 63 -33 76 -37 185 -4 146 15 233 68 316 66 101 151 162 249 178 l42 7 0 -219 c0 -128 5 -236 11 -259 15 -55 83 -119 142 -133 60 -16 83 -15 144 3 60 18 126 80 147 139 21 58 43 1213 25 1296 -47 219 -226 330 -440 272z", tx: 418, ty: 136, tz: 231, palette: "amber" },
    { d: "M1585 4199 c-75 -11 -175 -49 -257 -98 -73 -44 -159 -140 -208 -233 -18 -35 -92 -162 -165 -283 -165 -276 -450 -758 -526 -891 -67 -118 -94 -199 -85 -258 19 -125 82 -213 189 -266 59 -29 476 -137 1237 -320 140 -33 272 -68 293 -77 40 -17 87 -82 87 -120 0 -22 -72 -143 -230 -388 -56 -88 -127 -198 -156 -245 -57 -93 -113 -153 -157 -169 -16 -6 -51 -11 -78 -11 -42 0 -113 25 -407 144 -196 79 -411 167 -478 194 -149 61 -203 74 -269 61 -71 -13 -168 -63 -206 -106 -17 -21 -44 -62 -58 -93 -21 -44 -26 -70 -26 -130 0 -60 5 -86 26 -131 31 -66 84 -127 131 -151 18 -9 139 -63 268 -118 245 -106 594 -260 765 -337 165 -75 201 -86 295 -86 97 0 170 18 275 68 131 63 176 114 461 538 522 773 643 957 663 1012 27 72 28 172 1 256 -37 119 -161 251 -300 320 -63 31 -133 48 -855 205 -427 93 -467 104 -502 140 -58 57 -55 63 162 424 107 179 209 340 226 358 40 41 123 67 188 58 32 -4 144 -55 366 -167 315 -159 321 -162 396 -167 102 -6 162 14 233 79 74 67 106 134 106 218 0 52 -6 77 -27 119 -43 85 -53 92 -538 363 -71 39 -186 104 -255 142 -237 133 -399 173 -585 146z m271 -234 c72 -21 104 -36 354 -175 113 -62 248 -136 300 -165 162 -89 224 -126 242 -142 43 -39 26 -119 -31 -143 -54 -22 -79 -13 -344 131 -138 75 -326 165 -382 184 -30 10 -82 17 -130 16 -133 0 -276 -61 -339 -144 -23 -30 -300 -487 -393 -647 -23 -41 -48 -89 -54 -108 -17 -50 -7 -149 20 -205 30 -61 95 -127 151 -154 44 -21 309 -83 955 -224 199 -43 339 -79 371 -94 112 -54 188 -154 200 -261 5 -42 1 -57 -24 -106 -17 -32 -109 -172 -203 -310 -95 -139 -285 -419 -422 -623 -137 -203 -263 -382 -280 -397 -18 -15 -60 -41 -95 -59 -53 -27 -77 -33 -145 -37 -55 -2 -97 1 -127 11 -43 14 -296 123 -480 207 -130 58 -412 182 -535 235 -65 27 -121 58 -137 75 -61 66 -40 159 45 194 46 19 46 19 104 -2 32 -11 164 -64 293 -117 597 -244 661 -268 737 -273 132 -8 266 50 343 150 36 46 175 260 403 618 80 125 106 190 107 262 0 121 -78 241 -190 292 -52 23 -751 204 -1300 336 -240 57 -246 59 -279 95 -31 34 -33 41 -29 89 3 37 16 72 48 126 73 127 267 454 405 685 125 208 190 319 283 480 44 77 117 152 178 183 40 20 123 40 184 45 49 3 128 -8 196 -28z", tx: 793, ty: 337, tz: 429, palette: "pink" },
    { d: "M551 4155 c-18 -16 -36 -46 -47 -78 -33 -103 -204 -576 -280 -777 -89 -236 -96 -283 -54 -360 45 -81 156 -119 265 -89 22 6 98 33 169 61 70 27 131 47 133 44 6 -6 -21 -48 -287 -456 -95 -146 -179 -282 -187 -303 -8 -24 -17 -126 -24 -270 -5 -128 -21 -436 -34 -686 l-24 -455 -47 -67 c-54 -78 -66 -134 -41 -189 9 -19 68 -116 130 -215 98 -153 122 -184 158 -205 35 -20 58 -25 109 -25 111 1 192 57 255 177 l39 73 7 195 c10 250 29 1139 29 1336 0 150 0 151 -27 178 -46 46 -98 47 -149 2 -27 -23 -28 -27 -35 -167 -4 -79 -12 -439 -19 -799 -6 -360 -13 -670 -16 -688 -5 -34 -57 -102 -79 -102 -12 0 -135 181 -174 259 l-22 43 36 52 c19 28 40 67 45 86 10 38 64 822 80 1179 6 123 16 233 22 245 20 39 206 332 333 526 70 106 133 207 141 226 52 123 -55 275 -193 274 -40 -1 -62 -8 -265 -88 -88 -35 -128 -46 -128 -37 0 20 124 363 320 886 50 132 51 160 6 205 -27 27 -42 34 -74 34 -29 0 -49 -7 -71 -25z", tx: 1370, ty: 343, tz: 426, palette: "blue" },
    { d: "M1457 3834 c-42 -8 -150 -38 -240 -68 -300 -100 -782 -268 -837 -293 -78 -34 -186 -120 -225 -179 -50 -75 -78 -167 -72 -236 7 -75 63 -181 144 -269 107 -118 97 -76 192 -759 35 -249 143 -1064 202 -1520 11 -85 25 -171 30 -190 29 -96 129 -191 237 -226 148 -47 339 44 411 196 23 49 26 67 25 160 0 58 -12 191 -27 295 -56 409 -98 713 -107 780 -5 39 -32 241 -59 450 -27 209 -64 488 -82 620 -27 207 -30 246 -20 284 15 54 83 123 139 139 60 18 751 17 795 -1 46 -20 95 -64 116 -106 17 -32 165 -598 300 -1141 27 -113 88 -358 135 -545 46 -187 101 -410 121 -495 20 -85 46 -178 59 -206 34 -73 88 -129 161 -165 59 -29 70 -31 147 -27 62 2 95 9 132 27 103 51 173 158 182 279 5 58 -3 104 -60 347 -36 154 -124 531 -195 838 -82 356 -135 565 -146 577 -30 33 -71 44 -115 31 -50 -15 -80 -53 -80 -100 0 -20 14 -92 30 -161 17 -69 46 -190 65 -270 105 -448 170 -722 224 -945 34 -137 61 -267 61 -288 0 -53 -25 -96 -67 -113 -42 -18 -83 -11 -111 19 -22 23 -54 147 -437 1676 -110 438 -184 714 -201 749 -40 82 -127 165 -220 209 l-79 38 -380 3 c-320 2 -391 0 -452 -13 -104 -23 -182 -66 -246 -134 -63 -69 -92 -125 -108 -212 -10 -59 -7 -95 40 -429 51 -357 69 -489 208 -1495 37 -269 67 -506 66 -526 -3 -103 -99 -166 -188 -123 -40 19 -74 76 -75 125 0 26 -25 222 -125 969 -72 542 -83 629 -131 965 -41 298 -47 325 -79 390 -18 39 -63 104 -99 145 -36 41 -72 89 -81 107 -19 39 -19 96 -1 132 20 38 76 86 139 117 126 65 956 348 1048 359 41 5 74 2 115 -10 74 -21 118 -46 224 -130 159 -127 224 -155 351 -155 111 0 204 32 333 114 58 37 124 73 148 82 38 13 135 14 674 12 l629 -3 56 -28 c73 -35 147 -109 182 -180 17 -36 45 -137 77 -289 28 -128 82 -375 120 -548 166 -751 221 -1006 256 -1170 22 -110 54 -224 84 -306 27 -72 52 -154 56 -182 12 -93 -50 -183 -151 -220 -16 -6 -121 -34 -233 -62 -160 -40 -207 -48 -223 -40 -38 21 -16 44 93 100 120 62 168 103 204 172 38 74 39 112 10 239 -14 63 -62 278 -107 479 -199 896 -338 1478 -364 1531 -59 115 -185 212 -312 239 -33 7 -184 10 -434 8 -375 -3 -385 -4 -442 -26 -75 -31 -168 -116 -202 -187 -35 -71 -41 -144 -21 -252 9 -48 20 -117 26 -153 8 -51 16 -70 40 -95 25 -24 39 -30 74 -30 30 0 54 7 73 21 47 35 49 67 19 224 -17 85 -25 152 -21 170 9 42 49 87 88 99 18 6 181 13 368 16 317 5 341 4 402 -15 50 -16 73 -30 105 -64 43 -47 60 -93 102 -276 12 -52 41 -178 65 -280 60 -253 141 -608 235 -1025 43 -192 87 -383 96 -423 18 -71 17 -74 -1 -108 -15 -28 -38 -44 -131 -89 -84 -41 -122 -66 -151 -99 -87 -99 -84 -225 7 -317 51 -51 117 -79 187 -79 89 0 454 95 563 147 166 79 265 240 246 402 -4 31 -29 121 -56 201 -48 143 -70 237 -260 1130 -65 305 -88 412 -205 949 -25 118 -55 238 -66 267 -48 127 -159 248 -284 310 -127 62 -142 64 -827 64 l-617 0 -79 -25 c-48 -15 -126 -53 -198 -97 -144 -86 -171 -98 -226 -98 -61 1 -107 25 -233 125 -126 99 -240 158 -336 174 -80 13 -93 13 -192 -5z", tx: 33, ty: 364, tz: 393, palette: "amber" },
    { d: "M370 773 c-42 -6 -113 -35 -153 -61 -49 -33 -100 -104 -122 -171 -25 -77 -16 -183 21 -251 37 -68 111 -135 192 -173 59 -28 77 -32 152 -32 77 0 92 3 153 34 117 59 186 161 195 287 4 62 1 79 -23 132 -50 111 -179 206 -314 232 -30 5 -59 9 -65 9 -6 -1 -22 -4 -36 -6z m148 -222 c22 -11 52 -35 67 -53 24 -28 27 -39 23 -83 -6 -71 -36 -111 -98 -129 -83 -25 -168 9 -208 82 -29 52 -30 101 -5 144 39 69 131 85 221 39z", tx: 1523, ty: 366, tz: 86, palette: "amber" },
    { d: "M369 747 c-120 -41 -197 -111 -252 -226 -25 -54 -31 -77 -31 -140 0 -59 4 -86 22 -123 26 -53 91 -116 154 -150 37 -20 58 -23 143 -23 94 0 105 2 169 34 83 41 159 115 206 201 32 59 35 73 35 145 0 70 -4 87 -30 134 -57 103 -153 162 -275 168 -60 3 -89 -1 -141 -20z m202 -200 c37 -25 56 -76 45 -120 -10 -43 -69 -111 -116 -134 -62 -32 -134 -31 -183 2 -43 30 -54 62 -38 117 37 121 200 197 292 135z", tx: 1637, ty: 382, tz: 85, palette: "amber" },
    { d: "M290 691 c-84 -26 -157 -89 -188 -160 -23 -56 -19 -142 12 -205 33 -68 138 -169 209 -201 77 -36 157 -49 218 -36 191 41 280 208 201 376 -49 103 -169 198 -284 225 -50 11 -132 12 -168 1z m169 -212 c73 -36 111 -85 111 -141 0 -44 -27 -68 -77 -68 -117 0 -246 142 -190 212 29 37 78 36 156 -3z", tx: 580, ty: 401, tz: 78, palette: "amber" },
    { d: "M363 735 c-128 -35 -220 -133 -265 -278 -47 -156 18 -303 161 -363 18 -8 66 -14 105 -14 57 0 82 5 131 29 73 34 146 110 183 189 23 49 27 70 27 147 0 75 -4 98 -24 135 -29 57 -85 116 -132 140 -51 27 -124 32 -186 15z m117 -203 c18 -14 24 -32 28 -75 6 -70 -8 -106 -59 -152 -45 -40 -77 -51 -116 -38 -86 29 -58 190 46 260 41 28 71 29 101 5z", tx: 692, ty: 411, tz: 83, palette: "amber" },
    { d: "M925 2802 c-168 -67 -437 -264 -516 -378 -16 -24 -37 -63 -45 -86 -9 -24 -40 -185 -69 -358 -30 -173 -70 -403 -89 -510 -138 -784 -130 -727 -118 -821 19 -152 106 -318 222 -422 101 -91 288 -156 409 -142 82 10 168 33 222 60 65 33 280 164 621 377 347 217 336 214 410 101 50 -75 81 -102 137 -121 108 -37 237 30 292 152 25 54 24 147 -1 220 -64 186 -187 319 -341 367 -149 46 -214 24 -609 -211 -537 -319 -575 -340 -626 -340 -52 0 -93 20 -120 59 -34 47 -34 77 -4 239 106 582 150 828 160 902 20 144 51 190 152 226 52 19 97 13 169 -21 86 -40 136 -31 178 30 44 65 8 119 -112 167 -73 29 -92 33 -182 33 -93 0 -104 -2 -161 -32 -83 -43 -167 -123 -199 -187 -18 -36 -35 -107 -55 -222 -16 -93 -41 -230 -55 -304 -14 -74 -43 -234 -65 -355 -21 -121 -46 -254 -54 -296 -17 -84 -11 -154 18 -224 24 -56 81 -129 124 -158 81 -53 210 -72 304 -43 43 13 320 168 723 406 105 62 207 118 229 126 83 30 170 10 233 -52 45 -45 94 -133 112 -202 10 -34 9 -47 -4 -72 -8 -16 -21 -30 -28 -30 -6 0 -31 31 -54 68 -69 112 -121 155 -201 168 -76 12 -130 -11 -369 -158 -454 -279 -707 -430 -747 -445 -24 -9 -77 -16 -126 -17 -78 -1 -92 2 -152 32 -37 18 -88 54 -114 80 -59 58 -109 163 -126 259 -11 64 -9 84 11 195 13 68 40 220 61 338 21 118 54 301 74 405 19 105 51 291 71 415 20 124 43 242 52 263 29 68 189 197 366 297 43 24 75 34 122 38 56 4 72 1 121 -23 39 -19 68 -43 95 -79 48 -64 125 -167 506 -681 168 -225 317 -420 331 -432 32 -27 91 -30 126 -8 30 20 50 67 42 100 -4 14 -120 177 -259 363 -139 185 -316 422 -393 526 -197 268 -253 335 -306 372 -115 78 -266 96 -393 46z", tx: 1108, ty: 448, tz: 291, palette: "pink" },
    { d: "M940 2961 c-69 -21 -152 -85 -189 -145 -11 -18 -74 -194 -140 -392 -146 -440 -298 -888 -427 -1259 -89 -258 -97 -286 -97 -355 0 -87 21 -142 76 -205 19 -22 59 -54 88 -70 49 -27 62 -30 149 -30 79 0 103 4 143 24 63 31 129 97 162 160 14 28 39 93 56 144 17 50 93 263 169 472 75 209 159 445 185 523 27 79 61 162 77 184 17 22 48 48 71 59 77 34 176 18 211 -36 15 -23 60 -168 141 -460 27 -93 50 -175 52 -182 6 -16 -15 -21 -157 -33 -69 -6 -140 -16 -157 -21 -96 -30 -99 -164 -5 -200 40 -15 403 26 460 52 46 20 78 63 88 118 7 35 -23 152 -147 581 -81 278 -111 326 -245 387 -131 60 -293 32 -419 -72 -78 -64 -113 -131 -206 -393 -47 -136 -132 -375 -188 -532 -56 -157 -118 -332 -138 -390 -47 -133 -79 -170 -148 -170 -38 0 -52 5 -76 29 -22 23 -29 39 -29 69 0 22 29 124 69 238 223 644 287 830 417 1218 79 236 151 437 160 447 32 35 76 34 227 -6 289 -75 572 -157 594 -173 13 -8 30 -27 38 -43 8 -15 96 -348 195 -741 99 -392 218 -854 264 -1027 84 -310 85 -314 69 -352 -22 -56 -55 -79 -114 -79 -85 0 -74 -26 -198 449 -68 258 -84 308 -107 332 -56 58 -145 45 -178 -26 l-18 -38 60 -221 c128 -465 144 -520 159 -549 28 -56 106 -123 169 -147 156 -58 341 24 421 188 24 48 28 69 27 137 0 70 -16 137 -123 535 -67 250 -185 707 -262 1015 -77 308 -149 579 -159 602 -27 61 -67 110 -117 145 -43 29 -176 70 -683 208 -141 39 -215 47 -270 31z", tx: 1487, ty: 450, tz: 305, palette: "amber" },
    { d: "M1972 1966 c-73 -24 -147 -90 -176 -156 -9 -19 -69 -252 -135 -517 -66 -265 -124 -491 -130 -501 -22 -41 -89 -90 -137 -100 -31 -7 -140 -8 -293 -5 -220 6 -247 8 -284 27 -49 25 -83 71 -92 125 -5 28 14 144 70 427 82 417 84 442 45 531 -26 60 -97 127 -155 146 -66 23 -152 21 -217 -3 -67 -25 -140 -88 -167 -143 -12 -25 -49 -189 -91 -404 -38 -200 -84 -427 -100 -507 -37 -179 -38 -258 -5 -365 59 -185 213 -335 408 -396 69 -22 106 -26 340 -35 393 -15 633 -13 725 6 234 48 451 229 533 443 10 27 36 134 58 238 22 103 71 330 108 503 37 173 69 346 71 383 5 87 -18 154 -75 217 -73 81 -203 118 -301 86z m112 -217 c30 -14 50 -59 43 -96 -42 -230 -207 -1013 -223 -1059 -16 -43 -97 -144 -142 -178 -27 -19 -77 -49 -111 -65 -111 -52 -156 -55 -598 -42 -219 6 -420 17 -448 23 -156 34 -280 164 -304 320 -7 44 -2 84 30 243 58 282 116 578 134 683 8 52 22 106 30 121 30 58 105 61 141 6 16 -25 14 -39 -60 -414 -42 -213 -76 -408 -76 -433 0 -50 23 -134 51 -190 27 -52 109 -131 166 -159 45 -22 68 -24 328 -36 296 -12 364 -8 456 26 73 28 144 87 194 161 37 54 51 90 84 215 50 190 97 377 156 630 26 110 52 208 57 218 8 16 39 34 60 36 4 1 18 -4 32 -10z", tx: 551, ty: 513, tz: 206, palette: "amber" },
  ];

  class WidgetMusain extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      // Active theme id, injected by the manager via context.
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this._paths = LETTERS.map((l) =>
        typeof Path2D !== "undefined" ? new Path2D(l.d) : null
      );

      this._nextFlickerAt = 0;
      this._flickerUntil = 0;
      this._glitchUntil = 0;
    }

    onMount() {
      // HARD theme gate: never spin up the loop or draw on a non-grimhex theme.
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
    // Star Citizen chat / Grim HEX widgets).
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

      // --- pseudo-3D sway + glitch jitter ---
      const swayX = Math.sin(t * 0.5) * 4;
      const swayY = Math.cos(t * 0.4) * 3;
      const rot = Math.sin(t * 0.22) * 0.06;
      const dx = glitching ? (Math.random() * 2 - 1) * 7 : 0;

      const cx = cw / 2 + swayX + dx;
      const cy = ch / 2 + swayY;

      // Fit the neon sign (not the padded viewBox) to the widget. 0.84 leaves
      // room for the outer neon glow.
      const scale = Math.min((cw * 0.84) / SIGN_W, (ch * 0.84) / SIGN_H);

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);

      // Draw by layer (so glows blend coherently), then by tube segment.
      for (const layer of LAYERS) {
        const blurPx = layer.blur * scale * dpr;
        for (let i = 0; i < LETTERS.length; i++) {
          const letter = LETTERS[i];
          const path = this._paths[i];
          if (!path) continue;

          const color = PALETTES[letter.palette][layer.key];
          ctx.save();
          if (layer.blur > 0) ctx.globalCompositeOperation = "lighter"; // additive neon glow
          ctx.fillStyle = color;
          ctx.globalAlpha = layer.alpha * intensity;
          if (layer.blur > 0) {
            ctx.shadowColor = color;
            ctx.shadowBlur = blurPx * intensity;
          }
          // SVG transform: translate(tx,ty) translate(0,tz) scale(0.1,-0.1),
          // then centre the sign (SIGN_CX, SIGN_CY) instead of the viewBox.
          ctx.transform(
            0.1 * scale,
            0,
            0,
            -0.1 * scale,
            scale * (letter.tx - SIGN_CX),
            scale * (letter.ty + letter.tz - SIGN_CY)
          );
          ctx.fill(path);
          ctx.restore();
        }
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

  return WidgetMusain;
});
