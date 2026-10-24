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
  Кадр, который сервер шлёт, но страница не пересылает в шину, теряется
  молча: виджет просто ничего не получает. Так уже вышло с музыкой —
  `music_play` и `music_control` до виджета не доходили, и он знал только
  о треках из алертов. Здесь проверяется, что обе страницы с виджетами
  (оверлей и сцена) эти кадры пересылают.
*/

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const PAGES = ["overlay/overlay.js", "overlay/scene-canvas.js"];

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

describe("кадры музыки доходят до виджета", () => {
  test.each(PAGES)("%s пересылает music_play и music_control", (file) => {
    const text = source(file);
    expect(text).toMatch(/case EVENT_TYPES\.MUSIC_PLAY:/);
    expect(text).toMatch(/case EVENT_TYPES\.MUSIC_CONTROL:/);
    // Оба обработчика должны оказаться в общем `bus.emit`, иначе виджет
    // подпишется, но ничего не получит.
    expect(text).toMatch(/case EVENT_TYPES\.MUSIC_PLAY:\s*\n\s*case EVENT_TYPES\.MUSIC_CONTROL:\s*\n[\s\S]{0,200}?bus\.emit\(msg\.type/);
  });
});
