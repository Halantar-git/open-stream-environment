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
  WidgetWin98Hourglass — песочные часы темы Windows 98.

  Знакомый курсор ожидания: две стеклянные колбы в серой объёмной оправе,
  синий песок (цвет заголовка окна) пересыпается сверху вниз. Песок идёт по
  длительности алерта, поэтому к концу карточки часам «нечего ждать». До первого
  события их не видно; алерты идут по одному, донат даёт короткий «поп».

  Стекло и оправа получают бевел из светлых и тёмных линий, а лёгкий наклон
  через transform даёт объём, не превращая знак в плоскую иконку. Тема
  изолирована жёстко: на чужой теме цикл не поднимается.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetWin98Hourglass = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetWin98Hourglass;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetWin98Hourglass = WidgetWin98Hourglass;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  // Запасные цвета повторяют палитру Windows 98; живые значения читаются из
  // токенов, чтобы своя тема с этим набором не потеряла серый корпус.
  const DEFAULT_WINDOW = "#c0c0c0";
  const DEFAULT_LIGHT = "#ffffff";
  const DEFAULT_SHADOW = "#808080";
  const DEFAULT_DARK = "#000000";
  const DEFAULT_SAND = "#000080";

  const ALERT_MS = 5000;
  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

  // Цвет с прозрачностью для линий и тени: принимаем только `#rrggbb`.
  function rgba(hex, alpha) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!match) return `rgba(192, 192, 192, ${alpha})`;
    const n = parseInt(match[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  class WidgetWin98Hourglass extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.windowColor = DEFAULT_WINDOW;
      this.lightColor = DEFAULT_LIGHT;
      this.shadowColor = DEFAULT_SHADOW;
      this.darkColor = DEFAULT_DARK;
      this.sandColor = DEFAULT_SAND;

      this._queue = [];
      this._visibleUntil = 0;
      this._startedAt = 0;
      this._duration = ALERT_MS;
      this._popUntil = 0;
      this._popAmp = 0;
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не тратим ни canvas, ни подписки.
      if (this.theme !== "win98") return;

      this._readColors();
      this._applyPerspective();
      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this._queueAlert(alert));
      // Скрыт до первого алерта, как и остальные вывески.
      this._setVisible(false);
      this.startRenderLoop(30);
    }

    onUnmount() {
      this._queue = [];
      this._visibleUntil = 0;
      this._startedAt = 0;
      this._popUntil = 0;
      this._popAmp = 0;
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective) this._applyPerspective();
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.windowColor = (read && read("--win98-window")) || DEFAULT_WINDOW;
      this.lightColor = (read && read("--win98-light")) || DEFAULT_LIGHT;
      this.shadowColor = (read && read("--win98-shadow")) || DEFAULT_SHADOW;
      this.darkColor = (read && read("--win98-shadow-dark")) || DEFAULT_DARK;
      this.sandColor = (read && read("--md-primary")) || DEFAULT_SAND;
    }

    _applyPerspective() {
      const value = Math.max(0, Math.min(100, Number(this.config.perspective) || 0));
      if (value > 0) {
        const ry = -(value * 0.15);
        const rx = value * 0.03;
        this._setTilt(`perspective(1200px) rotateY(${ry}deg) rotateX(${rx}deg)`);
      } else {
        this._setTilt("");
      }
    }

    // ---- очередь алертов ----

    _queueAlert(alert) {
      if (!alert) return;
      this._queue.push(alert);
      if (performance.now() >= this._visibleUntil) this._drain();
    }

    _drain() {
      const alert = this._queue.shift();
      if (!alert) {
        this._visibleUntil = 0;
        this._setVisible(false);
        return;
      }
      const duration = alert.durationMs || ALERT_MS;
      this._duration = duration;
      this._startedAt = performance.now();
      this._visibleUntil = this._startedAt + duration;
      this._setVisible(true);
      this._pop(alert.kind);
      this.later(() => this._drain(), duration);
    }

    _setVisible(visible) {
      if (this.element) this.element.style.opacity = visible ? "1" : "0";
      this.setIdle(!visible);
    }

    _pop(kind) {
      this._popUntil = performance.now() + 450;
      this._popAmp = kind === "donation" ? 0.16 : 0.08;
    }

    // ---- отрисовка ----

    render() {
      if (this.theme !== "win98") return;
      const ctx = this.ctx;
      const canvas = this.canvas;
      if (!ctx || !canvas) return;

      const cw = canvas.clientWidth || 320;
      const ch = canvas.clientHeight || 200;
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.max(1, Math.round(cw * dpr));
      const bh = Math.max(1, Math.round(ch * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      const now = performance.now();
      const t = now / 1000;
      const progress = clamp(
        this._duration > 0 ? (now - this._startedAt) / this._duration : 0,
        0,
        1
      );

      let scale = 1 + 0.02 * Math.sin(t * 1.8);
      if (now < this._popUntil) {
        const k = 1 - (this._popUntil - now) / 450;
        scale += this._popAmp * Math.sin(Math.PI * k);
      }
      scale = clamp(scale, 0.85, 1.25);

      const cx = cw / 2 + Math.sin(t * 0.7) * 2;
      const cy = ch / 2 + Math.cos(t * 0.9) * 2;
      const height = Math.min(ch * 0.78, cw * 0.92) * scale;
      const width = height * 0.56;
      const capH = Math.max(3, height * 0.075);
      const topY = cy - height / 2;
      const bottomY = cy + height / 2;
      const neckY = cy;
      const neckW = width * 0.12;

      ctx.save();
      // Лёгкий наклон: объём без настоящей 3D-матрицы.
      ctx.transform(1, 0, -0.06, 1, 0.03 * height, 0);

      // Тень под прибором, чтобы он читался поверх светлой игры.
      ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
      ctx.fillRect(cx - width * 0.58 + 4, topY + 5, width * 1.16, height);

      this._drawCaps(ctx, cx, topY, bottomY, width, capH);

      // Стекло: две колбы, встречающиеся в горле.
      const glass = () => {
        ctx.beginPath();
        ctx.moveTo(cx - width / 2, topY + capH);
        ctx.lineTo(cx - neckW, neckY - height * 0.035);
        ctx.lineTo(cx - neckW, neckY + height * 0.035);
        ctx.lineTo(cx - width / 2, bottomY - capH);
        ctx.lineTo(cx + width / 2, bottomY - capH);
        ctx.lineTo(cx + neckW, neckY + height * 0.035);
        ctx.lineTo(cx + neckW, neckY - height * 0.035);
        ctx.lineTo(cx + width / 2, topY + capH);
        ctx.closePath();
      };

      ctx.save();
      glass();
      ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
      ctx.fill();
      ctx.strokeStyle = this.lightColor;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.strokeStyle = rgba(this.darkColor, 0.55);
      ctx.lineWidth = 0.7;
      ctx.stroke();
      ctx.restore();

      // Песок в верхней колбе: уровень уходит вниз по прогрессу.
      const neckTop = neckY - height * 0.035;
      const upperTop = topY + capH;
      const upperLevel = neckTop - (neckTop - upperTop) * progress;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx - width / 2, topY + capH);
      ctx.lineTo(cx + width / 2, topY + capH);
      ctx.lineTo(cx + neckW, neckTop);
      ctx.lineTo(cx - neckW, neckTop);
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = this.sandColor;
      ctx.fillRect(cx - width, upperTop, width * 2, Math.max(0, upperLevel - upperTop));
      ctx.restore();

      // Песок в нижней колбе: горка растёт от дна к горлу.
      const neckBottom = neckY + height * 0.035;
      const lowerBottom = bottomY - capH;
      const lowerTop = neckBottom + (lowerBottom - neckBottom) * progress;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx - width / 2, lowerBottom);
      ctx.lineTo(cx + width / 2, lowerBottom);
      ctx.lineTo(cx + neckW, neckBottom);
      ctx.lineTo(cx - neckW, neckBottom);
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = this.sandColor;
      ctx.fillRect(cx - width, lowerTop, width * 2, Math.max(0, lowerBottom - lowerTop));
      ctx.restore();

      // Струйка между колбами, пока песок идёт.
      if (progress > 0.01 && progress < 0.99) {
        ctx.save();
        ctx.strokeStyle = this.sandColor;
        ctx.lineWidth = Math.max(1, width * 0.03);
        ctx.beginPath();
        ctx.moveTo(cx, neckTop);
        ctx.lineTo(cx, lowerTop);
        ctx.stroke();
        ctx.restore();
      }

      // Блик на стекле — тонкая светлая линия слева.
      ctx.save();
      ctx.strokeStyle = rgba(this.lightColor, 0.75);
      ctx.lineWidth = Math.max(1, width * 0.02);
      ctx.beginPath();
      ctx.moveTo(cx - width * 0.38, topY + capH * 1.3);
      ctx.lineTo(cx - width * 0.22, topY + height * 0.34);
      ctx.stroke();
      ctx.restore();

      ctx.restore();
    }

    // Верхняя и нижняя крышки: серый корпус с белым верхом/левым и тёмным
    // низом/правым краем, как у кнопок 98-й.
    _drawCaps(ctx, cx, topY, bottomY, width, capH) {
      const capW = width * 1.14;
      [topY, bottomY - capH].forEach((y) => {
        ctx.save();
        ctx.fillStyle = this.windowColor;
        ctx.fillRect(cx - capW / 2, y, capW, capH);
        ctx.fillStyle = this.lightColor;
        ctx.fillRect(cx - capW / 2, y, capW, 1);
        ctx.fillRect(cx - capW / 2, y, 1, capH);
        ctx.fillStyle = this.shadowColor;
        ctx.fillRect(cx - capW / 2, y + capH - 1, capW, 1);
        ctx.fillRect(cx + capW / 2 - 1, y, 1, capH);
        ctx.strokeStyle = this.darkColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(cx - capW / 2 + 0.5, y + 0.5, capW - 1, capH - 1);
        ctx.restore();
      });
    }
  }

  return WidgetWin98Hourglass;
});
