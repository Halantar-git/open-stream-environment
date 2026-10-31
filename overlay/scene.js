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

(function () {
  const { EVENT_TYPES } = window.SharedEvents;
  const { ICONS } = window.SharedIcons;
  const t = (key, params) => (window.I18n ? window.I18n.t(key, params) : key);

  const params = new URLSearchParams(location.search);
  const sceneType = params.get("type") || "brb";
  const isTalk = sceneType === "talk";
  // «Разговор» и «Гости» — чистый холст: карточку с заголовком не показываем,
  // всё оформление ставят виджеты на канвасе сцены.
  const isCanvasOnly = isTalk || sceneType === "guests";
  const isPause = sceneType === "pause";

  let recentEvents = [];
  let topDonation = { user: "", amount: 0, currency: "RUB" };
  let doneText = "";
  let activeScene = null;
  let sceneStartedAt = null;
  let currentScene = null;
  let ws = null;

  const sceneTimer = window.SceneTimer.createSceneTimer();

  const els = {
    statusLabel: document.getElementById("statusLabel"),
    title: document.getElementById("sceneTitle"),
    subtitle: document.getElementById("sceneSubtitle"),
    timerBox: document.getElementById("timerBox"),
    timerDisplay: document.getElementById("timerDisplay"),
    timerProgress: document.getElementById("timerProgress"),
    eventsGrid: document.getElementById("eventsGrid"),
    evFollower: document.getElementById("evFollower"),
    evSubscriber: document.getElementById("evSubscriber"),
    evTopDonation: document.getElementById("evTopDonation"),
    socialsFooter: document.getElementById("socialsFooter"),
    sceneCard: document.querySelector(".scene-card"),
  };

  const sceneBackground = window.SceneBackground
    ? window.SceneBackground.create(document.querySelector(".scene-wrapper"))
    : null;

  document.querySelectorAll(".event-icon[data-icon]").forEach((el) => {
    el.innerHTML = ICONS[el.dataset.icon] || "";
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function formatMoney(n) {
    const locale = (window.I18n && window.I18n.getLang() === "ru") ? "ru-RU" : "en-US";
    return Number(n || 0).toLocaleString(locale);
  }
  const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", UAH: "₴", KZT: "₸", GBP: "£" };
  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || code || "";
  }

  function applyTheme(appearance) {
    if (!appearance || !appearance.tokens) return;
    const root = document.documentElement;
    Object.entries(appearance.tokens).forEach(([k, v]) => root.style.setProperty(k, v));
    document.body.dataset.decoration = appearance.tokens["--panel-decoration"] || "none";
    document.body.dataset.theme = appearance.activeThemeId || "";
  }

  // Scene content lives in config as editable text, but its defaults come from
  // the (Russian) catalog. Localize the default values, but keep any user edits.
  function localizedField(field, value) {
    const defaults = window.SceneCatalog ? window.SceneCatalog.defaultScenes()[sceneType] : null;
    const def = defaults ? defaults[field] : undefined;
    if (value === undefined || value === null || value === "" || value === def) {
      return t("sceneContent." + sceneType + "." + field);
    }
    return value;
  }

  function renderSceneText(scene) {
    els.statusLabel.textContent = localizedField("statusLabel", scene.statusLabel);
    els.title.textContent = localizedField("title", scene.title);
    els.subtitle.textContent = localizedField("subtitle", scene.subtitle);
  }

  function renderScene(scene) {
    if (!scene) return;
    currentScene = scene;
    if (sceneBackground) sceneBackground.apply(scene);
    renderSceneText(scene);

    if (isPause) {
      renderPause();
      return;
    }

    if (isCanvasOnly) {
      els.sceneCard.hidden = true;
      sceneTimer.stop();
      return;
    }

    els.sceneCard.hidden = false;
    els.eventsGrid.hidden = !scene.showEvents;
    els.socialsFooter.hidden = !scene.showSocials;
    els.timerBox.hidden = !scene.showTimer;

    renderSocials(scene.socials || []);
    renderEvents();

    applyTimer(scene);
  }

  function renderSocials(socials) {
    els.socialsFooter.innerHTML = socials
      .map((s) => `<div class="social-pill"><span class="pill-icon">${escapeHtml(s.platform)}</span><span class="pill-text">${escapeHtml(s.text)}</span></div>`)
      .join("");
  }

  function renderPause() {
    els.sceneCard.hidden = true;
    els.eventsGrid.hidden = true;
    els.socialsFooter.hidden = true;
    els.timerBox.hidden = true;
    sceneTimer.stop();
  }

  function renderEvents() {
    const follow = recentEvents.find((e) => e.kind === "follow");
    const sub = recentEvents.find((e) => e.kind === "sub" || e.kind === "gift_sub");
    els.evFollower.textContent = follow ? follow.user : t("scene.notYet");
    els.evSubscriber.textContent = sub ? sub.user : t("scene.notYet");
    els.evTopDonation.textContent = topDonation.amount > 0 ? `${topDonation.user} (${formatMoney(topDonation.amount)} ${currencySymbol(topDonation.currency)})` : t("scene.notYet");
  }

  // Обратный отсчёт привязан к моменту активации сцены (sceneStartedAt), а не к
  // загрузке страницы: перезагрузка/реконнект OBS-источника не сбрасывает таймер,
  // а обычные обновления STATE / SCENES_UPDATE его не перезапускают. Отсчёт идёт
  // только пока сцена активна; в остальных случаях показывается полная длительность.
  function applyTimer(scene) {
    doneText = localizedField("timerDoneText", scene.timerDoneText);
    sceneTimer.apply(
      {
        showTimer: scene.showTimer,
        duration: scene.timerDuration,
        isActive: activeScene === sceneType,
        startedAt: sceneStartedAt,
      },
      (state) => {
        updateTimerDisplay(state.timeLeft, state.totalDuration);
        // renderSceneText() уже сбросил подзаголовок — возвращаем текст окончания.
        if (state.finished && doneText) els.subtitle.textContent = doneText;
      }
    );
  }

  function updateTimerDisplay(timeLeft, totalDuration) {
    if (!els.timerDisplay) return;
    const m = Math.floor(timeLeft / 60);
    const s = timeLeft % 60;
    els.timerDisplay.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    const pct = totalDuration ? (timeLeft / totalDuration) * 100 : 0;
    els.timerProgress.style.width = pct + "%";
  }

  function handleMessage(msg) {
    // Раскладка виджетов сцены работает на том же потоке, что и её
    // собственное оформление: канвас сам обновляет состояние и шину.
    if (window.SceneCanvas) window.SceneCanvas.handleMessage(msg);
    switch (msg.type) {
      case EVENT_TYPES.STATE:
        if (window.TwitchEmotes && window.TwitchEmotes.configure) {
          window.TwitchEmotes.configure({
            channel: msg.payload.twitchChannel,
            channelId: msg.payload.twitchBroadcasterId,
          });
        }
        applyTheme(msg.payload.appearance);
        recentEvents = msg.payload.recentEvents || [];
        topDonation = msg.payload.topDonation || topDonation;
        if (typeof msg.payload.activeScene === "string") activeScene = msg.payload.activeScene;
        sceneStartedAt = typeof msg.payload.sceneStartedAt === "number" ? msg.payload.sceneStartedAt : null;
        renderScene(msg.payload.scenes && msg.payload.scenes[sceneType]);
        // Первое состояние пришло — тема и содержимое на месте, можно
        // показывать страницу (см. `body.is-pending` в scene.css).
        document.body.classList.remove("is-pending");
        break;
      case EVENT_TYPES.REMOTE_ACTION: {
        const action = msg.payload && msg.payload.action;
        const payload = (msg.payload && msg.payload.payload) || {};
        if (action === "SCENE_SET") {
          if (typeof payload.scene === "string") activeScene = payload.scene;
          if (typeof payload.startedAt === "number") sceneStartedAt = payload.startedAt;
          if (currentScene) renderScene(currentScene);
        }
        break;
      }
      case EVENT_TYPES.THEME_UPDATE:
        applyTheme(msg.payload);
        break;
      case EVENT_TYPES.SCENES_UPDATE:
        renderScene(msg.payload[sceneType]);
        break;
      case EVENT_TYPES.RECENT_EVENT:
        recentEvents = [msg.payload, ...recentEvents].slice(0, 15);
        renderEvents();
        break;
      case EVENT_TYPES.TOP_DONATION_UPDATE:
        topDonation = msg.payload;
        renderEvents();
        break;
      case EVENT_TYPES.LOCALES:
        if (window.I18n) {
          window.I18n.setLocales(msg.payload && msg.payload.locales);
          window.I18n.setLang(msg.payload && msg.payload.lang);
          window.I18n.apply();
        }
        if (currentScene) renderScene(currentScene);
        renderEvents();
        break;
      default:
        break;
    }
  }

  function send(type, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?role=scene`);
    // Кадры камеры приходят бинарно: сцены получают тот же поток, что оверлей.
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        if (window.SceneCanvas) window.SceneCanvas.handleBinary(ev.data);
        return;
      }
      try {
        handleMessage(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws.close();
  }

  if (window.SceneCanvas) window.SceneCanvas.init(sceneType, send);
  // Пакеты виджетов должны быть загружены до первого снимка раскладки:
  // иначе сцена получит тип, класса которого ещё нет.
  if (window.OSE) window.OSE.load().then(connect, connect);
  else connect();
})();
