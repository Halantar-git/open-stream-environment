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
  Отправка камеры и микрофона гостю (сторона источника).

  Поток захватывается в панели: только здесь есть getUserMedia и настройки
  устройств. Медиа уходит напрямую оверлею хоста по WebRTC; локальный сервер
  пересылает лишь SDP и ICE.

  Поток стартует не сразу после подтверждения, а после `guest_receiver_ready`:
  если виджет хоста ещё не смонтирован, offer был бы некому принять. Повторный
  ready означает, что приёмник пересоздан (перезагрузка OBS, повторная
  подписка), поэтому соединение собирается заново.
*/

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

export function createGuestShare({ state, send, EVENT_TYPES, onStatus }) {
  let peer = null;
  let stream = null;
  let slot = "";
  let pendingCandidates = [];
  let generation = 0;

  function setStatus(status, detail) {
    state.guestShare = { slot, status, detail: detail || "" };
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

  function closePeer() {
    if (!peer) return;
    peer.onicecandidate = null;
    peer.onconnectionstatechange = null;
    peer.ontrack = null;
    try {
      peer.close();
    } catch (_) {
      /* already closed */
    }
    peer = null;
    pendingCandidates = [];
  }

  function stopStream() {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  // STUN/TURN для peer'а. Настройки приходят с машины хоста в подтверждении и
  // в `receiver_ready`; свои (на случай локального запуска) — из состояния
  // панели. Без STUN в интернете остаются только локальные кандидаты.
  function peerIceServers(overrides) {
    const protocol = typeof window !== "undefined" ? window.GuestProtocol : null;
    if (!protocol || typeof protocol.iceServers !== "function") return [];
    return protocol.iceServers(overrides || state.guestIce || null);
  }

  function createPeer(ice) {
    closePeer();
    peer = new RTCPeerConnection({ iceServers: peerIceServers(ice) });
    peer.onicecandidate = (event) => {
      if (!event.candidate) return;
      send(EVENT_TYPES.GUEST_SIGNAL, {
        slot,
        payload: { type: "candidate", candidate: event.candidate.toJSON() },
      });
    };
    peer.onconnectionstatechange = () => {
      if (!peer) return;
      const connection = peer.connectionState;
      if (connection === "connected") setStatus("live");
      else if (connection === "failed") setStatus("error", "connection");
      else if (connection === "disconnected") setStatus("disconnected");
    };
    return peer;
  }

  async function flushCandidates() {
    if (!peer || !peer.remoteDescription) return;
    const queued = pendingCandidates;
    pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await peer.addIceCandidate(candidate);
      } catch (_) {
        /* a stale candidate after renegotiation is harmless */
      }
    }
  }

  async function start(targetSlot, ice) {
    if (!targetSlot) return;
    const current = ++generation;
    closePeer();
    stopStream();
    slot = targetSlot;
    pendingCandidates = [];

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof RTCPeerConnection !== "function") {
      setStatus("unsupported");
      return;
    }

    setStatus("capture");
    let captured;
    try {
      captured = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints(),
        audio: audioConstraints(),
      });
    } catch (error) {
      // Микрофон мог быть занят другим приложением или отсутствовать.
      // Видео важнее: пробуем ещё раз без звука, кроме явного запрета.
      if (!error || error.name === "NotAllowedError") {
        if (current !== generation) return;
        setStatus("error", (error && error.name) || "unknown");
        return;
      }
      try {
        captured = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(), audio: false });
      } catch (retryError) {
        if (current !== generation) return;
        setStatus("error", (retryError && retryError.name) || (error && error.name) || "unknown");
        return;
      }
    }
    // Пока камера открывалась, гость мог отключиться: поток ему уже не нужен.
    if (current !== generation || !slot) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = captured;
    createPeer(ice);
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
    setStatus("connecting");
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (current !== generation || !peer) return;
      send(EVENT_TYPES.GUEST_SIGNAL, {
        slot,
        payload: { type: "offer", sdp: peer.localDescription.sdp },
      });
    } catch (_) {
      if (current !== generation) return;
      setStatus("error", "offer");
    }
  }

  async function handleSignal(payload) {
    if (!peer || !payload || !payload.type) return;
    // Хост просит выключить или вернуть звук: у гостя это просто флаг на
    // дорожке — видео идёт дальше без пересогласования.
    if (payload.type === "audio") {
      if (stream) {
        for (const track of stream.getAudioTracks()) track.enabled = payload.enabled !== false;
      }
      return;
    }
    if (payload.type === "answer") {
      try {
        await peer.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        await flushCandidates();
      } catch (_) {
        setStatus("error", "answer");
      }
      return;
    }
    if (payload.type === "candidate" && payload.candidate) {
      if (peer.remoteDescription) {
        try {
          await peer.addIceCandidate(payload.candidate);
        } catch (_) {
          /* ignore a candidate that arrived after renegotiation */
        }
      } else {
        pendingCandidates.push(payload.candidate);
      }
    }
  }

  function markAccepted(targetSlot) {
    slot = targetSlot;
    setStatus("accepted");
  }

  function stop() {
    generation += 1;
    closePeer();
    stopStream();
    slot = "";
    setStatus("idle");
  }

  return { start, stop, handleSignal, markAccepted };
}
