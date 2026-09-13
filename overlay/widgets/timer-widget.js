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
  Timer widget — the 2D variant of the Executive Hangar cycle timer.

  Same cycle and markup as the Grim HEX 3D variant (./executive-timer-core.js);
  availability is decided by the catalog `themes` binding (Orbital + custom
  themes), so there is no hard theme gate here. When the active theme has a
  unique 3D counterpart for the "timer" role (Grim HEX), this 2D widget is
  remapped to it by the WidgetManager.
*/
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const Core = isNode ? require("./executive-timer-core") : root.OSEWidgets;
  const TimerWidget = factory(Core && Core.ExecutiveHangarTimer);

  if (isNode) {
    module.exports = TimerWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.TimerWidget = TimerWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (ExecutiveHangarTimer) {
  "use strict";

  class TimerWidget extends ExecutiveHangarTimer {}

  return TimerWidget;
});
