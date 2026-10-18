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
  SceneCamera — рамка веб-камеры на полноэкранных сценах.

  Геометрия и настройки хранятся в `config.scenes.<id>.camera` и приходят
  вместе со снимком состояния. Кадры камеры сервер рассылает роли `scene`,
  поэтому страница сцены декодирует тот же поток, что и оверлей.

  Переход между сценами: перед монтированием запоминаем последний прямоугольник
  камеры в `localStorage` (страницы сцен живут на одном origin). Новая сцена
  стартует с него и плавно переезжает в свой прямоугольник — при кроссфейде
  OBS это читается как движение камеры, а не как два разных кадра.
  При `prefers-reduced-motion` переход не запускается.
*/
(function () {
  "use strict";

  const LAST_RECT_KEY = "ose.camera.lastRect";
  const TRANSITION_MS = 650;
  const EASING = "cubic-bezier(0.22, 0.61, 0.36, 1)";

  const { EVENT_TYPES } = window.SharedEvents || {};
  const WebcamWidget = window.OSEWidgets && window.OSEWidgets.WebcamWidget;

  if (!WebcamWidget || !EVENT_TYPES) return;

  const motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  let sceneId = "";
  let sendCommand = null;
  let layer = null;
  let widget = null;
  let appliedSignature = "";
  let appliedRect = null;
  let active = false;

  // Препросмотр сцены в панели живёт на том же origin и не должен затирать
  // последний прямоугольник, по которому строится переход в OBS.
  const isPreview = (() => {
    try {
      return window.self !== window.top;
    } catch (_) {
      return true;
    }
  })();

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

  function reducedMotion() {
    return !!(motionQuery && motionQuery.matches);
  }

  function readCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }

  function t(key, params) {
    return window.I18n ? window.I18n.t(key, params) : key;
  }

  function context() {
    return {
      bus,
      EVENT_TYPES,
      readCssVar,
      t,
      escapeHtml,
      escapeAttr,
      send: (type, payload) => {
        if (typeof sendCommand === "function") sendCommand(type, payload);
      },
    };
  }

  function number(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function rectOf(camera) {
    const width = Math.max(5, Math.min(100, number(camera && camera.w, 24)));
    const height = Math.max(5, Math.min(100, number(camera && camera.h, 24)));
    return {
      x: Math.max(0, Math.min(100 - width, number(camera && camera.x, 3))),
      y: Math.max(0, Math.min(100 - height, number(camera && camera.y, 60))),
      w: width,
      h: height,
    };
  }

  function readLastRect() {
    try {
      const raw = JSON.parse(localStorage.getItem(LAST_RECT_KEY) || "null");
      if (!raw) return null;
      const rect = {
        x: number(raw.x, NaN),
        y: number(raw.y, NaN),
        w: number(raw.w, NaN),
        h: number(raw.h, NaN),
      };
      if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return null;
      if (rect.w <= 0 || rect.h <= 0) return null;
      return rect;
    } catch (_) {
      return null;
    }
  }

  function writeLastRect(rect) {
    if (!active || isPreview) return;
    try {
      localStorage.setItem(LAST_RECT_KEY, JSON.stringify({ ...rect, scene: sceneId }));
    } catch (_) {
      /* приватный режим или переполненное хранилище — не повод ломать сцену */
    }
  }

  function sameRect(a, b) {
    return !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  }

  function applyRect(el, rect) {
    el.style.left = rect.x + "%";
    el.style.top = rect.y + "%";
    el.style.width = rect.w + "%";
    el.style.height = rect.h + "%";
  }

  // Смена геометрии без пересоздания DOM: у рамки анимируются left/top/width/
  // height, поэтому камера переезжает, а не мигает.
  function animateRect(el, from, to, duration) {
    if (reducedMotion() || sameRect(from, to)) {
      applyRect(el, to);
      return;
    }
    const token = (el.__cameraTransition || 0) + 1;
    el.__cameraTransition = token;
    el.style.transition =
      `left ${duration}ms ${EASING}, top ${duration}ms ${EASING}, ` +
      `width ${duration}ms ${EASING}, height ${duration}ms ${EASING}`;
    applyRect(el, from);
    void el.offsetWidth;
    requestAnimationFrame(() => {
      if (el.__cameraTransition !== token) return;
      applyRect(el, to);
    });
    setTimeout(() => {
      if (el.__cameraTransition !== token) return;
      el.style.transition = "";
    }, duration + 40);
  }

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    const wrapper = document.querySelector(".scene-wrapper");
    if (!wrapper) return null;
    layer = document.createElement("div");
    layer.className = "scene-camera-layer";
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

  function createWidget(rect, config) {
    const target = ensureLayer();
    if (!target) return null;

    const last = active && !isPreview ? readLastRect() : null;
    const start = last && !sameRect(last, rect) ? last : rect;

    widget = new WebcamWidget(
      {
        id: "scene-camera",
        type: "webcam",
        x: start.x,
        y: start.y,
        w: start.w,
        h: start.h,
        z: 0,
        visible: true,
        config,
        renderType: "2d",
      },
      context()
    );
    widget.mount(target);

    if (!reducedMotion() && active) {
      if (last && !sameRect(last, rect)) {
        animateRect(widget.element, start, rect, TRANSITION_MS);
      } else if (!last && typeof widget.element.animate === "function") {
        // Первая сцена после запуска: мягкое появление, иначе рамка «прыгает».
        widget.element.animate(
          [
            { opacity: 0 },
            { opacity: 1 },
          ],
          { duration: 300, easing: "ease-out" }
        );
      }
    }

    appliedRect = { ...rect };
    widget.geometry.x = rect.x;
    widget.geometry.y = rect.y;
    widget.geometry.w = rect.w;
    widget.geometry.h = rect.h;
    writeLastRect(rect);
    return widget;
  }

  function updateWidget(rect, config) {
    const oldRect = {
      x: widget.geometry.x,
      y: widget.geometry.y,
      w: widget.geometry.w,
      h: widget.geometry.h,
    };
    const configChanged = JSON.stringify(widget.config) !== JSON.stringify(config);
    if (configChanged) {
      widget.config = { ...config };
      widget.render();
    }
    animateRect(widget.element, oldRect, rect, TRANSITION_MS);
    appliedRect = { ...rect };
    widget.geometry.x = rect.x;
    widget.geometry.y = rect.y;
    widget.geometry.w = rect.w;
    widget.geometry.h = rect.h;
    writeLastRect(rect);
  }

  // Сцена стала активной: только теперь её прямоугольник становится
  // отправной точкой для следующего перехода. Если страница была загружена
  // заранее, стартуем из последнего активного прямоугольника.
  function setActive(next) {
    active = !!next;
    if (!active || !widget || !appliedRect) return;
    const last = isPreview ? null : readLastRect();
    if (last && !sameRect(last, appliedRect)) {
      animateRect(widget.element, last, appliedRect, TRANSITION_MS);
    }
    writeLastRect(appliedRect);
  }

  function applyScene(scene) {
    const camera = scene && scene.camera;
    if (!camera || camera.enabled !== true) {
      destroy();
      return;
    }

    const rect = rectOf(camera);
    const config = camera.config && typeof camera.config === "object" ? camera.config : {};
    const signature = JSON.stringify({ rect, config });
    if (widget && signature === appliedSignature) return;

    if (!widget) {
      createWidget(rect, config);
      if (!widget) return;
    } else {
      updateWidget(rect, config);
    }
    appliedSignature = signature;
  }

  function handleBinary(data) {
    if (!data) return;
    const h264 = window.CameraFrame && window.CameraFrame.decodeH264(data);
    if (h264) {
      bus.emit(EVENT_TYPES.CAMERA_VIDEO_FRAME, h264);
      return;
    }
    const camera = window.CameraFrame && window.CameraFrame.decode(data);
    if (camera) bus.emit(EVENT_TYPES.CAMERA_VIDEO_FRAME, camera);
  }

  function handleConfig(payload) {
    bus.emit(EVENT_TYPES.CAMERA_STREAM_CONFIG, payload || {});
  }

  // Смена темы меняет `--panel-radius`; рамка пересчитывает скругление.
  function refreshTheme() {
    if (widget) widget.render();
  }

  function init(id, send) {
    sceneId = String(id || "");
    sendCommand = typeof send === "function" ? send : null;
    ensureLayer();
  }

  window.SceneCamera = { init, applyScene, setActive, handleBinary, handleConfig, refreshTheme };
})();
