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
  DonateX music widget: one line with the title of the track attached to a
  donation. There is no cover, requester or progress — the DonateX music page
  owns the sound and the queue, and the strip only names the song. While there
  is no music the strip is hidden entirely.

  Donations can arrive back to back, so tracks wait in a queue instead of
  cutting each other off. If the link is not a direct audio file, the widget
  keeps the title for a simulated duration and only then takes the next track.
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

  class MusicWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-music";
      this.element.appendChild(this.host);

      this._audio = null;
      this._simTimer = null;
      this._donatexFrame = null;
      this._donatexUrl = "";
      this.current = null;
      this.queue = [];
      this.el = {};

      this.buildDom();
      this._applyPerspective();
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
      });
      this.renderIdle();
    }

    onUnmount() {
      this.stopPlayback();
      this.removeDonatexWidget();
      this.current = null;
      this.queue.length = 0;
    }

    onUpdate(prev, next) {
      // Очередь выключили — ждущие треки больше не нужны.
      if (this.config.queue === false && this.queue.length) this.queue.length = 0;
      this.syncDonatexWidget();
      if (
        prev.perspective !== next.perspective ||
        prev.perspectiveDirection !== next.perspectiveDirection
      ) {
        this._applyPerspective();
      }
      // Смена темы меняет набор 3D-виджетов, а с ним и плавность.
      this._syncMotion();
      // Со ссылкой на виджет DonateX трек играет их страница: свой звук и
      // таймер выключаем, а строку дальше ведёт опрос текущего трека.
      if (this.donatexWidgetUrl() && this.current) this.showTrack(this.current);
      if (this._audio) this._audio.volume = clamp01(this.config.volume, 1);
      if (this.current) this.renderMeta(this.current);
    }

    // Наклон как у остальных виджетов: `perspective` 0–100 и направление,
    // в какую сторону уходит дальний край.
    _applyPerspective() {
      this._syncMotion();
      const value = Math.max(0, Math.min(100, Number(this.config.perspective) || 0));
      if (!value) {
        this._setTilt("");
        return;
      }
      const magnitude = value * 0.15;
      const direction = this.config.perspectiveDirection || "left";
      let ry = -magnitude;
      let rx = magnitude * 0.2;
      if (direction === "right") {
        ry = magnitude;
      } else if (direction === "up") {
        ry = 0;
        rx = magnitude;
      } else if (direction === "down") {
        ry = 0;
        rx = -magnitude;
      }
      this._setTilt(`perspective(1200px) rotateY(${ry}deg) rotateX(${rx}deg)`);
    }

    /// Плавные появление и исчезновение — только в 3D-режиме темы или при
    /// включённом наклоне: там виджет уже живёт в объёме, и рывок заметен.
    /// Плоская строка, как и остальные 2D-виджеты, появляется мгновенно.
    _syncMotion() {
      const value = Math.max(0, Math.min(100, Number(this.config.perspective) || 0));
      this.host.classList.toggle("is-motion", value > 0 || this.context.enable3d === true);
    }

    onAlert(alert) {
      if (!alert || alert.kind !== "donation") return;
      const musicLink = webUrl(alert.musicLink);
      if (!musicLink) return;
      const track = { musicLink, musicTitle: alert.musicTitle };
      // С подключённым виджетом DonateX очередь у сервиса: свой плеер не
      // запускаем и в очередь не ставим, но строку показываем сразу, чтобы
      // не ждать опроса. Дальше её удержит или погасит опрос текущего трека.
      if (this.donatexWidgetUrl()) {
        this.showTrack(track);
        return;
      }
      if (this.current && this.queueEnabled()) {
        this.queue.push(track);
        return;
      }
      this.play(track);
    }

    // Ссылка из инспектора: проверка виджета, а не событие стрима — суммы и
    // имени нет, звучит сразу и не встаёт в очередь.
    onMusicPlay(payload) {
      const musicLink = webUrl(payload && payload.musicLink);
      if (!musicLink) return;
      const track = {
        musicLink,
        musicTitle: (payload && payload.musicTitle) || "",
      };
      // `silent` — трек уже звучит на странице DonateX, и опрос сообщает только
      // о смене. Свой плеер трогать нельзя: иначе трек зазвучал бы дважды, а
      // таймер симуляции погасил бы карточку посреди трека.
      if (payload && payload.silent) this.showTrack(track);
      else this.play(track);
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

      // В кадре — одна строка с названием трека: обложка, заказчик и
      // прогресс только отвлекали от игры, а очередь и звук всё равно
      // остаются у страницы DonateX. Слева — эквалайзер в цвете темы.
      const orbital = el("div", "orbital");
      const badge = el("span", "orbital__badge");
      badge.setAttribute("aria-hidden", "true");
      badge.innerHTML = "<i></i><i></i><i></i>";
      orbital.appendChild(badge);
      const track = el("div", "orbital__track");
      const text = el("span", "orbital__track-text");
      track.appendChild(text);
      orbital.appendChild(track);
      this.host.appendChild(orbital);

      this.el = { trackTexts: [text] };
    }

    // ---- страница музыкального виджета DonateX ----

    /// Адрес их виджета из кабинета: только он делает виджет «подключённым».
    /// Проверяем жёстко — в iframe попадает только страница DonateX, а не
    /// произвольный адрес из настроек.
    donatexWidgetUrl() {
      const widgets =
        (this.context.state && this.context.state.donatex && this.context.state.donatex.widgets) || {};
      // Настройка важнее старого поля в раскладке: ссылка переехала туда.
      const raw = String(widgets.music || this.config.donatexWidgetUrl || "").trim();
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

    // Показать трек, который уже играет чужая страница: без звука и без
    // таймера. Громкость и очередь у DonateX, поэтому строка живёт до
    // `music_control: stop` от опроса.
    showTrack(info) {
      this.stopAudio();
      this.clearSimTimer();
      this.current = info;
      this.host.classList.add("is-playing");
      this.renderMeta(info);
    }

    applyPlaying(info) {
      this.renderMeta(info);
    }

    renderMeta(info) {
      this.el.trackTexts.forEach((span) => (span.textContent = this.trackTitle(info)));
      this.show();
    }

    renderIdle() {
      this.el.trackTexts.forEach((span) => (span.textContent = ""));
      this.hide();
    }

    /// Музыки нет — строки в кадре тоже нет. Прячем только плашку: скрытая
    /// страница DonateX должна остаться в документе, иначе сервис сочтёт
    /// виджет отключённым и перестанет играть.
    hide() {
      this.host.classList.add("is-empty");
    }

    show() {
      this.host.classList.remove("is-empty");
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

      const started = audio.play();
      if (started && typeof started.catch === "function") {
        started.catch(() => {
          if (this._audio === audio) this.scheduleSimulatedStop();
        });
      }
    }

    /// Ссылка может быть страницей YouTube: звука из неё не будет, поэтому
    /// показываем трек тот же отрезок времени и идём дальше.
    scheduleSimulatedStop() {
      this.clearSimTimer();
      this._simTimer = this.later(() => {
        this._simTimer = null;
        if (!this.host.classList.contains("is-playing")) return;
        this.idle();
      }, SIMULATED_PLAY_MS);
    }

    clearSimTimer() {
      if (!this._simTimer) return;
      this.clearTimer(this._simTimer);
      this._simTimer = null;
    }

    idle() {
      this.stopAudio();
      this.clearSimTimer();
      this.host.classList.remove("is-playing");
      this.current = null;
      if (this.queue.length) {
        this.play(this.queue.shift());
        return;
      }
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

    render() {}
  }

  return MusicWidget;
});
