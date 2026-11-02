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

  const LAYER_TYPES = ["text", "image", "video", "audio", "shape"];
  const ANIMATIONS = ["none", "fade", "slide-left", "slide-right", "slide-up", "slide-down", "zoom"];
  const ALIGNS = ["left", "center", "right"];
  const FONTS = ["body", "display", "mono"];
  const FITS = ["contain", "cover"];
  // Как текст слоя появляется на экране: сразу, посимвольно как в теме Terminal,
  // по словам, по буквам или дешифровкой.
  const TEXT_ANIMS = ["none", "type", "words", "letters", "scramble"];
  // Из чего собираются случайные буквы дешифровки: латиница и цифры читаются
  // как шум, а кириллица в наборе делала бы подмену незаметной.
  const SCRAMBLE_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&@*<>|/";
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
  // Скорость печати — миллисекунды на символ. 16 мс читается спокойнее, чем
  // терминальные два символа за такт, но не тормозит длинное сообщение.
  const DEFAULT_TYPE_MS = 16;
  const MIN_TYPE_MS = 4;
  const MAX_TYPE_MS = 120;

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
      // Второй цвет и угол нужны плашке-градиенту; тексту они не мешают.
      color2: layer.color2 != null ? String(layer.color2) : "#ff4fd8",
      angle: clamp(toNumber(layer.angle, 90), 0, 360),
      radius: clamp(toNumber(layer.radius, 0), 0, 50),
      fade: layer.fade === true,
      align: oneOf(layer.align, ALIGNS, "center"),
      weight: clamp(Math.round(toNumber(layer.weight, 600)), 100, 900),
      font: oneOf(layer.font, FONTS, "body"),
      italic: layer.italic === true,
      fit: oneOf(layer.fit, FITS, "contain"),
      loop: layer.loop !== false,
      volume: clamp(toNumber(layer.volume, 0.8), 0, 1),
      textAnim: oneOf(layer.textAnim, TEXT_ANIMS, "none"),
      typeMs: clamp(toNumber(layer.typeMs, DEFAULT_TYPE_MS), MIN_TYPE_MS, MAX_TYPE_MS),
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
      // Режим списка: новое событие сверху, старые строки уезжают вниз.
      stack: config.stack === true,
      stackMax: clamp(Math.round(toNumber(config.stackMax, 3)), 2, 6),
      // Настройка «висеть постоянно»: строки списка не исчезают по таймеру, их
      // вытесняет только новое событие. Так счётчик фолловеров висит в эфире.
      persistent: config.persistent === true,
      // Порог доната: ниже этой суммы композиция молчит. Ноль — показывать все.
      minAmount: clamp(toNumber(config.minAmount, 0), 0, 1000000000),
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
      stack: composition.stack,
      stackMax: composition.stackMax,
      persistent: composition.persistent,
      minAmount: composition.minAmount,
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
    return {
      durationMs: normalized.durationMs,
      stack: normalized.stack,
      stackMax: normalized.stackMax,
      persistent: normalized.persistent,
      minAmount: normalized.minAmount,
      layers: normalized.layers,
    };
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

  /*
    Прямое управление слоем в превью — как в OBS. `dir` — сторона или угол
    (`n`, `se`, `move` и т.д.), смещение — в процентах рамки. Минимальный размер
    не даёт рамке перевернуться: при пересечении тянем противоположный край.
  */
  function applyLayerDrag(rect, dir, dx, dy) {
    const source = rect || {};
    const ow = toNumber(source.w, 1);
    const oh = toNumber(source.h, 1);
    let x = toNumber(source.x, 0);
    let y = toNumber(source.y, 0);
    let w = ow;
    let h = oh;

    if (dir === "move") {
      x += dx;
      y += dy;
    } else {
      if (dir.indexOf("e") >= 0) w = ow + dx;
      if (dir.indexOf("s") >= 0) h = oh + dy;
      if (dir.indexOf("w") >= 0) {
        w = ow - dx;
        x = toNumber(source.x, 0) + dx;
      }
      if (dir.indexOf("n") >= 0) {
        h = oh - dy;
        y = toNumber(source.y, 0) + dy;
      }
      if (w < 1) {
        if (dir.indexOf("w") >= 0) x = toNumber(source.x, 0) + ow - 1;
        w = 1;
      }
      if (h < 1) {
        if (dir.indexOf("n") >= 0) y = toNumber(source.y, 0) + oh - 1;
        h = 1;
      }
    }

    return {
      x: clamp(x, -100, 200),
      y: clamp(y, -100, 200),
      w: clamp(w, 1, 200),
      h: clamp(h, 1, 200),
    };
  }

  function matchesEvent(config, alert) {
    const kinds = normalizeKinds(config && config.eventKinds);
    if (!kinds.length) return true;
    return kinds.indexOf(String((alert && alert.kind) || "")) >= 0;
  }

  /*
    Порог суммы: донат ниже него композиция не играет. Проверяем только
    донаты — остальные события денег не несут, а тестовый алерт должен играть
    всегда, иначе кнопку «Тест» нечем проверить. Так же считает и общая
    очередь алертов на сервере.
  */
  function passesAmount(composition, alert) {
    const min = toNumber(composition && composition.minAmount, 0);
    if (min <= 0) return true;
    const event = alert || {};
    if (event.isTest) return true;
    if (String(event.kind || "") !== "donation") return true;
    const amount = Number(event.amount);
    return Number.isFinite(amount) ? amount >= min : true;
  }

  // Категории, для которых есть человекочитаемая подпись в словаре.
  const EVENT_KIND_LABELS = [
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
    const kind = String(source.kind || "");
    // `{{event}}` — подпись для строки списка: «Фолловер», «Подписка» и т.д.
    // Без словаря остаётся технический `kind`, чтобы строка не была пустой.
    const kindLabel =
      typeof opts.t === "function" && EVENT_KIND_LABELS.indexOf(kind) >= 0
        ? opts.t("eventKind." + kind)
        : kind;
    const values = {
      user: source.user || "",
      amount: source.amount != null ? money(source.amount) : "",
      currency: source.currency ? symbol(source.currency) : "",
      message: source.message || "",
      count: source.count != null ? String(source.count) : "",
      months: source.months != null ? String(source.months) : "",
      title: source.rewardTitle || source.musicTitle || source.title || "",
      reward: source.rewardTitle || "",
      kind,
      event: kindLabel,
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

  /*
    Фон плашки: градиент из двух цветов. «Растворять» убирает второй цвет —
    полоса уходит в прозрачность, как в HUD-панелях. Угол — в градусах, как
    у `linear-gradient` в CSS.
  */
  function shapeBackground(layer) {
    const to = layer.fade ? "transparent" : layer.color2;
    return "linear-gradient(" + layer.angle + "deg, " + layer.color + ", " + to + ")";
  }

  function createLayerNode(doc, layer, alert, options) {
    const el = doc.createElement("div");
    el.className = "la-layer la-layer--" + layer.type;
    el.dataset.layerId = layer.id;
    el.style.left = layer.x + "%";
    el.style.top = layer.y + "%";
    el.style.width = layer.w + "%";
    el.style.height = layer.h + "%";
    el.style.zIndex = String(layer.z);
    el.style.opacity = "0";

    let video = null;
    let audio = null;
    let textEl = null;
    if (layer.type === "text") {
      const text = doc.createElement("div");
      textEl = text;
      text.className = "la-text";
      // В списке строка занимает часть рамки: `--la-text-scale` уменьшает шрифт
      // вместе с ней, иначе текст одной строки был бы выше самой строки.
      text.style.fontSize = "calc(" + layer.size + "cqw * var(--la-text-scale, 1))";
      text.style.color = layer.color;
      text.style.textAlign = layer.align;
      text.style.fontWeight = String(layer.weight);
      text.style.fontStyle = layer.italic ? "italic" : "normal";
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
    } else if (layer.type === "audio") {
      // Звук — невидимый слой: координаты ему не нужны, но окно времени
      // (`start`/`duration`) общее с остальными, поэтому он живёт в той же
      // дорожке таймлайна.
      audio = doc.createElement("audio");
      audio.className = "la-audio";
      audio.preload = "auto";
      audio.loop = layer.loop !== false;
      audio.volume = clamp(layer.volume, 0, 1);
      const src = resolveMedia(layer.src, options);
      if (src) audio.src = src;
      el.appendChild(audio);
    } else if (layer.type === "shape") {
      const shape = doc.createElement("div");
      shape.className = "la-shape";
      shape.style.background = shapeBackground(layer);
      // Скругление — в процентах ширины рамки, как размер текста: композиция
      // масштабируется вместе с виджетом.
      shape.style.borderRadius = layer.radius + "cqw";
      el.appendChild(shape);
    }
    return { el, video, audio, text: textEl };
  }

  function playMedia(media) {
    try {
      const attempt = media.play();
      if (attempt && typeof attempt.catch === "function") attempt.catch(() => {});
    } catch (_) {
      /* нет источника или автозапуск запрещён — не повод ломать алерт */
    }
  }

  function pauseMedia(media) {
    try {
      media.pause();
    } catch (_) {
      /* проигрыватель мог быть уже уничтожен */
    }
  }

  function playVideo(video) {
    playMedia(video);
  }

  function pauseVideo(video) {
    pauseMedia(video);
  }

  function playAudio(audio) {
    playMedia(audio);
  }

  function pauseAudio(audio) {
    pauseMedia(audio);
  }

  // ---- печать текста ----

  function reduceMotion() {
    return (
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  /*
    Посимвольная печать — тот же приём, что в теме Terminal: текст раскрывается
    по одному символу, в конце мигает каретка. Режем по code point'ам, иначе
    эмодзи на одном такте разваливается на половинки суррогатной пары.

    Полный текст заменяется текстовым узлом, который дописываем: так каретка
    стоит ровно в конце набранного, а не после всего абзаца.
  */
  function startTyping(node, layer) {
    const el = node.text;
    const doc = el && el.ownerDocument;
    if (!doc || typeof doc.createTextNode !== "function") return;
    const glyphs = Array.from(String(el.textContent == null ? "" : el.textContent));
    if (!glyphs.length || reduceMotion()) return;
    stopTyping(node);
    // `.la-text` — flex-колонка: текст и каретка отдельными элементами встали
    // бы друг под другом. Поэтому печатаем внутри блока на всю ширину — там
    // каретка идёт сразу за последней буквой, как в терминале.
    const holder = doc.createElement("span");
    holder.className = "la-text__typed";
    const textNode = doc.createTextNode("");
    const caret = doc.createElement("span");
    caret.className = "type-caret";
    el.textContent = "";
    el.appendChild(holder);
    holder.appendChild(textNode);
    holder.appendChild(caret);
    const step = clamp(toNumber(layer.typeMs, DEFAULT_TYPE_MS), MIN_TYPE_MS, MAX_TYPE_MS);
    let shown = 0;
    node.typing = setInterval(() => {
      shown += 1;
      textNode.nodeValue = glyphs.slice(0, shown).join("");
      // Каретка остаётся мигать и после последнего символа — как в терминале.
      if (shown >= glyphs.length) stopTyping(node, true);
    }, step);
  }

  function stopTyping(node, keepCaret) {
    if (node.typing) {
      clearInterval(node.typing);
      node.typing = null;
    }
    const el = node.text;
    const caret = el && typeof el.querySelector === "function" ? el.querySelector(".type-caret") : null;
    if (caret && caret.parentNode && keepCaret !== true) caret.parentNode.removeChild(caret);
  }

  /*
    Появление кусками: слово или буква проявляются и чуть поднимаются. Буквы
    группируются по словам — иначе строка ломалась бы посреди слова, ведь
    каждая буква — отдельный inline-block.
  */
  function startChunks(node, layer, unit) {
    const el = node.text;
    const doc = el && el.ownerDocument;
    if (!doc || typeof doc.createTextNode !== "function" || typeof doc.createElement !== "function") {
      return;
    }
    const text = String(el.textContent == null ? "" : el.textContent);
    if (!text.trim() || reduceMotion()) return;
    stopTyping(node);

    const holder = doc.createElement("span");
    holder.className = "la-text__typed";
    const chunks = [];
    const addChunk = (value, parent) => {
      const span = doc.createElement("span");
      span.className = "la-text__chunk";
      span.textContent = value;
      span.style.display = "inline-block";
      span.style.opacity = "0";
      span.style.transform = "translateY(0.3em)";
      span.style.transition = "opacity 220ms ease, transform 220ms ease";
      parent.appendChild(span);
      chunks.push(span);
    };

    text.split(/(\s+)/).forEach((part) => {
      if (!part) return;
      if (/^\s+$/.test(part)) {
        holder.appendChild(doc.createTextNode(part));
        return;
      }
      if (unit === "words") {
        addChunk(part, holder);
        return;
      }
      const word = doc.createElement("span");
      word.className = "la-text__word";
      word.style.display = "inline-block";
      holder.appendChild(word);
      Array.from(part).forEach((ch) => addChunk(ch, word));
    });

    el.textContent = "";
    el.appendChild(holder);

    const base = clamp(toNumber(layer.typeMs, DEFAULT_TYPE_MS), MIN_TYPE_MS, MAX_TYPE_MS);
    // Слово — крупнее буквы, поэтому ровно тот же шаг читался бы как вспышка.
    const step = unit === "words" ? base * 4 : base;
    let index = 0;
    node.typing = setInterval(() => {
      const chunk = chunks[index];
      if (!chunk) {
        stopTyping(node);
        return;
      }
      chunk.style.opacity = "1";
      chunk.style.transform = "none";
      index += 1;
      if (index >= chunks.length) stopTyping(node);
    }, step);
  }

  /*
    Дешифровка: текст раскрывается по символу, а последние два ещё «шумят»
    случайными знаками, прежде чем встать на место. Ширина строки при этом
    не дёргается — число символов сразу окончательное.
  */
  function startScramble(node, layer) {
    const el = node.text;
    const doc = el && el.ownerDocument;
    if (!doc || typeof doc.createTextNode !== "function") return;
    const glyphs = Array.from(String(el.textContent == null ? "" : el.textContent));
    if (!glyphs.length || reduceMotion()) return;
    stopTyping(node);

    const textNode = doc.createTextNode("");
    el.textContent = "";
    el.appendChild(textNode);

    const step = clamp(toNumber(layer.typeMs, DEFAULT_TYPE_MS), MIN_TYPE_MS, MAX_TYPE_MS);
    let shown = 0;
    const render = (settled) => {
      let out = "";
      for (let i = 0; i < shown; i += 1) {
        const ch = glyphs[i];
        out +=
          i < settled || /\s/.test(ch)
            ? ch
            : SCRAMBLE_GLYPHS.charAt(Math.floor(Math.random() * SCRAMBLE_GLYPHS.length));
      }
      textNode.nodeValue = out;
    };

    node.typing = setInterval(() => {
      if (shown < glyphs.length) {
        shown += 1;
        render(shown - 2);
        return;
      }
      render(glyphs.length);
      stopTyping(node);
    }, step);
  }

  function startTextReveal(node, layer) {
    if (layer.textAnim === "type") startTyping(node, layer);
    else if (layer.textAnim === "words" || layer.textAnim === "letters") {
      startChunks(node, layer, layer.textAnim);
    } else if (layer.textAnim === "scramble") startScramble(node, layer);
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
        stopTyping(node);
        if (node.video) pauseVideo(node.video);
        if (node.audio) pauseAudio(node.audio);
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
      if (node.audio) playAudio(node.audio);
      // Появление текста идёт поверх входа: слой может одновременно выезжать
      // и печатать или проявляться по словам.
      if (node.text) startTextReveal(node, layer);
    }

    function exitLayer(node, layer) {
      if (layer.out === "none" || layer.outMs <= 0) return;
      setVisual(node.el, 0, exitTransform(layer.out), layer.outMs);
    }

    function hideLayer(node) {
      node.el.hidden = true;
      stopTyping(node);
      if (node.video) pauseVideo(node.video);
      if (node.audio) pauseAudio(node.audio);
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
      // Постоянная композиция не гаснет: слои остаются в кадре, пока их не
      // заменит следующее событие или пока список не вытеснит самую старую
      // строку.
      const persistent = normalized.persistent && normalized.stack;
      const root = doc.createElement("div");
      root.className = "la-composition";

      normalized.layers.forEach((layer) => {
        const node = createLayerNode(doc, layer, alert, opts);
        nodes.push(node);
        root.appendChild(node.el);

        later(() => showLayer(node, layer), layer.start);
        if (persistent) return;
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
        // Постоянные строки остаются живыми: видео продолжает крутиться,
        // звук и печать не обрываются по общему таймеру.
        if (!persistent) reset(false);
        if (callback) callback();
      }, total);
      return total;
    }

    return { play, stop };
  }

  /*
    Список одновременных алертов: новое событие ставится в верхнюю строку,
    остальные сдвигаются вниз. Высота строки — `100 / stackMax` рамки, поэтому
    одну строку и рисуют в редакторе. Старые строки уходят сами по времени
    композиции, а у постоянной — только при переполнении снимается самая нижняя.
  */
  function createStack(host, options) {
    const opts = options || {};
    const items = [];
    let slotHeight = 100;
    let emptyHandler = null;

    function layout() {
      items.forEach((item, index) => {
        item.el.style.top = index * slotHeight + "%";
        item.el.style.height = slotHeight + "%";
        item.el.style.setProperty("--la-text-scale", String(slotHeight / 100));
      });
    }

    function notifyEmpty() {
      if (!items.length && emptyHandler) emptyHandler();
    }

    function removeItem(item, animated) {
      const index = items.indexOf(item);
      if (index >= 0) items.splice(index, 1);
      if (item.player) item.player.stop();
      layout();

      const detach = () => {
        if (item.el.parentNode) item.el.parentNode.removeChild(item.el);
        notifyEmpty();
      };
      if (animated) {
        item.el.style.opacity = "0";
        item.el.style.transform = "translateY(-8px)";
        setTimeout(detach, 220);
      } else {
        detach();
      }
    }

    function push(composition, alert) {
      const normalized = normalizeComposition(composition);
      const max = normalized.stackMax;
      slotHeight = 100 / max;
      while (items.length >= max) {
        // Снимаем самую нижнюю (самую старую) строку, чтобы не вылезать за рамку.
        removeItem(items[items.length - 1], true);
      }

      const doc = host.ownerDocument || (typeof document !== "undefined" ? document : null);
      if (!doc) return null;
      const el = doc.createElement("div");
      el.className = "la-stack__item";
      el.style.top = "0%";
      el.style.width = "100%";
      el.style.height = slotHeight + "%";
      el.style.setProperty("--la-text-scale", String(slotHeight / 100));
      el.style.opacity = "0";
      el.style.transform = "translateY(-8px)";
      host.appendChild(el);

      const item = { el, player: null, persistent: normalized.persistent };
      items.unshift(item);
      layout();

      requestFrame(() => {
        el.style.opacity = "1";
        el.style.transform = "none";
      });

      const player = createPlayer(el, opts);
      item.player = player;
      player.play(normalized, alert, () => {
        // Постоянная строка живёт до вытеснения новой.
        if (!normalized.persistent) removeItem(item, true);
      });
      return item;
    }

    function clear() {
      while (items.length) {
        const item = items.pop();
        if (item.player) item.player.stop();
        if (item.el.parentNode) item.el.parentNode.removeChild(item.el);
      }
      slotHeight = 100;
    }

    function requestFrame(fn) {
      if (typeof requestAnimationFrame === "function") return requestAnimationFrame(fn);
      return setTimeout(fn, 16);
    }

    return {
      push,
      clear,
      size: () => items.length,
      // Постоянные строки не освобождаются сами: одиночным алертам ждать их
      // ухода бессмысленно, иначе они не заиграют никогда.
      persistent: () => items.some((item) => item.persistent),
      onEmpty: (handler) => {
        emptyHandler = typeof handler === "function" ? handler : null;
      },
    };
  }

  return {
    LAYER_TYPES,
    ANIMATIONS,
    ALIGNS,
    FONTS,
    FITS,
    TEXT_ANIMS,
    EVENT_KINDS,
    DEFAULT_DURATION_MS,
    MIN_LAYER_MS,
    DEFAULT_TYPE_MS,
    MIN_TYPE_MS,
    MAX_TYPE_MS,
    normalizeLayer,
    normalizeLayers,
    normalizeComposition,
    normalizeConfig,
    compositionForEvent,
    compositionDuration,
    applyLayerDrag,
    matchesEvent,
    passesAmount,
    fillText,
    resolveMedia,
    renderStatic,
    createPlayer,
    createStack,
  };
});
