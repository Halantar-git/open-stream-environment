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
  Эталон для переноса `shared/theme-engine.js` в Rust: набор семян и токены,
  которые JS из них собирает (`src-tauri/theme_engine_samples.json`).

  Движок — это логика (перевод цветов, светимость и контраст, вывод ролей и
  поверхностей, формы панелей), руками её переносить без проверки нельзя. Поэтому
  эталон считается настоящим JS-кодом: Rust обязан получить ровно те же токены
  символ в символ, и расхождение видно тестом, а не при отрисовке.

  Семена подобраны так, чтобы накрыть ветки: обе схемы, все формы панелей,
  точечные переопределения, пустые и неизвестные значения, светлый фон в тёмной
  схеме и семена «без всего». Пересобрать после правки движка:

    node src-tauri/tools/build-theme-engine.mjs
*/

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fnv1a } from "./fingerprint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const sourcePath = join(repoRoot, "shared", "theme-engine.js");
const outputPath = join(repoRoot, "src-tauri", "theme_engine_samples.json");

const source = readFileSync(sourcePath, "utf8");
const engine = createRequire(import.meta.url)(sourcePath);

// Те же семена, что в `tests/theme-engine.test.js`: с них начинается любая своя тема.
const base = {
  primary: "#c6b8ff",
  secondary: "#7ee0d6",
  tertiary: "#ffb0d8",
  surfaceSeed: "#8878c8",
  shapeMode: "rounded",
  fontPreset: "nebula",
};

const samples = [
  { name: "dark_base", seeds: { ...base } },
  { name: "light_base", seeds: { ...base, mode: "light" } },
  // Все формы панелей: у каждой свой набор токенов.
  ...engine.SHAPE_MODES.map((mode) => ({
    name: `shape_${mode}`,
    seeds: { ...base, shapeMode: mode },
  })),
  {
    name: "font_override",
    seeds: {
      ...base,
      fontDisplay: '"Arial", sans-serif',
      fontBody: '"Georgia", serif',
      fontMono: '"Consolas", monospace',
    },
  },
  { name: "glow_override", seeds: { ...base, panelGlowColor: "#ff0000", panelGlowStrength: 60 } },
  {
    name: "border_override",
    seeds: { ...base, panelBorderWidth: "3px", panelBorderStyle: "dashed", panelBorderColor: "#00ff00" },
  },
  {
    name: "surface_override",
    seeds: {
      ...base,
      background: "#111111",
      text: "#eeeeee",
      panelOpacity: 60,
      panelBlur: "8px",
    },
  },
  { name: "panel_radius_override", seeds: { ...base, panelRadius: "6px" } },
  { name: "error_override", seeds: { ...base, error: "#ff0000" } },
  { name: "error_blank", seeds: { ...base, error: "   " } },
  { name: "alert_override", seeds: { ...base, alertEnterDuration: 700, alertEnterEasing: "spring" } },
  { name: "alert_clamped", seeds: { ...base, alertEnterDuration: 99999, alertEnterEasing: "nope" } },
  { name: "alert_negative", seeds: { ...base, alertEnterDuration: -50 } },
  { name: "alert_blank", seeds: { ...base, alertEnterDuration: "" } },
  // Светлый фон в тёмной схеме: текст и акценты обязаны остаться читаемыми.
  { name: "light_background_in_dark_scheme", seeds: { ...base, background: "#f4f4f4" } },
  { name: "light_scheme_with_dark_background", seeds: { ...base, mode: "light", background: "#101010" } },
  // «Без всего»: семена поверхностей и шрифта не заданы.
  {
    name: "other_seeds",
    seeds: {
      primary: "#ff8800",
      secondary: "#00ffaa",
      tertiary: "#aa00ff",
      shapeMode: "hazard",
      fontPreset: "orbital",
      mode: "light",
    },
  },
  { name: "no_font_preset", seeds: { ...base, fontPreset: "nope" } },
  { name: "no_surface_seed", seeds: { ...base, surfaceSeed: "" } },
  { name: "unknown_mode", seeds: { ...base, mode: "nope" } },
];

const data = {
  sourceHash: fnv1a(source),
  // Таблицы движка: переносятся руками, поэтому сверяются целиком.
  fonts: engine.FONT_PRESETS,
  shapeModes: engine.SHAPE_MODES,
  schemes: engine.SCHEMES,
  alertEasings: engine.ALERT_EASINGS,
  samples: samples.map(({ name, seeds }) => ({
    name,
    seeds,
    tokens: engine.buildThemeTokens(seeds),
  })),
};

writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
console.log(
  `эталон движка тем: ${data.samples.length} наборов семян, отпечаток ${data.sourceHash}`
);
