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
  Мелкие защитные помощники панели управления: безопасное значение цвета для
  инлайнового стиля и счётчик поколений захвата микрофона.

  Формат UMD, как у модулей shared/: в браузере файл подключается обычным
  <script> и живёт на window (control.js читает window.ControlGuards), а Jest
  забирает его через require — поэтому у панели есть тесты на чистой логике
  без jsdom (см. tests/control-guards.test.js).
*/
(function (root) {
  "use strict";

  const HEX = /^#[0-9a-f]{3,8}$/i;
  const CSS_VAR = /^var\(--[a-z0-9-]+\)$/i;

  /*
    Цвет из данных (тема могла приехать из чужого JSON-файла) нельзя склеивать в
    разметку: строка вида `#fff"></span><img onerror=…>` вырвалась бы из
    атрибута style. Пропускаем только одиночный цвет — hex или ссылку на токен
    темы, — остальное заменяем безопасным значением по умолчанию.
  */
  function safeCssColor(value, fallback) {
    const fallbackColor = typeof fallback === "string" && fallback ? fallback : "#888";
    const v = typeof value === "string" ? value.trim() : "";
    return HEX.test(v) || CSS_VAR.test(v) ? v : fallbackColor;
  }

  /*
    Счётчик поколений захвата микрофона. Мик-мост асинхронный: getUserMedia
    отвечает не сразу, а за это время мост могли остановить или перезапустить
    (смена устройства, выключение виджета). begin() выдаёт номер текущего
    поколения, invalidate() его увеличивает, isStale() проверяет, что результат
    всё ещё актуален — устаревший поток надо остановить, иначе микрофон остаётся
    захваченным (stop() про него уже не знает).
  */
  function createCaptureGeneration() {
    let current = 0;
    return {
      begin: () => current,
      invalidate: () => {
        current += 1;
        return current;
      },
      isStale: (generation) => generation !== current,
    };
  }

  const api = { safeCssColor, createCaptureGeneration };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ControlGuards = api;
})(typeof window !== "undefined" ? window : globalThis);
