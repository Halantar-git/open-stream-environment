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
  WidgetSfChat — чат на панели приборов Super Four.

  Шапка повторяет тахометр в миниатюре: четыре огонька цилиндров вместо
  заголовка-плашки. При новом сообщении они срабатывают по очереди, как
  четырёхцилиндровый двигатель, — это единственная анимация, которую чат
  позволяет себе в эфире. Имя зрителя окрашено янтарными «поворотниками»
  (вторичный акцент темы), время и цифры остаются моноширинными.

  Тема изолирована жёстко: на чужой теме не строится ни DOM, ни подписки.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetSfChat = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetSfChat;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetSfChat = WidgetSfChat;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_TEXT = "#f3e8ff"; // --md-on-surface
  const DEFAULT_MUTED = "#cbb8de"; // --md-on-surface-variant
  const DEFAULT_USER = "#f59e0b"; // --md-secondary, янтарные «поворотники»
  const DEFAULT_PRIMARY = "#a855f7"; // --md-primary
  const DEFAULT_TERTIARY = "#22d3ee"; // --md-tertiary

  const FONT_DISPLAY = "'Rajdhani', 'Segoe UI', sans-serif";
  const FONT_BODY = "'Manrope', 'Segoe UI', sans-serif";
  const FONT_MONO = "'JetBrains Mono', 'Consolas', monospace";

  const DEFAULT_MAX_MESSAGES = 50;
  const MAX_MESSAGES_LIMIT = 200;

  // Лимит строк из инспектора (1..100). Мусор в конфиге не должен снимать
  // лимит: иначе DOM рос бы безгранично за многочасовой эфир.
  function clampMaxMessages(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_MESSAGES;
    return Math.min(MAX_MESSAGES_LIMIT, n);
  }

  class WidgetSfChat extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;
      this.userColor = DEFAULT_USER;
      this.primaryColor = DEFAULT_PRIMARY;
      this.tertiaryColor = DEFAULT_TERTIARY;

      this.frameEl = null;
      this.headerEl = null;
      this.cylEl = null;
      this.messagesScroller = null;
      this.messagesInner = null;
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не строим DOM и не подписываемся.
      if (this.theme !== "sf") return;

      this._readColors();

      this.element.classList.add("sf-surface", "sf-chat-surface");
      this._applySurface();

      const frame = document.createElement("div");
      frame.className = "sf-chat__frame";
      Object.assign(frame.style, {
        position: "absolute",
        left: "0",
        right: "0",
        top: "0",
        bottom: "0",
        display: "flex",
        flexDirection: "column",
        padding: "14px 14px 14px 16px",
        boxSizing: "border-box",
      });
      this.element.appendChild(frame);
      this.frameEl = frame;

      this.headerEl = document.createElement("div");
      this.headerEl.className = "sf-chat__header";
      this.headerEl.style.cssText =
        `display:flex;align-items:center;gap:9px;flex-shrink:0;font-family:${FONT_DISPLAY};` +
        `color:${this.textColor};text-transform:uppercase;letter-spacing:1.8px;font-size:12px;font-weight:700;`;
      this.headerEl.innerHTML =
        `<span class="sf-chat__cyl"></span>` +
        `<span>${this.context.escapeHtml(this.context.t("editor.chat"))}</span>` +
        `<span style="flex:1;height:1px;background:linear-gradient(90deg,${this.primaryColor},${this.userColor} 70%,transparent);"></span>`;
      frame.appendChild(this.headerEl);

      // Четыре цилиндра: огоньки загораются по очереди на каждом сообщении.
      this.cylEl = this.headerEl.querySelector(".sf-chat__cyl");
      if (this.cylEl) {
        this.cylEl.innerHTML =
          `<i style="--sf-delay:0ms"></i><i style="--sf-delay:70ms"></i><i style="--sf-delay:140ms"></i><i style="--sf-delay:210ms"></i>`;
      }

      this.messagesScroller = document.createElement("div");
      this.messagesScroller.className = "sf-chat__viewport";
      this.messagesScroller.style.cssText = "flex:1;min-height:0;overflow:hidden;margin-top:11px;";
      frame.appendChild(this.messagesScroller);

      this.messagesInner = document.createElement("div");
      this.messagesInner.className = "sf-chat__list";
      this.messagesInner.style.cssText =
        "display:flex;flex-direction:column;justify-content:flex-end;min-height:100%;gap:6px;";
      this.messagesScroller.appendChild(this.messagesInner);

      this._applyPerspective();
      this.bindEvents();
    }

    onUnmount() {
      if (this.frameEl) this.frameEl.innerHTML = "";
      this.frameEl = null;
      this.headerEl = null;
      this.cylEl = null;
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
      this.userColor = (read && read("--md-secondary")) || DEFAULT_USER;
      this.primaryColor = (read && read("--md-primary")) || DEFAULT_PRIMARY;
      this.tertiaryColor = (read && read("--md-tertiary")) || DEFAULT_TERTIARY;
    }

    // Поверхность из токенов темы: одна панель на цель, чат и алерт.
    _applySurface() {
      const read = this.context.readCssVar;
      const style = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(15, 12, 25, 0.9)";
      const blur = (read && read("--panel-blur")) || "12px";
      const border = (read && read("--panel-border")) || "2px solid rgba(168, 85, 247, 0.35)";
      const radius = (read && read("--panel-radius")) || "6px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev = (read && read("--elev-1")) || "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow = (read && read("--panel-glow")) || "0 0 10px rgba(147, 51, 234, 0.5)";

      // Пустая backgroundImage оставляет фактуру из `.sf-surface`.
      style.backgroundColor = bg;
      style.backgroundImage = "";
      style.backdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      style.webkitBackdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      style.border = border;
      style.borderRadius = radius;
      style.clipPath = clip;
      style.boxShadow = `${elev}, ${glow}`;
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

    // Перезапуск CSS-анимации: снять класс, форсировать пересчёт и вернуть —
    // иначе повторное сообщение в том же кадре не перезапустит огоньки.
    _fireCylinders() {
      if (!this.cylEl) return;
      this.cylEl.classList.remove("is-firing");
      void this.cylEl.offsetWidth;
      this.cylEl.classList.add("is-firing");
    }

    pushMessage(message) {
      if (!this.messagesInner || !message) return;
      const { escapeHtml, escapeAttr, renderEmotes } = this.context;

      const row = document.createElement("div");
      row.className = "sf-chat__row";
      row.style.cssText =
        `font-family:${FONT_BODY};font-size:14px;line-height:1.45;color:${this.textColor};` +
        `padding:3px 8px 3px 10px;box-sizing:border-box;background:linear-gradient(90deg,${rgba(this.primaryColor, 0.12)},rgba(8,6,13,0.28) 46%,transparent);` +
        `border-left:2px solid ${rgba(this.userColor, 0.7)};`;

      const time = this.config.showTime === false ? "" : BaseWidget.clockTime();
      const badges = (message.badges || [])
        .slice(0, 3)
        .map((badge, index) => {
          const url = message.badgeImages && message.badgeImages[index];
          return url
            ? `<img src="${escapeAttr(url)}" alt="" title="${escapeAttr(String(badge))}" style="width:1.05em;height:1.05em;object-fit:contain;vertical-align:-0.15em" />`
            : `<span style="color:${this.tertiaryColor};font-weight:700;">${escapeHtml(String(badge).slice(0, 1).toUpperCase())}</span>`;
        })
        .join(" ");
      const userColor = message.color || this.userColor;
      const text = renderEmotes ? renderEmotes(message.message, message.emotes) : escapeHtml(message.message);

      row.innerHTML =
        (time ? `<span style="color:${this.mutedColor};font-family:${FONT_MONO};font-size:11px;opacity:0.85;">[${escapeHtml(time)}]</span>` : "") +
        (badges ? ` ${badges}` : "") +
        ` <span style="color:${escapeAttr(userColor)};font-weight:700;text-shadow:0 0 10px ${rgba(this.userColor, 0.55)};">${escapeHtml(message.user)}</span>` +
        `<span style="color:${this.mutedColor};">:</span>` +
        ` <span style="color:${this.textColor};word-break:break-word;">${text}</span>`;

      this.messagesInner.appendChild(row);

      const maxMessages = clampMaxMessages(this.config.maxMessages);
      while (this.messagesInner.children.length > maxMessages) {
        this.messagesInner.firstChild.remove();
      }

      this.messagesScroller.scrollTop = this.messagesScroller.scrollHeight;
      this._fireCylinders();

      if (row.animate) {
        row.animate(
          [
            { opacity: 0, transform: "translateX(-12px)" },
            { opacity: 1, transform: "translateX(0)" },
          ],
          { duration: 180, easing: "ease-out" }
        );
      }
    }
  }

  // `rgba()` принимает только `#rrggbb`: цвета темы приходят в этом виде, а
  // пользовательский цвет зрителя из Twitch может быть любым — тогда просто
  // оставляем его как есть.
  function rgba(hex, alpha) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!match) return hex;
    const n = parseInt(match[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  return WidgetSfChat;
});
