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

const I18n = require("../shared/i18n");

describe("shared/i18n", () => {
  beforeEach(() => {
    I18n.setLocales({
      ru: { greet: "Привет, {{name}}!", nested: { key: "значение" }, empty: "" },
      en: { greet: "Hello, {{name}}!", nested: { key: "value" }, empty: "" },
    });
    I18n.setLang("ru");
  });

  test("resolve находит вложенные ключи", () => {
    expect(I18n.resolve("nested.key", { nested: { key: "x" } })).toBe("x");
    expect(I18n.resolve("missing.key", { nested: { key: "x" } })).toBeUndefined();
  });

  test("t возвращает перевод с подстановкой параметров", () => {
    expect(I18n.t("greet", { name: "Ваня" })).toBe("Привет, Ваня!");
  });

  test("t использует английский как фолбэк", () => {
    expect(I18n.t("nested.key")).toBe("значение");
    I18n.setLang("en");
    expect(I18n.t("nested.key")).toBe("value");
  });

  test("t возвращает сам ключ, если перевода нет", () => {
    expect(I18n.t("does.not.exist")).toBe("does.not.exist");
  });

  test("normalizeLang приводит язык к ru/en", () => {
    expect(I18n.normalizeLang("ru")).toBe("ru");
    expect(I18n.normalizeLang("en")).toBe("en");
    expect(I18n.normalizeLang("fr")).toBe("en");
    expect(I18n.normalizeLang(undefined)).toBe("en");
  });
});
