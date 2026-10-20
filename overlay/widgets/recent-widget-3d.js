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
  Recent events 3D — theme variant of the "recent" widget.

  Новое событие выезжает слева и остаётся в списке; уже показанные карточки
  плавно сдвигаются вниз. Сдвиг считается по FLIP: перед перестройкой списка
  запоминаем верх каждой карточки, после — компенсируем разницу трансформом
  и отпускаем его в ноль. Так список не «прыгает», когда приходит уведомление.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const RecentWidget =
    typeof module !== "undefined" && module.exports
      ? require("./recent-widget")
      : root.OSEWidgets && root.OSEWidgets.RecentWidget;
  const RecentWidget3d = factory(BaseWidget, RecentWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = RecentWidget3d;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.RecentWidget3d = RecentWidget3d;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget, RecentWidget) {
  "use strict";

  // Ключ события для сопоставления карточек между обновлениями. `at` ставит
  // сервер, поэтому два одинаковых по тексту события не схлопываются.
  function eventKey(event) {
    return [event && event.at, event && event.kind, event && event.user, event && event.amount].join("|");
  }

  function nextFrame(fn) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
    else setTimeout(fn, 0);
  }

  class RecentWidget3d extends RecentWidget {
    onMount() {
      this._applyPerspective();

      this.host = document.createElement("div");
      this.host.className = "widget-recent widget-recent3d";
      this.element.appendChild(this.host);

      this.titleEl = document.createElement("div");
      this.titleEl.className = "widget-recent__title";
      this.listEl = document.createElement("div");
      this.listEl.className = "widget-recent__list widget-recent3d__list";
      this.host.appendChild(this.titleEl);
      this.host.appendChild(this.listEl);

      this.nodes = new Map();
      this.renderedKeys = [];

      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.RECENT_EVENT, () => this.refresh());
      this.subscribe(EVENT_TYPES.LOCALES, () => this.refresh(true));
      this.refresh(true);
    }

    onUpdate(prevConfig, nextConfig) {
      if (
        prevConfig.perspective !== nextConfig.perspective ||
        prevConfig.perspectiveDirection !== nextConfig.perspectiveDirection
      ) {
        this._applyPerspective();
      }
      // Обновление раскладки приходит часто; пересобираем список только когда
      // меняются собственные настройки виджета.
      if (
        prevConfig.maxItems !== nextConfig.maxItems ||
        prevConfig.animationMs !== nextConfig.animationMs
      ) {
        this.refresh(true);
      }
    }

    // Базовый `BaseWidget.mount()` зовёт `render()` сразу после `onMount()`.
    // Список уже собран в `onMount()`, а каждое обновление раскладки не должно
    // пересобирать его заново: события приходят отдельно, через `refresh()`.
    render() {
      if (!this.nodes) this.refresh(true);
    }

    duration() {
      return Math.max(80, Math.min(2000, Number(this.config.animationMs) || 840));
    }

    refresh(immediate = false) {
      if (!this.host || !this.listEl) return;
      const { t, state } = this.context;
      const max = Math.max(1, Number(this.config.maxItems) || 5);
      const events = (state.recentEvents || []).slice(0, max);

      this.host.style.setProperty("--recent-animation", `${this.duration()}ms`);
      this.titleEl.textContent = t("preview.recentTitle");

      // Уникальные ключи: одинаковые события на одной миллисекунде не должны
      // переиспользовать один и тот же DOM-узел.
      const desired = [];
      const entering = [];
      const seen = new Map();
      for (const event of events) {
        const base = eventKey(event);
        const count = (seen.get(base) || 0) + 1;
        seen.set(base, count);
        desired.push({ key: `${base}#${count}`, event });
      }
      const desiredKeys = new Set(desired.map((item) => item.key));

      // FLIP: запоминаем, где карточки были до вставки новой.
      const oldTops = new Map();
      if (!immediate) {
        for (const [key, node] of this.nodes) {
          if (node.isConnected) oldTops.set(key, node.getBoundingClientRect().top);
        }
      }

      for (const [key, node] of this.nodes) {
        if (!desiredKeys.has(key)) {
          node.remove();
          this.nodes.delete(key);
        }
      }

      for (const { key, event } of desired) {
        let node = this.nodes.get(key);
        if (!node) {
          node = this.createItem(event, !immediate);
          this.nodes.set(key, node);
          if (!immediate) entering.push(node);
        } else {
          // Локаль или данные события могли измениться — обновляем текст, не
          // трогая уже показанную карточку и её анимацию.
          this.updateItem(node, event);
        }
        this.listEl.appendChild(node);
      }

      // Компенсируем старым карточкам скачок вниз и отпускаем трансформ.
      if (!immediate) {
        for (const { key } of desired) {
          const node = this.nodes.get(key);
          const oldTop = oldTops.get(key);
          if (!node || oldTop == null || !node.isConnected) continue;
          const delta = oldTop - node.getBoundingClientRect().top;
          if (Math.abs(delta) < 0.5) continue;
          node.style.transition = "none";
          node.style.transform = `translateY(${delta}px)`;
          nextFrame(() => {
            if (!node.isConnected) return;
            node.style.transition = "";
            node.style.transform = "";
          });
        }
      }

      // Новые карточки стартуют с классом is-entering; снимаем его следующим
      // кадром, чтобы браузер успел отрисовать начальное состояние.
      for (const node of entering) {
        nextFrame(() => {
          if (node.isConnected) node.classList.remove("is-entering");
        });
      }

      this.renderedKeys = desired.map((item) => item.key);
    }

    createItem(event, entering) {
      const node = document.createElement("div");
      node.className = "widget-recent__item widget-recent3d__item";
      if (entering) node.classList.add("is-entering");
      this.updateItem(node, event);
      return node;
    }

    updateItem(node, event) {
      const { escapeHtml, escapeAttr } = this.context;
      const escape = escapeAttr || escapeHtml || ((value) => String(value));
      node.dataset.kind = event.kind || "";
      node.innerHTML = `<span class="widget-recent__dot" data-kind="${escape(event.kind || "")}"></span><span class="widget-recent3d__text">${this._text(event)}</span>`;
    }
  }

  return RecentWidget3d;
});
