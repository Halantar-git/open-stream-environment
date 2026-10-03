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
  Снимает встроенные темы и 3D-стили с `shared/themes.js` в
  `src-tauri/themes_data.json`.

  По той же причине, что и каталог виджетов: тем девять, и в каждой по три-четыре
  десятка токенов цвета, шрифта и формы — руками это копировать нельзя, а
  расхождение с фронтом (и с оверлеем) было бы тихим. Отпечаток исходника рядом с
  данными ловит забытую пересборку. Пересобрать:

    node src-tauri/tools/build-themes.mjs

  `buildThemeTokens` сюда не попадает: это логика (сборка токенов из семян для
  своих тем), и она переносится в Rust руками — `src-tauri/src/theme_engine.rs`.
*/

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fnv1a } from "./fingerprint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const sourcePath = join(repoRoot, "shared", "themes.js");
const outputPath = join(repoRoot, "src-tauri", "themes_data.json");

const source = readFileSync(sourcePath, "utf8");
const themes = createRequire(import.meta.url)(sourcePath);

const data = {
  sourceHash: fnv1a(source),
  builtinThemes: themes.BUILTIN_THEMES,
  threeDStyles: themes.THREE_D_STYLES,
};

writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
console.log(
  `темы: ${Object.keys(data.builtinThemes).length} встроенных, ` +
    `${data.threeDStyles.length} 3D-стилей, отпечаток ${data.sourceHash}`
);
