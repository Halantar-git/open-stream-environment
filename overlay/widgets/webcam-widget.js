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

    * "remote" — гостевая камера. Виджет — WebRTC-приёмник: панель гостя
      кодирует камеру и микрофон, сигналинг идёт через сервер, медиа — напрямую.
      Соединение живёт в экземпляре виджета, поэтому смена рамки или раскладки
      его не рвёт.
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
      // Мастер-флаг камеры: приходит событием от панели. Пока выключен,
      // виджет не рисует кадры и не держит декодер.
      this._cameraOff = false;
      this.videoDecoder = null;
      this._streamConfig = null;
      this._reportedDecodeFailure = false;
      // Гостевая камера (WebRTC). Соединение и поток живут в экземпляре, а не
      // в DOM: render() может пересобрать разметку в любой момент.
      this._guestSlot = "";
      this._guestPeer = null;
      this._guestStream = null;
      this._guestState = "idle";
      this._guestSubscribed = false;
      this._guestQueuedCandidates = [];
      this._guestApplying = false;
      // Последнее отправленное гостю состояние звука (null — ещё не отправляли).
      this._guestAudioSent = null;

      const { EVENT_TYPES } = this.context;
      if (EVENT_TYPES && EVENT_TYPES.CAMERA_VIDEO_FRAME) {
        this.subscribe(EVENT_TYPES.CAMERA_VIDEO_FRAME, (payload) => this._onFrame(payload));
      }
      if (EVENT_TYPES && EVENT_TYPES.CAMERA_STREAM_CONFIG) {
        this.subscribe(EVENT_TYPES.CAMERA_STREAM_CONFIG, (payload) => this._onStreamConfig(payload));
      }
      if (EVENT_TYPES && EVENT_TYPES.OVERLAY_CAMERA_CONFIG) {
        this.subscribe(EVENT_TYPES.OVERLAY_CAMERA_CONFIG, (payload) => this._onCameraConfig(payload));
      }
      if (EVENT_TYPES && EVENT_TYPES.GUEST_ACCEPTED) {
        this.subscribe(EVENT_TYPES.GUEST_ACCEPTED, (payload) => this._onGuestAccepted(payload));
      }
      if (EVENT_TYPES && EVENT_TYPES.GUEST_SIGNAL) {
        this.subscribe(EVENT_TYPES.GUEST_SIGNAL, (payload) => this._onGuestSignal(payload));
      }
      if (EVENT_TYPES && EVENT_TYPES.GUEST_LEFT) {
        this.subscribe(EVENT_TYPES.GUEST_LEFT, (payload) => this._onGuestLeft(payload));
      }
      if (EVENT_TYPES && EVENT_TYPES.GUEST_DECLINED) {
        this.subscribe(EVENT_TYPES.GUEST_DECLINED, (payload) => this._onGuestLeft(payload));
      }
      this._applyPerspective();
    }

    // Глобальный выключатель камеры: панель перестаёт слать кадры, а оверлей
    // гасит последний — иначе в эфире остался бы «замёрзший» кадр.
    _onCameraConfig(payload) {
      const enabled = !(payload && payload.config && payload.config.enabled === false);
      if (this._cameraOff === !enabled) return;
      this._cameraOff = !enabled;
      if (this._cameraOff) {
        this._hasFrame = false;
        this._closeDecoder();
        this._streamConfig = null;
      }
      this.render();
    }

    onUpdate(prev, next) {
      if (prev.source !== next.source || prev.guestSlot !== next.guestSlot) {
        this._teardownGuest();
      }
      if (prev.perspective !== next.perspective || prev.perspectiveDirection !== next.perspectiveDirection) {
        this._applyPerspective();
      }
      if (this.audioElement && prev.volume !== next.volume) {
        this.audioElement.volume = clamp(num(next.volume, 100) / 100, 0, 1);
      }
    }

    onUnmount() {
      // Декодирование, начатое до удаления виджета, должно молча завершиться:
      // ссылки на canvas к этому моменту уже нет.
      this._teardownGuest();
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
      const remote = cfg.source === "remote";
      if (remote) {
        // Состояние нужно до сборки разметки: заглушка пишется в HTML сразу.
        const protocol = typeof window !== "undefined" ? window.GuestProtocol : null;
        const slot = protocol ? protocol.normalizeSlot(cfg.guestSlot) : String(cfg.guestSlot || "");
        if (!slot) {
          this._guestState = "no-slot";
        } else if (
          !this._guestStream &&
          this._guestState !== "connecting" &&
          this._guestState !== "offline" &&
          this._guestState !== "error"
        ) {
          this._guestState = "waiting";
        }
      }

      const accent = SAFE_ACCENT.test(String(cfg.color || "").trim()) ? String(cfg.color).trim() : "var(--md-primary)";
      // Уголки и неон можно покрасить отдельно от рамки: пока цвет не выбран,
      // они наследуют акцент (и правила темы).
      const cornerColor = SAFE_ACCENT.test(String(cfg.cornerColor || "").trim()) ? String(cfg.cornerColor).trim() : "";
      const neon = cfg.neon === true;
      const glow = clamp(Math.round(num(cfg.neonStrength, 14)), 2, 40);
      const thickness = clamp(Math.round(num(cfg.thickness, 4)), 1, 16);
      // Старое значение 16px было дефолтом для всех тем; без явного
      // переопределения (`radiusAuto: false`) считаем его автоматическим.
      const legacyRadius = Number(cfg.radius) === 16 && cfg.radiusAuto !== false;
      const radiusAuto = cfg.radius == null || legacyRadius;
      // Без явного значения рамка берёт скругление темы: у Retrowave, Pixel
      // и HUD-тем панели прямые, у Material You — мягкие. Ползунок в
      // инспекторе перекрывает это значение, когда его трогают.
      const radius = clamp(Math.round(radiusAuto ? this._themeRadius() : num(cfg.radius, this._themeRadius())), 0, 64);
      const position = LABEL_POSITIONS.includes(cfg.labelPosition) ? cfg.labelPosition : "top-left";
      const label = String(cfg.label == null ? "LIVE" : cfg.label).trim();
      const showLabel = cfg.showLabel !== false && label.length > 0;

      this.host.style.setProperty("--webcam-accent", accent);
      this.host.style.setProperty("--webcam-thickness", `${thickness}px`);
      this.host.style.setProperty("--webcam-radius", `${radius}px`);
      this.host.style.setProperty("--webcam-glow", `${glow}px`);
      if (cornerColor) {
        this.host.style.setProperty("--webcam-corner", cornerColor);
        this.host.dataset.cornerColor = "custom";
      } else {
        this.host.style.removeProperty("--webcam-corner");
        delete this.host.dataset.cornerColor;
      }
      if (neon) this.host.dataset.neon = "on";
      else delete this.host.dataset.neon;

      const parts = [];
      if (cfg.showBackground) parts.push(`<div class="widget-webcam__backdrop"></div>`);
      if (camera) {
        const emptyKey = this._cameraOff ? "webcam.cameraOff" : "webcam.noSignal";
        const noSignal = this._hasFrame ? "" : `<div class="widget-webcam__empty">${escapeHtml(t(emptyKey))}</div>`;
        parts.push(
          `<div class="widget-webcam__video-wrap" data-fit="${escapeAttr(cfg.fit === "contain" ? "contain" : "cover")}">` +
            `<canvas class="widget-webcam__video"></canvas>` +
            noSignal +
            `</div>`
        );
      } else if (remote) {
        // Видео и звук — разные элементы: видео всегда беззвучное, иначе
        // браузер блокирует автозапуск; громкость гостя живёт на audio.
        const emptyKey = this._guestEmptyKey();
        const placeholder = `<div class="widget-webcam__empty">${escapeHtml(t(emptyKey))}</div>`;
        parts.push(
          `<div class="widget-webcam__video-wrap" data-fit="${escapeAttr(cfg.fit === "contain" ? "contain" : "cover")}">` +
            `<video class="widget-webcam__video" autoplay playsinline muted></video>` +
            `<audio class="widget-webcam__audio" autoplay></audio>` +
            placeholder +
            `</div>`
        );
      }
      if (neon) parts.push(`<div class="widget-webcam__glow"></div>`);
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
      this.videoElement = remote ? this.host.querySelector(".widget-webcam__video") : null;
      this.audioElement = remote ? this.host.querySelector(".widget-webcam__audio") : null;
      this.emptyEl = camera || remote ? this.host.querySelector(".widget-webcam__empty") : null;
      if (this.videoCanvas) {
        this.videoCanvas.style.transform = cfg.mirror ? "scaleX(-1)" : "";
      }
      if (this.videoElement) {
        this.videoElement.style.objectFit = cfg.fit === "contain" ? "contain" : "cover";
        this.videoElement.style.transform = cfg.mirror ? "scaleX(-1)" : "";
      }
      if (this.audioElement) {
        this.audioElement.volume = clamp(num(cfg.volume, 100) / 100, 0, 1);
      }
      // Для гостя декодер JPEG/H.264 не нужен: другой источник кадров.
      if (!camera) this._closeDecoder();
      if (remote) this._syncGuest();
    }

    // ---- гостевая камера (WebRTC) ------------------------------------

    // Виджет хоста — принимающая сторона: offer приходит от панели гостя.
    // Повторный offer (перезагрузка OBS у гостя, новое подключение) всегда
    // разбираем на новом peer, иначе старые ICE-пары тянули бы в прошлое.
    _onGuestAccepted(payload) {
      const slot = payload && payload.slot;
      if (!slot || slot !== this._guestSlot) return;
      this._createGuestPeer();
      this._guestState = "connecting";
      this._updateGuestEmpty();
    }

    _onGuestSignal(payload) {
      if (!payload || payload.slot !== this._guestSlot) return;
      const signal = payload.payload;
      if (!signal) return;
      if (signal.type === "offer") {
        this._applyGuestOffer(signal.sdp);
        return;
      }
      if (signal.type === "candidate" && signal.candidate) {
        const peer = this._guestPeer;
        if (!peer) return;
        if (peer.remoteDescription) {
          peer.addIceCandidate(signal.candidate).catch(() => {});
        } else {
          this._guestQueuedCandidates.push(signal.candidate);
        }
      }
    }

    _onGuestLeft(payload) {
      if (payload && payload.slot && payload.slot !== this._guestSlot) return;
      this._closeGuestPeer();
      this._guestStream = null;
      this._guestState = "offline";
      this._updateGuestEmpty();
    }

    async _applyGuestOffer(sdp) {
      if (!sdp || this._guestApplying) return;
      this._guestApplying = true;
      let peer = this._guestPeer;
      // Приёмник мог не получить `guest_accepted`: оверлей перезагрузили уже
      // после подтверждения. Peer создаём сами — иначе первый же offer
      // пришлось бы выбросить.
      if (!peer) {
        this._createGuestPeer();
        peer = this._guestPeer;
      } else if (peer.remoteDescription) {
        this._createGuestPeer();
        peer = this._guestPeer;
      }
      if (!peer) {
        this._guestApplying = false;
        return;
      }
      try {
        await peer.setRemoteDescription({ type: "offer", sdp });
        for (const candidate of this._guestQueuedCandidates) {
          try {
            await peer.addIceCandidate(candidate);
          } catch (_) {
            /* устаревший кандидат */
          }
        }
        this._guestQueuedCandidates = [];
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        if (this._guestPeer !== peer) return;
        this._sendGuestSignal({ type: "answer", sdp: peer.localDescription.sdp });
      } catch (_) {
        this._guestState = "error";
        this._updateGuestEmpty();
      } finally {
        this._guestApplying = false;
      }
    }

    _createGuestPeer() {
      this._closeGuestPeer();
      if (typeof RTCPeerConnection !== "function") {
        this._guestState = "error";
        this._updateGuestEmpty();
        return;
      }
      const peer = new RTCPeerConnection({ iceServers: [] });
      this._guestPeer = peer;
      this._guestQueuedCandidates = [];
      peer.onicecandidate = (event) => {
        if (!event.candidate) return;
        this._sendGuestSignal({ type: "candidate", candidate: event.candidate.toJSON() });
      };
      peer.ontrack = (event) => {
        const stream = event.streams && event.streams[0];
        if (!stream) return;
        this._guestStream = stream;
        this._attachGuestStream();
        this._guestState = "live";
        this._updateGuestEmpty();
      };
      peer.onconnectionstatechange = () => {
        if (this._guestPeer !== peer) return;
        const state = peer.connectionState;
        if (state === "connected") {
          this._guestState = "live";
        } else if (state === "disconnected" || state === "connecting") {
          this._guestState = "connecting";
        } else if (state === "failed" || state === "closed") {
          this._guestState = "offline";
        }
        this._updateGuestEmpty();
      };
    }

    _sendGuestSignal(payload) {
      const { EVENT_TYPES, send } = this.context;
      if (!EVENT_TYPES || !EVENT_TYPES.GUEST_SIGNAL || typeof send !== "function") return;
      send(EVENT_TYPES.GUEST_SIGNAL, { slot: this._guestSlot, payload });
    }

    _closeGuestPeer() {
      if (!this._guestPeer) return;
      this._guestPeer.onicecandidate = null;
      this._guestPeer.ontrack = null;
      this._guestPeer.onconnectionstatechange = null;
      try {
        this._guestPeer.close();
      } catch (_) {
        /* уже закрыт */
      }
      this._guestPeer = null;
      this._guestQueuedCandidates = [];
      // Новый peer у гостя тоже новый: состояние звука придётся передать заново.
      this._guestAudioSent = null;
    }

    _syncGuest() {
      const protocol = typeof window !== "undefined" ? window.GuestProtocol : null;
      const slot = protocol ? protocol.normalizeSlot(this.config.guestSlot) : String(this.config.guestSlot || "");
      if (!slot) {
        this._teardownGuest();
        this._guestState = "no-slot";
        this._updateGuestEmpty();
        return;
      }
      if (this._guestSlot !== slot) {
        this._teardownGuest();
        this._guestSlot = slot;
      }
      if (this._guestStream) {
        this._guestState = "live";
      } else if (this._guestState !== "connecting" && this._guestState !== "offline" && this._guestState !== "error") {
        this._guestState = "waiting";
      }
      this._updateGuestEmpty();
      this._attachGuestStream();
      this._subscribeGuest();
    }

    _subscribeGuest() {
      if (!this._guestSlot) return;
      const { EVENT_TYPES, send } = this.context;
      if (!EVENT_TYPES || !EVENT_TYPES.CMD_GUEST_SUBSCRIBE || typeof send !== "function") return;
      // Подписка повторяется на каждом рендере: после перезапуска приложения
      // или обрыва шины у сервера нет прежнего клиента, и молчание виджета
      // оставило бы гостя на «ждём экран». Сервер повторную подписку того же
      // окна игнорирует и поток не перезапускает.
      this._guestSubscribed = true;
      send(EVENT_TYPES.CMD_GUEST_SUBSCRIBE, { slot: this._guestSlot });
    }

    _teardownGuest() {
      if (this._guestSubscribed) {
        const { EVENT_TYPES, send } = this.context;
        if (EVENT_TYPES && EVENT_TYPES.CMD_GUEST_UNSUBSCRIBE && typeof send === "function") {
          // Освобождаем только свой слот: остальные виджеты мультикама в том
          // же оверлее продолжают принимать своих гостей.
          send(EVENT_TYPES.CMD_GUEST_UNSUBSCRIBE, { slot: this._guestSlot });
        }
      }
      this._guestSubscribed = false;
      this._closeGuestPeer();
      this._guestStream = null;
      this._guestSlot = "";
      this._guestState = "idle";
    }

    _attachGuestStream() {
      const stream = this._guestStream;
      if (!stream) return;
      if (this.videoElement) {
        if (this.videoElement.srcObject !== stream) this.videoElement.srcObject = stream;
        const played = this.videoElement.play();
        if (played && typeof played.catch === "function") played.catch(() => {});
      }
      if (this.audioElement) {
        if (this._guestVideoOnly()) {
          // «Только видео»: звук не выводим вообще — гость может сидеть в
          // Discord, и его голос не должен попадать в эфир.
          this.audioElement.srcObject = null;
        } else {
          if (this.audioElement.srcObject !== stream) this.audioElement.srcObject = stream;
          const played = this.audioElement.play();
          if (played && typeof played.catch === "function") played.catch(() => {});
        }
      }
      // Гость тоже должен знать: так его микрофон не уходит в сеть зря.
      this._sendGuestAudioState();
    }

    // «Только видео» для гостевой камеры.
    _guestVideoOnly() {
      return this.config.videoOnly === true;
    }

    // Сообщает гостю, нужен ли звук. Отправляется один раз на состояние и
    // заново — после пересоздания peer: гость перезапустил поток.
    _sendGuestAudioState(force = false) {
      if (!this._guestPeer || !this._guestSlot) return;
      const enabled = !this._guestVideoOnly();
      if (!force && this._guestAudioSent === enabled) return;
      this._guestAudioSent = enabled;
      this._sendGuestSignal({ type: "audio", enabled });
    }

    _guestEmptyKey() {
      if (this._guestState === "no-slot") return "webcam.guestNoSlot";
      if (this._guestState === "connecting") return "webcam.guestConnecting";
      if (this._guestState === "offline" || this._guestState === "error") return "webcam.guestOffline";
      return "webcam.guestWaiting";
    }

    _updateGuestEmpty() {
      if (this.config.source !== "remote" || !this.host) return;
      const el = this.host.querySelector(".widget-webcam__empty");
      if (!el) return;
      if (this._guestState === "live") {
        el.style.display = "none";
        return;
      }
      el.style.display = "";
      el.textContent = this.context.t(this._guestEmptyKey());
    }

    // Кадр приходит Blob'ом (JPEG). Декодируем через Image: это работает и в
    // system webview, и в CEF OBS, и не требует createImageBitmap.
    _onFrame(payload) {
      if (this._cameraOff) return;
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
      if (this._cameraOff) return;
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
      if (this._cameraOff) return;
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
        if (this._cameraOff || !this.videoCanvas || !this.videoCanvas.isConnected) return;
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

    // Скругление по умолчанию из темы: `--panel-radius` уже задаёт характер
    // панелей (0 у HUD-тем, 24 у Material You, 6 у Super Four).
    _themeRadius() {
      const read = this.context.readCssVar;
      const raw = read && read("--panel-radius");
      const n = parseFloat(raw);
      return Number.isFinite(n) ? clamp(Math.round(n), 0, 64) : 16;
    }

    // Тот же наклон, что у микрофона, 3D-целей и таймера: сила 0–100 и
    // направление. Наклоняем сам element, чтобы геометрия и рамка вращались
    // вместе, а не разъезжались относительно друг друга.
    _applyPerspective() {
      const value = clamp(num(this.config.perspective, 0), 0, 100);
      if (value <= 0) {
        this._setTilt("");
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
      this._setTilt(`perspective(1200px) rotateY(${rotateY}deg) rotateX(${rotateX}deg)`);
    }
  }

  return WebcamWidget;
});
