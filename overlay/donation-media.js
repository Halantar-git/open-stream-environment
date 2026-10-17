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
  Donation media layer — sound, image or video assigned to a donation amount.

  The layer is global (not a layout widget): the server picks the rule and sends
  `donation_media_play`. Audio plays independently; an image stays for its
  configured duration; a video plays to the end and then clears the layer.
*/
(function () {
  const layer = document.getElementById("donationMedia");
  const video = document.getElementById("donationMediaVideo");
  const image = document.getElementById("donationMediaImage");
  if (!layer || !video || !image) return;

  let hideTimer = null;
  let audio = null;

  function resolveUrl(path) {
    if (!path) return "";
    if (/^(https?:)?\/\//i.test(path) || path.startsWith("data:")) return path;
    return "/" + String(path).replace(/^\/+/, "");
  }

  function stop() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.hidden = true;
    image.removeAttribute("src");
    image.hidden = true;
    layer.hidden = true;
    if (audio) {
      audio.pause();
      audio = null;
    }
  }

  function play(media) {
    if (!media) return;
    stop();

    const volume = Math.max(0, Math.min(1, Number(media.volume)));
    const level = Number.isFinite(volume) ? volume : 0.8;

    if (media.audioFile) {
      audio = new Audio(resolveUrl(media.audioFile));
      audio.volume = level;
      audio.play().catch(() => {
        /* автоплей может быть запрещён — тихо пропускаем звук */
      });
    }

    if (media.videoFile) {
      layer.hidden = false;
      image.hidden = true;
      video.hidden = false;
      video.src = resolveUrl(media.videoFile);
      video.volume = level;
      video.currentTime = 0;
      const attempt = video.play();
      if (attempt && typeof attempt.catch === "function") {
        attempt.catch(() => stop());
      }
      return;
    }

    if (media.imageFile) {
      layer.hidden = false;
      video.hidden = true;
      image.hidden = false;
      image.src = resolveUrl(media.imageFile);
      const duration = Math.max(1000, Number(media.durationMs) || 5000);
      hideTimer = setTimeout(stop, duration);
    }
  }

  video.addEventListener("ended", stop);
  video.addEventListener("error", stop);

  window.OSEDonationMedia = { play, stop };
})();
