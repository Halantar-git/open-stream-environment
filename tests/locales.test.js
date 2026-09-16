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
  Паритет словарей.

  Русский и английский наборы ключей обязаны совпадать: лишний ключ — это
  строка, которую никто не увидит, а пропущенный в одном из языков вылезает
  у пользователя техническим `nav.editor` вместо текста. Заодно проверяются
  подстановки: если в одном языке `{{count}}` есть, а в другом нет — часть
  сообщения просто теряется.
*/

const fs = require("fs");
const path = require("path");

const LOCALES_DIR = path.join(__dirname, "..", "shared", "locales");

function flatten(node, prefix = "", out = new Map()) {
  Object.keys(node).forEach((key) => {
    const value = node[key];
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, full, out);
    else out.set(full, value);
  });
  return out;
}

function placeholders(value) {
  if (typeof value !== "string") return [];
  return [...value.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((match) => match[1]).sort();
}

function readLocale(name) {
  const raw = fs.readFileSync(path.join(LOCALES_DIR, `${name}.json`), "utf8");
  return flatten(JSON.parse(raw));
}

const ru = readLocale("ru");
const en = readLocale("en");

describe("shared/locales: паритет ru и en", () => {
  test("словари не пустые", () => {
    expect(ru.size).toBeGreaterThan(100);
    expect(en.size).toBeGreaterThan(100);
  });

  test("наборы ключей совпадают", () => {
    const onlyRu = [...ru.keys()].filter((key) => !en.has(key));
    const onlyEn = [...en.keys()].filter((key) => !ru.has(key));

    expect({ onlyRu, onlyEn }).toEqual({ onlyRu: [], onlyEn: [] });
  });

  test("подстановки {{…}} совпадают в обоих языках", () => {
    const mismatched = [];
    [...ru.keys()].forEach((key) => {
      if (!en.has(key)) return;
      const a = placeholders(ru.get(key));
      const b = placeholders(en.get(key));
      if (a.join(",") !== b.join(",")) mismatched.push({ key, ru: a, en: b });
    });

    expect(mismatched).toEqual([]);
  });

  test("все значения — строки", () => {
    const notStrings = [];
    [
      ["ru", ru],
      ["en", en],
    ].forEach(([lang, dict]) => {
      dict.forEach((value, key) => {
        if (typeof value !== "string") notStrings.push(`${lang}:${key} (${typeof value})`);
      });
    });

    expect(notStrings).toEqual([]);
  });

  test("пустые значения одинаковы в обоих языках", () => {
    // Пустая строка иногда — осознанное решение (необязательная подпись сцены),
    // но забытый перевод выглядит точно так же, поэтому сверяем списки: пусто
    // должно быть в обоих языках или ни в одном.
    const blank = (dict) => [...dict].filter(([, value]) => !value.trim()).map(([key]) => key);

    expect(blank(ru)).toEqual(blank(en));
  });
});
