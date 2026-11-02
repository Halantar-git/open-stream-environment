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
  Композиция алерта: слои картинок, видео и текста, разложенные по времени.

  Модель живёт отдельно от оверлея, потому что её используют двое: виджет
  `layer-alert` в эфире и окно монтажа. Общие здесь не только настройки, но и
  проигрыватель — иначе превью в редакторе и картинка в OBS разошлись бы
  анимациями и таймингом.

  Координаты и размеры слоя — проценты от рамки виджета, `start`/`duration` —
  миллисекунды от начала алерта. Размер текста — `cqw` (процент ширины рамки),
  поэтому композиция одинаково выглядит в превью и в эфире при любом
  разрешении источника OBS.
*/
(function (root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.LayerComposition = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const LAYER_TYPES = ["text", "image", "video"];
  const ANIMATIONS = ["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down", "zoom"];
  const ALIGNS = ["left", "center", "right"];
  const FONTS = ["body", "display", "mono"];
  const FITS = ["contain", "cover"];
  // События, на которые имеет смысл вешать композицию. Список совпадает с
  // `kind` из ALERT, кроме служебных wheel_*: у колеса своя сцена.
  const EVENT_KINDS = [
    "follow",
    "sub",
    "gift_sub",
    "cheer",
    "donation",
    "reward",
    "ai",
    "boosty_sub",
    "boosty_resub",
  ];

  const DEFAULT_DURATION_MS = 6000;
  const MIN_LAYER_MS = 100;
  const MAX_TIME_MS = 600000;
  const DEFAULT_TEXT_SIZE = 8;

  const FONT_VARS = {
    body: "var(--font-body, sans-serif)",
    display: "var(--font-display, sans-serif)",
    mono: "var(--font-mono, monospace)",
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function toNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function oneOf(value, list, fallback) {
    return list.indexOf(value) >= 0 ? value : fallback;
  }

  function normalizeType(value) {
    return oneOf(value, LAYER_TYPES, "text");
  }

  /*
    Слой приводится к полному набору полей при каждом чтении настроек. Так
    старые раскладки (и пакеты, собранные по прежней схеме) не ломают
    проигрыватель: недостающее получает умолчание, лишнее отбрасывается.
  */
  function normalizeLayer(raw, index) {
    const layer = raw && typeof raw === "object" ? raw : {};
    const type = normalizeType(layer.type);
    return {
      id: layer.id != null && layer.id !== "" ? String(layer.id) : "layer-" + (index + 1),
      type,
      text: layer.text != null ? String(layer.text) : "",
      src: layer.src != null ? String(layer.src) : "",
      x: clamp(toNumber(layer.x, 10), -100, 200),
      y: clamp(toNumber(layer.y, 10), -100, 200),
      w: clamp(toNumber(layer.w, 80), 1, 200),
      h: clamp(toNumber(layer.h, 20), 1, 200),
      start: clamp(toNumber(layer.start, 0), 0, MAX_TIME_MS),
      duration: clamp(toNumber(layer.duration, 4000), MIN_LAYER_MS, MAX_TIME_MS),
      z: clamp(Math.round(toNumber(layer.z, 1)), 0, 100),
      opacity: clamp(toNumber(layer.opacity, 1), 0, 1),
      size: clamp(toNumber(layer.size, DEFAULT_TEXT_SIZE), 0.5, 50),
      color: layer.color != null ? String(layer.color) : "#ffffff",
      align: oneOf(layer.align, ALIGNS, "center"),
      weight: clamp(Math.round(toNumber(layer.weight, 600)), 100, 900),
      font: oneOf(layer.font, FONTS, "body"),
      fit: oneOf(layer.fit, FITS, "contain"),
      loop: layer.loop !== false,
      in: oneOf(layer.in, ANIMATIONS, "fade"),
      out: oneOf(layer.out, ANIMATIONS, "fade"),
      inMs: clamp(toNumber(layer.inMs, 300), 0, 5000),
      outMs: clamp(toNumber(layer.outMs, 300), 0, 5000),
    };
  }

  function normalizeKinds(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const kinds = [];
    value.forEach((kind) => {
      const name = String(kind || "");
      if (!name || seen.has(name)) return;
      seen.add(name);
      kinds.push(name);
    });
    return kinds;
  }

  // Слои одной композиции. Идентификатор нужен редактору и проигрывателю,
  // поэтому дубликаты разводим суффиксом, а не оставляем двум слоям один ключ.
  function normalizeLayers(value) {
    const rawLayers = Array.isArray(value) ? value : [];
    const usedIds = new Set();
    return rawLayers.map((raw, index) => {
      const layer = normalizeLayer(raw, index);
      let id = layer.id;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = layer.id + "-" + suffix;
        suffix += 1;
      }
      usedIds.add(id);
      layer.id = id;
      return layer;
    });
  }

  // Одна композиция: минимальная длительность и слои. Этого достаточно
  // проигрывателю, превью и таймлайну.
  function normalizeComposition(source) {
    const config = source && typeof source === "object" ? source : {};
    return {
      durationMs: clamp(
        toNumber(config.durationMs, DEFAULT_DURATION_MS),
        MIN_LAYER_MS,
        MAX_TIME_MS
      ),
      layers: normalizeLayers(config.layers),
    };
  }

  // Отдельные реакции по категориям. Ключ — `kind` события, значение — своя
  // композиция. Пустой объект значит «у всех категорий общая композиция».
  function normalizeReactions(value) {
    const reactions = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return reactions;
    Object.keys(value).forEach((kind) => {
      if (!kind || kind === "__proto__" || kind === "constructor" || kind === "prototype") return;
      const composition = value[kind];
      if (!composition || typeof composition !== "object" || Array.isArray(composition)) return;
      reactions[kind] = normalizeComposition(composition);
    });
    return reactions;
  }

  function normalizeConfig(config) {
    const source = config && typeof config === "object" ? config : {};
    const composition = normalizeComposition(source);
    return {
      eventKinds: normalizeKinds(source.eventKinds),
      durationMs: composition.durationMs,
      layers: composition.layers,
      reactions: normalizeReactions(source.reactions),
    };
  }

  // Композиция для конкретного события: своя реакция категории, если она
  // задана, иначе общая. Пустая своя реакция — осознанное «молчать»: слоёв
  // нет, и виджет просто не играет этот алерт.
  function compositionForEvent(config, kind) {
    const normalized = normalizeConfig(config);
    const own = kind ? normalized.reactions[String(kind)] : null;
    if (own) return own;
    return { durationMs: normalized.durationMs, layers: normalized.layers };
  }

  // Сколько длится композиция: минимальная длительность из настроек или
  // конец самого позднего слоя — что позже.
  function compositionDuration(config) {
    const normalized = normalizeComposition(config);
    let end = normalized.durationMs;
    normalized.layers.forEach((layer) => {
      end = Math.max(end, layer.start + layer.duration);
    });
    return Math.max(MIN_LAYER_MS, end);
  }

  function matchesEvent(config, alert) {
    const kinds = normalizeKinds(config && config.eventKinds);
    if (!kinds.length) return true;
    return kinds.indexOf(String((alert && alert.kind) || "")) >= 0;
  }

  /*
    Подстановки в текстовом слое. Неизвестный ключ остаётся пустым: опечатка в
    шаблоне не должна показывать зрителю `{{users}}`.
  */
  function fillText(template, alert, options) {
    const source = alert && typeof alert === "object" ? alert : {};
    const opts = options || {};
    const money =
      typeof opts.formatMoney === "function"
        ? opts.formatMoney
        : (value) => (value == null ? "" : String(value));
    const symbol =
      typeof opts.currencySymbol === "function"
        ? opts.currencySymbol
        : (value) => String(value || "");
    const values = {
      user: source.user || "",
      amount: source.amount != null ? money(source.amount) : "",
      currency: source.currency ? symbol(source.currency) : "",
      message: source.message || "",
      count: source.count != null ? String(source.count) : "",
      months: source.months != null ? String(source.months) : "",
      title: source.rewardTitle || source.musicTitle || source.title || "",
      reward: source.rewardTitle || "",
      kind: source.kind || "",
    };
    return String(template == null ? "" : template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
      return values[key] != null ? values[key] : "";
    });
  }

  function resolveMedia(src, options) {
    const value = String(src || "").trim();
    if (!value) return "";
    if (/^(https?:)?\/\//i.test(value) || /^(data|blob):/i.test(value)) return value;
    if (options && typeof options.resolveMediaUrl === "function") {
      return options.resolveMediaUrl(value);
    }
    return "/" + value.replace(/^\/+/, "");
  }

  // ---- DOM ----

  function enterTransform(name) {
    switch (name) {
      case "slide-left":
        return "translateX(14%)";
      case "slide-right":
        return "translateX(-14%)";
      case "slide-up":
        return "translateY(14%)";
      case "slide-down":
        return "translateY(-14%)";
      case "zoom":
        return "scale(0.72)";
      default:
        return "none";
    }
  }

  function exitTransform(name) {
    switch (name) {
      case "slide-left":
        return "translateX(-14%)";
      case "slide-right":
        return "translateX(14%)";
      case "slide-up":
        return "translateY(-14%)";
      case "slide-down":
        return "translateY(14%)";
      case "zoom":
        return "scale(0.72)";
      default:
        return "none";
    }
  }

  function setVisual(el, opacity, transform, ms) {
    el.style.transition = ms > 0 ? "opacity " + ms + "ms ease, transform " + ms + "ms ease" : "none";
    el.style.opacity = String(opacity);
    el.style.transform = transform || "none";
  }

  function createLayerNode(doc, layer, alert, options) {
    const el = doc.createElement("div");
    el.className = "la-layer la-layer--" + layer.type;
    el.style.left = layer.x + "%";
    el.style.top = layer.y + "%";
    el.style.width = layer.w + "%";
    el.style.height = layer.h + "%";
    el.style.zIndex = String(layer.z);
    el.style.opacity = "0";

    let video = null;
    if (layer.type === "text") {
      const text = doc.createElement("div");
      text.className = "la-text";
      text.style.fontSize = layer.size + "cqw";
      text.style.color = layer.color;
      text.style.textAlign = layer.align;
      text.style.fontWeight = String(layer.weight);
      text.style.fontFamily = FONT_VARS[layer.font] || FONT_VARS.body;
      text.style.alignItems =
        layer.align === "left" ? "flex-start" : layer.align === "right" ? "flex-end" : "center";
      text.textContent = fillText(layer.text, alert, options);
      el.appendChild(text);
    } else if (layer.type === "image") {
      const img = doc.createElement("img");
      img.className = "la-media";
      img.alt = "";
      img.decoding = "async";
      img.style.objectFit = layer.fit;
      const src = resolveMedia(layer.src, options);
      if (src) img.src = src;
      el.appendChild(img);
    } else if (layer.type === "video") {
      video = doc.createElement("video");
      video.className = "la-media";
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.loop = layer.loop !== false;
      video.style.objectFit = layer.fit;
      const src = resolveMedia(layer.src, options);
      if (src) video.src = src;
      el.appendChild(video);
    }
    return { el, video };
  }

  function playVideo(video) {
    try {
      const attempt = video.play();
      if (attempt && typeof attempt.catch === "function") attempt.catch(() => {});
    } catch (_) {
      /* видео без источника — не повод ломать алерт */
    }
  }

  function pauseVideo(video) {
    try {
      video.pause();
    } catch (_) {
      /* проигрыватель мог быть уже уничтожен */
    }
  }

  // Статичная раскладка всех слоёв сразу: по ней в редакторе видно, где что
  // стоит, не дожидаясь начала проигрывания.
  function renderStatic(host, config, alert, options) {
    if (!host) return;
    host.innerHTML = "";
    const doc = host.ownerDocument || (typeof document !== "undefined" ? document : null);
    if (!doc) return;
    const normalized = normalizeComposition(config);
    const root = doc.createElement("div");
    root.className = "la-composition";
    normalized.layers.forEach((layer) => {
      const node = createLayerNode(doc, layer, alert, options);
      node.el.style.opacity = String(layer.opacity);
      root.appendChild(node.el);
      if (node.video) playVideo(node.video);
    });
    host.appendChild(root);
  }

  function createPlayer(host, options) {
    const opts = options || {};
    let timers = new Set();
    let nodes = [];
    let stopped = true;
    let finished = null;

    function clearTimers() {
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
    }

    function later(fn, ms) {
      const id = setTimeout(() => {
        timers.delete(id);
        if (!stopped) fn();
      }, Math.max(0, ms));
      timers.add(id);
      return id;
    }

    function requestFrame(fn) {
      if (typeof requestAnimationFrame === "function") return requestAnimationFrame(fn);
      return later(fn, 16);
    }

    function reset(clear) {
      clearTimers();
      nodes.forEach((node) => {
        if (node.video) pauseVideo(node.video);
      });
      nodes = [];
      if (clear && host) host.innerHTML = "";
    }

    function stop() {
      stopped = true;
      finished = null;
      reset(true);
    }

    function showLayer(node, layer) {
      node.el.hidden = false;
      const animate = layer.in !== "none" && layer.inMs > 0;
      if (!animate) {
        setVisual(node.el, layer.opacity, "none", 0);
      } else {
        setVisual(node.el, 0, enterTransform(layer.in), 0);
        // Без чтения раскладки браузер может схлопнуть начальное и конечное
        // состояние в один кадр, и переход не сыграет.
        void node.el.offsetWidth;
        requestFrame(() => {
          if (stopped) return;
          setVisual(node.el, layer.opacity, "none", layer.inMs);
        });
      }
      if (node.video) playVideo(node.video);
    }

    function exitLayer(node, layer) {
      if (layer.out === "none" || layer.outMs <= 0) return;
      setVisual(node.el, 0, exitTransform(layer.out), layer.outMs);
    }

    function hideLayer(node) {
      node.el.hidden = true;
      if (node.video) pauseVideo(node.video);
    }

    /*
      Проиграть композицию один раз. `onDone` зовётся по времени композиции,
      а не по последнему слою: пауза между алертами в очереди тоже настраивается
      длительностью.
    */
    function play(config, alert, onDone) {
      stop();
      if (!host) return 0;
      const doc = host.ownerDocument || (typeof document !== "undefined" ? document : null);
      if (!doc) return 0;
      stopped = false;
      finished = typeof onDone === "function" ? onDone : null;

      const normalized = normalizeComposition(config);
      const root = doc.createElement("div");
      root.className = "la-composition";

      normalized.layers.forEach((layer) => {
        const node = createLayerNode(doc, layer, alert, opts);
        nodes.push(node);
        root.appendChild(node.el);

        later(() => showLayer(node, layer), layer.start);
        const end = layer.start + layer.duration;
        if (layer.out !== "none" && layer.outMs > 0) {
          later(() => exitLayer(node, layer), Math.max(layer.start, end - layer.outMs));
        }
        later(() => hideLayer(node), end);
      });

      host.appendChild(root);

      const total = compositionDuration(normalized);
      later(() => {
        const callback = finished;
        finished = null;
        stopped = true;
        reset(false);
        if (callback) callback();
      }, total);
      return total;
    }

    return { play, stop };
  }

  return {
    LAYER_TYPES,
    ANIMATIONS,
    ALIGNS,
    FONTS,
    FITS,
    EVENT_KINDS,
    DEFAULT_DURATION_MS,
    MIN_LAYER_MS,
    normalizeLayer,
    normalizeLayers,
    normalizeComposition,
    normalizeConfig,
    compositionForEvent,
    compositionDuration,
    matchesEvent,
    fillText,
    resolveMedia,
    renderStatic,
    createPlayer,
  };
});
