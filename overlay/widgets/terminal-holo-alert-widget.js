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
  WidgetTerminalHoloAlert — событие как вывод команды в терминале.

  Вместо карточки с иконкой — окно консоли: строка команды `$ sudo apt
  install donation`, затем ответ `[OK] Received 500 RUB from Username` и
  сообщение зрителя `[MSG]: "..."`. Строки печатаются посимвольно, как в
  старом терминале; каретка мигает в конце.

  Очередь играет события по одному, панель невидима до первого алерта.
  Тема изолирована жёстко: на чужой теме не поднимается ни DOM, ни подписки.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetTerminalHoloAlert = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetTerminalHoloAlert;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetTerminalHoloAlert = WidgetTerminalHoloAlert;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_BG = "rgba(13, 17, 23, 0.95)";
  const DEFAULT_BORDER = "1px solid #30363d";
  const DEFAULT_GLOW = "0 0 18px rgba(0, 255, 102, 0.25)";
  const DEFAULT_TEXT = "#c9d1d9";
  const DEFAULT_MUTED = "#8b949e";
  const DEFAULT_PROMPT = "#00ff66";
  const DEFAULT_ACCENT = "#58a6ff";
  const DEFAULT_ERROR = "#ff3333";

  // Скорость печати: 16 мс на символ — быстро, но эффект виден.
  const TYPE_MS = 16;

  // Команда, которой «устанавливается» событие — своя для каждого вида.
  const COMMANDS = {
    donation: "sudo apt install donation",
    follow: "sudo apt install follow",
    sub: "sudo apt install subscription",
    gift_sub: "sudo apt install subscription --gift",
    cheer: "sudo apt install bits",
    reward: "sudo apt install reward",
    boosty_sub: "sudo apt install boosty",
    boosty_resub: "sudo apt install boosty --renew",
    wheel_start: "sudo apt install giveaway",
    wheel_winner: "sudo apt install giveaway --winner",
    ai: "sudo apt install ai-voice",
  };

  class WidgetTerminalHoloAlert extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;
      this.promptColor = DEFAULT_PROMPT;
      this.accentColor = DEFAULT_ACCENT;
      this.errorColor = DEFAULT_ERROR;

      this.host = null;
      this.queue = [];
      this.playing = false;
      this.typeTimer = null;
    }

    onMount() {
      // Жёсткая привязка к теме: на чужой не строим DOM и не подписываемся.
      if (this.theme !== "terminal") return;

      this._readColors();
      this.element.classList.add("terminal-surface");
      this._applySurface();
      // Скрыт до первого алерта — окно не должно висеть на экране.
      this.element.style.opacity = "0";

      this.host = document.createElement("div");
      this.host.className = "terminal-window";
      this.element.appendChild(this.host);

      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this.queueAlert(alert));
    }

    onUnmount() {
      this._stopTyping();
      this.queue = [];
      this.playing = false;
      if (this.element) this.element.innerHTML = "";
      this.host = null;
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
      this.promptColor = (read && read("--term-prompt")) || DEFAULT_PROMPT;
      this.accentColor = (read && read("--term-accent")) || DEFAULT_ACCENT;
      this.errorColor = (read && read("--term-error")) || DEFAULT_ERROR;
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

    // ---- очередь ----

    queueAlert(alert) {
      if (!alert) return;
      this.queue.push(alert);
      if (!this.playing) this.drain();
    }

    drain() {
      const alert = this.queue.shift();
      if (!alert) {
        this.playing = false;
        this.element.style.opacity = "0";
        this.element.style.height = this.geometry.h + "%";
        return;
      }
      this.playing = true;

      const card = this.buildCard(alert);
      this.host.appendChild(card);
      this.element.style.opacity = "1";
      this._autoSize(card);

      if (card.animate) {
        card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear" });
      }

      this._typeLines(card, () => {
        const holdMs = alert.durationMs || 5000;
        this.later(() => {
          if (card.animate) {
            card.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: 120,
              easing: "ease-in",
              fill: "forwards",
            });
          }
          this.later(() => {
            card.remove();
            this.drain();
          }, 120);
        }, holdMs);
      });
    }

    // ---- содержимое ----

    kindLabel(alert) {
      const { t } = this.context;
      switch (alert.kind) {
        case "follow": return t("alert.follow");
        case "sub":
          return Number(alert.months) > 1
            ? t("alert.resubMonths", { months: alert.months })
            : t("alert.sub");
        case "gift_sub": return t("alert.giftSub", { count: alert.count || 1 });
        case "cheer": return t("alert.cheer");
        case "donation": return t("alert.donation");
        case "ai": return t("alert.ai");
        case "boosty_sub": return t("alert.boostySub");
        case "boosty_resub": return t("alert.boostyResub");
        case "wheel_start": return t("alert.wheelStart");
        case "wheel_winner": return t("alert.wheelWinner");
        case "reward": return t("alert.reward");
        default: return "";
      }
    }

    formatAmount(alert) {
      const { t, formatMoney, currencySymbol } = this.context;
      if (alert.kind === "cheer") return t("alert.cheerBits", { amount: alert.amount });
      if (alert.kind === "donation") return `${formatMoney(alert.amount)} ${currencySymbol(alert.currency || "RUB")}`;
      if (alert.kind === "boosty_sub" || alert.kind === "boosty_resub") {
        return alert.amount ? `${formatMoney(alert.amount)} ${currencySymbol(alert.currency || "RUB")}` : "";
      }
      return "";
    }

    // Пары «что пришло» для строки ответа терминала.
    responseParts(alert) {
      const { t } = this.context;
      const amount = this.formatAmount(alert);
      const user = alert.user || "";

      switch (alert.kind) {
        case "donation":
          return { ok: true, text: `Received ${amount} from ${user}` };
        case "cheer":
          return { ok: true, text: `Received ${amount} from ${user}` };
        case "follow":
          return { ok: true, text: `New follower: ${user}` };
        case "sub":
          return { ok: true, text: `${this.kindLabel(alert)}: ${user}` };
        case "gift_sub":
          return { ok: true, text: `${this.kindLabel(alert)}: ${user}` };
        case "reward":
          return { ok: true, text: `${t("alert.reward")}: ${user}` };
        case "boosty_sub":
        case "boosty_resub":
          return { ok: true, text: amount ? `Received ${amount} from ${user}` : `${this.kindLabel(alert)}: ${user}` };
        case "wheel_start":
          return { ok: true, text: t("alert.wheelStartMessage", { command: alert.command || "" }) };
        case "wheel_winner":
          return { ok: true, text: `${t("alert.wheelWinner")}: ${user}` };
        case "ai":
          return { ok: true, text: `${t("alert.ai")}: ${user}` };
        default:
          return { ok: true, text: `${this.kindLabel(alert)}: ${user}` };
      }
    }

    buildCard(alert) {
      const { escapeHtml } = this.context;

      const command = COMMANDS[alert.kind] || "sudo apt install event";
      const response = this.responseParts(alert);
      const message = (alert.message || "").trim();
      const music = (alert.musicTitle || "").trim();

      const card = document.createElement("div");
      card.className = "terminal-window";
      card.style.cssText = "min-height:0;";

      const tab = document.createElement("div");
      tab.className = "terminal-tab";
      tab.innerHTML =
        '<span class="terminal-tab__prompt">root@ose-alert:~#</span>' +
        `<span class="terminal-tab__title">${escapeHtml(this.kindLabel(alert))}</span>` +
        '<span class="terminal-tab__dots"><i class="terminal-tab__dot"></i><i class="terminal-tab__dot"></i><i class="terminal-tab__dot"></i></span>';
      card.appendChild(tab);

      const body = document.createElement("div");
      body.className = "terminal-body";
      body.style.cssText = "gap:1px;padding:5px 9px 7px;";
      card.appendChild(body);

      const prompt = `<span style="color:${this.promptColor};font-weight:700;">$</span> `;
      const lines = [
        { text: command, html: `${prompt}<span style="color:${this.textColor};">${escapeHtml(command)}</span>` },
        {
          text: `[OK] ${response.text}`,
          html:
            `<span style="color:${this.promptColor};">[OK]</span> ` +
            `<span style="color:${this.textColor};">${escapeHtml(response.text)}</span>`,
        },
      ];

      // Время в окне — как `date` в логе, приглушённо справа.
      if (message) {
        lines.push({
          text: `[MSG]: "${message}"`,
          html:
            `<span style="color:${this.accentColor};">[MSG]</span>: ` +
            `<span style="color:${this.mutedColor};">"${escapeHtml(message)}"</span>`,
        });
      }
      if (music) {
        lines.push({
          text: `[MUSIC]: ${music}`,
          html:
            `<span style="color:${this.accentColor};">[MUSIC]</span>: ` +
            `<span style="color:${this.mutedColor};">${escapeHtml(music)}</span>`,
        });
      }

      const rows = lines.map((line) => {
        const row = document.createElement("div");
        row.className = "terminal-alert__line";
        row.style.cssText =
          "font-family:var(--font-mono);font-size:12px;line-height:1.35;" +
          "white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;";
        row.dataset.html = line.html;
        row.dataset.plain = line.text;
        row.innerHTML = "";
        body.appendChild(row);
        return row;
      });

      card.dataset.rows = "1";
      card._rows = rows;
      return card;
    }

    // Печать строк посимвольно: символы берём из готовой разметки строки,
    // поэтому цветные метки `[OK]`/`[MSG]` появляются вместе с текстом.
    _typeLines(card, done) {
      this._stopTyping();
      const rows = card._rows || [];
      if (!rows.length) {
        done();
        return;
      }

      const reduceMotion =
        typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduceMotion) {
        rows.forEach((row) => {
          row.innerHTML = row.dataset.html;
        });
        done();
        return;
      }

      let rowIndex = 0;
      let charIndex = 0;

      const step = () => {
        const row = rows[rowIndex];
        if (!row) {
          this._stopTyping();
          done();
          return;
        }
        const plain = row.dataset.plain || "";
        charIndex = Math.min(plain.length, charIndex + 2);
        row.textContent = plain.slice(0, charIndex);
        row.style.color = rowIndex === 0 ? this.textColor : "";
        if (charIndex >= plain.length) {
          // Строка допечатана — подменяем на цветную разметку.
          row.innerHTML = row.dataset.html;
          rowIndex += 1;
          charIndex = 0;
        }
      };

      this.typeTimer = setInterval(() => {
        step();
        if (rowIndex >= rows.length) {
          this._stopTyping();
          done();
        }
      }, TYPE_MS);
    }

    _stopTyping() {
      if (this.typeTimer) {
        clearInterval(this.typeTimer);
        this.typeTimer = null;
      }
    }

    // Панель растягивается под длинный текст доната, но не выходит за
    // разумный предел — иначе окно закрыло бы пол-экрана.
    _autoSize(card) {
      if (!this.element) return;
      this.element.style.height = this.geometry.h + "%";
      const base = this.element.clientHeight || 100;
      const needed = (card ? card.offsetHeight : 0) + 16;
      const cap = Math.max(360, base);
      this.element.style.height = Math.min(Math.max(base, needed), cap) + "px";
    }
  }

  return WidgetTerminalHoloAlert;
});
