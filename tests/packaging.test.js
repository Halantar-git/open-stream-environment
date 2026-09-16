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
  Гейт поставки.

  Один раз уже случилось так, что окна редакторов не попали в собранное
  приложение: в `build.files` не было нужных каталогов, а `loadFile` в main.js
  на них ссылался. Юнит-тесты и линт этого не видят — ошибка вылезает только у
  пользователя установленной сборки. Поэтому здесь по исходникам проверяется:

    * все цели loadFile/loadURL существуют на диске;
    * каталоги http-целей реально отдаются статикой сервера;
    * каждый файл окна попадает в `build.files` и не вырезан исключением;
    * то, чего в сборке быть не должно (базы, бэкапы, карантин, логи, медиа
      пользователя), исключениями накрыто.
*/

const fs = require("fs");
const path = require("path");

const pkg = require("../package.json");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "release", "backup", ".git", "coverage"]);

// Мини-глоб в семантике electron-builder: `**` — любой набор каталогов (в том
// числе ни одного), `*` — часть имени внутри одного каталога, `?` — один символ.
function globToRegExp(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(re + "$");
}

const files = pkg.build.files;
const includePatterns = files
  .filter((pattern) => !pattern.startsWith("!"))
  .map((pattern) => ({ pattern, re: globToRegExp(pattern) }));
const excludePatterns = files.filter((pattern) => pattern.startsWith("!")).map((pattern) => globToRegExp(pattern.slice(1)));

function isShipped(relativePath) {
  const target = relativePath.split(path.sep).join("/");
  if (!includePatterns.some(({ re }) => re.test(target))) return false;
  return !excludePatterns.some((re) => re.test(target));
}

function listFiles(dir = ROOT, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      out.push(...listFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`));
    } else {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

const allFiles = listFiles();

// Цели, которые окна грузят с диска: loadFile(path.join(__dirname, "a", "b.html")).
function loadFileTargets() {
  const source = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  const targets = [];
  const re = /loadFile\(\s*path\.join\(\s*__dirname\s*((?:\s*,\s*"[^"]+")+)\s*\)/g;
  let match;
  while ((match = re.exec(source))) {
    const parts = [...match[1].matchAll(/"([^"]+)"/g)].map((part) => part[1]);
    targets.push(parts.join("/"));
  }
  return targets;
}

// http-цели окон: loadURL(`http://localhost:${port}/overlay/overlay.html?x=1`).
function loadUrlTargets() {
  const source = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  const targets = [];
  const re = /loadURL\(\s*`http:\/\/localhost:\$\{[^}]+\}(\/[^`?"]*)/g;
  let match;
  while ((match = re.exec(source))) targets.push(match[1].replace(/^\//, ""));
  return targets;
}

// Каталоги, которые сервер отдаёт статикой (express.static(path.join(__dirname, "..", "…"))).
function servedDirs() {
  const source = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
  const dirs = new Set();
  const re = /express\.static\(path\.join\(__dirname,\s*"\.\.",\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(source))) dirs.add(match[1]);
  return dirs;
}

const PAGE_DIRS = ["control", "chatwindow", "themeeditor", "widgeteditor", "overlay", "remote", "splash", "csseditor"];

// Страницы приложения: окна Electron и страницы, которые сервер отдаёт в OBS.
function pageFiles() {
  return allFiles.filter((file) => file.endsWith(".html") && PAGE_DIRS.some((dir) => file.startsWith(`${dir}/`)));
}

/*
  Локальные ссылки страницы: то, что окно грузит с диска или с сервера.
  Внешнее (шрифты, data-URL, якоря) пропускаем; заодно подхватываем `import`
  из встроенных модульных скриптов — так грузится, например, CSS-редактор
  внутри редактора темы.
*/
function localReferences(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
  const refs = new Set();
  const attribute = /(?:src|href)\s*=\s*"([^"]+)"/g;
  const imported = /from\s+"([^"]+)"/g;
  let match;
  while ((match = attribute.exec(source))) refs.add(match[1]);
  while ((match = imported.exec(source))) refs.add(match[1]);

  return [...refs].filter(
    (ref) =>
      !/^(https?:|data:|#|mailto:|\/\/)/.test(ref) &&
      // /media/ — пользовательские файлы из каталога данных: в репозитории их
      // нет, ссылки на них собираются в рантайме.
      !ref.startsWith("/media/")
  );
}

function resolveReference(pageRelative, ref) {
  /*
    Абсолютный путь — это запрос к серверу: express отдаёт такие файлы из корня
    проекта (`/shared/theme.css` → `shared/theme.css`). Ведущий слэш снимаем
    руками: path.resolve посчитал бы его абсолютным путём в корне диска и тест
    искал бы файлы в C:\shared на Windows.
  */
  const base = ref.startsWith("/") ? ROOT : path.dirname(path.join(ROOT, pageRelative));
  const target = ref.replace(/^\/+/, "");
  return path.relative(ROOT, path.resolve(base, target)).split(path.sep).join("/");
}

function allReferences() {
  const out = [];
  pageFiles().forEach((page) => {
    localReferences(page).forEach((ref) => out.push({ page, ref, target: resolveReference(page, ref) }));
  });
  return out;
}

describe("поставка: цели окон", () => {
  test("loadFile-цели найдены и существуют на диске", () => {
    const targets = loadFileTargets();
    expect(targets.length).toBeGreaterThan(0);

    targets.forEach((target) => {
      expect({ target, exists: fs.existsSync(path.join(ROOT, target)) }).toEqual({ target, exists: true });
    });
  });

  test("каждый файл окна попадает в сборку", () => {
    loadFileTargets().forEach((target) => {
      expect({ target, shipped: isShipped(target) }).toEqual({ target, shipped: true });
    });
  });

  test("http-цели окон отдаются статикой сервера", () => {
    const dirs = servedDirs();
    const targets = loadUrlTargets();
    expect(targets.length).toBeGreaterThan(0);

    targets.forEach((target) => {
      const [dir] = target.split("/");
      expect({ target, served: dirs.has(dir) }).toEqual({ target, served: true });
      expect({ target, exists: fs.existsSync(path.join(ROOT, target)) }).toEqual({ target, exists: true });
    });
  });

  test("все ссылки страниц на файлы на месте", () => {
    const references = allReferences();
    // Порог с запасом: если разбор сломается, тест должен упасть, а не тихо пройти.
    expect(references.length).toBeGreaterThan(100);

    const missing = references.filter(({ target }) => !fs.existsSync(path.join(ROOT, target)));
    expect(missing.map(({ page, ref }) => `${page} → ${ref}`)).toEqual([]);
  });

  test("все, что грузят страницы, попадает в сборку", () => {
    const leaked = allReferences().filter(({ target }) => !isShipped(target));

    expect(leaked.map(({ page, target }) => `${page} → ${target}`)).toEqual([]);
  });

  test("каталоги, которые сервер отдаёт статикой, в сборке", () => {
    const dirs = servedDirs();
    expect(dirs.size).toBeGreaterThan(0);

    dirs.forEach((dir) => {
      const files = allFiles.filter((file) => file.startsWith(`${dir}/`));
      expect({ dir, files: files.length }).not.toEqual({ dir, files: 0 });
      expect({ dir, shipped: files.some((file) => isShipped(file)) }).toEqual({ dir, shipped: true });
    });
  });

  test("шаблон конфига едет с приложением и является валидным JSON", () => {
    const template = "config/config.example.json";
    expect(isShipped(template)).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(path.join(ROOT, template), "utf8"))).not.toThrow();
  });
});

