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
  WidgetTerminalRecent — «Последние события» как вывод системного лога.

  Вместо карточек с цветной точкой — строки `[OK] [12:04] текст`: тег события,
  время и подпись. Окно — терминальная панель с вкладкой и строкой состояния.
  Наследуем общий 3D-виджет событий: фильтр категорий, лимит строк и
  анимация появления остаются теми же, меняются только разметка строки и
  корпус.

  Тема изолирована жёстко: на чужой теме не строится ни DOM, ни подписки.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const RecentWidget3d =
    typeof module !== "undefined" && module.exports
      ? require("./recent-widget-3d")
      : root.OSEWidgets && root.OSEWidgets.RecentWidget3d;
  const WidgetTerminalRecent = factory(BaseWidget, RecentWidget3d);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetTerminalRecent;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetTerminalRecent = WidgetTerminalRecent;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget, RecentWidget3d) {
  "use strict";

  const DEFAULT_BG = "rgba(13, 17, 23, 0.92)";
  const DEFAULT_BORDER = "1px solid #30363d";
  const DEFAULT_GLOW = "0 0 18px rgba(0, 255, 102, 0.25)";
  const DEFAULT_MUTED = "#8b949e";
  const DEFAULT_PROMPT = "#00ff66";

  // Теги строк: короткие и латиницей, как у `journalctl`. Незнакомое событие
  // остаётся `[LOG]`, чтобы строка не выпадала из общего ритма.
  const TAGS = {
    follow: "[FOLLOW]",
    sub: "[SUB]",
    resub: "[RESUB]",
    gift_sub: "[GIFT]",
    cheer: "[CHEER]",
    donation: "[DONATE]",
    reward: "[REWARD]",
    boosty_sub: "[BOOSTY]",
    boosty_resub: "[BOOSTY]",
  };

  function eventKind(event) {
    const kind = String((event && event.kind) || "");
    if (kind === "sub" && event && event.resub === true) return "resub";
    return kind;
  }

  class WidgetTerminalRecent extends RecentWidget3d {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.mutedColor = DEFAULT_MUTED;
      this.promptColor = DEFAULT_PROMPT;

      this.windowEl = null;
      this.statusEl = null;
      this._emptyEl = null;
    }

    onMount() {
      if (this.theme !== "terminal") return;

      this._readColors();
      this._applyPerspective();
      this.element.classList.add("terminal-surface", "terminal-recent");
      this._applySurface();
      this._applyCrt();
      this._applyCrtFont();

      this.windowEl = document.createElement("div");
      this.windowEl.className = "terminal-window";
      this.element.appendChild(this.windowEl);

      const tab = document.createElement("div");
      tab.className = "terminal-tab";
      const promptSpan = document.createElement("span");
      promptSpan.className = "terminal-tab__prompt";
      promptSpan.textContent = "root@ose-log:~#";
      tab.appendChild(promptSpan);
      this.titleEl = document.createElement("span");
      this.titleEl.className = "terminal-tab__title";
      tab.appendChild(this.titleEl);
      const dots = document.createElement("span");
      dots.className = "terminal-tab__dots";
      for (let i = 0; i < 3; i += 1) {
        const dot = document.createElement("i");
        dot.className = "terminal-tab__dot";
        dots.appendChild(dot);
      }
      tab.appendChild(dots);
      this.windowEl.appendChild(tab);

      const body = document.createElement("div");
      body.className = "terminal-body";
      body.style.cssText = "gap:1px;padding:5px 9px 6px;justify-content:flex-start;";
      this.windowEl.appendChild(body);

      this.listEl = document.createElement("div");
      this.listEl.className = "widget-recent__list widget-recent3d__list terminal-log";
      body.appendChild(this.listEl);

      // `refresh()` пишет длительность анимации в `--recent-animation` на хосте.
      this.host = this.windowEl;

      this.statusEl = document.createElement("div");
      this.statusEl.className = "terminal-status";
      this.windowEl.appendChild(this.statusEl);

      this.nodes = new Map();
      this.renderedKeys = [];

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.RECENT_EVENT, () => this.refresh());
      this.subscribe(EVENT_TYPES.LOCALES, () => this.refresh(true));
      this.refresh(true);
    }

    onUnmount() {
      this.windowEl = null;
      this.statusEl = null;
      this.listEl = null;
      this.titleEl = null;
      this._emptyEl = null;
    }

    onUpdate(prev, next) {
      super.onUpdate(prev, next);
      if (prev.crt !== next.crt) this._applyCrt();
      if (prev.crtFont !== next.crtFont) this._applyCrtFont();
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
      this.promptColor = (read && read("--term-prompt")) || DEFAULT_PROMPT;
    }

    _applySurface() {
      const read = this.context.readCssVar;
      const style = this.element.style;
      style.backgroundColor = (read && read("--panel-bg")) || DEFAULT_BG;
      style.backgroundImage = "none";
      style.backdropFilter = "none";
      style.webkitBackdropFilter = "none";
      style.border = (read && read("--panel-border")) || DEFAULT_BORDER;
      style.borderRadius = (read && read("--panel-radius")) || "6px";
      style.boxShadow = (read && read("--panel-glow")) || DEFAULT_GLOW;
    }

    _applyCrt() {
      const on = this.config.crt !== false;
      if (this.element && this.element.dataset) {
        this.element.dataset.crt = on ? "on" : "off";
      }
    }

    // VT323 вместо JetBrains Mono — «старый монитор» по тумблеру в инспекторе.
    _applyCrtFont() {
      this.element.classList.toggle("is-crt-font", this.config.crtFont === true);
    }

    refresh(immediate = false) {
      if (this._emptyEl && this._emptyEl.parentNode) {
        this._emptyEl.parentNode.removeChild(this._emptyEl);
      }
      this._emptyEl = null;

      super.refresh(immediate);

      if (this.listEl && !this.listEl.children.length) {
        this._emptyEl = document.createElement("div");
        this._emptyEl.className = "terminal-log__empty";
        this._emptyEl.textContent = this.context.t("recent.empty");
        this.listEl.appendChild(this._emptyEl);
      }

      if (this.statusEl) {
        const escapeHtml = this.context.escapeHtml || ((value) => String(value));
        this.statusEl.innerHTML =
          '<span class="terminal-status__flag is-idle">[ONLINE]</span>' +
          '<span>log</span>' +
          `<span class="terminal-status__spacer">${escapeHtml(BaseWidget.clockTime())}</span>`;
      }
    }

    createItem(event, entering) {
      const node = super.createItem(event, entering);
      if (node.classList) node.classList.add("terminal-log__item");
      return node;
    }

    updateItem(node, event) {
      const { escapeHtml } = this.context;
      const escape = escapeHtml || ((value) => String(value));
      const kind = eventKind(event);
      node.dataset.kind = event.kind || "";
      const time = this._time(event);
      node.innerHTML =
        `<span class="terminal-log__tag">${escape(TAGS[kind] || "[LOG]")}</span>` +
        (time ? `<span class="terminal-log__time">${escape(time)}</span>` : "") +
        `<span class="terminal-log__text">${this._text(event)}</span>`;
    }

    // Время события: сервер присылает `at` в миллисекундах. Без него строка
    // остаётся без отметки, а не с выдуманным «00:00».
    _time(event) {
      const at = Number(event && event.at);
      if (!Number.isFinite(at) || at <= 0) return "";
      const date = new Date(at);
      const pad = (value) => String(value).padStart(2, "0");
      return `[${pad(date.getHours())}:${pad(date.getMinutes())}]`;
    }
  }

  return WidgetTerminalRecent;
});
