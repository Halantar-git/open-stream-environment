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
  Снегопад.

  Снежинки — обычные `span` в DOM, падение — CSS-анимация по `transform`:
  кадры рисует композитор, rAF и canvas не нужны, сцена почти ничего не
  тратит. Позиция, размер, скорость и снос каждой снежинки живут в
  CSS-переменных, поэтому при ресайзе достаточно пересобрать поле.

  Число снежинок зависит от площади виджета и плотности, а не от одних
  настроек: на маленькой плашке сотня точек выглядела бы как туман. Разброс
  детерминированный — пересборка не должна перетасовывать снег.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetSnow = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetSnow;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetSnow = WidgetSnow;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  // Плотность 40 — это примерно 130 снежинок на кадр 1920×1080: снег видно,
  // но он не превращается в туман и не жрёт кадры.
  const AREA_PER_FLAKE = 16000;
  const DENSITY_BASE = 40;
  const MIN_FLAKES = 4;
  const MAX_FLAKES = 320;
  // Порыв на алерт: базовая длительность плюс по 2 мс за единицу суммы.
  const BURST_BASE_MS = 1400;
  const BURST_MAX_MS = 3600;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  // Детерминированный «рандом»: пересборка при ресайзе не должна перетасовывать
  // снежинки, иначе узор дёргается на каждом изменении размера.
  function rand(i, salt) {
    const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  class WidgetSnow extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this._sig = "";
      this._burstId = null;
      this._observer = null;
      this.fieldEl = null;
    }

    onMount() {
      this.element.classList.add("snow");
      this.element.style.pointerEvents = "none";

      this.fieldEl = document.createElement("div");
      this.fieldEl.className = "snow__field";
      this.element.appendChild(this.fieldEl);

      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this.react(alert));

      if (typeof ResizeObserver === "function") {
        this._observer = new ResizeObserver(() => this.rebuild());
        this._observer.observe(this.element);
      }
      this.applyConfig();
      this.rebuild();
      // Размер может определиться только после первой раскладки.
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => this.rebuild());
    }

    onUpdate() {
      this.applyConfig();
      this.rebuild();
    }

    onUnmount() {
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
      if (this._burstId != null) this.clearTimer(this._burstId);
      this._burstId = null;
    }

    // ---- config ----

    settings() {
      const c = this.config || {};
      const color = String(c.color == null ? "" : c.color).trim();
      return {
        density: clamp(num(c.density, DENSITY_BASE), 5, 100),
        speed: clamp(num(c.speed, 1), 0.25, 3),
        size: clamp(num(c.size, 3), 1, 8),
        wind: clamp(num(c.wind, 0.2), -1, 1),
        color: HEX.test(color) ? color : "#ffffff",
        reactToAlerts: c.reactToAlerts !== false,
      };
    }

    applyConfig() {
      const { color } = this.settings();
      this.element.style.setProperty("--snow-color", color);
    }

    // ---- alerts ----

    react(alert) {
      if (!alert || !this.settings().reactToAlerts) return;
      const amount = Number(alert.amount) || 0;
      const ms = clamp(BURST_BASE_MS + amount * 2, BURST_BASE_MS, BURST_MAX_MS);
      this.element.classList.add("is-burst");
      if (this._burstId != null) this.clearTimer(this._burstId);
      this._burstId = this.later(() => {
        this._burstId = null;
        this.element.classList.remove("is-burst");
      }, ms);
    }

    // ---- geometry ----

    // Поле снежинок по реальному размеру виджета. Ничего не пересобираем, если
    // размер и настройки те же: `ResizeObserver` срабатывает и на скролл.
    rebuild() {
      if (!this.fieldEl) return;
      const w = Math.round(this.element.clientWidth);
      const h = Math.round(this.element.clientHeight);
      if (!w || !h) return;

      const s = this.settings();
      const count = clamp(
        Math.round(((w * h) / AREA_PER_FLAKE) * (s.density / DENSITY_BASE)),
        MIN_FLAKES,
        MAX_FLAKES,
      );
      const sig = [w, h, count, s.speed, s.size, s.wind, s.color].join("|");
      if (sig === this._sig) return;
      this._sig = sig;

      // Дальность падения и цвет — на поле: их читают анимации снежинок.
      this.fieldEl.style.setProperty("--h", h + "px");
      this.fieldEl.style.setProperty("--snow-color", s.color);

      this.fieldEl.textContent = "";
      for (let i = 0; i < count; i++) {
        const flake = document.createElement("span");
        flake.className = "snow__flake";
        const size = s.size * (0.55 + rand(i, 3) * 0.9);
        const duration = (7 + rand(i, 4) * 6) / s.speed;
        flake.style.setProperty("--x", (rand(i, 1) * 100).toFixed(2) + "%");
        // Статичное положение нужно режиму без анимации (prefers-reduced-motion):
        // снег остаётся заснеженным слоем, а не пропадает.
        flake.style.setProperty("--y", (rand(i, 8) * 100).toFixed(2) + "%");
        flake.style.setProperty("--s", size.toFixed(2) + "px");
        flake.style.setProperty("--dur", duration.toFixed(2) + "s");
        // Отрицательная задержка разносит снежинки по всей высоте: иначе первый
        // кадр — пустое поле и только потом снег.
        flake.style.setProperty("--delay", (-rand(i, 5) * duration).toFixed(2) + "s");
        flake.style.setProperty("--wind", (s.wind * 300 * (0.4 + rand(i, 6))).toFixed(1) + "px");
        flake.style.setProperty("--o", (0.35 + rand(i, 7) * 0.65).toFixed(2));
        this.fieldEl.appendChild(flake);
      }
    }
  }

  return WidgetSnow;
});
