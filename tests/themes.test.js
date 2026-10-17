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
  Встроенные темы: обязательные токены и новая Synthwave.

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

  test("Synthwave — встроенная 2D-тема без 3D-набора", () => {
    const theme = BUILTIN_THEMES.synthwave;
    expect(theme).toBeTruthy();
    expect(theme.name).toBe("Synthwave");
    expect(theme.dimension).toBe("2d");
    expect(theme.family).toBe("synthwave");
    expect(theme.variant3d).toBeUndefined();
    expect(THREE_D_STYLES.some((style) => style.id === "synthwave")).toBe(false);
  });

  test("Synthwave задаёт неоновую палитру и сетку на сценах", () => {
    const tokens = BUILTIN_THEMES.synthwave.tokens;
    expect(tokens["--md-primary"]).toBe("#ff2d95");
    expect(tokens["--md-secondary"]).toBe("#2de2e6");
    expect(tokens["--panel-decoration"]).toBe("brackets4");
    expect(tokens["--panel-radius"]).toBe("0px");
  });
});
