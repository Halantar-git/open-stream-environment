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
  Webcam frame widget.

  Два режима:

    * "frame" — только оформление. Видео не захватывается: страница оверлея
      живёт в OBS Browser Source, а тому браузер не выдаёт камеру (та же
      причина, по которой микрофон захватывает панель управления). Камеру
      добавляют в OBS отдельным источником, рамку кладут поверх или под ней.

    * "camera" — живое видео из моста. Панель управления захватывает камеру и
      шлёт JPEG-кадры по бинарному каналу, сервер пересылает их оверлею, а
      виджет рисует их на canvas внутри той же рамки.
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

      this.videoCanvas = null;
      this.emptyEl = null;
      this._decoding = false;
      this._hasFrame = false;
      this.videoDecoder = null;
      this._streamConfig = null;
      this._reportedDecodeFailure = false;

      const { EVENT_TYPES } = this.context;
      if (EVENT_TYPES && EVENT_TYPES.CAMERA_VIDEO_FRAME) {
        this.subscribe(EVENT_TYPES.CAMERA_VIDEO_FRAME, (payload) => this._onFrame(payload));
      }
      if (EVENT_TYPES && EVENT_TYPES.CAMERA_STREAM_CONFIG) {
        this.subscribe(EVENT_TYPES.CAMERA_STREAM_CONFIG, (payload) => this._onStreamConfig(payload));
      }
      this._applyPerspective();
    }

    onUpdate(prev, next) {
      if (prev.perspective !== next.perspective || prev.perspectiveDirection !== next.perspectiveDirection) {
        this._applyPerspective();
      }
    }

    onUnmount() {
      // Декодирование, начатое до удаления виджета, должно молча завершиться:
      // ссылки на canvas к этому моменту уже нет.
      this._closeDecoder();
      this._decoding = false;
      this.videoCanvas = null;
      this.emptyEl = null;
      this.host = null;
    }

    render() {
      const { escapeHtml, escapeAttr, t } = this.context;
      const cfg = this.config;
      const camera = cfg.source === "camera";

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
      if (camera) {
        const noSignal = this._hasFrame ? "" : `<div class="widget-webcam__empty">${escapeHtml(t("webcam.noSignal"))}</div>`;
        parts.push(
          `<div class="widget-webcam__video-wrap" data-fit="${escapeAttr(cfg.fit === "contain" ? "contain" : "cover")}">` +
            `<canvas class="widget-webcam__video"></canvas>` +
            noSignal +
            `</div>`
        );
      }
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

      // Ссылки на canvas после перерисовки новые: кадр нарисуется на
      // следующем тике моста (≤ 83 мс при 12 FPS).
      this.videoCanvas = camera ? this.host.querySelector(".widget-webcam__video") : null;
      this.emptyEl = camera ? this.host.querySelector(".widget-webcam__empty") : null;
      if (this.videoCanvas) {
        this.videoCanvas.style.transform = cfg.mirror ? "scaleX(-1)" : "";
      }
      if (!camera) this._closeDecoder();
    }

    // Кадр приходит Blob'ом (JPEG). Декодируем через Image: это работает и в
    // system webview, и в CEF OBS, и не требует createImageBitmap.
    _onFrame(payload) {
      if (payload && payload.h264) {
        this._onH264Chunk(payload);
        return;
      }
      const blob = payload && payload.blob;
      if (!blob || this._decoding || !this.videoCanvas) return;
      if (typeof Image === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return;

      this._decoding = true;
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        this._decoding = false;
        URL.revokeObjectURL(url);
        if (!this.videoCanvas || !this.videoCanvas.isConnected) return;
        this._drawFrame(img);
        this._hasFrame = true;
        if (this.emptyEl) {
          this.emptyEl.style.display = "none";
          this.emptyEl = null;
        }
      };
      img.onerror = () => {
        this._decoding = false;
        URL.revokeObjectURL(url);
      };
      img.src = url;
    }

    // Конфиг H.264-декодера приходит от панели перед ключевым кадром. Панель
    // повторяет его на каждом ключевом кадре, поэтому декодер пересоздаём
    // только когда сменились кодек или разрешение — иначе поток дёргался бы
    // каждые две секунды.
    _onStreamConfig(payload) {
      const cfg = payload || {};
      const codec = String(cfg.codec || "").toLowerCase();
      if (this.config.source !== "camera" || !codec.startsWith("avc1")) {
        this._streamConfig = cfg;
        this._closeDecoder();
        return;
      }
      const prev = this._streamConfig || {};
      const same =
        prev.codec === cfg.codec &&
        Number(prev.width) === Number(cfg.width) &&
        Number(prev.height) === Number(cfg.height);
      this._streamConfig = cfg;
      if (same && this.videoDecoder && this.videoDecoder.state === "configured") return;
      // Новый поток — можно снова сообщить о неудаче, если она повторится.
      this._reportedDecodeFailure = false;
      this._initDecoder(cfg);
    }

    _initDecoder(cfg) {
      this._closeDecoder();
      if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") {
        this._reportDecodeFailure("no-video-decoder");
        return;
      }
      const width = Math.max(2, Math.round(Number(cfg.width) || 0));
      const height = Math.max(2, Math.round(Number(cfg.height) || 0));
      if (!width || !height) return;

      const decoder = new VideoDecoder({
        output: (frame) => this._onVideoFrame(frame),
        error: (error) => this._reportDecodeFailure("decode-error", error),
      });
      try {
        // Annex B: SPS/PPS уже есть в ключевом кадре, description не нужен.
        decoder.configure({
          codec: cfg.codec,
          codedWidth: width,
          codedHeight: height,
          optimizeForLatency: true,
        });
      } catch (error) {
        this._reportDecodeFailure("configure", error);
        return;
      }
      this.videoDecoder = decoder;
    }

    _onH264Chunk(payload) {
      const decoder = this.videoDecoder;
      if (!decoder || decoder.state !== "configured" || !payload || !payload.data) return;
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: payload.keyframe ? "key" : "delta",
            timestamp: Math.max(0, Math.round(Number(payload.timestamp) || 0)),
            data: payload.data,
          })
        );
      } catch (error) {
        this._reportDecodeFailure("decode", error);
      }
    }

    _onVideoFrame(frame) {
      try {
        if (!this.videoCanvas || !this.videoCanvas.isConnected) return;
        this._drawImageLike(
          frame,
          frame.displayWidth || frame.codedWidth || 0,
          frame.displayHeight || frame.codedHeight || 0
        );
        this._hasFrame = true;
        if (this.emptyEl) {
          this.emptyEl.style.display = "none";
          this.emptyEl = null;
        }
      } finally {
        if (frame && typeof frame.close === "function") frame.close();
      }
    }

    // Оверлей не смог декодировать H.264: сообщаем панели, она перейдёт
    // на JPEG. Повторно на тот же поток не жалуемся.
    _reportDecodeFailure(reason, error) {
      this._closeDecoder();
      if (this._reportedDecodeFailure) return;
      this._reportedDecodeFailure = true;
      if (typeof console !== "undefined") {
        console.warn("[webcam] H.264 decode failed:", reason, error || "");
      }
      const send = this.context.send;
      const types = this.context.EVENT_TYPES;
      if (typeof send === "function" && types && types.CMD_CAMERA_DECODE_FAILED) {
        send(types.CMD_CAMERA_DECODE_FAILED, { reason: String(reason || "unknown") });
      }
    }

    _closeDecoder() {
      if (this.videoDecoder) {
        try {
          this.videoDecoder.close();
        } catch (_) {
          /* decoder already closed */
        }
        this.videoDecoder = null;
      }
    }

    _drawFrame(img) {
      this._drawImageLike(img, img.naturalWidth || img.width || 0, img.naturalHeight || img.height || 0);
    }

    _drawImageLike(source, imageWidth, imageHeight) {
      const canvas = this.videoCanvas;
      if (!canvas || typeof canvas.getContext !== "function") return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const cssWidth = canvas.clientWidth || (this.host && this.host.clientWidth) || 1;
      const cssHeight = canvas.clientHeight || (this.host && this.host.clientHeight) || 1;
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      const width = Math.max(1, Math.round(cssWidth * dpr));
      const height = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      ctx.clearRect(0, 0, width, height);

      if (!imageWidth || !imageHeight) return;

      // cover — заполнить рамку с обрезкой, contain — вписать целиком.
      const cover = this.config.fit !== "contain";
      const scale = cover
        ? Math.max(width / imageWidth, height / imageHeight)
        : Math.min(width / imageWidth, height / imageHeight);
      const drawWidth = imageWidth * scale;
      const drawHeight = imageHeight * scale;
      ctx.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    }

    // Тот же наклон, что у микрофона, 3D-целей и таймера: сила 0–100 и
    // направление. Наклоняем сам element, чтобы геометрия и рамка вращались
    // вместе, а не разъезжались относительно друг друга.
    _applyPerspective() {
      const value = clamp(num(this.config.perspective, 0), 0, 100);
      if (value <= 0) {
        this.element.style.transform = "";
        this.element.style.transformStyle = "";
        return;
      }
      const magnitude = value * 0.15;
      const direction = this.config.perspectiveDirection || "left";
      let rotateY = -magnitude;
      let rotateX = magnitude * 0.2;
      if (direction === "right") {
        rotateY = magnitude;
      } else if (direction === "up") {
        rotateY = 0;
        rotateX = magnitude;
      } else if (direction === "down") {
        rotateY = 0;
        rotateX = -magnitude;
      }
      this.element.style.transform = `perspective(1200px) rotateY(${rotateY}deg) rotateX(${rotateX}deg)`;
      this.element.style.transformStyle = "preserve-3d";
    }
  }

  return WebcamWidget;
});
