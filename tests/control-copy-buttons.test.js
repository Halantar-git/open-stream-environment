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
  Подписи кнопок копирования в панели.

  Словари приходят по WebSocket уже после запуска скриптов, поэтому подпись,
  выставленная из JS через t() при инициализации, осталась бы техническим
  ключом (например, `common.copy`). Кнопки обязаны переводиться через
  data-i18n — тогда I18n.apply() обновит их вместе с языком.
*/

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "control", "control.html"), "utf8");
const ru = JSON.parse(fs.readFileSync(path.join(ROOT, "shared", "locales", "ru.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "shared", "locales", "en.json"), "utf8"));

function resolve(dict, key) {
  return String(key)
    .split(".")
    .reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), dict);
}

function buttonTag(selector) {
  const match = html.match(new RegExp(`<button[^>]*${selector}[^>]*>`));
  return match ? match[0] : "";
}

describe("control/control.html: кнопки копирования", () => {
  test("у каждой кнопки с data-copy есть data-i18n", () => {
    const tags = [...html.matchAll(/<button[^>]*\bdata-copy="[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.filter((tag) => !/\bdata-i18n="/.test(tag))).toEqual([]);
  });

  test("кнопки адреса оверлея и сцены подписаны через словарь", () => {
    ["copyUrlBtn", "copySceneUrlBtn", "copyOverlayUrlBtn"].forEach((id) => {
      const tag = buttonTag(`id="${id}"`);
      expect(tag).not.toBe("");
      expect(tag).toMatch(/\bdata-i18n="/);
    });
  });

  test("ключи подписей есть в обоих словарях", () => {
    const tags = [...html.matchAll(/<button[^>]*\bdata-i18n="([^"]+)"[^>]*>/g)].map((m) => m[1]);
    const keys = [...new Set(tags)];
    expect(keys.length).toBeGreaterThan(0);
    const missing = keys.filter(
      (key) => typeof resolve(ru, key) !== "string" || typeof resolve(en, key) !== "string"
    );
    expect(missing).toEqual([]);
  });
});
