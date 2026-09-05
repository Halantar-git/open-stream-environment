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

const { buildThemeTokens, FONT_PRESETS, SHAPE_MODES } = require("../shared/theme-engine");

describe("shared/theme-engine custom theme tokens", () => {
  const base = {
    primary: "#c6b8ff",
    secondary: "#7ee0d6",
    tertiary: "#ffb0d8",
    surfaceSeed: "#8878c8",
    shapeMode: "rounded",
    fontPreset: "nebula",
  };

  test("пустые переопределения оставляют пресет/дефолт", () => {
    const tokens = buildThemeTokens(base);
    expect(tokens["--font-display"]).toBe(FONT_PRESETS.nebula["--font-display"]);
    expect(tokens["--panel-radius"]).toBe("24px");
  });

  test("переопределение шрифтов применяется точечно", () => {
    const tokens = buildThemeTokens({ ...base, fontDisplay: '"Arial", sans-serif' });
    expect(tokens["--font-display"]).toBe('"Arial", sans-serif');
    expect(tokens["--font-body"]).toBe(FONT_PRESETS.nebula["--font-body"]);
  });

  test("panelGlow собирает box-shadow из цвета и интенсивности", () => {
    const tokens = buildThemeTokens({ ...base, panelGlowColor: "#ff0000", panelGlowStrength: 60 });
    expect(tokens["--panel-glow"]).toMatch(/^0 0 \d+px \d+px #ff0000[0-9a-f]{2}$/);
  });

  test("границы пересобираются из ширины и цвета", () => {
    const tokens = buildThemeTokens({ ...base, panelBorderWidth: "3px", panelBorderColor: "#00ff00" });
    expect(tokens["--panel-border"]).toBe("3px solid #00ff00");
  });

  test("частичное переопределение границы сохраняет дефолтный цвет", () => {
    const tokens = buildThemeTokens({ ...base, panelBorderWidth: "3px" });
    expect(tokens["--panel-border"]).toMatch(/^3px solid /);
  });

  test("SHAPE_MODES включает все формы панелей", () => {
    expect(SHAPE_MODES).toEqual(["rounded", "angular", "sharp", "soft", "pill", "brackets4", "hazard"]);
  });

  test("формы sharp/pill задают радиус и декорацию", () => {
    const sharp = buildThemeTokens({ ...base, shapeMode: "sharp" });
    expect(sharp["--panel-radius"]).toBe("0px");
    expect(sharp["--panel-decoration"]).toBe("none");

    const pill = buildThemeTokens({ ...base, shapeMode: "pill" });
    expect(pill["--panel-radius"]).toBe("999px");

    const brackets4 = buildThemeTokens({ ...base, shapeMode: "brackets4" });
    expect(brackets4["--panel-decoration"]).toBe("brackets4");
  });

  test("фон/текст/стиль рамки/прозрачность/размытие переопределяются", () => {
    const tokens = buildThemeTokens({
      ...base,
      background: "#111111",
      text: "#eeeeee",
      panelBorderWidth: "2px",
      panelBorderStyle: "dashed",
      panelOpacity: 60,
      panelBlur: "8px",
    });
    expect(tokens["--md-surface"]).toBe("#111111");
    expect(tokens["--md-on-surface"]).toBe("#eeeeee");
    expect(tokens["--panel-border"]).toBe("2px dashed rgba(255, 255, 255, 0.12)");
    expect(tokens["--panel-bg"]).toMatch(/rgba\(\d+, \d+, \d+, 0\.6\)/);
    expect(tokens["--panel-blur"]).toBe("8px");
  });
});
