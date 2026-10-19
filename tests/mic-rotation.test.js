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
  Поворот визуализатора микрофона (control/modules/mic-rotation.js): угол
  рисунка и пропорции рамки под него. Логика чистая, DOM не нужен.
*/

const { micRotationPatch, normalizeRotation } = require("../control/modules/mic-rotation");

describe("micRotationPatch: поворот на 90°", () => {
  test("широкий виджет становится высоким вокруг своего центра", () => {
    const rect = micRotationPatch({ x: 20, y: 40, w: 40, h: 12 }, 90);

    expect(rect.swapped).toBe(true);
    expect(rect.rotation).toBe(90);
    expect(rect.w).toBe(12);
    expect(rect.h).toBe(40);
    // Центр (40, 46) остался на месте: 40 − 6 = 34, 46 − 20 = 26.
    expect(rect.x).toBe(34);
    expect(rect.y).toBe(26);
  });

  test("высокий виджет ложится набок", () => {
    const rect = micRotationPatch({ x: 20, y: 40, w: 12, h: 40 }, 180);

    expect(rect.swapped).toBe(true);
    expect(rect.rotation).toBe(180);
    expect(rect.w).toBe(40);
    expect(rect.h).toBe(12);
    // Центр (26, 60): 26 − 20 = 6, 60 − 6 = 54.
    expect(rect.x).toBe(6);
    expect(rect.y).toBe(54);
  });

  test("при упоре в нижнюю границу виджет прижимается к холсту", () => {
    const rect = micRotationPatch({ x: 50, y: 82, w: 40, h: 12 }, 90);

    expect(rect.h).toBe(40);
    expect(rect.y + rect.h).toBe(100);
  });
});

describe("micRotationPatch: разворот направления на 180°", () => {
  test("рамку не трогает, меняет только угол", () => {
    const rect = micRotationPatch({ x: 5, y: 5, w: 40, h: 12 }, 180);

    expect(rect.swapped).toBe(false);
    expect(rect.rotation).toBe(180);
    expect(rect).toMatchObject({ x: 5, y: 5, w: 40, h: 12 });
  });

  test("вертикальная рамка при развороте остаётся высокой", () => {
    const rect = micRotationPatch({ x: 10, y: 10, w: 12, h: 40 }, 270);

    expect(rect.swapped).toBe(false);
    expect(rect.rotation).toBe(270);
    expect(rect).toMatchObject({ x: 10, y: 10, w: 12, h: 40 });
  });
});

describe("micRotationPatch: защита от мусора", () => {
  test("пустая геометрия даёт рамку в левом верхнем углу", () => {
    const rect = micRotationPatch(undefined, 90);

    expect(rect).toMatchObject({ rotation: 90, w: 0, h: 0, x: 0, y: 0 });
  });

  test("виджет больше холста прижимается к границам", () => {
    const rect = micRotationPatch({ x: 0, y: 0, w: 150, h: 20 }, 90);

    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBe(0);
  });
});

describe("normalizeRotation", () => {
  test("пропускает допустимые углы", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(180)).toBe(180);
    expect(normalizeRotation(270)).toBe(270);
  });

  test("числовая строка тоже принимается — конфиг мог приехать из JSON", () => {
    expect(normalizeRotation("90")).toBe(90);
  });

  test("всё остальное считает «без поворота»", () => {
    expect(normalizeRotation(45)).toBe(0);
    expect(normalizeRotation(undefined)).toBe(0);
  });
});
