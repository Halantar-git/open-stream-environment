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
  Webcam frame widget — decoration only.

  Видео с камеры сюда не попадает намеренно: страница оверлея живёт в OBS
  Browser Source, а тому браузер не выдаёт доступ к камере (та же причина,
  по которой микрофон захватывает панель управления, а не оверлей). Камеру
  добавляют в OBS отдельным источником, а этот виджет рисует рамку поверх или
  под ней: прозрачный центр, акцентные уголки и бейдж.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WebcamWidget = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WebcamWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WebcamWidget = WebcamWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  // В конфиг может попасть что угодно (например, после ручной правки JSON):
  // в CSS подставляем только одиночный цвет или ссылку на токен темы.
  const SAFE_ACCENT = /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))$/i;
  const LABEL_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"];
  const CORNERS = ["tl", "tr", "bl", "br"];

  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  class WebcamWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-webcam";
      this.element.appendChild(this.host);
    }

    render() {
      const { escapeHtml, escapeAttr } = this.context;
      const cfg = this.config;

      const accent = SAFE_ACCENT.test(String(cfg.color || "").trim()) ? String(cfg.color).trim() : "var(--md-primary)";
      const thickness = clamp(Math.round(num(cfg.thickness, 4)), 1, 16);
      const radius = clamp(Math.round(num(cfg.radius, 16)), 0, 64);
      const position = LABEL_POSITIONS.includes(cfg.labelPosition) ? cfg.labelPosition : "top-left";
      const label = String(cfg.label == null ? "LIVE" : cfg.label).trim();
      const showLabel = cfg.showLabel !== false && label.length > 0;

      this.host.style.setProperty("--webcam-accent", accent);
      this.host.style.setProperty("--webcam-thickness", `${thickness}px`);
      this.host.style.setProperty("--webcam-radius", `${radius}px`);

      const parts = [];
      if (cfg.showBackground) parts.push(`<div class="widget-webcam__backdrop"></div>`);
      if (cfg.showBorder !== false) parts.push(`<div class="widget-webcam__frame"></div>`);
      if (cfg.showCorners !== false) {
        parts.push(...CORNERS.map((corner) => `<span class="widget-webcam__corner" data-corner="${corner}"></span>`));
      }
      if (showLabel) {
        parts.push(
          `<div class="widget-webcam__label" data-pos="${escapeAttr(position)}">` +
            `<span class="widget-webcam__dot"></span>` +
            `<span class="widget-webcam__label-text">${escapeHtml(label)}</span>` +
            `</div>`
        );
      }
      if (cfg.showVignette) parts.push(`<div class="widget-webcam__vignette"></div>`);

      this.host.innerHTML = parts.join("");
    }
  }

  return WebcamWidget;
});
