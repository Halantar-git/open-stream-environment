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
  WidgetRoulette — рулетка призов на донатах.

  Не колесо с секторами, а горизонтальная лента карточек, как у рулеток
  стриминговых сервисов: стрелка по центру, лента уезжает под неё и
  останавливается на призе. Приз выбирается по весам (weight), а не поровну,
  поэтому редкие исходы выпадают реже. Донат от заданной суммы запускает спин.

  Оформление целиком из токенов темы: карточки — поверхности с акцентом
  категории (обычная/редкая/эпическая/легендарная), стрелка и свечение — из
  primary. Кнопка «Крутить» в инспекторе меняет `spinId`, чтобы проверить
  рулетку без доната.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetRoulette = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetRoulette;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetRoulette = WidgetRoulette;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const CATEGORIES = ["common", "rare", "epic", "legendary"];
  // Сколько раз повторить список, чтобы лента была длинной и спин читался.
  const LOOPS = 8;
  const MAX_ITEMS = 24;
  const RESULT_MS = 6000;
  // Шаг карточки, если разметка ещё не измерена (тесты, первый кадр).
  const FALLBACK_STEP = 170;

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  // Мусор из конфига не должен ломать ленту: обрезаем длину, веса и категорию.
  function normalizeItems(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .slice(0, MAX_ITEMS)
      .map((item) => {
        const title = String((item && item.title) || "").trim().slice(0, 48);
        const category = CATEGORIES.includes(item && item.category) ? item.category : "common";
        const weight = clamp(Math.floor(Number(item && item.weight) || 1), 1, 9999);
        return { title, category, weight };
      })
      .filter((item) => item.title);
  }

  class WidgetRoulette extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.items = normalizeItems(this.config.items);
      this.frameEl = null;
      this.viewportEl = null;
      this.trackEl = null;
      this.resultEl = null;
      this.spinning = false;
      this.pending = false;
      this.winnerIndex = -1;
      this.resultTimer = 0;
    }

    onMount() {
      this._buildDom();
      this._applySurface();
      this._applyPerspective();

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.ALERT, (alert) => this._onAlert(alert));
      this.subscribe(EVENT_TYPES.LOCALES, () => {
        if (!this.spinning) this._renderTrack();
      });
    }

    onUnmount() {
      this.spinning = false;
      this.pending = false;
      this.winnerIndex = -1;
      this.resultTimer = 0;
      this.items = [];
      if (this.frameEl) this.frameEl.innerHTML = "";
      this.frameEl = null;
      this.viewportEl = null;
      this.trackEl = null;
      this.resultEl = null;
    }

    onUpdate(prev, next) {
      // Список призов пришёл из инспектора — пересобираем ленту.
      if (JSON.stringify(prev.items) !== JSON.stringify(next.items)) {
        this.items = normalizeItems(next.items);
        this._renderTrack();
      }
      if (prev.showBackground !== next.showBackground) this._applySurface();
      if (
        prev.perspective !== next.perspective ||
        prev.perspectiveDirection !== next.perspectiveDirection
      ) {
        this._applyPerspective();
      }
      // Кнопка «Крутить» в инспекторе меняет штамп, не трогая остальной конфиг.
      if (prev.spinId !== next.spinId) this.spin();
    }

    // ---- разметка ----

    _buildDom() {
      const div = (className) => {
        const node = document.createElement("div");
        node.className = className;
        return node;
      };
      this.element.classList.add("widget-roulette");

      this.frameEl = div("roulette");
      this.element.appendChild(this.frameEl);

      this.viewportEl = div("roulette__viewport");
      this.frameEl.appendChild(this.viewportEl);

      this.trackEl = div("roulette__track");
      this.viewportEl.appendChild(this.trackEl);

      const pointer = div("roulette__pointer");
      pointer.setAttribute("aria-hidden", "true");
      this.viewportEl.appendChild(pointer);

      this.resultEl = div("roulette__result");
      this.resultEl.hidden = true;
      this.frameEl.appendChild(this.resultEl);

      this._renderTrack();
    }

    _clear(node) {
      while (node.children.length) node.removeChild(node.children[0]);
    }

    _renderTrack() {
      if (!this.trackEl) return;
      this._clear(this.trackEl);
      this.frameEl.classList.toggle("is-empty", this.items.length === 0);
      if (!this.items.length) return;

      for (let loop = 0; loop < LOOPS; loop++) {
        for (const item of this.items) {
          const card = document.createElement("div");
          card.className = `roulette__card is-${item.category}`;

          const title = document.createElement("span");
          title.className = "roulette__card-title";
          title.textContent = item.title;
          card.appendChild(title);

          const category = document.createElement("span");
          category.className = "roulette__card-cat";
          category.textContent = this._categoryLabel(item.category);
          card.appendChild(category);

          this.trackEl.appendChild(card);
        }
      }
      this._resetTrack();
    }

    _categoryLabel(category) {
      const { t } = this.context;
      return t ? t(`roulette.category.${category}`) : category;
    }

    _resetTrack() {
      if (!this.trackEl) return;
      this.trackEl.style.transition = "none";
      this.trackEl.style.transform = "translateX(0)";
    }

    _applySurface() {
      if (!this.frameEl) return;
      // Без фона остаются только карточки: панель не нужна, если виджет и так
      // стоит на тёмной сцене.
      this.frameEl.classList.toggle("is-bare", this.config.showBackground === false);
    }

    _applyPerspective() {
      const value = clamp(Number(this.config.perspective) || 0, 0, 100);
      if (!value) {
        this._setTilt("");
        return;
      }
      const magnitude = value * 0.15;
      const direction = this.config.perspectiveDirection || "left";
      let ry = -magnitude;
      let rx = magnitude * 0.2;
      if (direction === "right") ry = magnitude;
      else if (direction === "up") {
        ry = 0;
        rx = magnitude;
      } else if (direction === "down") {
        ry = 0;
        rx = -magnitude;
      }
      this._setTilt(`perspective(1200px) rotateY(${ry}deg) rotateX(${rx}deg)`);
    }

    // ---- запуск ----

    _onAlert(alert) {
      if (!alert || alert.kind !== "donation") return;
      const amount = Number(alert.amount) || 0;
      if (amount + 1e-9 < this._minAmount()) return;
      this.spin();
    }

    _minAmount() {
      return Math.max(0, Number(this.config.minAmount) || 0);
    }

    _spinMs() {
      return clamp(Math.round(Number(this.config.spinMs) || 4200), 600, 15000);
    }

    // Взвешенный выбор: редкий приз с весом 1 против 100 обычных выпадает
    // примерно в сто раз реже, и в коде это дешевле, чем размножать призы.
    _pickIndex() {
      const total = this.items.reduce((sum, item) => sum + item.weight, 0);
      if (total <= 0) return 0;
      let roll = Math.random() * total;
      for (let i = 0; i < this.items.length; i++) {
        roll -= this.items[i].weight;
        if (roll < 0) return i;
      }
      return this.items.length - 1;
    }

    _step() {
      const kids = this.trackEl ? this.trackEl.children : [];
      if (kids.length >= 2) {
        const delta = kids[1].offsetLeft - kids[0].offsetLeft;
        if (delta > 0) return delta;
      }
      return FALLBACK_STEP;
    }

    spin() {
      if (!this.items.length) return;
      if (this.spinning) {
        // Донаты могут идти подряд: один спин доигрывает, следующий ждёт.
        this.pending = true;
        return;
      }
      this.spinning = true;
      this.pending = false;
      this.resultEl.hidden = true;
      // Новый спин обрывает показ прошлого результата и его таймер сброса.
      if (this.resultTimer) {
        this.clearTimer(this.resultTimer);
        this.resultTimer = 0;
      }

      this.winnerIndex = this._pickIndex();
      const targetIndex = (LOOPS - 1) * this.items.length + this.winnerIndex;
      const card = this.trackEl.children[targetIndex];
      const step = this._step();
      const cardWidth = card && card.offsetWidth ? card.offsetWidth : step * 0.9;
      const firstLeft = this.trackEl.children[0] ? this.trackEl.children[0].offsetLeft : 0;
      const viewportWidth = this.viewportEl.clientWidth || 0;
      // Центр выигрышной карточки ставим под стрелку по центру вьюпорта.
      const cardCenter = card ? card.offsetLeft + cardWidth / 2 - firstLeft : targetIndex * step + cardWidth / 2;
      const offset = Math.max(0, cardCenter - viewportWidth / 2);

      this.trackEl.style.transition = `transform ${this._spinMs()}ms cubic-bezier(0.12, 0.72, 0.16, 1)`;
      this.trackEl.style.transform = `translateX(${-offset}px)`;

      // CSS-переход не даёт события окончания в старых webview — таймер надёжнее.
      this.later(() => this._finishSpin(), this._spinMs() + 40);
    }

    _finishSpin() {
      if (!this.spinning) return;
      this.spinning = false;
      const item = this.items[this.winnerIndex];

      if (item && this.resultEl) {
        this.resultEl.className = `roulette__result is-${item.category}`;
        this.resultEl.textContent = this.context.t("roulette.result", { title: item.title });
        this.resultEl.hidden = false;
        this.resultEl.classList.remove("is-showing");
        // Перезапуск CSS-анимации: без пересчёта повторный показ не сработает.
        void this.resultEl.offsetWidth;
        this.resultEl.classList.add("is-showing");
      }

      this.resultTimer = this.later(() => {
        if (this.resultEl) this.resultEl.hidden = true;
        this._resetTrack();
        if (this.pending) {
          this.pending = false;
          this.spin();
        }
      }, RESULT_MS);
    }
  }

  return WidgetRoulette;
});
