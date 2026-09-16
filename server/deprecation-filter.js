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
  Одно предупреждение, которое мы не можем починить сами.

  Node помечает встроенный `punycode` устаревшим (DEP0040) и печатает
  предупреждение при его `require`. Наш код punycode не требует — поиск по
  репозиторию не находит ни одного такого require. Значит, источник чужой, и важно
  понимать, какой именно.

  Измерено (Node 24, тот же механизм в Electron):

    * `require("punycode")` из кода ПРИЛОЖЕНИЯ предупреждает;
    * он же из любого пакета в `node_modules` — молча: так Node и задуман, автору
      приложения такую зависимость всё равно не починить. Проверено на tr46,
      node-fetch и tmi.js — все три грузятся без предупреждения.

  Отсюда вывод: раз в консоли приложения предупреждение есть, а в `node_modules`
  его не порождает ничто, то источник — код ВНЕ `node_modules`, и у нас это только
  сам Electron (его внутренние модули живут не в node_modules). На то же намекает
  и подсказка самого Node: «Use `electron --trace-deprecation ...`».

  Поэтому фильтр точечный — по коду: `--no-deprecation` (или
  `process.noDeprecation`) спрятал бы и наши собственные предупреждения, а
  предупреждения об устаревании — это то, что полезно видеть про свой код.

  Ограничение, о котором честно стоит помнить: фильтр работает только для
  предупреждений, возникших ПОСЛЕ его установки (первая строка main.js). Если
  Electron успевает сделать свой require раньше, чем запускается наш код, фильтр
  не поможет — тогда виден только один путь: запуск с `--no-deprecation`. Точное
  место Node показывает сам: `electron --trace-deprecation .`
*/

const IGNORED_CODES = new Set(["DEP0040"]);

/*
  Подавляет перечисленные коды на источнике: подменяет `process.emitWarning`
  так, чтобы предупреждение вообще не порождалось.

  Именно подмена, а не своя подписка на событие `warning`: у Node есть свой
  обработчик по умолчанию, который печатает предупреждение в stderr, и чтобы его
  перехватить, пришлось бы снимать все слушатели — вместе с чужими (например,
  Jest собирает предупреждения в отчёт тестов). Так никто ничего не теряет.

  Возвращает true, если фильтр установлен этим вызовом, и false при повторном:
  в приложении модуль подключается из нескольких мест, и второй вызов не должен
  оборачивать уже обёрнутое.
*/
function installDeprecationFilter({ ignored = IGNORED_CODES } = {}) {
  if (process.emitWarning.__oseDeprecationFilter) return false;

  const original = process.emitWarning;

  function emitWarning(warning, type, code, ctor) {
    // У process.emitWarning две формы вызова: (warning, type, code, ctor) и
    // (warning, { type, code, ctor, detail }). Код живёт в разных местах.
    const options = type && typeof type === "object" ? type : null;
    const warningCode = options ? options.code : code;
    if (warningCode && ignored.has(warningCode)) return;
    return original.call(process, warning, type, code, ctor);
  }

  emitWarning.__oseDeprecationFilter = true;
  process.emitWarning = emitWarning;
  return true;
}

module.exports = { installDeprecationFilter, IGNORED_CODES };
