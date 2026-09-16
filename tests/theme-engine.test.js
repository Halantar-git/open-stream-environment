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

const {
  buildThemeTokens,
  contrastRatio,
  hexToHsl,
  deriveSurfaces,
  FONT_PRESETS,
  SHAPE_MODES,
  SCHEMES,
  ALERT_EASINGS,
  deriveRole,
} = require("../shared/theme-engine");

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

  test("цвет ошибки переопределяет токены ошибки", () => {
    expect(buildThemeTokens(base)["--md-error"]).toBe("#ffb4ab");

    const role = deriveRole("#ff0000");
    const tokens = buildThemeTokens({ ...base, error: "#ff0000" });
    expect(tokens["--md-error"]).toBe(role.role);
    expect(tokens["--md-on-error"]).toBe(role.onRole);
    expect(tokens["--md-error-container"]).toBe(role.container);
    expect(tokens["--md-on-error-container"]).toBe(role.onContainer);

    // Пустая строка — дефолт сохраняется.
    expect(buildThemeTokens({ ...base, error: "" })["--md-error"]).toBe("#ffb4ab");
  });

  test("анимация появления алертов переопределяется, неизвестные значения игнорируются", () => {
    // Без переопределения берётся значение формы панели.
    expect(buildThemeTokens(base)["--alert-enter-duration"]).toBe("480ms");
    expect(buildThemeTokens({ ...base, shapeMode: "angular" })["--alert-enter-duration"]).toBe("350ms");

    const tokens = buildThemeTokens({ ...base, alertEnterDuration: 700, alertEnterEasing: "spring" });
    expect(tokens["--alert-enter-duration"]).toBe("700ms");
    expect(tokens["--alert-enter-easing"]).toBe(ALERT_EASINGS.spring);

    expect(buildThemeTokens({ ...base, alertEnterDuration: 99999 })["--alert-enter-duration"]).toBe("2000ms");
    expect(buildThemeTokens({ ...base, alertEnterDuration: -50 })["--alert-enter-duration"]).toBe("0ms");

    // Пустое/неизвестное — падаем на значение формы панели.
    const fallback = buildThemeTokens({ ...base, alertEnterDuration: "", alertEnterEasing: "nope" });
    expect(fallback["--alert-enter-duration"]).toBe("480ms");
    expect(fallback["--alert-enter-easing"]).toBe("cubic-bezier(0.05, 0.7, 0.1, 1)");
  });

  test("ALERT_EASINGS содержит набор кривых", () => {
    expect(Object.keys(ALERT_EASINGS)).toEqual(
      expect.arrayContaining(["smooth", "decelerate", "spring", "sharp", "linear"])
    );
  });
});

describe("shared/theme-engine colour schemes", () => {
  const base = {
    primary: "#c6b8ff",
    secondary: "#7ee0d6",
    tertiary: "#ffb0d8",
    surfaceSeed: "#8878c8",
    shapeMode: "rounded",
    fontPreset: "nebula",
  };

  test("без mode (или с неизвестным) схема остаётся тёмной", () => {
    const dark = buildThemeTokens({ ...base, mode: "dark" });
    expect(buildThemeTokens(base)).toEqual(dark);
    expect(buildThemeTokens({ ...base, mode: "nope" })).toEqual(dark);
    expect(SCHEMES).toEqual(["dark", "light"]);
  });

  test("светлая схема разворачивает поверхности, текст и акценты", () => {
    const dark = buildThemeTokens(base);
    const light = buildThemeTokens({ ...base, mode: "light" });

    expect(hexToHsl(light["--md-surface"]).l).toBeGreaterThan(90);
    expect(hexToHsl(light["--md-on-surface"]).l).toBeLessThan(30);
    expect(hexToHsl(dark["--md-surface"]).l).toBeLessThan(20);
    expect(hexToHsl(dark["--md-on-surface"]).l).toBeGreaterThan(80);

    // Акцент на светлой схеме темнее, а текст на нём — почти белый.
    expect(hexToHsl(light["--md-primary"]).l).toBeLessThan(hexToHsl(dark["--md-primary"]).l);
    expect(hexToHsl(light["--md-on-primary"]).l).toBeGreaterThan(90);
  });

  test("светлая схема читается: текст, второстепенный текст и акцент на фоне", () => {
    const light = buildThemeTokens({ ...base, mode: "light" });
    const surface = light["--md-surface"];
    expect(contrastRatio(light["--md-on-surface"], surface)).toBeGreaterThan(7);
    expect(contrastRatio(light["--md-on-surface-variant"], surface)).toBeGreaterThan(4.5);
    expect(contrastRatio(light["--md-primary"], surface)).toBeGreaterThanOrEqual(4.5);
  });

  test("светлый фон в тёмной схеме не оставляет невидимый текст", () => {
    // Пользователь вручную поставил светлый фон, текст и акцент оставил «Авто».
    const tokens = buildThemeTokens({ ...base, background: "#f4f4f4" });
    expect(tokens["--md-surface"]).toBe("#f4f4f4");
    expect(contrastRatio(tokens["--md-on-surface"], "#f4f4f4")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens["--md-on-surface-variant"], "#f4f4f4")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens["--md-primary"], "#f4f4f4")).toBeGreaterThanOrEqual(4.5);
  });

  test("явные переопределения фона и текста не подменяются", () => {
    const tokens = buildThemeTokens({ ...base, background: "#101010", text: "#fafafa" });
    expect(tokens["--md-surface"]).toBe("#101010");
    expect(tokens["--md-on-surface"]).toBe("#fafafa");

    // Тёмная схема с тёмным фоном не меняется: производный on-surface тот же.
    expect(buildThemeTokens(base)["--md-on-surface"]).toBe(deriveSurfaces(base.surfaceSeed, "dark").onSurface);
    expect(buildThemeTokens(base)["--md-on-surface-variant"]).toBe(deriveSurfaces(base.surfaceSeed, "dark").onSurfaceVariant);
  });

  test("дефолтный цвет ошибки, тень и рамка зависят от схемы", () => {
    expect(buildThemeTokens(base)["--md-error"]).toBe("#ffb4ab");
    expect(buildThemeTokens({ ...base, mode: "light" })["--md-error"]).toBe("#ba1a1a");

    expect(buildThemeTokens(base)["--panel-glow"]).toBe("0 24px 48px rgba(0,0,0,0.45)");
    expect(buildThemeTokens({ ...base, mode: "light" })["--panel-glow"]).toBe("0 12px 32px rgba(0,0,0,0.18)");
    expect(buildThemeTokens({ ...base, mode: "light" })["--panel-border"]).toBe("1px solid rgba(0, 0, 0, 0.10)");
  });
});
