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
  WidgetTerminalChat — чат стрима как вывод консоли.

  Никаких аватарок и рамок: моноширинная строка `[чч:мм] ник: текст`, ник
  синим консольным цветом, сообщение — цветом текста темы. Заголовок — вкладка
  терминала с приглашением `root@ose-chat:~#`.

  Тема изолирована жёстко: на чужой теме не строится ни DOM, ни подписки.
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
  const WidgetTerminalChat = factory(BaseWidget, AlertTyping);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetTerminalChat;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetTerminalChat = WidgetTerminalChat;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget, AlertTyping) {
  "use strict";

  const DEFAULT_BG = "rgba(13, 17, 23, 0.92)";
  const DEFAULT_BORDER = "1px solid #30363d";
  const DEFAULT_GLOW = "0 0 18px rgba(0, 255, 102, 0.25)";
  const DEFAULT_TEXT = "#c9d1d9";
  const DEFAULT_MUTED = "#8b949e";
  const DEFAULT_ACCENT = "#58a6ff";

  const DEFAULT_MAX_MESSAGES = 50;
  const MAX_MESSAGES_LIMIT = 200;

  // Лимит строк из инспектора (1..200). Мусор в конфиге не должен снимать
  // лимит: иначе DOM рос бы безгранично за многочасовой эфир.
  function clampMaxMessages(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_MESSAGES;
    return Math.min(MAX_MESSAGES_LIMIT, n);
  }

  class WidgetTerminalChat extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;
      this.accentColor = DEFAULT_ACCENT;

      this.windowEl = null;
      this.messagesScroller = null;
      this.messagesInner = null;
      this._typing = null;
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не строим DOM и не подписываемся.
      if (this.theme !== "terminal") return;

      this._readColors();
      this.element.classList.add("terminal-surface");
      this._applySurface();

      this.windowEl = document.createElement("div");
      this.windowEl.className = "terminal-window";
      this.element.appendChild(this.windowEl);

      const tab = document.createElement("div");
      tab.className = "terminal-tab";
      tab.innerHTML =
        '<span class="terminal-tab__prompt">root@ose-chat:~#</span>' +
        `<span class="terminal-tab__title">${this.context.t("editor.chat")}</span>` +
        '<span class="terminal-tab__dots"><i class="terminal-tab__dot"></i><i class="terminal-tab__dot"></i><i class="terminal-tab__dot"></i></span>';
      this.windowEl.appendChild(tab);

      const body = document.createElement("div");
      body.className = "terminal-body";
      body.style.padding = "4px 9px";
      this.windowEl.appendChild(body);

      this.messagesScroller = document.createElement("div");
      this.messagesScroller.style.cssText = "flex:1 1 auto;min-height:0;overflow:hidden;";
      body.appendChild(this.messagesScroller);

      this.messagesInner = document.createElement("div");
      this.messagesInner.style.cssText =
        "display:flex;flex-direction:column;justify-content:flex-end;min-height:100%;";
      this.messagesScroller.appendChild(this.messagesInner);

      this._applyPerspective();
      this.bindEvents();
    }

    onUnmount() {
      this._stopTyping();
      if (this.windowEl) this.windowEl.innerHTML = "";
      this.windowEl = null;
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
      this.accentColor = (read && read("--term-accent")) || DEFAULT_ACCENT;
    }

    _applySurface() {
      const read = this.context.readCssVar;
      const style = this.element.style;

      const bg = (read && read("--panel-bg")) || DEFAULT_BG;
      const border = (read && read("--panel-border")) || DEFAULT_BORDER;
      const radius = (read && read("--panel-radius")) || "6px";
      const glow = (read && read("--panel-glow")) || DEFAULT_GLOW;

      style.backgroundColor = bg;
      style.backgroundImage = "none";
      style.backdropFilter = "none";
      style.webkitBackdropFilter = "none";
      style.border = border;
      style.borderRadius = radius;
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
      const { escapeHtml, renderEmotes } = this.context;

      const row = document.createElement("div");
      row.style.cssText =
        `font-family:var(--font-mono);font-size:13px;line-height:1.35;color:${this.textColor};` +
        "padding:1px 0;overflow-wrap:anywhere;word-break:break-word;white-space:pre-wrap;";

      const time = this.config.showTime === false ? "" : BaseWidget.clockTime();
      const userColor = message.color || this.accentColor;
      const text = renderEmotes ? renderEmotes(message.message, message.emotes) : escapeHtml(message.message);

      // Строка как в tail -f: время приглушено, ник — синим, текст — основным.
      row.innerHTML =
        (time ? `<span style="color:${this.mutedColor};">[${escapeHtml(time)}]</span> ` : "") +
        `<span style="color:${escapeHtml(userColor)};">${escapeHtml(message.user)}</span>` +
        `<span style="color:${this.mutedColor};">:</span> `;

      // Текст — отдельным узлом: его печатаем посимвольно, как вывод в
      // терминале, а время и ник появляются сразу.
      const textEl = document.createElement("span");
      textEl.innerHTML = text;
      row.appendChild(textEl);

      this.messagesInner.appendChild(row);

      const maxMessages = clampMaxMessages(this.config.maxMessages);
      while (this.messagesInner.children.length > maxMessages) {
        this.messagesInner.firstChild.remove();
      }

      this._scrollToEnd();
      this._typeMessage(textEl);

      if (row.animate) {
        row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 90, easing: "linear" });
      }
    }

    // Печать сообщения, как в алерте Terminal. Новый текст начинает печататься
    // сразу, а недопечатанное предыдущее сообщение дорисовывается мгновенно:
    // в живом чате ждать очереди нельзя, иначе печать отстаёт от эфира.
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

    // Строка растёт по мере печати — держим прокрутку внизу.
    _scrollToEnd() {
      if (!this.messagesScroller) return;
      this.messagesScroller.scrollTop = this.messagesScroller.scrollHeight;
    }
  }

  return WidgetTerminalChat;
});
