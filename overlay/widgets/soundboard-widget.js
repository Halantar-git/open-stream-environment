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
  Soundboard widget — plays a sound and shows a popup card when a channel-point
  reward is redeemed. Owns its audio queue so multiple widgets don't collide.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const SoundboardWidget = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = SoundboardWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.SoundboardWidget = SoundboardWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  class SoundboardWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-soundboard";
      this.element.appendChild(this.host);
      this.queue = [];
      this.busy = false;
      this.activeAudios = [];
      this.subscribe(this.context.EVENT_TYPES.SOUNDBOARD_PLAY, (sound) => this.trigger(sound));
    }

    onUnmount() {
      for (const a of this.activeAudios) {
        try {
          a.pause();
        } catch (_) {
          /* ignore */
        }
      }
      this.activeAudios = [];
      this.queue = [];
    }

    trigger(sound) {
      if (!sound) return;
      if (this.context.state.soundboardConfig.queueMode) {
        this.queue.push(sound);
        this.drainQueue();
      } else {
        this.playAudio(sound);
      }
      this.popup(sound);
    }

    playAudio(sound, onEnded) {
      const { resolveMediaUrl, state } = this.context;
      if (!sound.audioFile) {
        if (onEnded) onEnded();
        return;
      }
      const audio = new Audio(resolveMediaUrl(sound.audioFile));
      audio.volume = typeof state.soundboardConfig.volume === "number" ? state.soundboardConfig.volume : 0.8;
      audio.play().catch(() => {
        if (onEnded) onEnded();
      });
      audio.addEventListener("ended", () => {
        const i = this.activeAudios.indexOf(audio);
        if (i >= 0) this.activeAudios.splice(i, 1);
        if (onEnded) onEnded();
      });
      this.activeAudios.push(audio);
    }

    drainQueue() {
      if (this.busy) return;
      const next = this.queue.shift();
      if (!next) return;
      this.busy = true;
      this.playAudio(next, () => {
        this.busy = false;
        this.drainQueue();
      });
    }

    popup(sound) {
      if (!this.geometry.visible) return;
      const { escapeHtml, resolveMediaUrl, t } = this.context;
      const cfg = this.config;
      const duration = typeof cfg.popupDurationMs === "number" ? cfg.popupDurationMs : 4600;
      const showImage = cfg.showImage !== false;
      const showText = cfg.showText !== false;
      const showBackground = cfg.showBackground !== false;
      const showBorder = cfg.showBorder !== false;
      const imageSize = Math.max(40, typeof cfg.imageSize === "number" ? cfg.imageSize : 200);

      const card = document.createElement("div");
      card.className = "soundboard-popup";
      if (!showBackground) card.classList.add("soundboard-popup--no-bg");
      if (!showBorder) card.classList.add("soundboard-popup--no-border");

      let video = null;

      if (showImage) {
        const media = document.createElement("div");
        media.className = "soundboard-popup__media";
        media.style.width = imageSize + "px";
        media.style.height = imageSize + "px";
        if (sound.videoFile) {
          video = document.createElement("video");
          video.src = resolveMediaUrl(sound.videoFile);
          video.autoplay = true;
          video.muted = true;
          video.loop = false;
          video.playsInline = true;
          video.style.width = "100%";
          video.style.height = "100%";
          video.style.objectFit = "contain";
          media.appendChild(video);
        } else if (sound.imageFile) {
          const img = document.createElement("img");
          img.src = resolveMediaUrl(sound.imageFile);
          img.alt = "";
          media.appendChild(img);
        } else {
          media.textContent = "🔊";
          media.style.fontSize = Math.round(imageSize * 0.5) + "px";
        }
        card.appendChild(media);
      }

      if (showText) {
        const text = document.createElement("div");
        text.className = "soundboard-popup__text";
        text.innerHTML = t("overlay.soundboardPlayed", {
          user: escapeHtml(sound.user || ""),
          title: escapeHtml(sound.title || sound.soundId || ""),
        });
        card.appendChild(text);
      }

      this.host.appendChild(card);

      const removeCard = () => card.remove();
      if (video) {
        video.addEventListener("ended", removeCard);
        video.addEventListener("error", removeCard);
        this.later(removeCard, 30000);
      } else {
        this.later(removeCard, duration + 100);
      }
    }

    render() {}
  }

  return SoundboardWidget;
});
