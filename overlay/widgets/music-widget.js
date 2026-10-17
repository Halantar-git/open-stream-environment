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
  DonateX music widget — "Orbital Deck": a neon Sci-Fi player for the track
  attached to a donation. Shows cover art (YouTube thumbnail or a rotating
  vinyl placeholder), a marquee track title, the requester, a countdown timer
  and a progress bar. Accent colors follow the active overlay theme.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const MusicWidget = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = MusicWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.MusicWidget = MusicWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const SIMULATED_PLAY_MS = 20000;

  function youtubeVideoId(link) {
    if (!link) return "";
    try {
      const u = new URL(link);
      if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0];
      if (/youtube\.com$|\.youtube\.com$|music\.youtube\.com$/.test(u.hostname)) {
        const v = u.searchParams.get("v");
        if (v) return v;
        const m = u.pathname.match(/\/(shorts|embed|v)\/([^/?]+)/);
        if (m) return m[2];
      }
    } catch (_) {
      /* ignore */
    }
    return "";
  }

  function resolveCoverArt(link) {
    const id = youtubeVideoId(link);
    return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : "";
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return "--:--";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  class MusicWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-music";
      this.element.appendChild(this.host);

      this._audio = null;
      this._simTimer = null;
      this.current = null;
      this.el = {};

      this.buildDom();

      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this.onAlert(alert));
      this.subscribe(this.context.EVENT_TYPES.LOCALES, () => {
        if (this.current) this.applyPlaying(this.current);
        else this.renderIdle();
      });
      this.renderIdle();
    }

    onUnmount() {
      this.stopPlayback();
      this.current = null;
    }

    onAlert(alert) {
      if (!alert || alert.kind !== "donation" || !alert.musicLink) return;
      this.play({ user: alert.user, musicLink: alert.musicLink, amount: alert.amount, currency: alert.currency });
    }

    buildDom() {
      this.host.innerHTML = `
        <div class="orbital">
          <div class="orbital__cover">
            <span class="orbital__vinyl"></span>
            <span class="orbital__note">♪</span>
            <img class="orbital__art" alt="" />
          </div>
          <div class="orbital__meta">
            <div class="orbital__track">
              <span class="orbital__track-inner">
                <span class="orbital__track-text"></span><span class="orbital__track-text"></span>
              </span>
            </div>
            <div class="orbital__requester"></div>
          </div>
          <div class="orbital__timer">00:00 / --:--</div>
        </div>
        <div class="orbital__progress"><span class="orbital__progress-fill"></span></div>`;

      this.el = {
        track: this.host.querySelector(".orbital__track"),
        trackTexts: this.host.querySelectorAll(".orbital__track-text"),
        requester: this.host.querySelector(".orbital__requester"),
        timer: this.host.querySelector(".orbital__timer"),
        progressFill: this.host.querySelector(".orbital__progress-fill"),
        art: this.host.querySelector(".orbital__art"),
        note: this.host.querySelector(".orbital__note"),
      };
    }

    // ---- playback ----

    play(info) {
      this.current = info;
      this.stopPlayback();
      this.host.classList.add("is-playing");
      this.applyPlaying(info);

      if (this.config.autoplay !== false) this.startAudio(info.musicLink);
      else this.scheduleSimulatedStop();
    }

    applyPlaying(info) {
      this.resetProgress();
      const title = this.trackTitle(info);
      this.el.trackTexts.forEach((s) => (s.textContent = title));
      this.el.requester.textContent = this.context.t("music.requester", { user: info.user || "Аноним" });
      this.setCoverArt(info.musicLink);
      this.syncOrbitalMarquee();
    }

    renderIdle() {
      this.resetProgress();
      const idle = this.context.t("music.idle");
      this.el.trackTexts.forEach((s) => (s.textContent = idle));
      this.el.requester.textContent = "";
      this.setCoverArt("");
      this.syncOrbitalMarquee();
    }

    startAudio(link) {
      let audio;
      try {
        audio = new Audio(link);
      } catch (_) {
        this.scheduleSimulatedStop();
        return;
      }
      audio.volume = 1;
      this._audio = audio;
      audio.addEventListener("ended", () => this.idle());
      audio.addEventListener("error", () => this.idle());
      audio.addEventListener("timeupdate", () => this.updateProgress(audio.currentTime, audio.duration));

      const started = audio.play();
      if (started && typeof started.catch === "function") {
        started.catch(() => {
          if (this._audio === audio) this.scheduleSimulatedStop();
        });
      }
    }

    updateProgress(cur, dur) {
      if (this.el.timer) this.el.timer.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
      const pct = isFinite(dur) && dur > 0 ? Math.min(1, cur / dur) : 0;
      if (this.el.progressFill) this.el.progressFill.style.width = (pct * 100).toFixed(2) + "%";
    }

    resetProgress() {
      if (this.el.timer) this.el.timer.textContent = "00:00 / --:--";
      if (this.el.progressFill) this.el.progressFill.style.width = "0%";
    }

    scheduleSimulatedStop() {
      this.clearSimTimer();
      this._simTimer = this.later(() => {
        this._simTimer = null;
        if (!this.host.classList.contains("is-playing")) return;
        this.idle();
      }, SIMULATED_PLAY_MS);
    }

    clearSimTimer() {
      if (this._simTimer) {
        this.clearTimer(this._simTimer);
        this._simTimer = null;
      }
    }

    idle() {
      this.stopAudio();
      this.clearSimTimer();
      this.host.classList.remove("is-playing");
      this.current = null;
      this.renderIdle();
    }

    stopAudio() {
      const a = this._audio;
      this._audio = null;
      if (a) {
        try {
          a.pause();
        } catch (_) {
          /* ignore */
        }
      }
    }

    stopPlayback() {
      this.stopAudio();
      this.clearSimTimer();
      this.host.classList.remove("is-playing");
    }

    // ---- text / art helpers ----

    trackTitle(info) {
      const link = info && info.musicLink;
      if (link) {
        try {
          const u = new URL(link);
          const seg = decodeURIComponent((u.pathname.split("/").filter(Boolean).pop() || "")).trim();
          if (seg && !/youtube\.com$|youtu\.be$/.test(u.hostname)) return seg;
        } catch (_) {
          /* ignore */
        }
      }
      return this.context.t("music.track");
    }

    setCoverArt(link) {
      if (!this.el.art) return;
      const url = resolveCoverArt(link);
      const showNote = () => {
        if (this.el.note) this.el.note.style.display = "";
        this.el.art.style.display = "none";
      };
      this.el.art.onerror = showNote;
      if (url) {
        this.el.art.src = url;
        this.el.art.style.display = "";
        if (this.el.note) this.el.note.style.display = "none";
      } else {
        this.el.art.removeAttribute("src");
        showNote();
      }
    }

    syncOrbitalMarquee() {
      const track = this.el.track;
      const first = this.el.trackTexts && this.el.trackTexts[0];
      if (!track || !first) return;
      requestAnimationFrame(() => {
        if (!this.el || !this.el.track) return;
        this.el.track.classList.toggle("is-marquee", first.getBoundingClientRect().width > track.clientWidth);
      });
    }

    render() {}
  }

  return MusicWidget;
});
