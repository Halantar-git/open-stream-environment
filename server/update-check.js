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
  Разбор ответа `autoUpdater.checkForUpdates()`.

  electron-updater отдаёт объект и тогда, когда обновления нет: в нём заполнен
  `updateInfo` (версия из манифеста, то есть текущая), а признак — `isUpdateAvailable`.
  Принимать за признак наличие `updateInfo` нельзя: тогда установленная версия
  предлагается сама себе — так и было, на 3.2.6 панель показывала «доступно
  обновление 3.2.6» и зажигала кнопку «Обновить».
*/

function parseUpdateCheckResult(result) {
  if (!result || result.isUpdateAvailable !== true) {
    return { updateAvailable: false, version: null };
  }
  const version = result.updateInfo && result.updateInfo.version ? String(result.updateInfo.version) : null;
  return { updateAvailable: !!version, version };
}

module.exports = { parseUpdateCheckResult };
