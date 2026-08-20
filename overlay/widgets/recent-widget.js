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
  Recent events widget — list of the latest follows/subs/donations.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const RecentWidget = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = RecentWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.RecentWidget = RecentWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  class RecentWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-recent";
      this.element.appendChild(this.host);

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.RECENT_EVENT, () => this.render());
      this.subscribe(EVENT_TYPES.LOCALES, () => this.render());
    }

    render() {
      const { escapeHtml, t, state } = this.context;
      const max = this.config.maxItems || 5;
      const items = (state.recentEvents || []).slice(0, max);

      this.host.innerHTML =
        `<div class="widget-recent__title">${t("preview.recentTitle")}</div>` +
        (items.length
          ? `<div class="widget-recent__list">${items
              .map((e) => `<div class="widget-recent__item"><span class="widget-recent__dot" data-kind="${e.kind}"></span><span>${this._text(e)}</span></div>`)
              .join("")}</div>`
          : `<div class="widget-recent__empty">${t("recent.empty")}</div>`);
    }

    _text(evt) {
      const { escapeHtml, formatMoney, t } = this.context;
      const user = `<b>${escapeHtml(evt.user || "")}</b>`;
      switch (evt.kind) {
        case "follow":
          return t("recent.follow", { user });
        case "sub":
          return t("recent.sub", { user });
        case "gift_sub":
          return t("recent.giftSub", { user, amount: evt.amount || "" });
        case "cheer":
          return t("recent.cheer", { user, amount: evt.amount || 0 });
        case "donation":
          return t("recent.donation", { user, amount: formatMoney(evt.amount || 0) });
        default:
          return user;
      }
    }
  }

  return RecentWidget;
});
