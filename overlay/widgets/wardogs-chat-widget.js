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
  WidgetWardogsChat — stream chat for the Wardogs HUD theme.

  Messages render in a DOM list over the theme's own panel surface (neutral dark
  background shared with every Wardogs widget). The header is a small marker, an
  uppercase label and a striped rule that echoes the goal bar's loading stripes;
  usernames take the theme accent, text the theme's on-surface colours.

  Theme isolation: hard-gated to "wardogs" in onMount() and via the manager
  (shouldMount / resolveRenderType using the catalog `theme` field).
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetWardogsChat = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetWardogsChat;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetWardogsChat = WidgetWardogsChat;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_TEXT = "#e8e5dd"; // --md-on-surface (wardogs)
  const DEFAULT_MUTED = "#b6b3a7"; // --md-on-surface-variant (wardogs)
  const DEFAULT_USER = "#f0a92c"; // --md-primary (wardogs)
  const FONT_DISPLAY = "'Roboto Condensed', 'Segoe UI', sans-serif";
  const FONT_MONO = "'JetBrains Mono', 'Consolas', monospace";
  const DEFAULT_MAX_MESSAGES = 50;
  const MAX_MESSAGES_LIMIT = 200;

  // Лимит строк берётся из инспектора (1..100). Мусор в конфиге (не число, 0,
  // отрицательное, NaN) не должен снимать лимит — тогда DOM рос бы безгранично.
  function clampMaxMessages(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_MESSAGES;
    return Math.min(MAX_MESSAGES_LIMIT, n);
  }

  class WidgetWardogsChat extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;
      this.userColor = DEFAULT_USER;

      this.frameEl = null;
      this.messagesScroller = null;
      this.messagesInner = null;
    }

    onMount() {
      // HARD theme gate: no DOM, no events on a non-Wardogs theme.
      if (this.theme !== "wardogs") return;

      this._readColors();

      this.element.classList.add("wardogs-chat-surface");
      this._applySurface();

      const frame = document.createElement("div");
      frame.className = "wardogs-chat__frame";
      Object.assign(frame.style, {
        position: "absolute",
        left: "0",
        right: "0",
        top: "0",
        bottom: "0",
        display: "flex",
        flexDirection: "column",
        padding: "14px 16px 16px",
        boxSizing: "border-box",
      });
      this.element.appendChild(frame);
      this.frameEl = frame;

      // Header: marker — label — striped rule (echoes the goal bar's stripes).
      const { t, escapeHtml } = this.context;
      const header = document.createElement("div");
      header.className = "wardogs-chat__header";
      header.style.cssText =
        `display:flex;align-items:center;gap:8px;flex-shrink:0;font-family:${FONT_DISPLAY};` +
        `color:${this.textColor};text-transform:uppercase;letter-spacing:1.6px;font-size:13px;font-weight:700;`;
      header.innerHTML =
        `<span style="width:7px;height:7px;background:${this.userColor};box-shadow:0 0 6px ${this.userColor};flex-shrink:0;"></span>` +
        `<span>${escapeHtml(t("editor.chat"))}</span>` +
        `<span style="flex:1;height:5px;background:repeating-linear-gradient(90deg,${this.mutedColor} 0 2px,transparent 2px 5px);opacity:0.45;"></span>`;
      frame.appendChild(header);

      // Scroll viewport (fills the remaining height, trims overflow).
      this.messagesScroller = document.createElement("div");
      this.messagesScroller.className = "wardogs-chat__viewport";
      this.messagesScroller.style.cssText = "flex:1;min-height:0;overflow:hidden;margin-top:10px;";
      frame.appendChild(this.messagesScroller);

      this.messagesInner = document.createElement("div");
      this.messagesInner.className = "wardogs-chat__list";
      this.messagesInner.style.cssText =
        "display:flex;flex-direction:column;justify-content:flex-end;min-height:100%;gap:7px;";
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

    _readColors() {
      const read = this.context.readCssVar;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
      this.userColor = (read && read("--md-primary")) || DEFAULT_USER;
    }

    // Panel surface from the theme's tokens, so the chat shares one background
    // with every other Wardogs widget.
    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(9, 9, 9, 0.90)";
      const blur = (read && read("--panel-blur")) || "0px";
      const border = (read && read("--panel-border")) || "1px solid rgba(240, 169, 44, 0.26)";
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow = (read && read("--panel-glow")) || "0 0 12px rgba(240, 169, 44, 0.18)";

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

    bindEvents() {
      this.subscribe(this.context.EVENT_TYPES.CHAT_MESSAGE, (msg) => this.pushMessage(msg));
    }

    pushMessage(msg) {
      if (!this.messagesInner || !msg) return;
      const { escapeHtml, escapeAttr, renderEmotes } = this.context;

      const row = document.createElement("div");
      row.className = "wardogs-chat__row";
      row.style.cssText = `font-family:${FONT_DISPLAY};font-size:14px;line-height:1.45;color:${this.textColor};`;

      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
        `<span style="color:${this.mutedColor};font-family:${FONT_MONO};font-size:11px;">[${escapeHtml(time)}]</span>` +
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

  return WidgetWardogsChat;
});
