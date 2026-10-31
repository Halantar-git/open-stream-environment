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
  WidgetSfHoloAlert — всплывающий алерт на приборной панели Super Four.

  Слева — мини-тахометр с красной отсечкой: стрелка стоит по весу события
  (донат доходит до красной зоны), в центре прибора — значок события. Справа
  моноширинная строка «DASH // <ТИП>», имя зрителя в Rajdhani, сумма в золоте
  Showa и сообщение доната.

  Алерты приходят по шине и играются по одному; панель невидима до первого
  события, чтобы ничего не висело в эфире зря. Тема изолирована жёстко.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetSfHoloAlert = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetSfHoloAlert;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetSfHoloAlert = WidgetSfHoloAlert;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_PRIMARY = "#7b2cbf"; // --md-primary
  const DEFAULT_SECONDARY = "#ffb700"; // --md-secondary, золото Showa
  const DEFAULT_TERTIARY = "#00f5d4"; // --md-tertiary, бирюза Candy Flash
  const DEFAULT_REDLINE = "#ff3b30"; // --sf-redline, зона отсечки
  const DEFAULT_TEXT = "#ffffff"; // --md-on-surface
  const DEFAULT_MUTED = "#9a8c98"; // --md-on-surface-variant
  const DEFAULT_GLOW = "#9d4edd"; // --sf-glow

  const FONT_HEADING = "'Orbitron', 'Rajdhani', 'Segoe UI', sans-serif";
  const FONT_BODY = "'Manrope', 'Segoe UI', sans-serif";
  const FONT_MONO = "'JetBrains Mono', 'Consolas', monospace";

  // Обороты на мини-приборе: событие весомее — стрелка выше.
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

  const MAX_RPM = 14;
  const REDLINE_RPM = 11.5;
  const START_ANGLE = Math.PI * 0.75;
  const SWEEP = Math.PI * 1.5;
  const GAUGE_RADIUS = 16;
  const GAUGE_CENTER = 24;

  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

  function angleFor(rpm) {
    return START_ANGLE + (SWEEP * clamp(rpm, 0, MAX_RPM)) / MAX_RPM;
  }

  // Точка на окружности для SVG: ось Y вниз, как у canvas.
  function pointAt(rpm, radius) {
    const angle = angleFor(rpm);
    return {
      x: GAUGE_CENTER + Math.cos(angle) * radius,
      y: GAUGE_CENTER + Math.sin(angle) * radius,
    };
  }

  function arcPath(fromRpm, toRpm, radius) {
    const from = pointAt(fromRpm, radius);
    const to = pointAt(toRpm, radius);
    const large = SWEEP * ((toRpm - fromRpm) / MAX_RPM) > Math.PI ? 1 : 0;
    return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
  }

  class WidgetSfHoloAlert extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.primary = DEFAULT_PRIMARY;
      this.secondary = DEFAULT_SECONDARY;
      this.tertiary = DEFAULT_TERTIARY;
      this.redlineColor = DEFAULT_REDLINE;
      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;
      this.glowColor = DEFAULT_GLOW;

      this.host = null;
      this.queue = [];
      this.playing = false;
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не строим DOM и не подписываемся.
      if (this.theme !== "sf") return;

      this._readColors();
      this.element.classList.add("sf-surface");
      this._applySurface();
      // Скрыт до первого алерта — панель не должна висеть на экране.
      this.element.style.opacity = "0";

      this.host = document.createElement("div");
      this.host.className = "sf-holo-host";
      Object.assign(this.host.style, {
        position: "absolute",
        inset: "0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      });
      this.element.appendChild(this.host);

      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this.queueAlert(alert));
    }

    onUnmount() {
      this.queue = [];
      this.playing = false;
      if (this.element) this.element.innerHTML = "";
      this.host = null;
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.primary = (read && read("--md-primary")) || DEFAULT_PRIMARY;
      this.secondary = (read && read("--md-secondary")) || DEFAULT_SECONDARY;
      this.tertiary = (read && read("--md-tertiary")) || DEFAULT_TERTIARY;
      this.redlineColor = (read && read("--sf-redline")) || (read && read("--md-error")) || DEFAULT_REDLINE;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
      this.glowColor = (read && read("--sf-glow")) || this.primary;
    }

    // Поверхность из токенов темы: одна панель на цель, чат и алерт.
    _applySurface() {
      const read = this.context.readCssVar;
      const style = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(34, 22, 62, 0.92)";
      const blur = (read && read("--panel-blur")) || "12px";
      const border = (read && read("--panel-border")) || "2px solid rgba(123, 44, 191, 0.55)";
      const radius = (read && read("--panel-radius")) || "6px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev = (read && read("--elev-1")) || "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow = (read && read("--panel-glow")) || "0 0 12px rgba(157, 78, 221, 0.5)";

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

    // ---- очередь ----

    queueAlert(alert) {
      if (!alert) return;
      this.queue.push(alert);
      if (!this.playing) this.drain();
    }

    drain() {
      const alert = this.queue.shift();
      if (!alert) {
        this.playing = false;
        this.element.style.opacity = "0";
        this.element.style.height = this.geometry.h + "%";
        return;
      }
      this.playing = true;

      const card = this.buildCard(alert);
      this.host.appendChild(card);
      this.element.style.opacity = "1";
      this._autoSize(card);

      if (card.animate) {
        card.animate(
          [
            { opacity: 0, transform: "translateX(-18px) rotate(-1.2deg)" },
            { opacity: 1, transform: "translateX(0) rotate(0deg)" },
          ],
          { duration: 240, easing: "cubic-bezier(0.2, 0.9, 0.2, 1.1)" }
        );
      }

      const holdMs = alert.durationMs || 5000;
      this.later(() => {
        if (card.animate) {
          card.animate(
            [
              { opacity: 1, transform: "translateX(0) rotate(0deg)" },
              { opacity: 0, transform: "translateX(14px) rotate(1deg)" },
            ],
            { duration: 200, easing: "ease-in", fill: "forwards" }
          );
        }
        this.later(() => {
          card.remove();
          this.drain();
        }, 200);
      }, holdMs);
    }

    // ---- содержимое ----

    kindLabel(alert) {
      const { t } = this.context;
      switch (alert.kind) {
        case "follow": return t("alert.follow");
        case "sub":
          return Number(alert.months) > 1
            ? t("alert.resubMonths", { months: alert.months })
            : t("alert.sub");
        case "gift_sub": return t("alert.giftSub", { count: alert.count || 1 });
        case "cheer": return t("alert.cheer");
        case "donation": return t("alert.donation");
        case "ai": return t("alert.ai");
        case "boosty_sub": return t("alert.boostySub");
        case "boosty_resub": return t("alert.boostyResub");
        case "wheel_start": return t("alert.wheelStart");
        case "wheel_winner": return t("alert.wheelWinner");
        case "reward": return t("alert.reward");
        default: return "";
      }
    }

    formatAmount(alert) {
      const { t, formatMoney, currencySymbol } = this.context;
      if (alert.kind === "cheer") return t("alert.cheerBits", { amount: alert.amount });
      if (alert.kind === "donation") return `${formatMoney(alert.amount)} ${currencySymbol(alert.currency || "RUB")}`;
      if (alert.kind === "boosty_sub" || alert.kind === "boosty_resub") {
        return alert.amount ? `${formatMoney(alert.amount)} ${currencySymbol(alert.currency || "RUB")}` : "";
      }
      return "";
    }

    buildCard(alert) {
      const { t, ICONS, escapeHtml } = this.context;

      const showAmount =
        alert.kind === "donation" ||
        alert.kind === "cheer" ||
        ((alert.kind === "boosty_sub" || alert.kind === "boosty_resub") && Number(alert.amount) > 0);

      let icon = ICONS[alert.kind] || "";
      if (alert.kind === "wheel_start") icon = "🎉";

      let nameHtml = escapeHtml(alert.user || "");
      let messageHtml = "";
      let musicHtml = "";

      if (alert.kind === "wheel_start") {
        nameHtml = escapeHtml(t("alert.wheelStartMessage", { command: alert.command || "" }));
      } else if (alert.kind === "wheel_winner") {
        const name = escapeHtml(alert.user || "");
        if (alert.isElimination) nameHtml = t("alert.eliminated", { name });
        else if (alert.isFinalWinner) nameHtml = t("alert.finalWinner", { name });
        else nameHtml = t("alert.winner", { name });
      } else if (alert.kind === "ai" || alert.kind === "donation" || alert.kind === "cheer") {
        if (alert.message) {
          messageHtml = `<span style="font-family:${FONT_BODY};color:${this.mutedColor};font-size:12px;line-height:1.35;overflow-wrap:anywhere;word-break:break-word;">«${escapeHtml(alert.message)}»</span>`;
        }
        if (alert.musicTitle) {
          musicHtml = `<span style="font-family:${FONT_BODY};color:${this.mutedColor};font-size:12px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">♪ ${escapeHtml(alert.musicTitle)}</span>`;
        }
      }

      const card = document.createElement("div");
      card.className = "sf-holo";
      Object.assign(card.style, {
        display: "flex",
        alignItems: "center",
        gap: "13px",
        maxWidth: "92%",
        padding: "10px 15px",
        boxSizing: "border-box",
      });

      card.innerHTML = `
        <div class="sf-holo__gauge" style="position:relative;width:48px;height:48px;flex-shrink:0;">
          ${this._gaugeSvg(alert)}
          <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:${this.textColor};">
            <span style="width:15px;height:15px;display:inline-flex;">${icon}</span>
          </span>
        </div>
        <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
          <span style="font-family:${FONT_MONO};color:${this.tertiary};font-size:10px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;">DASH // ${escapeHtml(this.kindLabel(alert))}</span>
          <span style="font-family:${FONT_HEADING};color:${this.textColor};font-size:15px;font-weight:700;letter-spacing:0.04em;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 0 10px ${this.glowColor};">${nameHtml}</span>
          ${showAmount ? `<span style="font-family:${FONT_MONO};color:${this.secondary};font-size:13px;font-weight:700;text-shadow:0 0 10px ${this.secondary};">${escapeHtml(this.formatAmount(alert))}</span>` : ""}
          ${musicHtml}
          ${messageHtml}
        </div>`;

      return card;
    }

    // Мини-тахометр: дорожка 0–14, красная отсечка, стрелка по весу события.
    // Рисуется SVG, поэтому остаётся чётким на любом размере виджета.
    _gaugeSvg(alert) {
      const rpm = REV_BY_KIND[alert.kind] || 7.5;
      const needle = pointAt(rpm, GAUGE_RADIUS - 3);
      const tail = pointAt(rpm, -3);
      return `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" style="display:block;overflow:visible;">
        <circle cx="24" cy="24" r="19" fill="rgba(34,22,62,0.9)" stroke="${this.primary}" stroke-opacity="0.55" stroke-width="1.2"/>
        <path d="${arcPath(0, MAX_RPM, GAUGE_RADIUS)}" fill="none" stroke="${this.mutedColor}" stroke-opacity="0.28" stroke-width="1.2"/>
        <path d="${arcPath(REDLINE_RPM, MAX_RPM, GAUGE_RADIUS)}" fill="none" stroke="${this.redlineColor}" stroke-width="2" stroke-linecap="round"/>
        <line x1="${tail.x.toFixed(2)}" y1="${tail.y.toFixed(2)}" x2="${needle.x.toFixed(2)}" y2="${needle.y.toFixed(2)}" stroke="${rpm >= REDLINE_RPM ? this.redlineColor : this.textColor}" stroke-width="1.4" stroke-linecap="round"/>
        <circle cx="24" cy="24" r="2" fill="${this.primary}"/>
        <circle cx="24" cy="24" r="1" fill="${this.tertiary}"/>
      </svg>`;
    }

    // Панель растягивается под длинный текст доната, но не выходит за
    // разумный предел — иначе карточка закрыла бы пол-экрана.
    _autoSize(card) {
      if (!this.element) return;
      this.element.style.height = this.geometry.h + "%";
      const base = this.element.clientHeight || 100;
      const needed = (card ? card.offsetHeight : 0) + 20;
      const cap = Math.max(360, base);
      this.element.style.height = Math.min(Math.max(base, needed), cap) + "px";
    }
  }

  return WidgetSfHoloAlert;
});
