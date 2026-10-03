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
  Стандартные иконки сцен Stream Deck-плагина.

  Плагин выбирает картинку кнопки по сцене из `assets/scenes/`: `<сцена>.png`
  для обычного состояния и `<сцена>-active.png` для подсвеченного. Если пары на
  месте нет, плагин молча падает на запасную `assets/scene.png`, и кнопка
  выглядит одинаково для всех сцен — заметить это можно только глазами на
  железе. Поэтому набор держится полным и синхронным со списком сцен в `app.js`:

    * каждой сцене из `SCENES` — обе картинки;
    * ничего лишнего рядом: переименование сцены не оставляет мёртвых файлов;
    * картинки — настоящие PNG разумного размера, а не пустышки;
    * пути из `manifest.json` указывают на существующие файлы.
*/

const fs = require("fs");
const path = require("path");

const PLUGIN_DIR = path.join(__dirname, "..", "streamdeck-plugin");
const ASSETS_DIR = path.join(PLUGIN_DIR, "assets");
const SCENES_DIR = path.join(ASSETS_DIR, "scenes");

// Список сцен берём из самого плагина, а не дублируем: иначе тест разойдётся с
// кодом, который рисует кнопки.
function pluginScenes() {
  const source = fs.readFileSync(path.join(PLUGIN_DIR, "app.js"), "utf8");
  const block = source.match(/const SCENES = \[([\s\S]*?)\];/);
  if (!block) throw new Error("в app.js не найден список SCENES");

  const ids = [...block[1].matchAll(/\[\s*"([^"]+)"/g)].map((match) => match[1]);
  if (ids.length === 0) throw new Error("список SCENES в app.js пуст");
  return ids;
}

const scenes = pluginScenes();

describe("Stream Deck: иконки сцен", () => {
  test("у каждой сцены есть обычная и подсвеченная иконка", () => {
    const missing = [];
    for (const id of scenes) {
      for (const file of [`${id}.png`, `${id}-active.png`]) {
        if (!fs.existsSync(path.join(SCENES_DIR, file))) missing.push(file);
      }
    }
    expect(missing).toEqual([]);
  });

  test("в assets/scenes нет лишних файлов", () => {
    const expected = scenes.flatMap((id) => [`${id}.png`, `${id}-active.png`]).sort();
    expect(fs.readdirSync(SCENES_DIR).sort()).toEqual(expected);
  });

  test("иконки — непустые PNG не мельче 72x72", () => {
    const problems = [];
    for (const id of scenes) {
      for (const file of [`${id}.png`, `${id}-active.png`]) {
        const buf = fs.readFileSync(path.join(SCENES_DIR, file));
        if (buf.length < 24 || buf.subarray(1, 4).toString("ascii") !== "PNG") {
          problems.push(`${file}: не PNG`);
          continue;
        }
        const width = buf.readUInt32BE(16);
        const height = buf.readUInt32BE(20);
        if (width < 72 || height < 72) problems.push(`${file}: ${width}x${height}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("запасные иконки и иконка плагина на месте", () => {
    for (const file of ["plugin.png", "scene.png", "scene-active.png"]) {
      expect(fs.existsSync(path.join(ASSETS_DIR, file))).toBe(true);
    }
  });

  test("пути из manifest.json указывают на существующие картинки", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));

    const refs = new Set();
    if (manifest.Icon) refs.add(manifest.Icon);
    for (const action of manifest.Actions || []) {
      if (action.Icon) refs.add(action.Icon);
      for (const state of action.States || []) if (state.Image) refs.add(state.Image);
    }

    const missing = [...refs].filter((ref) => !fs.existsSync(path.join(PLUGIN_DIR, `${ref}.png`)));
    expect(missing).toEqual([]);
  });
});
