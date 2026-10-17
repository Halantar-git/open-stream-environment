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

const MicWidget = require("../overlay/widgets/mic-widget");

function widget(config) {
  const instance = new MicWidget({ type: "mic", config }, {});
  instance.element = { style: {} };
  return instance;
}

describe("MicWidget: перспектива", () => {
  test("наклоняется вправо с той же силой, что и 3D-виджеты", () => {
    const w = widget({ perspective: 50, perspectiveDirection: "right" });
    w._applyPerspective();

    expect(w.element.style.transform).toBe(
      "perspective(1200px) rotateY(7.5deg) rotateX(1.5deg)"
    );
    expect(w.element.style.transformStyle).toBe("preserve-3d");
  });

  test("по умолчанию наклон влево", () => {
    const w = widget({ perspective: 50 });
    w._applyPerspective();

    expect(w.element.style.transform).toBe(
      "perspective(1200px) rotateY(-7.5deg) rotateX(1.5deg)"
    );
  });

  test("направления вверх и вниз меняют ось", () => {
    const up = widget({ perspective: 100, perspectiveDirection: "up" });
    up._applyPerspective();
    expect(up.element.style.transform).toBe(
      "perspective(1200px) rotateY(0deg) rotateX(15deg)"
    );

    const down = widget({ perspective: 100, perspectiveDirection: "down" });
    down._applyPerspective();
    expect(down.element.style.transform).toBe(
      "perspective(1200px) rotateY(0deg) rotateX(-15deg)"
    );
  });

  test("нулевая перспектива убирает трансформацию", () => {
    const w = widget({ perspective: 0 });
    w.element.style.transform = "old";
    w.element.style.transformStyle = "preserve-3d";

    w._applyPerspective();
    expect(w.element.style.transform).toBe("");
    expect(w.element.style.transformStyle).toBe("");
  });

  test("сила зажимается в 0–100", () => {
    const over = widget({ perspective: 500, perspectiveDirection: "up" });
    over._applyPerspective();
    expect(over.element.style.transform).toBe(
      "perspective(1200px) rotateY(0deg) rotateX(15deg)"
    );

    const below = widget({ perspective: -50 });
    below._applyPerspective();
    expect(below.element.style.transform).toBe("");
  });

  test("обновление конфига сразу применяет наклон", () => {
    const w = new MicWidget({ type: "mic", config: { perspective: 0 } }, {});
    w.element = { style: {} };

    w.update({ type: "mic", config: { perspective: 50, perspectiveDirection: "right" } });
    expect(w.element.style.transform).toBe(
      "perspective(1200px) rotateY(7.5deg) rotateX(1.5deg)"
    );
  });
});
