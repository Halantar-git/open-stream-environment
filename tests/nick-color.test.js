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
  Цвет ника для чатов, которые его не отдают (сейчас — YouTube).

  Проверяем три вещи, которые легко сломать незаметно: цвет стабилен для одного
  и того же зрителя, он остаётся читаемым на тёмной панели при любом оттенке и
  не превращается в одну палитру на всех.
*/

const { nickColor, DEFAULT_NICK_COLOR } = require("../server/nick-color");
const { contrastRatio } = require("../shared/theme-engine");

// Фон тёмной панели оверлея — самый тёмный вариант из тем приложения.
const DARK_SURFACE = "#131019";

// Порог WCAG AA для обычного текста.
const MIN_CONTRAST = 4.5;

// Правдоподобный идентификатор канала: буквы и цифры, без пробелов.
function channelId(index) {
  const digits = Math.abs(Math.sin(index) * 1e12);
  return "UC" + digits.toString(36).slice(0, 12);
}

// Прогоняем заведомо больше семплов, чем в палитре оттенков, — так проверка
// контраста ниже покрывает всю палитру, а не её часть.
const PALETTE = new Set();
for (let i = 0; i < 5000; i += 1) PALETTE.add(nickColor(channelId(i) + i.toString(36)));

describe("nickColor", () => {
  test("цвет стабилен: одинаковый идентификатор — одинаковый цвет", () => {
    expect(nickColor("UCabc")).toBe(nickColor("UCabc"));
    expect(nickColor("UCabc")).toBe(nickColor("  UCabc  "));
  });

  test("цвет — hex из шести цифр", () => {
    expect(nickColor("UCabc")).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("без идентификатора остаётся прежний фиксированный цвет", () => {
    [undefined, null, "", "   "].forEach((seed) => {
      expect(nickColor(seed)).toBe(DEFAULT_NICK_COLOR);
    });
  });

  test("разные зрители получают разные цвета", () => {
    const ids = [];
    for (let i = 0; i < 20; i += 1) ids.push(channelId(i));
    expect(new Set(ids.map(nickColor)).size).toBe(20);
  });

  test("палитра не вырождается: несколько сотен зрителей не сходятся в десяток цветов", () => {
    const colors = new Set();
    for (let i = 0; i < 400; i += 1) colors.add(nickColor(channelId(i)));
    expect(colors.size).toBeGreaterThan(200);
  });

  test("контраст на тёмной панели выдерживается для всей палитры", () => {
    // Если хеш перестанет распределять оттенок по всему кругу, проверка станет
    // частичной — об этом сообщаем отдельно, а не молча занижаем её охват.
    expect(PALETTE.size).toBe(360);

    let worst = Infinity;
    PALETTE.forEach((color) => {
      const ratio = contrastRatio(color, DARK_SURFACE);
      if (ratio < worst) worst = ratio;
    });
    expect(worst).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });
});
