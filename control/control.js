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
import { initWsClient } from "./modules/ws-client.js";
import { createStateManager } from "./modules/state-manager.js";
import { initPropertiesPanel } from "./modules/properties-panel.js";
import { initCanvasEditor } from "./modules/canvas-editor.js";

const { EVENT_TYPES } = window.SharedEvents;
  const { ICONS } = window.SharedIcons;
  const { WIDGET_TYPES } = window.WidgetCatalog;
  const t = (key, params) => (window.I18n ? window.I18n.t(key, params) : key);

  const params = new URLSearchParams(location.search);
  const port = params.get("port") || "8710";
  const wsUrl = `ws://localhost:${port}/ws`;
  const overlayUrl = `http://localhost:${port}/overlay/overlay.html`;

  const wsClient = initWsClient({ url: wsUrl, t, onMessage: handleMessage, onStatusClick });
  const send = wsClient.send;

  // ---- state ----
  const state = createStateManager();

  // ---- dom refs ----
  const tabsEl = document.getElementById("tabs");
  const viewEditor = document.getElementById("view-editor");
  const viewScenes = document.getElementById("view-scenes");
  const viewSettings = document.getElementById("view-settings");
  const libraryListEl = document.getElementById("libraryList");
  const obsUrlLabel = document.getElementById("obsUrlLabel");
  const copyUrlBtn = document.getElementById("copyUrlBtn");
  const remoteUrlHint = document.getElementById("remoteUrlHint");
  const remoteUrlText = document.getElementById("remoteUrlText");
  const gridSizeSelect = document.getElementById("gridSizeSelect");
  const themeGridEl = document.getElementById("themeGrid");
  const themeEditorEl = document.getElementById("themeEditor");
  const newThemeBtn = document.getElementById("newThemeBtn");
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
  const obsSceneMainInput = document.getElementById("obsSceneMain");
  const obsSceneStartInput = document.getElementById("obsSceneStart");
  const obsSceneBrbInput = document.getElementById("obsSceneBrb");
  const obsSceneTalkInput = document.getElementById("obsSceneTalk");
  const obsSceneEndInput = document.getElementById("obsSceneEnd");
  const obsSceneWheelInput = document.getElementById("obsSceneWheel");
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
  const soundboardList = document.getElementById("soundboardList");
  const addSoundBtn = document.getElementById("addSoundBtn");
  const streamdeckIconStart = document.getElementById("streamdeckIconStart");
  const streamdeckIconBrb = document.getElementById("streamdeckIconBrb");
  const streamdeckIconWheel = document.getElementById("streamdeckIconWheel");
  const streamdeckIconTalk = document.getElementById("streamdeckIconTalk");
  const streamdeckIconEnd = document.getElementById("streamdeckIconEnd");
  const appPortInput = document.getElementById("appPort");
  const savePortBtn = document.getElementById("savePortBtn");
  const appOverlayUrlInput = document.getElementById("appOverlayUrl");
  const eventsHistoryEl = document.getElementById("eventsHistory");
  const refreshEventsBtn = document.getElementById("refreshEventsBtn");
  const loadMoreEventsBtn = document.getElementById("loadMoreEventsBtn");
  const eventsFiltersEl = document.getElementById("eventsFilters");
  const eventsSearchInput = document.getElementById("eventsSearch");
  const clearEventsBtn = document.getElementById("clearEventsBtn");
  const eventsMetaEl = document.getElementById("eventsMeta");

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
  function switchView(view) {
    tabsEl.querySelectorAll(".topbar__tab").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.view === view);
    });
    viewEditor.hidden = view !== "editor";
    viewScenes.hidden = view !== "scenes";
    viewSettings.hidden = view !== "settings";
    if (view === "settings") renderStreamEvents();
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
  function renderLibrary() {
    libraryListEl.innerHTML = "";
    Object.values(WIDGET_TYPES).forEach((def) => {
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
      obsPasswordInput.value = state.obs.password || "";
      const sm = state.obs.sceneMap || {};
      obsSceneMainInput.value = sm.main || "";
      obsSceneStartInput.value = sm.start || "";
      obsSceneBrbInput.value = sm.brb || "";
      obsSceneTalkInput.value = sm.talk || "";
      obsSceneEndInput.value = sm.end || "";
      obsSceneWheelInput.value = sm.wheel || "";
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
    renderStreamDeckIcons();
    appPortInput.value = port;
    appOverlayUrlInput.value = overlayUrl;
    twitchRedirectUriEl.textContent = `http://localhost:${port}/oauth/twitch/callback`;
    daRedirectUriEl.textContent = `http://localhost:${port}/oauth/donationalerts/callback`;
    youtubeRedirectUriEl.textContent = `http://localhost:${port}/oauth/youtube/callback`;
  }

  twitchChannelInput.addEventListener("change", () => {
    send(EVENT_TYPES.CMD_SET_APP_CONFIG, { twitchChannel: twitchChannelInput.value.trim() });
  });

  savePortBtn.addEventListener("click", () => {
    const port = Number(appPortInput.value);
    if (!port || port < 1024 || port > 65535) return;
    send(EVENT_TYPES.CMD_SET_APP_CONFIG, { port });
  });

  youtubeVideoIdInput.addEventListener("change", () => {
    send(EVENT_TYPES.CMD_SET_YOUTUBE_VIDEO_ID, { videoId: youtubeVideoIdInput.value.trim() });
  });

  function sendObsConfig(patch) {
    send(EVENT_TYPES.CMD_SET_OBS_CONFIG, patch);
  }
  obsHostInput.addEventListener("change", () => sendObsConfig({ host: obsHostInput.value.trim() }));
  obsPortInput.addEventListener("change", () => sendObsConfig({ port: Number(obsPortInput.value) || 4455 }));
  obsPasswordInput.addEventListener("change", () => sendObsConfig({ password: obsPasswordInput.value }));
  obsSceneMainInput.addEventListener("change", () => sendObsConfig({ sceneMap: { main: obsSceneMainInput.value.trim() } }));
  obsSceneStartInput.addEventListener("change", () => sendObsConfig({ sceneMap: { start: obsSceneStartInput.value.trim() } }));
  obsSceneBrbInput.addEventListener("change", () => sendObsConfig({ sceneMap: { brb: obsSceneBrbInput.value.trim() } }));
  obsSceneTalkInput.addEventListener("change", () => sendObsConfig({ sceneMap: { talk: obsSceneTalkInput.value.trim() } }));
  obsSceneEndInput.addEventListener("change", () => sendObsConfig({ sceneMap: { end: obsSceneEndInput.value.trim() } }));
  obsSceneWheelInput.addEventListener("change", () => sendObsConfig({ sceneMap: { wheel: obsSceneWheelInput.value.trim() } }));

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
      let parsed = {};
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
    makeStreamDeckIconField(streamdeckIconEnd, "end", "media/...png");
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

    row.append(reward, audioWrap, imageWrap, test, remove);
    return row;
  }

  function renderSoundboard() {
    soundboardList.innerHTML = "";
    (state.soundboard.sounds || []).forEach((sound) => {
      soundboardList.appendChild(renderSoundboardItem(sound));
    });
  }

  addSoundBtn.addEventListener("click", () => {
    const sounds = [...(state.soundboard.sounds || []), { id: "sound_" + Date.now(), rewardTitle: "", rewardId: "", audioFile: "", imageFile: "", title: "" }];
    sendSoundboardConfig({ sounds });
  });

  soundboardVolume.addEventListener("input", (e) => {
    soundboardVolumeValue.textContent = `${e.target.value}%`;
  });
  soundboardVolume.addEventListener("change", (e) => {
    sendSoundboardConfig({ volume: Number(e.target.value) / 100 });
  });

  wireSwitch(soundboardQueueSwitch, (on) => sendSoundboardConfig({ queueMode: on }));
  wireSwitch(soundboardEnabledSwitch, (on) => sendSoundboardConfig({ enabled: on }));

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

  // ---- events history ----
  const EVENTS_TYPE_LABEL = (type) =>
    ({ donation: t("events.donation"), subscription: t("events.subscription"), follow: t("events.follow"), cheer: t("events.cheer") }[type] || type);
  const EVENTS_PAGE_SIZE = 20;
  let eventsOffset = 0;
  let eventsTotal = 0;
  let eventsFilter = "all";
  let eventsSearch = "";
  let eventsSearchTimer = null;

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
    } catch (err) {
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

  // ---- giveaway / fortune wheel ----
  function renderGiveaway() {
    const commandEl = document.getElementById("giveawayCommand");
    if (!commandEl) return; // wheel scene form not currently rendered
    if (document.activeElement !== commandEl) {
      commandEl.value = state.giveaway.command || "!go";
    }
    const countEl = document.getElementById("giveawayCount");
    const chipEl = document.getElementById("giveawayChip");
    const listEl = document.getElementById("giveawayParticipants");
    const eliminationEl = document.getElementById("giveawayElimination");
    if (countEl) countEl.textContent = `${t("giveaway.participants")}: ${state.giveaway.count}`;
    if (chipEl) chipEl.className = "md-chip " + (state.giveaway.active ? "is-pending" : "");

    const items = state.giveaway.participants || [];
    if (listEl) {
      listEl.innerHTML = items.length
        ? items.map((u) => `
            <div class="giveaway-participant-row">
              <span class="giveaway-participant__name">${escapeHtml(u)}</span>
              <button class="giveaway-participant__remove" data-remove-name="${escapeAttr(u)}" title="${t("giveaway.removeParticipant")}">✕</button>
            </div>`).join("")
        : '<div class="events-history__empty">' + t("giveaway.noParticipants") + '</div>';
    }

    if (eliminationEl && eliminationEl.classList.contains("is-on") !== !!state.giveaway.eliminationMode) {
      eliminationEl.classList.toggle("is-on", !!state.giveaway.eliminationMode);
    }
  }

  function wireGiveawayControls() {
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

  // ---- participants widget settings ----
  function sendParticipantsConfig(patch) {
    state.participantsConfig = { ...state.participantsConfig, ...patch };
    send(EVENT_TYPES.CMD_SET_PARTICIPANTS_CONFIG, { config: state.participantsConfig });
  }

  // ---- microphone visualizer widget settings ----
  function sendMicConfig(patch) {
    state.micConfig = { ...state.micConfig, ...patch };
    send(EVENT_TYPES.CMD_SET_MIC_CONFIG, { config: state.micConfig });
  }

  // ---- properties panel (extracted module) ----
  const propertiesPanel = initPropertiesPanel({
    state,
    t,
    ICONS,
    WIDGET_TYPES,
    EVENT_TYPES,
    send,
    switchHtml,
    wireSwitch,
    escapeAttr,
    round1,
    sendParticipantsConfig,
    sendMicConfig,
  });

  // ---- canvas editor (extracted module) ----
  const canvasEditor = initCanvasEditor({
    state,
    t,
    ICONS,
    WIDGET_TYPES,
    EVENT_TYPES,
    send,
    clamp,
    round1,
    escapeHtml,
    escapeAttr,
    formatMoney,
    currencySymbol,
    onSelectionChange: () => propertiesPanel.render(),
  });

  // ---- appearance: theme picker + custom theme editor ----

  function renderThemeSwatch(theme) {
    const card = document.createElement("div");
    card.className = "theme-swatch" + (theme.id === state.appearance.activeThemeId ? " is-active" : "");
    const dotColors = theme.builtin
      ? BuiltinThemes.BUILTIN_THEMES[theme.id].tokens
      : null;
    const dots = theme.builtin
      ? [dotColors["--md-primary"], dotColors["--md-secondary"], dotColors["--md-tertiary"]]
      : theme.seeds
      ? [theme.seeds.primary, theme.seeds.secondary, theme.seeds.tertiary]
      : ["#888", "#888", "#888"];
    card.innerHTML = `
      <div class="theme-swatch__dots">${dots.map((c) => `<span class="theme-swatch__dot" style="background:${c}"></span>`).join("")}</div>
      <div class="theme-swatch__row">
        <span class="theme-swatch__name">${escapeHtml(theme.name)}</span>
        ${
          theme.builtin
            ? ""
            : `<span class="layer-row__btns">
                <button class="theme-swatch__btn" data-action="edit" title="${t("common.edit")}">✎</button>
                <button class="theme-swatch__btn" data-action="delete" title="${t("common.remove")}">${ICONS.trash}</button>
              </span>`
        }
      </div>`;
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-action]")) return;
      send(EVENT_TYPES.CMD_SET_ACTIVE_THEME, { id: theme.id });
    });
    if (!theme.builtin) {
      card.querySelector('[data-action="edit"]').addEventListener("click", (e) => {
        e.stopPropagation();
        openThemeEditor(theme);
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
    const groups = [
      ["system", t("settings.themeCategorySystem")],
      ["starcitizen", t("settings.themeCategoryStarCitizen")],
      ["custom", t("settings.themeCategoryCustom")],
    ];
    groups.forEach(([category, label]) => {
      const items = themes.filter((theme) => (theme.category || "system") === category);
      if (!items.length) return;
      const header = document.createElement("div");
      header.className = "theme-grid__category";
      header.textContent = label;
      themeGridEl.appendChild(header);
      const grid = document.createElement("div");
      grid.className = "theme-grid__items";
      items.forEach((theme) => grid.appendChild(renderThemeSwatch(theme)));
      themeGridEl.appendChild(grid);
    });
  }

  function openThemeEditor(theme) {
    state.editingThemeId = theme ? theme.id : null;
    const seeds = theme && theme.seeds
      ? theme.seeds
      : { primary: "#c6b8ff", secondary: "#7ee0d6", tertiary: "#ffb0d8", surfaceSeed: "#8878c8", shapeMode: "rounded", fontPreset: "nebula" };

    themeEditorEl.hidden = false;
    themeEditorEl.innerHTML = `
      <div class="md-field"><label>${t("themeEditor.themeName")}</label><input type="text" id="themeName" value="${escapeAttr(theme ? theme.name : t("themeEditor.myTheme"))}"></div>
      <div class="theme-editor__colors">
        <div class="theme-editor__color"><label>${t("themeEditor.primary")}</label><input type="color" id="seedPrimary" value="${seeds.primary}"></div>
        <div class="theme-editor__color"><label>${t("themeEditor.secondary")}</label><input type="color" id="seedSecondary" value="${seeds.secondary}"></div>
        <div class="theme-editor__color"><label>${t("themeEditor.tertiary")}</label><input type="color" id="seedTertiary" value="${seeds.tertiary}"></div>
        <div class="theme-editor__color"><label>${t("themeEditor.surface")}</label><input type="color" id="seedSurface" value="${seeds.surfaceSeed}"></div>
      </div>
      <div class="theme-editor__row">
        <div class="md-field"><label>${t("themeEditor.shape")}</label>
          <select id="seedShape">
            <option value="rounded" ${seeds.shapeMode !== "angular" ? "selected" : ""}>${t("themeEditor.rounded")}</option>
            <option value="angular" ${seeds.shapeMode === "angular" ? "selected" : ""}>${t("themeEditor.angular")}</option>
          </select>
        </div>
        <div class="md-field"><label>${t("themeEditor.fonts")}</label>
          <select id="seedFont">
            <option value="nebula" ${seeds.fontPreset !== "orbital" ? "selected" : ""}>Roboto (Material You)</option>
            <option value="orbital" ${seeds.fontPreset === "orbital" ? "selected" : ""}>Orbitron / Rajdhani (Orbital)</option>
          </select>
        </div>
      </div>
      <div class="settings__actions">
        <button class="md-button md-button--filled" id="saveThemeBtn">${t("themeEditor.save")}</button>
        <button class="md-button md-button--text" id="cancelThemeBtn">${t("themeEditor.cancel")}</button>
      </div>`;

    const previewFromForm = () => {
      const liveSeeds = {
        primary: document.getElementById("seedPrimary").value,
        secondary: document.getElementById("seedSecondary").value,
        tertiary: document.getElementById("seedTertiary").value,
        surfaceSeed: document.getElementById("seedSurface").value,
        shapeMode: document.getElementById("seedShape").value,
        fontPreset: document.getElementById("seedFont").value,
      };
      canvasEditor.applyThemeToCanvas(ThemeEngine.buildThemeTokens(liveSeeds));
      return liveSeeds;
    };
    themeEditorEl.querySelectorAll("input, select").forEach((el) => el.addEventListener("input", previewFromForm));

    document.getElementById("saveThemeBtn").addEventListener("click", () => {
      const liveSeeds = previewFromForm();
      send(EVENT_TYPES.CMD_SAVE_CUSTOM_THEME, {
        id: state.editingThemeId,
        name: document.getElementById("themeName").value.trim() || t("themeEditor.myTheme"),
        seeds: liveSeeds,
      });
      closeThemeEditor();
    });
    document.getElementById("cancelThemeBtn").addEventListener("click", closeThemeEditor);

    themeEditorEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closeThemeEditor() {
    state.editingThemeId = null;
    themeEditorEl.hidden = true;
    themeEditorEl.innerHTML = "";
    canvasEditor.applyThemeToCanvas(state.appearance.tokens, state.appearance.activeThemeId); // revert live-preview back to the actually active theme
  }

  newThemeBtn.addEventListener("click", () => openThemeEditor(null));

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

  // ---- scenes ----

  function sceneUrl(id) {
    if (id === "wheel") return `http://localhost:${port}/overlay/wheel-scene.html`;
    return `http://localhost:${port}/overlay/scene.html?type=${id}`;
  }

  function renderScenesNav() {
    scenesNavListEl.innerHTML = "";
    Object.values(SceneCatalog.SCENE_DEFS).forEach((def) => {
      const card = document.createElement("div");
      card.className = "library-card" + (def.id === state.activeSceneId ? " is-active" : "");
      card.innerHTML = `<span class="library-card__icon">${ICONS[def.icon] || ""}</span><span class="library-card__text"><span class="library-card__label">${t("scene." + def.id + "Label")}</span></span>`;
      card.addEventListener("click", () => selectScene(def.id));
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

  function renderSceneForm() {
    const scene = state.scenes[state.activeSceneId];
    if (!scene) return;
    const def = SceneCatalog.SCENE_DEFS[state.activeSceneId];
    sceneFormTitle.textContent = t("scene." + def.id + "Label");

    if (state.activeSceneId === "wheel") {
      sceneFormEl.innerHTML = `
        <div class="md-field"><label>${t("giveaway.command")}</label><input type="text" id="giveawayCommand" placeholder="!go" value="${escapeAttr(state.giveaway.command || "!go")}"></div>
        <div class="settings__statuses"><span class="md-chip" id="giveawayChip"><span class="md-chip__dot"></span><span id="giveawayCount">${t("giveaway.participants")}: ${state.giveaway.count}</span></span></div>
        <div class="properties__test-grid">
          <button class="md-button md-button--filled" id="startGiveawayBtn">${t("giveaway.start")}</button>
          <button class="md-button md-button--outlined" id="stopGiveawayBtn">${t("giveaway.stop")}</button>
          <button class="md-button md-button--tonal" id="shuffleGiveawayBtn">${t("giveaway.shuffle")}</button>
          <button class="md-button md-button--tonal" id="generateWheelBtn">${t("giveaway.generateWheel")}</button>
          <button class="md-button md-button--filled" id="spinWheelBtn">${t("giveaway.spinWheel")}</button>
        </div>
        <div class="properties__toggle-row"><label>${t("giveaway.eliminationMode")}</label>${switchHtml("giveawayElimination", !!state.giveaway.eliminationMode)}</div>
        <div class="giveaway-manual">
          <input type="text" id="giveawayManualName" placeholder="${t("giveaway.participantPlaceholder")}" />
        </div>
        <button class="md-button md-button--tonal" id="addParticipantBtn" title="${t("giveaway.addParticipant")}">+ ${t("giveaway.addParticipant")}</button>
        <div class="giveaway-participants" id="giveawayParticipants"></div>

        <div class="inspector__title" style="margin-top:10px;">${t("giveaway.participantsWidgetTitle")}</div>
        <div class="properties__row">
          <div class="md-field"><label>${t("giveaway.showNames")}</label><input type="number" id="wsMaxNames" min="1" max="200" value="${state.participantsConfig.maxNames ?? 10}"></div>
          <div class="md-field"><label>${t("giveaway.fontSize")} (px)</label><input type="number" id="wsFontSize" min="10" max="48" value="${state.participantsConfig.fontSize ?? 16}"></div>
        </div>
        <div class="md-field"><label>${t("giveaway.textColor")}</label><input type="color" id="wsTextColor" value="${escapeAttr(state.participantsConfig.textColor || "#e8e1f0")}"></div>
        <div class="md-field"><label>${t("giveaway.backgroundOpacity")}: <span id="wsBgOpacityValue">${state.participantsConfig.backgroundOpacity ?? 82}%</span></label><input type="range" id="wsBgOpacity" min="0" max="100" value="${state.participantsConfig.backgroundOpacity ?? 82}"></div>
        <div class="properties__row">
          <div class="md-field"><label>X: <span id="wsXValue">${state.participantsConfig.x ?? 1.25}%</span></label><input type="range" id="wsX" min="0" max="100" step="0.25" value="${state.participantsConfig.x ?? 1.25}"></div>
          <div class="md-field"><label>Y: <span id="wsYValue">${state.participantsConfig.y ?? 50}%</span></label><input type="range" id="wsY" min="0" max="100" step="0.25" value="${state.participantsConfig.y ?? 50}"></div>
        </div>
        <div class="properties__toggle-row"><label>${t("giveaway.marquee")}</label>${switchHtml("wsMarquee", !!state.participantsConfig.marquee)}</div>

        <div class="inspector__title" style="margin-top:10px;">${t("giveaway.wheelSettings")}</div>
        <div class="md-field"><label>${t("giveaway.musicVolume")}: <span id="wsMusicVolumeValue">${state.wheelConfig.musicVolume ?? 50}%</span></label><input type="range" id="wsMusicVolume" min="0" max="100" value="${state.wheelConfig.musicVolume ?? 50}"></div>
        <div class="md-field"><label>${t("giveaway.spinSpeed")}: <span id="wsSpeedValue">${state.wheelSpeedConfig.speed ?? 3}</span></label><input type="range" id="wsSpeed" min="1" max="5" value="${state.wheelSpeedConfig.speed ?? 3}"></div>
      `;

      renderGiveaway();
      wireGiveawayControls();

      sceneFormEl.querySelector("#wsMaxNames").addEventListener("change", (e) => sendParticipantsConfig({ maxNames: Number(e.target.value) || 10 }));
      sceneFormEl.querySelector("#wsFontSize").addEventListener("change", (e) => sendParticipantsConfig({ fontSize: Number(e.target.value) || 16 }));
      sceneFormEl.querySelector("#wsTextColor").addEventListener("input", (e) => sendParticipantsConfig({ textColor: e.target.value }));
      sceneFormEl.querySelector("#wsBgOpacity").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        sceneFormEl.querySelector("#wsBgOpacityValue").textContent = `${v}%`;
        sendParticipantsConfig({ backgroundOpacity: v });
      });
      sceneFormEl.querySelector("#wsX").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        sceneFormEl.querySelector("#wsXValue").textContent = `${v}%`;
        sendParticipantsConfig({ x: v });
      });
      sceneFormEl.querySelector("#wsY").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        sceneFormEl.querySelector("#wsYValue").textContent = `${v}%`;
        sendParticipantsConfig({ y: v });
      });
      wireSwitch(sceneFormEl.querySelector("#wsMarquee"), (on) => sendParticipantsConfig({ marquee: on }));

      sceneFormEl.querySelector("#wsMusicVolume").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        sceneFormEl.querySelector("#wsMusicVolumeValue").textContent = `${v}%`;
        state.wheelConfig = { ...state.wheelConfig, musicVolume: v };
        send(EVENT_TYPES.CMD_SET_WHEEL_CONFIG, { config: state.wheelConfig });
      });
      sceneFormEl.querySelector("#wsSpeed").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        sceneFormEl.querySelector("#wsSpeedValue").textContent = `${v}`;
        state.wheelSpeedConfig = { ...state.wheelSpeedConfig, speed: v };
        send(EVENT_TYPES.CMD_SET_WHEEL_SPEED_CONFIG, { config: state.wheelSpeedConfig });
      });
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

  copySceneUrlBtn.textContent = t("scenes.copyUrl");
  copySceneUrlBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(sceneUrl(state.activeSceneId));
    copySceneUrlBtn.textContent = t("scenes.copied");
    setTimeout(() => (copySceneUrlBtn.textContent = t("scenes.copyUrl")), 1400);
  });

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.textContent = t("common.copy");
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.copy);
      navigator.clipboard.writeText(target.textContent);
      btn.textContent = t("editor.copied");
      setTimeout(() => (btn.textContent = t("common.copy")), 1400);
    });
  });

  obsUrlLabel.textContent = overlayUrl;
  copyUrlBtn.textContent = t("editor.copyUrl");
  copyUrlBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(overlayUrl);
    copyUrlBtn.textContent = t("editor.copied");
    setTimeout(() => (copyUrlBtn.textContent = t("editor.copyUrl")), 1400);
  });

  remoteUrlHint.addEventListener("click", () => {
    const url = remoteUrlText.textContent;
    if (!url || url === "—") return;
    navigator.clipboard.writeText(url);
    remoteUrlText.textContent = t("editor.copied");
    setTimeout(() => (remoteUrlText.textContent = url), 1400);
  });

  const openChatWindowBtn = document.getElementById("openChatWindowBtn");
  openChatWindowBtn.innerHTML = `${ICONS.widgetChat} ${t("editor.chat")}`;
  openChatWindowBtn.addEventListener("click", () => window.desktop?.openChatWindow());

  const testChatBtn = document.getElementById("testChatBtn");
  if (testChatBtn) {
    testChatBtn.innerHTML = `${ICONS.widgetChat} ${t("editor.testChat")}`;
    testChatBtn.addEventListener("click", () => send(EVENT_TYPES.CMD_TEST_CHAT, { count: 6 }));
  }

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
  const helpPanel = initHelpPanel({ t, ICONS });

  // ---- history console panel ----
  const historyPanelEl = document.getElementById("historyPanel");
  const toggleHistoryBtn = document.getElementById("toggleHistoryBtn");
  function setHistoryOpen(open) {
    if (!historyPanelEl || !toggleHistoryBtn) return;
    historyPanelEl.hidden = !open;
    toggleHistoryBtn.classList.toggle("is-active", open);
    if (open) renderStreamEvents(true);
  }
  if (toggleHistoryBtn) {
    toggleHistoryBtn.innerHTML = `${ICONS.widgetRecent} ${t("nav.history")}`;
    toggleHistoryBtn.addEventListener("click", () => setHistoryOpen(historyPanelEl && historyPanelEl.hidden));
  }
  const historyCloseBtn = document.getElementById("historyCloseBtn");
  if (historyCloseBtn) historyCloseBtn.addEventListener("click", () => setHistoryOpen(false));

  // ---- websocket ----
  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE:
        state.applySnapshot(msg.payload);
        if (msg.payload.remoteUrl) {
          remoteUrlText.textContent = msg.payload.remoteUrl;
          remoteUrlHint.hidden = false;
        }
        wsClient.setStatuses(msg.payload.connectionStatus);
        gridSizeSelect.value = String(state.editorPrefs.gridSize || 0);
        canvasEditor.applyThemeToCanvas(state.appearance.tokens, state.appearance.activeThemeId);
        canvasEditor.applyGridToCanvas();
        renderThemeGrid();
        renderLibrary();
        canvasEditor.renderCanvas();
        canvasEditor.renderLayers();
        propertiesPanel.render();
        populateSettings();
        syncIntegrationSwitches();
        renderGiveaway();
        selectScene(state.activeSceneId);
        break;
      case EVENT_TYPES.LAYOUT_UPDATE:
        handleLayoutUpdate(msg.payload.layout || []);
        break;
      case EVENT_TYPES.THEME_UPDATE:
        state.appearance = msg.payload;
        if (!state.editingThemeId) canvasEditor.applyThemeToCanvas(state.appearance.tokens, state.appearance.activeThemeId);
        renderThemeGrid();
        canvasEditor.renderCanvas();
        break;
      case EVENT_TYPES.EDITOR_PREFS_UPDATE:
        state.editorPrefs = msg.payload;
        gridSizeSelect.value = String(state.editorPrefs.gridSize || 0);
        canvasEditor.applyGridToCanvas();
        break;
      case EVENT_TYPES.SCENES_UPDATE:
        state.scenes = msg.payload;
        renderSceneForm();
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
        if (state.activeSceneId === "wheel") renderSceneForm();
        break;
      case EVENT_TYPES.WHEEL_CONFIG:
        state.wheelConfig = (msg.payload && msg.payload.config) || state.wheelConfig;
        if (state.activeSceneId === "wheel") renderSceneForm();
        break;
      case EVENT_TYPES.WHEEL_SPEED_CONFIG:
        state.wheelSpeedConfig = (msg.payload && msg.payload.config) || state.wheelSpeedConfig;
        if (state.activeSceneId === "wheel") renderSceneForm();
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
        wsClient.updateStatus(msg.payload.service, msg.payload.status);
        break;
      case EVENT_TYPES.LOCALES:
        applyLocales(msg.payload && msg.payload.lang, msg.payload && msg.payload.locales);
        break;
      case EVENT_TYPES.TERMINAL_LOG:
        loggerPanel.append(msg.payload);
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
      default:
        break; // ALERT / CHAT_MESSAGE / RECENT_EVENT are for the overlay, not the editor
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
    renderGiveaway();
    renderThemeGrid();
    wsClient.refreshStatusChips();
    updateEventsFilterButtons();
    renderStreamEvents(true);
    copyUrlBtn.textContent = t("editor.copyUrl");
    copySceneUrlBtn.textContent = t("scenes.copyUrl");
    exportConfigBtn.textContent = t("settings.export");
    importConfigBtn.textContent = t("settings.import");
    const chatBtn = document.getElementById("openChatWindowBtn");
    if (chatBtn) chatBtn.innerHTML = `${ICONS.widgetChat} ${t("editor.chat")}`;
    const testChatBtn = document.getElementById("testChatBtn");
    if (testChatBtn) testChatBtn.innerHTML = `${ICONS.widgetChat} ${t("editor.testChat")}`;
    const historyBtn = document.getElementById("toggleHistoryBtn");
    if (historyBtn) historyBtn.innerHTML = `${ICONS.widgetRecent} ${t("nav.history")}`;
    loggerPanel.refreshLabel();
    helpPanel.refresh();
    const boostyBtn = document.getElementById("openBoostyBtn");
    if (boostyBtn) boostyBtn.innerHTML = `${ICONS.heart} ${t("boosty.support")}`;
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
  }
