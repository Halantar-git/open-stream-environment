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
  WidgetOrbitalSymbol — неоновая сфера в семье Star Citizen.

  Orbital включает 3D-набор Star Citizen (Grim HEX), поэтому знаку нужен гейт
  именно этой семьи. Вся геометрия — сетка, глубина, экватор, полюса и иконка
  события в центре — живёт в базовом классе Retrowave: палитры у тем совпадают
  (циан и янтарь), и сфера читается одинаково в обеих.

  Тема изолирована так же жёстко: на чужой семье не поднимается ни цикл, ни
  подписки.
*/
(function (root, factory) {
  const Base =
    typeof module !== "undefined" && module.exports
      ? require("./retrowave-symbol-widget")
      : root.OSEWidgets && root.OSEWidgets.WidgetRetrowaveSymbol;
  const WidgetOrbitalSymbol = factory(Base);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetOrbitalSymbol;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetOrbitalSymbol = WidgetOrbitalSymbol;
  }
})(typeof window !== "undefined" ? window : globalThis, function (Base) {
  "use strict";

  class WidgetOrbitalSymbol extends Base {
    _themeFamily() {
      return "grimhex";
    }
  }

  return WidgetOrbitalSymbol;
});
