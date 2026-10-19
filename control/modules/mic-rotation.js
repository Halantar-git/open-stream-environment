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
  Поворот визуализатора микрофона: угол рисунка и рамка под него.

  Одного угла мало: в широкой рамке вертикальная волна остаётся тонкой
  полоской по центру, а столбики — узкой полосой у края. Поэтому, если рамка
  не совпадает по пропорции с углом (90/270 — высокая, 0/180 — широкая),
  стороны меняются местами вокруг центра, а положение прижимается к холсту,
  когда виджет упирается в границу.

  Формат UMD, как у `guards.js`: в браузере файл подключается обычным
  <script> и живёт на window, а Jest забирает его через require — логика
  проверяется без DOM (см. tests/mic-rotation.test.js).
*/
(function (root) {
  "use strict";

  const CANVAS = 100;

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  // Допустимые углы перебираются кнопками, но конфиг мог приехать из чужого
  // файла — всё, что не кратно 90, считаем «без поворота».
  function normalizeRotation(value) {
    const n = Number(value);
    return n === 90 || n === 180 || n === 270 ? n : 0;
  }

  /*
    `geometry` — { x, y, w, h } в процентах холста, `rotation` — целевой угол
    рисунка (0/90/180/270). Возвращает новый прямоугольник, угол и признак
    `swapped`: если рамка уже нужной пропорции (например, при развороте на
    180°), размер и положение не трогаем.
  */
  function micRotationPatch(geometry, rotation) {
    const source = geometry || {};
    const x = Number(source.x) || 0;
    const y = Number(source.y) || 0;
    const w = Number(source.w) || 0;
    const h = Number(source.h) || 0;
    const angle = normalizeRotation(rotation);
    const wantsTall = angle === 90 || angle === 270;
    const swapped = wantsTall !== h > w;
    const nextW = swapped ? h : w;
    const nextH = swapped ? w : h;
    const centerX = x + w / 2;
    const centerY = y + h / 2;
    return {
      rotation: angle,
      swapped,
      x: clamp(centerX - nextW / 2, 0, Math.max(0, CANVAS - nextW)),
      y: clamp(centerY - nextH / 2, 0, Math.max(0, CANVAS - nextH)),
      w: nextW,
      h: nextH,
    };
  }

  const api = { micRotationPatch, normalizeRotation };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ControlMicRotation = api;
})(typeof window !== "undefined" ? window : globalThis);
