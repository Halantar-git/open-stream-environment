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
  Гейт поставки (Tauri).

  Один раз уже случилось так, что окна редакторов не попали в собранное
  приложение: каталога не было в списке ресурсов, а страница на него ссылалась.
  Юнит-тесты и линт этого не видят — ошибка вылезает только у пользователя
  установленной сборки. Поэтому здесь по исходникам проверяется:

    * все ссылки страниц на файлы есть на диске;
    * всё, что грузят страницы и CSS, попадает в `bundle.resources`;
    * каталоги страниц и общие ресурсы объявлены в ресурсах;
    * встроенные шрифты тем объявлены в наборе и не лежат мёртвым грузом;
    * то, чего в поставке быть не должно (базы, бэкапы, карантин, логи, медиа
      пользователя), в `bundle.resources` не попадает.
*/

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "release", "backup", ".git", "coverage"]);
// Артефакты Rust-сборки и схемы Tauri: в поставку они не едут, а обход иначе
// вычитывал бы копии `shared/` и `assets/` из `src-tauri/target`.
const SKIP_PATHS = new Set(["src-tauri/target", "src-tauri/gen"]);

function listFiles(dir = ROOT, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".") || SKIP_PATHS.has(relative)) continue;
      out.push(...listFiles(path.join(dir, entry.name), `${relative}/`));
    } else {
      out.push(relative);
    }
  }
  return out;
}

const allFiles = listFiles();

// Конфиг сборки Tauri — единственный источник правды о том, что попадает в поставку.
const tauri = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));

