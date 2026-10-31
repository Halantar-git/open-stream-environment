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
  Alerts widget — queued popup cards (follow / sub / donation / wheel winner).
  Hold + exit timers are auto-tracked via later(), so unmount() clears them.

  Расписание алертов держит сервер (server/alert-queue.js) и присылает их по
  одному, поэтому собственный буфер здесь — только страховка: обычно drain()
  срабатывает на первом же алерте. Он нужен, если сервер отдаст больше одного
  сразу — так бывает, когда очередь повторно отправляет текущий алерт
  перезагруженной странице OBS и следом приходит следующий.
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
  const AlertsWidget = factory(BaseWidget, AlertTyping);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = AlertsWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.AlertsWidget = AlertsWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget, AlertTyping) {
  "use strict";

  class AlertsWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-alerts-host";
      this.element.appendChild(this.host);
      this.queue = [];
      this.playing = false;
      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this.queueAlert(alert));
    }

    onUnmount() {
      this.queue = [];
      this.playing = false;
      if (this._typing) {
        this._typing.stop();
        this._typing = null;
      }
    }

    onUpdate() {
      // `syncLayout` присылает новый снимок на каждое событие, и BaseWidget
      // заново ставит процентную высоту. Возвращаем замеренную под текст,
      // иначе панель сжималась бы и снова резала длинное сообщение.
      if (this.element && this._cardHeight > 0) {
        this.element.style.height = this._cardHeight + "px";
      }
    }

    /*
      Звук победителя и выбывания играет страница колеса (overlay/wheel-scene.js):
      розыгрыш идёт на ней. Здесь его не дублируем: в обычной раскладке OBS в сцене
      с колесом лежит и основной оверлей, поэтому звук слышался дважды, а окно HUD
      и окно превью темы добавляли к этому третью копию. Карточка остаётся.
    */
    queueAlert(alert) {
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
        this.element.style.height = this.geometry.h + "%"; // reset to layout height
        return;
      }
      this.playing = true;

      const card = this.buildCard(alert);
      this.host.appendChild(card);
      this._autoSize(card);
      this._typeText(card);
      requestAnimationFrame(() => card.classList.add("alert-enter-active"));

      const holdMs = alert.durationMs || 5000;
      this.later(() => {
        card.classList.add("alert-exit");
        this.later(() => {
          card.remove();
          this.drain();
        }, 280);
      }, holdMs);
    }

    kindLabel(alert) {
      const { t } = this.context;
      switch (alert.kind) {
        case "follow":
          return t("alert.follow");
        case "sub":
          return Number(alert.months) > 1
            ? t("alert.resubMonths", { months: alert.months })
            : t("alert.sub");
        case "gift_sub":
          return t("alert.giftSub", { count: alert.count || 1 });
        case "cheer":
          return t("alert.cheer");
        case "donation":
          return t("alert.donation");
        case "ai":
          return t("alert.ai");
        case "boosty_sub":
          return t("alert.boostySub");
        case "boosty_resub":
          return t("alert.boostyResub");
        case "wheel_start":
          return t("alert.wheelStart");
        case "wheel_winner":
          return t("alert.wheelWinner");
        case "reward":
          return t("alert.reward");
        default:
          return "";
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
      const card = document.createElement("div");
      card.className = "widget-alert";
      card.dataset.kind = alert.kind;

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
      } else if (alert.kind === "reward") {
        nameHtml = escapeHtml(alert.rewardTitle || alert.user || "");
        if (alert.message) messageHtml = `<div class="widget-alert__message">«${escapeHtml(alert.message)}»</div>`;
      } else if (alert.kind === "ai" || alert.kind === "donation" || alert.kind === "cheer") {
        if (alert.message) messageHtml = `<div class="widget-alert__message">«${escapeHtml(alert.message)}»</div>`;
        // Заказанный трек показываем рядом с суммой: зритель видит, за что
        // заплатили, не дожидаясь карточки музыки.
        if (alert.musicTitle) {
          musicHtml = `<div class="widget-alert__music"><span>♪</span>${escapeHtml(alert.musicTitle)}</div>`;
        }
      }

      card.innerHTML = `
        <div class="widget-alert__spark">${"<span></span>".repeat(6)}</div>
        ${icon ? `<div class="widget-alert__icon">${icon}</div>` : ""}
        <div class="widget-alert__body">
          <div class="widget-alert__status"><span class="widget-alert__dot"></span><span class="widget-alert__kicker">${this.kindLabel(alert)}</span></div>
          <div class="widget-alert__name">${nameHtml}</div>
          ${showAmount ? `<div class="widget-alert__amount">${this.formatAmount(alert)}</div>` : ""}
          ${musicHtml}
          ${messageHtml}
        </div>
        <div class="widget-alert__lockbar"><div class="widget-alert__lockbar-fill"></div></div>`;
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
      if (!this.element) return;
      this.element.style.height = this.geometry.h + "%";
      const base = this.element.clientHeight || 120;

      let needed = 0;
      if (card) {
        // Карточка в CSS тянется на всю панель: на время замера отпускаем её
        // по высоте, иначе `offsetHeight` вернёт высоту панели, а не текста.
        card.style.height = "auto";
        needed = card.offsetHeight;
        card.style.height = ""; // restore the CSS height:100%
      }
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

    render() {}
  }

  return AlertsWidget;
});
