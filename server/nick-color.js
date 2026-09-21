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
  Цвет ника для чатов, которые его не отдают сами.

  YouTube Live Chat в `authorDetails` возвращает только имя, аватар и флаги —
  цвета автора там нет вовсе, поэтому считаем его сами. Twitch цвет присылает
  тегом `color`, но он бывает и пустым — тогда используется тот же расчёт.
  В обоих случаях берётся стабильный идентификатор (канал / user-id), поэтому
  один и тот же зритель всегда получает один и тот же цвет — в любом стриме и
  после перезапуска приложения.

  Тон берётся из хеша, а насыщенность и светлота зафиксированы: при них любой
  оттенок читается на тёмных панелях оверлея — минимальный контраст к `#131019`
  около 5.6:1, то есть выше порога WCAG AA для обычного текста.
*/

const { hslToHex } = require("../shared/theme-engine");

// Прежний единый цвет ников: остаётся для сообщений, у которых идентификатора
// автора нет вообще.
const DEFAULT_NICK_COLOR = "#e8e1f0";

const HUE_COUNT = 360;
const SATURATION = 62;
const LIGHTNESS = 70;

// FNV-1a — короткий, без зависимостей и одинаковый на всех платформах.
function hashString(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function nickColor(seed) {
  const key = String(seed == null ? "" : seed).trim();
  if (!key) return DEFAULT_NICK_COLOR;
  return hslToHex(hashString(key) % HUE_COUNT, SATURATION, LIGHTNESS);
}

module.exports = { nickColor, DEFAULT_NICK_COLOR };
