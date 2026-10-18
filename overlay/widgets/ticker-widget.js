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
  News ticker — бегущая строка событий стрима.

  Один движок на 2D-виджет и тематические 3D-варианты: тип с суффиксом
  `-ticker` получает класс `ticker--3d` и лёгкий наклон, всё остальное —
  плоская полоса. Оформление берётся из токенов темы, поэтому в Retrowave
  лента неоновая, в Wardogs — плоская, в Pixel — пиксельная.

  Лента липкая по построению: события копятся в `_events` (хронологический
  порядок), а трек дублируется столько раз, сколько нужно, чтобы за краем
  всегда был запас. Сдвиг считается от времени, а не от кадров, поэтому
  скорость в px/с остаётся одинаковой при любом FPS и при длинном тексте.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetTicker = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetTicker;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetTicker = WidgetTicker;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const SPEED_MIN = 20;
  const SPEED_MAX = 200;
  const DEFAULT_SPEED = 80;
  const DEFAULT_MAX_ITEMS = 24;
  const MAX_ITEMS_LIMIT = 60;
  const CHAT_TEXT_LIMIT = 140;
  const CHAT_MIN_INTERVAL_MS = 1200;
  const SEPARATOR = "◆";

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
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

  class WidgetTicker extends BaseWidget {
    constructor(config, context) {
      super(config, context);

      this._events = [];
      this._goal = null;
      this._top = null;
      this._lastChatTs = 0;
      this._seeded = false;

      this._offset = 0;
      this._cycle = 0;
      this._speed = DEFAULT_SPEED;
      this._direction = "left";
      this._label = "";
      this._perspective = 0;
      this._signature = "";
      this._raf = 0;
      this._lastTs = 0;
      this._fontSize = 0;
    }

    // ---- lifecycle ----

    onMount() {
      this.element.classList.add("ticker");
      this.is3d = /-ticker$/.test(this.type) && this.type !== "ticker";
      if (this.is3d) this.element.classList.add("ticker--3d");

      this.labelEl = span("ticker__label");
      this.frameEl = div("ticker__frame");
      this.railEl = div("ticker__rail");
      this.trackEl = div("ticker__track");
      this.railEl.appendChild(this.trackEl);
      this.frameEl.appendChild(this.labelEl);
      this.frameEl.appendChild(this.railEl);
      this.element.appendChild(this.frameEl);

      const E = this.context.EVENT_TYPES;
      this.subscribe(E.ALERT, (alert) => this._ingestAlert(alert));
      this.subscribe(E.CHAT_MESSAGE, (msg) => this._ingestChat(msg));
      this.subscribe(E.GOAL_UPDATE, (goal) => {
        this._goal = goal || null;
        this._rebuild();
      });
      this.subscribe(E.TOP_DONATION_UPDATE, (top) => {
        this._top = top || null;
        this._rebuild();
      });
      // Локали приходят отдельным кадром: теги и тексты событий нужно
      // пересобрать, иначе лента останется на прежнем языке до новых событий.
      this.subscribe(E.LOCALES, () => {
        this._applyConfig();
        this._rebuild(true);
      });

      this._seedFromState();
      this._applyConfig();
      this._rebuild(true);

      this.on(document, "visibilitychange", () => this._syncLoop());
      this.on(window, "resize", () => this._rebuild(true));

      if (typeof window.matchMedia === "function") {
        this._motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
        this._onMotionChange = () => this._syncLoop();
        if (typeof this._motionQuery.addEventListener === "function") {
          this._motionQuery.addEventListener("change", this._onMotionChange);
        }
      }

      // Шрифты могут догрузиться после первого замера — ширина трека изменится.
      if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          if (this._mounted) this._rebuild(true);
        });
      }

      this._syncLoop();
      // Первый кадр после раскладки: высота полосы и шрифт уже известны,
      // поэтому кегль и ширина трека считаются по фактическому размеру.
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          if (this._mounted) this._rebuild(true);
        });
      }
    }

    onUpdate() {
      this._applyConfig();
      this._rebuild();
    }

    onUnmount() {
      this._stop();
      if (this._motionQuery && this._onMotionChange) {
        if (typeof this._motionQuery.removeEventListener === "function") {
          this._motionQuery.removeEventListener("change", this._onMotionChange);
        }
      }
      this._motionQuery = null;
      this._onMotionChange = null;
      this._events = [];
      this._goal = null;
      this._top = null;
      this.labelEl = null;
      this.frameEl = null;
      this.railEl = null;
      this.trackEl = null;
    }

    // ---- data ----

    // При подключении оверлея берём уже накопленные события из снимка, чтобы
    // лента не начиналась с пустоты. Порядок разворачиваем в хронологический:
    // свежие события должны войти справа.
    _seedFromState() {
      if (this._seeded) return;
      this._seeded = true;
      const state = this.context.state || {};
      const recent = Array.isArray(state.recentEvents) ? state.recentEvents : [];
      recent
        .slice(0, this._maxItems())
        .reverse()
        .forEach((event) => this._ingestAlert(event, { rebuild: false }));
      if (state.goal) this._goal = state.goal;
      if (state.topDonation) this._top = state.topDonation;
    }

    _maxItems() {
      return clamp(Math.round(Number(this.config.maxItems) || DEFAULT_MAX_ITEMS), 1, MAX_ITEMS_LIMIT);
    }

    _sources() {
      const src = this.config.sources && typeof this.config.sources === "object" ? this.config.sources : {};
      return {
        donations: src.donations !== false,
        follows: src.follows !== false,
        subs: src.subs !== false,
        rewards: src.rewards !== false,
        chat: src.chat === true,
        goal: src.goal === true,
        top: src.top === true,
      };
    }

    _allows(kind) {
      const src = this._sources();
      if (kind === "donation" || kind === "cheer") return src.donations;
      if (kind === "follow") return src.follows;
      if (kind === "sub" || kind === "gift_sub") return src.subs;
      if (kind === "reward") return src.rewards;
      if (kind === "wheel_start" || kind === "wheel_winner") return src.subs || src.rewards;
      return false;
    }

    _ingestAlert(alert, options) {
      if (!alert) return;
      const kind = String(alert.kind || "");
      if (!this._allows(kind)) return;
      const raw = {
        kind,
        user: String(alert.user || "").trim(),
        amount: Number(alert.amount) || 0,
        currency: alert.currency || "RUB",
        message: String(alert.message || "").trim(),
        tier: alert.tier,
        count: Number(alert.count) || 0,
      };
      this._push(raw, options && options.rebuild === false ? false : true);
    }

    _ingestChat(msg) {
      if (!msg || !this._sources().chat) return;
      const text = String(msg.message || "").trim();
      // Команды бота и пустые сообщения в эфирную ленту не попадают.
      if (!text || text.startsWith("!")) return;
      const now = Date.now();
      if (now - this._lastChatTs < CHAT_MIN_INTERVAL_MS) return;
      this._lastChatTs = now;
      this._push({
        kind: "chat",
        user: String(msg.user || "").trim(),
        message: text.slice(0, CHAT_TEXT_LIMIT),
      });
    }

    _push(raw, rebuild = true) {
      const key = this._keyOf(raw);
      if (this._events.some((event) => this._keyOf(event) === key)) return;
      this._events.push(raw);
      const limit = this._maxItems();
      while (this._events.length > limit) this._events.shift();
      if (rebuild) this._rebuild();
    }

    _keyOf(raw) {
      return [raw.kind, raw.user || "", raw.amount || "", raw.message || "", raw.count || ""].join("|");
    }

    // ---- formatting ----

    t(key, params) {
      const context = this.context || {};
      return typeof context.t === "function" ? context.t(key, params) : key;
    }

    _money(amount, currency) {
      const context = this.context || {};
      const format = typeof context.formatMoney === "function" ? context.formatMoney : (n) => String(n);
      const symbol = typeof context.currencySymbol === "function" ? context.currencySymbol : () => "";
      return `${format(Number(amount) || 0)} ${symbol(currency || "RUB")}`.trim();
    }

    _textOf(raw) {
      const user = raw.user || this.t("ticker.anonymous");
      switch (raw.kind) {
        case "donation": {
          const base = this.t("ticker.donation", { user, amount: `+${this._money(raw.amount, raw.currency)}` });
          return raw.message ? `${base} — ${raw.message}` : base;
        }
        case "cheer":
          return this.t("ticker.cheer", { user, amount: `+${this._money(raw.amount, "")}` });
        case "follow":
          return this.t("ticker.follow", { user });
        case "sub":
          return this.t("ticker.sub", { user, tier: this._tier(raw.tier) });
        case "gift_sub":
          return this.t("ticker.gift", {
            user,
            count: Math.max(1, raw.count || 1),
            tier: this._tier(raw.tier),
          });
        case "reward":
          return this.t("ticker.reward", { user });
        case "chat":
          return this.t("ticker.chat", { user, message: raw.message });
        case "wheel_start":
          return this.t("ticker.wheelStart");
        case "wheel_winner":
          return this.t("ticker.wheelWinner", { user });
        default:
          return "";
      }
    }

    _tagOf(kind) {
      const keys = {
        donation: "ticker.tagDonation",
        cheer: "ticker.tagCheer",
        follow: "ticker.tagFollow",
        sub: "ticker.tagSub",
        gift_sub: "ticker.tagGift",
        reward: "ticker.tagReward",
        chat: "ticker.tagChat",
        wheel_start: "ticker.tagSystem",
        wheel_winner: "ticker.tagSystem",
      };
      return this.t(keys[kind] || "ticker.tagSystem");
    }

    _tier(tier) {
      const raw = String(tier || "").trim();
      if (!raw) return "1";
      const match = raw.match(/^(\d+)000$/);
      return match ? match[1] : raw;
    }

    _items() {
      const items = this._events
        .map((raw) => {
          const text = this._textOf(raw);
          return text ? { kind: raw.kind, tag: this._tagOf(raw.kind), text } : null;
        })
        .filter(Boolean);

      const src = this._sources();
      if (src.goal && this._goal && Number(this._goal.target) > 0) {
        const goal = this._goal;
        const text = goal.title
          ? this.t("ticker.goalTitle", {
              title: goal.title,
              current: this._money(goal.current, goal.currency),
              target: this._money(goal.target, goal.currency),
            })
          : this.t("ticker.goal", {
              current: this._money(goal.current, goal.currency),
              target: this._money(goal.target, goal.currency),
            });
        items.push({ kind: "goal", tag: this.t("ticker.tagGoal"), text });
      }
      if (src.top && this._top && Number(this._top.amount) > 0) {
        items.push({
          kind: "top",
          tag: this.t("ticker.tagTop"),
          text: this.t("ticker.top", {
            user: this._top.user || this.t("ticker.anonymous"),
            amount: this._money(this._top.amount, this._top.currency),
          }),
        });
      }
      return items;
    }

    // ---- rendering ----

    _applyConfig() {
      const config = this.config || {};
      this._speed = clamp(Math.round(Number(config.speed) || DEFAULT_SPEED), SPEED_MIN, SPEED_MAX);
      this._direction = config.direction === "right" ? "right" : "left";
      this._perspective = clamp(Number(config.perspective) || 0, 0, 100);

      const label = config.showLabel === false ? "" : String(config.label || "").trim() || this.t("ticker.label");
      this._label = label;
      if (this.labelEl) this.labelEl.textContent = label;
      if (this.element) {
        this.element.classList.toggle("ticker--no-label", !label);
        this.element.style.setProperty("--ticker-tilt", `${(this._perspective * 0.22).toFixed(2)}deg`);
      }
      this._applyFont();
    }

    // Кегль считаем от высоты полосы: при высоком виджете текст должен расти,
    // а не тонуть в полосе. Значение меняем только при реальном изменении,
    // иначе перестройка трека дёргалась бы на каждом обновлении раскладки.
    _applyFont() {
      if (!this.element) return;
      const height = this.element.clientHeight || 0;
      if (!height) return;
      const size = clamp(Math.round(height * 0.34), 12, 30);
      if (size === this._fontSize) return;
      this._fontSize = size;
      this.element.style.setProperty("--ticker-font", `${size}px`);
    }

    _rebuild(force = false) {
      if (!this.trackEl || !this.railEl) return;
      this._applyFont();

      const items = this._items();
      const railWidth = this.railEl.getBoundingClientRect ? this.railEl.getBoundingClientRect().width : 0;
      // Перестройка стоит DOM-операций. `syncLayout` зовёт update() на каждый
      // снимок состояния, поэтому одинаковый контент и ширину пропускаем —
      // иначе лента дёргалась бы на смене статуса связи.
      const signature = JSON.stringify({
        items: items.map((item) => [item.kind, item.tag, item.text]),
        label: this._label,
        speed: this._speed,
        direction: this._direction,
        font: this._fontSize,
        rail: Math.round(railWidth),
      });
      if (!force && signature === this._signature) {
        this._syncLoop();
        return;
      }
      this._signature = signature;

      this.trackEl.textContent = "";
      this.trackEl.style.transform = "translate3d(0, 0, 0)";

      const group = div("ticker__group");
      if (!items.length) {
        const empty = div("ticker__item");
        empty.dataset.kind = "empty";
        empty.appendChild(this._textEl(this.t("ticker.empty"), "ticker__text"));
        group.appendChild(empty);
      } else {
        items.forEach((item) => group.appendChild(this._itemEl(item)));
      }
      this.trackEl.appendChild(group);

      const groupWidth = group.getBoundingClientRect ? group.getBoundingClientRect().width : 0;
      this._cycle = groupWidth || 0;
      if (this._cycle > 0) {
        let total = this._cycle;
        // Дублируем контент, пока за циклом не останется полоса на всю ширину:
        // так в момент перескока в начале трека всегда есть чем заполнить кадр.
        while (total < railWidth + this._cycle) {
          this.trackEl.appendChild(group.cloneNode(true));
          total += this._cycle;
        }
        this._offset = this._offset % this._cycle;
      } else {
        this._offset = 0;
      }

      this._applyTransform();
      this._syncLoop();
    }

    _itemEl(item) {
      const el = div("ticker__item");
      el.dataset.kind = item.kind;
      const tag = span("ticker__tag");
      tag.textContent = item.tag;
      el.appendChild(tag);
      el.appendChild(this._textEl(item.text, "ticker__text"));
      const sep = span("ticker__sep");
      sep.textContent = SEPARATOR;
      el.appendChild(sep);
      return el;
    }

    _textEl(text, className) {
      const el = span(className);
      el.textContent = text;
      return el;
    }

    // ---- animation ----

    _reducedMotion() {
      return !!(this._motionQuery && this._motionQuery.matches);
    }

    _syncLoop() {
      const hasContent = this._cycle > 0;
      const visible =
        this.geometry.visible !== false &&
        this.element &&
        this.element.offsetWidth > 0 &&
        typeof document !== "undefined" &&
        !document.hidden;
      if (hasContent && visible && !this._reducedMotion()) this._start();
      else this._stop();
    }

    _start() {
      if (this._raf) return;
      this._lastTs = 0;
      const tick = (ts) => {
        if (!this._raf) return;
        if (!this._lastTs) this._lastTs = ts;
        const dt = Math.min(64, ts - this._lastTs);
        this._lastTs = ts;
        if (this._cycle > 0) {
          this._offset = (this._offset + (this._speed * dt) / 1000) % this._cycle;
          this._applyTransform();
        }
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }

    _stop() {
      if (!this._raf) return;
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      this._lastTs = 0;
    }

    _applyTransform() {
      if (!this.trackEl) return;
      const x = this._direction === "right" ? this._offset - this._cycle : -this._offset;
      this.trackEl.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;
    }
  }

  return WidgetTicker;
});
