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
  WidgetSfTachometer — аналоговый тахометр темы Super Four.

  Тема названа по Honda CB400SF, поэтому вывеска — не логотип, а сам прибор:
  круглый тахометр с оцифровкой до 14 тысяч, красной зоной отсечки и окном
  передачи. В покое стрелка «держит холостые» и еле заметно дрожит, как живой двигатель; обороты отражают активность чата —
  каждое сообщение поднимает уровень, пауза плавно его сбрасывает, — а на
  алерте стрелка уходит в свою зону: чем весомее событие, тем выше обороты,
  донат доходит до отсечки. Это делает виджет живым даже между событиями,
  в отличие от вывесок Retrowave/Pixel/Wardogs, которые появляются только
  на алерте.

  Так как цикл не останавливается, в покое он идёт на AMBIENT_FPS (20 кадров
  хватает для спокойной стрелки), а на алерте на время раскрутки — на 30.

  Тема изолирована жёстко: на чужой теме не создаётся ни цикл, ни подписки.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetSfTachometer = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetSfTachometer;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetSfTachometer = WidgetSfTachometer;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  // Запасные цвета повторяют токены Super Four из shared/themes.js: живые
  // значения читаются из CSS, чтобы своя тема с этим набором не потеряла палитру.
  const DEFAULT_PRIMARY = "#7b2cbf";
  const DEFAULT_REDLINE = "#ff3b30";
  const DEFAULT_TEXT = "#ffffff";
  const DEFAULT_MUTED = "#9a8c98";
  const DEFAULT_DIAL = "rgba(34, 22, 62, 0.9)";
  const DEFAULT_GLOW = "#9d4edd";
  const DEFAULT_PINK = "#ff007f";

  const FONT_MONO = "'JetBrains Mono', 'Consolas', monospace";

  // Шкала: 0…14 ×1000 об/мин, отсечка с 11.5 — как у четырёхцилиндрового CB400.
  const MAX_RPM = 14;
  const REDLINE_RPM = 11.5;
  const IDLE_RPM = 1.2;

  // Дуга 270° с разрывом снизу: там живут надпись и окно передачи.
  const START_ANGLE = Math.PI * 0.75;
  const SWEEP = Math.PI * 1.5;

  // Передачи от активности чата: один разговор — первая, плотный поток —
  // шестая. Шаги совпадают с CHAT_GAIN (0.18 за сообщение), чтобы передача
  // менялась примерно на каждой реплике подряд.
  const CHAT_GEAR_STEPS = [0.1, 0.28, 0.46, 0.64, 0.82, 0.95];

  const ALERT_MS = 5000;
  const CALM_DELAY_MS = 900;

  // Отклик на чат: уровень активности, а не разовый подгаз. Каждое сообщение
  // добавляет порцию, пауза гасит её по экспоненте — получается «двигатель
  // слышит разговор»: один зритель даёт лёгкий подъём, плотный поток держит
  // стрелку высоко. Потолок ниже отсечки, чтобы донат всё равно был заметен.
  const CHAT_GAIN = 0.18;
  const CHAT_DECAY_MS = 2600;
  const CHAT_RPM_MIN = 1.5;
  const CHAT_RPM_MAX = 10.6;
  const CHAT_CURVE = 0.7;
  const CHAT_FLOOR = 0.005;

  // Обороты под событие: донат выкручивает стрелку до отсечки, фоллоу — только
  // до середины. Передача в окне растёт вместе с весом события.
  const REV_BY_KIND = {
    donation: 13.6,
    cheer: 12.4,
    gift_sub: 10.4,
    sub: 9.4,
    boosty_sub: 9.4,
    boosty_resub: 10.0,
    follow: 6.4,
    reward: 7.4,
    wheel_start: 5.2,
    wheel_winner: 5.8,
  };
  const GEAR_BY_KIND = {
    donation: "6",
    cheer: "5",
    gift_sub: "5",
    sub: "4",
    boosty_sub: "4",
    boosty_resub: "4",
    follow: "2",
    reward: "3",
    wheel_start: "1",
    wheel_winner: "1",
  };

  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

  // Угол для оборотов. Держим отдельной функцией: по ней же считаются метки,
  // подписи и стрелка, поэтому шкала не может разъехаться.
  function angleFor(rpm) {
    return START_ANGLE + (SWEEP * clamp(rpm, 0, MAX_RPM)) / MAX_RPM;
  }

  // `#rrggbb` + прозрачность — для ореолов и приглушённых меток.
  function rgba(hex, alpha) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!match) return `rgba(123, 44, 191, ${alpha})`;
    const n = parseInt(match[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  class WidgetSfTachometer extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.primary = DEFAULT_PRIMARY;
      this.redlineColor = DEFAULT_REDLINE;
      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;
      this.dialColor = DEFAULT_DIAL;
      this.glowColor = DEFAULT_GLOW;
      this.pinkColor = DEFAULT_PINK;

      this._displayRpm = IDLE_RPM;
      this._alertRpm = 0;
      this._revUntil = 0;
      this._chatActivity = 0;
      this._lastRenderAt = 0;
      this._gear = "N";
      this._alertGear = null;
      this._revToken = 0;
      this._highFps = false;
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не тратим ни canvas, ни подписки.
      if (this.theme !== "sf") return;

      this._readColors();
      this._applyPerspective();
      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this._rev(alert));
      this.subscribe(this.context.EVENT_TYPES.CHAT_MESSAGE, () => this._blip());
      this.startRenderLoop(BaseWidget.AMBIENT_FPS);
    }

    onUnmount() {
      this._highFps = false;
      this._revToken += 1;
      this._gear = "N";
      this._alertGear = null;
      this._alertRpm = 0;
      this._revUntil = 0;
      this._chatActivity = 0;
      this._lastRenderAt = 0;
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective) this._applyPerspective();
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.primary = (read && read("--md-primary")) || DEFAULT_PRIMARY;
      // Зона отсечки — красная, как на приборке: свой токен, иначе берём
      // error (в своих темах он тоже красный) и только потом запасной цвет.
      this.redlineColor = (read && read("--sf-redline")) || (read && read("--md-error")) || DEFAULT_REDLINE;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
      this.dialColor = (read && read("--panel-bg")) || DEFAULT_DIAL;
      // Свечение и розовая полоса Candy Flash — свои токены: в Material-роли они
      // не влезают, а для своей темы достаточно откатиться на primary.
      this.glowColor = (read && read("--sf-glow")) || this.primary;
      this.pinkColor = (read && read("--sf-candy-pink")) || this.primary;
    }

    _applyPerspective() {
      const value = clamp(Number(this.config.perspective) || 0, 0, 100);
      if (value > 0) {
        const magnitude = value * 0.15;
        let ry = -magnitude;
        let rx = magnitude * 0.03;
        const direction = this.config.perspectiveDirection || "left";
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

    // Переключение частоты кадра без пересоздания цикла: 30 на раскрутке,
    // 20 в покое. Иначе спокойная стрелка круглосуточно жгла бы кадры.
    _switchFps(fps) {
      const high = fps > BaseWidget.AMBIENT_FPS;
      if (this._highFps === high && this._fps === fps) return;
      this._highFps = high;
      this.stopRenderLoop();
      this.startRenderLoop(fps);
    }

    _rev(alert) {
      if (!alert) return;
      const duration = Number(alert.durationMs) || ALERT_MS;
      this._alertRpm = REV_BY_KIND[alert.kind] || 7.5;
      this._alertGear = GEAR_BY_KIND[alert.kind] || "4";
      this._gear = this._alertGear;
      this._revUntil = performance.now() + duration;
      this._switchFps(30);

      // Своя метка на каждый алерт: поздний таймер прошлого события не должен
      // гасить раскрутку следующего.
      const token = ++this._revToken;
      this.later(() => {
        if (token !== this._revToken) return;
        this._endRev();
      }, duration + CALM_DELAY_MS);
    }

    // Чат не переключает кадры и не трогает передачу: он только поднимает
    // уровень активности, с которого считается устойчивое положение стрелки.
    _blip() {
      this._chatActivity = clamp(this._chatActivity + CHAT_GAIN, 0, 1);
    }

    // Уровень активности гаснет по времени, а не по числу кадров: при 20 и 30
    // FPS стрелка должна возвращаться к холостым с одинаковой скоростью.
    _chatRpm(now) {
      const delta = Math.max(0, now - this._lastRenderAt);
      this._lastRenderAt = now;
      if (delta > 0) this._chatActivity *= Math.exp(-delta / CHAT_DECAY_MS);
      if (this._chatActivity <= CHAT_FLOOR) return 0;
      const level = Math.pow(clamp(this._chatActivity, 0, 1), CHAT_CURVE);
      return CHAT_RPM_MIN + (CHAT_RPM_MAX - CHAT_RPM_MIN) * level;
    }

    _endRev() {
      this._alertGear = null;
      this._gear = this._gearForActivity();
      this._alertRpm = 0;
      this._revUntil = 0;
      this._switchFps(BaseWidget.AMBIENT_FPS);
    }

    // Передача по уровню активности: N в тишине, 1–6 по растущему потоку.
    _gearForActivity() {
      if (this._chatActivity <= CHAT_FLOOR) return "N";
      let gear = 1;
      for (let i = 0; i < CHAT_GEAR_STEPS.length; i++) {
        if (this._chatActivity >= CHAT_GEAR_STEPS[i]) gear = i + 1;
      }
      return String(gear);
    }

    render() {
      if (this.theme !== "sf") return;
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
      const seconds = now / 1000;

      // Холостые: медленная волна плюс быстрая дрожь — стрелка не замирает
      // в одном пикселе, но и не отвлекает от эфира.
      const idle = IDLE_RPM + Math.sin(seconds * 2.1) * 0.06 + Math.sin(seconds * 5.7) * 0.035;
      // Алерт важнее чата: пока идёт событие, разговор не сбивает
      // раскрутку. В остальное время стрелка стоит по активности чата.
      const alertRpm = now < this._revUntil ? this._alertRpm : 0;
      const chatRpm = this._chatRpm(now);
      const target = Math.max(idle, alertRpm, chatRpm);
      // Окно передачи: на алерте — передача события, иначе — по активности
      // чата. Оба значения могут меняться каждый кадр, поэтому считаем здесь,
      // а не в момент прихода события.
      this._gear = now < this._revUntil ? this._alertGear || this._gearForActivity() : this._gearForActivity();
      const rate = target > this._displayRpm ? 0.18 : 0.09;
      this._displayRpm += (target - this._displayRpm) * rate;
      if (Math.abs(target - this._displayRpm) < 0.01) this._displayRpm = target;
      const rpm = clamp(this._displayRpm, 0, MAX_RPM);

      const cx = cw / 2;
      const cy = ch / 2;
      const radius = Math.min(cw, ch) * 0.42;

      this._drawDial(ctx, cx, cy, radius, rpm, seconds);
    }

    _drawDial(ctx, cx, cy, radius, rpm, seconds) {
      // Циферблат: тёмное стекло с фиолетовым ободком, чтобы прибор читался
      // поверх светлой игры, но не выглядел непрозрачной плашкой.
      ctx.save();
      const face = ctx.createRadialGradient(cx, cy - radius * 0.25, radius * 0.1, cx, cy, radius);
      face.addColorStop(0, rgba(this.primary, 0.16));
      face.addColorStop(0.55, this.dialColor);
      face.addColorStop(1, "rgba(13, 8, 25, 0.9)");
      ctx.fillStyle = face;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = rgba(this.primary, 0.55);
      ctx.lineWidth = Math.max(1.4, radius * 0.018);
      ctx.shadowColor = rgba(this.glowColor, 0.75);
      ctx.shadowBlur = radius * 0.16;
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = rgba(this.mutedColor, 0.22);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.87, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Метки: длинные через каждую тысячу, короткие через пятьсот.
      for (let i = 0; i <= MAX_RPM * 2; i++) {
        const value = i / 2;
        const angle = angleFor(value);
        const major = i % 2 === 0;
        const redline = value >= REDLINE_RPM;
        const inner = radius * (major ? 0.78 : 0.83);
        const outer = radius * 0.88;
        ctx.strokeStyle = redline ? rgba(this.redlineColor, 0.9) : rgba(this.textColor, major ? 0.72 : 0.38);
        ctx.lineWidth = major ? Math.max(1.3, radius * 0.014) : 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
        ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
        ctx.stroke();

        if (major) {
          const labelR = radius * 0.62;
          ctx.save();
          ctx.fillStyle = redline ? this.redlineColor : rgba(this.textColor, 0.78);
          ctx.font = `${Math.max(7, radius * 0.11)}px ${FONT_MONO}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(value), cx + Math.cos(angle) * labelR, cy + Math.sin(angle) * labelR);
          ctx.restore();
        }
      }

      // Красная зона отсечки. На высоких оборотах она пульсирует — это и есть
      // «шифт-ламп», а не отдельная лампочка поверх прибора.
      const pulse = rpm >= REDLINE_RPM ? 0.55 + 0.45 * Math.abs(Math.sin(seconds * 6)) : 0.55;
      ctx.save();
      ctx.strokeStyle = rgba(this.redlineColor, pulse);
      ctx.lineWidth = Math.max(2, radius * 0.035);
      ctx.lineCap = "round";
      ctx.shadowColor = this.redlineColor;
      ctx.shadowBlur = rpm >= REDLINE_RPM ? radius * 0.16 : 0;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.93, angleFor(REDLINE_RPM), angleFor(MAX_RPM));
      ctx.stroke();
      ctx.restore();

      // Стрелка: почти белая с фиолетовым ореолом, в отсечке — красная.
      const needleAngle = angleFor(rpm);
      const needleLength = radius * 0.72;
      const inRedline = rpm >= REDLINE_RPM;
      ctx.save();
      ctx.strokeStyle = inRedline ? this.redlineColor : this.textColor;
      ctx.lineWidth = Math.max(1.8, radius * 0.022);
      ctx.lineCap = "round";
      ctx.shadowColor = inRedline ? this.redlineColor : rgba(this.glowColor, 0.9);
      ctx.shadowBlur = radius * 0.12;
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(needleAngle) * radius * 0.08, cy - Math.sin(needleAngle) * radius * 0.08);
      ctx.lineTo(cx + Math.cos(needleAngle) * needleLength, cy + Math.sin(needleAngle) * needleLength);
      ctx.stroke();
      ctx.restore();

      // Ступица.
      ctx.save();
      ctx.fillStyle = this.primary;
      ctx.shadowColor = rgba(this.glowColor, 0.85);
      ctx.shadowBlur = radius * 0.1;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2, radius * 0.035), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Надпись и окно передачи в нижнем разрыве шкалы — как на приборке.
      ctx.save();
      ctx.fillStyle = rgba(this.mutedColor, 0.75);
      ctx.font = `${Math.max(6, radius * 0.085)}px ${FONT_MONO}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("CB400SF", cx, cy + radius * 0.44);
      ctx.restore();

      this._drawGear(ctx, cx, cy + radius * 0.57, radius);
    }

    _drawGear(ctx, x, y, radius) {
      const w = radius * 0.34;
      const h = radius * 0.26;
      const left = x - w / 2;
      const top = y - h / 2;

      ctx.save();
      ctx.fillStyle = "rgba(13, 8, 25, 0.92)";
      ctx.strokeStyle = rgba(this.primary, 0.6);
      ctx.lineWidth = Math.max(1, radius * 0.012);
      ctx.fillRect(left, top, w, h);
      ctx.strokeRect(left, top, w, h);
      // Кромка окна: розовая полоска Candy Flash, как язычок индикатора.
      ctx.fillStyle = rgba(this.pinkColor, 0.9);
      ctx.fillRect(left, top, w, Math.max(1, radius * 0.014));
      ctx.fillStyle = this._gear === "N" ? this.mutedColor : this.textColor;
      ctx.font = `700 ${Math.max(8, radius * 0.17)}px ${FONT_MONO}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this._gear, x, y + radius * 0.012);
      ctx.restore();
    }
  }

  return WidgetSfTachometer;
});
