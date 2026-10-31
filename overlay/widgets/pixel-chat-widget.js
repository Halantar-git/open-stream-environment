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
  WidgetPixelChat — pixel stream chat for the Pixel Perfect theme.

  Chat messages render in a DOM container on the theme's flat panel surface
  (radius 0, no blur, 1px border), with Roboto Condensed for readable long
  chat text and the theme's muted gold accent for usernames.
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
  const WidgetPixelChat = factory(BaseWidget, AlertTyping);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetPixelChat;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetPixelChat = WidgetPixelChat;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget, AlertTyping) {
  "use strict";

  const DEFAULT_TEXT = "#e6e6e6";
  const DEFAULT_MUTED = "#b8b8b8";
  const DEFAULT_USER = "#d6b675";
  const FONT = "'Roboto Condensed', 'Segoe UI', sans-serif";
  const DEFAULT_MAX_MESSAGES = 50;
  const MAX_MESSAGES_LIMIT = 200;

  // Лимит строк берётся из инспектора (1..100). Мусор в конфиге (не число, 0,
  // отрицательное, NaN) не должен снимать лимит — тогда DOM рос бы безгранично.
  function clampMaxMessages(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_MESSAGES;
    return Math.min(MAX_MESSAGES_LIMIT, n);
  }

  class WidgetPixelChat extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;
      this.userColor = DEFAULT_USER;

      this.messagesEl = null;
      this.messagesScroller = null;
      this.messagesInner = null;
    }

    onMount() {
      if (this.theme !== "pixel") return;

      this._readColors();
      this.element.classList.add("pixel-chat-surface");
      this._applySurface();

      this.messagesEl = document.createElement("div");
      this.messagesEl.className = "chat-messages-container";
      Object.assign(this.messagesEl.style, {
        position: "absolute",
        left: "0",
        right: "0",
        top: "0",
        bottom: "0",
        padding: "18px 22px",
        boxSizing: "border-box",
      });
      this.element.appendChild(this.messagesEl);

      this.messagesScroller = document.createElement("div");
      this.messagesScroller.className = "pixel-chat__viewport";
      this.messagesScroller.style.cssText = "height:100%;overflow:hidden;";
      this.messagesEl.appendChild(this.messagesScroller);

      this.messagesInner = document.createElement("div");
      this.messagesInner.className = "pixel-chat__list";
      this.messagesInner.style.cssText =
        "display:flex;flex-direction:column;justify-content:flex-end;min-height:100%;";
      this.messagesScroller.appendChild(this.messagesInner);

      this._applyPerspective();
      this.bindEvents();
    }

    onUnmount() {
      this._stopTyping();
      if (this.messagesEl) this.messagesEl.innerHTML = "";
      this.messagesEl = null;
      this.messagesScroller = null;
      this.messagesInner = null;
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective) this._applyPerspective();
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
      this.userColor = (read && read("--md-primary")) || DEFAULT_USER;
    }

    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(16, 16, 18, 0.95)";
      const blur = (read && read("--panel-blur")) || "0px";
      const border = (read && read("--panel-border")) || "1px solid rgba(138, 138, 141, 0.35)";
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const glow = (read && read("--panel-glow")) || "0 0 0 1px rgba(214, 182, 117, 0.15)";

      s.backgroundColor = bg;
      s.backgroundImage = "";
      s.backdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.webkitBackdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.border = border;
      s.borderRadius = radius;
      s.clipPath = clip;
      s.boxShadow = glow;
    }

    _applyPerspective() {
      const v = Math.max(0, Math.min(100, Number(this.config.perspective) || 0));
      if (v > 0) {
        const ry = -(v * 0.15);
        const rx = v * 0.03;
        this._setTilt(`perspective(1200px) rotateY(${ry}deg) rotateX(${rx}deg)`);
      } else {
        this._setTilt("");
      }
    }

    bindEvents() {
      this.subscribe(this.context.EVENT_TYPES.CHAT_MESSAGE, (msg) => this.pushMessage(msg));
    }

    pushMessage(msg) {
      if (!this.messagesEl || !msg) return;
      const { escapeHtml, escapeAttr, renderEmotes } = this.context;

      const row = document.createElement("div");
      row.className = "pixel-chat__row";
      row.style.cssText = `font-size:13px;line-height:1.5;color:${this.textColor};font-family:${FONT};`;

      const time = this.config.showTime === false ? "" : BaseWidget.clockTime();
      const badges = (msg.badges || [])
        .slice(0, 3)
        .map((b, i) => {
          const url = msg.badgeImages && msg.badgeImages[i];
          return url
            ? `<img src="${escapeAttr(url)}" alt="" title="${escapeAttr(String(b))}" style="width:1.05em;height:1.05em;object-fit:contain;vertical-align:-0.15em" />`
            : `<span style="color:${this.mutedColor};font-weight:700;">${escapeHtml(String(b).slice(0, 1).toUpperCase())}</span>`;
        })
        .join(" ");
      const userColor = msg.color || this.userColor;
      const text = renderEmotes ? renderEmotes(msg.message, msg.emotes) : escapeHtml(msg.message);

      row.innerHTML =
        (time ? `<span style="color:${this.mutedColor};">[${escapeHtml(time)}]</span>` : "") +
        (badges ? ` ${badges}` : "") +
        ` <span style="color:${escapeAttr(userColor)};font-weight:700;">${escapeHtml(msg.user)}</span>` +
        `<span style="color:${this.mutedColor};">:</span>` +
        ` <span style="color:${this.textColor};word-break:break-word;">${text}</span>`;

      this.messagesInner.appendChild(row);

      const maxMessages = clampMaxMessages(this.config.maxMessages);
      while (this.messagesInner.children.length > maxMessages) {
        this.messagesInner.firstChild.remove();
      }

      this.messagesScroller.scrollTop = this.messagesScroller.scrollHeight;
      this._typeMessage(row.lastElementChild);

      if (row.animate) {
        row.animate(
          [
            { opacity: 0, transform: "translateX(-6px)" },
            { opacity: 1, transform: "translateX(0)" },
          ],
          { duration: 140, easing: "steps(3, end)" }
        );
      }
    }

    // Текст сообщения печатается как в терминале; ник, бейджи и время — сразу.
    // Новое сообщение дорисовывает недопечатанное прежнее: в живом чате
    // печать не должна копиться и отставать от эфира.
    _typeMessage(textEl) {
      this._stopTyping();
      this._typing = AlertTyping
        ? AlertTyping.typeAlertText(textEl, { onTick: () => this._scrollToEnd() })
        : null;
    }

    _stopTyping() {
      if (this._typing) {
        this._typing.stop();
        this._typing = null;
      }
    }

    _scrollToEnd() {
      if (this.messagesScroller) {
        this.messagesScroller.scrollTop = this.messagesScroller.scrollHeight;
      }
    }
  }

  return WidgetPixelChat;
});
