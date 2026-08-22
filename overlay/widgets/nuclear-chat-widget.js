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
  WidgetNuclearChat — radioactive stream chat for the Nuclear theme.

  Chat messages render in a DOM container while the background is a filled
  panel surface matching the Recent events widget (var(--panel-bg) + border +
  radius + shadow + scanlines + corner brackets). No neon HUD frame.

  Theme isolation: hard-gated to "nuclear" in onMount() and via the manager
  (shouldMount / resolveRenderType using the catalog `theme` field).
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetNuclearChat = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetNuclearChat;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetNuclearChat = WidgetNuclearChat;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const USER_COLOR = "#d3d8d4"; // bright gray (usernames)
  const TEXT_COLOR = "#a7ada8"; // gray phosphor text
  const MUTED = "#59615b"; // muted gray (time/badges)
  const MAX_MESSAGES = 50;

  class WidgetNuclearChat extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.messagesEl = null;
      this.messagesScroller = null;
      this.messagesInner = null;
    }

    onMount() {
      // HARD theme gate: no DOM, no events on a non-nuclear theme.
      if (this.theme !== "nuclear") return;

      // Panel surface + scanlines/corner brackets, driven by the active theme's
      // --panel-decoration token (same decoration language as Recent events).
      this.element.classList.add("nuclear-chat-surface");
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
        padding: "30px 34px",
        boxSizing: "border-box",
      });
      this.element.appendChild(this.messagesEl);

      // Scroll viewport: fills the outer content box (no padding of its own).
      this.messagesScroller = document.createElement("div");
      this.messagesScroller.className = "nuclear-chat__viewport";
      this.messagesScroller.style.cssText = "height:100%;overflow:hidden;";
      this.messagesEl.appendChild(this.messagesScroller);

      // Inner list: pinned to the bottom while short, grows past the viewport
      // when it overflows.
      this.messagesInner = document.createElement("div");
      this.messagesInner.className = "nuclear-chat__list";
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

    // Panel surface matching the Recent events widget: filled panel, border,
    // radius, drop shadow/glow, scanlines + corner brackets.
    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(13, 16, 14, 0.92)";
      const blur = (read && read("--panel-blur")) || "0px";
      const border = (read && read("--panel-border")) || "1px solid rgba(167, 173, 168, 0.18)";
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow =
        (read && read("--panel-glow")) ||
        "0 8px 24px rgba(0, 0, 0, 0.5)";

      // Set only backgroundColor so the scanline background-image from the
      // decoration ([data-decoration="nuclear"]) can layer on top.
      s.backgroundColor = bg;
      s.backgroundImage = "";
      s.backdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.webkitBackdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.border = border;
      s.borderRadius = radius;
      s.clipPath = clip;
      s.boxShadow = `${elev}, ${glow}`;
    }

    // Perspective tilt (0-100), adjustable from the chat inspector.
    _applyPerspective() {
      const v = Math.max(0, Math.min(100, Number(this.config.perspective) || 0));
      if (v > 0) {
        const ry = -(v * 0.15); // 0 .. -15deg
        const rx = v * 0.03; // 0 .. 3deg
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
      row.className = "nuclear-chat__row";
      row.style.cssText =
        "font-size:13px;line-height:1.55;color:" + TEXT_COLOR + ";";

      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const badges = (msg.badges || [])
        .slice(0, 3)
        .map((b) => `<span style="color:${MUTED};font-weight:700;">${escapeHtml(String(b).slice(0, 1).toUpperCase())}</span>`)
        .join(" ");
      const text = renderEmotes ? renderEmotes(msg.message, msg.emotes) : escapeHtml(msg.message);

      row.innerHTML =
        `<span style="color:${MUTED};">[${escapeHtml(time)}]</span>` +
        (badges ? ` ${badges}` : "") +
        ` <span style="color:${escapeAttr(USER_COLOR)};font-weight:700;">${escapeHtml(msg.user)}</span>` +
        `<span style="color:${MUTED};">:</span>` +
        ` <span style="color:${TEXT_COLOR};word-break:break-word;">${text}</span>`;

      this.messagesInner.appendChild(row);

      // Hard limit: drop the oldest rows so the DOM never grows unbounded.
      while (this.messagesInner.children.length > MAX_MESSAGES) {
        this.messagesInner.firstChild.remove();
      }

      // Auto-scroll to the newest message.
      this.messagesScroller.scrollTop = this.messagesScroller.scrollHeight;

      // GPU-accelerated entrance: slide in from the left + fade.
      if (row.animate) {
        row.animate(
          [
            { opacity: 0, transform: "translateX(-20px)" },
            { opacity: 1, transform: "translateX(0)" },
          ],
          { duration: 220, easing: "ease-out" }
        );
      }
    }
  }

  return WidgetNuclearChat;
});