describe("поставка: build.files", () => {
  test("каждый шаблон включения находит хотя бы один файл", () => {
    const empty = includePatterns.filter(({ re }) => !allFiles.some((file) => re.test(file)));
    expect(empty.map(({ pattern }) => pattern)).toEqual([]);
  });

  test("главные файлы приложения в сборке", () => {
    [
      "main.js",
      "preload.js",
      "server/index.js",
      "server/db.js",
      "server/crash-guard.js",
      "server/data-integrity.js",
      "server/health.js",
      "server/support-bundle.js",
      "shared/theme.css",
    ].forEach((file) => {
      expect({ file, shipped: isShipped(file) }).toEqual({ file, shipped: true });
    });
  });

  test("данные пользователя, бэкапы, карантин и логи в сборку не попадают", () => {
    const forbidden = [
      "config/config.json",
      "config/local-db.json",
      "config/local-db.jsonl",
      "config/local-db.chat.jsonl",
      "config/window-state.json",
      "config/local-db.json.bak.0",
      "config/config.json.bak.12",
      "config/config.json.corrupt-20260915-101010",
      "config/logs/ose-2026-09-15.log",
      "config/logs/recovery-2026-09-15.log",
      "config/logs/crash-2026-09-15T10-10-10-1-uncaught.log",
      "config/media/soundboard/sound.mp3",
    ];

    expect(forbidden.filter((file) => isShipped(file))).toEqual([]);
  });

  test("исключения работают и во вложенных каталогах", () => {
    expect(isShipped("config/media/audio/theme/track.wav")).toBe(false);
    expect(isShipped("config/logs/2026/ose-2026-09-15.log")).toBe(false);
  });

  test("цели сборки настроены для всех платформ", () => {
    // Сборка может быть запущена под любую ОС: если цель пропадёт, релиз уйдёт
    // артефактами только для одной платформы и никто этого не заметит.
    ["win", "mac", "linux"].forEach((platform) => {
      expect({ platform, target: pkg.build[platform]?.target }).not.toEqual({ platform, target: undefined });
    });
    expect(pkg.build.asar).toBe(true);
    expect(pkg.build.publish?.provider).toBe("github");
    expect(pkg.build.directories?.output).toBeTruthy();
  });
});
