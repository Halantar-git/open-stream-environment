/*
  Copyright (C) 2026  Halantar

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://gnu.org>.
*/

/*
  Журнал изменяющих команд.

  Зачем: приложение слушает порт, и до сих пор нельзя было ответить на вопрос
  «а что вообще происходило?» — кто переключил сцену, откуда пришла команда,
  не долбится ли кто-то в шину. Теперь каждая команда от клиента оставляет
  запись в кольцевом буфере: время, тип, роль клиента, признак «из сети» и пара
  безопасных деталей (идентификаторы виджета/сцены, а не содержимое).

  Чего здесь сознательно нет и не должно быть:
    * полного payload — в сообщениях чата и настройках бывают личные данные и
      секреты, а журнал уходит в отчёт для поддержки;
    * адресов клиентов — роль и признак «из сети» для разбора достаточны;
    * записи в файловый лог на каждое локальное действие — панель и оверлей
      шлют команды постоянно, и лог превратился бы в шум. В файл уходят только
      события, которые интересны и после перезапуска: действия из сети и
      срабатывания ограничителя частоты (см. onEntry в index.js).
*/

// Поля, которые безопасно показать в журнале: это идентификаторы и переключатели,
// а не тексты. Строки обрезаются — в журнале не место длинным сообщениям.
const SAFE_FIELDS = [
  "id",
  "widgetId",
  "sceneId",
  "scene",
  "action",
  "type",
  "port",
  "lang",
  "level",
  "themeId",
  "index",
  "direction",
  "enabled",
  "visible",
  "soundId",
  "imageId",
  "cameraAngleId",
  "cameraFilterId",
  "presetId",
  "optionId",
  "rewardId",
  "hotkey",
  "target",
  "displayId",
];

const MAX_STRING = 60;

function safeValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = String(value);
  return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text;
}

// Из payload берём только безопасные поля верхнего уровня и вложенный action,
// если он есть: остальное может содержать что угодно.
function summarizePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const out = {};
  SAFE_FIELDS.forEach((key) => {
    if (payload[key] !== undefined) out[key] = safeValue(payload[key]);
  });
  return Object.keys(out).length ? out : null;
}

function createAuditLog(options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 200;
  const onEntry = typeof options.onEntry === "function" ? options.onEntry : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();

  const entries = [];
  const counters = { total: 0, external: 0, limited: 0 };

  function record(entry = {}) {
    const item = {
      at: clock(),
      type: String(entry.type || "unknown"),
      role: String(entry.role || "other"),
      external: !!entry.external,
      limited: !!entry.limited,
      details: entry.details || null,
    };
    entries.push(item);
    if (entries.length > limit) entries.shift();
    counters.total += 1;
    if (item.external) counters.external += 1;
    if (item.limited) counters.limited += 1;
    if (onEntry) {
      try {
        onEntry(item);
      } catch {
        /* журнал не должен мешать обработке команд */
      }
    }
    return item;
  }

  return {
    record,
    // Свежие записи: сначала новые — так их читают и человек, и отчёт.
    recent(count = 50) {
      const size = Math.max(0, Math.floor(Number(count) || 0));
      // slice(-0) вернул бы весь массив: ноль нужно отсечь отдельно.
      if (!size) return [];
      return entries.slice(-size).reverse();
    },
    counters() {
      return { ...counters, kept: entries.length };
    },
    get limit() {
      return limit;
    },
  };
}

module.exports = { createAuditLog, summarizePayload, SAFE_FIELDS };
