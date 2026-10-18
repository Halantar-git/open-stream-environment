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
  Размер кадра, который уходит из видео-моста в энкодер и оверлей.

  Ширину выбирает пользователь, но выше источника не поднимаем: апскейл не
  добавляет деталей, зато добавляет пиксели энкодеру и декодеру. Высота идёт
  по пропорциям потока — у телефона в режиме 4:3 она отличается от 16:9,
  и жёсткие 9/16 обрезали бы или растянули кадр. Функция чистая, поэтому
  проверяется тестами без DOM и WebCodecs.

  Формат UMD, как у `guards.js`: в браузере файл подключается обычным
  <script> и живёт на window, а Jest забирает его через require.
*/
(function (root) {
  "use strict";

  function cameraOutputSize(wanted, sourceWidth, sourceHeight) {
    const target = Math.max(2, Math.round(Number(wanted) || 960));
    const srcWidth = Math.max(1, Math.round(Number(sourceWidth) || target));
    const srcHeight = Math.max(1, Math.round(Number(sourceHeight) || Math.round((target * 9) / 16)));
    const width = Math.max(2, Math.min(target, srcWidth));
    const height = Math.max(2, Math.round((width * srcHeight) / srcWidth));
    // H.264-энкодеры требуют чётные стороны.
    return { width: width - (width % 2), height: height - (height % 2) };
  }

  const api = { cameraOutputSize };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ControlCamera = api;
})(this);
