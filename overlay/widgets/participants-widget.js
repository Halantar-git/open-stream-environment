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
  Participants widget — giveaway participant list. Its visibility is gated by
  the wheel: it only shows while the wheel is visible (see the "wheel_visibility"
  bus channel emitted by overlay.js).
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const ParticipantsWidget = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ParticipantsWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.ParticipantsWidget = ParticipantsWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  class ParticipantsWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-participants";
      this.element.appendChild(this.host);

      this._wheelVisible = false;

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.GIVEAWAY_PARTICIPANTS, () => this.render());
      this.subscribe(EVENT_TYPES.OVERLAY_PARTICIPANTS_CONFIG, () => this.render());
      this.subscribe(EVENT_TYPES.LOCALES, () => this.render());
      this.subscribe("wheel_visibility", (payload) => {
        this._wheelVisible = !!(payload && payload.visible);
        this._syncVisibility();
      });

      this._syncVisibility();
    }

    update(newConfig = {}) {
      super.update(newConfig);
      this._syncVisibility();
    }

    _syncVisibility() {
      if (!this.element) return;
      this.element.style.display = this.geometry.visible && this._wheelVisible ? "" : "none";
    }

    render() {
      const { escapeHtml, t, state } = this.context;
      const participantsState = state.participantsState || {};
      const participantsConfig = state.participantsConfig || {};
      const count = participantsState.count || 0;
      const all = participantsState.participants || [];

      this.host.style.setProperty("--pw-font-size", participantsConfig.fontSize + "px");
      this.host.style.setProperty("--pw-text", participantsConfig.textColor);
      this.host.style.setProperty("--pw-bg-opacity", participantsConfig.backgroundOpacity + "%");

      if (!count) {
        this.host.innerHTML = "";
        return;
      }

      let listHtml = "";
      if (participantsConfig.marquee) {
        const text = all.join(" • ");
        listHtml = `<div class="widget-participants__marquee"><span>${escapeHtml(text)}</span><span>${escapeHtml(text)}</span></div>`;
      } else {
        const max = Math.max(1, Number(participantsConfig.maxNames) || 10);
        const names = all.slice(0, max);
        const extra = count - names.length;
        listHtml = `<div class="widget-participants__list">${names.map((n) => `<span class="widget-participants__chip">${escapeHtml(n)}</span>`).join("")}${extra > 0 ? `<span class="widget-participants__more">+${extra}</span>` : ""}</div>`;
      }

      this.host.innerHTML = `
        <div class="widget-participants__title">${t("wheelScene.participantsTitle", { count })}</div>
        ${listHtml}`;
    }
  }

  return ParticipantsWidget;
});
