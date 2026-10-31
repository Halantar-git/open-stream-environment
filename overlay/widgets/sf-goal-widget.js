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
  WidgetSfGoal — донат-цель в виде шкалы оборотов.

  Язык темы — приборка CB400SF, поэтому прогресс читается не сплошной полосой,
  а секторами тахометра: четырнадцать клеток по тысяче оборотов, перламутровый
  фиолетовый переходит в бирюзу Candy Flash, последние три клетки — золотая
  зона отсечки (цвет пружин Showa). Голова заливки светится, поэтому процент
  видно и на тёмной сцене.

  Панель собирается из токенов темы (`--panel-*`), а фактуру и полосу Candy
  Flash даёт класс `.sf-surface` из shared/widgets.css — так цель не
  расходится с чатом и алертом при смене палитры.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetSfGoal = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetSfGoal;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetSfGoal = WidgetSfGoal;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_PRIMARY = "#7b2cbf";
  const DEFAULT_SECONDARY = "#ffb700";
  const DEFAULT_TERTIARY = "#00f5d4";
  const DEFAULT_TEXT = "#ffffff";
  const DEFAULT_MUTED = "#9a8c98";

  const DEFAULT_PANEL_BG = "rgba(34, 22, 62, 0.92)";
  const DEFAULT_PANEL_BORDER = "2px solid rgba(123, 44, 191, 0.55)";
  const DEFAULT_PANEL_GLOW = "0 0 12px rgba(157, 78, 221, 0.5)";

  const FONT_DISPLAY = "'Rajdhani', 'Segoe UI', sans-serif";
  const FONT_MONO = "'JetBrains Mono', 'Consolas', monospace";

  const CELLS = 14;
  const REDLINE_CELL = 11;

  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

  function parseHex(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!match) return null;
    const n = parseInt(match[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Линейный переход между двумя цветами темы: заливка идёт от перламутра
  // к циану, не выходя за палитру.
  function mixColor(from, to, ratio) {
    const a = parseHex(from);
    const b = parseHex(to);
    if (!a || !b) return from;
    const k = clamp(ratio, 0, 1);
    const channel = (index) => Math.round(a[index] + (b[index] - a[index]) * k);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
  }

  function rgba(hex, alpha) {
    const rgb = parseHex(hex);
    if (!rgb) return `rgba(123, 44, 191, ${alpha})`;
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
  }

  class WidgetSfGoal extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.primary = DEFAULT_PRIMARY;
      this.secondary = DEFAULT_SECONDARY;
      this.tertiary = DEFAULT_TERTIARY;
      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;

      this.canvas = null;
      this.ctx = null;
      this.layoutEl = null;
      this.contentEl = null;
      this.amountEl = null;
      this.barWrap = null;

      this._pct = 0;
      this._displayPct = 0;
    }

    // Полоса анимируется, хотя корневой элемент — обычный div.
    _isAnimated() {
      return true;
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не создаём ни DOM, ни цикл.
      if (this.theme !== "sf") return;

      this._readColors();
      this._applyPerspective();

      this.layoutEl = document.createElement("div");
      this.layoutEl.className = "sf-goal";
      this.layoutEl.style.cssText =
        "position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;box-sizing:border-box;padding:8px 16px 9px;";
      this.element.appendChild(this.layoutEl);

      this.contentEl = document.createElement("div");
      this.contentEl.className = "sf-goal__content";
      this.contentEl.style.cssText =
        "display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-shrink:0;margin-bottom:6px;";
      this.layoutEl.appendChild(this.contentEl);

      this.barWrap = document.createElement("div");
      this.barWrap.className = "sf-goal__bar";
      this.barWrap.style.cssText = "position:relative;flex:0 0 auto;height:22px;min-height:0;";
      this.layoutEl.appendChild(this.barWrap);

      this.canvas = document.createElement("canvas");
      this.canvas.className = "sf-goal__canvas";
      Object.assign(this.canvas.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
      });
      this.barWrap.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");

      this.element.classList.add("sf-surface");
      this._applySurface();
      this._updateDom();

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.GOAL_UPDATE, () => this._updateDom());
      this.subscribe(EVENT_TYPES.LOCALES, () => this._updateDom());

      this.startRenderLoop(30);
    }

    onUnmount() {
      if (this.element) this.element.innerHTML = "";
      this.layoutEl = null;
      this.contentEl = null;
      this.amountEl = null;
      this.barWrap = null;
      this.ctx = null;
      this.canvas = null;
    }

    onUpdate(prev, next) {
      if (prev.showPercentage !== next.showPercentage) this._updateDom();
      if (prev.showBackground !== next.showBackground) this._applySurface();
      if (prev.perspective !== next.perspective || prev.perspectiveDirection !== next.perspectiveDirection) {
        this._applyPerspective();
      }
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.primary = (read && read("--md-primary")) || DEFAULT_PRIMARY;
      this.secondary = (read && read("--md-secondary")) || DEFAULT_SECONDARY;
      this.tertiary = (read && read("--md-tertiary")) || DEFAULT_TERTIARY;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
    }

    _applyPerspective() {
      const value = clamp(Number(this.config.perspective) || 0, 0, 100);
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

    // Панель из токенов темы: одна поверхность на цель, чат и алерт.
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
        this.element.classList.remove("sf-surface");
        return;
      }

      this.element.classList.add("sf-surface");
      const bg = (read && read("--panel-bg")) || DEFAULT_PANEL_BG;
      const blur = (read && read("--panel-blur")) || "12px";
      const border = (read && read("--panel-border")) || DEFAULT_PANEL_BORDER;
      const radius = (read && read("--panel-radius")) || "6px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev = (read && read("--elev-1")) || "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow = (read && read("--panel-glow")) || DEFAULT_PANEL_GLOW;

      // Пустая backgroundImage оставляет фактуру из `.sf-surface`.
      style.backgroundColor = bg;
      style.backgroundImage = "";
      style.backdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      style.webkitBackdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      style.border = border;
      style.borderRadius = radius;
      style.clipPath = clip;
      style.boxShadow = `${elev}, ${glow}`;
    }

    _updateDom() {
      if (!this.contentEl) return;
      const { escapeHtml, formatMoney, currencySymbol, t, state } = this.context;
      const goal = (state && state.goal) || {};
      const pct = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
      this._pct = pct;

      const badge = this.config.showPercentage
        ? `<b style="color:${this.secondary};font-weight:700;">[${pct}%]</b>`
        : "";

      this.contentEl.innerHTML =
        `<span style="color:${this.textColor};font-family:${FONT_DISPLAY};font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(goal.title || t("preview.goalTitle"))}</span>` +
        `<span style="color:${this.mutedColor};font-family:${FONT_MONO};font-size:12px;white-space:nowrap;">${formatMoney(goal.current)} / ${formatMoney(goal.target)} ${escapeHtml(currencySymbol(goal.currency))} ${badge}</span>`;
    }

    render() {
      if (this.theme !== "sf") return;
      this._drawBar();
    }

    _drawBar() {
      const ctx = this.ctx;
      if (!ctx || !this.canvas) return;

      const cw = this.canvas.clientWidth || 320;
      const ch = this.canvas.clientHeight || 22;
      const dpr = window.devicePixelRatio || 1;

      const bw = Math.max(1, Math.round(cw * dpr));
      const bh = Math.max(1, Math.round(ch * dpr));
      if (this.canvas.width !== bw || this.canvas.height !== bh) {
        this.canvas.width = bw;
        this.canvas.height = bh;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      // Плавно догоняем новый процент: обновление цели приходит в эфире и
      // скачок заливки читается как глитч.
      this._displayPct += (this._pct - this._displayPct) * 0.12;
      if (Math.abs(this._pct - this._displayPct) < 0.05) this._displayPct = this._pct;
      const pct = clamp(this._displayPct, 0, 100);

      const gap = Math.max(1, cw * 0.008);
      const cellW = Math.max(1, (cw - gap * (CELLS - 1)) / CELLS);
      const cellPct = 100 / CELLS;

      for (let i = 0; i < CELLS; i++) {
        const x = i * (cellW + gap);
        const redline = i >= REDLINE_CELL;
        const fill = clamp((pct - i * cellPct) / cellPct, 0, 1);

        // Дорожка: в зоне отсечки она тонирована золотом, чтобы граница
        // читалась до заполнения.
        ctx.fillStyle = redline ? rgba(this.secondary, 0.16) : rgba(this.mutedColor, 0.1);
        ctx.fillRect(x, 0, cellW, ch);

        if (fill <= 0) continue;

        const color = redline
          ? this.secondary
          : mixColor(this.primary, this.tertiary, Math.min(1, i / (REDLINE_CELL - 1)));
        const fillW = Math.max(1, cellW * fill);
        ctx.fillStyle = color;
        ctx.shadowColor = redline ? rgba(this.secondary, 0.55) : rgba(this.primary, 0.55);
        ctx.shadowBlur = i === Math.floor(pct / cellPct) ? 10 : 0;
        ctx.fillRect(x, 0, fillW, ch);
        ctx.shadowBlur = 0;

        // Голова заливки — белая риска с ореолом: на светлой игре иначе
        // непонятно, где именно кончился сбор.
        if (fill > 0 && fill < 1) {
          ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
          ctx.fillRect(x + fillW - 1.5, 1, 1.5, ch - 2);
        }
      }

      // Верхняя кромка — тонкий хром темы.
      ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
      ctx.fillRect(0, 0, cw, 1);
    }
  }

  return WidgetSfGoal;
});
