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
  avatar + dialog bubble, playing the generated voice line. The bubble shows
  who donated and how much when DonateX sends this with the reply.

  Replies wait in a queue while the previous line is speaking: a donation
  should not silence the one before it. The queue can be turned off in the
  inspector.

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
      this._active = false;
      this._current = null;
      this.queue = [];

      this.buildIframeHost();
      this.buildEventDom();
      this.applyMode();

      this.subscribe(this.context.EVENT_TYPES.DONATEX_AI_EVENT, (data) => this.trigger(data));
    }

    onUpdate() {
      this.applyMode();
      if (this.config.queue === false && this.queue.length) {
        this.queue.length = 0;
        this.renderQueue();
      }
      if (this._current) this.renderSpeaker(this._current);
    }

    onUnmount() {
      this.stopAudio();
      this.clearHideTimer();
      this._active = false;
      this._current = null;
      this.queue.length = 0;
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
      this.donorEl = document.createElement("div");
      this.donorEl.className = "ai-donor";
      this.donorEl.style.display = "none";
      this.textEl = document.createElement("div");
      this.textEl.className = "ai-text-content";
      this.queueEl = document.createElement("div");
      this.queueEl.className = "ai-queue";
      this.queueEl.style.display = "none";
      bubble.appendChild(this.nameEl);
      bubble.appendChild(this.donorEl);
      bubble.appendChild(this.textEl);
      bubble.appendChild(this.queueEl);

      this.eventHost.appendChild(avatarBox);
      this.eventHost.appendChild(bubble);
    }

    applyMode() {
      const url = String(this.config.url || "").trim();

      if (url) {
        // Iframe fallback: embeds a full character/overlay URL, events are ignored.
        this.stopAudio();
        this.clearHideTimer();
        this.host.classList.remove("is-active");
        this.host.classList.remove("is-speaking");
        this._active = false;
        this._current = null;
        this.queue.length = 0;
        this.renderQueue();

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
      this.renderQueue();
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

      if (this._active && this.queueEnabled()) {
        this.queue.push(data);
        this.renderQueue();
        return;
      }
      this.speak(data);
    }

    queueEnabled() {
      return this.config.queue !== false;
    }

    speak(data) {
      this._active = true;
      this._current = data;
      this.renderSpeaker(data);
      this.textEl.textContent = data.aiText || data.message || "";

      this.eventHost.style.display = "flex";
      this.host.classList.add("is-active");

      this.stopAudio();
      this.clearHideTimer();

      const audioUrl = String(data.aiAudio || "").trim();
      if (audioUrl) {
        const src = this.context.resolveMediaUrl
          ? this.context.resolveMediaUrl(audioUrl)
          : audioUrl;
        let audio;
        try {
          audio = new Audio(src);
        } catch (_) {
          audio = null;
        }
        if (audio) {
          audio.volume = clamp01(this.config.volume != null ? this.config.volume : 0.8);
          this._audio = audio;
          this.host.classList.add("is-speaking");
          audio.addEventListener("ended", () => {
            if (this._audio !== audio) return;
            this.host.classList.remove("is-speaking");
            this.hide();
          });
          audio.addEventListener("error", () => {
            if (this._audio !== audio) return;
            this.host.classList.remove("is-speaking");
            this.hide();
          });
          const started = audio.play();
          if (started && typeof started.catch === "function") {
            started.catch(() => {
              if (this._audio !== audio) return;
              this.host.classList.remove("is-speaking");
              this.scheduleHide();
            });
          }
          return;
        }
      }
      this.scheduleHide();
    }

    renderSpeaker(data) {
      this.nameEl.textContent =
        data.characterName ||
        this.config.characterName ||
        (this.context.t ? this.context.t("donatexAi.defaultName") : "Ассистент");
      this.nameEl.style.display = this.config.showName === false ? "none" : "";

      const donor = this.donorLine(data);
      this.donorEl.textContent = donor;
      this.donorEl.style.display = donor ? "" : "none";
    }

    /// «nick · 250 ₽» — сумма тем же форматером, что в алертах.
    donorLine(data) {
      if (this.config.showDonor === false) return "";
      const user = String(data.user || "").trim();
      if (!user) return "";
      if (data.amount == null || data.amount === "") return user;
      const money = this.context.formatMoney
        ? this.context.formatMoney(data.amount)
        : String(data.amount);
      const symbol = this.context.currencySymbol
        ? this.context.currencySymbol(data.currency)
        : String(data.currency || "");
      return `${user} · ${money} ${symbol}`.trim();
    }

    renderQueue() {
      if (!this.queueEl) return;
      const count = this.queue.length;
      if (!count) {
        this.queueEl.textContent = "";
        this.queueEl.style.display = "none";
        return;
      }
      this.queueEl.textContent = this.context.t
        ? this.context.t("donatexAi.queue", { count })
        : `+${count}`;
      this.queueEl.style.display = "";
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
      this.host.classList.remove("is-speaking");
      this._active = false;
      this._current = null;

      if (this.queue.length) {
        const next = this.queue.shift();
        this.renderQueue();
        this.speak(next);
        return;
      }

      this.renderQueue();
      if (this.eventHost) this.eventHost.style.display = "none";
      this.host.classList.remove("is-active");
    }

    stopAudio() {
      const audio = this._audio;
      this._audio = null;
      this.host.classList.remove("is-speaking");
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
