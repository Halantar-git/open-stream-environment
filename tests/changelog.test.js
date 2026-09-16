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
  Сверка версии CHANGELOG с package.json.

  Версию в package.json поднять и забыть про CHANGELOG — самая незаметная
  ошибка релиза: сборка уходит с новой версией, а описания изменений в ней
  нет. Здесь же ловится и нарушение формата заголовков, на котором держится
  чтение истории версий.
*/

const fs = require("fs");
const path = require("path");

const pkg = require("../package.json");

const CHANGELOG_PATH = path.join(__dirname, "..", "CHANGELOG.md");
const changelog = fs.readFileSync(CHANGELOG_PATH, "utf8");
const headingLines = changelog.split(/\r?\n/).filter((line) => /^##\s/.test(line));

const VERSION_HEADING = /^##\s+\[(\d+\.\d+\.\d+)\]\s+—\s+\d{4}-\d{2}-\d{2}\s*$/;

function releasedVersions() {
  return headingLines.map((line) => (line.match(VERSION_HEADING) || [])[1]).filter(Boolean);
}

describe("CHANGELOG", () => {
  test("есть хотя бы одна версия", () => {
    expect(releasedVersions().length).toBeGreaterThan(0);
  });

  test("самая свежая версия в CHANGELOG совпадает с package.json", () => {
    expect(releasedVersions()[0]).toBe(pkg.version);
  });

  test("версия в package.json — корректный semver", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("версии не повторяются", () => {
    const versions = releasedVersions();
    const duplicates = versions.filter((version, index) => versions.indexOf(version) !== index);
    expect(duplicates).toEqual([]);
  });

  test("все заголовки версий одного формата", () => {
    const bad = headingLines.filter((line) => !VERSION_HEADING.test(line) && !/^##\s+\[Unreleased\]/.test(line));
    expect(bad).toEqual([]);
  });

  test("у текущей версии есть разделы изменений", () => {
    // Про историю проекта не спорим, а вот у версии, которая сейчас в
    // package.json, список изменений быть обязан: иначе релиз уходит без
    // описания того, что в нём поменялось.
    const sections = changelog.split(/\r?\n##\s+\[/).slice(1);
    const current = sections.find((section) => section.startsWith(`${pkg.version}]`));

    expect(current).toBeTruthy();
    expect(current).toMatch(/###\s+(Added|Changed|Fixed|Removed|Security)/);
  });
});
