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
  WidgetTerminalGoal — донат-цель как вывод команды.

  Шкала нарисована символами `█` и `░` в моноширинной строке, процент — в
  квадратных скобках рядом, ниже — сумма `current / target` со знаком валюты.
  Заголовок — вкладка терминала `root@ose-goal:~#`.

  Панель собирается из токенов темы (`--panel-*`, `--term-*`), каркас даёт
  `.terminal-surface` из shared/widgets.css — так цель не расходится с чатом
  и алертом. Тема изолирована жёстко: на чужой не строится ни DOM, ни подписки.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetTerminalGoal = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetTerminalGoal;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetTerminalGoal = WidgetTerminalGoal;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_BG = "rgba(13, 17, 23, 0.92)";
  const DEFAULT_BORDER = "1px solid #30363d";
  const DEFAULT_GLOW = "0 0 18px rgba(0, 255, 102, 0.25)";
  const DEFAULT_TEXT = "#c9d1d9";
  const DEFAULT_MUTED = "#8b949e";
  const DEFAULT_PROMPT = "#00ff66";

  // Ширина шкалы в символах: 24 клетки читаются и на узкой панели, и на широкой.
  const BARS = 24;

  class WidgetTerminalGoal extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;
      this.promptColor = DEFAULT_PROMPT;

      this.windowEl = null;
      this.tabEl = null;
      this.titleEl = null;
      this.barEl = null;
      this.amountEl = null;
      this.bareTitleEl = null;
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не создаём ни DOM, ни подписки.
      if (this.theme !== "terminal") return;

      this._readColors();
      this._applyPerspective();

      this.element.classList.add("terminal-surface");
      this._applySurface();

      this.windowEl = document.createElement("div");
      this.windowEl.className = "terminal-window";
      this.element.appendChild(this.windowEl);

      this.tabEl = document.createElement("div");
      this.tabEl.className = "terminal-tab";
      const promptSpan = document.createElement("span");
      promptSpan.className = "terminal-tab__prompt";
      promptSpan.textContent = "root@ose-goal:~#";
      this.tabEl.appendChild(promptSpan);
      this.titleEl = document.createElement("span");
      this.titleEl.className = "terminal-tab__title";
      this.tabEl.appendChild(this.titleEl);
      const dots = document.createElement("span");
      dots.className = "terminal-tab__dots";
      for (let i = 0; i < 3; i += 1) {
        const dot = document.createElement("i");
        dot.className = "terminal-tab__dot";
        dots.appendChild(dot);
      }
      this.tabEl.appendChild(dots);
      this.windowEl.appendChild(this.tabEl);

      const body = document.createElement("div");
      body.className = "terminal-body";
      body.style.justifyContent = "center";
      this.windowEl.appendChild(body);

      this.barEl = document.createElement("div");
      this.barEl.style.cssText =
        "font-family:var(--font-mono);font-size:13px;line-height:1.2;white-space:nowrap;" +
        "overflow:hidden;text-overflow:clip;";
      body.appendChild(this.barEl);

      this.amountEl = document.createElement("div");
      this.amountEl.style.cssText =
        `font-family:var(--font-mono);font-size:12px;line-height:1.3;color:${this.mutedColor};` +
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      body.appendChild(this.amountEl);

      this._updateDom();

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.GOAL_UPDATE, () => this._updateDom());
      this.subscribe(EVENT_TYPES.LOCALES, () => this._updateDom());
    }

    onUnmount() {
      if (this.windowEl) this.windowEl.innerHTML = "";
      this.windowEl = null;
      this.tabEl = null;
      this.titleEl = null;
      this.barEl = null;
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
      this.promptColor = (read && read("--term-prompt")) || DEFAULT_PROMPT;
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

    // Корпус панели из токенов темы. Отключённый фон снимает только панель:
    // шкала и цифры остаются на сцене.
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
        style.boxShadow = "none";
        this.element.classList.remove("terminal-surface");
        return;
      }

      this.element.classList.add("terminal-surface");
      style.backgroundColor = (read && read("--panel-bg")) || DEFAULT_BG;
      style.backgroundImage = "none";
      style.backdropFilter = "none";
      style.webkitBackdropFilter = "none";
      style.border = (read && read("--panel-border")) || DEFAULT_BORDER;
      style.borderRadius = (read && read("--panel-radius")) || "6px";
      style.boxShadow = (read && read("--panel-glow")) || DEFAULT_GLOW;
    }

    // Шкала символами: заполненные клетки — зелёным, пустые — приглушённым.
    _barHtml(pct) {
      const filled = Math.round((pct / 100) * BARS);
      const on = "█".repeat(filled);
      const off = "░".repeat(BARS - filled);
      const percent = this.config.showPercentage === false ? "" : ` [${pct}%]`;
      return (
        `<span style="color:${this.mutedColor};">[</span>` +
        `<span style="color:${this.promptColor};">${on}</span>` +
        `<span style="color:${this.mutedColor};">${off}</span>` +
        `<span style="color:${this.mutedColor};">]</span>` +
        `<span style="color:${this.promptColor};">${percent}</span>`
      );
    }

    _updateDom() {
      if (!this.barEl) return;
      const { escapeHtml, formatMoney, currencySymbol, t, state } = this.context;
      const goal = (state && state.goal) || {};
      const pct = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
      const title = goal.title || t("preview.goalTitle");
      const framed = this.config.showBackground !== false;

      this.titleEl.textContent = framed ? title : "";
      this.tabEl.style.display = framed ? "" : "none";

      this.barEl.innerHTML = this._barHtml(pct);

      const amounts =
        `${escapeHtml(formatMoney(goal.current))} / ${escapeHtml(formatMoney(goal.target))} ` +
        `${escapeHtml(currencySymbol(goal.currency))}`;
      const titlePrefix = framed ? "" : `${escapeHtml(title)}  `;
      this.amountEl.innerHTML = titlePrefix + amounts;
    }
  }

  return WidgetTerminalGoal;
});
