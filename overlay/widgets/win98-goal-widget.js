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
  WidgetWin98Goal — донат-цель в окне Windows 98.

  Прогресс читается как полоса загрузки 98-й: вдавленная белая дорожка и
  синие сегменты цвета заголовка окна. Заголовок окна — синий градиент с
  названием цели и процентом справа, ниже — строка состояния с суммой.

  Панель собирается из токенов темы (`--panel-*`, `--win98-*`), а каркас
  окна, заголовок и вдавленные поля даёт CSS-класс `.win98-surface` из
  shared/widgets.css — так цель не расходится с чатом и алертом.

  Тема изолирована жёстко: на чужой теме не строится ни DOM, ни подписки.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetWin98Goal = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetWin98Goal;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetWin98Goal = WidgetWin98Goal;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_BG = "#c0c0c0";
  const DEFAULT_BORDER = "1px solid #808080";
  const DEFAULT_GLOW =
    "inset 1px 1px 0 #ffffff, inset -1px -1px 0 #000000, inset 2px 2px 0 #dfdfdf, inset -2px -2px 0 #808080";
  const DEFAULT_TEXT = "#000000";
  const DEFAULT_MUTED = "#404040";
  const DEFAULT_PRIMARY = "#000080";

  const FONT_TITLE = "var(--font-display, 'Pixelify Sans', 'Segoe UI', sans-serif)";
  const FONT_MONO = "var(--font-mono, 'VT323', 'Consolas', monospace)";

  class WidgetWin98Goal extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;
      this.primaryColor = DEFAULT_PRIMARY;

      this.windowEl = null;
      this.titlebarEl = null;
      this.titleEl = null;
      this.pctEl = null;
      this.fillEl = null;
      this.statusEl = null;
      this.amountEl = null;
      this.bareTitleEl = null;
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не создаём ни DOM, ни подписки.
      if (this.theme !== "win98") return;

      this._readColors();
      this._applyPerspective();

      this.element.classList.add("win98-surface");
      this._applySurface();

      this.windowEl = document.createElement("div");
      this.windowEl.className = "win98-window";
      this.element.appendChild(this.windowEl);

      this.titlebarEl = document.createElement("div");
      this.titlebarEl.className = "win98-window__titlebar";
      this.windowEl.appendChild(this.titlebarEl);

      this.titleEl = document.createElement("span");
      this.titleEl.className = "win98-window__title";
      this.titlebarEl.appendChild(this.titleEl);

      this.pctEl = document.createElement("span");
      this.pctEl.style.cssText = `font-family:${FONT_MONO};font-size:13px;font-weight:700;flex-shrink:0;`;
      this.titlebarEl.appendChild(this.pctEl);

      const buttons = document.createElement("span");
      buttons.className = "win98-window__buttons";
      buttons.innerHTML = `<i class="win98-window__btn"></i><i class="win98-window__btn"></i>`;
      this.titlebarEl.appendChild(buttons);

      const client = document.createElement("div");
      client.className = "win98-window__client";
      this.windowEl.appendChild(client);

      const track = document.createElement("div");
      track.className = "win98-sunken";
      track.style.cssText = "position:relative;flex:1 1 auto;min-height:8px;overflow:hidden;";
      client.appendChild(track);

      this.fillEl = document.createElement("div");
      this.fillEl.style.cssText =
        "position:absolute;left:0;top:0;bottom:0;width:0%;" +
        "background:repeating-linear-gradient(90deg,var(--win98-titlebar,#000080) 0 9px,transparent 9px 11px);" +
        "transition:width 220ms linear;";
      track.appendChild(this.fillEl);

      this.statusEl = document.createElement("div");
      this.statusEl.className = "win98-statusbar";
      client.appendChild(this.statusEl);

      this.bareTitleEl = document.createElement("span");
      this.bareTitleEl.style.cssText =
        `font-family:${FONT_TITLE};font-weight:700;text-transform:uppercase;letter-spacing:0.4px;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${this.textColor};`;
      this.statusEl.appendChild(this.bareTitleEl);

      this.amountEl = document.createElement("span");
      this.amountEl.style.cssText = `flex:1 1 auto;text-align:right;white-space:nowrap;color:${this.mutedColor};`;
      this.statusEl.appendChild(this.amountEl);

      this._updateDom();

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.GOAL_UPDATE, () => this._updateDom());
      this.subscribe(EVENT_TYPES.LOCALES, () => this._updateDom());
    }

    onUnmount() {
      if (this.windowEl) this.windowEl.innerHTML = "";
      this.windowEl = null;
      this.titlebarEl = null;
      this.titleEl = null;
      this.pctEl = null;
      this.fillEl = null;
      this.statusEl = null;
      this.amountEl = null;
      this.bareTitleEl = null;
    }

    onUpdate(prev, next) {
      if (prev.showPercentage !== next.showPercentage) this._updateDom();
      if (prev.showBackground !== next.showBackground) {
        this._applySurface();
        this._updateDom();
      }
      if (prev.perspective !== next.perspective || prev.perspectiveDirection !== next.perspectiveDirection) {
        this._applyPerspective();
      }
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
      this.primaryColor = (read && read("--md-primary")) || DEFAULT_PRIMARY;
    }

    _applyPerspective() {
      const value = Math.max(0, Math.min(100, Number(this.config.perspective) || 0));
      if (value > 0) {
        const magnitude = value * 0.15;
        const direction = this.config.perspectiveDirection || "left";
        let ry = -magnitude;
        let rx = magnitude * 0.2;
        if (direction === "right") ry = magnitude;
        else if (direction === "up") {
          ry = 0;
          rx = magnitude;
        } else if (direction === "down") {
          ry = 0;
          rx = -magnitude;
        }
        this._setTilt(`perspective(1200px) rotateY(${ry}deg) rotateX(${rx}deg)`);
      } else {
        this._setTilt("");
      }
    }

    // Корпус окна из токенов темы. Как и в остальных наборах, отключённый фон
    // снимает только панель: шкала и цифры остаются на сцене.
    _applySurface() {
      const read = this.context.readCssVar;
      const style = this.element.style;

      if (this.config.showBackground === false) {
        style.backgroundColor = "transparent";
        style.backgroundImage = "none";
        style.backdropFilter = "none";
        style.webkitBackdropFilter = "none";
        style.border = "none";
        style.borderRadius = "0";
        style.clipPath = "none";
        style.boxShadow = "none";
        this.element.classList.remove("win98-surface");
        return;
      }

      this.element.classList.add("win98-surface");
      const bg = (read && read("--panel-bg")) || DEFAULT_BG;
      const border = (read && read("--panel-border")) || DEFAULT_BORDER;
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const glow = (read && read("--panel-glow")) || DEFAULT_GLOW;

      style.backgroundColor = bg;
      style.backgroundImage = "none";
      style.backdropFilter = "none";
      style.webkitBackdropFilter = "none";
      style.border = border;
      style.borderRadius = radius;
      style.clipPath = clip;
      // Мягкая тень 98-й не нужна: силуэт держит жёсткий бевел из токенов.
      style.boxShadow = glow;
    }

    _updateDom() {
      if (!this.titleEl || !this.fillEl) return;
      const { escapeHtml, formatMoney, currencySymbol, t, state } = this.context;
      const goal = (state && state.goal) || {};
      const pct = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
      const title = goal.title || t("preview.goalTitle");
      const framed = this.config.showBackground !== false;

      this.titleEl.textContent = title;
      this.titleEl.style.display = framed ? "" : "none";
      this.pctEl.style.display = framed && this.config.showPercentage ? "" : "none";
      this.pctEl.textContent = `[${pct}%]`;

      // Без рамки название цели переезжает в строку состояния, иначе оно
      // пропало бы вместе с заголовком окна.
      this.bareTitleEl.textContent = title;
      this.bareTitleEl.style.display = framed ? "none" : "";

      const badge = !framed && this.config.showPercentage ? ` [${pct}%]` : "";
      this.amountEl.innerHTML =
        `${escapeHtml(formatMoney(goal.current))} / ${escapeHtml(formatMoney(goal.target))} ` +
        `${escapeHtml(currencySymbol(goal.currency))}${escapeHtml(badge)}`;

      this.fillEl.style.width = `${pct}%`;
    }
  }

  return WidgetWin98Goal;
});
