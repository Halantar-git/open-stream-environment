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
  UEC transfer alert ("Входящая передача").

  A Star Citizen HUD-style alert (Orbital first): a compact strip
  ("ВХОДЯЩЕЕ СООБЩЕНИЕ") slides in first, the panel then expands to show the
  channel, the callsign and — for donations — the transferred amount. The
  callsign is scrambled and decoded character by character, like a signal
  being decrypted.

  The panel surface, border, glow and accent come from the active theme's
  tokens, so the widget sits next to the other HUD panels instead of carrying
  its own palette. The widget is DOM-only: phases are driven by tracked
  `later()`/`every()` timers, so no rAF loop is needed and the scene budget
  stays low.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetUecTransfer = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetUecTransfer;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetUecTransfer = WidgetUecTransfer;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  // Компактная плашка держится чуть больше секунды — как «входящий вызов» в
  // референсе: успеваешь прочитать, но она не мешает раскрытию.
  const COMPACT_MS = 1400;
  // Дефолтный шаг дешифровки: 76 мс читаются как заметное «раскрытие сигнала»,
  // а не как мельтешение. В настройках виджета шаг можно переопределить.
  const DEFAULT_DECODE_TICK_MS = 76;
  const MIN_DECODE_TICK_MS = 10;
  const MAX_DECODE_TICK_MS = 500;
  const MESSAGE_TICKS = 18;
  const DEFAULT_DURATION_MS = 9000;
  // С этого момента сообщение переносится на несколько строк даже на широком
  // виджете: подпись логичнее вынести над текстом, а не держать в одной строке
  // с ним.
  const LONG_MESSAGE_CHARS = 90;

  // Символы для «шифра»: цифры и знаки читаются как служебный код, а не как
  // случайный текст. Буквы оставлены латинскими, чтобы ник не превращался в
  // кашу из кириллицы.
  const SCRAMBLE = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ#=+*/<>";

  const BADGE =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 2.4l8.2 4.7v9.8L12 21.6l-8.2-4.7V7.1L12 2.4z" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
    '<path d="M12 6.2l4.9 2.8v5.9L12 17.8l-4.9-2.9V9L12 6.2z" fill="none" stroke="currentColor" stroke-width="0.9"/>' +
    '<path d="M12 9.4l2.2 1.3v2.6L12 14.6l-2.2-1.3v-2.6L12 9.4z" fill="currentColor" stroke="none"/>' +
    "</svg>";

  const CHIP_KEYS = {
    donation: "uec.chipDonation",
    cheer: "uec.chipCheer",
    follow: "uec.chipFollow",
    sub: "uec.chipSub",
    gift_sub: "uec.chipSub",
    reward: "uec.chipReward",
    wheel_start: "uec.chipSystem",
    wheel_winner: "uec.chipSystem",
  };

  const CREDIT_KEYS = {
    donation: "uec.credited",
    cheer: "uec.credited",
    follow: "uec.registered",
    sub: "uec.activated",
    gift_sub: "uec.activated",
    reward: "uec.received",
    wheel_start: "uec.processed",
    wheel_winner: "uec.processed",
  };

  // Ник может прийти пустым (например у колеса) — подставляем служебную строку,
  // а не пустую строку с одиноким курсором.
  const NAME_FALLBACK = "uec.anonymous";

  // Палитра качества донатов — та же, что у TESO-алерта: сумма красится по
  // tier'ам, чтобы крупный донат было видно с первого взгляда.
  function donationQualityColor(amount) {
    const a = Number(amount) || 0;
    if (a < 200) return "#ffffff"; // White (Trash)
    if (a < 400) return "#2dc50e"; // Green (Fine)
    if (a < 600) return "#3a92ff"; // Blue (Superior)
    if (a < 800) return "#a02dc5"; // Purple (Epic)
    if (a < 1000) return "#e5a823"; // Gold (Legendary)
    return "#ee6a00"; // Orange (Mythic)
  }

  function div(className) {
    const el = document.createElement("div");
    el.className = className;
    return el;
  }

  function span(className) {
    const el = document.createElement("span");
    el.className = className;
    return el;
  }

  class WidgetUecTransfer extends BaseWidget {
    constructor(config, context) {
      super(config, context);

      this.queue = [];
      this.current = null;
      this._hideId = null;
      this._compactId = null;
      this._decodeId = null;
      this._messageDecodeId = null;
      this._messageText = "";
      this._messageDecoded = false;
      this._duration = DEFAULT_DURATION_MS;
    }

    onMount() {
      this.element.classList.add("uec-transfer");
      this.element.style.opacity = "0";
      this.element.style.pointerEvents = "none";

      this.compactEl = div("uec-transfer__compact");
      this.compactBadgeEl = span("uec-transfer__badge uec-transfer__badge--compact");
      this.compactBadgeEl.innerHTML = BADGE;
      this.compactTextEl = span("uec-transfer__compact-text");
      this.compactTextEl.textContent = this.t("uec.incoming");
      this.compactDotsEl = span("uec-transfer__dots");
      for (let i = 0; i < 3; i++) this.compactDotsEl.appendChild(span("uec-transfer__dot"));
      this.compactEl.appendChild(this.compactBadgeEl);
      this.compactEl.appendChild(this.compactTextEl);
      this.compactEl.appendChild(this.compactDotsEl);
      this.compactEl.appendChild(this._buildSignal());
      this.element.appendChild(this.compactEl);

      this.frameEl = div("uec-transfer__frame");
      this.panelEl = div("uec-transfer__panel");

      const head = div("uec-transfer__head");
      const headBadge = span("uec-transfer__badge");
      headBadge.innerHTML = BADGE;
      this.titleEl = span("uec-transfer__title");
      this.titleEl.textContent = this.t("uec.transmission");
      this.separatorEl = span("uec-transfer__separator");
      this.separatorEl.textContent = "·";
      this.channelEl = span("uec-transfer__channel");
      this.chipEl = span("uec-transfer__chip");
      head.appendChild(headBadge);
      head.appendChild(this.titleEl);
      head.appendChild(this.separatorEl);
      head.appendChild(this.channelEl);
      head.appendChild(this._buildSignal());
      head.appendChild(this.chipEl);
      this.panelEl.appendChild(head);

      const body = div("uec-transfer__body");

      const main = div("uec-transfer__main");
      this.callsignLabelEl = span("uec-transfer__label");
      this.callsignLabelEl.textContent = this.t("uec.callsign");
      const nameRow = div("uec-transfer__name-row");
      this.nameEl = span("uec-transfer__name");
      nameRow.appendChild(this.nameEl);
      const messageRow = div("uec-transfer__message-row");
      this.messageLabelEl = span("uec-transfer__label uec-transfer__label--muted");
      this.messageLabelEl.textContent = this.t("uec.commLog");
      this.messageEl = span("uec-transfer__message");
      messageRow.appendChild(this.messageLabelEl);
      messageRow.appendChild(this.messageEl);
      main.appendChild(this.callsignLabelEl);
      main.appendChild(nameRow);
      main.appendChild(messageRow);

      const aside = div("uec-transfer__aside");
      this.asideEl = aside;
      this.creditLabelEl = span("uec-transfer__credit-label");
      this.amountEl = span("uec-transfer__amount");
      this.decodedLabelEl = span("uec-transfer__decoded");
      this.decodedLabelEl.textContent = this.t("uec.decoded");
      aside.appendChild(this.creditLabelEl);
      aside.appendChild(this.amountEl);
      aside.appendChild(this.decodedLabelEl);

      body.appendChild(main);
      body.appendChild(aside);
      this.panelEl.appendChild(body);

      this.frameEl.appendChild(this.panelEl);
      this.element.appendChild(this.frameEl);

      this.applyConfig();
      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this.queueAlert(alert));
      // Смена языка приходит отдельным кадром: статичные подписи нужно
      // перерисовать, иначе они останутся на прежнем языке до нового алерта.
      this.subscribe(this.context.EVENT_TYPES.LOCALES, () => this.applyConfig());
      // Если алерт пришёл до загрузки вшитых шрифтов, после их готовности
      // переносы станут другими — иначе текст обрежется старой высотой.
      const fonts = typeof document !== "undefined" ? document.fonts : null;
      if (fonts) {
        this._onFontsDone = () => {
          if (this.current && this.element.classList.contains("is-expanded")) this._fitHeight(true);
        };
        if (typeof fonts.addEventListener === "function") {
          fonts.addEventListener("loadingdone", this._onFontsDone);
        }
        // В headless и при медленной загрузке событие может уже пройти —
        // готовность шрифтов ловим оба способа.
        if (fonts.ready && typeof fonts.ready.then === "function") {
          fonts.ready.then(this._onFontsDone);
        }
      }
    }

    onUpdate() {
      this.applyConfig();
      // syncLayout зовёт update() на каждый STATE, смену темы и даже статус связи.
      // _applyGeometry при этом сбрасывает высоту к геометрии, поэтому раскрытую
      // панель подгоняем заново — иначе она «прыгает» обратно во время показа.
      if (this.current && this.element && this.element.classList.contains("is-expanded")) {
        this._fitHeight(true);
      }
    }

    onUnmount() {
      this._clearDecode();
      this._clearMessageDecode();
      if (this._onFontsDone && typeof document !== "undefined" && document.fonts) {
        if (typeof document.fonts.removeEventListener === "function") {
          document.fonts.removeEventListener("loadingdone", this._onFontsDone);
        }
        this._onFontsDone = null;
      }
      if (this._hideId != null) this.clearTimer(this._hideId);
      if (this._compactId != null) this.clearTimer(this._compactId);
      this._hideId = null;
      this._compactId = null;
      this.queue = [];
      this.current = null;
    }

    // ---- config ----

    applyConfig() {
      const channel = String(this.config.channel || "").trim() || this.t("uec.channel");
      if (this.channelEl) this.channelEl.textContent = channel;
      if (this.compactTextEl) this.compactTextEl.textContent = this.t("uec.incoming");
      if (this.titleEl) this.titleEl.textContent = this.t("uec.transmission");
      if (this.callsignLabelEl) this.callsignLabelEl.textContent = this.t("uec.callsign");
      if (this.messageLabelEl) this.messageLabelEl.textContent = this.t("uec.commLog");
      if (this.decodedLabelEl) this.decodedLabelEl.textContent = this.t("uec.decoded");
      if (this.panelEl) this.panelEl.classList.toggle("is-no-message", this.config.showMessage === false);
      if (this.current) this.renderLabels(this.current);
    }

    t(key, params) {
      const context = this.context || {};
      return typeof context.t === "function" ? context.t(key, params) : key;
    }

    // ---- queue ----

    queueAlert(alert) {
      if (!alert) return;
      this.queue.push(alert);
      if (!this.current) this.showNext();
    }

    showNext() {
      this.current = null;
      this._clearDecode();
      this._clearMessageDecode();
      this._messageDecoded = false;
      this._resetHeight();
      if (this._compactId != null) {
        this.clearTimer(this._compactId);
        this._compactId = null;
      }
      this.element.classList.remove("is-active", "is-compact", "is-expanded");
      this.element.style.opacity = "0";

      const alert = this.queue.shift();
      if (!alert) return;

      this.current = alert;
      this.renderContent(alert);
      this.element.style.opacity = "1";
      this.element.classList.add("is-active", "is-compact");

      this._compactId = this.later(() => {
        this._compactId = null;
        this._expand();
      }, COMPACT_MS);

      const duration = Number(alert.durationMs) || Number(this.config.durationMs) || DEFAULT_DURATION_MS;
      this._duration = Math.max(1500, Math.min(60000, duration));
      this._hideId = this.later(() => {
        this._hideId = null;
        this.showNext();
      }, this._duration);
    }

    _expand() {
      if (!this.current) return;
      this.element.classList.remove("is-compact");
      this.element.classList.add("is-expanded");
      this._startDecode(this.currentName());
      if (this.config.showMessage !== false) this._startMessageDecode(this._messageText);
      // Меряем сразу по полному тексту: пока он зашифрован, ширина символов
      // другая, и панель могла получиться ниже финальной.
      this._fitHeight(true);
      // Шрифты и переносы могут досчитаться уже после замера: повторяем на
      // следующем кадре, иначе длинное сообщение останется обрезанным
      // высотой, посчитанной по старой раскладке.
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => this._fitHeight(true));
      }
    }

    // ---- content ----

    renderContent(alert) {
      if (!this.chipEl) return;
      this.renderLabels(alert);

      // Пока панель не раскрыта, ник стоит «зашифрованным» — так компактная
      // плашка не выдаёт содержимое раньше времени.
      this.nameEl.textContent = this._scramble(Array.from(this.currentName()), 0);
    }

    // Подписи и сумма не зависят от фазы дешифровки, поэтому их можно
    // перерисовывать отдельно при смене языка или настроек.
    renderLabels(alert) {
      const kind = alert.kind || "";
      this.chipEl.textContent = this.t(CHIP_KEYS[kind] || "uec.chipSystem");
      if (this.creditLabelEl) {
        this.creditLabelEl.textContent = this.t(CREDIT_KEYS[kind] || "uec.processed");
      }

      const amount = this.amountText(alert);
      const showAmount = this.config.showAmount !== false && amount;
      if (this.amountEl) {
        this.amountEl.textContent = showAmount ? amount : "";
        this.amountEl.style.display = showAmount ? "" : "none";
      }
      if (this.creditLabelEl) {
        this.creditLabelEl.style.display = showAmount ? "" : "none";
      }

      // Сообщение есть у донатов, cheers и наград; у follow/sub/gift вместо
      // него показываем служебные сведения о событии.
      const infoKind = kind === "follow" || kind === "sub" || kind === "gift_sub";
      const message = !infoKind && (kind === "donation" || kind === "cheer" || kind === "reward")
        ? String(alert.message || "").trim()
        : "";
      const text = infoKind ? this.detailText(alert) : message;
      if (this.messageLabelEl) {
        this.messageLabelEl.textContent = this.t(infoKind ? "uec.details" : "uec.commLog");
      }
      if (this.messageEl) {
        this._messageText = text;
        // Текст тоже стартует шифром: смена языка или настроек не должна
        // раскрывать его раньше дешифровки.
        this.messageEl.textContent = text
          ? this._messageDecoded
            ? text
            : this._scramble(Array.from(text), 0)
          : this.t("uec.emptyLog");
        this.messageEl.classList.toggle("is-empty", !text);
      }

      if (this.asideEl && typeof this.asideEl.style.setProperty === "function") {
        this.asideEl.style.setProperty("--uec-amount-color", this.amountColor(kind, alert.amount));
      }
      // Длинный текст раскладываем иначе: подпись — отдельной строкой, текст на
      // всю ширину. Иначе каждая перенесённая строка начинается с отступа под
      // подпись, и на узком виджете сообщение вытягивается в длинный столбик.
      this.element.classList.toggle("is-long-message", Array.from(text).length > LONG_MESSAGE_CHARS);
    }

    // Сведения о неденежных событиях: уровень подписки и количество подарков.
    detailText(alert) {
      const kind = alert.kind || "";
      if (kind === "follow") return this.t("uec.detailFollow");
      if (kind === "sub") return this.t("uec.detailSub", { tier: this.tierLabel(alert.tier) });
      if (kind === "gift_sub") {
        return this.t("uec.detailGift", {
          count: Math.max(1, Number(alert.count) || 1),
          tier: this.tierLabel(alert.tier),
        });
      }
      return "";
    }

    // Twitch отдаёт уровень как 1000/2000/3000; показываем привычную цифру.
    tierLabel(tier) {
      const raw = String(tier || "").trim();
      if (!raw) return "1";
      const match = raw.match(/^(\d+)000$/);
      return match ? match[1] : raw;
    }

    currentName() {
      const alert = this.current || {};
      const user = String(alert.user || "").trim();
      return user || this.t(NAME_FALLBACK);
    }

    amountText(alert) {
      const context = this.context || {};
      const formatMoney = typeof context.formatMoney === "function" ? context.formatMoney : (n) => String(n);
      const symbol = typeof context.currencySymbol === "function" ? context.currencySymbol : () => "";
      const amount = Number(alert.amount) || 0;
      if (amount <= 0) return "";
      if (alert.kind === "cheer") return `+${formatMoney(amount)} ${this.t("uec.bits")}`;
      return `+${formatMoney(amount)} ${symbol(alert.currency || "RUB")}`.trim();
    }

    // Шаг дешифровки в миллисекундах: больше — медленнее. Настройка виджета
    // ограничена разумными рамками, чтобы кривое число не заморозило текст.
    decodeTickMs() {
      const value = Number(this.config.decodeTickMs);
      if (!Number.isFinite(value) || value <= 0) return DEFAULT_DECODE_TICK_MS;
      return Math.max(MIN_DECODE_TICK_MS, Math.min(MAX_DECODE_TICK_MS, Math.round(value)));
    }

    // Донат красится по tier'ам (как в TESO), cheer — третичным акцентом темы.
    amountColor(kind, amount) {
      if (kind === "donation") return donationQualityColor(amount);
      if (kind === "cheer") return "var(--md-tertiary, #ff3860)";
      return "var(--md-primary, #00f0ff)";
    }

    // ---- decode animation ----

    _startDecode(text) {
      this._clearDecode();
      const chars = Array.from(String(text || ""));
      if (!chars.length) {
        this.nameEl.textContent = "";
        return;
      }

      let revealed = 0;
      this.nameEl.textContent = this._scramble(chars, 0);
      this._decodeId = this.every(() => {
        revealed += 1;
        if (revealed >= chars.length) {
          this.nameEl.textContent = chars.join("");
          this._clearDecode();
          this.panelEl.classList.add("is-decoded");
          return;
        }
        this.nameEl.textContent = this._scramble(chars, revealed);
      }, this.decodeTickMs());
    }

    _clearDecode() {
      if (this._decodeId != null) {
        this.clearTimer(this._decodeId);
        this._decodeId = null;
      }
      if (this.panelEl) this.panelEl.classList.remove("is-decoded");
    }

    // Текст сообщения расшифровывается вместе с ником, но чуть медленнее:
    // длинная строка не должна проскакивать за один кадр, поэтому за тик
    // открывается сразу несколько символов и весь лог читается примерно
    // за ту же секунду, что и позывной.
    _startMessageDecode(text) {
      this._clearMessageDecode();
      const chars = Array.from(String(text || ""));
      if (!chars.length) return;

      this._messageDecoded = false;
      const perTick = Math.max(1, Math.ceil(chars.length / MESSAGE_TICKS));
      let revealed = 0;
      this.messageEl.classList.add("is-decoding");
      this.messageEl.textContent = this._scramble(chars, 0);
      this._messageDecodeId = this.every(() => {
        revealed += perTick;
        if (revealed >= chars.length) {
          this.messageEl.textContent = chars.join("");
          this._messageDecoded = true;
          this._clearMessageDecode();
          // После расшифровки ширина строк может измениться — подгоняем панель
          // ещё раз, чтобы текст не оказался обрезанным.
          this._fitHeight();
          return;
        }
        this.messageEl.textContent = this._scramble(chars, revealed);
      }, this.decodeTickMs());
    }

    _clearMessageDecode() {
      if (this._messageDecodeId != null) {
        this.clearTimer(this._messageDecodeId);
        this._messageDecodeId = null;
      }
      if (this.messageEl) this.messageEl.classList.remove("is-decoding");
    }

    _scramble(chars, revealed) {
      let out = "";
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (i < revealed || ch === " ") out += ch;
        else out += SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)];
      }
      return out;
    }

    // ---- panel height ----

    // Сбрасываем высоту к геометрии виджета: она могла быть растянута под
    // длинный текст предыдущего алерта.
    _resetHeight() {
      if (this.element) this.element.style.height = this.geometry.h + "%";
    }

    // Панель растёт под сообщение, но не бесконечно: длинный текст больше не
    // обрезается, а высота ограничена нижней границей экрана.
    _fitHeight(usePlainMessage = false) {
      if (!this.element || !this.frameEl || !this.panelEl) return;
      this.element.style.height = this.geometry.h + "%";
      const base = this.element.clientHeight || 0;
      if (!base) return;

      // На время замера подменяем «шифр» на финальный текст: так высота
      // считается по тому, сколько места он займёт после дешифровки.
      const shownMessage = this.messageEl ? this.messageEl.textContent : "";
      if (usePlainMessage && this.messageEl && this._messageText) {
        this.messageEl.textContent = this._messageText;
      }

      const viewport = (typeof window !== "undefined" && window.innerHeight) || 1080;
      const top = (Number(this.geometry.y) / 100) * viewport;
      const maxHeight = Math.max(base, viewport - top - 8);

      // Без `is-measuring` flex-дети сжимаются под высоту виджета, и панель
      // получается ниже текста — потом `overflow: hidden` обрезает конец
      // длинного сообщения. В этом режиме высота считается по содержимому.
      this.panelEl.classList.add("is-measuring");
      const elementHeight = this.element.style.height;
      const frameHeight = this.frameEl.style.height;
      const panelHeight = this.panelEl.style.height;
      const panelOverflow = this.panelEl.style.overflow;
      // Снимаем и высоту самого виджета: иначе фиксированные проценты
      // продолжают поджимать панель через flex-родителя.
      this.element.style.height = "auto";
      this.frameEl.style.height = "auto";
      this.panelEl.style.height = "auto";
      this.panelEl.style.overflow = "visible";
      let needed = this.panelEl.offsetHeight || 0;

      // Если даже полный текст не помещается до низа экрана, уплотняем его:
      // лучше чуть меньше шрифт, чем обрезанное сообщение.
      const dense = needed + 2 > maxHeight;
      this.panelEl.classList.toggle("is-dense", dense);
      if (dense) needed = this.panelEl.offsetHeight || needed;

      this.panelEl.classList.remove("is-measuring");
      this.element.style.height = elementHeight;
      this.frameEl.style.height = frameHeight;
      this.panelEl.style.height = panelHeight;
      this.panelEl.style.overflow = panelOverflow;
      if (this.messageEl && usePlainMessage) {
        this.messageEl.textContent = shownMessage;
      }

      if (!needed) return;
      // Полстроки запаса: переносы, округление и границы глифов дают разницу в
      // несколько пикселей, из-за которой последняя строка липла к рамке.
      this.element.style.height = Math.min(Math.max(base, needed + 12), maxHeight) + "px";

      // Замер по flex-раскладке может недосчитать несколько пикселей (перенос
      // строк, отступы сетки). Добираем по факту: пока содержимое панели выше
      // её самой, растим высоту — иначе край обрежет последнюю строку.
      for (let attempt = 0; attempt < 3; attempt++) {
        const scroll = this.panelEl.scrollHeight;
        const client = this.panelEl.clientHeight;
        if (!Number.isFinite(scroll) || !Number.isFinite(client)) break;
        const overflow = scroll - client;
        if (overflow <= 0) break;
        const current = Number.parseFloat(this.element.style.height) || 0;
        const next = Math.min(current + overflow + 2, maxHeight);
        if (next <= current) break;
        this.element.style.height = next + "px";
      }
    }

    // ---- small DOM helpers ----

    _buildSignal() {
      const signal = span("uec-transfer__signal");
      for (let i = 0; i < 5; i++) signal.appendChild(span("uec-transfer__bar"));
      return signal;
    }
  }

  return WidgetUecTransfer;
});
