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
  SceneAlerts — виджет алертов на полноэкранных сценах.

  Геометрия и включение живут в `config.scenes.<id>.alerts` и приезжают
  вместе со снимком состояния. Сам виджет — тот же `AlertsWidget`, что и на
  оверлее: сцены получают те же карточки, оформленные токенами активной темы.
  Сервер рассылает алерты всем клиентам, поэтому странице достаточно
  переложить их в шину виджета.
*/
(function () {
  "use strict";

  const { EVENT_TYPES } = window.SharedEvents || {};
  const AlertsWidget = window.OSEWidgets && window.OSEWidgets.AlertsWidget;

  if (!AlertsWidget || !EVENT_TYPES) return;

  let layer = null;
  let widget = null;
  let appliedSignature = "";

  const handlers = new Map();
  const bus = {
    on(channel, handler) {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel).add(handler);
      return () => handlers.get(channel)?.delete(handler);
    },
    off(channel, handler) {
      handlers.get(channel)?.delete(handler);
    },
    emit(channel, payload) {
      const set = handlers.get(channel);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(payload);
        } catch (_) {
          /* один виджет не должен ронять остальные */
        }
      }
    },
  };

  function t(key, params) {
    return window.I18n ? window.I18n.t(key, params) : key;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }

  function formatMoney(value) {
    const locale = window.I18n && window.I18n.getLang() === "ru" ? "ru-RU" : "en-US";
    return Number(value || 0).toLocaleString(locale);
  }

  const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", UAH: "₴", KZT: "₸", GBP: "£" };
  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || code || "";
  }

  function context() {
    return {
      bus,
      EVENT_TYPES,
      t,
      ICONS: window.SharedIcons ? window.SharedIcons.ICONS : {},
      escapeHtml,
      escapeAttr,
      formatMoney,
      currencySymbol,
      readCssVar: (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    };
  }

  function number(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function rectOf(alerts) {
    const width = Math.max(5, Math.min(100, number(alerts && alerts.w, 28)));
    const height = Math.max(5, Math.min(100, number(alerts && alerts.h, 30)));
    return {
      x: Math.max(0, Math.min(100 - width, number(alerts && alerts.x, 68))),
      y: Math.max(0, Math.min(100 - height, number(alerts && alerts.y, 2))),
      w: width,
      h: height,
    };
  }

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    const wrapper = document.querySelector(".scene-wrapper");
    if (!wrapper) return null;
    layer = document.createElement("div");
    layer.className = "scene-alerts-layer";
    wrapper.appendChild(layer);
    return layer;
  }

  function destroy() {
    appliedSignature = "";
    if (widget) {
      widget.unmount();
      widget = null;
    }
  }

  function createWidget(rect) {
    const target = ensureLayer();
    if (!target) return;
    widget = new AlertsWidget(
      {
        id: "scene-alerts",
        type: "alerts",
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        z: 0,
        visible: true,
        config: {},
        renderType: "2d",
      },
      context()
    );
    widget.mount(target);
  }

  function applyScene(scene) {
    const alerts = scene && scene.alerts;
    if (!alerts || alerts.enabled !== true) {
      destroy();
      return;
    }

    const rect = rectOf(alerts);
    const signature = JSON.stringify(rect);
    if (widget && signature === appliedSignature) return;

    if (!widget) {
      createWidget(rect);
      if (!widget) return;
    } else {
      widget.update({ ...rect, config: {} });
    }
    appliedSignature = signature;
  }

  function handleAlert(alert) {
    if (!widget || !alert) return;
    bus.emit(EVENT_TYPES.ALERT, alert);
  }

  // Карточки берут цвета и шрифты из CSS-переменных, которые обновляются на
  // корне документа, — перерисовывать уже показанные не нужно.
  function refreshTheme() {}

  function init() {
    ensureLayer();
  }

  window.SceneAlerts = { init, applyScene, handleAlert, refreshTheme };
})();
