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
  Stat pill widget — followers / subscribers / latest / top donation.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const StatWidget = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = StatWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.StatWidget = StatWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  class StatWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-stat";
      this.element.appendChild(this.host);

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.STAT_UPDATE, () => this.render());
      this.subscribe(EVENT_TYPES.TOP_DONATION_UPDATE, () => this.render());
      this.subscribe(EVENT_TYPES.RECENT_EVENT, () => this.render());
      this.subscribe(EVENT_TYPES.LOCALES, () => this.render());
    }

    render() {
      const { icon, label, value } = this._content();
      this.host.innerHTML = `<div class="widget-stat__icon">${icon}</div><div class="widget-stat__info"><span class="widget-stat__label">${this.context.escapeHtml(label)}</span><span class="widget-stat__value">${this.context.escapeHtml(value)}</span></div>`;
    }

    _content() {
      const { ICONS, formatMoney, currencySymbol, t, state } = this.context;
      const metric = this.config.metric || "followers";

      if (metric === "subscribers") {
        return {
          icon: ICONS.sub,
          label: this.config.label || t("preview.subscribers"),
          value: state.stats.subscriberCount != null ? formatMoney(state.stats.subscriberCount) : "—",
        };
      }
      if (metric === "latestFollower") {
        const e = state.recentEvents.find((ev) => ev.kind === "follow");
        return { icon: ICONS.follow, label: this.config.label || t("preview.latestFollower"), value: e ? e.user : t("scene.notYet") };
      }
      if (metric === "latestSubscriber") {
        const e = state.recentEvents.find((ev) => ev.kind === "sub" || ev.kind === "gift_sub");
        return { icon: ICONS.sub, label: this.config.label || t("preview.latestSubscriber"), value: e ? e.user : t("scene.notYet") };
      }
      if (metric === "topDonation") {
        return {
          icon: ICONS.donation,
          label: this.config.label || t("preview.topDonation"),
          value:
            state.topDonation.amount > 0
              ? `${state.topDonation.user} (${formatMoney(state.topDonation.amount)} ${currencySymbol(state.topDonation.currency)})`
              : t("scene.notYet"),
        };
      }
      return {
        icon: ICONS.follow,
        label: this.config.label || t("preview.followers"),
        value: state.stats.followerCount != null ? formatMoney(state.stats.followerCount) : "—",
      };
    }
  }

  return StatWidget;
});
