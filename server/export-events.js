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
  Сериализация истории стрим-событий для экспорта в файл.

  Вынесено из main.js, чтобы форматирование (и особенно экранирование CSV)
  можно было покрыть юнит-тестами без запуска Electron.
*/

const CSV_HEADER = ["id", "timestamp", "date", "type", "kind", "username", "amount", "currency", "message", "is_test"];

// Значение с запятой, кавычкой, точкой с запятой или переводом строки
// заворачивается в кавычки, внутренние кавычки удваиваются (RFC 4180).
function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function eventsToCsv(items) {
  const rows = (Array.isArray(items) ? items : []).map((e) =>
    [
      e.id,
      e.timestamp,
      e.timestamp ? new Date(e.timestamp).toISOString() : "",
      e.type,
      e.kind,
      e.username,
      typeof e.amount === "number" ? e.amount : "",
      e.currency,
      e.message,
      e.is_test ? "1" : "0",
    ]
      .map(csvCell)
      .join(",")
  );
  return [CSV_HEADER.join(","), ...rows].join("\n") + "\n";
}

module.exports = { csvCell, eventsToCsv, CSV_HEADER };
