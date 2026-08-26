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
  WidgetCobraChat — orange-HUD stream chat for the Elite Dangerous
  "Cobra Mk II" theme.

  Chat messages render in a DOM container while the background is a filled
  panel surface matching the Recent events widget (var(--panel-bg) + border +
  radius + shadow + scanline texture + corner brackets). No neon HUD frame.

  Theme isolation: hard-gated to "cobra-mk2" in onMount() and via the manager
  (shouldMount / resolveRenderType using the catalog `theme` field).
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetCobraChat = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetCobraChat;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetCobraChat = WidgetCobraChat;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const AMBER = "#ffaa00";
  const TEXT_COLOR = "#dcebf5";
  const MUTED = "#8ab4d0";
  const MAX_MESSAGES = 50;

  class WidgetCobraChat extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.messagesEl = null;
      this.messagesScroller = null;
      this.messagesInner = null;
      this._glitchTimer = null;
      this._glitchStylesReady = false;
    }

    onMount() {
      // HARD theme gate: no DOM, no events on a non-Cobra Mk II theme.
      if (this.theme !== "cobra-mk2") return;

      // Panel surface + corner brackets/scanlines, driven by the active theme's
      // --panel-decoration token (same decoration language as Recent events).
      this.element.classList.add("elite-surface");
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
      this.messagesScroller.className = "cobra-chat__viewport";
      this.messagesScroller.style.cssText = "height:100%;overflow:hidden;";
      this.messagesEl.appendChild(this.messagesScroller);

      // Inner list: pinned to the bottom while short (min-height:100% +
      // flex-end), and grows past the viewport when it overflows so the viewport
      // scrolls instead of bleeding messages past the frame.
      this.messagesInner = document.createElement("div");
      this.messagesInner.className = "cobra-chat__list";
      this.messagesInner.style.cssText =
        "display:flex;flex-direction:column;justify-content:flex-end;min-height:100%;";
      this.messagesScroller.appendChild(this.messagesInner);

      this._applyPerspective();
      this._ensureGlitchStyles();
      this._startGlitchLoop();
      this.bindEvents();
    }

    onUnmount() {
      if (this._glitchTimer) {
        clearTimeout(this._glitchTimer);
        this._glitchTimer = null;
      }
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

      const bg = (read && read("--panel-bg")) || "rgba(10, 8, 6, 0.92)";
      const blur = (read && read("--panel-blur")) || "0px";
      const border = (read && read("--panel-border")) || "1px solid rgba(255, 118, 5, 0.35)";
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow =
        (read && read("--panel-glow")) ||
        "0 0 15px rgba(255,118,5,0.28), inset 0 0 30px rgba(255,118,5,0.04)";

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

    // One shared <style> block for the Star Citizen-style holographic glitch:
    // a persistent RGB channel split plus an occasional "tear" burst on a row.
    _ensureGlitchStyles() {
      if (this._glitchStylesReady) return;
      this._glitchStylesReady = true;

      const id = "cobra-chat-glitch-styles";
      if (document.getElementById(id)) return;

      const style = document.createElement("style");
      style.id = id;
      style.textContent =
        ".cobra-chat__row {" +
        "text-shadow:0.6px 0 0 rgba(255,118,5,0.28),-0.6px 0 0 rgba(0,210,255,0.22);" +
        "}" +
        ".cobra-chat__row.cobra-glitch {" +
        "animation:cobra-chat-glitch 0.34s steps(2,end) both;" +
        "}" +
        "@keyframes cobra-chat-glitch {" +
        "0% { transform:translateX(0); filter:none; }" +
        "8% { transform:translateX(-2px) skewX(-2deg); text-shadow:2px 0 rgba(255,118,5,0.95),-2px 0 rgba(0,210,255,0.95); }" +
        "16% { transform:translateX(2px) skewX(1deg); filter:brightness(1.3); }" +
        "24% { transform:translateX(-1px); text-shadow:-2px 0 rgba(255,118,5,0.95),2px 0 rgba(0,210,255,0.95); }" +
        "32% { transform:translateX(1px) skewX(2deg); filter:none; }" +
        "40% { transform:translateX(0); text-shadow:3px 0 rgba(255,118,5,0.6),-3px 0 rgba(0,210,255,0.6); }" +
        "100% { transform:translateX(0); text-shadow:0.6px 0 rgba(255,118,5,0.28),-0.6px 0 rgba(0,210,255,0.22); }" +
        "}";
      document.head.appendChild(style);
    }

    // Ambient glitch: occasionally fire a burst on a random visible row so the
    // hologram feels alive, matching the Star Citizen HUD flicker.
    _startGlitchLoop() {
      const tick = () => {
        this._glitchBurst();
        this._glitchTimer = setTimeout(tick, 1200 + Math.random() * 2600);
      };
      this._glitchTimer = setTimeout(tick, 900);
    }

    _glitchBurst(targetRow) {
      if (!this.messagesInner) return;

      let row = targetRow;
      if (!row) {
        const rows = this.messagesInner.children;
        if (!rows.length) return;
        row = rows[Math.floor(Math.random() * rows.length)];
      }
      if (!row || row.classList.contains("cobra-glitch")) return;

      // Force a reflow so a second burst on the same row retriggers cleanly.
      void row.offsetWidth;
      row.classList.add("cobra-glitch");
      const onEnd = () => {
        row.classList.remove("cobra-glitch");
        row.removeEventListener("animationend", onEnd);
      };
      row.addEventListener("animationend", onEnd);
    }

    bindEvents() {
      this.subscribe(this.context.EVENT_TYPES.CHAT_MESSAGE, (msg) => this.pushMessage(msg));
    }

    pushMessage(msg) {
      if (!this.messagesEl || !msg) return;
      const { escapeHtml, escapeAttr, renderEmotes } = this.context;

      const row = document.createElement("div");
      row.className = "cobra-chat__row";
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
        ` <span style="color:${escapeAttr(AMBER)};font-weight:700;">${escapeHtml(msg.user)}</span>` +
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

      // New messages occasionally materialize with a holographic glitch burst
      // (delayed past the entrance slide so the two transforms don't fight).
      if (Math.random() < 0.35) {
        setTimeout(() => this._glitchBurst(row), 240);
      }
    }
  }

  return WidgetCobraChat;
});
