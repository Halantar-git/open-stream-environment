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
  WidgetTesoChat — Elder Scrolls-style stream chat for the TESO
  "Ouroboros Seal" 3D theme.

  A Cinzel title ("Game Chat") over a gold rhombus divider, then chat rows in
  Montserrat: gold usernames on parchment text, framed by the theme's panel
  surface and gold corner brackets (--panel-decoration = brackets2).

  Theme isolation: hard-gated to "teso-seal" in onMount() and via the manager
  (shouldMount / resolveRenderType using the catalog `theme` field).
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetTesoChat = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetTesoChat;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetTesoChat = WidgetTesoChat;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const GOLD = "#c7a75c";
  const GOLD_BRIGHT = "#e2c47e";
  const TEXT = "#e6e3d8";
  const MUTED = "#bfc3b0";
  const FONT_DISPLAY = "'Cinzel', 'Georgia', serif";
  const FONT_BODY = "'Montserrat', 'Segoe UI', sans-serif";
  const MAX_MESSAGES = 50;

  class WidgetTesoChat extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.frameEl = null;
      this.messagesScroller = null;
      this.messagesInner = null;
    }

    onMount() {
      // HARD theme gate: no DOM, no events on a non-TESO theme.
      if (this.theme !== "teso-seal") return;

      this.element.classList.add("teso-chat-surface");
      this._applySurface();

      // Foreground frame: padding only, so the scroll viewport clips inside
      // the panel (matching the Cobra/Recent events chat frame).
      this.frameEl = document.createElement("div");
      this.frameEl.className = "teso-chat__frame";
      Object.assign(this.frameEl.style, {
        position: "absolute",
        left: "0",
        right: "0",
        top: "0",
        bottom: "0",
        display: "flex",
        flexDirection: "column",
        padding: "18px 24px 20px",
        boxSizing: "border-box",
      });
      this.element.appendChild(this.frameEl);

      // Title + gold rhombus divider (Elder Scrolls HUD header).
      const title = document.createElement("div");
      title.style.cssText =
        `font-family:${FONT_DISPLAY};color:${GOLD};text-align:center;font-size:14px;` +
        `letter-spacing:2px;text-transform:uppercase;flex-shrink:0;`;
      title.textContent = "Game Chat";
      this.frameEl.appendChild(title);

      const divider = this._buildDivider();
      divider.style.cssText += "flex-shrink:0;";
      this.frameEl.appendChild(divider);

      // Scroll viewport (fills the remaining height, trims overflow).
      this.messagesScroller = document.createElement("div");
      this.messagesScroller.className = "teso-chat__viewport";
      this.messagesScroller.style.cssText =
        "flex:1;min-height:0;overflow:hidden;margin-top:10px;";
      this.frameEl.appendChild(this.messagesScroller);

      // Inner list: pinned to the bottom while short, scrolls once it overflows.
      this.messagesInner = document.createElement("div");
      this.messagesInner.className = "teso-chat__list";
      this.messagesInner.style.cssText =
        "display:flex;flex-direction:column;justify-content:flex-end;min-height:100%;gap:10px;";
      this.messagesScroller.appendChild(this.messagesInner);

      this._applyPerspective();
      this.bindEvents();
    }

    onUnmount() {
      if (this.frameEl) this.frameEl.innerHTML = "";
      this.frameEl = null;
      this.messagesScroller = null;
      this.messagesInner = null;
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective) this._applyPerspective();
    }

    // Panel surface matching the Recent events widget: filled panel, border,
    // radius, drop shadow/glow + gold corner brackets (brackets2 decoration).
    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(13, 17, 15, 0.92)";
      const blur = (read && read("--panel-blur")) || "4px";
      const border = (read && read("--panel-border")) || "1px solid #a38652";
      const radius = (read && read("--panel-radius")) || "2px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow =
        (read && read("--panel-glow")) ||
        "0 0 15px rgba(199,167,92,0.35), inset 0 0 30px rgba(199,167,92,0.05)";

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
        const ry = -(v * 0.15);
        const rx = v * 0.03;
        this.element.style.transform = `perspective(1200px) rotateY(${ry}deg) rotateX(${rx}deg)`;
        this.element.style.transformStyle = "preserve-3d";
      } else {
        this.element.style.transform = "";
        this.element.style.transformStyle = "";
      }
    }

    // Gold line — rhombus — gold line divider (the TESO HUD separator).
    _buildDivider() {
      const divider = document.createElement("div");
      divider.className = "teso-chat__divider";
      divider.style.cssText =
        "display:flex;align-items:center;justify-content:center;margin:8px 0 0;";

      const left = document.createElement("div");
      left.style.cssText =
        `flex:1;height:1px;background:linear-gradient(90deg,transparent,rgba(199,167,92,0.4),transparent);`;
      const rhombus = document.createElement("div");
      rhombus.style.cssText =
        `width:6px;height:6px;background:${GOLD};transform:rotate(45deg);` +
        `margin:0 10px;box-shadow:0 0 5px ${GOLD};flex-shrink:0;`;
      const right = document.createElement("div");
      right.style.cssText =
        `flex:1;height:1px;background:linear-gradient(90deg,transparent,rgba(199,167,92,0.4),transparent);`;

      divider.appendChild(left);
      divider.appendChild(rhombus);
      divider.appendChild(right);
      return divider;
    }

    bindEvents() {
      this.subscribe(this.context.EVENT_TYPES.CHAT_MESSAGE, (msg) => this.pushMessage(msg));
    }

    pushMessage(msg) {
      if (!this.messagesInner || !msg) return;
      const { escapeHtml, renderEmotes } = this.context;

      const row = document.createElement("div");
      row.className = "teso-chat__row";
      row.style.cssText =
        `font-family:${FONT_BODY};font-size:13px;line-height:1.5;color:${TEXT};` +
        "text-shadow:1px 1px 2px rgba(0,0,0,0.9);";

      const text = renderEmotes ? renderEmotes(msg.message, msg.emotes) : escapeHtml(msg.message);

      row.innerHTML =
        `<span style="color:${GOLD_BRIGHT};font-weight:600;">${escapeHtml(msg.user)}</span>` +
        `<span style="color:${MUTED};">:</span>` +
        ` <span style="color:${TEXT};word-break:break-word;">${text}</span>`;

      this.messagesInner.appendChild(row);

      // Hard limit: drop the oldest rows so the DOM never grows unbounded.
      while (this.messagesInner.children.length > MAX_MESSAGES) {
        this.messagesInner.firstChild.remove();
      }

      this.messagesScroller.scrollTop = this.messagesScroller.scrollHeight;

      // Entrance: fade + slide in from the left.
      if (row.animate) {
        row.animate(
          [
            { opacity: 0, transform: "translateX(-14px)" },
            { opacity: 1, transform: "translateX(0)" },
          ],
          { duration: 220, easing: "ease-out" }
        );
      }
    }
  }

  return WidgetTesoChat;
});
