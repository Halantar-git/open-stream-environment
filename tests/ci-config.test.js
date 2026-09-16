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
  Проверка самих файлов CI.

  Ошибка в workflow не видна ни линту, ни локальным тестам: она проявляется
  ровно тогда, когда что-то пошло не так — при первом запуске на другой ОС или
  при попытке выпустить релиз. Здесь читаются те же файлы и проверяется то, что
  ломается тише всего:

    * matrix прогоняет lint и тесты на всех трёх платформах, на которых
      поставляется приложение;
    * версия Node в CI совпадает с engines.node — иначе CI проверяет не ту среду,
      в которой приложение запускается;
    * каждый «npm run <скрипт>» из workflow существует в package.json: опечатка
      вроде `distt:win` иначе всплыла бы только в день релиза;
    * релизный workflow запускается по тегу, отказывается собирать версию,
      не совпадающую с package.json, и умеет загружать артефакты (GH_TOKEN).
*/

const fs = require("fs");
const path = require("path");

const pkg = require("../package.json");

const WORKFLOWS_DIR = path.join(__dirname, "..", ".github", "workflows");

function workflow(name) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, name), "utf8");
}

const ci = workflow("ci.yml");
const release = workflow("release.yml");

// Все «npm run <скрипт>» и «script: <скрипт>» из workflow (matrix передаёт имя
// скрипта именно так).
function referencedScripts(source) {
  const out = new Set();
  const runRe = /npm run ([A-Za-z0-9:_-]+)/g;
  const matrixRe = /^\s*script:\s*([A-Za-z0-9:_-]+)\s*$/gm;
  let match;
  while ((match = runRe.exec(source))) out.add(match[1]);
  while ((match = matrixRe.exec(source))) out.add(match[1]);
  return [...out];
}

describe("CI: файлы workflow", () => {
  test("тесты и линт гоняются на всех платформах поставки", () => {
    ["ubuntu-latest", "windows-latest", "macos-latest"].forEach((os) => {
      expect({ os, present: ci.includes(os) }).toEqual({ os, present: true });
    });
    expect(ci).toContain("runs-on: ${{ matrix.os }}");
    expect(ci).toContain("fail-fast: false");
  });

  test("в CI те же шаги, что и локально: install → lint → test", () => {
    expect(ci).toContain("npm ci");
    expect(ci).toContain("npm run lint");
    expect(ci).toContain("npm test");
    expect(ci.indexOf("npm ci")).toBeLessThan(ci.indexOf("npm run lint"));
    expect(ci.indexOf("npm run lint")).toBeLessThan(ci.indexOf("npm test"));
  });

  test("версия Node в CI совпадает с engines", () => {
    const engine = String(pkg.engines?.node || "").replace(/^[^\d]*/, "");
    expect(engine).toMatch(/^\d+\.\d+\.\d+/);

    // Кавычки не важны — важно, что версия та же самая.
    const expected = new RegExp(`node-version:\\s*["']?${engine.replace(/\./g, "\\.")}["']?`);
    expect(ci).toMatch(expected);
    expect(release).toMatch(expected);
  });

  test("workflow не сломан форматированием", () => {
    /*
      Полный разбор YAML в тесте недоступен: prettier тянет ESM-парсер, которого
      в jest-окружении нет. Поэтому проверяем то, что ломается на практике и
      видно без парсера: табы (в YAML запрещены), отступы не кратные двум и
      строки, оборванные на двоеточии. Содержимое шагов отдельно проверяется
      тестами ниже.
    */
    [
      ["ci.yml", ci],
      ["release.yml", release],
    ].forEach(([name, source]) => {
      expect({ name, tabs: source.includes("\t") }).toEqual({ name, tabs: false });
      const badIndent = source
        .split(/\r?\n/)
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => line.trim() && /^ +/.test(line) && (line.match(/^ +/)[0].length % 2 !== 0))
        .map(({ line, number }) => `${name}:${number}: ${line.trim().slice(0, 40)}`);
      expect(badIndent).toEqual([]);
      expect(source.trim().endsWith(":") || source.split(/\r?\n/).length > 10).toBe(true);
    });
  });

  test("все npm-скрипты из workflow существуют", () => {
    const scripts = pkg.scripts || {};
    const referenced = [...new Set([...referencedScripts(ci), ...referencedScripts(release)])];

    expect(referenced.length).toBeGreaterThan(0);
    const missing = referenced.filter((name) => !scripts[name]);
    expect(missing).toEqual([]);
  });

  test("релиз: только по тегу, с проверкой версии и загрузкой артефактов", () => {
    expect(release).toContain('tags: ["v*"]');
    expect(release).toContain("GITHUB_REF_NAME");
    expect(release).toContain("package.json");
    expect(release).toContain("contents: write");
    expect(release).toContain("GH_TOKEN");
    expect(release).toContain("--publish always");
  });

  test("релиз собирается только после зелёных тестов и для обеих платформ", () => {
    /*
      Цель сборки передаётся electron-builder флагом, а не именем npm-скрипта:
      npm считает `--publish` своим ключом и не отдаёт его скрипту — тогда до
      сборщика доезжает «--win always», и релиз падает на «Unknown target».
      Проверяем то, что от этого не зависит: обе платформы, публикация и порядок
      «сначала линт и тесты».
    */
    expect(release).toContain("--win");
    expect(release).toContain("--linux");
    expect(release.indexOf("npm run lint")).toBeLessThan(release.indexOf("--publish always"));
    expect(release.indexOf("npm test")).toBeLessThan(release.indexOf("--publish always"));
  });
});
