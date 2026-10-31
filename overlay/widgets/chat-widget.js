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
  Chat widget — Twitch/YouTube message feed. Event-driven: appends a row on
  every `chat_message` and trims to `maxMessages`.
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
  const ChatWidget = factory(BaseWidget, AlertTyping);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ChatWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.ChatWidget = ChatWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget, AlertTyping) {
  "use strict";

  class ChatWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-chat";
      this.element.appendChild(this.host);
      this.subscribe(this.context.EVENT_TYPES.CHAT_MESSAGE, (msg) => this.push(msg));
    }

    onUnmount() {
      this._stopTyping();
    }

    push(msg) {
      const { escapeHtml, escapeAttr, renderEmotes } = this.context;
      const row = document.createElement("div");
      row.className = "widget-chat__msg";

      const badges = (msg.badges || [])
        .slice(0, 3)
        .map((b, i) => {
          const url = msg.badgeImages && msg.badgeImages[i];
          return url
            ? `<img class="widget-chat__badge" src="${escapeAttr(url)}" alt="" title="${escapeAttr(String(b))}" style="object-fit:contain;background:none" />`
            : `<span class="widget-chat__badge" data-role="${escapeAttr(String(b))}">${escapeHtml(String(b).slice(0, 1).toUpperCase())}</span>`;
        })
        .join("");

      row.innerHTML = `${badges}<span class="widget-chat__user" style="color:${escapeAttr(msg.color || "#c9c1d6")}">${escapeHtml(msg.user)}</span><span class="widget-chat__colon">:</span><span class="widget-chat__text">${renderEmotes(msg.message, msg.emotes)}</span>`;
      this.host.appendChild(row);
      this.trim();
      this._typeMessage(row.lastElementChild);
    }

    // Текст сообщения печатается как в терминале; ник, бейджи и время — сразу.
    // Новое сообщение дорисовывает недопечатанное прежнее: в живом чате
    // печать не должна копиться и отставать от эфира.
    _typeMessage(textEl) {
      this._stopTyping();
      this._typing = AlertTyping ? AlertTyping.typeAlertText(textEl) : null;
    }

    _stopTyping() {
      if (this._typing) {
        this._typing.stop();
        this._typing = null;
      }
    }

    trim() {
      const max = this.config.maxMessages || 8;
      while (this.host.children.length > max) this.host.removeChild(this.host.firstChild);
    }

    render() {}
  }

  return ChatWidget;
});
