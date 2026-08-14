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
  Lightweight isomorphic i18n helper. The server pushes the locale dictionaries
  to every connected renderer over the existing WebSocket bus (see the `locales`
  event), and renderers call `I18n.setLocales()` + `I18n.setLang()` once they
  arrive. Keys are dot-separated paths into the nested JSON dictionaries and
  support `{{param}}` interpolation.
*/
(function (root) {
  let dictionaries = {};
  let lang = "en";

  function resolve(path, dict) {
    return String(path).split(".").reduce((acc, key) => {
      return acc && typeof acc === "object" ? acc[key] : undefined;
    }, dict);
  }

  function normalizeLang(code) {
    return code === "ru" ? "ru" : "en";
  }

  function setLocales(locales) {
    if (locales && typeof locales === "object") dictionaries = locales;
  }

  function setLang(code) {
    lang = normalizeLang(code);
    if (root.document && root.document.documentElement) {
      root.document.documentElement.lang = lang;
    }
  }

  function getLang() {
    return lang;
  }

  function t(key, params) {
    const dict = dictionaries[lang] || {};
    let str = resolve(key, dict);
    if (typeof str !== "string") str = resolve(key, dictionaries.en || {});
    if (typeof str !== "string") str = String(key);
    if (params) {
      Object.keys(params).forEach((k) => {
        str = str.split("{{" + k + "}}").join(String(params[k]));
      });
    }
    return str;
  }

  // Translate static DOM: [data-i18n] -> textContent, [data-i18n-placeholder]
  // -> placeholder, [data-i18n-title] -> title attribute.
  function apply(scope) {
    const rootEl = scope || (root.document && root.document.body);
    if (!rootEl || typeof rootEl.querySelectorAll !== "function") return;
    rootEl.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    rootEl.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    });
    rootEl.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
    });
  }

  const api = { setLocales, setLang, getLang, t, apply, normalizeLang, resolve };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.I18n = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
