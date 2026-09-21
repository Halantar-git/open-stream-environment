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
      не совпадающую с package.json, и умеет загружать артефакты (GH_TOKEN);
    * релиз собирает ровно один workflow: два сборщика на один тег — это гонка
      за один и тот же черновик, а не двойная страховка;
    * публикация не размножается по платформам: сборка ничего не публикует, а
      черновик создаёт одна задача. Так было сломано на v3.2.5 — публиковал
      каждый job матрицы, и по тегу выходило три релиза с неполным набором
      файлов вместо одного;
    * уведомление сайта после публикации релиза шлёт то событие и тому
      репозиторию, которые сайт слушает: опечатка здесь ничего не ломает — сайт
      просто никогда не пересоберётся, и видно это будет только по устаревшей
      версии на странице.
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
const notify = workflow("notify-site.yml");

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
      ["notify-site.yml", notify],
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
    expect(release).toContain("gh release upload");
  });

  test("релиз собирается только после зелёных тестов и для всех платформ поставки", () => {
    /*
      Цель сборки передаётся electron-builder флагом, а не именем npm-скрипта:
      npm считает `--publish` своим ключом и не отдаёт его скрипту — тогда до
      сборщика доезжает «--win always», и релиз падает на «Unknown target».
      Проверяем то, что от этого не зависит: все платформы, публикация и порядок
      «сначала линт и тесты».
    */
    expect(release).toContain("--win");
    expect(release).toContain("--linux");
    expect(release).toContain("--mac");
    // Сверяем с шагом сборки, а не с первым упоминанием флага в комментариях.
    expect(release.indexOf("npm run lint")).toBeLessThan(release.indexOf("npx electron-builder"));
    expect(release.indexOf("npm test")).toBeLessThan(release.indexOf("npx electron-builder"));
  });

  test("установщики собираются по платформам, а черновик релиза один", () => {
    /*
      Так было сломано на v3.2.5: публиковал каждый job матрицы, и по одному тегу
      выходило три черновика — в каждом только своя платформа. Публикация должна
      жить в одной задаче, иначе GitHub снова получит несколько релизов одной
      версии, а автообновление не найдёт latest.yml целиком.
    */
    expect(release).toContain("--publish never");
    expect(release).not.toContain("--publish always");
    expect(release).toContain("upload-artifact");
    expect(release).toContain("download-artifact");
    expect(release).toContain("--draft");

    // Ровно одно место создаёт релиз и ровно одно кладёт в него ассеты.
    expect(release.match(/gh release create/g)).toHaveLength(1);
    expect(release.match(/gh release upload/g)).toHaveLength(1);
  });

  test("имена ассетов совпадают с тем, что записано в latest*.yml", () => {
    /*
      Так было сломано на v3.2.6: electron-builder пишет в latest*.yml имена с
      дефисами вместо пробелов, а GitHub при загрузке меняет пробелы на точки.
      Манифест ждал `Open-Stream-Environment-…-setup.exe`, в релизе лежал
      `Open.Stream.Environment-…-setup.exe` — и автообновление просило файл,
      которого нет. Поэтому пробелы в именах убираются до загрузки.
    */
    expect(release).toContain("tr ' ' '-'");
    expect(release).toContain("upload/*");
    expect(release).not.toContain('gh release upload "$tag" dist/*');

    // Манифесты перечислены по именам: `release/*.yml` тянул builder-debug.yml.
    expect(release).toContain("release/latest.yml");
    expect(release).toContain("release/latest-linux.yml");
    expect(release).toContain("release/latest-mac.yml");
  });

  test("по тегу публикует ровно один workflow", () => {
    /*
      Такой дубль уже жил в репозитории: по тегу запускались «Build and Release»
      и «Release», оба собирали установщики и оба заливали их в один черновик.
      Сборка шла наперегонки, а красным становился тот, кто дошёл вторым, — и по
      логу невозможно было понять, что дело в дубле, а не в сборке. Видно это
      только глазами, поэтому проверяем здесь.
    */
    const files = fs.readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name));
    const publishers = files.filter((name) => {
      const source = workflow(name);
      const onTagPush = /tags:/.test(source);
      const buildsInstallers = /electron-builder/.test(source);
      return onTagPush && buildsInstallers;
    });

    expect(publishers).toEqual(["release.yml"]);
  });

  test("после публикации релиза сайт просят пересобраться", () => {
    /*
      Сайт (ose-website) берёт версию, дату и адреса установщиков из последнего
      релиза при своей выкладке, а про сам релиз узнать не может: он выходит
      здесь. Публикация релиза шлёт сайту repository_dispatch, который тот
      слушает (тип события объявлен в его pages.yml). Опечатка в типе события или
      в имени репозитория ничего не ломает — сайт просто никогда не пересоберётся,
      и заметно это будет только по устаревшей версии на странице.
    */
    expect(notify).toContain("release:");
    expect(notify).toContain("types: [published]");
    expect(notify).toContain("repos/Halantar-git/ose-website/dispatches");
    expect(notify).toContain('{"event_type":"app-release"}');
    expect(notify).toContain("SITE_DISPATCH_TOKEN");

    /* Черновик релиза сайту не интересен: releases/latest его не видит, поэтому
       рассылка не должна висеть на создании релиза или на теге. */
    expect(notify).not.toContain("tags:");
    expect(notify).not.toContain("types: [created]");
  });
});
