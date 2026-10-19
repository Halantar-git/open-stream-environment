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
  Ориентация визуализатора микрофона (control/modules/mic-orientation.js):
  смена сторон рамки вокруг центра и угол поворота рисунка. Логика чистая,
  DOM не нужен.
*/

const { micOrientationPatch } = require("../control/modules/mic-orientation");

describe("micOrientationPatch: вертикальная ориентация", () => {
  test("широкий виджет становится высоким вокруг своего центра", () => {
    const rect = micOrientationPatch({ x: 20, y: 40, w: 40, h: 12 }, true);

    expect(rect.swapped).toBe(true);
    expect(rect.rotation).toBe(90);
    expect(rect.w).toBe(12);
    expect(rect.h).toBe(40);
    // Центр (40, 46) остался на месте: 40 − 6 = 34, 46 − 20 = 26.
    expect(rect.x).toBe(34);
    expect(rect.y).toBe(26);
  });

  test("при упоре в нижнюю границу виджет прижимается к холсту", () => {
    const rect = micOrientationPatch({ x: 50, y: 82, w: 40, h: 12 }, true);

    expect(rect.h).toBe(40);
    expect(rect.y + rect.h).toBe(100);
  });

  test("уже вертикальную рамку не трогает", () => {
    const rect = micOrientationPatch({ x: 10, y: 10, w: 12, h: 40 }, true);

    expect(rect.swapped).toBe(false);
    expect(rect.rotation).toBe(90);
    expect(rect).toMatchObject({ x: 10, y: 10, w: 12, h: 40 });
  });
});

describe("micOrientationPatch: горизонтальная ориентация", () => {
  test("высокий виджет снова ложится набок", () => {
    const rect = micOrientationPatch({ x: 10, y: 10, w: 12, h: 40 }, false);

    expect(rect.swapped).toBe(true);
    expect(rect.rotation).toBe(0);
    expect(rect.w).toBe(40);
    expect(rect.h).toBe(12);
  });

  test("широкую рамку оставляет как есть", () => {
    const rect = micOrientationPatch({ x: 5, y: 5, w: 40, h: 12 }, false);

    expect(rect.swapped).toBe(false);
    expect(rect.rotation).toBe(0);
    expect(rect).toMatchObject({ x: 5, y: 5, w: 40, h: 12 });
  });
});

describe("micOrientationPatch: защита от мусора", () => {
  test("пустая геометрия даёт рамку в левом верхнем углу", () => {
    const rect = micOrientationPatch(undefined, true);

    expect(rect).toMatchObject({ rotation: 90, w: 0, h: 0, x: 0, y: 0 });
  });

  test("виджет больше холста прижимается к границам", () => {
    const rect = micOrientationPatch({ x: 0, y: 0, w: 150, h: 20 }, true);

    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBe(0);
  });
});
