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
  Social banner widget — rotates through a list of social links on an interval.
  The rotation is driven by auto-tracked timers (every/later), so unmount() and
  config changes clean them up automatically.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const SocialWidget = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = SocialWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.SocialWidget = SocialWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  class SocialWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-social";
      this.element.appendChild(this.host);
      this.socialIndex = 0;
      this._intervalId = null;
      this._key = "";
      this._startRotation();
    }

    onUpdate(prevConfig, nextConfig) {
      const a = JSON.stringify(prevConfig.socials) + "|" + (prevConfig.rotateIntervalSec || 8);
      const b = JSON.stringify(nextConfig.socials) + "|" + (nextConfig.rotateIntervalSec || 8);
      if (a !== b) this._startRotation();
    }

    _startRotation() {
      const socials = this.config.socials || [];
      const key = JSON.stringify(socials) + "|" + (this.config.rotateIntervalSec || 8);
      if (this._key === key) return;
      this._key = key;

      if (this._intervalId) this.clearTimer(this._intervalId);
      this._intervalId = null;
      this.socialIndex = 0;
      this.render();

      if (socials.length > 1) {
        const intervalMs = Math.max(2, this.config.rotateIntervalSec || 8) * 1000;
        this._intervalId = this.every(() => {
          const contentEl = this.host.querySelector(".widget-social__content");
          if (contentEl) contentEl.classList.add("is-fading");
          this.later(() => {
            this.socialIndex = (this.socialIndex + 1) % socials.length;
            this.render();
          }, 300);
        }, intervalMs);
      }
    }

    render() {
      const { escapeHtml } = this.context;
      const socials = this.config.socials || [];
      const s = socials[this.socialIndex] || { platform: "", text: "" };
      this.host.innerHTML = `<div class="widget-social__content"><span class="widget-social__icon">${escapeHtml(s.platform)}</span><div class="widget-social__info"><span class="widget-social__platform">${escapeHtml(s.platform)}</span><span class="widget-social__handle">${escapeHtml(s.text)}</span></div></div>`;
    }
  }

  return SocialWidget;
});
