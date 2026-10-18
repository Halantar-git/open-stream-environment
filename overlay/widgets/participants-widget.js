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
  Participants widget — список участников розыгрыша «Колесо Фортуны».

  Данные приходят из того же состояния, что и у самой сцены колеса:
  снимок STATE несёт `giveaway`, а изменения — события `giveaway_update`
  и `giveaway_participants`. Пока участников нет, виджет скрыт, чтобы
  пустая плашка не висела в эфире до начала розыгрыша.
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

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  class ParticipantsWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-participants";
      this.element.appendChild(this.host);
      this.liveGiveaway = null;

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.GIVEAWAY_UPDATE, (payload) => {
        if (payload && payload.giveaway) this.liveGiveaway = payload.giveaway;
        this.render();
      });
      this.subscribe(EVENT_TYPES.GIVEAWAY_PARTICIPANTS, (payload) => {
        const base = this.liveGiveaway || {};
        this.liveGiveaway = {
          ...base,
          count: payload && payload.count != null ? payload.count : base.count,
          participants:
            payload && Array.isArray(payload.participants)
              ? payload.participants
              : base.participants,
        };
        this.render();
      });
      // Заголовок «Участники: N» тоже переводится вместе с языком.
      this.subscribe(EVENT_TYPES.LOCALES, () => this.render());
    }

    onUpdate() {
      this.render();
    }

    giveawayState() {
      const state = this.context.state || {};
      return this.liveGiveaway || state.giveaway || {};
    }

    render() {
      if (!this.host) return;
      const escapeHtml = this.context.escapeHtml || ((value) => String(value));
      const t = this.context.t || ((key) => key);
      const giveaway = this.giveawayState();
      const all = Array.isArray(giveaway.participants) ? giveaway.participants : [];
      const count = Number(giveaway.count != null ? giveaway.count : all.length) || 0;
      const config = this.config || {};

      this.host.style.setProperty(
        "--pw-font-size",
        `${clamp(Number(config.fontSize) || 16, 8, 64)}px`
      );
      this.host.style.setProperty("--pw-text", config.textColor || "var(--md-on-surface)");
      this.host.style.setProperty(
        "--pw-bg-opacity",
        `${clamp(config.backgroundOpacity == null ? 82 : Number(config.backgroundOpacity), 0, 100)}%`
      );

      // Пустая плашка в эфире не нужна: виджет появляется вместе с первым
      // участником и исчезает после очистки списка.
      if (!count) {
        this.host.hidden = true;
        this.host.innerHTML = "";
        return;
      }
      this.host.hidden = false;

      let listHtml;
      if (config.marquee) {
        const text = all.join(" • ");
        listHtml = `<div class="widget-participants__marquee"><span>${escapeHtml(text)}</span><span>${escapeHtml(text)}</span></div>`;
      } else {
        const max = Math.max(1, Number(config.maxNames) || 10);
        const names = all.slice(0, max);
        const extra = Math.max(0, count - names.length);
        listHtml = `<div class="widget-participants__list">${names
          .map((name) => `<span class="widget-participants__chip">${escapeHtml(name)}</span>`)
          .join("")}${extra > 0 ? `<span class="widget-participants__more">+${extra}</span>` : ""}</div>`;
      }

      this.host.innerHTML = `<div class="widget-participants__title">${escapeHtml(
        t("wheelScene.participantsTitle", { count })
      )}</div>${listHtml}`;
    }
  }

  return ParticipantsWidget;
});
