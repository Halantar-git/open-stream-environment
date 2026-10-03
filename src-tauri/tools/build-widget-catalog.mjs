/*
  Copyright (C) 2026  Halantar

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://gnu.org>.
*/

/*
  Снимает каталог виджетов с `shared/widget-catalog.js` в `src-tauri/catalog_data.json`.

  Зачем скрипт, а не копия руками: каталог — это ~45 виджетов по десятку полей, и
  один неверный `minW` тихо разошёлся бы с фронтом. Здесь данные берутся из того же
  файла, что грузит панель, поэтому расходиться нечему. `ANIMATED_TYPES` в
  `module.exports` не попадает (это `Set` для функции `isAnimatedWidget`), поэтому
  список вынимается из текста файла.

  Отпечаток исходника (`sourceHash`, FNV-1a 64) кладётся рядом с данными: тест в
  `src-tauri/src/catalog.rs` сверяет его и падает, если JS поправили, а данные не
  обновили. Пересобрать после правки каталога:

    node src-tauri/tools/build-widget-catalog.mjs
*/

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fnv1a } from "./fingerprint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const sourcePath = join(repoRoot, "shared", "widget-catalog.js");
const outputPath = join(repoRoot, "src-tauri", "catalog_data.json");

const source = readFileSync(sourcePath, "utf8");
const catalog = createRequire(import.meta.url)(sourcePath);

/** Виджеты с собственным canvas-циклом: `Set`, который не экспортируется. */
function animatedTypes(text) {
  const block = text.match(/const ANIMATED_TYPES = new Set\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error("не нашёл ANIMATED_TYPES в shared/widget-catalog.js");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

const data = {
  // Отпечаток исходника: по нему Rust понимает, что данные устарели.
  sourceHash: fnv1a(source),
  widgetTypes: catalog.WIDGET_TYPES,
  canvas: catalog.CANVAS,
  animatedTypes: animatedTypes(source),
};

writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
console.log(
  `каталог виджетов: ${Object.keys(data.widgetTypes).length} видов, ` +
    `${data.animatedTypes.length} анимированных, отпечаток ${data.sourceHash}`
);
