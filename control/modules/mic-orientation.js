/*
  Copyright (C) 2026  Halantar

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://gnu.org>.
*/

/*
  Геометрия визуализатора микрофона при смене ориентации.

  Поворот рисунка сам по себе не делает виджет вертикальным: в широкой рамке
  вертикальная волна остаётся тонкой полоской по центру, а столбики — узкой
  полосой у края. Поэтому вместе с углом меняются местами стороны рамки, а
  положение сохраняется по центру (с прижатием к холсту, если виджет упирается
  в границу).

  Формат UMD, как у `guards.js`: в браузере файл подключается обычным
  <script> и живёт на window, а Jest забирает его через require — логика
  проверяется без DOM (см. tests/mic-orientation.test.js).
*/
(function (root) {
  "use strict";

  const CANVAS = 100;

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  /*
    `geometry` — { x, y, w, h } в процентах холста, `vertical` — нужна ли
    вертикальная раскладка. Возвращает новый прямоугольник и угол поворота
    рисунка: 0 — вдоль ширины рамки, 90 — вдоль высоты. `swapped` говорит,
    менялись ли стороны: если рамка уже нужной пропорции, размер не трогаем.
  */
  function micOrientationPatch(geometry, vertical) {
    const source = geometry || {};
    const x = Number(source.x) || 0;
    const y = Number(source.y) || 0;
    const w = Number(source.w) || 0;
    const h = Number(source.h) || 0;
    const wantsTall = !!vertical;
    const swapped = wantsTall ? !(h > w) : h > w;
    const nextW = swapped ? h : w;
    const nextH = swapped ? w : h;
    const centerX = x + w / 2;
    const centerY = y + h / 2;
    return {
      rotation: wantsTall ? 90 : 0,
      swapped,
      x: clamp(centerX - nextW / 2, 0, Math.max(0, CANVAS - nextW)),
      y: clamp(centerY - nextH / 2, 0, Math.max(0, CANVAS - nextH)),
      w: nextW,
      h: nextH,
    };
  }

  const api = { micOrientationPatch };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ControlMicOrientation = api;
})(typeof window !== "undefined" ? window : globalThis);
