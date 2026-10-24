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
  Отправка камеры и микрофона гостям (сторона источника).

  Поток захватывается в панели: только здесь есть getUserMedia и настройки
  устройств. Медиа уходит напрямую оверлеям хостов по WebRTC; локальный сервер
  пересылает лишь SDP и ICE.

  В сетке подключений несколько: у каждого стримера свой `RTCPeerConnection`,
  но камера открывается один раз — второе `getUserMedia` заняло бы устройство
  и запустило вторую копию. Звук при этом клонируется на каждую связь: хост
  может попросить «только видео», и это не должно выключать микрофон остальным.

  Поток стартует не сразу после подтверждения, а после `guest_receiver_ready`:
  если виджет хоста ещё не смонтирован, offer был бы некому принять. Повторный
  ready означает, что приёмник пересоздан (перезагрузка OBS, повторная
  подписка), поэтому соединение собирается заново — только для этой связи.
*/

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

export function createGuestShare({ state, send, EVENT_TYPES, onStatus }) {
  // link -> { peer, slot, queued, audio }
  const peers = new Map();
  // link -> токен запуска: пока камера открывается, связь могли отключить.
  const pending = new Map();
  let stream = null;
  let capturePromise = null;
  let generation = 0;

  function setStatus(link, slot, status, detail) {
    if (!link) return;
    if (!state.guestShares) state.guestShares = {};
    state.guestShares[link] = { slot: slot || "", status, detail: detail || "" };
    if (typeof onStatus === "function") onStatus();
  }

  function videoConstraints() {
    const cfg = state.cameraConfig || {};
    const width = clamp(Math.round(Number(cfg.width) || 960), 320, 1920);
    const fps = clamp(Math.round(Number(cfg.fps) || 12), 1, 60);
    const video = {
      width: { ideal: width },
      height: { ideal: Math.round((width * 9) / 16) },
      frameRate: { ideal: fps, max: fps },
    };
    if (cfg.deviceId) video.deviceId = { exact: cfg.deviceId };
    return video;
  }

  function audioConstraints() {
    const cfg = state.micConfig || {};
    const audio = {
      echoCancellation: cfg.echoCancellation !== false,
      noiseSuppression: cfg.noiseSuppression !== false,
      autoGainControl: cfg.autoGainControl !== false,
    };
    if (cfg.deviceId) audio.deviceId = { exact: cfg.deviceId };
    return audio;
  }

  function mediaSupport() {
    return !!(
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia &&
      typeof RTCPeerConnection === "function"
    );
  }

  /*
    Открыть камеру один раз на все связи. Если микрофон занят или недоступен,
    повторяем без звука: видео важнее. `NotAllowedError` не повторяем — это
    осознанный отказ пользователя.
  */
  function captureStream() {
    if (stream) return Promise.resolve(stream);
    if (capturePromise) return capturePromise;
    capturePromise = (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints(),
          audio: audioConstraints(),
        });
      } catch (error) {
        if (!error || error.name === "NotAllowedError") throw error;
        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(), audio: false });
      }
      return stream;
    })();
    capturePromise
      .catch(() => {})
      .finally(() => {
        capturePromise = null;
      });
    return capturePromise;
  }

  function stopStream() {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  // Остановить камеру, только когда её больше некому отправлять.
  function stopStreamIfIdle() {
    if (peers.size || pending.size) return;
    stopStream();
  }

  // STUN/TURN для peer'а. Настройки приходят с машины хоста в подтверждении и
  // в `receiver_ready`; свои (на случай локального запуска) — из состояния
  // панели. Без STUN в интернете остаются только локальные кандидаты.
  function peerIceServers(overrides) {
    const protocol = typeof window !== "undefined" ? window.GuestProtocol : null;
    if (!protocol || typeof protocol.iceServers !== "function") return [];
    return protocol.iceServers(overrides || state.guestIce || null);
  }

  function closePeer(link) {
    pending.delete(link);
    const entry = peers.get(link);
    if (!entry) {
      stopStreamIfIdle();
      return;
    }
    peers.delete(link);
    entry.peer.onicecandidate = null;
    entry.peer.onconnectionstatechange = null;
    entry.peer.ontrack = null;
    try {
      entry.peer.close();
    } catch (_) {
      /* already closed */
    }
    // Клоны звука принадлежат только этой связи: после закрытия peer'а они
    // больше никому не нужны.
    for (const track of entry.audio) {
      try {
        track.stop();
      } catch (_) {
        /* уже остановлена */
      }
    }
    stopStreamIfIdle();
  }

  function createPeer(link, slot, ice, captured) {
    const peer = new RTCPeerConnection({ iceServers: peerIceServers(ice) });
    const entry = { peer, slot, queued: [], audio: [] };
    peers.set(link, entry);

    peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      send(EVENT_TYPES.GUEST_SIGNAL, {
        link,
        slot,
        payload: { type: "candidate", candidate: event.candidate.toJSON() },
      });
    };
    peer.onconnectionstatechange = () => {
      if (peers.get(link) !== entry) return;
      const connection = peer.connectionState;
      if (connection === "connected") setStatus(link, slot, "live");
      else if (connection === "failed") setStatus(link, slot, "error", "connection");
      else if (connection === "disconnected") setStatus(link, slot, "disconnected");
    };

    const out = new MediaStream();
    for (const track of captured.getVideoTracks()) out.addTrack(track);
    for (const track of captured.getAudioTracks()) {
      const clone = track.clone();
      entry.audio.push(clone);
      out.addTrack(clone);
    }
    for (const track of out.getTracks()) peer.addTrack(track, out);
    return entry;
  }

  async function flushCandidates(entry) {
    if (!entry.peer.remoteDescription) return;
    const queued = entry.queued;
    entry.queued = [];
    for (const candidate of queued) {
      try {
        await entry.peer.addIceCandidate(candidate);
      } catch (_) {
        /* устаревший кандидат после пересогласования — это нормально */
      }
    }
  }

  async function start(link, slot, ice) {
    if (!link || !slot) return;
    closePeer(link);
    const token = { generation: ++generation };
    pending.set(link, token);

    if (!mediaSupport()) {
      pending.delete(link);
      setStatus(link, slot, "unsupported");
      return;
    }

    setStatus(link, slot, "capture");
    let captured;
    try {
      captured = await captureStream();
    } catch (error) {
      if (pending.get(link) !== token) return;
      pending.delete(link);
      stopStreamIfIdle();
      setStatus(link, slot, "error", (error && error.name) || "unknown");
      return;
    }
    // Пока камера открывалась, эту связь могли закрыть.
    if (pending.get(link) !== token) {
      stopStreamIfIdle();
      return;
    }
    pending.delete(link);

    const entry = createPeer(link, slot, ice, captured);
    setStatus(link, slot, "connecting");
    try {
      const offer = await entry.peer.createOffer();
      await entry.peer.setLocalDescription(offer);
      if (peers.get(link) !== entry) return;
      send(EVENT_TYPES.GUEST_SIGNAL, {
        link,
        slot,
        payload: { type: "offer", sdp: entry.peer.localDescription.sdp },
      });
    } catch (_) {
      if (peers.get(link) !== entry) return;
      setStatus(link, slot, "error", "offer");
    }
  }

  async function handleSignal(link, payload) {
    const entry = peers.get(link);
    if (!entry || !payload || !payload.type) return;
    // Хост просит выключить или вернуть звук: у гостя это флаг на клонах
    // дорожки, видео идёт дальше без пересогласования.
    if (payload.type === "audio") {
      for (const track of entry.audio) track.enabled = payload.enabled !== false;
      return;
    }
    if (payload.type === "answer") {
      try {
        await entry.peer.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        await flushCandidates(entry);
      } catch (_) {
        if (peers.get(link) === entry) setStatus(link, entry.slot, "error", "answer");
      }
      return;
    }
    if (payload.type === "candidate" && payload.candidate) {
      if (entry.peer.remoteDescription) {
        try {
          await entry.peer.addIceCandidate(payload.candidate);
        } catch (_) {
          /* ignore a candidate that arrived after renegotiation */
        }
      } else {
        entry.queued.push(payload.candidate);
      }
    }
  }

  function markAccepted(link, slot) {
    pending.delete(link);
    setStatus(link, slot, "accepted");
  }

  function stop(link) {
    closePeer(link);
  }

  function stopAll() {
    pending.clear();
    for (const link of Array.from(peers.keys())) closePeer(link);
    stopStream();
  }

  return { start, stop, stopAll, handleSignal, markAccepted };
}
