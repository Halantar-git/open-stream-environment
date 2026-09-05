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
  Splash overlay (intro/brb/outro заставка).

  A full-screen browser source shown during scene transitions. It plays a local
  video, image or GIF; when no file is configured it shows the standard brand
  splash instead. On end/error/timeout it sends VIDEO_SPLASH_ENDED back so the
  server can auto-advance to the pending target scene.
*/
(function () {
  const { EVENT_TYPES } = window.SharedEvents;
  const video = document.getElementById("splashVideo");
  const image = document.getElementById("splashImage");
  const defaultEl = document.getElementById("defaultSplash");
  const defaultLabel = document.getElementById("defaultLabel");

  const DEFAULT_IMAGE_MS = 4000; // картинка / GIF, если длительность не задана
  const DEFAULT_HOLD_MS = 2500; // стандартная заставка

  function resolveUrl(p) {
    if (!p) return "";
    if (/^(https?:)?\/\//i.test(p) || p.startsWith("data:")) return p;
    return location.origin + "/" + String(p).replace(/^\/+/, "");
  }

  function mediaKind(file) {
    if (/\.(mp4|webm|mov)$/i.test(file)) return "video";
    if (/\.(png|jpe?g|gif|webp)$/i.test(file)) return "image";
    return "";
  }

  let ws = null;
  let advanceTimer = null;

  function clearAdvanceTimer() {
    if (advanceTimer) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
  }

  function notifyEnded() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: EVENT_TYPES.VIDEO_SPLASH_ENDED }));
    }
  }

  function hideAll() {
    clearAdvanceTimer();
    video.pause();
    video.removeAttribute("src");
    video.hidden = true;
    image.removeAttribute("src");
    image.hidden = true;
    defaultEl.hidden = true;
  }

  function showDefault(title) {
    hideAll();
    defaultLabel.textContent = title || "OPEN STREAM ENVIRONMENT";
    defaultEl.hidden = false;
    advanceTimer = setTimeout(notifyEnded, DEFAULT_HOLD_MS);
  }

  function showImage(url, durationMs) {
    hideAll();
    image.src = url;
    image.hidden = false;
    advanceTimer = setTimeout(notifyEnded, durationMs);
  }

  function showVideo(url) {
    hideAll();
    video.src = url;
    video.hidden = false;
    video.muted = false;
    video.autoplay = true;
    video.playsInline = true;
    video.loop = false;

    const attempt = video.play();
    // If autoplay-with-sound is blocked (some CEF/browser-source policies),
    // fall back to a muted autoplay so the stream is never stuck.
    if (attempt && typeof attempt.catch === "function") {
      attempt.catch(() => {
        video.muted = true;
        video.play().catch(() => notifyEnded());
      });
    }
  }

  function play(payload) {
    const file = (payload && payload.mediaFile) || "";
    const durationSec = Number(payload && payload.duration) || 0;
    const durationMs = durationSec > 0 ? Math.max(1000, Math.round(durationSec * 1000)) : DEFAULT_IMAGE_MS;
    const url = resolveUrl(file);
    const kind = mediaKind(file);
    if (kind === "video" && url) showVideo(url);
    else if (kind === "image" && url) showImage(url, durationMs);
    else showDefault(payload && payload.title);
  }

  function handleMessage(msg) {
    if (msg.type === EVENT_TYPES.VIDEO_SPLASH_PLAY) play(msg.payload);
  }

  video.addEventListener("ended", notifyEnded);
  video.addEventListener("error", notifyEnded);
  image.addEventListener("error", notifyEnded);

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: EVENT_TYPES.VIDEO_SPLASH_READY }));
      }
    };
    ws.onmessage = (ev) => {
      try {
        handleMessage(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws.close();
  }

  connect();
})();
