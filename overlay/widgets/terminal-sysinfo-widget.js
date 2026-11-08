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
  WidgetTerminalSysinfo — сводка стрима как вывод `neofetch`.

  Заголовок `ose@terminal`, под ним строки «ключ — значение»: аптайм оверлея,
  фолловеры, сабы, донаты текущего стрима, цель шкалой и число сообщений в
  чате. Данные берутся из снимка состояния и событий — сеть не нужна, поэтому
  панель живёт и без подключённых сервисов, показывая прочерки.

  Тема изолирована жёстко: на чужой теме не строится ни DOM, ни подписки.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetTerminalSysinfo = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetTerminalSysinfo;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetTerminalSysinfo = WidgetTerminalSysinfo;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_BG = "rgba(13, 17, 23, 0.92)";
  const DEFAULT_BORDER = "1px solid #30363d";
  const DEFAULT_GLOW = "0 0 18px rgba(0, 255, 102, 0.25)";
  const DEFAULT_TEXT = "#c9d1d9";
  const DEFAULT_MUTED = "#8b949e";
  const DEFAULT_PROMPT = "#00ff66";

  // Шкала цели в этой панели короткая: строка делится с подписью и цифрами,
  // поэтому клеток пять — восемь занимали половину панели и превращали строку
  // в сплошную полосу.
  const BAR_CELLS = 5;

  // Ширина колонки ключа в символах. Выравниваем пробелами, как в neofetch:
  // тогда значение не прилипает к ключу, даже если CSS не применился —
  // например, OBS держит старый кэш стилей.
  const KEY_COLUMN = 12;

  class WidgetTerminalSysinfo extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;
      this.promptColor = DEFAULT_PROMPT;

      this.windowEl = null;
      this.rowsEl = null;
      this.titleEl = null;
      this.statusEl = null;
      // Значение строки «чат» обновляется отдельно: сообщения идут чаще, чем
      // меняются фолловеры, и перерисовывать всю панель на каждое незачем.
      this.chatValueEl = null;
      this._messages = 0;
      this._startedAt = 0;
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не строим DOM и не подписываемся.
      if (this.theme !== "terminal") return;

      this._readColors();
      this._applyPerspective();
      this.element.classList.add("terminal-surface");
      this._applySurface();
      this._applyCrt();
      this._applyCrtFont();
      this._startedAt = Date.now();

      this.windowEl = document.createElement("div");
      this.windowEl.className = "terminal-window";
      this.element.appendChild(this.windowEl);

      const tab = document.createElement("div");
      tab.className = "terminal-tab";
      const promptSpan = document.createElement("span");
      promptSpan.className = "terminal-tab__prompt";
      promptSpan.textContent = "root@ose-sysinfo:~#";
      tab.appendChild(promptSpan);
      this.titleEl = document.createElement("span");
      this.titleEl.className = "terminal-tab__title";
      // Подпись вкладки берётся из словаря — она же имя виджета в библиотеке.
      this.titleEl.textContent = this.context.t("sysinfo.title");
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
      body.style.cssText = "gap:1px;padding:5px 9px 6px;justify-content:center;";
      this.windowEl.appendChild(body);

      this.rowsEl = document.createElement("div");
      this.rowsEl.style.cssText = "display:flex;flex-direction:column;gap:1px;min-height:0;";
      body.appendChild(this.rowsEl);

      this.statusEl = document.createElement("div");
      this.statusEl.className = "terminal-status";
      this.windowEl.appendChild(this.statusEl);

      this._render();

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.STAT_UPDATE, () => this._render());
      this.subscribe(EVENT_TYPES.SESSION_STATS, () => this._render());
      this.subscribe(EVENT_TYPES.TOP_DONATION_UPDATE, () => this._render());
      this.subscribe(EVENT_TYPES.GOAL_UPDATE, () => this._render());
      this.subscribe(EVENT_TYPES.LOCALES, () => this._render());
      this.subscribe(EVENT_TYPES.CHAT_MESSAGE, () => this._countMessage());
      // Аптайм и часы должны идти сами: в тихом чате событий нет, и без
      // тика панель выглядела бы зависшей.
      this.every(() => this._render(), 30000);
    }

    onUnmount() {
      this.windowEl = null;
      this.rowsEl = null;
      this.titleEl = null;
      this.statusEl = null;
      this.chatValueEl = null;
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective) this._applyPerspective();
      if (prev.crt !== next.crt) this._applyCrt();
      if (prev.crtFont !== next.crtFont) this._applyCrtFont();
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
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

    // Сканлайны — эффект темы; тумблер «CRT-эффект» снимает их с виджета.
    _applyCrt() {
      const on = this.config.crt !== false;
      if (this.element && this.element.dataset) {
        this.element.dataset.crt = on ? "on" : "off";
      }
    }

    _applyCrtFont() {
      this.element.classList.toggle("is-crt-font", this.config.crtFont === true);
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

    // Аптайм — время с момента монтирования панели: для OBS это время жизни
    // источника, для превью — с момента открытия страницы. Часы в сутках идут
    // дальше, а не сбрасываются на ноль.
    _uptime() {
      const seconds = Math.max(0, Math.floor((Date.now() - this._startedAt) / 1000));
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      if (days > 0) return `${days}d ${String(hours).padStart(2, "0")}h`;
      if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
      return `${minutes}m`;
    }

    // Итог донатов стрима: количество, сумма в основной валюте и отдельными
    // слагаемыми то, что пересчитать не удалось. Та же логика, что у виджета
    // «Статистика»: одна цифра не должна врать из-за чужой валюты.
    _sessionAmount(session) {
      const { formatMoney, currencySymbol } = this.context;
      const extra = (Array.isArray(session.unconverted) ? session.unconverted : [])
        .map((item) => ({
          amount: Number(item && item.amount) || 0,
          currency: (item && item.currency) || "",
        }))
        .filter((item) => item.amount > 0);

      const base = Number(session.amount) || 0;
      const parts = [];
      if (base > 0 || !extra.length) {
        parts.push(`${formatMoney(base)} ${currencySymbol(session.currency || "RUB")}`.trim());
      }
      for (const item of extra) {
        parts.push(`${formatMoney(item.amount)} ${currencySymbol(item.currency)}`.trim());
      }
      return parts.join(" + ");
    }

    _barHtml(pct) {
      const filled = Math.round((pct / 100) * BAR_CELLS);
      return (
        '<span class="terminal-sysinfo__bar-off">[</span>' +
        `<span class="terminal-sysinfo__bar">${"█".repeat(filled)}</span>` +
        `<span class="terminal-sysinfo__bar-off">${"░".repeat(BAR_CELLS - filled)}]</span>` +
        `<span class="terminal-sysinfo__bar"> ${pct}%</span>`
      );
    }

    // Строки панели: `value` — простой текст, `bar` — доля цели в процентах.
    _rows() {
      const { t, state, formatMoney, currencySymbol } = this.context;
      const stats = (state && state.stats) || {};
      const goal = (state && state.goal) || {};
      const session = state && state.sessionDonations;
      const top = (state && state.topDonation) || null;
      const count = (value) => (value != null ? formatMoney(value) : "—");
      const pct = goal.target
        ? Math.min(100, Math.round(((Number(goal.current) || 0) / goal.target) * 100))
        : 0;

      return [
        { key: t("sysinfo.uptime"), value: this._uptime() },
        { key: t("sysinfo.followers"), value: count(stats.followerCount) },
        { key: t("sysinfo.subs"), value: count(stats.subscriberCount) },
        {
          key: t("sysinfo.donated"),
          value: session
            ? `${formatMoney(session.count)} · ${this._sessionAmount(session)}`
            : "—",
        },
        {
          key: t("sysinfo.top"),
          value:
            top && Number(top.amount) > 0
              ? `${top.user} · ${formatMoney(top.amount)} ${currencySymbol(top.currency || "RUB")}`.trim()
              : "—",
        },
        { key: t("sysinfo.goal"), bar: pct },
        { key: t("sysinfo.chat"), value: String(this._messages), slot: "chat" },
      ];
    }

    _render() {
      const rowsEl = this.rowsEl;
      if (!rowsEl) return;
      const { escapeHtml } = this.context;
      const text = (value) => escapeHtml(String(value));

      while (rowsEl.children.length) rowsEl.removeChild(rowsEl.firstChild);
      this.chatValueEl = null;

      const head = document.createElement("div");
      head.className = "terminal-sysinfo__head";
      head.textContent = "ose@terminal";
      rowsEl.appendChild(head);

      const sep = document.createElement("div");
      sep.className = "terminal-sysinfo__sep";
      rowsEl.appendChild(sep);

      for (const row of this._rows()) {
        const rowEl = document.createElement("div");
        rowEl.className = "terminal-sysinfo__row";

        const keyEl = document.createElement("span");
        keyEl.className = "terminal-sysinfo__key";
        keyEl.textContent = String(row.key).padEnd(KEY_COLUMN, " ");
        rowEl.appendChild(keyEl);

        const valueEl = document.createElement("span");
        valueEl.className = "terminal-sysinfo__value";
        valueEl.innerHTML = row.bar != null ? this._barHtml(row.bar) : text(row.value);
        rowEl.appendChild(valueEl);

        if (row.slot === "chat") this.chatValueEl = valueEl;
        rowsEl.appendChild(rowEl);
      }

      if (this.statusEl) {
        this.statusEl.innerHTML =
          '<span class="terminal-status__flag is-idle">[ONLINE]</span>' +
          '<span>sysinfo</span>' +
          '<span>utf-8</span>' +
          `<span class="terminal-status__spacer">${text(BaseWidget.clockTime())}</span>`;
      }
    }

    // Чат — единственное, что приходит часто: обновляем одну ячейку, чтобы
    // панель не перерисовывалась тридцать раз в секунду.
    _countMessage() {
      this._messages += 1;
      if (this.chatValueEl) this.chatValueEl.textContent = String(this._messages);
    }
  }

  return WidgetTerminalSysinfo;
});
