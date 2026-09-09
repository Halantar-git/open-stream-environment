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

const fs = require("fs");
const path = require("path");

/*
  Атомарная синхронная запись файла: данные сначала пишутся во временный файл
  в том же каталоге, затем переименовываются поверх целевого. Если процесс
  упадёт во время записи, целевой файл останется прежним, а не превратится в
  обнулённый мусор (раньше прямой writeFileSync при краше оставлял config.json
  из 8 КБ нулевых байтов).

  Временный файл лежит в том же каталоге, что и целевой, поэтому rename
  остаётся атомарным (одна файловая система). При неудачном rename временный
  файл подчищается, а исходный — нетронут.
*/
function atomicWriteFileSync(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp`);

  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      // сбой очистки игнорируем — важнее сохранить исходную ошибку
    }
    throw err;
  }
}

module.exports = { atomicWriteFileSync };
