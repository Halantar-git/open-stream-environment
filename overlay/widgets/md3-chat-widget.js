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
  WidgetMd3Chat — elevated stream chat for the Material You theme.

  Chat messages render in a DOM container while the background is the theme's
  glass panel surface (var(--panel-bg) + border + radius + blur), so it
  automatically follows the Material You look. Text colours come from the theme
  tokens (--md-on-surface / --md-on-surface-variant), usernames keep the chat
  color (or fall back to the primary accent).

  Theme isolation: hard-gated to "nebula" in onMount() and via the manager
  (shouldMount / resolveRenderType using the catalog `theme` field).
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetMd3Chat = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetMd3Chat;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetMd3Chat = WidgetMd3Chat;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_TEXT = "#e6e1e5"; // --md-on-surface (nebula)
  const DEFAULT_MUTED = "#cac4d0"; // --md-on-surface-variant (nebula)
  const DEFAULT_USER = "#d0bcff"; // --md-primary (nebula)
  const MAX_MESSAGES = 50;

  class WidgetMd3Chat extends BaseWidget {
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
      // HARD theme gate: no DOM, no events on a non-MD3 theme.
      if (this.theme !== "nebula") return;

      this._readColors();

      this.element.classList.add("md3-chat-surface");
      this._applySurface();

      // Foreground chat frame: an outer box holding only the padding, so the
      // scroll viewport below clips exactly at the padded content box.
      this.messagesEl = document.createElement("div");
      this.messagesEl.className = "chat-messages-container";
      Object.assign(this.messagesEl.style, {
        position: "absolute",
        left: "0",
        right: "0",
        top: "0",
        bottom: "0",
        padding: "22px 26px",
        boxSizing: "border-box",
      });
      this.element.appendChild(this.messagesEl);

      this.messagesScroller = document.createElement("div");
      this.messagesScroller.className = "md3-chat__viewport";
      this.messagesScroller.style.cssText = "height:100%;overflow:hidden;";
      this.messagesEl.appendChild(this.messagesScroller);

      this.messagesInner = document.createElement("div");
      this.messagesInner.className = "md3-chat__list";
      this.messagesInner.style.cssText =
        "display:flex;flex-direction:column;justify-content:flex-end;min-height:100%;";
      this.messagesScroller.appendChild(this.messagesInner);

      this._applyPerspective();
      this.bindEvents();
    }

    onUnmount() {
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

      const bg = (read && read("--panel-bg")) || "rgba(33, 31, 38, 0.82)";
      const blur = (read && read("--panel-blur")) || "20px";
      const border = (read && read("--panel-border")) || "1px solid rgba(255, 255, 255, 0.12)";
      const radius = (read && read("--panel-radius")) || "24px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) || "0 1px 3px rgba(0,0,0,0.45), 0 1px 2px rgba(0,0,0,0.3)";
      const glow = (read && read("--panel-glow")) || "0 24px 48px rgba(0,0,0,0.45)";

      s.backgroundColor = bg;
      s.backgroundImage = "";
      s.backdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.webkitBackdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.border = border;
      s.borderRadius = radius;
      s.clipPath = clip;
      s.boxShadow = `${elev}, ${glow}`;
    }

    _applyPerspective() {
      const v = Math.max(0, Math.min(100, Number(this.config.perspective) || 0));
      if (v > 0) {
        const ry = -(v * 0.15);
        const rx = v * 0.03;
        this.element.style.transform = `perspective(1200px) rotateY(${ry}deg) rotateX(${rx}deg)`;
        this.element.style.transformStyle = "preserve-3d";
      } else {
        this.element.style.transform = "";
        this.element.style.transformStyle = "";
      }
    }

    bindEvents() {
      this.subscribe(this.context.EVENT_TYPES.CHAT_MESSAGE, (msg) => this.pushMessage(msg));
    }

    pushMessage(msg) {
      if (!this.messagesEl || !msg) return;
      const { escapeHtml, escapeAttr, renderEmotes } = this.context;

      const row = document.createElement("div");
      row.className = "md3-chat__row";
      row.style.cssText = `font-size:13px;line-height:1.55;color:${this.textColor};`;

      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const badges = (msg.badges || [])
        .slice(0, 3)
        .map((b) => `<span style="color:${this.mutedColor};font-weight:700;">${escapeHtml(String(b).slice(0, 1).toUpperCase())}</span>`)
        .join(" ");
      const userColor = msg.color || this.userColor;
      const text = renderEmotes ? renderEmotes(msg.message, msg.emotes) : escapeHtml(msg.message);

      row.innerHTML =
        `<span style="color:${this.mutedColor};">[${escapeHtml(time)}]</span>` +
        (badges ? ` ${badges}` : "") +
        ` <span style="color:${escapeAttr(userColor)};font-weight:700;">${escapeHtml(msg.user)}</span>` +
        `<span style="color:${this.mutedColor};">:</span>` +
        ` <span style="color:${this.textColor};word-break:break-word;">${text}</span>`;

      this.messagesInner.appendChild(row);

      while (this.messagesInner.children.length > MAX_MESSAGES) {
        this.messagesInner.firstChild.remove();
      }

      this.messagesScroller.scrollTop = this.messagesScroller.scrollHeight;

      if (row.animate) {
        row.animate(
          [
            { opacity: 0, transform: "translateY(8px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 200, easing: "ease-out" }
        );
      }
    }
  }

  return WidgetMd3Chat;
});
