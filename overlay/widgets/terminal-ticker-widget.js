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
  WidgetTerminalTicker — бегущая строка событий как поток `journalctl -f`.

  Механика ленты (скорость, направление, дублирование трека, срочная полоса)
  остаётся общей: наследуем `WidgetTicker` и меняем только строку — тег
  события латиницей в квадратных скобках, как у системного журнала, и
  разделитель `|` вместо ромба.

  Тема изолирована жёстко: на чужой теме не строится ни DOM, ни подписки.
*/
(function (root, factory) {
  const WidgetTicker =
    typeof module !== "undefined" && module.exports
      ? require("./ticker-widget")
      : root.OSEWidgets && root.OSEWidgets.WidgetTicker;
  const WidgetTerminalTicker = factory(WidgetTicker);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetTerminalTicker;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetTerminalTicker = WidgetTerminalTicker;
  }
})(typeof window !== "undefined" ? window : globalThis, function (WidgetTicker) {
  "use strict";

  // Теги журнала: короткие и латиницей. Незнакомое событие остаётся `[LOG]`.
  const TAGS = {
    donation: "[DONATE]",
    cheer: "[CHEER]",
    follow: "[FOLLOW]",
    sub: "[SUB]",
    gift_sub: "[GIFT]",
    reward: "[REWARD]",
    chat: "[CHAT]",
    goal: "[GOAL]",
    top: "[TOP]",
    wheel_start: "[GIVE]",
    wheel_winner: "[GIVE]",
    message: "[MSG]",
  };

  class WidgetTerminalTicker extends WidgetTicker {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не строим ни DOM, ни подписки.
      if (this.theme !== "terminal") return;
      super.onMount();
      this.element.classList.add("terminal-run");
      this._applyLook();
    }

    onUpdate(prev, next) {
      if (this.theme !== "terminal" || !this.railEl) return;
      if (prev && next && (prev.crt !== next.crt || prev.crtFont !== next.crtFont)) {
        this._applyLook();
      }
      super.onUpdate();
    }

    // Сканлайны снимаются тумблером «CRT-эффект», шрифт — «CRT-шрифтом»:
    // класс на корне, а правила лежат в shared/widgets.css.
    _applyLook() {
      this.element.classList.toggle("is-crt-off", this.config.crt === false);
      this.element.classList.toggle("is-crt-font", this.config.crtFont === true);
    }

    // Строка журнала: `[OK] текст |` — тег вместо цветной плашки.
    _itemEl(item) {
      const el = super._itemEl(item);
      el.classList.add("ticker__item--term");
      const tag = el.children && el.children[0];
      if (tag && TAGS[item.kind]) tag.textContent = TAGS[item.kind];
      // Разделитель журнала — вертикальная черта, а не ромб ленты.
      const sep = el.children && el.children[2];
      if (sep) sep.textContent = "|";
      return el;
    }
  }

  return WidgetTerminalTicker;
});
