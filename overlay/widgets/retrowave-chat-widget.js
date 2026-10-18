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
  WidgetRetrowaveChat — stream chat on a neon synthwave panel.

  The header is a marker, an Orbitron label and a cyan→magenta rule; each message
  sits on a cut-corner chip with a gradient leading bar, so the chat repeats the
  panel language instead of looking like a generic message list. Times and the
  amount-like data stay monospaced, usernames take the theme accent.

  Theme isolation: hard-gated to "retrowave" in onMount() and via the manager
  (shouldMount / resolveRenderType using the catalog `theme` field).
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetRetrowaveChat = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetRetrowaveChat;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetRetrowaveChat = WidgetRetrowaveChat;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_TEXT = "#f3e8ff"; // --md-on-surface
  const DEFAULT_MUTED = "#c3b0e0"; // --md-on-surface-variant
  const DEFAULT_USER = "#ff2d95"; // --md-primary
  const DEFAULT_SECONDARY = "#2de2e6"; // --md-secondary

  const FONT_DISPLAY = "'Orbitron', 'Segoe UI', sans-serif";
  const FONT_BODY = "'Montserrat', 'Segoe UI', sans-serif";
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

  class WidgetRetrowaveChat extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;
      this.userColor = DEFAULT_USER;
      this.secondaryColor = DEFAULT_SECONDARY;

      this.frameEl = null;
      this.messagesScroller = null;
      this.messagesInner = null;
    }

    onMount() {
      // HARD theme gate: no DOM, no events on a foreign theme.
      if (this.theme !== "retrowave") return;

      this._readColors();

      this.element.classList.add("retrowave-surface", "retrowave-chat-surface");
      this._applySurface();

      const frame = document.createElement("div");
      frame.className = "retrowave-chat__frame";
      Object.assign(frame.style, {
        position: "absolute",
        left: "0",
        right: "0",
        top: "0",
        bottom: "0",
        display: "flex",
        flexDirection: "column",
        padding: "18px 18px 18px 32px",
        boxSizing: "border-box",
      });
      this.element.appendChild(frame);
      this.frameEl = frame;

      const { t, escapeHtml } = this.context;
      const header = document.createElement("div");
      header.className = "retrowave-chat__header";
      header.style.cssText =
        `display:flex;align-items:center;gap:9px;flex-shrink:0;font-family:${FONT_DISPLAY};` +
        `color:${this.textColor};text-transform:uppercase;letter-spacing:2px;font-size:11px;font-weight:700;`;
      header.innerHTML =
        `<span style="width:7px;height:7px;background:${this.userColor};box-shadow:0 0 8px ${this.userColor};transform:rotate(45deg);flex-shrink:0;"></span>` +
        `<span>${escapeHtml(t("editor.chat"))}</span>` +
        `<span style="flex:1;height:1px;background:linear-gradient(90deg,${this.secondaryColor},${this.userColor} 60%,transparent);box-shadow:0 0 8px rgba(255,45,149,0.5);"></span>`;
      frame.appendChild(header);

      this.messagesScroller = document.createElement("div");
      this.messagesScroller.className = "retrowave-chat__viewport";
      this.messagesScroller.style.cssText = "flex:1;min-height:0;overflow:hidden;margin-top:12px;";
      frame.appendChild(this.messagesScroller);

      this.messagesInner = document.createElement("div");
      this.messagesInner.className = "retrowave-chat__list";
      this.messagesInner.style.cssText =
        "display:flex;flex-direction:column;justify-content:flex-end;min-height:100%;gap:6px;";
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
      this.secondaryColor = (read && read("--md-secondary")) || DEFAULT_SECONDARY;
    }

    // Panel surface from the theme's tokens so the chat shares one background
    // with the goal and the alert.
    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(13, 7, 25, 0.88)";
      const blur = (read && read("--panel-blur")) || "0px";
      const border = (read && read("--panel-border")) || "2px solid rgba(255, 45, 149, 0.8)";
      const radius = (read && read("--panel-radius")) || "0px";
      // Чат высокий, и текст стоит близко к ведущей кромке: общий срез 26px
      // съедал первые строки. Здесь кромка мягче, её повторяет
      // `.retrowave-chat-surface::before` в shared/widgets.css.
      const clip = "polygon(18px 0, 100% 0, 100% 100%, 0 100%)";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow = (read && read("--panel-glow")) || "0 0 18px rgba(255,45,149,0.35)";

      // An empty backgroundImage lets the grid from `.retrowave-surface` show.
      s.backgroundColor = bg;
      s.backgroundImage = "";
      s.backdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.webkitBackdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.border = border;
      s.borderRadius = radius;
      s.clipPath = clip;
      s.boxShadow = `${elev}, ${glow}`;
    }

    // Perspective tilt (0-100) from the chat inspector.
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
      row.className = "retrowave-chat__row";
      row.style.cssText =
        `font-family:${FONT_BODY};font-size:14px;line-height:1.45;color:${this.textColor};` +
        "padding:3px 8px 3px 11px;box-sizing:border-box;background:linear-gradient(90deg,rgba(255,45,149,0.10),rgba(5,2,11,0.30) 42%,transparent);" +
        "border-left:2px solid rgba(45,226,230,0.55);box-shadow:inset 3px 0 8px -4px rgba(45,226,230,0.9);";

      const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const badges = (msg.badges || [])
        .slice(0, 3)
        .map((b, i) => {
          const url = msg.badgeImages && msg.badgeImages[i];
          return url
            ? `<img src="${escapeAttr(url)}" alt="" title="${escapeAttr(String(b))}" style="width:1.05em;height:1.05em;object-fit:contain;vertical-align:-0.15em" />`
            : `<span style="color:${this.secondaryColor};font-weight:700;">${escapeHtml(String(b).slice(0, 1).toUpperCase())}</span>`;
        })
        .join(" ");
      const userColor = msg.color || this.userColor;
      const text = renderEmotes ? renderEmotes(msg.message, msg.emotes) : escapeHtml(msg.message);

      row.innerHTML =
        `<span style="color:${this.mutedColor};font-family:${FONT_MONO};font-size:11px;opacity:0.85;">[${escapeHtml(time)}]</span>` +
        (badges ? ` ${badges}` : "") +
        ` <span style="color:${escapeAttr(userColor)};font-weight:700;text-shadow:0 0 10px rgba(255,45,149,0.6);">${escapeHtml(msg.user)}</span>` +
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
            { opacity: 0, transform: "translateX(-10px)" },
            { opacity: 1, transform: "translateX(0)" },
          ],
          { duration: 180, easing: "ease-out" }
        );
      }
    }
  }

  return WidgetRetrowaveChat;
});
