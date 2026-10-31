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
  WidgetPixelHoloAlert — pixel alert for the Pixel Perfect theme.

  A DOM-based flat alert card with a square badge whose border ticks with a
  stepped rotation (Web Animations), a kind label, username, amount and message.
  Alerts are queued and drained one at a time.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const AlertTyping =
    typeof module !== "undefined" && module.exports
      ? require("./alert-typing")
      : root.OSEWidgets && root.OSEWidgets.AlertTyping;
  const WidgetPixelHoloAlert = factory(BaseWidget, AlertTyping);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetPixelHoloAlert;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetPixelHoloAlert = WidgetPixelHoloAlert;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget, AlertTyping) {
  "use strict";

  const DEFAULT_GOLD = "#d6b675";
  const DEFAULT_TEXT = "#e6e6e6";
  const DEFAULT_MUTED = "#b8b8b8";
  const FONT = "'PT Sans Caption', 'Segoe UI', sans-serif";
  const FONT_DATA = "'PT Sans Caption', 'Segoe UI', sans-serif";

  class WidgetPixelHoloAlert extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.gold = DEFAULT_GOLD;
      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;

      this.host = null;
      this.queue = [];
      this.playing = false;
    }

    onMount() {
      if (this.theme !== "pixel") return;

      this._readColors();
      this.element.classList.add("pixel-holo-surface");
      this._applySurface();
      // Hidden until the first alert — the panel must not linger on screen.
      this.element.style.opacity = "0";

      this.host = document.createElement("div");
      this.host.className = "pixel-holo-host";
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
      if (this._typing) {
        this._typing.stop();
        this._typing = null;
      }
      if (this.element) this.element.innerHTML = "";
      this.host = null;
    }

    onUpdate() {
      // `syncLayout` присылает новый снимок на каждое событие, и BaseWidget
      // заново ставит процентную высоту. Возвращаем замеренную под текст,
      // иначе панель сжималась бы и снова резала длинное сообщение.
      if (this.element && this._cardHeight > 0) {
        this.element.style.height = this._cardHeight + "px";
      }
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.gold = (read && read("--md-primary")) || DEFAULT_GOLD;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
    }

    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(16, 16, 18, 0.95)";
      const border = (read && read("--panel-border")) || "1px solid rgba(138, 138, 141, 0.35)";
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const glow = (read && read("--panel-glow")) || "0 0 0 1px rgba(214, 182, 117, 0.15)";

      s.backgroundColor = bg;
      s.backgroundImage = "";
      s.backdropFilter = "none";
      s.webkitBackdropFilter = "none";
      s.border = border;
      s.borderRadius = radius;
      s.clipPath = clip;
      s.boxShadow = glow;
    }

    queueAlert(alert) {
      if (!alert) return;
      this.queue.push(alert);
      if (!this.playing) this.drain();
    }

    drain() {
      const alert = this.queue.shift();
      if (!alert) {
        this.playing = false;
        this._cardHeight = 0;
        if (this._typing) {
          this._typing.stop();
          this._typing = null;
        }
        this.element.style.opacity = "0";
        this.element.style.height = this.geometry.h + "%"; // reset to layout height while hidden
        return;
      }
      this.playing = true;

      const card = this.buildCard(alert);
      this.host.appendChild(card);
      this.element.style.opacity = "1";
      this._autoSize(card);
      this._typeText(card);

      const badge = card.querySelector(".pixel-holo__badge");
      if (badge && badge.animate) {
        badge.animate(
          [
            { transform: "rotate(0deg) scale(1)" },
            { transform: "rotate(90deg) scale(1.08)" },
            { transform: "rotate(180deg) scale(1)" },
            { transform: "rotate(270deg) scale(1.08)" },
            { transform: "rotate(360deg) scale(1)" },
          ],
          { duration: 3600, iterations: Infinity, easing: "steps(8, end)" }
        );
      }
      if (card.animate) {
        card.animate(
          [
            { opacity: 0, transform: "translateY(6px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 180, easing: "steps(3, end)" }
        );
      }

      const holdMs = alert.durationMs || 5000;
      this.later(() => {
        if (card.animate) {
          card.animate(
            [{ opacity: 1 }, { opacity: 0 }],
            { duration: 160, easing: "steps(3, end)", fill: "forwards" }
          );
        }
        this.later(() => {
          card.remove();
          this.drain();
        }, 160);
      }, holdMs);
    }

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
        icon = "";
        const name = escapeHtml(alert.user || "");
        if (alert.isElimination) nameHtml = t("alert.eliminated", { name });
        else if (alert.isFinalWinner) nameHtml = t("alert.finalWinner", { name });
        else nameHtml = t("alert.winner", { name });
      } else if (alert.kind === "ai" || alert.kind === "donation" || alert.kind === "cheer") {
        if (alert.message) messageHtml = `<div style="color:${this.mutedColor};font-size:13px;font-family:${FONT};">«${escapeHtml(alert.message)}»</div>`;
        if (alert.musicTitle) {
          musicHtml = `<div style="color:${this.mutedColor};font-size:12px;font-family:${FONT};font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">♪ ${escapeHtml(alert.musicTitle)}</div>`;
        }
      }

      const card = document.createElement("div");
      card.className = "pixel-holo";
      Object.assign(card.style, {
        display: "flex",
        alignItems: "center",
        gap: "12px",
        maxWidth: "90%",
        padding: "10px 16px",
        boxSizing: "border-box",
        fontFamily: FONT,
      });

      card.innerHTML = `
        <div class="pixel-holo__badge" style="width:34px;height:34px;flex-shrink:0;border:2px solid ${this.gold};display:flex;align-items:center;justify-content:center;color:${this.gold};box-sizing:border-box;">
          <span style="width:16px;height:16px;display:inline-flex;">${icon}</span>
        </div>
        <div style="min-width:0;">
          <div style="color:${this.mutedColor};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">${escapeHtml(this.kindLabel(alert))}</div>
          <div style="color:${this.textColor};font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${nameHtml}</div>
          ${showAmount ? `<div style="color:${this.gold};font-size:14px;font-weight:700;font-family:${FONT_DATA};">${escapeHtml(this.formatAmount(alert))}</div>` : ""}
          ${musicHtml}
          ${messageHtml}
        </div>`;

      return card;
    }

    // Печать текста карточки — как в теме Terminal: посимвольно, с кареткой.
    // Вызывается после замера: панель уже знает полную высоту сообщения.
    _typeText(root) {
      if (this._typing) this._typing.stop();
      this._typing = AlertTyping ? AlertTyping.typeAlertText(root) : null;
    }

    // Панель растёт под сообщение, но не бесконечно: длинный текст больше не
    // обрезается краем панели, а высота ограничена низом экрана.
    _autoSize(card) {
      if (!this.element || !card) return;
      this.element.style.height = this.geometry.h + "%";
      const base = this.element.clientHeight || 100;

      const needed = card.offsetHeight + 20;
      if (!needed) return;

      const viewport =
        typeof window !== "undefined" && Number(window.innerHeight) > 0
          ? Number(window.innerHeight)
          : 1080;
      const top = (Number(this.geometry.y) / 100) * viewport;
      const maxHeight = Math.max(base, viewport - top - 8);

      this.element.style.height = Math.min(Math.max(base, needed), maxHeight) + "px";

      // Замер недосчитывает пару пикселей (переносы, отступы): растим по факту.
      for (let attempt = 0; attempt < 3; attempt++) {
        const overflow = this.element.scrollHeight - this.element.clientHeight;
        if (!Number.isFinite(overflow) || overflow <= 0) break;
        const current = Number.parseFloat(this.element.style.height) || 0;
        const next = Math.min(current + overflow + 2, maxHeight);
        if (next <= current) break;
        this.element.style.height = next + "px";
      }

      this._cardHeight = Number.parseFloat(this.element.style.height) || 0;
    }
  }

  return WidgetPixelHoloAlert;
});
