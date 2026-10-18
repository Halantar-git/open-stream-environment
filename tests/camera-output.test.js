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
  Размер кадра видео-моста (control/modules/camera-output.js). Правило
  простое, но у него есть края: телефон отдаёт 4:3 и нестандартные стороны,
  а сверху добавляется требование H.264 к чётным размерам.
*/

const { cameraOutputSize } = require("../control/modules/camera-output");

describe("cameraOutputSize", () => {
  test("уменьшает 1080p до выбранной ширины", () => {
    expect(cameraOutputSize(960, 1920, 1080)).toEqual({ width: 960, height: 540 });
  });

  test("не растягивает кадр выше источника", () => {
    expect(cameraOutputSize(1920, 1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  test("сохраняет пропорции 4:3 от телефона", () => {
    expect(cameraOutputSize(960, 1440, 1080)).toEqual({ width: 960, height: 720 });
  });

  test("4K сводится к тем же 960×540", () => {
    expect(cameraOutputSize(960, 3840, 2160)).toEqual({ width: 960, height: 540 });
  });

  test("без известного источника берёт 16:9 по выбранной ширине", () => {
    expect(cameraOutputSize(960, 0, 0)).toEqual({ width: 960, height: 540 });
    expect(cameraOutputSize(1280, null, undefined)).toEqual({ width: 1280, height: 720 });
  });

  test("округляет нечётные стороны вниз до чётных", () => {
    expect(cameraOutputSize(1920, 1919, 1079)).toEqual({ width: 1918, height: 1078 });
  });

  test("не отдаёт размер меньше двух пикселей", () => {
    const size = cameraOutputSize(1, 1, 1);
    expect(size.width).toBeGreaterThanOrEqual(2);
    expect(size.height).toBeGreaterThanOrEqual(2);
  });
});
