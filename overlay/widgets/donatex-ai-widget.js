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
  DonateX AI character widget.

  Primary mode (event-driven): listens for `donatex_ai_event` pushed by the
  backend from the single DonateX SignalR connection and shows a speaking
  avatar + dialog bubble, playing the generated voice line.

  Fallback mode: if `config.url` is set, the widget embeds that link in an
  iframe instead (for a full DonateX character/overlay URL).
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const DonatexAiWidget = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = DonatexAiWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.DonatexAiWidget = DonatexAiWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const clamp01 = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return 0.8;
    return Math.max(0, Math.min(1, n));
  };

  class DonatexAiWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-donatex-ai";
      this.element.appendChild(this.host);

      this._audio = null;
      this._hideTimer = null;
      this._renderedUrl = null;

      this.buildIframeHost();
      this.buildEventDom();
      this.applyMode();

      this.subscribe(this.context.EVENT_TYPES.DONATEX_AI_EVENT, (data) => this.trigger(data));
    }

    onUpdate() {
      this.applyMode();
    }

    onUnmount() {
      this.stopAudio();
      this.clearHideTimer();
    }

    buildIframeHost() {
      this.iframeHost = document.createElement("div");
      this.iframeHost.className = "widget-donatex-ai__frame-host";
      this.iframeHost.style.display = "none";
      this.host.appendChild(this.iframeHost);
    }

    buildEventDom() {
      this.eventHost = document.createElement("div");
      this.eventHost.className = "widget-donatex-ai__event";
      this.eventHost.style.display = "none";
      this.host.appendChild(this.eventHost);

      const avatarBox = document.createElement("div");
      avatarBox.className = "ai-avatar-box";
      this.avatarArt = document.createElement("img");
      this.avatarArt.className = "ai-avatar-art";
      this.avatarArt.alt = "";
      this.avatarArt.style.display = "none";
      this.avatarVisual = document.createElement("div");
      this.avatarVisual.className = "ai-avatar-visual";
      avatarBox.appendChild(this.avatarArt);
      avatarBox.appendChild(this.avatarVisual);

      const bubble = document.createElement("div");
      bubble.className = "ai-dialog-bubble";
      this.nameEl = document.createElement("div");
      this.nameEl.className = "ai-speaker-name";
      this.textEl = document.createElement("div");
      this.textEl.className = "ai-text-content";
      bubble.appendChild(this.nameEl);
      bubble.appendChild(this.textEl);

      this.eventHost.appendChild(avatarBox);
      this.eventHost.appendChild(bubble);
    }

    applyMode() {
      const url = String(this.config.url || "").trim();

      if (url) {
        // Iframe fallback: embeds a full character/overlay URL, events are ignored.
        this.eventHost.style.display = "none";
        this.iframeHost.style.display = "";
        if (url !== this._renderedUrl) {
          this._renderedUrl = url;
          this.iframeHost.innerHTML = "";
          const iframe = document.createElement("iframe");
          iframe.className = "widget-donatex-ai__frame";
          iframe.src = url;
          iframe.title = "";
          iframe.allow = "autoplay; fullscreen; clipboard-write; picture-in-picture";
          iframe.allowFullscreen = true;
          iframe.setAttribute("referrerpolicy", "no-referrer");
          this.iframeHost.appendChild(iframe);
        }
        return;
      }

      this._renderedUrl = null;
      this.iframeHost.style.display = "none";
      this.applyAvatar();
    }

    applyAvatar() {
      const url = String(this.config.avatarUrl || "").trim();
      if (url && this.avatarArt) {
        this.avatarArt.src = this.context.resolveMediaUrl
          ? this.context.resolveMediaUrl(url)
          : url;
        this.avatarArt.style.display = "";
        this.avatarVisual.style.display = "none";
      } else {
        this.avatarArt.style.display = "none";
        this.avatarVisual.style.display = "";
      }
    }

    trigger(data) {
      if (!data || String(this.config.url || "").trim()) return;
      if (!this.eventHost) return;

      this.nameEl.textContent =
        data.characterName ||
        this.config.characterName ||
        (this.context.t ? this.context.t("donatexAi.defaultName") : "Ассистент");
      this.textEl.textContent = data.aiText || data.message || "";
      this.nameEl.style.display = this.config.showName === false ? "none" : "";

      this.eventHost.style.display = "flex";
      this.host.classList.add("is-active");

      this.stopAudio();
      this.clearHideTimer();

      if (data.aiAudio) {
        let audio;
        try {
          audio = new Audio(data.aiAudio);
        } catch (_) {
          audio = null;
        }
        if (audio) {
          audio.volume = clamp01(this.config.volume != null ? this.config.volume : 0.8);
          this._audio = audio;
          audio.addEventListener("ended", () => this.hide());
          audio.addEventListener("error", () => this.hide());
          const started = audio.play();
          if (started && typeof started.catch === "function") {
            started.catch(() => this.scheduleHide());
          }
        } else {
          this.scheduleHide();
        }
      } else {
        this.scheduleHide();
      }
    }

    scheduleHide() {
      this.clearHideTimer();
      const ms = Number(this.config.hideDelayMs);
      const delay = isFinite(ms) && ms > 0 ? ms : 5000;
      this._hideTimer = this.later(() => this.hide(), delay);
    }

    hide() {
      this.stopAudio();
      this.clearHideTimer();
      if (this.eventHost) this.eventHost.style.display = "none";
      this.host.classList.remove("is-active");
    }

    stopAudio() {
      const audio = this._audio;
      this._audio = null;
      if (audio) {
        try {
          audio.pause();
        } catch (_) {
          /* ignore */
        }
      }
    }

    clearHideTimer() {
      if (this._hideTimer) {
        this.clearTimer(this._hideTimer);
        this._hideTimer = null;
      }
    }

    render() {}
  }

  return DonatexAiWidget;
});
