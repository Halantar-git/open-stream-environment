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
  Общая шина страницы сцены: виджеты на канвасе сцены подписываются на те же
  события, что и на оверлее (`alert`, `chat_message`, `goal_update`, …).
*/
(function () {
  "use strict";
  const OW = window.OSEWidgets || {};
  if (!OW.EventBus) return;
  window.OSESceneBus = new OW.EventBus();
})();
