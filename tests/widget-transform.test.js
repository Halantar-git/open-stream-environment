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
  Поворот 3D-виджетов живёт в BaseWidget, поэтому проверяется без DOM и без
  конкретного виджета: если сломается склейка угла с наклоном, это видно здесь,
  а не в эфире.
*/

const BaseWidget = require("../overlay/widgets/base-widget");

function widget(config = {}) {
  const instance = new BaseWidget({ id: "w", type: "grimhex-chat", config });
  instance.element = { style: {} };
  return instance;
}

const TILT = "perspective(1200px) rotateY(-7.5deg) rotateX(1.5deg)";

describe("BaseWidget: поворот 3D-виджетов", () => {
  test("без угла и наклона transform пустой", () => {
    const w = widget({});
    w._applyTransform();

    expect(w.element.style.transform).toBe("");
    expect(w.element.style.transformStyle).toBe("");
  });

  test("угол поворачивает виджет вокруг центра", () => {
    const w = widget({ angle: 30 });
    w._applyTransform();

    expect(w.element.style.transform).toBe("rotate(30deg)");
    // preserve-3d нужен только наклону.
    expect(w.element.style.transformStyle).toBe("");
  });

  test("угол складывается с перспективой, а не затирает её", () => {
    const w = widget({ angle: 30 });
    w._setTilt(TILT);

    // Поворот идёт последним: сначала знак крутится в своей плоскости, потом
    // наклоняется целиком.
    expect(w.element.style.transform).toBe(`${TILT} rotate(30deg)`);
    expect(w.element.style.transformStyle).toBe("preserve-3d");
  });

  test("обновление геометрии не сбрасывает наклон и угол", () => {
    const w = widget({ angle: 15 });
    w._setTilt(TILT);

    w.update({ x: 20, w: 40 });

    expect(w.element.style.left).toBe("20%");
    expect(w.element.style.width).toBe("40%");
    expect(w.element.style.transform).toBe(`${TILT} rotate(15deg)`);
  });

  test("угол приводится к 0–359", () => {
    expect(widget({ angle: -90 })._widgetAngle()).toBe(270);
    expect(widget({ angle: 720 })._widgetAngle()).toBe(0);
    expect(widget({ angle: 45.4 })._widgetAngle()).toBe(45);
    expect(widget({ angle: "60" })._widgetAngle()).toBe(60);
    expect(widget({ angle: "кривой" })._widgetAngle()).toBe(0);
  });

  test("сброс наклона убирает preserve-3d", () => {
    const w = widget({ angle: 10 });
    w._setTilt(TILT);
    w._setTilt("");

    expect(w.element.style.transform).toBe("rotate(10deg)");
    expect(w.element.style.transformStyle).toBe("");
  });

  test("поворот холста визуализатора не превращается в CSS-угол", () => {
    // У микрофона `rotation` — это угол отрисовки на канвасе, а не поворот
    // рамки: если применить его ещё и к element, картинка встанет дважды.
    const mic = new BaseWidget({ id: "m", type: "mic", config: { rotation: 90 } });
    mic.element = { style: {} };
    mic._applyGeometry();

    expect(mic.element.style.transform).toBe("");
  });
});
