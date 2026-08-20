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
  WidgetStarCitizenChat — pirate-sci-fi stream chat for the Star Citizen theme.

  Chat messages render in a DOM container while the background is a filled
  panel surface matching the Recent events widget (var(--panel-bg) + border +
  radius + shadow + scanline texture + corner brackets). No neon HUD frame.

  Theme isolation: hard-gated to "grimhex" in onMount() and via the manager
  (shouldMount / resolveRenderType using the catalog `theme` field).
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetStarCitizenChat = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetStarCitizenChat;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetStarCitizenChat = WidgetStarCitizenChat;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const AMBER = "#ffaa00";
  const TEXT_COLOR = "#dcebf5";
  const MUTED = "#8ab4d0";
  const MAX_MESSAGES = 50;

  class WidgetStarCitizenChat extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.messagesEl = null;
      this.messagesScroller = null;
      this.messagesInner = null;
    }

    onMount() {
      // HARD theme gate: no DOM, no events on a non-grimhex theme.
      if (this.theme !== "grimhex") return;

      // Panel surface + corner brackets/scanlines, driven by the active theme's
      // --panel-decoration token (same decoration language as Recent events).
      this.element.classList.add("star-citizen-chat-surface");
      this._applySurface();

      // Foreground chat frame: an outer box holding only the padding, so the
      // scroll viewport below clips exactly at the padded content box (the
      // frame) rather than at the widget edge.
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

      // Scroll viewport: fills the outer content box (no padding of its own),
      // so overflow is trimmed at the frame instead of bleeding into it.
      this.messagesScroller = document.createElement("div");
      this.messagesScroller.className = "star-citizen-chat__viewport";
      this.messagesScroller.style.cssText = "height:100%;overflow:hidden;";
      this.messagesEl.appendChild(this.messagesScroller);

      // Inner list: pinned to the bottom while short (min-height:100% +
      // flex-end), and grows past the viewport when it overflows so the viewport
      // scrolls instead of bleeding messages past the frame.
      this.messagesInner = document.createElement("div");
      this.messagesInner.className = "star-citizen-chat__list";
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
    // radius, drop shadow/glow, scanline texture + corner brackets.
    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(8, 14, 20, 0.92)";
      const blur = (read && read("--panel-blur")) || "0px";
      const border = (read && read("--panel-border")) || "1px solid rgba(0, 240, 255, 0.35)";
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow =
        (read && read("--panel-glow")) ||
        "0 0 15px rgba(0,240,255,0.3), inset 0 0 30px rgba(0,240,255,0.04)";

      // Set only backgroundColor so the scanline background-image from the
      // HUD decoration ([data-decoration]) can layer on top, like Recent events.
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
      row.className = "star-citizen-chat__row";
      row.style.cssText =
        "display:flex;gap:7px;align-items:baseline;font-size:13px;line-height:1.55;color:" + TEXT_COLOR + ";";

      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const badges = (msg.badges || [])
        .slice(0, 3)
        .map((b) => `<span style="color:${MUTED};font-weight:700;flex-shrink:0;">${escapeHtml(String(b).slice(0, 1).toUpperCase())}</span>`)
        .join("");
      const text = renderEmotes ? renderEmotes(msg.message, msg.emotes) : escapeHtml(msg.message);

      row.innerHTML =
        `<span style="color:${MUTED};flex-shrink:0;">[${escapeHtml(time)}]</span>` +
        badges +
        `<span style="color:${escapeAttr(AMBER)};font-weight:700;flex-shrink:0;">${escapeHtml(msg.user)}</span>` +
        `<span style="color:${MUTED};flex-shrink:0;">:</span>` +
        `<span style="color:${TEXT_COLOR};flex:1 1 0%;min-width:0;overflow-wrap:anywhere;word-break:break-word;">${text}</span>`;

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

  return WidgetStarCitizenChat;
});
