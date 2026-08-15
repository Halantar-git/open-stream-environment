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
  Soundboard overlay widget.

  Standalone, self-contained widget loaded by overlay.html. It opens its own
  WebSocket connection to the local bus, listens for `soundboard_play`, plays
  the mapped audio file (respecting the configured volume and queue mode) and
  shows an animated MD3 popup card. Keeping it separate means it survives
  layout re-renders of the main overlay canvas.
*/
(function () {
  const EVENT_TYPES = (window.SharedEvents && window.SharedEvents.EVENT_TYPES) || {
    STATE: "state",
    SOUNDBOARD_PLAY: "soundboard_play",
  };

  const host = document.createElement("div");
  host.className = "soundboard-host";
  document.body.appendChild(host);

  let volume = 0.8;
  let queueMode = false;
  let queueBusy = false;
  const queue = [];
  const activeAudios = [];

  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  let ws = null;
  let reconnectTimer = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Config stores paths relative to the server root (e.g. media/x.mp3),
  // but the widget lives under /overlay — so normalize to an absolute URL.
  function resolveUrl(path) {
    if (!path) return "";
    if (/^(https?:)?\/\//i.test(path)) return path;
    return "/" + String(path).replace(/^\/+/, "");
  }

  function playSound(sound, onEnded) {
    if (!sound.audioFile) {
      if (onEnded) onEnded();
      return;
    }

    const audio = new Audio(resolveUrl(sound.audioFile));
    audio.volume = volume;
    audio.play().catch(() => {
      if (onEnded) onEnded();
    });
    audio.addEventListener("ended", () => {
      const i = activeAudios.indexOf(audio);
      if (i >= 0) activeAudios.splice(i, 1);
      if (onEnded) onEnded();
    });
    activeAudios.push(audio);
  }

  function drainQueue() {
    if (queueBusy) return;
    const next = queue.shift();
    if (!next) return;
    queueBusy = true;
    playSound(next, () => {
      queueBusy = false;
      drainQueue();
    });
  }

  function trigger(sound) {
    if (!sound) return;
    if (queueMode) {
      queue.push(sound);
      drainQueue();
    } else {
      playSound(sound);
    }
    showPopup(sound);
  }

  function showPopup(sound) {
    const card = document.createElement("div");
    card.className = "soundboard-popup";

    const media = document.createElement("div");
    media.className = "soundboard-popup__media";
    if (sound.imageFile) {
      const img = document.createElement("img");
      img.src = resolveUrl(sound.imageFile);
      img.alt = "";
      media.appendChild(img);
    } else {
      media.textContent = "🔊";
    }

    const text = document.createElement("div");
    text.className = "soundboard-popup__text";
    text.innerHTML = `<b>${escapeHtml(sound.user || "")}</b> запустил <b>${escapeHtml(sound.title || sound.soundId || "")}</b>`;

    card.appendChild(media);
    card.appendChild(text);
    host.appendChild(card);

    setTimeout(() => card.remove(), 4600);
  }

  function handleMessage(msg) {
    if (msg.type === EVENT_TYPES.STATE && msg.payload && msg.payload.soundboard) {
      const sb = msg.payload.soundboard;
      if (typeof sb.volume === "number") volume = sb.volume;
      queueMode = !!sb.queueMode;
    } else if (msg.type === EVENT_TYPES.SOUNDBOARD_PLAY) {
      trigger(msg.payload);
    }
  }

  function connect() {
    ws = new WebSocket(proto + location.host + "/ws");
    ws.onmessage = (ev) => {
      try {
        handleMessage(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      if (ws) ws.close();
    };
  }

  connect();
})();
