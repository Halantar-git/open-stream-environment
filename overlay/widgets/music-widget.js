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

  Donations can arrive back to back, so tracks wait in a queue instead of
  cutting each other off. If the link is not a direct audio file, the widget
  moves the progress bar itself for the same simulated duration and only then
  takes the next track.
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
  const SIM_TICK_MS = 250;

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

  function clamp01(value, fallback) {
    const number = Number(value);
    if (!isFinite(number)) return fallback;
    return Math.max(0, Math.min(1, number));
  }

  /// Ссылка, которую можно отдать в `Audio`: http/https или файл из медиатеки
  /// (`media/…`, его раскрывает `resolveMediaUrl`). Прочие схемы
  /// (`javascript:`, `file:`) в источник звука не отдаём.
  function webUrl(value) {
    const link = String(value || "").trim();
    if (/^https?:\/\//i.test(link)) return link;
    if (/^media\/[\w./-]+$/i.test(link)) return link;
    return "";
  }

  /// «250 ₽» в локали интерфейса — тем же форматером, что и алерты.
  function sumText(context, amount, currency) {
    if (amount == null || amount === "") return "";
    const money = context.formatMoney ? context.formatMoney(amount) : String(amount);
    const symbol = context.currencySymbol
      ? context.currencySymbol(currency)
      : String(currency || "");
    return `${money} ${symbol}`.trim();
  }

  class MusicWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-music";
      this.element.appendChild(this.host);

      this._audio = null;
      this._simTimer = null;
      this._simTick = null;
      this._donatexFrame = null;
      this._donatexUrl = "";
      this.current = null;
      this.queue = [];
      this.el = {};

      this.buildDom();
      // Страница DonateX должна быть открыта всё время, а не только когда
      // играет трек: по ней сервис и считает виджет подключённым.
      this.syncDonatexWidget();

      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this.onAlert(alert));
      if (this.context.EVENT_TYPES.MUSIC_PLAY) {
        this.subscribe(this.context.EVENT_TYPES.MUSIC_PLAY, (payload) => this.onMusicPlay(payload));
      }
      if (this.context.EVENT_TYPES.MUSIC_CONTROL) {
        this.subscribe(this.context.EVENT_TYPES.MUSIC_CONTROL, (payload) => this.onControl(payload));
      }
      this.subscribe(this.context.EVENT_TYPES.LOCALES, () => {
        if (this.current) this.renderMeta(this.current);
        else this.renderIdle();
        this.renderQueue();
      });
      this.renderIdle();
      this.renderQueue();
    }

    onUnmount() {
      this.stopPlayback();
      this.removeDonatexWidget();
      this.current = null;
      this.queue.length = 0;
    }

    onUpdate() {
      // Очередь выключили — ждущие треки больше не нужны.
      if (this.config.queue === false && this.queue.length) {
        this.queue.length = 0;
        this.renderQueue();
      }
      this.syncDonatexWidget();
      // Со ссылкой на виджет DonateX трек играет их страница; наш звук
      // выключаем, чтобы не было двух дорожек.
      if (this.donatexWidgetUrl() && this._audio) {
        this.stopAudio();
        if (this.current) this.scheduleSimulatedStop();
      }
      if (this._audio) this._audio.volume = clamp01(this.config.volume, 1);
      if (this.current) this.renderMeta(this.current);
    }

    onAlert(alert) {
      if (!alert || alert.kind !== "donation") return;
      const musicLink = webUrl(alert.musicLink);
      if (!musicLink) return;
      const track = {
        user: alert.user,
        musicLink,
        musicTitle: alert.musicTitle,
        amount: alert.amount,
        currency: alert.currency,
      };
      if (this.current && this.queueEnabled()) {
        this.queue.push(track);
        this.renderQueue();
        return;
      }
      this.play(track);
    }

    // Ссылка из инспектора: проверка виджета, а не событие стрима — суммы и
    // имени нет, звучит сразу и не встаёт в очередь.
    onMusicPlay(payload) {
      const musicLink = webUrl(payload && payload.musicLink);
      if (!musicLink) return;
      this.play({
        user: "",
        musicLink,
        musicTitle: (payload && payload.musicTitle) || "",
        amount: null,
        currency: "",
      });
    }

    // Управление плеером из инспектора: «Пропустить» заканчивает текущий
    // трек и берёт следующий, «Стоп» гасит плеер и чистит очередь.
    onControl(payload) {
      const action = payload && payload.action;
      if (action === "skip") this.skip();
      else if (action === "stop") this.stopAll();
    }

    skip() {
      // `idle()` останавливает звук, снимает «играет» и берёт следующий трек
      // из очереди; пустая очередь просто возвращает плеер в покой.
      this.idle();
    }

    stopAll() {
      this.queue = [];
      this.stopPlayback();
      this.current = null;
      this.renderQueue();
      this.renderIdle();
    }

    queueEnabled() {
      return this.config.queue !== false;
    }

    buildDom() {
      const el = (tag, className) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        return node;
      };

      const orbital = el("div", "orbital");
      const cover = el("div", "orbital__cover");
      const vinyl = el("span", "orbital__vinyl");
      const note = el("span", "orbital__note");
      note.textContent = "♪";
      const art = el("img", "orbital__art");
      art.alt = "";
      cover.appendChild(vinyl);
      cover.appendChild(note);
      cover.appendChild(art);

      const meta = el("div", "orbital__meta");
      const track = el("div", "orbital__track");
      const trackInner = el("span", "orbital__track-inner");
      const text1 = el("span", "orbital__track-text");
      const text2 = el("span", "orbital__track-text");
      trackInner.appendChild(text1);
      trackInner.appendChild(text2);
      track.appendChild(trackInner);

      const requester = el("div", "orbital__requester");
      const queue = el("div", "orbital__queue");
      queue.style.display = "none";
      meta.appendChild(track);
      meta.appendChild(requester);
      meta.appendChild(queue);

      const timer = el("div", "orbital__timer");
      orbital.appendChild(cover);
      orbital.appendChild(meta);
      orbital.appendChild(timer);

      const progress = el("div", "orbital__progress");
      const progressFill = el("span", "orbital__progress-fill");
      progress.appendChild(progressFill);

      this.host.appendChild(orbital);
      this.host.appendChild(progress);

      this.el = {
        track,
        trackTexts: [text1, text2],
        requester,
        queue,
        timer,
        progressFill,
        art,
        note,
      };
    }

    // ---- страница музыкального виджета DonateX ----

    /// Адрес их виджета из кабинета: только он делает виджет «подключённым».
    /// Проверяем жёстко — в iframe попадает только страница DonateX, а не
    /// произвольный адрес из настроек.
    donatexWidgetUrl() {
      const raw = String(this.config.donatexWidgetUrl || "").trim();
      if (!raw) return "";
      try {
        const url = new URL(raw);
        if (url.protocol !== "https:") return "";
        if (!/(^|\.)donatex\.gg$/i.test(url.hostname)) return "";
        if (!/^\/widgets\/music\/[0-9a-z-]+\/?$/i.test(url.pathname)) return "";
        return `${url.origin}${url.pathname}`;
      } catch (_) {
        return "";
      }
    }

    /// Держать скрытую страницу в соответствии с настройкой. 1×1 в углу:
    /// DonateX видит открытый виджет и играет трек сам, а оверлей не получает
    /// второй интерфейс поверх нашего.
    syncDonatexWidget() {
      const url = this.donatexWidgetUrl();
      if (url === this._donatexUrl) return;
      this._donatexUrl = url;
      this.removeDonatexWidget();
      if (!url || !this.host) return;

      const frame = document.createElement("iframe");
      frame.className = "widget-music__donatex";
      frame.src = url;
      frame.title = "DonateX music";
      frame.allow = "autoplay";
      frame.tabIndex = -1;
      frame.setAttribute("aria-hidden", "true");
      this.host.appendChild(frame);
      this._donatexFrame = frame;
    }

    removeDonatexWidget() {
      if (!this._donatexFrame) return;
      this._donatexFrame.remove();
      this._donatexFrame = null;
    }

    // ---- playback ----

    play(info) {
      this.current = info;
      this.stopPlayback();
      this.host.classList.add("is-playing");
      this.applyPlaying(info);

      // С подключённым виджетом DonateX звук идёт с их страницы: пробуем
      // играть только без него. Иначе трек звучал бы дважды.
      if (this.donatexWidgetUrl()) this.scheduleSimulatedStop();
      else if (this.config.autoplay !== false) this.startAudio(info.musicLink);
      else this.scheduleSimulatedStop();
    }

    applyPlaying(info) {
      this.resetProgress();
      this.renderMeta(info);
    }

    renderMeta(info) {
      const title = this.trackTitle(info);
      this.el.trackTexts.forEach((span) => (span.textContent = title));

      const user = info.user || this.context.t("music.anonymous");
      const requester = this.context.t("music.requester", { user });
      const sum =
        this.config.showAmount === false ? "" : sumText(this.context, info.amount, info.currency);
      this.el.requester.textContent = sum ? `${requester} · ${sum}` : requester;

      this.setCoverArt(info.musicLink);
      this.syncOrbitalMarquee();
    }

    renderIdle() {
      this.resetProgress();
      const idle = this.context.t("music.idle");
      this.el.trackTexts.forEach((span) => (span.textContent = idle));
      this.el.requester.textContent = "";
      this.setCoverArt("");
      this.syncOrbitalMarquee();
    }

    renderQueue() {
      if (!this.el.queue) return;
      const count = this.queue.length;
      if (!count) {
        this.el.queue.textContent = "";
        this.el.queue.style.display = "none";
        return;
      }
      this.el.queue.textContent = this.context.t("music.queue", { count });
      this.el.queue.style.display = "";
    }

    startAudio(link) {
      this.clearSimTimer();
      const src = this.context.resolveMediaUrl ? this.context.resolveMediaUrl(link) : link;
      let audio;
      try {
        audio = new Audio(src);
      } catch (_) {
        this.scheduleSimulatedStop();
        return;
      }
      audio.volume = clamp01(this.config.volume, 1);
      this._audio = audio;
      audio.addEventListener("ended", () => {
        if (this._audio === audio) this.idle();
      });
      audio.addEventListener("error", () => {
        if (this._audio === audio) this.idle();
      });
      audio.addEventListener("timeupdate", () => {
        if (this._audio === audio) this.updateProgress(audio.currentTime, audio.duration);
      });

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

    /// Ссылка может быть страницей YouTube: звука из неё не будет, поэтому
    /// показываем тот же отрезок времени полосой прогресса и идём дальше.
    scheduleSimulatedStop() {
      this.clearSimTimer();
      const total = SIMULATED_PLAY_MS;
      const startedAt = Date.now();
      this.updateProgress(0, total / 1000);
      this._simTick = this.every(() => {
        const elapsed = Math.min(total, Date.now() - startedAt);
        this.updateProgress(elapsed / 1000, total / 1000);
      }, SIM_TICK_MS);
      this._simTimer = this.later(() => {
        this._simTimer = null;
        if (!this.host.classList.contains("is-playing")) return;
        this.idle();
      }, total);
    }

    clearSimTimer() {
      if (this._simTimer) {
        this.clearTimer(this._simTimer);
        this._simTimer = null;
      }
      if (this._simTick) {
        this.clearTimer(this._simTick);
        this._simTick = null;
      }
    }

    idle() {
      this.stopAudio();
      this.clearSimTimer();
      this.host.classList.remove("is-playing");
      this.current = null;
      if (this.queue.length) {
        const next = this.queue.shift();
        this.renderQueue();
        this.play(next);
        return;
      }
      this.renderQueue();
      this.renderIdle();
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

    stopPlayback() {
      this.stopAudio();
      this.clearSimTimer();
      this.host.classList.remove("is-playing");
    }

    // ---- text / art helpers ----

    trackTitle(info) {
      const explicit = info && typeof info.musicTitle === "string" ? info.musicTitle.trim() : "";
      if (explicit) return explicit;

      const link = info && info.musicLink;
      if (link) {
        try {
          const u = new URL(link);
          const segment = decodeURIComponent((u.pathname.split("/").filter(Boolean).pop() || "")).trim();
          if (segment && !/youtube\.com$|youtu\.be$/.test(u.hostname)) return segment;
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
