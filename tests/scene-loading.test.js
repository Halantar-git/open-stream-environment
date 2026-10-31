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
  Страницы сцен до первого состояния.

  OBS перезагружает браузерный источник, когда сцена снова попадает в кадр.
  Статическая разметка сцены показывает «скелет»: таймер 00:00, «Пока нет»
  в событиях, тему по умолчанию. На переходе он успевал мелькнуть в эфире.
  Поэтому страница спрятана классом `is-pending` и показывает себя только
  тогда, когда пришло первое состояние с темой и содержимым.
*/

const fs = require("fs");
const path = require("path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

// Страницы с собственным оформлением сцены и их обработчики шины.
const PAGES = [
  ["overlay/scene.html", "overlay/scene.js"],
  ["overlay/poll-scene.html", "overlay/poll-scene.js"],
  ["overlay/wheel-scene.html", "overlay/wheel-scene.js"],
];

describe("Страницы сцен до первого состояния", () => {
  test("страница помечена как ожидающая", () => {
    const missing = PAGES.filter(([html]) => !/<body class="is-pending">/.test(read(html))).map(
      ([html]) => html,
    );
    expect(missing).toEqual([]);
  });

  test("стиль прячет сцену, пока класс не снят", () => {
    const css = read("overlay/scene.css");
    expect(css).toContain("body.is-pending .scene-wrapper");
    expect(css).toMatch(/body\.is-pending \.scene-wrapper \{[^}]*visibility: hidden;/);
  });

  test("состояние снимает ожидание", () => {
    const missing = PAGES.filter(([, js]) => !read(js).includes('classList.remove("is-pending")')).map(
      ([, js]) => js,
    );
    expect(missing).toEqual([]);
  });
});