// Источники ресурсов как пути репозитория: `../control` → `control`,
// `../config/config.example.json` → `config/config.example.json`.
const resourceSources = Object.keys(tauri.bundle.resources).map((source) => source.replace(/^\.\.\//, ""));

// Попадает ли файл в поставку: он сам или что-то под его каталогом объявлено
// в ресурсах. Так `config/config.example.json` уезжает, а `config/config.json`
// (данные пользователя) — нет.
function isShipped(relativePath) {
  const target = relativePath.split(path.sep).join("/");
  return resourceSources.some((entry) => target === entry || target.startsWith(`${entry}/`));
}

const PAGE_DIRS = ["control", "chatwindow", "themeeditor", "widgeteditor", "overlay", "remote", "splash", "csseditor"];

// Страницы приложения: их сервер отдаёт в окна и в OBS Browser Source.
function pageFiles() {
  return allFiles.filter((file) => file.endsWith(".html") && PAGE_DIRS.some((dir) => file.startsWith(`${dir}/`)));
}

/*
  Локальные ссылки страницы: то, что окно грузит с сервера. Внешнее (шрифты,
  data-URL, якоря) пропускаем; заодно подхватываем `import` из встроенных
  модульных скриптов — так грузится, например, CSS-редактор внутри редактора темы.
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
    Абсолютный путь — это запрос к серверу: он отдаёт такие файлы из корня
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

/*
  Ссылки из CSS: url("…") в @font-face и обычных правилах. Из HTML они не видны —
  страница подключает CSS, а шрифт упомянут только внутри него, — поэтому
  проверяются отдельно: забытый в ресурсах файл иначе уехал бы в релиз мимо всех
  тестов и всплыл у пользователя подменой на системный шрифт.
*/
function cssReferences() {
  const out = [];
  allFiles
    .filter((file) => file.endsWith(".css"))
    .forEach((file) => {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      /*
        Один проход с альтернативой на три формы записи: значение в кавычках
        может само содержать кавычку другого типа — так устроены SVG-заливки в
        data-URI. Проход слева направо съедает такое значение целиком и не
        разбирает `url()` внутри него как отдельную ссылку.
      */
      const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"'()\s]+))\s*\)/g;
      let match;
      while ((match = re.exec(source))) {
        const ref = (match[1] || match[2] || match[3] || "").trim();
        if (!ref || /^(https?:|data:|\/\/|#)/.test(ref)) continue;
        out.push({ file, ref, target: resolveReference(file, ref) });
      }
    });
  return out;
}

// Семейства, объявленные во встроенном наборе шрифтов (`shared/fonts.css`).
function declaredFontFamilies() {
  const source = fs.readFileSync(path.join(ROOT, "shared", "fonts.css"), "utf8");
  return new Set([...source.matchAll(/@font-face\s*\{[^}]*?font-family\s*:\s*"([^"]+)"/g)].map((match) => match[1]));
}

/*
  Первое семейство шрифтовых токенов тем — то, что реально рисует текст. Смотрим
  и встроенные темы, и пресеты движка, и список шрифтов редактора: разойдись имя
  здесь и в `fonts.css` — и тема молча уедет на системный шрифт.
*/
function themeFontFamilies() {
  const sources = ["shared/themes.js", "shared/theme-engine.js", "themeeditor/theme-editor.js"];
  const patterns = [/--font-(?:display|body|mono)"?\s*:\s*'([^']+)'/g, /value:\s*'([^']+)'/g];
  const out = new Map();

  sources.forEach((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    patterns.forEach((re) => {
      let match;
      while ((match = re.exec(source))) {
        const family = match[1].split(",")[0].trim().replace(/^["']|["']$/g, "");
        if (family && !out.has(family)) out.set(family, file);
      }
    });
  });

  return out;
}

// Семейства, которые остаются системными фолбэками и намеренно не вшиваются.
const SYSTEM_FONT_FALLBACKS = new Set([
  "Segoe UI",
  "Consolas",
  "Georgia",
  "Arial",
  "system-ui",
  "sans-serif",
  "serif",
  "monospace",
]);

// Исходники, где могут упоминаться семейства шрифтов, — без самих файлов шрифтов.
function fontConsumerSources() {
  return allFiles
    .filter((file) => /\.(css|html|js)$/.test(file) && !file.startsWith("assets/fonts/") && file !== "shared/fonts.css")
    .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"));
}

describe("поставка: страницы и ссылки", () => {
  test("все ссылки страниц на файлы на месте", () => {
    const references = allReferences();
    // Порог с запасом: если разбор сломается, тест должен упасть, а не тихо пройти.
    expect(references.length).toBeGreaterThan(100);

    const missing = references.filter(({ target }) => !fs.existsSync(path.join(ROOT, target)));
    expect(missing.map(({ page, ref }) => `${page} → ${ref}`)).toEqual([]);
  });

  test("всё, что грузят страницы, попадает в поставку", () => {
    const leaked = allReferences().filter(({ target }) => !isShipped(target));

    expect(leaked.map(({ page, target }) => `${page} → ${target}`)).toEqual([]);
  });

  /*
    Токены оформления (`--md-*`, `--font-*`) и встроенные шрифты приходят из
    общего `shared/theme.css`, поэтому каждая страница обязана его подключать.
    Один раз ссылка на него пропала у панели при правке головы страницы — и
    панель осталась без оформления, а тесты и линт этого не видели. Пульт и
    OBS-сцена заставки живут на своём наборе (только встроенные шрифты), для
    них общий theme.css не обязателен.
  */
  const THEME_OPTIONAL_PAGES = new Set(["remote/index.html", "overlay/video-splash.html"]);

  test("страницы подключают общий theme.css", () => {
    const missing = pageFiles()
      .filter((page) => !THEME_OPTIONAL_PAGES.has(page))
      .filter(
        (page) =>
          !localReferences(page)
            .map((ref) => resolveReference(page, ref))
            .includes("shared/theme.css")
      );

    expect(missing).toEqual([]);
  });

  test("каталоги страниц объявлены в ресурсах", () => {
    PAGE_DIRS.forEach((dir) => {
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

describe("поставка: встроенные шрифты", () => {
  test("файлы, на которые ссылается CSS, на месте", () => {
    const references = cssReferences();
    // Порог с запасом: если разбор сломается, тест должен упасть, а не тихо пройти.
    expect(references.length).toBeGreaterThan(20);

    const missing = references.filter(({ target }) => !fs.existsSync(path.join(ROOT, target)));
    expect(missing.map(({ file, ref }) => `${file} → ${ref}`)).toEqual([]);
  });

  test("файлы, на которые ссылается CSS, попадают в поставку", () => {
    const leaked = cssReferences().filter(({ target }) => !isShipped(target));

    expect(leaked.map(({ file, target }) => `${file} → ${target}`)).toEqual([]);
  });

  test("каждое семейство тем объявлено во встроенном наборе", () => {
    const declared = declaredFontFamilies();
    expect(declared.size).toBeGreaterThan(0);

    const missing = [...themeFontFamilies()]
      .filter(([family]) => !SYSTEM_FONT_FALLBACKS.has(family) && !declared.has(family))
      .map(([family, file]) => `${file} → ${family}`);

    expect(missing).toEqual([]);
  });

  test("ни один вшитый шрифт не лежит в сборке мертвым грузом", () => {
    const sources = fontConsumerSources();
    const unused = [...declaredFontFamilies()].filter(
      (family) => !sources.some((source) => source.includes(`"${family}"`) || source.includes(`'${family}'`))
    );

    expect(unused).toEqual([]);
  });
});

describe("поставка: конфигурация Tauri", () => {
  test("источники ресурсов существуют на диске", () => {
    const missing = resourceSources.filter((entry) => !fs.existsSync(path.join(ROOT, entry)));
    expect(missing).toEqual([]);
  });

  test("статика приложения объявлена в ресурсах", () => {
    // Каталоги, которые сервер отдаёт статикой (см. server::SERVED_DIRS в Rust), и
    // общие ресурсы: разъехавшись с конфигом, сборка отдала бы 404 на страницу,
    // которую dev-режим открывает.
    const dirs = [
      "control",
      "overlay",
      "remote",
      "chatwindow",
      "splash",
      "widgeteditor",
      "themeeditor",
      "csseditor",
      "shared",
      "assets",
    ];
    const missing = dirs.filter((dir) => !isShipped(`${dir}/index.html`));
    expect(missing).toEqual([]);
  });

  test("данные пользователя, бэкапы, карантин и логи в поставку не попадают", () => {
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

  test("сборка и обновления настроены", () => {
    // Без `createUpdaterArtifacts` и `plugins.updater` установщики выйдут без
    // `latest.json`/`.sig`, и встроенное автообновление не найдёт ни версию, ни
    // файл. `targets` включает все платформы: пропажа цели оставила бы релиз без
    // установщиков одной ОС и никто бы этого не заметил.
    expect(tauri.bundle.active).toBe(true);
    expect(tauri.bundle.targets).toBeTruthy();
    expect(tauri.bundle.createUpdaterArtifacts).toBe(true);
    expect(tauri.plugins?.updater?.endpoints?.length).toBeGreaterThan(0);
    expect(tauri.plugins?.updater?.pubkey).toBeTruthy();
  });
});
