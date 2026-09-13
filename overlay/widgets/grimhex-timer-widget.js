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
  Grim HEX timer widget — the 3D (Grim HEX family) variant of the Executive
  Hangar cycle timer. All rendering lives in ./executive-timer-core.js; this
  file only adds the hard Grim HEX theme gate.
*/
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const Core = isNode ? require("./executive-timer-core") : root.OSEWidgets;
  const GrimHexTimerWidget = factory(Core && Core.ExecutiveHangarTimer);

  if (isNode) {
    module.exports = GrimHexTimerWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.GrimHexTimerWidget = GrimHexTimerWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (ExecutiveHangarTimer) {
  "use strict";

  class GrimHexTimerWidget extends ExecutiveHangarTimer {
    constructor(config, context) {
      super(config, context);
      // HARD theme gate: no DOM, no events outside the Grim HEX family.
      this.requiredTheme = "grimhex";
    }
  }

  return GrimHexTimerWidget;
});
