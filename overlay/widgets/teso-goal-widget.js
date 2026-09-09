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
  WidgetTesoGoal — Elder Scrolls-style donation goal bar for the TESO
  "Ouroboros Seal" 3D theme.

  A transparent, full-width attribute bar in the style of the TESO HUD:
  pointed/chevron ends (<=====>), a 2px gold outline, a dark track with a
  health-red gradient fill, and the title + amounts drawn inside the bar
  itself (no separate header, no panel background).

  Theme isolation: hard-gated to "teso-seal" in onMount() and via the manager
  (shouldMount / resolveRenderType using the catalog `theme` field).
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetTesoGoal = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetTesoGoal;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetTesoGoal = WidgetTesoGoal;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const GOLD = "#c7a75c";
  const GOLD_BRIGHT = "#e2c47e";
  const MUTED = "#bfc3b0";
  const OUTLINE = GOLD; // 2px gold outline around the bar
  const TRACK = "#171310"; // opaque dark track (no panel behind it)
  const FILL_GRADIENT = "linear-gradient(90deg, #611313, #a62323, #da3636)";
  const FONT_DISPLAY = "'Cinzel', 'Georgia', serif";
  const FONT_MONO = "'Cinzel', 'Georgia', serif";

  // Pointed-end geometry: the horizontal run of each chevron tip, derived from
  // the bar height so the ~45° angle stays consistent across widget sizes.
  const TIP_MIN = 6;
  const TIP_MAX = 22;

  class WidgetTesoGoal extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.outerEl = null;
      this.innerEl = null;
      this.fillEl = null;
      this.labelEl = null;
    }

    onMount() {
      // HARD theme gate: no DOM, no events on a non-TESO theme.
      if (this.theme !== "teso-seal") return;

      // Outer shell: the 2px gold outline, exposed through the padding.
      this.outerEl = document.createElement("div");
      this.outerEl.className = "teso-goal";
      this.outerEl.style.cssText =
        "position:absolute;inset:0;box-sizing:border-box;padding:2px;" +
        `background:${OUTLINE};`;
      this.element.appendChild(this.outerEl);

      // Inner track (dark), inset by the 2px outline.
      this.innerEl = document.createElement("div");
      this.innerEl.className = "teso-goal__track";
      this.innerEl.style.cssText =
        "position:relative;width:100%;height:100%;box-sizing:border-box;" +
        `background:${TRACK};box-shadow:inset 0 0 10px rgba(0,0,0,0.9);`;
      this.outerEl.appendChild(this.innerEl);

      // Health-red gradient fill, clipped to the track's pointed silhouette.
      this.fillEl = document.createElement("div");
      this.fillEl.className = "teso-goal__fill";
      this.fillEl.style.cssText =
        "position:absolute;left:0;top:0;bottom:0;width:0%;" +
        `background:${FILL_GRADIENT};box-shadow:0 0 8px rgba(166,35,35,0.6);` +
        "transition:width 600ms ease-in-out;";
      this.innerEl.appendChild(this.fillEl);

      // Text overlay inside the bar.
      this.labelEl = document.createElement("div");
      this.labelEl.className = "teso-goal__label";
      this.labelEl.style.cssText =
        "position:absolute;inset:0;display:flex;align-items:center;justify-content:space-between;gap:12px;" +
        "padding:0 20px;box-sizing:border-box;";
      this.innerEl.appendChild(this.labelEl);

      this._applyShape();
      this._updateDom();

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.GOAL_UPDATE, () => this._updateDom());
      this.subscribe(EVENT_TYPES.LOCALES, () => this._updateDom());
      this.on(window, "resize", () => this._applyShape());
    }

    onUnmount() {
      if (this.element) this.element.innerHTML = "";
      this.outerEl = null;
      this.innerEl = null;
      this.fillEl = null;
      this.labelEl = null;
    }

    // React to config/layout patches pushed through update() (the "Показывать %"
    // toggle in the inspector, plus any geometry resize).
    onUpdate(prev, next) {
      if (prev.showPercentage !== next.showPercentage) this._updateDom();
      this._applyShape();
    }

    // Pointed/chevron silhouette applied to both the outline and the track.
    _applyShape() {
      if (!this.outerEl || !this.innerEl) return;
      const h = this.innerEl.clientHeight || this.element.clientHeight || 24;
      const tip = Math.max(TIP_MIN, Math.min(TIP_MAX, Math.round(h * 0.5)));
      const polygon =
        `polygon(0 50%, ${tip}px 0, calc(100% - ${tip}px) 0, 100% 50%, ` +
        `calc(100% - ${tip}px) 100%, ${tip}px 100%)`;
      this.outerEl.style.clipPath = polygon;
      this.innerEl.style.clipPath = polygon;
    }

    // ---- data -> DOM ----

    _updateDom() {
      if (!this.labelEl) return;
      const { escapeHtml, formatMoney, currencySymbol, t, state } = this.context;
      const goal = (state && state.goal) || {};
      const target = Number(goal.target) || 0;
      const current = Number(goal.current) || 0;
      const pct = target ? Math.min(100, (current / target) * 100) : 0;

      const pctStr = this.config.showPercentage
        ? `<span style="color:${GOLD_BRIGHT};"> (${Math.round(pct)}%)</span>`
        : "";

      this.labelEl.innerHTML =
        `<span style="color:${GOLD};font-family:${FONT_DISPLAY};font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:1px 1px 2px rgba(0,0,0,0.95);">${escapeHtml(goal.title || t("preview.goalTitle"))}</span>` +
        `<span style="color:${MUTED};font-family:${FONT_MONO};font-size:12px;white-space:nowrap;text-shadow:1px 1px 2px rgba(0,0,0,0.95);"><b style="color:${GOLD_BRIGHT};">${formatMoney(current)}</b> / ${formatMoney(target)} ${escapeHtml(currencySymbol(goal.currency))}${pctStr}</span>`;

      if (this.fillEl) this.fillEl.style.width = pct + "%";
    }
  }

  return WidgetTesoGoal;
});
