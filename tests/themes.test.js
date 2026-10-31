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
  Встроенные темы: обязательные токены и Retrowave.

  Оверлей, сцены и Колесо Фортуны читают один и тот же набор `--md-*` и
  `--panel-*`. Если тема забыла хотя бы один токен, она молча подставит значение
  из `shared/theme.css`, и вид разъедется с остальными темами.
*/

const { BUILTIN_THEMES, THREE_D_STYLES } = require("../shared/themes");

const REQUIRED_TOKENS = [
  "--md-primary",
  "--md-on-primary",
  "--md-primary-container",
  "--md-on-primary-container",
  "--md-secondary",
  "--md-on-secondary",
  "--md-secondary-container",
  "--md-on-secondary-container",
  "--md-tertiary",
  "--md-on-tertiary",
  "--md-tertiary-container",
  "--md-on-tertiary-container",
  "--md-error",
  "--md-on-error",
  "--md-error-container",
  "--md-on-error-container",
  "--md-surface-dim",
  "--md-surface",
  "--md-surface-bright",
  "--md-surface-container-lowest",
  "--md-surface-container-low",
  "--md-surface-container",
  "--md-surface-container-high",
  "--md-surface-container-highest",
  "--md-on-surface",
  "--md-on-surface-variant",
  "--md-outline",
  "--md-outline-variant",
  "--font-display",
  "--font-body",
  "--font-mono",
  "--panel-radius",
  "--panel-clip",
  "--panel-decoration",
  "--panel-glow",
  "--panel-bg",
  "--panel-blur",
  "--panel-border",
  "--alert-enter-easing",
  "--alert-enter-duration",
];

describe("встроенные темы", () => {
  test("у каждой темы id совпадает с ключом и заполнены обязательные токены", () => {
    Object.entries(BUILTIN_THEMES).forEach(([id, theme]) => {
      expect(theme.id).toBe(id);
      expect(theme.builtin).toBe(true);
      REQUIRED_TOKENS.forEach((token) => {
        expect(typeof theme.tokens[token]).toBe("string");
        expect(theme.tokens[token]).not.toBe("");
      });
    });
  });

  test("Retrowave — встроенная тема с 3D-набором", () => {
    const theme = BUILTIN_THEMES.retrowave;
    expect(theme).toBeTruthy();
    expect(theme.name).toBe("Retrowave");
    expect(theme.dimension).toBe("2d");
    expect(theme.family).toBe("retrowave");
    expect(theme.variant3d).toBe("retrowave");
    expect(THREE_D_STYLES.some((style) => style.id === "retrowave")).toBe(true);
  });

  test("Retrowave задаёт неоновую палитру и скошенные панели", () => {
    const tokens = BUILTIN_THEMES.retrowave.tokens;
    expect(tokens["--md-primary"]).toBe("#ff2d95");
    expect(tokens["--md-secondary"]).toBe("#2de2e6");
    expect(tokens["--panel-decoration"]).toBe("retrowave");
    expect(tokens["--panel-clip"]).toContain("polygon(26px 0");
    expect(tokens["--panel-radius"]).toBe("0px");
  });

  test("Super Four — встроенная тема с 3D-набором приборной панели", () => {
    const theme = BUILTIN_THEMES.sf;
    expect(theme).toBeTruthy();
    expect(theme.name).toBe("Super Four");
    expect(theme.dimension).toBe("2d");
    expect(theme.family).toBe("sf");
    expect(theme.variant3d).toBe("sf");
    expect(THREE_D_STYLES.some((style) => style.id === "sf")).toBe(true);
  });

  test("Super Four выкрашен в палитру Candy Flash CB400SF", () => {
    const tokens = BUILTIN_THEMES.sf.tokens;
    expect(tokens["--md-primary"]).toBe("#7b2cbf");
    expect(tokens["--md-secondary"]).toBe("#ffb700");
    expect(tokens["--md-tertiary"]).toBe("#00f5d4");
    expect(tokens["--sf-candy-pink"]).toBe("#ff007f");
    expect(tokens["--sf-glow"]).toBe("#9d4edd");
    expect(tokens["--sf-redline"]).toBe("#ff3b30");
    expect(tokens["--md-on-surface"]).toBe("#ffffff");
    expect(tokens["--panel-radius"]).toBe("6px");
  });
});
