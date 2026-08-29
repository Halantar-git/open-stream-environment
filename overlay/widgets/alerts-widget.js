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
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const AlertsWidget = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = AlertsWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.AlertsWidget = AlertsWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
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
    }

    queueAlert(alert) {
      if (alert.kind === "wheel_winner") {
        if (alert.isElimination) this.context.audio.playEliminationAudio();
        else this.context.audio.playWinSound();
      }
      this.queue.push(alert);
      if (!this.playing) this.drain();
    }

    drain() {
      const alert = this.queue.shift();
      if (!alert) {
        this.playing = false;
        return;
      }
      this.playing = true;

      const card = this.buildCard(alert);
      this.host.appendChild(card);
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
          return t("alert.sub");
        case "gift_sub":
          return t("alert.giftSub", { count: alert.count || 1 });
        case "cheer":
          return t("alert.cheer");
        case "donation":
          return t("alert.donation");
        case "boosty_sub":
          return t("alert.boostySub");
        case "boosty_resub":
          return t("alert.boostyResub");
        case "wheel_start":
          return t("alert.wheelStart");
        case "wheel_winner":
          return t("alert.wheelWinner");
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

      if (alert.kind === "wheel_start") {
        nameHtml = escapeHtml(t("alert.wheelStartMessage", { command: alert.command || "" }));
      } else if (alert.kind === "wheel_winner") {
        icon = "";
        const name = escapeHtml(alert.user || "");
        if (alert.isElimination) nameHtml = t("alert.eliminated", { name });
        else if (alert.isFinalWinner) nameHtml = t("alert.finalWinner", { name });
        else nameHtml = t("alert.winner", { name });
      } else if (alert.kind === "donation" || alert.kind === "cheer") {
        if (alert.message) messageHtml = `<div class="widget-alert__message">«${escapeHtml(alert.message)}»</div>`;
      }

      card.innerHTML = `
        <div class="widget-alert__spark">${"<span></span>".repeat(6)}</div>
        ${icon ? `<div class="widget-alert__icon">${icon}</div>` : ""}
        <div class="widget-alert__body">
          <div class="widget-alert__status"><span class="widget-alert__dot"></span><span class="widget-alert__kicker">${this.kindLabel(alert)}</span></div>
          <div class="widget-alert__name">${nameHtml}</div>
          ${showAmount ? `<div class="widget-alert__amount">${this.formatAmount(alert)}</div>` : ""}
          ${messageHtml}
        </div>
        <div class="widget-alert__lockbar"><div class="widget-alert__lockbar-fill"></div></div>`;
      return card;
    }

    render() {}
  }

  return AlertsWidget;
});
