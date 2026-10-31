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
  WidgetWin98Chat — чат стрима в окне Windows 98.

  Синий градиентный заголовок с именем окна «Чат» и серыми кнопками, ниже —
  вдавленное белое поле списка, как в проводнике 98-й. Ник зрителя окрашен в
  цвет активного заголовка, время набрано терминальным VT323. Разделители
  строк — пунктир, чтобы длинный список читался как список файлов.

  Тема изолирована жёстко: на чужой теме не строится ни DOM, ни подписки.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetWin98Chat = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetWin98Chat;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetWin98Chat = WidgetWin98Chat;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_BG = "#c0c0c0";
  const DEFAULT_BORDER = "1px solid #808080";
  const DEFAULT_GLOW =
    "inset 1px 1px 0 #ffffff, inset -1px -1px 0 #000000, inset 2px 2px 0 #dfdfdf, inset -2px -2px 0 #808080";
  const DEFAULT_TEXT = "#000000";
  const DEFAULT_MUTED = "#404040";
  const DEFAULT_PRIMARY = "#000080";

  const FONT_BODY = "var(--font-body, 'Pixelify Sans', 'Segoe UI', sans-serif)";
  const FONT_MONO = "var(--font-mono, 'VT323', 'Consolas', monospace)";

  const DEFAULT_MAX_MESSAGES = 50;
  const MAX_MESSAGES_LIMIT = 200;

  // Лимит строк из инспектора (1..100). Мусор в конфиге не должен снимать
  // лимит: иначе DOM рос бы безгранично за многочасовой эфир.
  function clampMaxMessages(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_MESSAGES;
    return Math.min(MAX_MESSAGES_LIMIT, n);
  }

  class WidgetWin98Chat extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;
      this.primaryColor = DEFAULT_PRIMARY;

      this.windowEl = null;
      this.titleEl = null;
      this.messagesScroller = null;
      this.messagesInner = null;
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не строим DOM и не подписываемся.
      if (this.theme !== "win98") return;

      this._readColors();

      this.element.classList.add("win98-surface");
      this._applySurface();

      this.windowEl = document.createElement("div");
      this.windowEl.className = "win98-window";
      this.element.appendChild(this.windowEl);

      const titlebar = document.createElement("div");
      titlebar.className = "win98-window__titlebar";
      this.windowEl.appendChild(titlebar);

      this.titleEl = document.createElement("span");
      this.titleEl.className = "win98-window__title";
      this.titleEl.textContent = this.context.t("editor.chat");
      titlebar.appendChild(this.titleEl);

      const buttons = document.createElement("span");
      buttons.className = "win98-window__buttons";
      buttons.innerHTML = `<i class="win98-window__btn"></i><i class="win98-window__btn"></i>`;
      titlebar.appendChild(buttons);

      const client = document.createElement("div");
      client.className = "win98-window__client";
      this.windowEl.appendChild(client);

      this.messagesScroller = document.createElement("div");
      this.messagesScroller.className = "win98-sunken";
      this.messagesScroller.style.cssText =
        "flex:1 1 auto;min-height:0;overflow:hidden;padding:3px 5px;box-sizing:border-box;";
      client.appendChild(this.messagesScroller);

      this.messagesInner = document.createElement("div");
      this.messagesInner.className = "win98-chat__list";
      this.messagesInner.style.cssText =
        "display:flex;flex-direction:column;justify-content:flex-end;min-height:100%;";
      this.messagesScroller.appendChild(this.messagesInner);

      this._applyPerspective();
      this.bindEvents();
    }

    onUnmount() {
      if (this.windowEl) this.windowEl.innerHTML = "";
      this.windowEl = null;
      this.titleEl = null;
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
      this.primaryColor = (read && read("--md-primary")) || DEFAULT_PRIMARY;
    }

    _applySurface() {
      const read = this.context.readCssVar;
      const style = this.element.style;

      const bg = (read && read("--panel-bg")) || DEFAULT_BG;
      const border = (read && read("--panel-border")) || DEFAULT_BORDER;
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const glow = (read && read("--panel-glow")) || DEFAULT_GLOW;

      style.backgroundColor = bg;
      style.backgroundImage = "none";
      style.backdropFilter = "none";
      style.webkitBackdropFilter = "none";
      style.border = border;
      style.borderRadius = radius;
      style.clipPath = clip;
      style.boxShadow = glow;
    }

    _applyPerspective() {
      const value = Math.max(0, Math.min(100, Number(this.config.perspective) || 0));
      if (value > 0) {
        const ry = -(value * 0.15);
        const rx = value * 0.03;
        this._setTilt(`perspective(1200px) rotateY(${ry}deg) rotateX(${rx}deg)`);
      } else {
        this._setTilt("");
      }
    }

    bindEvents() {
      this.subscribe(this.context.EVENT_TYPES.CHAT_MESSAGE, (message) => this.pushMessage(message));
    }

    pushMessage(message) {
      if (!this.messagesInner || !message) return;
      const { escapeHtml, escapeAttr, renderEmotes } = this.context;

      const row = document.createElement("div");
      row.className = "win98-chat__row";
      row.style.cssText =
        `font-family:${FONT_BODY};font-size:13px;line-height:1.35;color:${this.textColor};` +
        `padding:2px 3px;box-sizing:border-box;border-bottom:1px dotted rgba(0,0,0,0.18);` +
        `overflow-wrap:anywhere;word-break:break-word;`;

      const time = this.config.showTime === false ? "" : BaseWidget.clockTime();
      const badges = (message.badges || [])
        .slice(0, 3)
        .map((badge, index) => {
          const url = message.badgeImages && message.badgeImages[index];
          return url
            ? `<img src="${escapeAttr(url)}" alt="" title="${escapeAttr(String(badge))}" style="width:1.05em;height:1.05em;object-fit:contain;vertical-align:-0.15em" />`
            : `<span style="color:${this.primaryColor};font-weight:700;">${escapeHtml(String(badge).slice(0, 1).toUpperCase())}</span>`;
        })
        .join(" ");
      const userColor = message.color || this.primaryColor;
      const text = renderEmotes ? renderEmotes(message.message, message.emotes) : escapeHtml(message.message);

      row.innerHTML =
        (time ? `<span style="color:${this.mutedColor};font-family:${FONT_MONO};font-size:13px;">[${escapeHtml(time)}]</span> ` : "") +
        (badges ? `${badges} ` : "") +
        `<span style="color:${escapeAttr(userColor)};font-weight:700;">${escapeHtml(message.user)}</span>` +
        `<span style="color:${this.mutedColor};">:</span> ` +
        `<span style="color:${this.textColor};">${text}</span>`;

      this.messagesInner.appendChild(row);

      const maxMessages = clampMaxMessages(this.config.maxMessages);
      while (this.messagesInner.children.length > maxMessages) {
        this.messagesInner.firstChild.remove();
      }

      this.messagesScroller.scrollTop = this.messagesScroller.scrollHeight;

      if (row.animate) {
        row.animate(
          [
            { opacity: 0, transform: "translateY(4px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 140, easing: "ease-out" }
        );
      }
    }
  }

  return WidgetWin98Chat;
});
