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

  A Cinzel header (goal title + amounts) over a dark track framed in gold,
  with a health-red gradient fill and gold notches on either side of the
  track. The fill eases on each donation. Driven only by the goal state.

  The background matches the Recent events widget: a filled panel surface
  (var(--panel-bg) + border + radius + shadow), with gold corner brackets
  (--panel-decoration = brackets2).
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
  const TEXT = "#e6e3d8";
  const MUTED = "#bfc3b0";
  const TRACK = "rgba(0, 0, 0, 0.6)";
  const FILL_GRADIENT = "linear-gradient(90deg, #611313, #a62323, #da3636)";
  const FONT_DISPLAY = "'Cinzel', 'Georgia', serif";
  const FONT_MONO = "'Cinzel', 'Georgia', serif";

  class WidgetTesoGoal extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.layoutEl = null;
      this.contentEl = null;
      this.fillEl = null;
    }

    onMount() {
      // HARD theme gate: no DOM, no events on a non-TESO theme.
      if (this.theme !== "teso-seal") return;

      // Inner flex layout (keeps the BaseWidget geometry untouched).
      this.layoutEl = document.createElement("div");
      this.layoutEl.className = "teso-goal";
      this.layoutEl.style.cssText =
        "position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;box-sizing:border-box;padding:12px 16px;gap:4px;";
      this.element.appendChild(this.layoutEl);

      // Title + amounts row.
      this.contentEl = document.createElement("div");
      this.contentEl.className = "teso-goal__content";
      this.contentEl.style.cssText =
        "display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-shrink:0;";
      this.layoutEl.appendChild(this.contentEl);

      // Track with fill + gold notches.
      this._buildBar();

      // Gold corner brackets driven by the theme's --panel-decoration token.
      this.element.classList.add("teso-goal-surface");
      this._applySurface();
      this._updateDom();

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.GOAL_UPDATE, () => this._updateDom());
      this.subscribe(EVENT_TYPES.LOCALES, () => this._updateDom());
    }

    onUnmount() {
      if (this.element) this.element.innerHTML = "";
      this.layoutEl = null;
      this.contentEl = null;
      this.fillEl = null;
    }

    // React to config/layout patches pushed through update() (the
    // "Показывать %" and "Фон" toggles in the inspector).
    onUpdate(prev, next) {
      if (prev.showPercentage !== next.showPercentage) this._updateDom();
      if (prev.showBackground !== next.showBackground) this._applySurface();
    }

    _buildBar() {
      const track = document.createElement("div");
      track.className = "teso-goal__track";
      track.style.cssText =
        `position:relative;height:20px;background:${TRACK};` +
        `border:1px solid rgba(199,167,92,0.4);box-shadow:inset 0 0 8px rgba(0,0,0,0.9);` +
        "padding:2px;box-sizing:border-box;flex-shrink:0;";

      this.fillEl = document.createElement("div");
      this.fillEl.className = "teso-goal__fill";
      this.fillEl.style.cssText =
        `height:100%;width:0%;background:${FILL_GRADIENT};` +
        "box-shadow:0 0 8px rgba(166,35,35,0.6);transition:width 600ms ease-in-out;";
      track.appendChild(this.fillEl);

      this.layoutEl.appendChild(track);
    }

    // Panel surface matching the Recent events widget: filled panel, border,
    // radius and drop shadow/glow. Cleared entirely when showBackground is false.
    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      if (this.config.showBackground === false) {
        s.backgroundColor = "transparent";
        s.backgroundImage = "none";
        s.backdropFilter = "none";
        s.webkitBackdropFilter = "none";
        s.border = "none";
        s.borderRadius = "0";
        s.clipPath = "none";
        s.boxShadow = "none";
        return;
      }

      const bg = (read && read("--panel-bg")) || "rgba(13, 17, 15, 0.92)";
      const blur = (read && read("--panel-blur")) || "4px";
      const border = (read && read("--panel-border")) || "1px solid #a38652";
      const radius = (read && read("--panel-radius")) || "2px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow =
        (read && read("--panel-glow")) ||
        "0 0 15px rgba(199,167,92,0.35), inset 0 0 30px rgba(199,167,92,0.05)";

      s.backgroundColor = bg;
      s.backgroundImage = "";
      s.backdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.webkitBackdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.border = border;
      s.borderRadius = radius;
      s.clipPath = clip;
      s.boxShadow = `${elev}, ${glow}`;
    }

    // ---- data -> DOM ----

    _updateDom() {
      if (!this.contentEl) return;
      const { escapeHtml, formatMoney, currencySymbol, t, state } = this.context;
      const goal = (state && state.goal) || {};
      const target = Number(goal.target) || 0;
      const current = Number(goal.current) || 0;
      const pct = target ? Math.min(100, (current / target) * 100) : 0;

      const pctStr = this.config.showPercentage
        ? `<span style="color:${GOLD_BRIGHT};"> (${Math.round(pct)}%)</span>`
        : "";

      this.contentEl.innerHTML =
        `<span style="color:${GOLD};font-family:${FONT_DISPLAY};font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:1px 1px 2px rgba(0,0,0,0.9);">${escapeHtml(goal.title || t("preview.goalTitle"))}</span>` +
        `<span style="color:${MUTED};font-family:${FONT_MONO};font-size:12px;white-space:nowrap;"><b style="color:${GOLD_BRIGHT};">${formatMoney(current)}</b> / ${formatMoney(target)} ${escapeHtml(currencySymbol(goal.currency))}${pctStr}</span>`;

      if (this.fillEl) this.fillEl.style.width = pct + "%";
    }
  }

  return WidgetTesoGoal;
});
