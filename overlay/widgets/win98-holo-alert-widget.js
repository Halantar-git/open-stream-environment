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
  WidgetWin98HoloAlert — всплывающее окно события в стиле Windows 98.

  Каждое событие — отдельное маленькое окно: синий градиентный заголовок с
  названием события и серыми кнопками, ниже — значок в вдавленном квадрате,
  имя зрителя, сумма и сообщение доната. Очередь играет окна по одному,
  панель невидима до первого события.

  Алерты приходят по шине; тема изолирована жёстко, чтобы на чужой теме не
  поднимался ни DOM, ни подписки.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetWin98HoloAlert = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetWin98HoloAlert;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetWin98HoloAlert = WidgetWin98HoloAlert;
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
  const DEFAULT_ACCENT = "#006666";

  const FONT_TITLE = "var(--font-display, 'Pixelify Sans', 'Segoe UI', sans-serif)";
  const FONT_BODY = "var(--font-body, 'Pixelify Sans', 'Segoe UI', sans-serif)";
  const FONT_MONO = "var(--font-mono, 'VT323', 'Consolas', monospace)";

  class WidgetWin98HoloAlert extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;
      this.primaryColor = DEFAULT_PRIMARY;
      this.accentColor = DEFAULT_ACCENT;

      this.host = null;
      this.queue = [];
      this.playing = false;
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не строим DOM и не подписываемся.
      if (this.theme !== "win98") return;

      this._readColors();
      this.element.classList.add("win98-surface");
      this._applySurface();
      // Скрыт до первого алерта — окно не должно висеть на экране.
      this.element.style.opacity = "0";

      this.host = document.createElement("div");
      this.host.className = "win98-holo-host";
      Object.assign(this.host.style, {
        position: "absolute",
        left: "3px",
        right: "3px",
        top: "3px",
        bottom: "3px",
        display: "flex",
        alignItems: "stretch",
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
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
      this.primaryColor = (read && read("--md-primary")) || DEFAULT_PRIMARY;
      this.accentColor = (read && read("--md-secondary")) || DEFAULT_ACCENT;
    }

    // Корпус окна из токенов темы: мягкая тень 98-й не нужна, силуэт держит
    // жёсткий бевел.
    _applySurface() {
      const read = this.context.readCssVar;
      const style = this.element.style;

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
      style.boxShadow = glow;
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
            { opacity: 0, transform: "scale(0.97)" },
            { opacity: 1, transform: "scale(1)" },
          ],
          { duration: 160, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
        );
      }

      const holdMs = alert.durationMs || 5000;
      this.later(() => {
        if (card.animate) {
          card.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: 140,
            easing: "ease-in",
            fill: "forwards",
          });
        }
        this.later(() => {
          card.remove();
          this.drain();
        }, 140);
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
          messageHtml = `<span style="font-family:${FONT_BODY};color:${this.mutedColor};font-size:12px;line-height:1.3;overflow-wrap:anywhere;word-break:break-word;">«${escapeHtml(alert.message)}»</span>`;
        }
        if (alert.musicTitle) {
          musicHtml = `<span style="font-family:${FONT_BODY};color:${this.mutedColor};font-size:12px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">♪ ${escapeHtml(alert.musicTitle)}</span>`;
        }
      }

      const card = document.createElement("div");
      card.className = "win98-holo";
      Object.assign(card.style, {
        display: "flex",
        flexDirection: "column",
        width: "100%",
        minWidth: "0",
        boxSizing: "border-box",
      });

      card.innerHTML = `
        <div class="win98-window__titlebar">
          <span class="win98-window__title">${escapeHtml(this.kindLabel(alert))}</span>
          <span class="win98-window__buttons"><i class="win98-window__btn"></i><i class="win98-window__btn"></i></span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;padding:7px 9px;box-sizing:border-box;min-width:0;">
          <span class="win98-sunken" style="display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:36px;height:36px;padding:7px;box-sizing:border-box;color:${this.primaryColor};">
            <span style="display:inline-flex;width:100%;height:100%;">${icon}</span>
          </span>
          <span style="min-width:0;display:flex;flex-direction:column;gap:1px;">
            <span style="font-family:${FONT_TITLE};color:${this.textColor};font-size:15px;font-weight:700;line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${nameHtml}</span>
            ${showAmount ? `<span style="font-family:${FONT_MONO};color:${this.primaryColor};font-size:15px;font-weight:700;line-height:1.1;">${escapeHtml(this.formatAmount(alert))}</span>` : ""}
            ${musicHtml}
            ${messageHtml}
          </span>
        </div>`;

      return card;
    }

    // Панель растягивается под длинный текст доната, но не выходит за
    // разумный предел — иначе окно закрыло бы пол-экрана.
    _autoSize(card) {
      if (!this.element) return;
      this.element.style.height = this.geometry.h + "%";
      const base = this.element.clientHeight || 100;
      const needed = (card ? card.offsetHeight : 0) + 16;
      const cap = Math.max(360, base);
      this.element.style.height = Math.min(Math.max(base, needed), cap) + "px";
    }
  }

  return WidgetWin98HoloAlert;
});
