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
  Death counter widget — large death counter for challenge streams.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const DeathWidget = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = DeathWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.DeathWidget = DeathWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  class DeathWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-death";
      this.element.appendChild(this.host);

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.DEATH_COUNT_UPDATE, () => this.render());
      this.subscribe(EVENT_TYPES.LOCALES, () => this.render());
    }

    render() {
      const { escapeHtml, escapeAttr, t, state } = this.context;
      const label = this.config.label || t("preview.death");
      const color = this.config.color || "#ff4d4d";
      this.host.innerHTML = `<div class="widget-death__label">${escapeHtml(label)}</div><div class="widget-death__value" style="color:${escapeAttr(color)}">${state.deathCount}</div>`;
    }
  }

  return DeathWidget;
});
