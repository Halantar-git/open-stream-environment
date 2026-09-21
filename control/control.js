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
  Control panel entry point.

  Orchestrates the ES modules under ./modules and keeps the view logic that
  is not a standalone concern: settings, events history, scenes, themes,
  giveaway, export/import and the WebSocket message router.
 */

import { initLoggerPanel } from "./modules/logger-panel.js";
import { initHelpPanel } from "./modules/help-panel.js";
import { initDebugPanel } from "./modules/debug-panel.js";
import { initDonationAlertsPanel } from "./modules/donationalerts-panel.js";
import { initWsClient } from "./modules/ws-client.js";
import { createStateManager } from "./modules/state-manager.js";
import { initPropertiesPanel } from "./modules/properties-panel.js";
import { initCanvasEditor } from "./modules/canvas-editor.js";

const { EVENT_TYPES } = window.SharedEvents;
  const MicFrame = window.MicFrame;
  const { ICONS } = window.SharedIcons;
  const { safeCssColor, createCaptureGeneration } = window.ControlGuards;
  const { WIDGET_TYPES, widgetsForTheme, themeAllowsWidget, replacedBy3d, widgetRole, resolveTypeForTheme, isAnimatedWidget } = window.WidgetCatalog;
  const t = (key, params) => (window.I18n ? window.I18n.t(key, params) : key);

  const params = new URLSearchParams(location.search);
  let port = params.get("port") || "8710";
  const appVersion = params.get("version") || "";
  let overlayUrl = `http://localhost:${port}/overlay/overlay.html`;
  function resolveMediaUrl(p) {
    if (!p) return "";
    if (/^(https?:)?\/\//i.test(p) || p.startsWith("data:")) return p;
    return `http://localhost:${port}/${String(p).replace(/^\/+/, "")}`;
  }

  const resolveWsUrl = async () => {
    const info = await window.desktop?.getInfo();
    if (!info || !info.port) return null;
    return `ws://localhost:${info.port}/ws`;
  };

  const wsClient = initWsClient({ url: `ws://localhost:${port}/ws`, role: "control", t, onMessage: handleMessage, onStatusClick, resolveUrl: resolveWsUrl });
  const send = wsClient.send;
  const sendBinary = wsClient.sendBinary;

  // ---- state ----
  const state = createStateManager();

  let ttsVoices = [];
  let notificationSoundQueue = [];
  let notificationSoundPlaying = false;

  // ---- dom refs ----
  const tabsEl = document.getElementById("tabs");
  const viewEditor = document.getElementById("view-editor");
  const viewScenes = document.getElementById("view-scenes");
  const viewSplashes = document.getElementById("view-splashes");
  const viewSettings = document.getElementById("view-settings");
  const libraryListEl = document.getElementById("libraryList");
  const widgetTooltip = document.getElementById("widgetTooltip");
  const obsUrlLabel = document.getElementById("obsUrlLabel");
  const copyUrlBtn = document.getElementById("copyUrlBtn");
  const appVersionEl = document.getElementById("appVersion");
  const updateMenu = document.getElementById("updateMenu");
  const updateMenuInstallBtn = document.getElementById("updateMenuInstallBtn");
  const updateMenuLaterBtn = document.getElementById("updateMenuLaterBtn");
  let knownUpdateVersion = null;

  function renderAppVersion() {
    if (!appVersionEl) return;
    if (knownUpdateVersion) {
      appVersionEl.textContent = t("settings.updateNow");
      appVersionEl.title = t("settings.updateAvailable", { version: knownUpdateVersion });
    } else {
      appVersionEl.textContent = appVersion ? `v${appVersion}` : "";
      appVersionEl.title = "";
      setUpdateMenu(false);
    }
    appVersionEl.classList.toggle("has-update", !!knownUpdateVersion);
  }

  function applyKnownUpdate(version) {
    knownUpdateVersion = version || null;
    renderAppVersion();
    renderUpdateCheckButton();
  }

  function setUpdateMenu(open) {
    if (!updateMenu) return;
    updateMenu.hidden = !open;
  }

  function toggleUpdateMenu() {
    if (!updateMenu) return;
    setUpdateMenu(updateMenu.hidden);
  }

  if (appVersionEl) {
    appVersionEl.addEventListener("click", () => {
      if (!knownUpdateVersion) return;
      toggleUpdateMenu();
    });
  }

  if (updateMenuInstallBtn) {
    updateMenuInstallBtn.addEventListener("click", () => {
      setUpdateMenu(false);
      if (window.desktop && window.desktop.downloadAndInstall) {
        window.desktop.downloadAndInstall();
      }
    });
  }

  if (updateMenuLaterBtn) {
    updateMenuLaterBtn.addEventListener("click", () => setUpdateMenu(false));
  }

  // Закрываем меню по клику вне его (или по клику на саму кнопку версии).
  document.addEventListener("click", (e) => {
    if (!updateMenu || updateMenu.hidden) return;
    if (appVersionEl && appVersionEl.contains(e.target)) return;
    if (updateMenu.contains(e.target)) return;
    setUpdateMenu(false);
  });

  renderAppVersion();
  const statusFabStack = document.getElementById("statusFabStack");
  const checkUpdatesBtn = document.getElementById("checkUpdatesBtn");
  const checkUpdatesStatus = document.getElementById("checkUpdatesStatus");
  const remoteUrlHint = document.getElementById("remoteUrlHint");
  const remoteUrlText = document.getElementById("remoteUrlText");
  const alertToasts = document.getElementById("alertToasts");
  const gridSizeSelect = document.getElementById("gridSizeSelect");
  const aspectRatioSelect = document.getElementById("aspectRatioSelect");
  const layoutPresetSelect = document.getElementById("layoutPresetSelect");
  const layoutPresetName = document.getElementById("layoutPresetName");
  const saveLayoutPresetBtn = document.getElementById("saveLayoutPresetBtn");
  const deleteLayoutPresetBtn = document.getElementById("deleteLayoutPresetBtn");
  const sceneBudgetEl = document.getElementById("sceneBudget");
  const themeGridEl = document.getElementById("themeGrid");
  const newThemeBtn = document.getElementById("newThemeBtn");
  const importThemeBtn = document.getElementById("importThemeBtn");
  const exportConfigBtn = document.getElementById("exportConfigBtn");
  const importConfigBtn = document.getElementById("importConfigBtn");
  const exportImportStatus = document.getElementById("exportImportStatus");
  const scenesNavListEl = document.getElementById("scenesNavList");
  const scenesPreviewFrame = document.getElementById("scenesPreviewFrame");
  const sceneUrlLabel = document.getElementById("sceneUrlLabel");
  const copySceneUrlBtn = document.getElementById("copySceneUrlBtn");
  const sceneFormTitle = document.getElementById("sceneFormTitle");
  const sceneFormEl = document.getElementById("sceneForm");

  const twitchChannelInput = document.getElementById("twitchChannel");
  const twitchClientIdInput = document.getElementById("twitchClientId");
  const twitchClientSecretInput = document.getElementById("twitchClientSecret");
  const twitchRedirectUriEl = document.getElementById("twitchRedirectUri");
  const daClientIdInput = document.getElementById("daClientId");
  const daClientSecretInput = document.getElementById("daClientSecret");
  const daRedirectUriEl = document.getElementById("daRedirectUri");
  const youtubeClientIdInput = document.getElementById("youtubeClientId");
  const youtubeClientSecretInput = document.getElementById("youtubeClientSecret");
  const youtubeRedirectUriEl = document.getElementById("youtubeRedirectUri");
  const youtubeVideoIdInput = document.getElementById("youtubeVideoId");
  const twitchEnabledSwitch = document.getElementById("twitchEnabledSwitch");
  const donationAlertsEnabledSwitch = document.getElementById("donationAlertsEnabledSwitch");
  const youtubeEnabledSwitch = document.getElementById("youtubeEnabledSwitch");
  const obsEnabledSwitch = document.getElementById("obsEnabledSwitch");
  const obsHostInput = document.getElementById("obsHost");
  const obsPortInput = document.getElementById("obsPort");
  const obsPasswordInput = document.getElementById("obsPassword");
  const obsPasswordClearBtn = document.getElementById("obsPasswordClearBtn");
  const obsWebcamSourceInput = document.getElementById("obsWebcamSource");
  const obsMicSourceInput = document.getElementById("obsMicSource");
  const obsSceneMainInput = document.getElementById("obsSceneMain");
  const obsSceneStartInput = document.getElementById("obsSceneStart");
  const obsSceneBrbInput = document.getElementById("obsSceneBrb");
  const obsSceneTalkInput = document.getElementById("obsSceneTalk");
  const obsSceneEndInput = document.getElementById("obsSceneEnd");
  const obsSceneWheelInput = document.getElementById("obsSceneWheel");
  const obsSceneVideoInput = document.getElementById("obsSceneVideo");
  const obsScenePollInput = document.getElementById("obsScenePoll");
  const obsScenePauseInput = document.getElementById("obsScenePause");
  const splashSettingsFormEl = document.getElementById("splashSettingsForm");
  const obsCommandsList = document.getElementById("obsCommandsList");
  const addObsCommandBtn = document.getElementById("addObsCommandBtn");
  const cameraAnglesList = document.getElementById("cameraAnglesList");
  const addCameraAngleBtn = document.getElementById("addCameraAngleBtn");
  const cameraFiltersList = document.getElementById("cameraFiltersList");
  const addCameraFilterBtn = document.getElementById("addCameraFilterBtn");
  const soundboardEnabledSwitch = document.getElementById("soundboardEnabledSwitch");
  const soundboardVolume = document.getElementById("soundboardVolume");
  const soundboardVolumeValue = document.getElementById("soundboardVolumeValue");
  const soundboardQueueSwitch = document.getElementById("soundboardQueueSwitch");
  const notificationSoundSwitch = document.getElementById("notificationSoundSwitch");
  const notificationVolume = document.getElementById("notificationVolume");
  const notificationVolumeValue = document.getElementById("notificationVolumeValue");
  const notificationRepeats = document.getElementById("notificationRepeats");
  const ttsEnabledSwitch = document.getElementById("ttsEnabledSwitch");
  const ttsVolume = document.getElementById("ttsVolume");
  const ttsVolumeValue = document.getElementById("ttsVolumeValue");
  const ttsRate = document.getElementById("ttsRate");
  const ttsRateValue = document.getElementById("ttsRateValue");
  const ttsLang = document.getElementById("ttsLang");
  const ttsVoice = document.getElementById("ttsVoice");
  const ttsTestBtn = document.getElementById("ttsTestBtn");
  const daVoiceSwitch = document.getElementById("daVoiceSwitch");
  const soundboardList = document.getElementById("soundboardList");
  const addSoundBtn = document.getElementById("addSoundBtn");
  const twitchRewardsList = document.getElementById("twitchRewardsList");
  const addRewardBtn = document.getElementById("addRewardBtn");
  const createClipBtn = document.getElementById("createClipBtn");
  const createMarkerBtn = document.getElementById("createMarkerBtn");
  const chatBotEnabledSwitch = document.getElementById("chatBotEnabledSwitch");
  const chatBotPrefixInput = document.getElementById("chatBotPrefix");
  const chatBotCommandsList = document.getElementById("chatBotCommandsList");
  const addChatBotCommandBtn = document.getElementById("addChatBotCommandBtn");
  const chatBotTimersList = document.getElementById("chatBotTimersList");
  const addChatBotTimerBtn = document.getElementById("addChatBotTimerBtn");
  const moderationEnabledSwitch = document.getElementById("moderationEnabledSwitch");
  const moderationLinkProtectionSwitch = document.getElementById("moderationLinkProtectionSwitch");
  const moderationWhitelistInput = document.getElementById("moderationWhitelistInput");
  const moderationBadWordsInput = document.getElementById("moderationBadWordsInput");
  const moderationCapsThreshold = document.getElementById("moderationCapsThreshold");
  const moderationMaxEmotes = document.getElementById("moderationMaxEmotes");
  const moderationMaxWarns = document.getElementById("moderationMaxWarns");
  const moderationWarnTimeoutSec = document.getElementById("moderationWarnTimeoutSec");
  const streamdeckIconStart = document.getElementById("streamdeckIconStart");
  const streamdeckIconBrb = document.getElementById("streamdeckIconBrb");
  const streamdeckIconWheel = document.getElementById("streamdeckIconWheel");
  const streamdeckIconTalk = document.getElementById("streamdeckIconTalk");
  const streamdeckIconMain = document.getElementById("streamdeckIconMain");
  const streamdeckIconEnd = document.getElementById("streamdeckIconEnd");
  const streamdeckIconPause = document.getElementById("streamdeckIconPause");
  const appPortInput = document.getElementById("appPort");
  const savePortBtn = document.getElementById("savePortBtn");
  const appOverlayUrlInput = document.getElementById("appOverlayUrl");
  const copyOverlayUrlBtn = document.getElementById("copyOverlayUrlBtn");
  const hudHotkeyInput = document.getElementById("hudHotkeyInput");
  const saveHudHotkeyBtn = document.getElementById("saveHudHotkeyBtn");
  const hudDisplaySelect = document.getElementById("hudDisplaySelect");
  const refreshDisplaysBtn = document.getElementById("refreshDisplaysBtn");
  const toggleChatHudBtn = document.getElementById("toggleChatHudBtn");
  const chatHudHotkeyInput = document.getElementById("chatHudHotkeyInput");
  const saveChatHudHotkeyBtn = document.getElementById("saveChatHudHotkeyBtn");
  const chatHudDisplaySelect = document.getElementById("chatHudDisplaySelect");
  const refreshChatHudDisplaysBtn = document.getElementById("refreshChatHudDisplaysBtn");
  const chatHudWidth = document.getElementById("chatHudWidth");
  const chatHudHeight = document.getElementById("chatHudHeight");
  const chatHudX = document.getElementById("chatHudX");
  const chatHudY = document.getElementById("chatHudY");
  const chatHudOpacity = document.getElementById("chatHudOpacity");
  const chatHudOpacityValue = document.getElementById("chatHudOpacityValue");
  const chatHudFontSize = document.getElementById("chatHudFontSize");
  const chatHudFontSizeValue = document.getElementById("chatHudFontSizeValue");
  const eventsHistoryEl = document.getElementById("eventsHistory");
  const refreshEventsBtn = document.getElementById("refreshEventsBtn");
  const loadMoreEventsBtn = document.getElementById("loadMoreEventsBtn");
  const eventsFiltersEl = document.getElementById("eventsFilters");
  const eventsSearchInput = document.getElementById("eventsSearch");
  const clearEventsBtn = document.getElementById("clearEventsBtn");
  const eventsMetaEl = document.getElementById("eventsMeta");
  const historyTabsEl = document.getElementById("historyTabs");
  const sessionsBodyEl = document.getElementById("sessionsBody");
  const sessionsMetaEl = document.getElementById("sessionsMeta");
  const refreshSessionsBtn = document.getElementById("refreshSessionsBtn");
  const clearSessionsBtn = document.getElementById("clearSessionsBtn");
  const chatHistoryEl = document.getElementById("chatHistory");
  const chatMetaEl = document.getElementById("chatMeta");
  const chatSearchInput = document.getElementById("chatSearch");
  const refreshChatBtn = document.getElementById("refreshChatBtn");
  const clearChatBtn = document.getElementById("clearChatBtn");
  const loadMoreChatBtn = document.getElementById("loadMoreChatBtn");
  const eventsExportFormat = document.getElementById("eventsExportFormat");
  const exportEventsBtn = document.getElementById("exportEventsBtn");
  const deleteEventsBtn = document.getElementById("deleteEventsBtn");
  const dataStatsEl = document.getElementById("dataStats");
  const dataBackupsEl = document.getElementById("dataBackups");
  const accessRemoteUrlEl = document.getElementById("accessRemoteUrl");
  const copyAccessUrlBtn = document.getElementById("copyAccessUrlBtn");
  const rotateAccessCodeBtn = document.getElementById("rotateAccessCodeBtn");
  const accessStatusEl = document.getElementById("accessStatus");
  const chatHistorySwitch = document.getElementById("chatHistorySwitch");
  const historyLimitInput = document.getElementById("historyLimitInput");
  const saveHistoryLimitBtn = document.getElementById("saveHistoryLimitBtn");
  const dataClearScope = document.getElementById("dataClearScope");
  const dataClearBtn = document.getElementById("dataClearBtn");
  const openDataFolderBtn = document.getElementById("openDataFolderBtn");
  const supportBundleBtn = document.getElementById("supportBundleBtn");
  const resetDbBtn = document.getElementById("resetDbBtn");
  const dataStatusEl = document.getElementById("dataStatus");
  const wheelPanelEl = document.getElementById("wheelPanel");
  const wheelPanelBody = document.getElementById("wheelPanelBody");
  const participantsPanelEl = document.getElementById("participantsPanel");
  const participantsPanelBody = document.getElementById("participantsPanelBody");
  const participantsSearchInput = document.getElementById("participantsSearch");
  const clearParticipantsBtn = document.getElementById("clearParticipantsBtn");
  const toggleWheelBtn = document.getElementById("toggleWheelBtn");
  const wheelCloseBtn = document.getElementById("wheelCloseBtn");
  const pollPanelEl = document.getElementById("pollPanel");
  const pollPanelBody = document.getElementById("pollPanelBody");
  const pollOptionsPanelEl = document.getElementById("pollOptionsPanel");
  const pollOptionsPanelBody = document.getElementById("pollOptionsPanelBody");
  const togglePollBtn = document.getElementById("togglePollBtn");
  const pollCloseBtn = document.getElementById("pollCloseBtn");

  // ---- helpers ----
  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
  function round1(n) { return Math.round(n * 10) / 10; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }
  function formatMoney(n) { return Number(n || 0).toLocaleString("ru-RU"); }
  const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", UAH: "₴", KZT: "₸", GBP: "£" };
  function currencySymbol(code) { return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || code || ""; }
  function alertToastTitle(kind, event) {
    if (kind === "gift_sub") return t("alert.giftSub", { count: event.count ?? event.amount ?? 1 });
    const key = "alert." + kind;
    const label = t(key);
    return label === key ? String(kind) : label;
  }
  function showAlertToast(event) {
    if (!event || !event.kind || !alertToasts) return;
    const kind = event.kind;

    const parts = [];
    if (event.user) parts.push(event.user);
    if (kind === "donation" && typeof event.amount === "number") {
      parts.push(`${formatMoney(event.amount)} ${currencySymbol(event.currency)}`);
    } else if (kind === "cheer" && typeof event.amount === "number") {
      parts.push(t("alert.cheerBits", { amount: event.amount }));
    }
    const body = parts.join(" · ");

    showToast(alertToastTitle(kind, event), body, kind);
  }
  function showToast(title, body, kind) {
    if (!alertToasts) return;
    const toast = document.createElement("div");
    toast.className = "alert-toast";
    toast.setAttribute("data-kind", kind || "");
    toast.innerHTML = `<span class="alert-toast__dot"></span><span class="alert-toast__content"><span class="alert-toast__title">${escapeHtml(title)}</span>${body ? `<span class="alert-toast__body">${escapeHtml(body)}</span>` : ""}</span>`;
    alertToasts.prepend(toast);

    while (alertToasts.children.length > 5) alertToasts.removeChild(alertToasts.lastChild);

    setTimeout(() => {
      toast.classList.add("is-leaving");
      setTimeout(() => toast.remove(), 240);
    }, 5000);
  }
  function playNotificationSound() {
    const repeats = Math.min(5, Math.max(1, Number(state.notificationRepeats ?? 1) || 1));
    for (let i = 0; i < repeats; i++) notificationSoundQueue.push(true);
    drainNotificationSoundQueue();
  }

  function drainNotificationSoundQueue() {
    if (notificationSoundPlaying) return;
    if (!notificationSoundQueue.length) return;

    notificationSoundQueue.shift();
    notificationSoundPlaying = true;

    const finish = () => {
      notificationSoundPlaying = false;
      drainNotificationSoundQueue();
    };

    try {
      const a = new Audio(`http://localhost:${port}/assets/audio/buzzer.wav`);
      a.volume = Math.min(1, Math.max(0, Number(state.notificationVolume ?? 0.8)));
      let done = false;
      const once = () => {
        if (done) return;
        done = true;
        finish();
      };
      a.addEventListener("ended", once);
      // Фолбэк на случай, если `ended` не придёт (например, проблемы с декодом).
      setTimeout(once, 2000);
      const p = a.play();
      if (p && p.catch) p.catch(once);
    } catch {
      /* звук — необязательный */
      finish();
    }
  }
  function switchHtml(id, on) {
    return `<div class="md-switch${on ? " is-on" : ""}" id="${id}"><div class="md-switch__thumb"></div></div>`;
  }
  function wireSwitch(el, cb) {
    if (!el) return;
    el.addEventListener("click", () => {
      const now = !el.classList.contains("is-on");
      el.classList.toggle("is-on", now);
      cb(now);
    });
  }

  // ---- tabs ----
  function setActiveTab(view) {
    tabsEl.querySelectorAll(".topbar__tab").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.view === view);
    });
  }

  function switchView(view) {
    // «Колесо» — ярлык: открывает сцену колеса внутри раздела «Сцены».
    const isWheel = view === "wheel";
    const targetView = isWheel ? "scenes" : view;
    setActiveTab(view);
    viewEditor.hidden = targetView !== "editor";
    viewScenes.hidden = targetView !== "scenes";
    viewSplashes.hidden = targetView !== "splashes";
    viewSettings.hidden = targetView !== "settings";
    if (statusFabStack) {
      statusFabStack.style.display = targetView === "settings" || targetView === "splashes" ? "none" : "";
    }
    if (isWheel) selectScene("wheel");
    if (targetView === "settings") renderStreamEvents();
  }

  tabsEl.querySelectorAll(".topbar__tab").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // ---- status FAB → jump to the matching settings card ----
  function onStatusClick(service) {
    const cardId =
      ({ twitchChat: "settingsCardTwitch", twitchEvents: "settingsCardTwitch", donationAlerts: "settingsCardDonationAlerts", youtube: "settingsCardYoutube", obs: "settingsCardObs" })[service];
    switchView("settings");
    const card = cardId && document.getElementById(cardId);
    if (card) {
      card.classList.add("is-flash");
      requestAnimationFrame(() => card.scrollIntoView({ behavior: "smooth", block: "start" }));
      setTimeout(() => card.classList.remove("is-flash"), 1200);
    }
  }

  // ---- library rail ----
  function hideWidgetTooltip() {
    if (widgetTooltip) widgetTooltip.hidden = true;
  }

  function showWidgetTooltip(card, def) {
    if (!widgetTooltip) return;
    widgetTooltip.innerHTML = `
      <span class="widget-tooltip__label">${escapeHtml(t("widgets." + def.type))}</span>
      <span class="widget-tooltip__desc">${escapeHtml(t("widgets." + def.type + "Desc"))}</span>`;
    widgetTooltip.hidden = false;
    const rect = card.getBoundingClientRect();
    const gap = 10;
    const tw = widgetTooltip.offsetWidth;
    const th = widgetTooltip.offsetHeight;
    let left = rect.right + gap;
    let top = rect.top;
    if (left + tw > window.innerWidth - 8) left = Math.max(8, rect.left - tw - gap);
    if (top + th > window.innerHeight - 8) top = Math.max(8, window.innerHeight - th - 8);
    widgetTooltip.style.left = `${left}px`;
    widgetTooltip.style.top = `${top}px`;
  }

  function renderLibrary() {
    libraryListEl.innerHTML = "";
    Object.values(WIDGET_TYPES).forEach((def) => {
      // A theme-bound widget (3D) is only offered while it is in the active 3D
      // widget set (a built-in variant minus disabled фишки, or a custom theme's
      // own selection).
      if (def.theme && !(state.appearance.active3dWidgets || []).includes(def.type)) return;
      // 2D-привязка к теме (Orbital и свои темы).
      if (!themeAllowsWidget(def, state.appearance)) return;
      const card = document.createElement("div");
      card.className = "library-card";
      card.draggable = true;
      card.innerHTML = `
        <span class="library-card__icon">${ICONS[def.icon] || ""}</span>
        <span class="library-card__text">
          <span class="library-card__label">${t("widgets." + def.type)}</span>
          <span class="library-card__desc">${t("widgets." + def.type + "Desc")}</span>
        </span>`;
      card.addEventListener("click", () => canvasEditor.addWidget(def.type, null));
      card.addEventListener("mouseenter", () => showWidgetTooltip(card, def));
      card.addEventListener("mouseleave", hideWidgetTooltip);
      card.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/widget-type", def.type);
        e.dataTransfer.effectAllowed = "copy";
      });
      libraryListEl.appendChild(card);
    });
  }

  // ---- settings view ----
  function populateSettings() {
    twitchChannelInput.value = state.twitchChannel || "";
    twitchClientIdInput.value = state.twitchClientId || "";
    daClientIdInput.value = state.daClientId || "";
    youtubeClientIdInput.value = state.youtubeClientId || "";
    youtubeVideoIdInput.value = state.youtubeVideoId || "";
    if (state.obs) {
      obsHostInput.value = state.obs.host || "";
      obsPortInput.value = state.obs.port || 4455;
      /*
        Пароль панель не показывает и не подставляет: сервер отдаёт его пустым
        и только помечает, что он сохранён (obs.hasPassword). Пустая строка при
        этом означает «не менять» (см. обработчик ниже), поэтому значение поля
        сбрасываем, чтобы оно не попалось в отправку само.
      */
      if (document.activeElement !== obsPasswordInput) obsPasswordInput.value = "";
      obsPasswordInput.placeholder = state.obs.hasPassword === true ? t("settings.obsPasswordSavedPlaceholder") : "••••••••";
      // Кнопку очистки показываем только когда есть что очищать.
      if (obsPasswordClearBtn) obsPasswordClearBtn.hidden = state.obs.hasPassword !== true;
      obsWebcamSourceInput.value = state.obs.webcamSource || "";
      obsMicSourceInput.value = state.obs.micSource || "";
      const sm = state.obs.sceneMap || {};
      obsSceneMainInput.value = sm.main || "";
      obsSceneStartInput.value = sm.start || "";
      obsSceneBrbInput.value = sm.brb || "";
      obsSceneTalkInput.value = sm.talk || "";
      obsSceneEndInput.value = sm.end || "";
      obsSceneWheelInput.value = sm.wheel || "";
      obsSceneVideoInput.value = sm.video || "";
      obsScenePollInput.value = sm.poll || "";
      obsScenePauseInput.value = sm.pause || "";
    }
    renderObsCommands();
    renderCameraAngles();
    renderCameraFilters();
    if (state.soundboard) {
      setSwitchState(soundboardEnabledSwitch, !!state.soundboard.enabled);
      setSwitchState(soundboardQueueSwitch, !!state.soundboard.queueMode);
      const vol = Math.round((state.soundboard.volume ?? 0.8) * 100);
      soundboardVolume.value = vol;
      soundboardVolumeValue.textContent = `${vol}%`;
      renderSoundboard();
    }
    renderTwitchRewards();
    if (state.tts) {
      setSwitchState(ttsEnabledSwitch, !!state.tts.enabled);
      const ttsVol = Math.round((state.tts.volume ?? 0.9) * 100);
      ttsVolume.value = ttsVol;
      ttsVolumeValue.textContent = `${ttsVol}%`;
      ttsRate.value = state.tts.rate ?? 1;
      ttsRateValue.textContent = `${(state.tts.rate ?? 1).toFixed(1)}×`;
      ttsLang.value = state.tts.lang || "ru-RU";
      renderTtsVoices();
    }
    if (state.donationVoice) {
      setSwitchState(daVoiceSwitch, !!state.donationVoice.donationAlerts);
    }
    if (state.chatBot) {
      setSwitchState(chatBotEnabledSwitch, !!state.chatBot.enabled);
      if (chatBotPrefixInput) chatBotPrefixInput.value = state.chatBot.prefix || "!";
      renderChatBotCommands();
      renderChatBotTimers();
      renderChatBotModeration();
    }
    setSwitchState(notificationSoundSwitch, state.notificationSound !== false);
    if (notificationVolume) {
      const vol = Math.round((state.notificationVolume ?? 0.8) * 100);
      notificationVolume.value = vol;
      if (notificationVolumeValue) notificationVolumeValue.textContent = `${vol}%`;
    }
    if (notificationRepeats) notificationRepeats.value = String(state.notificationRepeats ?? 1);
    renderStreamDeckIcons();
    renderSplashSettings();
    appPortInput.value = port;
    appOverlayUrlInput.value = overlayUrl;
    if (hudHotkeyInput) hudHotkeyInput.value = state.hudEditHotkey || "Control+Shift+H";
    if (chatHudHotkeyInput) chatHudHotkeyInput.value = state.chatHudHotkey || "Control+Shift+L";
    renderHudDisplays();
    renderChatHudDisplays();
    renderChatHudConfig();
    twitchRedirectUriEl.textContent = `http://localhost:${port}/oauth/twitch/callback`;
    daRedirectUriEl.textContent = `http://localhost:${port}/oauth/donationalerts/callback`;
    youtubeRedirectUriEl.textContent = `http://localhost:${port}/oauth/youtube/callback`;
  }

  // Live port switch (no app restart): keep the renderer's port-derived URLs
  // in sync and point the WebSocket client at the new listener. The server is
  // authoritative — on a failed switch it rolls back and the next STATE frame
  // re-syncs this value.
  function setAppPort(nextPort) {
    port = String(nextPort);
    overlayUrl = `http://localhost:${port}/overlay/overlay.html`;
    obsUrlLabel.textContent = overlayUrl;
    if (appPortInput) appPortInput.value = port;
    if (appOverlayUrlInput) appOverlayUrlInput.value = overlayUrl;
    twitchRedirectUriEl.textContent = `http://localhost:${port}/oauth/twitch/callback`;
    daRedirectUriEl.textContent = `http://localhost:${port}/oauth/donationalerts/callback`;
    youtubeRedirectUriEl.textContent = `http://localhost:${port}/oauth/youtube/callback`;
    wsClient.setUrl(`ws://localhost:${port}/ws`);
    // Scene preview is reloaded by the STATE handler once the new listener
    // is up (selectScene), so we don't point the iframe at a port that is
    // not yet listening.
  }

  twitchChannelInput.addEventListener("change", () => {
    send(EVENT_TYPES.CMD_SET_APP_CONFIG, { twitchChannel: twitchChannelInput.value.trim() });
  });

  savePortBtn.addEventListener("click", () => {
    const next = Number(appPortInput.value);
    if (!next || next < 1024 || next > 65535) return;
    if (next === Number(port)) return;
    setAppPort(next);
    send(EVENT_TYPES.CMD_SET_APP_CONFIG, { port: next });
  });

  if (saveHudHotkeyBtn && hudHotkeyInput) {
    saveHudHotkeyBtn.addEventListener("click", () => {
      const hotkey = hudHotkeyInput.value.trim();
      if (!hotkey) return;
      hudHotkeyInput.classList.remove("is-invalid");
      send(EVENT_TYPES.CMD_SET_HUD_HOTKEY, { hotkey });
    });
    hudHotkeyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveHudHotkeyBtn.click();
    });
    hudHotkeyInput.addEventListener("input", () => hudHotkeyInput.classList.remove("is-invalid"));
  }

  let hudDisplays = [];

  function displayOptions(displays) {
    return displays
      .map((d, i) => {
        const name = d.label || `${t("settings.monitor")} ${i + 1}`;
        const suffix = d.primary ? ` (${t("settings.primaryMonitor")})` : "";
        return `<option value="${escapeAttr(String(d.id))}">${escapeHtml(name)}${escapeHtml(suffix)}</option>`;
      })
      .join("");
  }

  function syncDisplaySelect(selectEl, selectedId) {
    if (!selectEl || !selectEl.options.length) return;
    if (selectedId != null) {
      selectEl.value = String(selectedId);
    } else {
      const primary = hudDisplays.find((d) => d.primary) || hudDisplays[0];
      if (primary) selectEl.value = String(primary.id);
    }
  }

  async function loadDisplays() {
    try {
      hudDisplays = (await window.desktop?.getDisplays()) || [];
    } catch {
      hudDisplays = [];
    }
    return hudDisplays;
  }

  async function renderHudDisplays() {
    if (!hudDisplaySelect) return;
    const displays = await loadDisplays();
    if (!displays.length) {
      hudDisplaySelect.hidden = true;
      return;
    }
    hudDisplaySelect.hidden = false;
    hudDisplaySelect.innerHTML = displayOptions(displays);
    syncDisplaySelect(hudDisplaySelect, state.hudDisplayId);
  }

  async function renderChatHudDisplays() {
    if (!chatHudDisplaySelect) return;
    const displays = await loadDisplays();
    if (!displays.length) {
      chatHudDisplaySelect.hidden = true;
      return;
    }
    chatHudDisplaySelect.hidden = false;
    chatHudDisplaySelect.innerHTML = displayOptions(displays);
    syncDisplaySelect(chatHudDisplaySelect, state.chatHudDisplayId);
  }

  function syncHudDisplaySelect() {
    syncDisplaySelect(hudDisplaySelect, state.hudDisplayId);
  }

  function syncChatHudDisplaySelect() {
    syncDisplaySelect(chatHudDisplaySelect, state.chatHudDisplayId);
  }

  if (hudDisplaySelect) {
    hudDisplaySelect.addEventListener("change", () => {
      send(EVENT_TYPES.CMD_SET_HUD_DISPLAY, { displayId: hudDisplaySelect.value || null });
    });
  }
  if (refreshDisplaysBtn) refreshDisplaysBtn.addEventListener("click", () => renderHudDisplays());

  if (toggleChatHudBtn) {
    toggleChatHudBtn.addEventListener("click", () => send(EVENT_TYPES.CMD_TOGGLE_CHAT_HUD, {}));
  }

  if (saveChatHudHotkeyBtn && chatHudHotkeyInput) {
    saveChatHudHotkeyBtn.addEventListener("click", () => {
      const hotkey = chatHudHotkeyInput.value.trim();
      if (!hotkey) return;
      chatHudHotkeyInput.classList.remove("is-invalid");
      send(EVENT_TYPES.CMD_SET_CHAT_HUD_HOTKEY, { hotkey });
    });
    chatHudHotkeyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveChatHudHotkeyBtn.click();
    });
    chatHudHotkeyInput.addEventListener("input", () => chatHudHotkeyInput.classList.remove("is-invalid"));
  }

  if (chatHudDisplaySelect) {
    chatHudDisplaySelect.addEventListener("change", () => {
      send(EVENT_TYPES.CMD_SET_CHAT_HUD_DISPLAY, { displayId: chatHudDisplaySelect.value || null });
    });
  }
  if (refreshChatHudDisplaysBtn) refreshChatHudDisplaysBtn.addEventListener("click", () => renderChatHudDisplays());

  function sendChatHudConfig(patch) {
    state.chatHud = { ...state.chatHud, ...patch };
    send(EVENT_TYPES.CMD_SET_CHAT_HUD_CONFIG, { config: state.chatHud });
  }

  function renderChatHudConfig() {
    const c = state.chatHud || {};
    if (chatHudWidth) chatHudWidth.value = c.width ?? 360;
    if (chatHudHeight) chatHudHeight.value = c.height ?? 560;
    if (chatHudX) chatHudX.value = c.x != null ? c.x : "";
    if (chatHudY) chatHudY.value = c.y != null ? c.y : "";
    if (chatHudOpacity) {
      chatHudOpacity.value = c.opacity ?? 70;
      if (chatHudOpacityValue) chatHudOpacityValue.textContent = `${c.opacity ?? 70}%`;
    }
    if (chatHudFontSize) {
      chatHudFontSize.value = c.fontSize ?? 14;
      if (chatHudFontSizeValue) chatHudFontSizeValue.textContent = c.fontSize ?? 14;
    }
  }

  if (chatHudWidth) chatHudWidth.addEventListener("change", () => sendChatHudConfig({ width: Number(chatHudWidth.value) || 360 }));
  if (chatHudHeight) chatHudHeight.addEventListener("change", () => sendChatHudConfig({ height: Number(chatHudHeight.value) || 560 }));
  if (chatHudX) chatHudX.addEventListener("change", () => sendChatHudConfig({ x: chatHudX.value === "" ? null : Number(chatHudX.value) }));
  if (chatHudY) chatHudY.addEventListener("change", () => sendChatHudConfig({ y: chatHudY.value === "" ? null : Number(chatHudY.value) }));
  if (chatHudOpacity) {
    chatHudOpacity.addEventListener("input", () => {
      const v = Number(chatHudOpacity.value);
      if (chatHudOpacityValue) chatHudOpacityValue.textContent = `${v}%`;
      sendChatHudConfig({ opacity: v });
    });
  }
  if (chatHudFontSize) {
    chatHudFontSize.addEventListener("input", () => {
      const v = Number(chatHudFontSize.value);
      if (chatHudFontSizeValue) chatHudFontSizeValue.textContent = v;
      sendChatHudConfig({ fontSize: v });
    });
  }

  youtubeVideoIdInput.addEventListener("change", () => {
    send(EVENT_TYPES.CMD_SET_YOUTUBE_VIDEO_ID, { videoId: youtubeVideoIdInput.value.trim() });
  });

  function sendObsConfig(patch) {
    send(EVENT_TYPES.CMD_SET_OBS_CONFIG, patch);
  }
  obsHostInput.addEventListener("change", () => sendObsConfig({ host: obsHostInput.value.trim() }));
  obsPortInput.addEventListener("change", () => sendObsConfig({ port: Number(obsPortInput.value) || 4455 }));
  obsPasswordInput.addEventListener("change", () => {
    const password = obsPasswordInput.value;
    // Пустое поле — «оставить сохранённый пароль как есть»: отправлять нечего.
    if (!password) return;
    sendObsConfig({ password });
    // Пароль ушёл — поле больше не нужно: показывать его дальше незачем.
    obsPasswordInput.value = "";
  });
  if (obsPasswordClearBtn) {
    obsPasswordClearBtn.addEventListener("click", () => {
      // Стереть пароль можно только явно: уйдёт `clearPassword`, а не пустое
      // поле — так отправка карточки настроек как есть его не затирает.
      if (!confirm(t("settings.obsPasswordClearConfirm"))) return;
      sendObsConfig({ clearPassword: true });
    });
  }
  obsWebcamSourceInput.addEventListener("change", () => sendObsConfig({ webcamSource: obsWebcamSourceInput.value.trim() }));
  obsMicSourceInput.addEventListener("change", () => sendObsConfig({ micSource: obsMicSourceInput.value.trim() }));
  obsSceneMainInput.addEventListener("change", () => sendObsConfig({ sceneMap: { main: obsSceneMainInput.value.trim() } }));
  obsSceneStartInput.addEventListener("change", () => sendObsConfig({ sceneMap: { start: obsSceneStartInput.value.trim() } }));
  obsSceneBrbInput.addEventListener("change", () => sendObsConfig({ sceneMap: { brb: obsSceneBrbInput.value.trim() } }));
  obsSceneTalkInput.addEventListener("change", () => sendObsConfig({ sceneMap: { talk: obsSceneTalkInput.value.trim() } }));
  obsSceneEndInput.addEventListener("change", () => sendObsConfig({ sceneMap: { end: obsSceneEndInput.value.trim() } }));
  obsSceneWheelInput.addEventListener("change", () => sendObsConfig({ sceneMap: { wheel: obsSceneWheelInput.value.trim() } }));
  obsSceneVideoInput.addEventListener("change", () => sendObsConfig({ sceneMap: { video: obsSceneVideoInput.value.trim() } }));
  obsScenePollInput.addEventListener("change", () => sendObsConfig({ sceneMap: { poll: obsScenePollInput.value.trim() } }));
  obsScenePauseInput.addEventListener("change", () => sendObsConfig({ sceneMap: { pause: obsScenePauseInput.value.trim() } }));

  function updateObsCommand(id, patch) {
    const commands = (state.obs.customCommands || []).map((c) => (c.id === id ? { ...c, ...patch } : c));
    sendObsConfig({ customCommands: commands });
  }

  function renderObsCommandItem(cmd) {
    const row = document.createElement("div");
    row.className = "obs-command-item";

    const label = document.createElement("input");
    label.type = "text";
    label.placeholder = t("settings.obsCommandLabel");
    label.value = cmd.label || "";
    label.addEventListener("change", () => updateObsCommand(cmd.id, { label: label.value }));

    const requestType = document.createElement("input");
    requestType.type = "text";
    requestType.placeholder = t("settings.obsCommandRequestType");
    requestType.value = cmd.requestType || "";
    requestType.addEventListener("change", () => updateObsCommand(cmd.id, { requestType: requestType.value }));

    const data = document.createElement("input");
    data.type = "text";
    data.placeholder = '{"inputName":"Mic/Aux"}';
    const dataJson = JSON.stringify(cmd.requestData || {});
    data.value = dataJson === "{}" ? "" : dataJson;
    data.addEventListener("change", () => {
      let parsed;
      try { parsed = JSON.parse(data.value || "{}"); } catch { parsed = {}; }
      updateObsCommand(cmd.id, { requestData: parsed });
    });

    const test = document.createElement("button");
    test.className = "md-button md-button--tonal";
    test.textContent = "▶";
    test.title = t("settings.run");
    test.addEventListener("click", () => send(EVENT_TYPES.CMD_RUN_OBS_COMMAND, { id: cmd.id }));

    const remove = document.createElement("button");
    remove.className = "md-button md-button--text";
    remove.textContent = "✕";
    remove.title = t("common.remove");
    remove.addEventListener("click", () => {
      const commands = (state.obs.customCommands || []).filter((c) => c.id !== cmd.id);
      sendObsConfig({ customCommands: commands });
    });

    row.append(label, requestType, data, test, remove);
    return row;
  }

  function renderObsCommands() {
    obsCommandsList.innerHTML = "";
    (state.obs.customCommands || []).forEach((cmd) => {
      obsCommandsList.appendChild(renderObsCommandItem(cmd));
    });
  }

  function updateCameraAngle(id, patch) {
    const cameraAngles = (state.obs.cameraAngles || []).map((a) => (a.id === id ? { ...a, ...patch } : a));
    sendObsConfig({ cameraAngles });
  }

  function renderCameraAngleItem(angle) {
    const row = document.createElement("div");
    row.className = "camera-angle-item" + (angle.id === state.activeCameraAngle ? " is-active" : "");

    const label = document.createElement("input");
    label.type = "text";
    label.placeholder = t("settings.cameraAngleLabel");
    label.value = angle.label || "";
    label.addEventListener("change", () => updateCameraAngle(angle.id, { label: label.value }));

    const reward = document.createElement("input");
    reward.type = "text";
    reward.placeholder = t("settings.cameraAngleReward");
    reward.value = angle.twitchRewardTitle || "";
    reward.addEventListener("change", () => updateCameraAngle(angle.id, { twitchRewardTitle: reward.value }));

    const scene = document.createElement("input");
    scene.type = "text";
    scene.placeholder = t("settings.cameraAngleScene");
    scene.value = angle.sceneName || "";
    scene.addEventListener("change", () => updateCameraAngle(angle.id, { sceneName: scene.value }));

    const source = document.createElement("input");
    source.type = "text";
    source.placeholder = t("settings.cameraAngleSource");
    source.value = angle.cameraSource || "";
    source.addEventListener("change", () => updateCameraAngle(angle.id, { cameraSource: source.value }));

    const activate = document.createElement("button");
    activate.className = "md-button md-button--tonal";
    activate.textContent = "▶";
    activate.title = t("settings.activateNow");
    activate.addEventListener("click", () => send(EVENT_TYPES.CMD_SET_CAMERA_ANGLE, { angleId: angle.id }));

    const remove = document.createElement("button");
    remove.className = "md-button md-button--text";
    remove.textContent = "✕";
    remove.title = t("common.remove");
    remove.addEventListener("click", () => {
      const cameraAngles = (state.obs.cameraAngles || []).filter((a) => a.id !== angle.id);
      sendObsConfig({ cameraAngles });
    });

    row.append(label, reward, scene, source, activate, remove);
    return row;
  }

  function renderCameraAngles() {
    cameraAnglesList.innerHTML = "";
    (state.obs.cameraAngles || []).forEach((angle) => {
      cameraAnglesList.appendChild(renderCameraAngleItem(angle));
    });
  }

  addCameraAngleBtn.addEventListener("click", () => {
    const cameraAngles = [...(state.obs.cameraAngles || []), { id: "cam_" + Date.now(), label: "", twitchRewardTitle: "", sceneName: "", cameraSource: "" }];
    sendObsConfig({ cameraAngles });
  });

  function updateCameraFilter(id, patch) {
    const cameraFilters = (state.obs.cameraFilters || []).map((f) => (f.id === id ? { ...f, ...patch } : f));
    sendObsConfig({ cameraFilters });
  }

  function renderCameraFilterItem(filter) {
    const row = document.createElement("div");
    row.className = "camera-filter-item" + ((state.activeFilters || []).includes(filter.id) ? " is-active" : "");

    const label = document.createElement("input");
    label.type = "text";
    label.placeholder = t("settings.cameraFilterLabel");
    label.value = filter.label || "";
    label.addEventListener("change", () => updateCameraFilter(filter.id, { label: label.value }));

    const reward = document.createElement("input");
    reward.type = "text";
    reward.placeholder = t("settings.cameraFilterReward");
    reward.value = filter.twitchRewardTitle || "";
    reward.addEventListener("change", () => updateCameraFilter(filter.id, { twitchRewardTitle: reward.value }));

    const source = document.createElement("input");
    source.type = "text";
    source.placeholder = t("settings.cameraFilterSource");
    source.value = filter.sourceName || "";
    source.addEventListener("change", () => updateCameraFilter(filter.id, { sourceName: source.value }));

    const filterName = document.createElement("input");
    filterName.type = "text";
    filterName.placeholder = t("settings.cameraFilterFilter");
    filterName.value = filter.filterName || "";
    filterName.addEventListener("change", () => updateCameraFilter(filter.id, { filterName: filterName.value }));

    const duration = document.createElement("input");
    duration.type = "number";
    duration.min = "0";
    duration.placeholder = t("settings.cameraFilterDuration");
    duration.value = filter.durationSec || 0;
    duration.addEventListener("change", () => updateCameraFilter(filter.id, { durationSec: Math.max(0, Number(duration.value) || 0) }));

    const test = document.createElement("button");
    test.className = "md-button md-button--tonal";
    test.textContent = "▶";
    test.title = t("settings.test");
    test.addEventListener("click", () => send(EVENT_TYPES.CMD_TRIGGER_CAMERA_FILTER, { filterId: filter.id }));

    const remove = document.createElement("button");
    remove.className = "md-button md-button--text";
    remove.textContent = "✕";
    remove.title = t("common.remove");
    remove.addEventListener("click", () => {
      const cameraFilters = (state.obs.cameraFilters || []).filter((f) => f.id !== filter.id);
      sendObsConfig({ cameraFilters });
    });

    row.append(label, reward, source, filterName, duration, test, remove);
    return row;
  }

  function renderCameraFilters() {
    cameraFiltersList.innerHTML = "";
    (state.obs.cameraFilters || []).forEach((filter) => {
      cameraFiltersList.appendChild(renderCameraFilterItem(filter));
    });
  }

  addCameraFilterBtn.addEventListener("click", () => {
    const cameraFilters = [...(state.obs.cameraFilters || []), { id: "f_" + Date.now(), label: "", twitchRewardTitle: "", sourceName: "", filterName: "", durationSec: 0 }];
    sendObsConfig({ cameraFilters });
  });

  addObsCommandBtn.addEventListener("click", () => {
    const commands = [...(state.obs.customCommands || []), { id: "cmd_" + Date.now(), label: "", requestType: "", requestData: {} }];
    sendObsConfig({ customCommands: commands });
  });

  function sendSoundboardConfig(patch) {
    send(EVENT_TYPES.CMD_SET_SOUNDBOARD_CONFIG, { config: patch });
  }

  function sendTtsConfig(patch) {
    send(EVENT_TYPES.CMD_SET_TTS_CONFIG, { config: patch });
  }

  function sendChatBotConfig(patch) {
    send(EVENT_TYPES.CMD_SET_CHAT_BOT_CONFIG, { config: patch });
  }

  function updateChatBotCommand(id, patch) {
    const commands = (state.chatBot.commands || []).map((c) => (c.id === id ? { ...c, ...patch } : c));
    sendChatBotConfig({ commands });
  }

  function updateChatBotTimer(id, patch) {
    const timers = (state.chatBot.timers || []).map((t) => (t.id === id ? { ...t, ...patch } : t));
    sendChatBotConfig({ timers });
  }

  function chatBotLevelSelect(value) {
    const select = document.createElement("select");
    [
      ["everyone", t("settings.chatBotLevelEveryone")],
      ["subscriber", t("settings.chatBotLevelSubscriber")],
      ["moderator", t("settings.chatBotLevelModerator")],
      ["broadcaster", t("settings.chatBotLevelBroadcaster")],
    ].forEach(([val, label]) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      if (val === value) opt.selected = true;
      select.appendChild(opt);
    });
    return select;
  }

  function renderChatBotCommandItem(cmd) {
    const row = document.createElement("div");
    row.className = "chatbot-command-item";

    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = t("settings.chatBotCommandName");
    name.value = cmd.name || "";
    name.addEventListener("change", () => updateChatBotCommand(cmd.id, { name: name.value }));

    const response = document.createElement("input");
    response.type = "text";
    response.placeholder = t("settings.chatBotCommandResponse");
    response.value = cmd.response || "";
    response.addEventListener("change", () => updateChatBotCommand(cmd.id, { response: response.value }));

    const level = chatBotLevelSelect(cmd.level || "everyone");
    level.addEventListener("change", () => updateChatBotCommand(cmd.id, { level: level.value }));

    const cooldown = document.createElement("input");
    cooldown.type = "number";
    cooldown.min = "0";
    cooldown.placeholder = t("settings.chatBotCooldown");
    cooldown.title = t("settings.chatBotCooldownHint");
    cooldown.value = cmd.cooldown || 0;
    cooldown.addEventListener("change", () => updateChatBotCommand(cmd.id, { cooldown: Math.max(0, Number(cooldown.value) || 0) }));

    const userCooldown = document.createElement("input");
    userCooldown.type = "number";
    userCooldown.min = "0";
    userCooldown.placeholder = t("settings.chatBotUserCooldown");
    userCooldown.title = t("settings.chatBotUserCooldownHint");
    userCooldown.value = cmd.userCooldown || 0;
    userCooldown.addEventListener("change", () => updateChatBotCommand(cmd.id, { userCooldown: Math.max(0, Number(userCooldown.value) || 0) }));

    const remove = document.createElement("button");
    remove.className = "md-button md-button--text";
    remove.textContent = "✕";
    remove.title = t("common.remove");
    remove.addEventListener("click", () => {
      const commands = (state.chatBot.commands || []).filter((c) => c.id !== cmd.id);
      sendChatBotConfig({ commands });
    });

    row.append(name, response, level, cooldown, userCooldown, remove);
    return row;
  }

  function renderChatBotCommands() {
    if (!chatBotCommandsList) return;
    chatBotCommandsList.innerHTML = "";
    (state.chatBot.commands || []).forEach((cmd) => {
      chatBotCommandsList.appendChild(renderChatBotCommandItem(cmd));
    });
  }

  function renderChatBotTimerItem(timer) {
    const row = document.createElement("div");
    row.className = "chatbot-timer-item";

    const name = document.createElement("input");
    name.type = "text";
    name.placeholder = t("settings.chatBotTimerName");
    name.value = timer.name || "";
    name.addEventListener("change", () => updateChatBotTimer(timer.id, { name: name.value }));

    const response = document.createElement("input");
    response.type = "text";
    response.placeholder = t("settings.chatBotCommandResponse");
    response.value = timer.response || "";
    response.addEventListener("change", () => updateChatBotTimer(timer.id, { response: response.value }));

    const interval = document.createElement("input");
    interval.type = "number";
    interval.min = "1";
    interval.placeholder = t("settings.chatBotInterval");
    interval.title = t("settings.chatBotIntervalHint");
    interval.value = timer.interval || 1;
    interval.addEventListener("change", () => updateChatBotTimer(timer.id, { interval: Math.max(1, Number(interval.value) || 1) }));

    const minChat = document.createElement("input");
    minChat.type = "number";
    minChat.min = "0";
    minChat.placeholder = t("settings.chatBotMinChat");
    minChat.title = t("settings.chatBotMinChatHint");
    minChat.value = timer.minChat || 0;
    minChat.addEventListener("change", () => updateChatBotTimer(timer.id, { minChat: Math.max(0, Number(minChat.value) || 0) }));

    const remove = document.createElement("button");
    remove.className = "md-button md-button--text";
    remove.textContent = "✕";
    remove.title = t("common.remove");
    remove.addEventListener("click", () => {
      const timers = (state.chatBot.timers || []).filter((t) => t.id !== timer.id);
      sendChatBotConfig({ timers });
    });

    row.append(name, response, interval, minChat, remove);
    return row;
  }

  function renderChatBotTimers() {
    if (!chatBotTimersList) return;
    chatBotTimersList.innerHTML = "";
    (state.chatBot.timers || []).forEach((timer) => {
      chatBotTimersList.appendChild(renderChatBotTimerItem(timer));
    });
  }

  if (chatBotEnabledSwitch) {
    chatBotEnabledSwitch.addEventListener("click", () => {
      const on = !chatBotEnabledSwitch.classList.contains("is-on");
      setSwitchState(chatBotEnabledSwitch, on);
      sendChatBotConfig({ enabled: on });
    });
  }
  if (chatBotPrefixInput) {
    chatBotPrefixInput.addEventListener("change", () => {
      sendChatBotConfig({ prefix: chatBotPrefixInput.value.trim() || "!" });
    });
  }
  if (addChatBotCommandBtn) {
    addChatBotCommandBtn.addEventListener("click", () => {
      const commands = [...(state.chatBot.commands || []), { id: "cmd_" + Date.now(), name: "", response: "", level: "everyone", cooldown: 0, userCooldown: 0 }];
      sendChatBotConfig({ commands });
    });
  }
  if (addChatBotTimerBtn) {
    addChatBotTimerBtn.addEventListener("click", () => {
      const timers = [...(state.chatBot.timers || []), { id: "tmr_" + Date.now(), name: "", response: "", interval: 30, minChat: 0 }];
      sendChatBotConfig({ timers });
    });
  }

  function sendChatBotModeration(patch) {
    const moderation = { ...(state.chatBot.moderation || {}), ...patch };
    sendChatBotConfig({ moderation });
  }

  function renderChatBotModeration() {
    const m = state.chatBot.moderation || {};
    setSwitchState(moderationEnabledSwitch, !!m.enabled);
    setSwitchState(moderationLinkProtectionSwitch, m.linkProtection !== false);
    if (moderationWhitelistInput) moderationWhitelistInput.value = (m.whitelistDomains || []).join(", ");
    if (moderationBadWordsInput) moderationBadWordsInput.value = (m.badWords || []).join(", ");
    if (moderationCapsThreshold) moderationCapsThreshold.value = Math.round((m.capsThreshold ?? 0.7) * 100);
    if (moderationMaxEmotes) moderationMaxEmotes.value = m.maxEmotes ?? 15;
    if (moderationMaxWarns) moderationMaxWarns.value = m.maxWarns ?? 3;
    if (moderationWarnTimeoutSec) moderationWarnTimeoutSec.value = m.warnTimeoutSec ?? 600;
  }

  if (moderationEnabledSwitch) {
    moderationEnabledSwitch.addEventListener("click", () => {
      const on = !moderationEnabledSwitch.classList.contains("is-on");
      setSwitchState(moderationEnabledSwitch, on);
      sendChatBotModeration({ enabled: on });
    });
  }
  if (moderationLinkProtectionSwitch) {
    moderationLinkProtectionSwitch.addEventListener("click", () => {
      const on = !moderationLinkProtectionSwitch.classList.contains("is-on");
      setSwitchState(moderationLinkProtectionSwitch, on);
      sendChatBotModeration({ linkProtection: on });
    });
  }
  if (moderationWhitelistInput) {
    moderationWhitelistInput.addEventListener("change", () => {
      const whitelistDomains = moderationWhitelistInput.value.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      sendChatBotModeration({ whitelistDomains });
    });
  }
  if (moderationBadWordsInput) {
    moderationBadWordsInput.addEventListener("change", () => {
      const badWords = moderationBadWordsInput.value.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      sendChatBotModeration({ badWords });
    });
  }
  if (moderationCapsThreshold) {
    moderationCapsThreshold.addEventListener("change", () => {
      const v = Math.max(0, Math.min(100, Number(moderationCapsThreshold.value) || 0));
      sendChatBotModeration({ capsThreshold: v / 100 });
    });
  }
  if (moderationMaxEmotes) {
    moderationMaxEmotes.addEventListener("change", () => {
      sendChatBotModeration({ maxEmotes: Math.max(1, Number(moderationMaxEmotes.value) || 15) });
    });
  }
  if (moderationMaxWarns) {
    moderationMaxWarns.addEventListener("change", () => {
      sendChatBotModeration({ maxWarns: Math.max(1, Number(moderationMaxWarns.value) || 3) });
    });
  }
  if (moderationWarnTimeoutSec) {
    moderationWarnTimeoutSec.addEventListener("change", () => {
      sendChatBotModeration({ warnTimeoutSec: Math.max(1, Number(moderationWarnTimeoutSec.value) || 600) });
    });
  }

  function renderTtsVoices() {
    if (!ttsVoice) return;
    const lang = (state.tts && state.tts.lang) || "ru-RU";
    const prefix = lang.slice(0, 2).toLowerCase();
    const matching = ttsVoices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(prefix));
    const list = matching.length ? matching : ttsVoices;
    const current = (state.tts && state.tts.voice) || "";
    ttsVoice.innerHTML =
      `<option value="">${t("settings.ttsVoiceAuto")}</option>` +
      list.map((v) => `<option value="${escapeAttr(v.name)}" ${v.name === current ? "selected" : ""}>${escapeHtml(v.name)} (${escapeHtml(v.lang)})</option>`).join("");
  }

  function loadTtsVoices() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      ttsVoices = window.speechSynthesis.getVoices() || [];
    } else {
      ttsVoices = [];
    }
    renderTtsVoices();
  }

  function sendStreamDeckConfig(patch) {
    send(EVENT_TYPES.CMD_SET_STREAMDECK_CONFIG, { config: patch });
  }

  function makeStreamDeckIconField(container, key, placeholder) {
    const icons = (state.streamdeck && state.streamdeck.icons) || {};
    const field = makeSoundFileInput(icons[key] || "", placeholder, "image", (v) => {
      sendStreamDeckConfig({ icons: { [key]: v } });
    });
    container.innerHTML = "";
    container.appendChild(field);
  }

  function renderStreamDeckIcons() {
    makeStreamDeckIconField(streamdeckIconStart, "start", "media/...png");
    makeStreamDeckIconField(streamdeckIconBrb, "brb", "media/...png");
    makeStreamDeckIconField(streamdeckIconWheel, "wheel", "media/...png");
    makeStreamDeckIconField(streamdeckIconTalk, "talk", "media/...png");
    makeStreamDeckIconField(streamdeckIconMain, "main", "media/...png");
    makeStreamDeckIconField(streamdeckIconEnd, "end", "media/...png");
    makeStreamDeckIconField(streamdeckIconPause, "pause", "media/...png");
  }

  function durationSelectHtml(id, value) {
    const v = Math.max(0, Math.min(30, Number(value) || 0));
    let opts = `<option value="0" ${v === 0 ? "selected" : ""}>${t("scenes.splashDurationAuto")}</option>`;
    for (let s = 1; s <= 30; s++) {
      opts += `<option value="${s}" ${v === s ? "selected" : ""}>${s} ${t("scenes.sec")}</option>`;
    }
    return `<select id="${id}">${opts}</select>`;
  }

  function renderSplashSettings() {
    if (!splashSettingsFormEl) return;
    const splash = state.splash || { file: "", duration: 0 };
    const sceneIds = ["start", "brb", "talk", "end", "wheel", "poll"];

    let html = `
      <div class="md-field">
        <label>${t("scenes.globalSplashFile")}</label>
        <div class="splash-row">
          <div id="globalSplashFile"></div>
          ${durationSelectHtml("globalSplashDuration", splash.duration || 0)}
        </div>
      </div>
      <p class="properties__hint" style="margin:0;">${t("scenes.splashDurationHint")}</p>
      <div class="inspector__title" style="margin-top:10px;">${t("scenes.splashPerScene")}</div>
      <p class="properties__hint" style="margin:0 0 6px;">${t("scenes.splashPerSceneHint")}</p>
    `;

    sceneIds.forEach((id) => {
      const sc = state.scenes[id] || {};
      const enabled = sc.splashEnabled !== false;
      html += `
        <div class="md-field splash-scene${enabled ? "" : " is-off"}">
          <div class="properties__toggle-row">
            <label>${t("scene." + id + "Label")}</label>
            ${switchHtml("splashEnabled_" + id, enabled)}
          </div>
          <div class="splash-row">
            <div id="splashFile_${id}"></div>
            ${durationSelectHtml("splashDuration_" + id, sc.splashDuration || 0)}
          </div>
        </div>
      `;
    });

    splashSettingsFormEl.innerHTML = html;

    splashSettingsFormEl.querySelector("#globalSplashFile").appendChild(
      makeSoundFileInput(splash.file || "", "media/...mp4/gif", "media", (v) =>
        send(EVENT_TYPES.CMD_SET_SPLASH_CONFIG, { config: { file: v } })
      )
    );
    splashSettingsFormEl.querySelector("#globalSplashDuration").addEventListener("change", (e) =>
      send(EVENT_TYPES.CMD_SET_SPLASH_CONFIG, { config: { duration: Number(e.target.value) || 0 } })
    );

    sceneIds.forEach((id) => {
      const sc = state.scenes[id] || {};
      splashSettingsFormEl.querySelector(`#splashFile_${id}`).appendChild(
        makeSoundFileInput(sc.splashFile || "", "media/...mp4/gif", "media", (v) => sendSceneConfigFor(id, { splashFile: v }))
      );
      splashSettingsFormEl.querySelector(`#splashDuration_${id}`).addEventListener("change", (e) =>
        sendSceneConfigFor(id, { splashDuration: Number(e.target.value) || 0 })
      );
      wireSwitch(splashSettingsFormEl.querySelector(`#splashEnabled_${id}`), (on) =>
        sendSceneConfigFor(id, { splashEnabled: on })
      );
    });
  }

  function makeSoundFileInput(value, placeholder, kind, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "sb-file";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.value = value;
    input.addEventListener("change", () => onChange(input.value));

    const browse = document.createElement("button");
    browse.className = "md-button md-button--text";
    browse.textContent = "📁";
    browse.title = t("settings.chooseFile");
    browse.addEventListener("click", async () => {
      if (!window.desktop || !window.desktop.pickSoundFile) return;
      const res = await window.desktop.pickSoundFile(kind);
      if (res && res.ok && res.relativePath) {
        input.value = res.relativePath;
        onChange(res.relativePath);
      }
    });

    wrap.append(input, browse);
    return wrap;
  }

  function renderSoundboardItem(sound) {
    const row = document.createElement("div");
    row.className = "soundboard-item";

    const reward = document.createElement("input");
    reward.type = "text";
    reward.placeholder = t("settings.soundReward");
    reward.value = sound.rewardTitle || "";
    reward.addEventListener("change", () => {
      const sounds = (state.soundboard.sounds || []).map((s) => (s.id === sound.id ? { ...s, rewardTitle: reward.value } : s));
      sendSoundboardConfig({ sounds });
    });

    const audioWrap = makeSoundFileInput(sound.audioFile || "", "media/...mp3", "audio", (v) => {
      const sounds = (state.soundboard.sounds || []).map((s) => (s.id === sound.id ? { ...s, audioFile: v } : s));
      sendSoundboardConfig({ sounds });
    });

    const imageWrap = makeSoundFileInput(sound.imageFile || "", "media/...gif", "image", (v) => {
      const sounds = (state.soundboard.sounds || []).map((s) => (s.id === sound.id ? { ...s, imageFile: v } : s));
      sendSoundboardConfig({ sounds });
    });

    const videoWrap = makeSoundFileInput(sound.videoFile || "", "media/...mp4", "video", (v) => {
      const sounds = (state.soundboard.sounds || []).map((s) => (s.id === sound.id ? { ...s, videoFile: v } : s));
      sendSoundboardConfig({ sounds });
    });

    const test = document.createElement("button");
    test.className = "md-button md-button--tonal";
    test.textContent = "▶";
    test.title = t("settings.test");
    test.addEventListener("click", () => send(EVENT_TYPES.CMD_TEST_SOUNDBOARD, { soundId: sound.id }));

    const remove = document.createElement("button");
    remove.className = "md-button md-button--text";
    remove.textContent = "✕";
    remove.title = t("common.remove");
    remove.addEventListener("click", () => {
      const sounds = (state.soundboard.sounds || []).filter((s) => s.id !== sound.id);
      sendSoundboardConfig({ sounds });
    });

    row.append(reward, audioWrap, imageWrap, videoWrap, test, remove);
    return row;
  }

  function renderSoundboard() {
    soundboardList.innerHTML = "";
    (state.soundboard.sounds || []).forEach((sound) => {
      soundboardList.appendChild(renderSoundboardItem(sound));
    });
  }

  addSoundBtn.addEventListener("click", () => {
    const sounds = [...(state.soundboard.sounds || []), { id: "sound_" + Date.now(), rewardTitle: "", rewardId: "", audioFile: "", imageFile: "", videoFile: "", title: "" }];
    sendSoundboardConfig({ sounds });
  });

  // ---- Twitch channel-point reward actions ----

  function sendTwitchRewards(rewards) {
    send(EVENT_TYPES.CMD_SET_TWITCH_REWARDS, { rewards });
  }

  function updateTwitchReward(id, patch) {
    const rewards = (state.twitchRewards || []).map((r) => (r.id === id ? { ...r, ...patch } : r));
    sendTwitchRewards(rewards);
  }

  function rewardSceneSelect(value) {
    const select = document.createElement("select");
    const scenes = ["", "main", "start", "brb", "talk", "end", "wheel", "poll", "pause"];
    scenes.forEach((id) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id === "" ? t("settings.rewardSceneNone") : t("scene." + id + "Label");
      if (id === (value || "")) opt.selected = true;
      select.appendChild(opt);
    });
    return select;
  }

  function renderTwitchRewardItem(reward) {
    const row = document.createElement("div");
    row.className = "twitch-reward-item";

    const title = document.createElement("input");
    title.type = "text";
    title.placeholder = t("settings.rewardTitle");
    title.value = reward.rewardTitle || "";
    title.addEventListener("change", () => updateTwitchReward(reward.id, { rewardTitle: title.value }));

    const id = document.createElement("input");
    id.type = "text";
    id.placeholder = t("settings.rewardId");
    id.value = reward.rewardId || "";
    id.addEventListener("change", () => updateTwitchReward(reward.id, { rewardId: id.value }));

    const alertWrap = document.createElement("label");
    alertWrap.className = "twitch-reward-flag";
    alertWrap.appendChild(document.createTextNode(t("settings.rewardAlert")));
    const alertSwitch = document.createElement("div");
    alertSwitch.className = "md-switch" + (reward.alert ? " is-on" : "");
    alertSwitch.innerHTML = `<div class="md-switch__thumb"></div>`;
    wireSwitch(alertSwitch, (on) => updateTwitchReward(reward.id, { alert: on }));
    alertWrap.appendChild(alertSwitch);

    const alertMessage = document.createElement("input");
    alertMessage.type = "text";
    alertMessage.placeholder = t("settings.rewardAlertMessage");
    alertMessage.value = reward.alertMessage || "";
    alertMessage.addEventListener("change", () => updateTwitchReward(reward.id, { alertMessage: alertMessage.value }));

    const ttsWrap = document.createElement("label");
    ttsWrap.className = "twitch-reward-flag";
    ttsWrap.appendChild(document.createTextNode(t("settings.rewardTts")));
    const ttsSwitch = document.createElement("div");
    ttsSwitch.className = "md-switch" + (reward.tts ? " is-on" : "");
    ttsSwitch.innerHTML = `<div class="md-switch__thumb"></div>`;
    wireSwitch(ttsSwitch, (on) => updateTwitchReward(reward.id, { tts: on }));
    ttsWrap.appendChild(ttsSwitch);

    const ttsText = document.createElement("input");
    ttsText.type = "text";
    ttsText.placeholder = t("settings.rewardTtsText");
    ttsText.value = reward.ttsText || "";
    ttsText.addEventListener("change", () => updateTwitchReward(reward.id, { ttsText: ttsText.value }));

    const scene = rewardSceneSelect(reward.scene);
    scene.title = t("settings.rewardScene");
    scene.addEventListener("change", () => updateTwitchReward(reward.id, { scene: scene.value }));

    const test = document.createElement("button");
    test.className = "md-button md-button--tonal";
    test.textContent = "▶";
    test.title = t("settings.rewardTest");
    test.addEventListener("click", () => send(EVENT_TYPES.CMD_TEST_TWITCH_REWARD, { id: reward.id }));

    const remove = document.createElement("button");
    remove.className = "md-button md-button--text";
    remove.textContent = "✕";
    remove.title = t("common.remove");
    remove.addEventListener("click", () => {
      const rewards = (state.twitchRewards || []).filter((r) => r.id !== reward.id);
      sendTwitchRewards(rewards);
    });

    row.append(title, id, alertWrap, alertMessage, ttsWrap, ttsText, scene, test, remove);
    return row;
  }

  function renderTwitchRewards() {
    if (!twitchRewardsList) return;
    twitchRewardsList.innerHTML = "";
    (state.twitchRewards || []).forEach((reward) => {
      twitchRewardsList.appendChild(renderTwitchRewardItem(reward));
    });
  }

  if (addRewardBtn) {
    addRewardBtn.addEventListener("click", () => {
      const rewards = [...(state.twitchRewards || []), { id: "r_" + Date.now(), rewardId: "", rewardTitle: "", alert: false, alertMessage: "", tts: false, ttsText: "", scene: "" }];
      sendTwitchRewards(rewards);
    });
  }

  // ---- Clip / stream marker ----

  function showTwitchActionResult(result) {
    if (!result) return;
    const action = result.action === "clip" ? "clip" : "marker";
    if (result.ok) {
      showToast(action === "clip" ? t("settings.clipCreated") : t("settings.markerCreated"), "", action);
    } else {
      const key = action === "clip" ? "settings.clipFailed" : "settings.markerFailed";
      const friendly = result.error === "not_configured" || result.error === "auth" ? t("settings.twitchActionDenied") : String(result.error || "");
      showToast(t(key, { error: friendly }), "", action);
    }
  }

  if (createClipBtn) {
    createClipBtn.addEventListener("click", () => send(EVENT_TYPES.CMD_CREATE_CLIP, {}));
  }
  if (createMarkerBtn) {
    createMarkerBtn.addEventListener("click", () => send(EVENT_TYPES.CMD_CREATE_STREAM_MARKER, { description: "" }));
  }

  soundboardVolume.addEventListener("input", (e) => {
    soundboardVolumeValue.textContent = `${e.target.value}%`;
  });
  soundboardVolume.addEventListener("change", (e) => {
    sendSoundboardConfig({ volume: Number(e.target.value) / 100 });
  });

  wireSwitch(soundboardQueueSwitch, (on) => sendSoundboardConfig({ queueMode: on }));
  wireSwitch(soundboardEnabledSwitch, (on) => sendSoundboardConfig({ enabled: on }));

  wireSwitch(notificationSoundSwitch, (on) => send(EVENT_TYPES.CMD_SET_NOTIFICATION_SOUND, { enabled: on }));
  if (notificationVolume) {
    notificationVolume.addEventListener("input", (e) => {
      if (notificationVolumeValue) notificationVolumeValue.textContent = `${e.target.value}%`;
    });
    notificationVolume.addEventListener("change", (e) => {
      send(EVENT_TYPES.CMD_SET_NOTIFICATION_VOLUME, { volume: Number(e.target.value) / 100 });
    });
  }
  if (notificationRepeats) {
    notificationRepeats.addEventListener("change", (e) => {
      send(EVENT_TYPES.CMD_SET_NOTIFICATION_REPEATS, { repeats: Number(e.target.value) });
    });
  }

  wireSwitch(ttsEnabledSwitch, (on) => sendTtsConfig({ enabled: on }));
  wireSwitch(daVoiceSwitch, (on) => send(EVENT_TYPES.CMD_SET_DONATION_VOICE, { config: { donationAlerts: on } }));
  ttsVolume.addEventListener("input", (e) => {
    ttsVolumeValue.textContent = `${e.target.value}%`;
  });
  ttsVolume.addEventListener("change", (e) => {
    sendTtsConfig({ volume: Number(e.target.value) / 100 });
  });
  ttsRate.addEventListener("input", (e) => {
    ttsRateValue.textContent = `${Number(e.target.value).toFixed(1)}×`;
  });
  ttsRate.addEventListener("change", (e) => {
    sendTtsConfig({ rate: Number(e.target.value) });
  });

  ttsLang.addEventListener("change", (e) => {
    if (state.tts) {
      state.tts.lang = e.target.value;
      state.tts.voice = "";
    }
    sendTtsConfig({ lang: e.target.value, voice: "" });
    renderTtsVoices();
  });
  ttsVoice.addEventListener("change", (e) => {
    if (state.tts) state.tts.voice = e.target.value;
    sendTtsConfig({ voice: e.target.value });
  });
  ttsTestBtn.addEventListener("click", () => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(t("settings.ttsTestPhrase"));
    u.lang = (state.tts && state.tts.lang) || "ru-RU";
    u.volume = state.tts && state.tts.volume != null ? state.tts.volume : 0.9;
    u.rate = state.tts && state.tts.rate != null ? state.tts.rate : 1;
    const name = (state.tts && state.tts.voice) || "";
    const voice = (window.speechSynthesis.getVoices() || []).find((v) => v.name === name);
    if (voice) u.voice = voice;
    window.speechSynthesis.speak(u);
  });

  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.addEventListener("voiceschanged", loadTtsVoices);
    loadTtsVoices();
  }

  document.getElementById("connectTwitchBtn").addEventListener("click", () => {
    window.desktop?.connectTwitch({
      clientId: twitchClientIdInput.value.trim(),
      clientSecret: twitchClientSecretInput.value.trim(),
      channel: twitchChannelInput.value.trim(),
    });
  });
  document.getElementById("connectDaBtn").addEventListener("click", () => {
    window.desktop?.connectDonationAlerts({
      clientId: daClientIdInput.value.trim(),
      clientSecret: daClientSecretInput.value.trim(),
    });
  });
  document.getElementById("connectYoutubeBtn").addEventListener("click", () => {
    window.desktop?.connectYoutube({
      clientId: youtubeClientIdInput.value.trim(),
      clientSecret: youtubeClientSecretInput.value.trim(),
    });
  });
  document.getElementById("openTwitchConsole").addEventListener("click", () => window.desktop?.openExternal("https://dev.twitch.tv/console/apps"));
  document.getElementById("openDaConsole").addEventListener("click", () => window.desktop?.openExternal("https://www.donationalerts.com/application/clients"));
  document.getElementById("openYoutubeConsole").addEventListener("click", () => window.desktop?.openExternal("https://console.cloud.google.com/apis/credentials"));

  function setSwitchState(el, on) {
    if (!el) return;
    el.classList.toggle("is-on", on);
    el.setAttribute("aria-checked", String(on));
  }

  function syncIntegrationSwitches() {
    setSwitchState(twitchEnabledSwitch, state.twitchEnabled);
    setSwitchState(donationAlertsEnabledSwitch, state.donationAlertsEnabled);
    setSwitchState(youtubeEnabledSwitch, state.youtubeEnabled);
    setSwitchState(obsEnabledSwitch, state.obs ? !!state.obs.enabled : false);
  }

  [[twitchEnabledSwitch, "twitch"], [donationAlertsEnabledSwitch, "donationAlerts"], [youtubeEnabledSwitch, "youtube"], [obsEnabledSwitch, "obs"]].forEach(([el, service]) => {
    if (!el) return;
    el.addEventListener("click", () => {
      const on = !el.classList.contains("is-on");
      setSwitchState(el, on);
      send(EVENT_TYPES.CMD_SET_INTEGRATION_ENABLED, { service, enabled: on });
    });
  });
  document.getElementById("resetLayoutBtn").addEventListener("click", () => {
    if (!confirm(t("common.resetLayoutConfirm"))) return;
    state.layout.forEach((w) => send(EVENT_TYPES.CMD_REMOVE_WIDGET, { id: w.id }));
    ["recent", "alerts", "goal", "chat"].forEach((type) => send(EVENT_TYPES.CMD_ADD_WIDGET, { type }));
    state.selectedId = null;
  });
  const toggleHudBtn = document.getElementById("toggleHudBtn");
  if (toggleHudBtn) toggleHudBtn.addEventListener("click", () => send(EVENT_TYPES.CMD_TOGGLE_HUD_EDIT_MODE, {}));

  // ---- events history ----
  const EVENTS_TYPE_LABEL = (type) =>
    ({ donation: t("events.donation"), subscription: t("events.subscription"), follow: t("events.follow"), cheer: t("events.cheer") }[type] || type);
  const EVENTS_PAGE_SIZE = 20;
  let eventsOffset = 0;
  let eventsTotal = 0;
  let eventsFilter = "all";
  let eventsSearch = "";
  let eventsSearchTimer = null;
  let giveawaySearch = "";

  function formatEventTime(ts) {
    const locale = (window.I18n && window.I18n.getLang() === "ru") ? "ru-RU" : "en-US";
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function renderEventRow(ev) {
    const amount = typeof ev.amount === "number" ? `${formatMoney(ev.amount)} ${currencySymbol(ev.currency)}` : "";
    const testBadge = ev.is_test ? '<span class="events-history__test">' + t("events.test") + '</span>' : "";
    return `
      <div class="events-history__row">
        <span class="events-history__type events-history__type--${escapeAttr(ev.type)}">${escapeHtml(EVENTS_TYPE_LABEL(ev.type))}</span>
        <span class="events-history__user">${escapeHtml(ev.username)}</span>
        ${amount ? `<span class="events-history__amount">${escapeHtml(amount)}</span>` : ""}
        ${ev.message ? `<span class="events-history__message">${escapeHtml(ev.message)}</span>` : ""}
        <span class="events-history__time">${formatEventTime(ev.timestamp)}</span>
        ${testBadge}
        <button class="md-button md-button--text events-history__replay" data-replay-id="${escapeAttr(ev.id)}">${t("events.replay")}</button>
      </div>`;
  }

  async function renderStreamEvents(reset = true) {
    if (!window.desktop?.db?.getStreamEvents) return;

    if (reset) {
      eventsOffset = 0;
      eventsTotal = 0;
      eventsHistoryEl.innerHTML = '<div class="events-history__empty">' + t("events.loading") + '</div>';
      eventsMetaEl.textContent = "";
      loadMoreEventsBtn.hidden = true;
    }

    try {
      const result = await window.desktop.db.getStreamEvents({
        limit: EVENTS_PAGE_SIZE,
        offset: eventsOffset,
        type: eventsFilter === "all" ? undefined : eventsFilter,
        search: eventsSearch,
      });
      const items = (result && result.items) || [];
      eventsTotal = (result && result.total) || 0;

      if (reset) {
        eventsHistoryEl.innerHTML = "";
        eventsMetaEl.textContent = t("events.totalCount", { count: eventsTotal });
      }

      if (!items.length && reset) {
        eventsHistoryEl.innerHTML = '<div class="events-history__empty">' + t("events.empty") + '</div>';
        return;
      }

      items.forEach((ev) => eventsHistoryEl.insertAdjacentHTML("beforeend", renderEventRow(ev)));
      eventsOffset += items.length;

      const hasMore = eventsOffset < eventsTotal;
      loadMoreEventsBtn.hidden = !hasMore;
      if (hasMore) loadMoreEventsBtn.textContent = t("events.showMore", { current: eventsOffset, total: eventsTotal });
    } catch {
      if (reset) {
        eventsHistoryEl.innerHTML = '<div class="events-history__empty">' + t("events.loadError") + '</div>';
        eventsMetaEl.textContent = "";
      }
    }
  }

  refreshEventsBtn.addEventListener("click", () => renderStreamEvents(true));
  loadMoreEventsBtn.addEventListener("click", () => renderStreamEvents(false));

  function updateEventsFilterButtons() {
    eventsFiltersEl.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.filter === eventsFilter);
    });
  }

  eventsFiltersEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-filter]");
    if (!btn) return;
    eventsFilter = btn.dataset.filter;
    updateEventsFilterButtons();
    renderStreamEvents(true);
  });

  eventsSearchInput.addEventListener("input", () => {
    clearTimeout(eventsSearchTimer);
    eventsSearchTimer = setTimeout(() => {
      eventsSearch = eventsSearchInput.value.trim();
      renderStreamEvents(true);
    }, 300);
  });

  clearEventsBtn.addEventListener("click", async () => {
    if (!confirm(t("events.clearConfirm"))) return;
    await window.desktop?.db?.clearStreamEvents?.();
    renderStreamEvents(true);
  });

  eventsHistoryEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-replay-id]");
    if (!btn) return;
    await window.desktop?.replayEvent?.(btn.dataset.replayId);
  });

  renderStreamEvents(true);

  // ---- history tabs: events / sessions / chat ----
  let historyTab = "events";
  let sessionsData = [];
  let chatOffset = 0;
  let chatTotal = 0;
  let chatSearch = "";
  let chatSearchTimer = null;
  const CHAT_PAGE_SIZE = 50;

  function setHistoryTab(tab) {
    historyTab = tab;
    if (historyTabsEl) {
      historyTabsEl.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === tab));
    }
    document.querySelectorAll("#historyPanel .history-tabpane").forEach((pane) => {
      pane.hidden = pane.dataset.pane !== tab;
    });
    refreshHistoryTab();
  }

  function refreshHistoryTab() {
    if (historyTab === "sessions") renderSessions();
    else if (historyTab === "chat") renderChat(true);
    else renderStreamEvents(true);
  }

  const pad2 = (n) => String(n).padStart(2, "0");
  function formatDuration(ms) {
    if (ms === null || ms === undefined) return "—";
    const total = Math.max(0, Math.round(ms / 1000));
    return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;
  }

  function formatDateTime(ts) {
    if (!ts) return "—";
    const locale = window.I18n && window.I18n.getLang() === "ru" ? "ru-RU" : "en-US";
    return new Date(ts).toLocaleString(locale, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  async function renderSessions() {
    if (!sessionsBodyEl || !window.desktop?.db?.getSessionsWithStats) return;
    sessionsBodyEl.innerHTML = '<div class="events-history__empty">' + t("events.loading") + "</div>";
    try {
      sessionsData = (await window.desktop.db.getSessionsWithStats()) || [];
      if (sessionsMetaEl) sessionsMetaEl.textContent = t("sessions.totalCount", { count: sessionsData.length });
      if (!sessionsData.length) {
        sessionsBodyEl.innerHTML = '<div class="events-history__empty">' + t("sessions.empty") + "</div>";
        return;
      }
      const head = `<tr><th>${t("sessions.started")}</th><th>${t("sessions.channel")}</th><th class="sessions-table__num">${t("sessions.duration")}</th><th class="sessions-table__num">${t("sessions.events")}</th><th class="sessions-table__num">${t("sessions.donations")}</th><th class="sessions-table__num">${t("sessions.chat")}</th></tr>`;
      const rows = sessionsData
        .map(
          (s) =>
            `<tr><td>${escapeHtml(formatDateTime(s.startedAt))}</td><td>${escapeHtml(s.channel || "—")}</td><td class="sessions-table__num">${formatDuration(s.durationMs)}</td><td class="sessions-table__num">${s.events}</td><td class="sessions-table__num">${s.donations}</td><td class="sessions-table__num">${s.chat}</td></tr>`
        )
        .join("");
      sessionsBodyEl.innerHTML = `<table class="sessions-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
    } catch {
      sessionsBodyEl.innerHTML = '<div class="events-history__empty">' + t("events.loadError") + "</div>";
    }
  }

  function renderChatRow(m) {
    const testBadge = m.isTest ? '<span class="events-history__test">' + t("events.test") + "</span>" : "";
    return `<div class="events-history__row"><span class="events-history__user">${escapeHtml(m.username || "")}</span><span class="events-history__message">${escapeHtml(m.message || "")}</span><span class="events-history__time">${formatEventTime(m.timestamp)}</span>${testBadge}</div>`;
  }

  async function renderChat(reset = true) {
    if (!chatHistoryEl || !window.desktop?.db?.getChatPage) return;
    const enabled = await window.desktop.db.getChatHistoryEnabled?.();
    if (enabled === false) {
      chatHistoryEl.innerHTML = '<div class="events-history__empty">' + t("chat.disabled") + "</div>";
      if (chatMetaEl) chatMetaEl.textContent = "";
      if (loadMoreChatBtn) loadMoreChatBtn.hidden = true;
      return;
    }
    if (reset) {
      chatOffset = 0;
      chatTotal = 0;
      chatHistoryEl.innerHTML = '<div class="events-history__empty">' + t("events.loading") + "</div>";
      if (chatMetaEl) chatMetaEl.textContent = "";
      if (loadMoreChatBtn) loadMoreChatBtn.hidden = true;
    }
    try {
      const result = await window.desktop.db.getChatPage({ limit: CHAT_PAGE_SIZE, offset: chatOffset, search: chatSearch });
      const items = (result && result.items) || [];
      chatTotal = (result && result.total) || 0;
      if (reset) {
        chatHistoryEl.innerHTML = "";
        if (chatMetaEl) chatMetaEl.textContent = t("chat.totalCount", { count: chatTotal });
      }
      if (!items.length && reset) {
        chatHistoryEl.innerHTML = '<div class="events-history__empty">' + t("chat.empty") + "</div>";
        return;
      }
      items.forEach((m) => chatHistoryEl.insertAdjacentHTML("beforeend", renderChatRow(m)));
      chatOffset += items.length;
      const hasMore = chatOffset < chatTotal;
      if (loadMoreChatBtn) {
        loadMoreChatBtn.hidden = !hasMore;
        if (hasMore) loadMoreChatBtn.textContent = t("events.showMore", { current: chatOffset, total: chatTotal });
      }
    } catch {
      if (reset) chatHistoryEl.innerHTML = '<div class="events-history__empty">' + t("events.loadError") + "</div>";
    }
  }

  if (historyTabsEl) {
    historyTabsEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tab]");
      if (btn) setHistoryTab(btn.dataset.tab);
    });
  }
  if (refreshSessionsBtn) refreshSessionsBtn.addEventListener("click", () => renderSessions());
  if (clearSessionsBtn) {
    clearSessionsBtn.addEventListener("click", async () => {
      if (!confirm(t("sessions.clearConfirm"))) return;
      await window.desktop?.db?.clearSessions?.();
      renderSessions();
      renderDataStats();
    });
  }
  if (refreshChatBtn) refreshChatBtn.addEventListener("click", () => renderChat(true));
  if (loadMoreChatBtn) loadMoreChatBtn.addEventListener("click", () => renderChat(false));
  if (clearChatBtn) {
    clearChatBtn.addEventListener("click", async () => {
      if (!confirm(t("chat.clearConfirm"))) return;
      await window.desktop?.db?.clearChat?.();
      renderChat(true);
      renderDataStats();
    });
  }
  if (chatSearchInput) {
    chatSearchInput.addEventListener("input", () => {
      clearTimeout(chatSearchTimer);
      chatSearchTimer = setTimeout(() => {
        chatSearch = chatSearchInput.value.trim();
        renderChat(true);
      }, 300);
    });
  }

  // ---- events export / удаление по текущему фильтру ----
  if (exportEventsBtn) {
    exportEventsBtn.addEventListener("click", async () => {
      const format = eventsExportFormat && eventsExportFormat.value === "json" ? "json" : "csv";
      const res = await window.desktop?.db?.exportStreamEvents?.({
        format,
        filter: { type: eventsFilter === "all" ? undefined : eventsFilter, search: eventsSearch },
      });
      if (!res || res.canceled) return;
      if (res.ok) showToast(t("events.exported", { count: res.count }), "");
      else showToast(t("events.exportFailed", { error: res.error }), "");
    });
  }
  if (deleteEventsBtn) {
    deleteEventsBtn.addEventListener("click", async () => {
      const scope = eventsFilter === "all" ? t("events.all") : EVENTS_TYPE_LABEL(eventsFilter);
      if (!confirm(t("events.deleteFilteredConfirm", { scope }))) return;
      const removed = await window.desktop?.db?.removeStreamEvents?.({
        type: eventsFilter === "all" ? undefined : eventsFilter,
        search: eventsSearch,
      });
      renderStreamEvents(true);
      renderDataStats();
      if (typeof removed === "number") showToast(t("events.deleted", { count: removed }), "");
    });
  }

  // ---- wheel settings panels ----
  // Разметка панелей «Колесо» и «Участники» зависит только от языка (подписи
  // полей), а значения приходят событиями на каждое движение ползунка. Поэтому
  // панель пересобирается лишь при смене языка, в остальных случаях значения
  // обновляются на месте (syncWheelPanelValues): полная перерисовка под курсором
  // обрывала перетаскивание ползунка и закрывала открытый цветовой пикер — тот
  // же приём, что в панели свойств (modules/properties-panel.js).
  let wheelPanelLang = null;
  let participantsPanelLang = null;

  function panelLang() {
    return (window.I18n && window.I18n.getLang && window.I18n.getLang()) || "";
  }

  function renderWheelPanel() {
    if (!wheelPanelBody) return;
    const lang = panelLang();
    if (lang === wheelPanelLang) {
      syncWheelPanelValues();
      return;
    }
    wheelPanelLang = lang;
    wheelPanelBody.innerHTML = `
      <div class="md-field"><label>${t("giveaway.command")}</label><input type="text" id="giveawayCommand" placeholder="!go" value="${escapeAttr(state.giveaway.command || "!go")}"></div>
      <div class="properties__test-grid">
        <button class="md-button md-button--filled" id="startGiveawayBtn">${t("giveaway.start")}</button>
        <button class="md-button md-button--outlined" id="stopGiveawayBtn">${t("giveaway.stop")}</button>
        <button class="md-button md-button--tonal" id="shuffleGiveawayBtn">${t("giveaway.shuffle")}</button>
        <button class="md-button md-button--tonal" id="generateWheelBtn">${t("giveaway.generateWheel")}</button>
        <button class="md-button md-button--filled" id="spinWheelBtn">${t("giveaway.spinWheel")}</button>
      </div>
      <div class="properties__toggle-row"><label>${t("giveaway.eliminationMode")}</label>${switchHtml("giveawayElimination", !!state.giveaway.eliminationMode)}</div>

      <div class="inspector__title" style="margin-top:10px;">${t("giveaway.participantsWidgetTitle")}</div>
      <div class="properties__row">
        <div class="md-field"><label>${t("giveaway.showNames")}</label><input type="number" id="wsMaxNames" min="1" max="200" value="${state.participantsConfig.maxNames ?? 10}"></div>
        <div class="md-field"><label>${t("giveaway.fontSize")} (px)</label><input type="number" id="wsFontSize" min="10" max="48" value="${state.participantsConfig.fontSize ?? 16}"></div>
      </div>
      <div class="md-field"><label>${t("giveaway.textColor")}</label><input type="color" id="wsTextColor" value="${escapeAttr(state.participantsConfig.textColor || "#e8e1f0")}"></div>
      <div class="md-field"><label>${t("giveaway.backgroundOpacity")}: <span id="wsBgOpacityValue">${state.participantsConfig.backgroundOpacity ?? 82}%</span></label><input type="range" id="wsBgOpacity" min="0" max="100" value="${state.participantsConfig.backgroundOpacity ?? 82}"></div>
      <div class="properties__row">
        <div class="md-field"><label>X (px)</label><input type="number" id="wsX" step="1" value="${state.participantsConfig.x ?? 24}"></div>
        <div class="md-field"><label>Y (px)</label><input type="number" id="wsY" step="1" value="${state.participantsConfig.y ?? 340}"></div>
      </div>
      <div class="properties__row">
        <div class="md-field"><label>${t("giveaway.widgetWidth")}</label><input type="number" id="wsW" min="1" step="1" value="${state.participantsConfig.w ?? 340}"></div>
        <div class="md-field"><label>${t("giveaway.widgetHeight")}</label><input type="number" id="wsH" min="1" step="1" value="${state.participantsConfig.h ?? 400}"></div>
      </div>
      <div class="properties__toggle-row"><label>${t("giveaway.marquee")}</label>${switchHtml("wsMarquee", !!state.participantsConfig.marquee)}</div>

      <div class="inspector__title" style="margin-top:10px;">${t("giveaway.wheelSettings")}</div>
      <div class="properties__row">
        <div class="md-field"><label>X (px)</label><input type="number" id="wheelX" step="1" value="${state.wheelConfig.x ?? 960}"></div>
        <div class="md-field"><label>Y (px)</label><input type="number" id="wheelY" step="1" value="${state.wheelConfig.y ?? 540}"></div>
      </div>
      <div class="md-field"><label>${t("giveaway.musicVolume")}: <span id="wsMusicVolumeValue">${state.wheelConfig.musicVolume ?? 50}%</span></label><input type="range" id="wsMusicVolume" min="0" max="100" value="${state.wheelConfig.musicVolume ?? 50}"></div>
      <div class="md-field"><label>${t("giveaway.spinSpeed")}: <span id="wsSpeedValue">${state.wheelSpeedConfig.speed ?? 3}</span></label><input type="range" id="wsSpeed" min="1" max="5" value="${state.wheelSpeedConfig.speed ?? 3}"></div>
    `;

    wireWheelControls();

    wheelPanelBody.querySelector("#wsMaxNames").addEventListener("change", (e) => sendParticipantsConfig({ maxNames: Number(e.target.value) || 10 }));
    wheelPanelBody.querySelector("#wsFontSize").addEventListener("change", (e) => sendParticipantsConfig({ fontSize: Number(e.target.value) || 16 }));
    wheelPanelBody.querySelector("#wsTextColor").addEventListener("input", (e) => sendParticipantsConfig({ textColor: e.target.value }));
    wheelPanelBody.querySelector("#wsBgOpacity").addEventListener("input", (e) => {
      const v = Number(e.target.value);
      wheelPanelBody.querySelector("#wsBgOpacityValue").textContent = `${v}%`;
      sendParticipantsConfig({ backgroundOpacity: v });
    });
    wheelPanelBody.querySelector("#wsX").addEventListener("change", (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      sendParticipantsConfig({ x: v });
    });
    wheelPanelBody.querySelector("#wsY").addEventListener("change", (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      sendParticipantsConfig({ y: v });
    });
    wheelPanelBody.querySelector("#wsW").addEventListener("change", (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v) || v <= 0) return;
      sendParticipantsConfig({ w: v });
    });
    wheelPanelBody.querySelector("#wsH").addEventListener("change", (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v) || v <= 0) return;
      sendParticipantsConfig({ h: v });
    });
    wireSwitch(wheelPanelBody.querySelector("#wsMarquee"), (on) => sendParticipantsConfig({ marquee: on }));

    wheelPanelBody.querySelector("#wheelX").addEventListener("change", (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      state.wheelConfig = { ...state.wheelConfig, x: v };
      send(EVENT_TYPES.CMD_SET_WHEEL_CONFIG, { config: state.wheelConfig });
    });
    wheelPanelBody.querySelector("#wheelY").addEventListener("change", (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      state.wheelConfig = { ...state.wheelConfig, y: v };
      send(EVENT_TYPES.CMD_SET_WHEEL_CONFIG, { config: state.wheelConfig });
    });
    wheelPanelBody.querySelector("#wsMusicVolume").addEventListener("input", (e) => {
      const v = Number(e.target.value);
      wheelPanelBody.querySelector("#wsMusicVolumeValue").textContent = `${v}%`;
      state.wheelConfig = { ...state.wheelConfig, musicVolume: v };
      send(EVENT_TYPES.CMD_SET_WHEEL_CONFIG, { config: state.wheelConfig });
    });
    wheelPanelBody.querySelector("#wsSpeed").addEventListener("input", (e) => {
      const v = Number(e.target.value);
      wheelPanelBody.querySelector("#wsSpeedValue").textContent = `${v}`;
      state.wheelSpeedConfig = { speed: v };
      send(EVENT_TYPES.CMD_SET_WHEEL_SPEED_CONFIG, { config: { speed: v } });
    });
  }

  // Значение поля без пересборки разметки. Элемент, которым сейчас занят
  // пользователь (тянут ползунок, открыт цветовой пикер, идёт ввод), не трогаем.
  // false — значение осталось прежним и связанную с ним подпись обновлять нельзя.
  function setPanelValue(selector, value) {
    const node = wheelPanelBody && wheelPanelBody.querySelector(selector);
    if (!node || node === document.activeElement) return false;
    const next = String(value);
    if (node.value !== next) node.value = next;
    return true;
  }

  function setPanelText(selector, text) {
    const node = wheelPanelBody && wheelPanelBody.querySelector(selector);
    if (node && node !== document.activeElement) node.textContent = text;
  }

  function setPanelSwitch(selector, on) {
    const node = wheelPanelBody && wheelPanelBody.querySelector(selector);
    if (node && node.classList.contains("is-on") !== !!on) node.classList.toggle("is-on", !!on);
  }

  function syncWheelPanelValues() {
    const pc = state.participantsConfig || {};
    const wc = state.wheelConfig || {};
    const ws = state.wheelSpeedConfig || {};
    renderGiveaway(); // команда розыгрыша, счётчик и список участников
    setPanelValue("#wsMaxNames", pc.maxNames ?? 10);
    setPanelValue("#wsFontSize", pc.fontSize ?? 16);
    setPanelValue("#wsTextColor", pc.textColor || "#e8e1f0");
    if (setPanelValue("#wsBgOpacity", pc.backgroundOpacity ?? 82)) setPanelText("#wsBgOpacityValue", `${pc.backgroundOpacity ?? 82}%`);
    setPanelValue("#wsX", pc.x ?? 24);
    setPanelValue("#wsY", pc.y ?? 340);
    setPanelValue("#wsW", pc.w ?? 340);
    setPanelValue("#wsH", pc.h ?? 400);
    setPanelSwitch("#wsMarquee", !!pc.marquee);
    setPanelValue("#wheelX", wc.x ?? 960);
    setPanelValue("#wheelY", wc.y ?? 540);
    if (setPanelValue("#wsMusicVolume", wc.musicVolume ?? 50)) setPanelText("#wsMusicVolumeValue", `${wc.musicVolume ?? 50}%`);
    if (setPanelValue("#wsSpeed", ws.speed ?? 3)) setPanelText("#wsSpeedValue", `${ws.speed ?? 3}`);
  }

  function renderParticipantsPanel() {
    if (!participantsPanelBody) return;
    // Та же осторожность, что и в панели колеса: снимок STATE приходит на каждое
    // событие, и пересборка стирала бы набранный вручную ник участника.
    const lang = panelLang();
    if (lang === participantsPanelLang) {
      renderGiveaway();
      return;
    }
    participantsPanelLang = lang;
    participantsPanelBody.innerHTML = `
      <div class="settings__statuses"><span class="md-chip" id="giveawayChip"><span class="md-chip__dot"></span><span id="giveawayCount">${t("giveaway.participants")}: ${state.giveaway.count}</span></span></div>
      <div class="giveaway-manual">
        <input type="text" id="giveawayManualName" placeholder="${t("giveaway.participantPlaceholder")}" />
      </div>
      <button class="md-button md-button--tonal" id="addParticipantBtn" title="${t("giveaway.addParticipant")}">+ ${t("giveaway.addParticipant")}</button>
      <div class="giveaway-participants" id="giveawayParticipants"></div>
    `;
    wireParticipantsControls();
  }

  function renderWheelPanels() {
    renderWheelPanel();
    renderParticipantsPanel();
    renderGiveaway();
  }

  // ---- giveaway / fortune wheel ----
  function renderGiveaway() {
    const commandEl = document.getElementById("giveawayCommand");
    if (!commandEl) return; // wheel settings panel not currently rendered
    if (document.activeElement !== commandEl) {
      commandEl.value = state.giveaway.command || "!go";
    }
    const countEl = document.getElementById("giveawayCount");
    const chipEl = document.getElementById("giveawayChip");
    const listEl = document.getElementById("giveawayParticipants");
    const eliminationEl = document.getElementById("giveawayElimination");
    if (countEl) countEl.textContent = `${t("giveaway.participants")}: ${state.giveaway.count}`;
    if (chipEl) chipEl.className = "md-chip " + (state.giveaway.active ? "is-pending" : "");

    const rawItems = state.giveaway.participants || [];
    const items = giveawaySearch
      ? rawItems.filter((u) => String(u).toLowerCase().includes(giveawaySearch))
      : rawItems;
    if (listEl) {
      listEl.innerHTML = rawItems.length
        ? (items.length
          ? items.map((u) => `
            <div class="giveaway-participant-row">
              <span class="giveaway-participant__name">${escapeHtml(u)}</span>
              <button class="giveaway-participant__remove" data-remove-name="${escapeAttr(u)}" title="${t("giveaway.removeParticipant")}">✕</button>
            </div>`).join("")
          : '<div class="events-history__empty">' + t("giveaway.noMatches") + '</div>')
        : '<div class="events-history__empty">' + t("giveaway.noParticipants") + '</div>';
    }

    if (eliminationEl && eliminationEl.classList.contains("is-on") !== !!state.giveaway.eliminationMode) {
      eliminationEl.classList.toggle("is-on", !!state.giveaway.eliminationMode);
    }
  }

  function wireWheelControls() {
    document.getElementById("startGiveawayBtn")?.addEventListener("click", () => {
      const commandEl = document.getElementById("giveawayCommand");
      send(EVENT_TYPES.CMD_START_GIVEAWAY, { command: commandEl ? commandEl.value.trim() : "!go" });
    });
    document.getElementById("stopGiveawayBtn")?.addEventListener("click", () => send(EVENT_TYPES.CMD_STOP_GIVEAWAY, {}));
    document.getElementById("shuffleGiveawayBtn")?.addEventListener("click", () => send(EVENT_TYPES.CMD_SHUFFLE_GIVEAWAY, {}));
    document.getElementById("generateWheelBtn")?.addEventListener("click", () => send(EVENT_TYPES.CMD_GENERATE_WHEEL, {}));
    document.getElementById("spinWheelBtn")?.addEventListener("click", () => send(EVENT_TYPES.CMD_SPIN_WHEEL, {}));
    const eliminationEl = document.getElementById("giveawayElimination");
    if (eliminationEl) wireSwitch(eliminationEl, (on) => send(EVENT_TYPES.CMD_SET_GIVEAWAY_ELIMINATION, { enabled: on }));
  }

  function wireParticipantsControls() {
    document.getElementById("addParticipantBtn")?.addEventListener("click", () => {
      const input = document.getElementById("giveawayManualName");
      if (!input) return;
      const name = input.value.trim();
      if (!name) return;
      send(EVENT_TYPES.CMD_ADD_GIVEAWAY_PARTICIPANT, { username: name });
      input.value = "";
    });

    document.getElementById("giveawayParticipants")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove-name]");
      if (!btn) return;
      send(EVENT_TYPES.CMD_REMOVE_GIVEAWAY_PARTICIPANT, { username: btn.dataset.removeName });
    });
  }

  // ---- poll (chat voting) settings ----
  function renderPollPanel() {
    if (!pollPanelBody) return;
    pollPanelBody.innerHTML = `
      <div class="md-field"><label>${t("poll.command")}</label><input type="text" id="pollCommand" placeholder="!poll" value="${escapeAttr(state.poll.command || "!poll")}"></div>
      <div class="properties__test-grid">
        <button class="md-button md-button--filled" id="startPollBtn">${t("poll.start")}</button>
        <button class="md-button md-button--outlined" id="stopPollBtn">${t("poll.stop")}</button>
        <button class="md-button md-button--tonal" id="resetPollBtn">${t("poll.reset")}</button>
      </div>

      <div class="inspector__title" style="margin-top:10px;">${t("poll.chartType")}</div>
      <div class="poll-chart-types">
        <button class="md-button md-button--tonal" id="pollBarsBtn">${t("poll.bars")}</button>
        <button class="md-button md-button--tonal" id="pollPieBtn">${t("poll.pie")}</button>
      </div>
    `;
    wirePollControls();
  }

  function renderPollOptionsPanel() {
    if (!pollOptionsPanelBody) return;
    pollOptionsPanelBody.innerHTML = `
      <div class="inspector__title">${t("poll.presetsTitle")}</div>
      <div class="poll-presets">
        <select id="pollPresetSelect"><option value="">${t("presets.placeholder")}</option></select>
        <input type="text" id="pollPresetName" placeholder="${escapeAttr(t("presets.promptName"))}" autocomplete="off" />
        <button class="md-button md-button--tonal" id="savePollPresetBtn">${t("presets.save")}</button>
        <button class="md-button md-button--tonal" id="deletePollPresetBtn" hidden>${t("presets.delete")}</button>
      </div>

      <div class="inspector__title" style="margin-top:10px;">${t("poll.optionsTitle")}</div>
      <div class="giveaway-manual">
        <input type="text" id="pollOptionName" placeholder="${t("poll.optionPlaceholder")}" />
      </div>
      <button class="md-button md-button--tonal" id="addPollOptionBtn" title="${t("poll.addOption")}">+ ${t("poll.addOption")}</button>
      <div class="giveaway-participants" id="pollOptionsList"></div>
      <button class="md-button md-button--outlined" id="clearPollOptionsBtn">${t("poll.clearOptions")}</button>
    `;
    wirePollOptionsControls();
    wirePollPresetControls();
    renderPollOptions();
    renderPollPresets();
  }

  function renderPollPanels() {
    renderPollPanel();
    renderPollOptionsPanel();
  }

  function renderPollOptions() {
    const commandEl = document.getElementById("pollCommand");
    if (commandEl && document.activeElement !== commandEl) commandEl.value = state.poll.command || "!poll";
    const barsBtn = document.getElementById("pollBarsBtn");
    const pieBtn = document.getElementById("pollPieBtn");
    if (barsBtn) barsBtn.classList.toggle("is-active", state.poll.chartType !== "pie");
    if (pieBtn) pieBtn.classList.toggle("is-active", state.poll.chartType === "pie");

    const listEl = document.getElementById("pollOptionsList");
    if (!listEl) return;
    const options = state.poll.options || [];
    listEl.innerHTML = options.length
      ? options.map((o, i) => `
        <div class="giveaway-participant-row">
          <span class="giveaway-participant__name">${i + 1}. ${escapeHtml(o.label)}</span>
          <button class="giveaway-participant__remove" data-remove-id="${escapeAttr(o.id)}" title="${t("poll.removeOption")}">✕</button>
        </div>`).join("")
      : `<div class="events-history__empty">${t("poll.noOptions")}</div>`;
  }

  function wirePollControls() {
    document.getElementById("startPollBtn")?.addEventListener("click", () => {
      const cmd = document.getElementById("pollCommand");
      send(EVENT_TYPES.CMD_START_POLL, { command: cmd ? cmd.value.trim() : "!poll" });
    });
    document.getElementById("stopPollBtn")?.addEventListener("click", () => send(EVENT_TYPES.CMD_STOP_POLL, {}));
    document.getElementById("resetPollBtn")?.addEventListener("click", () => send(EVENT_TYPES.CMD_RESET_POLL, {}));
    document.getElementById("pollBarsBtn")?.addEventListener("click", () => sendPollConfig({ chartType: "bars" }));
    document.getElementById("pollPieBtn")?.addEventListener("click", () => sendPollConfig({ chartType: "pie" }));
    document.getElementById("pollCommand")?.addEventListener("change", (e) => sendPollConfig({ command: e.target.value.trim() || "!poll" }));
  }

  function wirePollOptionsControls() {
    document.getElementById("addPollOptionBtn")?.addEventListener("click", () => {
      const input = document.getElementById("pollOptionName");
      if (!input) return;
      const label = input.value.trim();
      if (!label) return;
      send(EVENT_TYPES.CMD_ADD_POLL_OPTION, { label });
      input.value = "";
    });
    document.getElementById("pollOptionName")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("addPollOptionBtn")?.click();
    });
    document.getElementById("pollOptionsList")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove-id]");
      if (!btn) return;
      send(EVENT_TYPES.CMD_REMOVE_POLL_OPTION, { id: btn.dataset.removeId });
    });
    document.getElementById("clearPollOptionsBtn")?.addEventListener("click", () => {
      if (confirm(t("poll.clearOptionsConfirm"))) send(EVENT_TYPES.CMD_CLEAR_POLL_OPTIONS, {});
    });
  }

  function sendPollConfig(patch) {
    state.poll = { ...state.poll, ...patch };
    send(EVENT_TYPES.CMD_SET_POLL_CONFIG, { config: patch });
  }

  function renderPollPresets() {
    const select = document.getElementById("pollPresetSelect");
    if (!select) return;
    const presets = state.pollPresets || [];
    const current = select.value;
    select.innerHTML =
      `<option value="">${escapeHtml(t("presets.placeholder"))}</option>` +
      presets.map((p) => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)}</option>`).join("");
    select.value = presets.some((p) => p.id === current) ? current : "";
    const delBtn = document.getElementById("deletePollPresetBtn");
    if (delBtn) delBtn.hidden = !select.value;
  }

  function wirePollPresetControls() {
    const select = document.getElementById("pollPresetSelect");
    const nameInput = document.getElementById("pollPresetName");
    const saveBtn = document.getElementById("savePollPresetBtn");
    const delBtn = document.getElementById("deletePollPresetBtn");

    const createFromName = () => {
      const clean = nameInput ? String(nameInput.value).trim() : "";
      if (!clean) return;
      const existing = (state.pollPresets || []).find((p) => p.name === clean);
      if (existing) {
        if (!confirm(t("presets.overwriteConfirm", { name: clean }))) return;
        send(EVENT_TYPES.CMD_SAVE_POLL_PRESET, { id: existing.id, name: clean });
      } else {
        send(EVENT_TYPES.CMD_SAVE_POLL_PRESET, { name: clean });
      }
      if (nameInput) nameInput.value = "";
    };

    saveBtn?.addEventListener("click", () => {
      // Если выбран пресет в списке — перезаписываем именно его.
      const selectedId = select ? select.value : "";
      if (selectedId) {
        const preset = (state.pollPresets || []).find((p) => p.id === selectedId);
        if (preset) {
          if (confirm(t("presets.overwriteConfirm", { name: preset.name }))) {
            send(EVENT_TYPES.CMD_SAVE_POLL_PRESET, { id: preset.id, name: preset.name });
          }
          return;
        }
      }
      createFromName();
    });

    nameInput?.addEventListener("input", () => {
      if (select) {
        select.value = "";
        if (delBtn) delBtn.hidden = true;
      }
    });
    nameInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        createFromName();
      }
    });

    select?.addEventListener("change", () => {
      const id = select.value;
      if (delBtn) delBtn.hidden = !id;
      if (id) send(EVENT_TYPES.CMD_APPLY_POLL_PRESET, { id });
    });

    delBtn?.addEventListener("click", () => {
      const id = select ? select.value : "";
      if (!id) return;
      const preset = (state.pollPresets || []).find((p) => p.id === id);
      if (!confirm(t("presets.deleteConfirm", { name: preset ? preset.name : "" }))) return;
      send(EVENT_TYPES.CMD_DELETE_POLL_PRESET, { id });
    });
  }

  // ---- participants widget settings ----
  function sendParticipantsConfig(patch) {
    state.participantsConfig = { ...state.participantsConfig, ...patch };
    send(EVENT_TYPES.CMD_SET_PARTICIPANTS_CONFIG, { config: state.participantsConfig });
  }

  // ---- microphone visualizer widget settings ----
  // Глобальные настройки захвата (устройство ввода, шумоподавление). Настройки
  // отображения (режим, полосы и т.д.) хранятся на самом виджете.
  function sendMicCaptureConfig(patch) {
    state.micConfig = { ...state.micConfig, ...patch };
    send(EVENT_TYPES.CMD_SET_MIC_CONFIG, { config: state.micConfig });
    micBridge.restartIfRunning();
  }

  // Список устройств ввода — для выпадающего списка в панели свойств.
  function refreshMicDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        state.micDevices = devices
          .filter((d) => d.kind === "audioinput")
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || t("mic.deviceFallback", { n: i + 1 }) }));
        propertiesPanel.invalidate();
        propertiesPanel.render();
      })
      .catch(() => {});
  }

  function updateMicLevelMeter(level) {
    const pct = Math.round(Math.min(1, Math.max(0, Number(level) || 0)) * 100);
    const bar = document.getElementById("pMicLevelBar");
    if (bar) bar.style.width = `${pct}%`;
    const val = document.getElementById("pMicLevelValue");
    if (val) val.textContent = `${pct}%`;
  }

  // ---- properties panel (extracted module) ----
  const propertiesPanel = initPropertiesPanel({
    state,
    t,
    ICONS,
    WIDGET_TYPES,
    resolveTypeForTheme,
    EVENT_TYPES,
    send,
    switchHtml,
    wireSwitch,
    escapeAttr,
    round1,
    sendMicCaptureConfig,
    refreshMicDevices,
  });

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", refreshMicDevices);
  }
  refreshMicDevices();

  // ---- canvas editor (extracted module) ----
  const canvasEditor = initCanvasEditor({
    state,
    t,
    ICONS,
    WIDGET_TYPES,
    widgetsForTheme,
    themeAllowsWidget,
    replacedBy3d,
    widgetRole,
    resolveTypeForTheme,
    EVENT_TYPES,
    send,
    clamp,
    round1,
    escapeHtml,
    escapeAttr,
    formatMoney,
    currencySymbol,
    resolveMediaUrl,
    onSelectionChange: () => propertiesPanel.render(),
  });

  // ---- appearance: theme picker + custom theme editor ----

  function renderThemeSwatch(theme) {
    const isActive = theme.id === state.appearance.activeThemeId;
    const has3d = !!theme.has3d;
    const enable3d = isActive && !!state.appearance.enable3d;
    const card = document.createElement("div");
    card.className = "theme-swatch" + (isActive ? " is-active" : "");
    const dotColors = theme.builtin
      ? BuiltinThemes.BUILTIN_THEMES[theme.id].tokens
      : null;
    const dots = theme.builtin
      ? [dotColors["--md-primary"], dotColors["--md-secondary"], dotColors["--md-tertiary"]]
      : theme.seeds
      ? [theme.seeds.primary, theme.seeds.secondary, theme.seeds.tertiary]
      : ["#888", "#888", "#888"];
    card.innerHTML = `
      <div class="theme-swatch__dots"></div>
      <div class="theme-swatch__row">
        <span class="theme-swatch__name">${escapeHtml(theme.name)}</span>
        ${
          theme.builtin
            ? ""
            : `<span class="layer-row__btns">
                <button class="theme-swatch__btn" data-action="duplicate" title="${escapeAttr(t("themeEditor.duplicate"))}">⧉</button>
                <button class="theme-swatch__btn" data-action="export" title="${escapeAttr(t("themeEditor.exportTheme"))}">⤓</button>
                <button class="theme-swatch__btn" data-action="edit" title="${t("common.edit")}">✎</button>
                <button class="theme-swatch__btn" data-action="delete" title="${t("common.remove")}">${ICONS.trash}</button>
              </span>`
        }
      </div>
      ${
        has3d
          ? `<button class="theme-swatch__3d${enable3d ? " is-on" : ""}" data-action="3d" type="button" title="${escapeAttr(t("settings.theme3dToggleHint"))}">${escapeHtml(t("settings.theme3dToggle"))}</button>`
          : ""
      }`;
    // Цвет приезжает из файла темы (импорт не валидирует содержимое), поэтому в
    // разметку его подставлять нельзя — склеенное `style="background:${c}"`
    // позволяет вырваться из атрибута. Задаём фон через CSSOM: сюда попадает
    // только валидный цвет, а всё остальное заменяет безопасный дефолт.
    const dotsWrap = card.querySelector(".theme-swatch__dots");
    dots.forEach((c) => {
      const dot = document.createElement("span");
      dot.className = "theme-swatch__dot";
      dot.style.backgroundColor = safeCssColor(c);
      dotsWrap.appendChild(dot);
    });
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-action]")) return;
      send(EVENT_TYPES.CMD_SET_ACTIVE_THEME, { id: theme.id });
    });
    if (has3d) {
      card.querySelector('[data-action="3d"]').addEventListener("click", (e) => {
        e.stopPropagation();
        send(EVENT_TYPES.CMD_SET_ACTIVE_THEME, { id: theme.id, enable3d: !enable3d });
      });
    }
    if (!theme.builtin) {
      card.querySelector('[data-action="duplicate"]').addEventListener("click", (e) => {
        e.stopPropagation();
        send(EVENT_TYPES.CMD_DUPLICATE_CUSTOM_THEME, { id: theme.id });
      });
      card.querySelector('[data-action="export"]').addEventListener("click", async (e) => {
        e.stopPropagation();
        const res = await window.desktop?.exportTheme({ name: theme.name, seeds: theme.seeds });
        if (!res || res.canceled) return;
        if (res.ok) showExportImportStatus(t("themeEditor.themeExported", { path: res.filePath }), false);
        else showExportImportStatus(t("themeEditor.themeExportFailed", { error: res.error }), true);
      });
      card.querySelector('[data-action="edit"]').addEventListener("click", (e) => {
        e.stopPropagation();
        window.desktop?.openThemeEditor?.({ theme: { id: theme.id, name: theme.name, seeds: theme.seeds } });
      });
      card.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm(t("common.deleteThemeConfirm", { name: theme.name }))) send(EVENT_TYPES.CMD_DELETE_CUSTOM_THEME, { id: theme.id });
      });
    }
    return card;
  }

  function renderThemeGrid() {
    themeGridEl.innerHTML = "";
    const themes = state.appearance.themes || [];
    const grid = document.createElement("div");
    grid.className = "theme-grid__items";
    themes.forEach((theme) => grid.appendChild(renderThemeSwatch(theme)));
    themeGridEl.appendChild(grid);
    render3dFeatureToggles();
  }

  // When the active theme's 3D variant is on, show its individual 3D widgets
  // (фишки) as toggle switches so each one can be enabled/disabled separately.
  function render3dFeatureToggles() {
    const variantId = state.appearance.activeThemeId3d;
    const widgets = (variantId && widgetsForTheme && widgetsForTheme(variantId)) || [];
    if (!widgets.length) return;

    const container = document.createElement("div");
    container.className = "theme-grid__3d";

    const header = document.createElement("div");
    header.className = "theme-grid__category";
    header.textContent = t("settings.theme3dWidgets");
    container.appendChild(header);

    widgets.forEach((def) => {
      const on = !(state.appearance.enabled3d && state.appearance.enabled3d[def.type] === false);
      const row = document.createElement("div");
      row.className = "theme-grid__3d-row";
      row.innerHTML = `<span class="theme-grid__3d-label">${escapeHtml(t("widgets." + def.type))}</span>`;

      const sw = document.createElement("div");
      sw.className = "md-switch" + (on ? " is-on" : "");
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", String(on));
      sw.innerHTML = '<div class="md-switch__thumb"></div>';
      sw.addEventListener("click", () => {
        const next = !sw.classList.contains("is-on");
        sw.classList.toggle("is-on", next);
        sw.setAttribute("aria-checked", String(next));
        send(EVENT_TYPES.CMD_SET_ENABLED_3D, { type: def.type, enabled: next });
      });
      row.appendChild(sw);
      container.appendChild(row);
    });

    themeGridEl.appendChild(container);
  }

  newThemeBtn.addEventListener("click", () => window.desktop?.openThemeEditor?.({ theme: null }));

  importThemeBtn.addEventListener("click", async () => {
    const res = await window.desktop?.importTheme();
    if (!res || res.canceled) return;
    if (res.ok) {
      send(EVENT_TYPES.CMD_IMPORT_CUSTOM_THEME, { name: res.theme.name, seeds: res.theme.seeds });
      showExportImportStatus(t("themeEditor.themeImported"), false);
    } else {
      showExportImportStatus(t("themeEditor.themeImportFailed", { error: res.error }), true);
    }
  });

  // ---- export / import ----

  function showExportImportStatus(text, isError) {
    exportImportStatus.hidden = false;
    exportImportStatus.textContent = text;
    exportImportStatus.style.color = isError ? "var(--md-error)" : "";
  }

  exportConfigBtn.textContent = t("settings.export");
  exportConfigBtn.addEventListener("click", async () => {
    const res = await window.desktop?.exportConfig();
    if (!res) return;
    if (res.canceled) return;
    if (res.ok) showExportImportStatus(t("settings.exportSaved", { path: res.filePath }), false);
    else showExportImportStatus(t("settings.exportFailed", { error: res.error }), true);
  });

  importConfigBtn.textContent = t("settings.import");
  importConfigBtn.addEventListener("click", async () => {
    if (!confirm(t("settings.importConfirm"))) return;
    const res = await window.desktop?.importConfig();
    if (!res) return;
    if (res.canceled) return;
    if (res.ok) {
      showExportImportStatus(t("settings.imported"), false);
      state.selectedId = null;
    } else {
      showExportImportStatus(t("settings.importFailed", { error: res.error }), true);
    }
  });

  // ---- data & storage ----
  function formatBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / (1024 * 1024)).toFixed(2) + " MB";
  }

  async function renderDataStats() {
    if (!dataStatsEl || !window.desktop?.db?.getStorageStats) return;
    try {
      const stats = await window.desktop.db.getStorageStats();
      if (!stats) return;
      dataStatsEl.innerHTML = [
        ["data.path", escapeHtml(stats.dir)],
        ["data.database", formatBytes(stats.database && stats.database.bytes)],
        ["data.events", `${stats.history.count} · ${formatBytes(stats.history.bytes)}`],
        ["data.chat", `${stats.chat.count} · ${formatBytes(stats.chat.bytes)}`],
        ["data.sessions", String(stats.sessions)],
      ]
        .map(([key, value]) => `<div class="data-stats__row"><span>${t(key)}</span><code>${value}</code></div>`)
        .join("");
      if (historyLimitInput && document.activeElement !== historyLimitInput) historyLimitInput.value = String(stats.history.limit);
    } catch {
      /* статистика не критична */
    }
    renderDataBackups();
  }

  // ---- резервные копии настроек и базы ----

  // Список слотов .bak.0… от главного процесса: показываем имя файла, время и
  // размер, а битые слоты вообще нельзя нажать — увидеть это лучше до отката,
  // а не после.
  async function renderDataBackups() {
    if (!dataBackupsEl || !window.desktop?.backups?.list) return;
    let data;
    try {
      data = await window.desktop.backups.list();
    } catch {
      return;
    }
    if (!data) return;

    const rows = [];
    [
      ["config", data.config],
      ["database", data.database],
    ].forEach(([target, slots]) => {
      (slots || []).forEach((slot) => {
        const when = new Date(slot.mtime);
        const info = [when.toLocaleString(), formatBytes(slot.bytes), slot.valid ? null : t("data.backupBroken")]
          .filter(Boolean)
          .join(" · ");
        rows.push(
          `<div class="data-backups__row" data-target="${target}" data-slot="${slot.slot}">` +
            `<div class="data-backups__meta">` +
            `<span class="data-backups__name">${escapeHtml(slot.name)}</span>` +
            `<span class="data-backups__info">${escapeHtml(info)}</span>` +
            `</div>` +
            `<button class="md-button md-button--outlined"${slot.valid ? "" : " disabled"}>${t("data.backupRestore")}</button>` +
            `</div>`
        );
      });
    });

    dataBackupsEl.innerHTML = rows.length ? rows.join("") : `<div class="data-backups__empty">${t("data.backupsEmpty")}</div>`;
    dataBackupsEl.querySelectorAll(".data-backups__row").forEach((row) => {
      const btn = row.querySelector("button");
      if (!btn || btn.disabled) return;
      btn.addEventListener("click", () => restoreBackup(row.dataset.target, Number(row.dataset.slot), btn));
    });
  }

  async function restoreBackup(target, slot, btn) {
    const name = btn.closest(".data-backups__row")?.querySelector(".data-backups__name")?.textContent || "";
    if (!confirm(t("data.backupConfirm", { file: name }))) return;
    btn.disabled = true;
    const res = await window.desktop?.backups?.restore?.(target, slot);
    btn.disabled = false;
    if (res && res.ok) {
      // Панель получит свежий STATE от сервера и перерисует раскладку/настройки.
      showDataStatus(t("data.backupRestored"), false);
      renderDataStats();
    } else {
      showDataStatus(t("data.backupRestoreFailed", { error: (res && res.error) || "—" }), true);
    }
  }

  // ---- доступ из сети ----

  function showAccessStatus(text, isError) {
    if (!accessStatusEl) return;
    accessStatusEl.hidden = false;
    accessStatusEl.textContent = text;
    accessStatusEl.style.color = isError ? "var(--md-error)" : "";
  }

  // Адрес пульта приходит в снапшоте состояния (уже с кодом доступа): панель
  // только показывает и копирует его.
  function renderAccessUrl(url) {
    if (!accessRemoteUrlEl) return;
    accessRemoteUrlEl.textContent = url || "—";
  }

  if (copyAccessUrlBtn) {
    copyAccessUrlBtn.addEventListener("click", async () => {
      const url = accessRemoteUrlEl ? accessRemoteUrlEl.textContent : "";
      if (!url || url === "—") return;
      const ok = await copyText(url);
      showAccessStatus(ok ? t("access.copied") : t("access.failed", { error: "clipboard" }), !ok);
    });
  }

  if (rotateAccessCodeBtn) {
    rotateAccessCodeBtn.addEventListener("click", async () => {
      if (!confirm(t("access.hint"))) return;
      const res = await window.desktop?.rotateAccessCode?.();
      if (res && res.ok) {
        renderAccessUrl(res.remoteUrl);
        showAccessStatus(t("access.rotated"), false);
      } else {
        showAccessStatus(t("access.failed", { error: (res && res.error) || "—" }), true);
      }
    });
  }

  function showDataStatus(text, isError) {
    if (!dataStatusEl) return;
    dataStatusEl.hidden = false;
    dataStatusEl.textContent = text;
    dataStatusEl.style.color = isError ? "var(--md-error)" : "";
  }

  if (chatHistorySwitch) {
    Promise.resolve(window.desktop?.db?.getChatHistoryEnabled?.()).then((on) => {
      if (on !== undefined) setSwitchState(chatHistorySwitch, on !== false);
    });
    chatHistorySwitch.addEventListener("click", async () => {
      const on = !chatHistorySwitch.classList.contains("is-on");
      setSwitchState(chatHistorySwitch, on);
      await window.desktop?.db?.setChatHistoryEnabled?.(on);
      if (historyTab === "chat") renderChat(true);
    });
  }

  if (saveHistoryLimitBtn) {
    saveHistoryLimitBtn.addEventListener("click", async () => {
      const raw = historyLimitInput.value.trim();
      if (raw === "") return;
      const value = Math.max(0, Math.floor(Number(raw) || 0));
      const next = await window.desktop?.db?.setHistoryLimit?.(value);
      if (typeof next === "number" && historyLimitInput) historyLimitInput.value = String(next);
      showDataStatus(t("data.saved"), false);
      renderDataStats();
      if (historyTab === "events") renderStreamEvents(true);
    });
  }

  if (dataClearBtn) {
    dataClearBtn.addEventListener("click", async () => {
      const scope = dataClearScope ? dataClearScope.value : "events";
      const label = dataClearScope && dataClearScope.selectedOptions[0] ? dataClearScope.selectedOptions[0].textContent : scope;
      if (!confirm(t("data.clearConfirm", { scope: label }))) return;
      const api = window.desktop?.db;
      if (scope === "sessions") await api?.clearSessions?.();
      else if (scope === "chat") await api?.clearChat?.();
      else if (scope === "all") {
        await api?.clearStreamEvents?.();
        await api?.clearSessions?.();
        await api?.clearChat?.();
      } else await api?.clearStreamEvents?.();
      showDataStatus(t("data.cleared"), false);
      renderDataStats();
      refreshHistoryTab();
    });
  }

  if (openDataFolderBtn) {
    openDataFolderBtn.addEventListener("click", () => window.desktop?.db?.openDataFolder?.());
  }

  // Отчёт для поддержки собирается в главном процессе (там есть лог, пути и
  // телеметрия записи) и сохраняется выбранным файлом — панель только просит.
  if (supportBundleBtn) {
    supportBundleBtn.addEventListener("click", async () => {
      const res = await window.desktop?.saveSupportBundle?.();
      if (!res || res.canceled) return;
      if (res.ok) showDataStatus(t("data.supportSaved", { path: res.path }), false);
      else showDataStatus(t("data.supportFailed", { error: res.error }), true);
    });
  }

  if (resetDbBtn) {
    resetDbBtn.addEventListener("click", async () => {
      if (!confirm(t("data.resetConfirm"))) return;
      showDataStatus(t("data.resetting"), false);
      await window.desktop?.db?.resetAll?.();
    });
  }

  renderDataStats();

  // ---- layout presets ----

  function renderLayoutPresets() {
    if (!layoutPresetSelect) return;
    const presets = state.layoutPresets || [];
    const current = layoutPresetSelect.value;
    layoutPresetSelect.innerHTML =
      `<option value="">${escapeHtml(t("presets.placeholder"))}</option>` +
      presets.map((p) => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)}</option>`).join("");
    layoutPresetSelect.value = presets.some((p) => p.id === current) ? current : "";
    if (deleteLayoutPresetBtn) deleteLayoutPresetBtn.hidden = !layoutPresetSelect.value;
  }

  if (saveLayoutPresetBtn) {
    const createFromName = () => {
      // Создание нового пресета по имени (без дублей названий).
      const clean = layoutPresetName ? String(layoutPresetName.value).trim() : "";
      if (!clean) return;
      const existing = (state.layoutPresets || []).find((p) => p.name === clean);
      if (existing) {
        if (!confirm(t("presets.overwriteConfirm", { name: clean }))) return;
        send(EVENT_TYPES.CMD_SAVE_LAYOUT_PRESET, { id: existing.id, name: clean });
      } else {
        send(EVENT_TYPES.CMD_SAVE_LAYOUT_PRESET, { name: clean });
      }
      if (layoutPresetName) layoutPresetName.value = "";
    };

    saveLayoutPresetBtn.addEventListener("click", () => {
      // Если в выпадающем списке выбран пресет — перезаписываем именно его.
      const selectedId = layoutPresetSelect ? layoutPresetSelect.value : "";
      if (selectedId) {
        const preset = (state.layoutPresets || []).find((p) => p.id === selectedId);
        if (preset) {
          if (confirm(t("presets.overwriteConfirm", { name: preset.name }))) {
            send(EVENT_TYPES.CMD_SAVE_LAYOUT_PRESET, { id: preset.id, name: preset.name });
          }
          return;
        }
      }
      createFromName();
    });

    if (layoutPresetName) {
      // Когда пользователь начинает вводить имя — снимаем выбор, чтобы "Сохранить"
      // создавал новый пресет, а не перезаписывал выбранный.
      layoutPresetName.addEventListener("input", () => {
        if (layoutPresetSelect) {
          layoutPresetSelect.value = "";
          if (deleteLayoutPresetBtn) deleteLayoutPresetBtn.hidden = true;
        }
      });
      layoutPresetName.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          createFromName();
        }
      });
    }
  }

  if (layoutPresetSelect) {
    layoutPresetSelect.addEventListener("change", () => {
      const id = layoutPresetSelect.value;
      if (deleteLayoutPresetBtn) deleteLayoutPresetBtn.hidden = !id;
      if (id) send(EVENT_TYPES.CMD_APPLY_LAYOUT_PRESET, { id });
    });
  }

  if (deleteLayoutPresetBtn) {
    deleteLayoutPresetBtn.addEventListener("click", () => {
      const id = layoutPresetSelect.value;
      if (!id) return;
      const preset = (state.layoutPresets || []).find((p) => p.id === id);
      if (!confirm(t("presets.deleteConfirm", { name: preset ? preset.name : "" }))) return;
      send(EVENT_TYPES.CMD_DELETE_LAYOUT_PRESET, { id });
    });
  }

  // ---- scenes ----

  function sceneUrl(id) {
    if (id === "wheel") return `http://localhost:${port}/overlay/wheel-scene.html`;
    if (id === "poll") return `http://localhost:${port}/overlay/poll-scene.html`;
    return `http://localhost:${port}/overlay/scene.html?type=${id}`;
  }

  function renderScenesNav() {
    scenesNavListEl.innerHTML = "";
    Object.values(SceneCatalog.SCENE_DEFS).forEach((def) => {
      const card = document.createElement("div");
      card.className = "library-card" + (def.id === state.activeSceneId ? " is-active" : "");
      card.innerHTML = `<span class="library-card__icon">${ICONS[def.icon] || ""}</span><span class="library-card__text"><span class="library-card__label">${t("scene." + def.id + "Label")}</span></span>`;
      card.addEventListener("click", () => {
        selectScene(def.id);
        setActiveTab("scenes");
      });
      scenesNavListEl.appendChild(card);
    });
  }

  function selectScene(id) {
    state.activeSceneId = id;
    const url = sceneUrl(id);
    if (scenesPreviewFrame.src !== url) scenesPreviewFrame.src = url;
    sceneUrlLabel.textContent = url;
    renderScenesNav();
    renderSceneForm();
  }

  function sendSceneUpdate(patch) {
    send(EVENT_TYPES.CMD_SET_SCENE_CONFIG, { sceneId: state.activeSceneId, patch });
  }

  function sendSceneConfigFor(sceneId, patch) {
    send(EVENT_TYPES.CMD_SET_SCENE_CONFIG, { sceneId, patch });
  }

  function renderSceneForm() {
    const scene = state.scenes[state.activeSceneId];
    if (!scene) return;
    const def = SceneCatalog.SCENE_DEFS[state.activeSceneId];
    sceneFormTitle.textContent = t("scene." + def.id + "Label");

    if (state.activeSceneId === "wheel") {
      sceneFormEl.innerHTML = `
        <div class="wheel-panel__hint">${t("giveaway.wheelPanelHint")}</div>
        <button class="md-button md-button--tonal" id="openWheelSettingsBtn" style="margin-top:10px;">${t("giveaway.openWheelSettings")}</button>
      `;
      sceneFormEl.querySelector("#openWheelSettingsBtn").addEventListener("click", () => setWheelOpen(true));
      return;
    }

    if (state.activeSceneId === "poll") {
      sceneFormEl.innerHTML = `
        <div class="wheel-panel__hint">${t("poll.panelHint")}</div>
        <button class="md-button md-button--tonal" id="openPollSettingsBtn" style="margin-top:10px;">${t("poll.openSettings")}</button>
      `;
      sceneFormEl.querySelector("#openPollSettingsBtn").addEventListener("click", () => setPollOpen(true));
      return;
    }

    if (state.activeSceneId === "pause") {
      sceneFormEl.innerHTML = `
        <div class="md-field">
          <label>${t("sceneForm.pauseBackground")}</label>
          <div id="pauseBackgroundFile"></div>
          <p class="properties__hint" style="margin:6px 0 0;">${t("sceneForm.pauseBackgroundHint")}</p>
        </div>
      `;
      sceneFormEl.querySelector("#pauseBackgroundFile").appendChild(
        makeSoundFileInput(scene.backgroundFile || "", "media/...mp4/gif", "media", (v) => sendSceneUpdate({ backgroundFile: v }))
      );
      return;
    }

    sceneFormEl.innerHTML = `
      <div class="md-field"><label>${t("sceneForm.statusBadge")}</label><input type="text" id="sStatusLabel" value="${escapeAttr(scene.statusLabel)}"></div>
      <div class="md-field"><label>${t("sceneForm.title")}</label><input type="text" id="sTitle" value="${escapeAttr(scene.title)}"></div>
      <div class="md-field"><label>${t("sceneForm.subtitle")}</label><input type="text" id="sSubtitle" value="${escapeAttr(scene.subtitle)}"></div>
      <div class="properties__toggle-row"><label>${t("sceneForm.timer")}</label>${switchHtml("sShowTimer", scene.showTimer)}</div>
      <div class="md-field"><label>${t("sceneForm.timerDuration")}</label><input type="number" id="sTimerDuration" min="0" value="${scene.timerDuration}"></div>
      <div class="md-field"><label>${t("sceneForm.timerDoneText")}</label><input type="text" id="sTimerDoneText" value="${escapeAttr(scene.timerDoneText || "")}"></div>
      <div class="properties__toggle-row"><label>${t("sceneForm.recentEvents")}</label>${switchHtml("sShowEvents", scene.showEvents)}</div>
      <div class="properties__toggle-row"><label>${t("sceneForm.socials")}</label>${switchHtml("sShowSocials", scene.showSocials)}</div>
      <div class="md-field">
        <label>${t("sceneForm.socials")}</label>
        <div class="scene-socials-list" id="sSocialsList"></div>
        <button class="md-button md-button--text" id="sAddSocial" style="align-self:flex-start;margin-top:4px;">+ ${t("sceneForm.addSocial")}</button>
      </div>
      <div class="inspector__title" style="margin-top:4px;">${t("sceneForm.topDonation")}</div>
      <div class="properties__hint">${state.topDonation.amount > 0 ? `${escapeHtml(state.topDonation.user)} — ${formatMoney(state.topDonation.amount)} ${escapeHtml(currencySymbol(state.topDonation.currency))}` : t("sceneForm.noDonations")}</div>
      <button class="md-button md-button--outlined" id="sResetTopDonation">${t("sceneForm.resetTopDonation")}</button>
    `;

    renderSocialsList(scene.socials || []);

    sceneFormEl.querySelector("#sStatusLabel").addEventListener("change", (e) => sendSceneUpdate({ statusLabel: e.target.value }));
    sceneFormEl.querySelector("#sTitle").addEventListener("change", (e) => sendSceneUpdate({ title: e.target.value }));
    sceneFormEl.querySelector("#sSubtitle").addEventListener("change", (e) => sendSceneUpdate({ subtitle: e.target.value }));
    sceneFormEl.querySelector("#sTimerDuration").addEventListener("change", (e) => sendSceneUpdate({ timerDuration: Number(e.target.value) }));
    sceneFormEl.querySelector("#sTimerDoneText").addEventListener("change", (e) => sendSceneUpdate({ timerDoneText: e.target.value }));
    wireSwitch(sceneFormEl.querySelector("#sShowTimer"), (on) => sendSceneUpdate({ showTimer: on }));
    wireSwitch(sceneFormEl.querySelector("#sShowEvents"), (on) => sendSceneUpdate({ showEvents: on }));
    wireSwitch(sceneFormEl.querySelector("#sShowSocials"), (on) => sendSceneUpdate({ showSocials: on }));
    sceneFormEl.querySelector("#sAddSocial").addEventListener("click", () => {
      sendSceneUpdate({ socials: [...(scene.socials || []), { platform: "", text: "" }] });
    });
    sceneFormEl.querySelector("#sResetTopDonation").addEventListener("click", () => {
      if (confirm(t("sceneForm.resetTopDonationConfirm"))) send(EVENT_TYPES.CMD_RESET_TOP_DONATION, {});
    });
  }

  function renderSocialsList(socials) {
    const host = document.getElementById("sSocialsList");
    host.innerHTML = socials
      .map(
        (s, i) => `
      <div class="scene-social-row">
        <input type="text" class="platform" data-idx="${i}" data-field="platform" value="${escapeAttr(s.platform)}" maxlength="4">
        <input type="text" class="text" data-idx="${i}" data-field="text" value="${escapeAttr(s.text)}">
        <button class="layer-row__btn" data-action="remove-social" data-idx="${i}" title="${t("common.remove")}">${ICONS.trash}</button>
      </div>`
      )
      .join("");
    host.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("change", () => {
        const idx = Number(inp.dataset.idx);
        const field = inp.dataset.field;
        sendSceneUpdate({ socials: socials.map((s, i) => (i === idx ? { ...s, [field]: inp.value } : s)) });
      });
    });
    host.querySelectorAll('[data-action="remove-social"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        sendSceneUpdate({ socials: socials.filter((_, i) => i !== idx) });
      });
    });
  }

  const copyText = async (text) => {
    if (window.desktop?.copyText) {
      try {
        await window.desktop.copyText(text);
        return true;
      } catch (_) {
        /* fall through to the web API below */
      }
    }
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  };

  copySceneUrlBtn.textContent = t("scenes.copyUrl");
  copySceneUrlBtn.addEventListener("click", async () => {
    const ok = await copyText(sceneUrl(state.activeSceneId));
    if (!ok) return;
    copySceneUrlBtn.textContent = t("scenes.copied");
    setTimeout(() => (copySceneUrlBtn.textContent = t("scenes.copyUrl")), 1400);
  });

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.textContent = t("common.copy");
    btn.addEventListener("click", async () => {
      const target = document.getElementById(btn.dataset.copy);
      const ok = await copyText(target.textContent);
      if (!ok) return;
      btn.textContent = t("editor.copied");
      setTimeout(() => (btn.textContent = t("common.copy")), 1400);
    });
  });

  obsUrlLabel.textContent = overlayUrl;
  copyUrlBtn.textContent = t("editor.copyUrl");
  copyUrlBtn.addEventListener("click", async () => {
    const ok = await copyText(overlayUrl);
    if (!ok) return;
    copyUrlBtn.textContent = t("editor.copied");
    setTimeout(() => (copyUrlBtn.textContent = t("editor.copyUrl")), 1400);
  });

  if (copyOverlayUrlBtn) {
    copyOverlayUrlBtn.textContent = t("common.copy");
    copyOverlayUrlBtn.addEventListener("click", async () => {
      const url = appOverlayUrlInput ? appOverlayUrlInput.value : overlayUrl;
      const ok = await copyText(url);
      if (!ok) return;
      copyOverlayUrlBtn.textContent = t("editor.copied");
      setTimeout(() => (copyOverlayUrlBtn.textContent = t("common.copy")), 1400);
    });
  }

  remoteUrlHint.addEventListener("click", async () => {
    const url = remoteUrlText.textContent;
    if (!url || url === "—") return;
    const ok = await copyText(url);
    if (!ok) return;
    remoteUrlText.textContent = t("editor.copied");
    setTimeout(() => (remoteUrlText.textContent = url), 1400);
  });

  const openChatWindowBtn = document.getElementById("openChatWindowBtn");
  openChatWindowBtn.innerHTML = `${ICONS.widgetChat} ${t("editor.chat")}`;
  openChatWindowBtn.addEventListener("click", () => window.desktop?.openChatWindow());

  const openBoostyBtn = document.getElementById("openBoostyBtn");
  if (openBoostyBtn) {
    openBoostyBtn.innerHTML = `${ICONS.heart} ${t("boosty.support")}`;
    openBoostyBtn.addEventListener("click", () => window.desktop?.openExternal("https://boosty.to/halantar/donate"));
  }

  document.querySelectorAll("#languageSwitcher [data-lang]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lang = btn.dataset.lang;
      if (window.desktop && window.desktop.changeLanguage) window.desktop.changeLanguage(lang);
      else send(EVENT_TYPES.CMD_SET_LANGUAGE, { lang });
    });
  });

  const loggerPanel = initLoggerPanel({ t, ICONS, send, EVENT_TYPES, state });
  const daPanel = initDonationAlertsPanel({
    t,
    ICONS,
    send,
    EVENT_TYPES,
    state,
    showToast,
    // Подписи и цвета статусов берём из ws-client: он владеет их словарём,
    // иначе панель и чипы в шапке говорили бы об одном разными словами.
    statusText: wsClient.statusText,
    statusClass: wsClient.statusClass,
    // Форматирование и экранирование — то же, что у остальной панели, чтобы
    // суммы и время в списке донатов выглядели как в «Истории».
    utils: { escapeHtml, escapeAttr, formatMoney, currencySymbol, formatEventTime },
  });
  const helpPanel = initHelpPanel({ t, ICONS });
  const debugPanel = initDebugPanel({ t, ICONS, send, EVENT_TYPES });

  // ---- history console panel ----
  const historyPanelEl = document.getElementById("historyPanel");
  const toggleHistoryBtn = document.getElementById("toggleHistoryBtn");
  function setHistoryOpen(open) {
    if (!historyPanelEl || !toggleHistoryBtn) return;
    historyPanelEl.hidden = !open;
    toggleHistoryBtn.classList.toggle("is-active", open);
    if (open) refreshHistoryTab();
  }
  if (toggleHistoryBtn) {
    toggleHistoryBtn.innerHTML = `${ICONS.widgetRecent} ${t("nav.history")}`;
  }
  const historyCloseBtn = document.getElementById("historyCloseBtn");
  if (historyCloseBtn) historyCloseBtn.addEventListener("click", () => setHistoryOpen(false));

  // ---- wheel settings panels ----
  function setWheelOpen(open) {
    if (!wheelPanelEl || !participantsPanelEl || !toggleWheelBtn) return;
    wheelPanelEl.hidden = !open;
    participantsPanelEl.hidden = !open;
    toggleWheelBtn.classList.toggle("is-active", open);
    if (open) renderWheelPanels();
  }
  if (toggleWheelBtn) {
    toggleWheelBtn.innerHTML = `${ICONS.sceneWheel} ${t("nav.wheel")}`;
  }
  if (wheelCloseBtn) wheelCloseBtn.addEventListener("click", () => setWheelOpen(false));

  // ---- poll settings panel ----
  function setPollOpen(open) {
    if (!pollPanelEl || !pollOptionsPanelEl || !togglePollBtn) return;
    pollPanelEl.hidden = !open;
    pollOptionsPanelEl.hidden = !open;
    togglePollBtn.classList.toggle("is-active", open);
    if (open) renderPollPanels();
  }
  if (togglePollBtn) {
    togglePollBtn.innerHTML = `${ICONS.scenePoll} ${t("nav.poll")}`;
  }
  if (pollCloseBtn) pollCloseBtn.addEventListener("click", () => setPollOpen(false));

  if (participantsSearchInput) {
    participantsSearchInput.addEventListener("input", () => {
      giveawaySearch = participantsSearchInput.value.trim().toLowerCase();
      renderGiveaway();
    });
  }
  if (clearParticipantsBtn) {
    clearParticipantsBtn.addEventListener("click", () => {
      if (confirm(t("giveaway.clearParticipantsConfirm"))) {
        send(EVENT_TYPES.CMD_CLEAR_GIVEAWAY_PARTICIPANTS, {});
      }
    });
  }

  // ---- alert queue panel ----
  /*
    Очередь алертов живёт на сервере (см. server/alert-queue.js) и присылается
    целиком: снимок приходит в STATE (поле alertQueue) и в ALERT_QUEUE_UPDATE
    после каждого изменения. Клиент не ведёт своей модели очереди — он помнит
    только последний снимок и полностью перерисовывается из него, поэтому
    панель не может разойтись с сервером.
  */
  const queuePanelEl = document.getElementById("queuePanel");
  const pendingPanelEl = document.getElementById("pendingPanel");
  const queueNowCardEl = document.getElementById("queueNowCard");
  const queuePendingEl = document.getElementById("queuePending");
  const queueStatsEl = document.getElementById("queueStats");
  const queueListEl = document.getElementById("queueList");
  const queueEmptyEl = document.getElementById("queueEmpty");
  const queuePauseStateEl = document.getElementById("queuePauseState");
  const queueSkipBtn = document.getElementById("queueSkipBtn");
  const queueClearBtn = document.getElementById("queueClearBtn");
  const queuePauseBtn = document.getElementById("queuePauseBtn");
  const queuePause5Btn = document.getElementById("queuePause5Btn");
  const queuePause15Btn = document.getElementById("queuePause15Btn");
  const queuePause30Btn = document.getElementById("queuePause30Btn");
  const queueMinAmountInput = document.getElementById("queueMinAmount");
  const queueEnabledInput = document.getElementById("queueEnabled");
  const queueMergeSameUserInput = document.getElementById("queueMergeSameUser");
  const queueMergeWindowInput = document.getElementById("queueMergeWindow");
  const queueRecoverBtn = document.getElementById("queueRecoverBtn");
  const queueRecoverStatusEl = document.getElementById("queueRecoverStatus");

  let queueSnapshot = null; // последний снимок с сервера — единственный источник отрисовки
  // Подтягивание пропущенных донатов отвечает не сразу (запрос к DonationAlerts),
  // поэтому кнопка блокируется на время ожидания и разблокируется по таймауту.
  const QUEUE_RECOVER_TIMEOUT_MS = 30000;
  let queueRecoverTimer = null;
  let queueRecoverPending = false;
  let queueRecoverStatus = "";
  let queueRecoverOk = false;

  const QUEUE_PAUSE_PRESETS = [[queuePause5Btn, 5], [queuePause15Btn, 15], [queuePause30Btn, 30]];

  function queueAmountText(item) {
    if (!item || typeof item.amount !== "number") return "";
    return `${formatMoney(item.amount)} ${currencySymbol(item.currency)}`.trim();
  }

  function queueBadgesHtml(item, blockClass) {
    const badges = [];
    if (item.recovered === true) {
      badges.push(`<span class="queue-badge queue-badge--recovered">${escapeHtml(t("queue.recovered"))}</span>`);
    }
    if (Number(item.count) > 1) badges.push(`<span class="queue-badge">×${Number(item.count)}</span>`);
    return badges.length ? `<div class="${blockClass}">${badges.join("")}</div>` : "";
  }

  function queueNowCardHtml(item) {
    if (!item) return `<div class="queue-card__empty">${escapeHtml(t("queue.nothingPlaying"))}</div>`;
    const amount = queueAmountText(item);
    return `
      <div class="queue-card__top">
        <span class="queue-card__user">${escapeHtml(item.user || "—")}</span>
        ${amount ? `<span class="queue-card__amount">${escapeHtml(amount)}</span>` : ""}
      </div>
      ${item.message ? `<div class="queue-card__message">${escapeHtml(item.message)}</div>` : ""}
      ${queueBadgesHtml(item, "queue-card__badges")}`;
  }

  function queueItemHtml(item, index) {
    const id = escapeAttr(item.id);
    const amount = queueAmountText(item);
    return `
      <div class="queue-item">
        <div class="queue-item__main">
          <div class="queue-item__top">
            <span class="queue-item__user">${escapeHtml(item.user || "—")}</span>
            ${amount ? `<span class="queue-item__amount">${escapeHtml(amount)}</span>` : ""}
          </div>
          ${item.message ? `<div class="queue-item__message">${escapeHtml(item.message)}</div>` : ""}
          ${queueBadgesHtml(item, "queue-item__badges")}
        </div>
        <div class="queue-item__actions">
          <button class="queue-btn queue-btn--small" data-queue-action="play-now" data-queue-id="${id}">${escapeHtml(t("queue.playNow"))}</button>
          <button class="queue-btn queue-btn--small" data-queue-action="up" data-queue-id="${id}" ${index === 0 ? "disabled" : ""}>${escapeHtml(t("queue.up"))}</button>
          <button class="queue-btn queue-btn--small queue-btn--danger" data-queue-action="remove" data-queue-id="${id}">${escapeHtml(t("queue.remove"))}</button>
        </div>
      </div>`;
  }

  // Пауза со сроком приходит меткой времени — показываем её в локальном времени
  // пользователя, а не как «через N минут».
  function queuePauseText(snapshot) {
    if (!snapshot.paused) return "";
    if (!snapshot.pausedUntil) return t("queue.paused");
    return t("queue.pausedUntil", { time: formatEventTime(snapshot.pausedUntil) });
  }

  function queueRecoverStatusText(recover) {
    const count = typeof recover.count === "number" ? recover.count : 0;
    if (recover.ok === false && recover.error === "insufficient_scope") return t("queue.recoverScope");
    if (recover.ok === false && recover.error === "not_authorized") return t("queue.recoverNoAuth");
    if (recover.ok === true && count > 0) return t("queue.recoverDone", { count });
    if (recover.ok === true && count === 0) return t("queue.recoverNone");
    return t("queue.recoverFailed", { error: recover.error || "unknown" });
  }

  /*
    Рисует и «Очередь», и «Ожидают»: снимок очереди один, а элементы разошлись по
    двум панелям — «В эфире» и правила остались в очереди, счётчик и список
    ждущих уехали в левую. Поэтому и перерисовка вызывается из одной точки.
  */
  function renderQueuePanel() {
    if (!queuePanelEl) return;
    const snapshot = queueSnapshot || { now: null, items: [], paused: false, pausedUntil: null, rules: {}, stats: {}, pending: 0 };
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    const stats = snapshot.stats || {};
    const rules = snapshot.rules || {};

    if (queueNowCardEl) queueNowCardEl.innerHTML = queueNowCardHtml(snapshot.now);
    if (queueSkipBtn) queueSkipBtn.disabled = !snapshot.now;
    if (queueClearBtn) queueClearBtn.disabled = items.length === 0;

    if (queuePauseStateEl) {
      /*
        Бессрочную паузу видно по самой кнопке — она становится «Продолжить» и
        подсвечивается, — поэтому отдельное слово «Пауза» было бы повтором.
        Строку показываем только у паузы со сроком: там она говорит то, чего на
        кнопке нет, — до какого времени.
      */
      const until = snapshot.paused ? Number(snapshot.pausedUntil) || 0 : 0;
      queuePauseStateEl.textContent = until ? queuePauseText(snapshot) : "";
      queuePauseStateEl.classList.toggle("is-paused", !!snapshot.paused);
    }
    QUEUE_PAUSE_PRESETS.forEach(([btn, minutes]) => {
      if (btn) btn.textContent = t("queue.pauseFor", { count: minutes });
    });
    // Кнопка паузы — переключатель на два действия: в паузе она же становится
    // «Продолжить» и подсвечивается, как включённая (то же поведение в пульте).
    if (queuePauseBtn) {
      queuePauseBtn.textContent = t(snapshot.paused ? "queue.resume" : "queue.pause");
      queuePauseBtn.classList.toggle("is-active", !!snapshot.paused);
    }

    // Поля правил не перебиваем, пока пользователь в них печатает: сервер
    // присылает снимок после каждого изменения очереди, в том числе чужого.
    if (queueMinAmountInput && document.activeElement !== queueMinAmountInput) {
      queueMinAmountInput.value = String(Number(rules.minAmount) || 0);
    }
    if (queueMergeSameUserInput) queueMergeSameUserInput.checked = rules.mergeSameUser !== false;
    if (queueEnabledInput) queueEnabledInput.checked = snapshot.enabled !== false;
    if (queueMergeWindowInput && document.activeElement !== queueMergeWindowInput) {
      const mergeWindow = Number(rules.mergeWindowSec);
      queueMergeWindowInput.value = String(Number.isFinite(mergeWindow) ? mergeWindow : 0);
    }

    if (queuePendingEl) {
      // Выключенная очередь пуста по определению — вместо «Ожидают: 0» говорим
      // прямо, что она не используется.
      queuePendingEl.textContent =
        snapshot.enabled === false ? t("queue.disabled") : t("queue.pending", { count: items.length });
    }
    if (queueStatsEl) {
      const filtered = Number(stats.filtered) || 0;
      const line = t("queue.stats", {
        received: Number(stats.received) || 0,
        played: Number(stats.played) || 0,
        skipped: Number(stats.skipped) || 0,
        merged: Number(stats.merged) || 0,
        filtered,
      });
      queueStatsEl.innerHTML =
        `<div class="queue-stats__line">${escapeHtml(line)}</div>` +
        (filtered > 0 ? `<div class="queue-stats__note">${escapeHtml(t("queue.kindsFiltered", { count: filtered }))}</div>` : "");
    }

    if (queueListEl) {
      queueListEl.innerHTML = items.map((item, index) => queueItemHtml(item, index)).join("");
      queueListEl.hidden = items.length === 0;
      queueListEl.querySelectorAll("[data-queue-action]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.queueId;
          const action = btn.dataset.queueAction;
          if (action === "play-now") send(EVENT_TYPES.CMD_ALERT_QUEUE_PLAY_NOW, { id });
          else if (action === "up") send(EVENT_TYPES.CMD_ALERT_QUEUE_UP, { id });
          else if (action === "remove") send(EVENT_TYPES.CMD_ALERT_QUEUE_REMOVE, { id });
        });
      });
    }
    if (queueEmptyEl) queueEmptyEl.hidden = items.length > 0;

    if (queueRecoverBtn) {
      queueRecoverBtn.disabled = queueRecoverPending;
      queueRecoverBtn.textContent = queueRecoverPending ? t("queue.recovering") : t("queue.recover");
    }
    if (queueRecoverStatusEl) {
      queueRecoverStatusEl.hidden = !queueRecoverStatus;
      queueRecoverStatusEl.textContent = queueRecoverStatus;
      queueRecoverStatusEl.classList.toggle("is-error", !!queueRecoverStatus && !queueRecoverOk);
    }
  }

  function applyQueuePayload(queue, recover) {
    if (queue) queueSnapshot = queue;
    if (recover) {
      if (queueRecoverTimer) { clearTimeout(queueRecoverTimer); queueRecoverTimer = null; }
      queueRecoverPending = false;
      queueRecoverOk = recover.ok === true;
      queueRecoverStatus = queueRecoverStatusText(recover);
    }
    // Список ожидающих лежит в своей панели: перерисовываем, если открыта любая
    // из двух — вдруг одну из них когда-нибудь откроют отдельно от соседки.
    const anyOpen = [queuePanelEl, pendingPanelEl].some((panel) => panel && !panel.hidden);
    if (anyOpen) renderQueuePanel();
  }

  /*
    Очередь и «Ожидают» — панели-спутники «DA»: своей кнопки в шапке у них нет,
    состояние они делят с панелью DonationAlerts (см. setDaOpen), поэтому здесь
    только показ и перерисовка.
  */
  function setQueueOpen(open) {
    if (queuePanelEl) queuePanelEl.hidden = !open;
    if (pendingPanelEl) pendingPanelEl.hidden = !open;
    if (open) renderQueuePanel();
  }

  // Крестик стоит только на правой панели тройки, поэтому закрывает все три —
  // иначе спутники остались бы висеть одни, без единого способа их убрать.
  const daCloseBtn = document.getElementById("daCloseBtn");
  if (daCloseBtn) daCloseBtn.addEventListener("click", () => setQueueOpen(false));

  if (queueSkipBtn) queueSkipBtn.addEventListener("click", () => send(EVENT_TYPES.CMD_ALERT_QUEUE_SKIP, {}));
  if (queueClearBtn) queueClearBtn.addEventListener("click", () => send(EVENT_TYPES.CMD_ALERT_QUEUE_CLEAR, {}));
  if (queuePauseBtn) {
    queuePauseBtn.addEventListener("click", () => {
      // Что делать — решает последний снимок сервера, а не подпись на кнопке:
      // пауза ставится без срока, до повторного нажатия.
      const paused = !!(queueSnapshot && queueSnapshot.paused);
      send(paused ? EVENT_TYPES.CMD_ALERT_QUEUE_RESUME : EVENT_TYPES.CMD_ALERT_QUEUE_PAUSE, {});
    });
  }
  QUEUE_PAUSE_PRESETS.forEach(([btn, minutes]) => {
    if (btn) btn.addEventListener("click", () => send(EVENT_TYPES.CMD_ALERT_QUEUE_PAUSE, { minutes }));
  });

  if (queueEnabledInput) {
    queueEnabledInput.addEventListener("change", () => {
      send(EVENT_TYPES.CMD_ALERT_QUEUE_CONFIG, { enabled: queueEnabledInput.checked });
    });
  }
  if (queueMinAmountInput) {
    queueMinAmountInput.addEventListener("change", () => {
      const value = Math.max(0, Math.round(Number(queueMinAmountInput.value) || 0));
      queueMinAmountInput.value = String(value);
      send(EVENT_TYPES.CMD_ALERT_QUEUE_CONFIG, { minAmount: value });
    });
  }
  if (queueMergeSameUserInput) {
    queueMergeSameUserInput.addEventListener("change", () => {
      send(EVENT_TYPES.CMD_ALERT_QUEUE_CONFIG, { mergeSameUser: queueMergeSameUserInput.checked });
    });
  }
  if (queueMergeWindowInput) {
    queueMergeWindowInput.addEventListener("change", () => {
      const value = clamp(Math.round(Number(queueMergeWindowInput.value) || 0), 0, 600);
      queueMergeWindowInput.value = String(value);
      send(EVENT_TYPES.CMD_ALERT_QUEUE_CONFIG, { mergeWindowSec: value });
    });
  }

  if (queueRecoverBtn) {
    queueRecoverBtn.addEventListener("click", () => {
      if (queueRecoverPending) return;
      queueRecoverPending = true;
      queueRecoverStatus = "";
      if (queueRecoverTimer) clearTimeout(queueRecoverTimer);
      queueRecoverTimer = setTimeout(() => {
        queueRecoverTimer = null;
        queueRecoverPending = false;
        renderQueuePanel();
      }, QUEUE_RECOVER_TIMEOUT_MS);
      renderQueuePanel();
      send(EVENT_TYPES.CMD_RECOVER_DONATIONS, {});
    });
  }

  // ---- panel manager: keep only one panel open at a time ----
  /*
    «DA», «Очередь» и «Ожидают» — одна тройка экранов, как «Колесо» и
    «Участники»: открытие и закрытие идёт через одну точку, а спутники DA в
    реестре не значатся — иначе Escape и переключение панелей убирали бы их
    отдельно от DA.
  */
  function setDaOpen(open) {
    daPanel.setOpen(open);
    setQueueOpen(open);
  }

  const panelRegistry = [
    { id: "terminalPanel", setOpen: loggerPanel.setOpen },
    { id: "debugPanel", setOpen: debugPanel.setOpen },
    { id: "helpPanel", setOpen: helpPanel.setOpen },
    { id: "historyPanel", setOpen: setHistoryOpen },
    { id: "wheelPanel", setOpen: setWheelOpen },
    { id: "pollPanel", setOpen: setPollOpen },
    { id: "daPanel", setOpen: setDaOpen },
  ];

  function panelIsOpen(id) {
    const el = document.getElementById(id);
    return !!el && !el.hidden;
  }

  function togglePanelById(id) {
    const entry = panelRegistry.find((p) => p.id === id);
    if (!entry) return;
    if (panelIsOpen(id)) {
      entry.setOpen(false);
    } else {
      panelRegistry.forEach((p) => p.setOpen(false));
      entry.setOpen(true);
    }
  }

  [
    ["toggleTerminalBtn", "terminalPanel"],
    ["toggleDebugBtn", "debugPanel"],
    ["toggleHelpBtn", "helpPanel"],
    ["toggleHistoryBtn", "historyPanel"],
    ["toggleWheelBtn", "wheelPanel"],
    ["togglePollBtn", "pollPanel"],
    ["toggleDaBtn", "daPanel"],
  ].forEach(([btnId, panelId]) => {
    const btn = document.getElementById(btnId);
    if (btn) btn.addEventListener("click", () => togglePanelById(panelId));
  });

  // ---- local hotkeys for panels - не мешают вводу текста ----
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
      const open = panelRegistry.find((p) => panelIsOpen(p.id));
      if (open) open.setOpen(false);
      return;
    }
    if (panelIsOpen("historyPanel") && (e.key === "1" || e.key === "2" || e.key === "3")) {
      setHistoryTab({ "1": "events", "2": "sessions", "3": "chat" }[e.key]);
    }
  });

  // ---- websocket ----
  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE:
        state.applySnapshot(msg.payload);
        applyQueuePayload(msg.payload.alertQueue, null);
        daPanel.applySnapshot(msg.payload);
        if (msg.payload.port && Number(msg.payload.port) !== Number(port)) {
          setAppPort(msg.payload.port);
        }
        if (msg.payload.remoteUrl) {
          remoteUrlText.textContent = msg.payload.remoteUrl;
          remoteUrlHint.hidden = false;
          renderAccessUrl(msg.payload.remoteUrl);
        }
        wsClient.setStatuses(msg.payload.connectionStatus);
        gridSizeSelect.value = String(state.editorPrefs.gridSize || 0);
        aspectRatioSelect.value = state.editorPrefs.aspectRatio || "16:9";
        canvasEditor.applyThemeToCanvas(state.appearance.tokens, state.appearance.activeThemeId, state.appearance.customCss || "");
        canvasEditor.applyCanvasRatio();
        renderThemeGrid();
        renderLayoutPresets();
        renderLibrary();
        canvasEditor.renderCanvas();
        canvasEditor.renderLayers();
        propertiesPanel.render();
        populateSettings();
        renderSceneBudget();
        syncIntegrationSwitches();
        if (!wheelPanelEl.hidden) renderWheelPanels();
        if (!pollPanelEl.hidden) renderPollPanels();
        selectScene(state.activeSceneId);
        syncMicBridge();
        break;
      case EVENT_TYPES.LAYOUT_UPDATE:
        handleLayoutUpdate(msg.payload.layout || []);
        break;
      case EVENT_TYPES.LAYOUT_PRESETS_UPDATE:
        state.layoutPresets = (msg.payload && msg.payload.presets) || [];
        renderLayoutPresets();
        break;
      case EVENT_TYPES.SESSION_STATS:
        // Счёт донатов текущего стрима складывает сервер в момент прихода доната
        // (см. state.addDonationToSession), поэтому панель только показывает его.
        state.sessionDonations = msg.payload;
        daPanel.applySessionStats(msg.payload);
        // Канвас держит превью «Счётчика» — как и на STAT_UPDATE, перерисовываем.
        canvasEditor.renderCanvas();
        break;
      case EVENT_TYPES.ALERT:
        // Список донатов в панели DonationAlerts читается из базы, а запись в неё
        // уже сделана сервером — поэтому здесь только просьба перечитать его.
        // Панель сама стягивает серию (и тестовые алерты в список не берёт).
        if (msg.payload && msg.payload.kind === "donation" && !msg.payload.isTest) daPanel.refreshDonations();
        break;
      case EVENT_TYPES.ALERT_QUEUE_UPDATE:
        applyQueuePayload(msg.payload && msg.payload.queue, (msg.payload && msg.payload.recover) || null);
        // Ответ на «подтянуть пропущенные» показывают обе панели: кнопка есть и в
        // очереди, и в DonationAlerts, а событие одно на всех.
        if (msg.payload && msg.payload.recover) daPanel.showRecoverResult(msg.payload.recover);
        break;
      case EVENT_TYPES.TWITCH_ACTION_RESULT:
        showTwitchActionResult(msg.payload || {});
        break;
      case EVENT_TYPES.THEME_UPDATE:
        state.appearance = msg.payload;
        if (!state.editingThemeId) canvasEditor.applyThemeToCanvas(state.appearance.tokens, state.appearance.activeThemeId, state.appearance.customCss || "");
        renderThemeGrid();
        renderLibrary();
        canvasEditor.renderCanvas();
        canvasEditor.renderLayers();
        renderSceneBudget();
        break;
      case EVENT_TYPES.THEME_DRAFT_PREVIEW:
        if (msg.payload && !msg.payload.clear && msg.payload.tokens) {
          canvasEditor.applyThemeToCanvas(msg.payload.tokens, msg.payload.themeId || "", msg.payload.customCss || "");
        } else {
          canvasEditor.applyThemeToCanvas(state.appearance.tokens, state.appearance.activeThemeId, state.appearance.customCss || "");
        }
        break;
      case EVENT_TYPES.EDITOR_PREFS_UPDATE:
        state.editorPrefs = msg.payload;
        gridSizeSelect.value = String(state.editorPrefs.gridSize || 0);
        aspectRatioSelect.value = state.editorPrefs.aspectRatio || "16:9";
        canvasEditor.applyCanvasRatio();
        break;
      case EVENT_TYPES.HUD_HOTKEY_UPDATE:
        state.hudEditHotkey = (msg.payload && msg.payload.hotkey) || state.hudEditHotkey;
        if (hudHotkeyInput) {
          hudHotkeyInput.value = state.hudEditHotkey;
          if (msg.payload && msg.payload.ok === false) {
            hudHotkeyInput.classList.add("is-invalid");
            setTimeout(() => hudHotkeyInput.classList.remove("is-invalid"), 2000);
          } else {
            hudHotkeyInput.classList.remove("is-invalid");
          }
        }
        break;
      case EVENT_TYPES.HUD_DISPLAY_UPDATE:
        state.hudDisplayId = (msg.payload && msg.payload.displayId != null) ? msg.payload.displayId : null;
        syncHudDisplaySelect();
        break;
      case EVENT_TYPES.CHAT_HUD_HOTKEY_UPDATE:
        state.chatHudHotkey = (msg.payload && msg.payload.hotkey) || state.chatHudHotkey;
        if (chatHudHotkeyInput) {
          chatHudHotkeyInput.value = state.chatHudHotkey;
          if (msg.payload && msg.payload.ok === false) {
            chatHudHotkeyInput.classList.add("is-invalid");
            setTimeout(() => chatHudHotkeyInput.classList.remove("is-invalid"), 2000);
          } else {
            chatHudHotkeyInput.classList.remove("is-invalid");
          }
        }
        break;
      case EVENT_TYPES.CHAT_HUD_DISPLAY_UPDATE:
        state.chatHudDisplayId = (msg.payload && msg.payload.displayId != null) ? msg.payload.displayId : null;
        syncChatHudDisplaySelect();
        break;
      case EVENT_TYPES.CHAT_HUD_CONFIG_UPDATE:
        state.chatHud = (msg.payload && msg.payload.config) || state.chatHud;
        renderChatHudConfig();
        break;
      case EVENT_TYPES.SCENES_UPDATE:
        state.scenes = msg.payload;
        renderSceneForm();
        renderSplashSettings();
        break;
      case EVENT_TYPES.TOP_DONATION_UPDATE:
        state.topDonation = msg.payload;
        renderSceneForm();
        canvasEditor.renderCanvas();
        break;
      case EVENT_TYPES.STAT_UPDATE:
        state.stats = msg.payload;
        canvasEditor.renderCanvas();
        break;
      case EVENT_TYPES.DEATH_COUNT_UPDATE:
        state.deathCount = (msg.payload && msg.payload.count) || 0;
        canvasEditor.renderCanvas();
        break;
      case EVENT_TYPES.CAMERA_ANGLE_UPDATE:
        state.activeCameraAngle = (msg.payload && msg.payload.activeCameraAngle) || null;
        renderCameraAngles();
        break;
      case EVENT_TYPES.CAMERA_FILTER_UPDATE:
        if (msg.payload && msg.payload.filterId) {
          const set = new Set(state.activeFilters || []);
          if (msg.payload.active) set.add(msg.payload.filterId);
          else set.delete(msg.payload.filterId);
          state.activeFilters = [...set];
        }
        renderCameraFilters();
        break;
      case EVENT_TYPES.GIVEAWAY_UPDATE:
        state.giveaway = msg.payload.giveaway || state.giveaway;
        renderGiveaway();
        break;
      case EVENT_TYPES.OVERLAY_PARTICIPANTS_CONFIG:
        state.participantsConfig = (msg.payload && msg.payload.config) || state.participantsConfig;
        canvasEditor.renderCanvas();
        propertiesPanel.render();
        if (!wheelPanelEl.hidden) renderWheelPanel();
        break;
      case EVENT_TYPES.LONGSHOT_UPDATE:
        state.longshot = (msg.payload && msg.payload.longshot) || state.longshot;
        propertiesPanel.render();
        break;
      case EVENT_TYPES.WHEEL_CONFIG:
        state.wheelConfig = (msg.payload && msg.payload.config) || state.wheelConfig;
        if (!wheelPanelEl.hidden) renderWheelPanel();
        break;
      case EVENT_TYPES.WHEEL_SPEED_CONFIG:
        state.wheelSpeedConfig = (msg.payload && msg.payload.config) || state.wheelSpeedConfig;
        if (!wheelPanelEl.hidden) renderWheelPanel();
        break;
      case EVENT_TYPES.POLL_UPDATE:
        state.poll = (msg.payload && msg.payload.poll) || state.poll;
        if (!pollPanelEl.hidden) renderPollOptions();
        break;
      case EVENT_TYPES.POLL_PRESETS_UPDATE:
        state.pollPresets = (msg.payload && msg.payload.presets) || [];
        renderPollPresets();
        break;
      case EVENT_TYPES.OVERLAY_MIC_CONFIG:
        state.micConfig = (msg.payload && msg.payload.config) || state.micConfig;
        canvasEditor.renderCanvas();
        propertiesPanel.render();
        break;
      case EVENT_TYPES.GOAL_UPDATE:
        state.goal = msg.payload;
        canvasEditor.renderCanvas();
        propertiesPanel.render();
        break;
      case EVENT_TYPES.CONNECTION_STATUS:
        state.connectionStatus[msg.payload.service] = msg.payload.status;
        wsClient.updateStatus(msg.payload.service, msg.payload.status);
        if (msg.payload.service === "donationAlerts") daPanel.applyStatus(msg.payload.status);
        canvasEditor.renderCanvas();
        canvasEditor.renderLayers();
        break;
      case EVENT_TYPES.LOCALES:
        applyLocales(msg.payload && msg.payload.lang, msg.payload && msg.payload.locales);
        break;
      case EVENT_TYPES.TERMINAL_LOG:
        loggerPanel.append(msg.payload);
        // У той же записи есть второй адресат: панель DonationAlerts копит
        // только «свои» строки, чтобы после сбоя было видно, что происходило
        // с сервисом, — в общем терминале они тонут среди остальных сервисов.
        daPanel.appendLog(msg.payload);
        break;
      case EVENT_TYPES.DEBUG_LOG:
        debugPanel.appendDebug(msg.payload);
        break;
      case EVENT_TYPES.CLEAR_TERMINAL:
        loggerPanel.clear();
        break;
      case EVENT_TYPES.CLI_COMPLETIONS:
        loggerPanel.applyCompletions(msg.payload || {});
        break;
      case EVENT_TYPES.TERMINAL_FILTER:
        loggerPanel.setFilter((msg.payload && msg.payload.level) || "all");
        break;
      case EVENT_TYPES.RECENT_EVENT:
        showAlertToast(msg.payload);
        if (state.notificationSound !== false) playNotificationSound();
        break;
      default:
        break; // ALERT / CHAT_MESSAGE are for the overlay, not the editor
    }
  }

  function updateLanguageButtons() {
    const lang = window.I18n ? window.I18n.getLang() : "en";
    document.querySelectorAll("#languageSwitcher [data-lang]").forEach((btn) => {
      const active = btn.dataset.lang === lang;
      btn.classList.toggle("md-button--filled", active);
      btn.classList.toggle("md-button--tonal", !active);
    });
  }

  function applyLocales(lang, locales) {
    if (window.I18n) {
      window.I18n.setLocales(locales);
      window.I18n.setLang(lang);
      window.I18n.apply();
    }
    updateLanguageButtons();
    renderLibrary();
    renderScenesNav();
    canvasEditor.renderCanvas();
    canvasEditor.renderLayers();
    propertiesPanel.render();
    renderSceneForm();
    if (!wheelPanelEl.hidden) renderWheelPanels();
    if (!pollPanelEl.hidden) renderPollPanels();
    renderThemeGrid();
    renderLayoutPresets();
    wsClient.refreshStatusChips();
    updateEventsFilterButtons();
    refreshHistoryTab();
    renderDataStats();
    renderSceneBudget();
    copyUrlBtn.textContent = t("editor.copyUrl");
    renderUpdateCheckButton();
    copySceneUrlBtn.textContent = t("scenes.copyUrl");
    exportConfigBtn.textContent = t("settings.export");
    importConfigBtn.textContent = t("settings.import");
    const chatBtn = document.getElementById("openChatWindowBtn");
    if (chatBtn) chatBtn.innerHTML = `${ICONS.widgetChat} ${t("editor.chat")}`;
    const historyBtn = document.getElementById("toggleHistoryBtn");
    if (historyBtn) historyBtn.innerHTML = `${ICONS.widgetRecent} ${t("nav.history")}`;
    const wheelBtn = document.getElementById("toggleWheelBtn");
    if (wheelBtn) wheelBtn.innerHTML = `${ICONS.sceneWheel} ${t("nav.wheel")}`;
    const pollBtn = document.getElementById("togglePollBtn");
    if (pollBtn) pollBtn.innerHTML = `${ICONS.scenePoll} ${t("nav.poll")}`;
    renderQueuePanel();
    daPanel.refreshLabel();
    loggerPanel.refreshLabel();
    debugPanel.refresh();
    helpPanel.refresh();
    const boostyBtn = document.getElementById("openBoostyBtn");
    if (boostyBtn) boostyBtn.innerHTML = `${ICONS.heart} ${t("boosty.support")}`;
  }

  // Диагностика «бюджета сцены»: сколько анимированных 3D-виджетов (у каждого
  // собственный canvas-цикл) сейчас видно и какую долю площади канваса они
  // занимают. Помогает держаться ориентира «2–3 тяжёлых виджета».
  function renderSceneBudget() {
    if (!sceneBudgetEl || typeof isAnimatedWidget !== "function") return;
    const active3d = (state.appearance && state.appearance.active3dWidgets) || [];
    let count = 0;
    let area = 0;
    (state.layout || []).forEach((item) => {
      if (!item || item.visible === false) return;
      const type = resolveTypeForTheme ? resolveTypeForTheme(item.type, active3d) : item.type;
      if (!isAnimatedWidget(type)) return;
      count += 1;
      area += ((Number(item.w) || 0) * (Number(item.h) || 0)) / 100; // % площади экрана
    });
    if (!count) {
      sceneBudgetEl.hidden = true;
      sceneBudgetEl.textContent = "";
      return;
    }
    const areaPct = Math.round(area);
    sceneBudgetEl.hidden = false;
    sceneBudgetEl.textContent = t("editor.perfBudget", { count, area: areaPct });
    sceneBudgetEl.classList.toggle("is-heavy", count > 3 || areaPct >= 80);
  }

  function handleLayoutUpdate(newLayout) {
    state.layout = newLayout;
    if (state.pendingAdd) {
      const newItem = state.layout.find((w) => !state.pendingAdd.knownIds.has(w.id));
      if (newItem) {
        if (state.pendingAdd.dropXY) {
          const x = clamp(state.pendingAdd.dropXY.x - newItem.w / 2, 0, 100 - newItem.w);
          const y = clamp(state.pendingAdd.dropXY.y - newItem.h / 2, 0, 100 - newItem.h);
          send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: newItem.id, patch: { x: round1(x), y: round1(y) } });
        }
        state.selectedId = newItem.id;
      }
      state.pendingAdd = null;
    }
    if (state.selectedId && !state.layout.find((w) => w.id === state.selectedId)) state.selectedId = null;
    canvasEditor.renderCanvas();
    canvasEditor.renderLayers();
    propertiesPanel.render();
    renderSceneBudget();
    syncMicBridge();
  }

  // ---- microphone bridge ----------------------------------------------
  // The overlay can't reliably capture the mic inside OBS Browser Source
  // (getUserMedia is blocked / insecure context). Instead, this control panel
  // captures the mic (Electron grants media) and forwards downsampled levels
  // to the server, which broadcasts them to the overlay visualizer.
  //
  // Кадры уходят бинарно (см. shared/mic-frame.js): ~371 Б вместо ~1.4 КБ JSON,
  // и сервер пересылает их без JSON.parse/stringify. Интервал — ~30 Гц (33 мс):
  // это осознанный компромисс между плавностью и нагрузкой, понижать дальше
  // нечего, а 40 Гц было бы даже чаще.
  const MIC_FRAME_INTERVAL_MS = 33;
  // Захват асинхронный: getUserMedia отвечает через секунды, а за это время мост
  // могли остановить (виджет убрали) или перезапустить (сменили устройство).
  // Поколение отличает актуальный ответ от опоздавшего.
  const micCapture = createCaptureGeneration();
  const micBridge = {
    running: false,
    stream: null,
    ctx: null,
    analyser: null,
    timer: null,
    dataArray: null,
    freqArray: null,
    wave: null,
    freq: null,
    frame: null,

    start() {
      if (this.running) return;
      this.running = true;
      const generation = micCapture.begin();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.warn("[mic-bridge] getUserMedia unavailable in the control panel");
        this.running = false;
        return;
      }
      navigator.mediaDevices.getUserMedia({ audio: this._constraints() })
        .then((stream) => {
          // Поток получили после stop()/restart: молча отпускаем его, иначе
          // микрофон остаётся захваченным — stop() про этот поток уже не знает.
          if (!this.running || micCapture.isStale(generation)) { stream.getTracks().forEach((tr) => tr.stop()); return; }
          const ctx = new Ctx();
          if (ctx.state === "suspended") ctx.resume().catch(() => {});
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0.6;
          source.connect(analyser);
          this.stream = stream;
          this.ctx = ctx;
          this.analyser = analyser;
          this.dataArray = new Uint8Array(analyser.fftSize);
          this.freqArray = new Uint8Array(analyser.frequencyBinCount);
          this.wave = new Uint8Array(240);
          this.freq = new Uint8Array(128);
          this.frame = MicFrame ? new Uint8Array(MicFrame.FRAME_LEN) : null;
          if (!this.timer) this.timer = setInterval(() => this.tick(), MIC_FRAME_INTERVAL_MS);
        })
        .catch((err) => {
          // Отказ устаревшего запроса ничего не говорит о текущем захвате.
          if (micCapture.isStale(generation)) return;
          this.running = false;
          console.warn("[mic-bridge] microphone unavailable:", (err && err.name) || "unknown");
        });
    },

    tick() {
      if (!this.analyser) return;
      const a = this.analyser;
      a.getByteTimeDomainData(this.dataArray);
      const d = this.dataArray;
      const dl = d.length;
      const w = this.wave;
      for (let i = 0; i < 240; i++) w[i] = d[Math.floor((i / 240) * dl)];
      a.getByteFrequencyData(this.freqArray);
      const f = this.freqArray;
      const fl = f.length;
      const usable = Math.max(8, Math.floor(fl * 0.8));
      const fr = this.freq;
      const fn = fr.length;
      for (let i = 0; i < fn; i++) fr[i] = f[Math.floor((i / fn) * (usable - 1))];
      let sum = 0;
      for (let i = 0; i < dl; i++) { const v = (d[i] - 128) / 128; sum += v * v; }
      const level = Math.sqrt(sum / dl);
      if (MicFrame) sendBinary(MicFrame.encode(level, w, fr, this.frame));
      else send(EVENT_TYPES.MIC_AUDIO_DATA, { level, wave: Array.from(w), freq: Array.from(fr) });
      updateMicLevelMeter(level);
    },

    _constraints() {
      const cfg = state.micConfig || {};
      const audio = {
        echoCancellation: cfg.echoCancellation !== false,
        noiseSuppression: cfg.noiseSuppression !== false,
        autoGainControl: cfg.autoGainControl !== false,
      };
      if (cfg.deviceId) audio.deviceId = { exact: cfg.deviceId };
      return audio;
    },

    // Перезапуск с новым устройством/опциями захвата.
    restartIfRunning() {
      if (!this.running) return;
      this.stop();
      this.start();
    },

    stop() {
      this.running = false;
      // Поколение закрывает все незавершённые getUserMedia: их результат уже
      // неактуален и будет отброшен (см. комментарий в start).
      micCapture.invalidate();
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this.stream) { this.stream.getTracks().forEach((tr) => tr.stop()); this.stream = null; }
      if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
      this.analyser = null;
    },
  };

  function syncMicBridge() {
    const hasMic = Array.isArray(state.layout) && state.layout.some((w) => w.type === "mic");
    if (hasMic) micBridge.start();
    else micBridge.stop();
  }

  // ---- auto-updates ----
  if (window.desktop && window.desktop.onUpdateAvailable) {
    // При наличии обновления (например, после стартовой проверки) просто
    // зажигаем кнопку «Обновить» в шапке: ни баннера, ни системного
    // уведомления — установка идёт из меню этой кнопки.
    window.desktop.onUpdateAvailable((info) => applyKnownUpdate(info && info.version));
  }

  if (libraryListEl) libraryListEl.addEventListener("scroll", hideWidgetTooltip);

  /*
    Кнопка проверки в «Настройки → Приложение» живёт в двух состояниях: пока
    обновления нет — «Проверить обновления», а когда оно найдено — «Обновить и
    перезапустить». Иначе после проверки установку пришлось бы искать в другом
    месте (она есть в меню кнопки версии в шапке), а кнопка, которая только что
    нашла обновление, продолжала бы предлагать «проверить».
  */
  function renderUpdateCheckButton() {
    if (!checkUpdatesBtn) return;
    const key = knownUpdateVersion ? "settings.updateAndRestart" : "settings.checkUpdates";
    const label = t(key);
    // До прихода словарей (они едут по WebSocket) t() отдаёт сам ключ — тогда
    // оставляем текст из разметки, чтобы кнопка не мигала
    // «settings.checkUpdates»; верная подпись придёт вместе с applyLocales().
    if (label && label !== key) checkUpdatesBtn.textContent = label;
  }

  function installKnownUpdate() {
    if (window.desktop && window.desktop.downloadAndInstall) window.desktop.downloadAndInstall();
  }

  async function runUpdateCheck() {
    if (!window.desktop || !window.desktop.checkForUpdates) {
      checkUpdatesStatus.textContent = t("settings.updateUnavailable");
      return;
    }
    checkUpdatesBtn.disabled = true;
    checkUpdatesStatus.textContent = t("settings.updateChecking");
    try {
      const res = await window.desktop.checkForUpdates();
      if (!res || !res.ok) {
        checkUpdatesStatus.textContent = t("settings.updateUnavailable");
      } else if (res.updateAvailable && res.version) {
        applyKnownUpdate(res.version);
        checkUpdatesStatus.textContent = t("settings.updateAvailable", { version: res.version });
      } else {
        // Обновления нет — снимаем подсказку, если версия была известна раньше.
        applyKnownUpdate(null);
        checkUpdatesStatus.textContent = t("settings.updateNone");
      }
    } catch {
      checkUpdatesStatus.textContent = t("settings.updateError");
    } finally {
      checkUpdatesBtn.disabled = false;
      renderUpdateCheckButton();
    }
  }

  if (checkUpdatesBtn && checkUpdatesStatus) {
    checkUpdatesBtn.addEventListener("click", () => {
      if (knownUpdateVersion) installKnownUpdate();
      else runUpdateCheck();
    });
    renderUpdateCheckButton();
  }
