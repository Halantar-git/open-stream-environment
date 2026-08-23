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
  Goal widget — donation goal progress bar. 2D DOM/CSS, re-renders on
  `goal_update` and `locales`.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const GoalWidget = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = GoalWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.GoalWidget = GoalWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  class GoalWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-goal";
      this.element.appendChild(this.host);

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.GOAL_UPDATE, () => this.render());
      this.subscribe(EVENT_TYPES.LOCALES, () => this.render());
    }

    render() {
      const { escapeHtml, formatMoney, currencySymbol, t, state } = this.context;
      const goal = state.goal || {};
      const pct = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;

      this.host.classList.toggle("widget-goal--no-bg", this.config.showBackground === false);
      this.host.innerHTML = `
        <div class="widget-goal__row">
          <span class="widget-goal__title">${escapeHtml(goal.title || t("preview.goalTitle"))}</span>
          <span class="widget-goal__amounts"><b>${formatMoney(goal.current)}</b> / ${formatMoney(goal.target)} ${escapeHtml(currencySymbol(goal.currency))}</span>
        </div>
        ${this._barHtml(pct)}
        ${this.config.showPercentage ? `<div class="widget-goal__percent">${pct}%</div>` : ""}`;
    }

    _barHtml(pct) {
      // The Elite (2D) theme uses the Cobra-style 10-segment readout; every
      // other theme keeps the standard linear progress bar.
      if (this.context.activeThemeId !== "elite") {
        return `<div class="md-linear-progress"><div class="md-linear-progress__bar" style="width:${pct}%"></div></div>`;
      }

      const SEGMENTS = 10;
      let cells = "";
      for (let i = 0; i < SEGMENTS; i++) {
        const segStart = (i * 100) / SEGMENTS;
        const segSize = 100 / SEGMENTS;
        const fill = Math.max(0, Math.min(1, (pct - segStart) / segSize));
        cells += `<div class="widget-goal__seg"><div class="widget-goal__seg-fill" style="width:${Math.round(fill * 100)}%"></div></div>`;
      }
      return `<div class="widget-goal__segments">${cells}</div>`;
    }
  }

  return GoalWidget;
});
