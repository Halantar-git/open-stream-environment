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
  SceneCanvas — раскладка виджетов на полноэкранной сцене.

  Работает так же, как основной оверлей: `WidgetManager` сверяет массив
  `scene.widgets` с живыми экземплярами, а шина разносит события стрима по
  подпискам виджетов. Отличие одно — раскладка своя у каждой сцены и приходит
  внутри `scenes.<id>.widgets`, а обновления прилетают кадром
  `scene_layout_update`.

  Тематические ограничения (2D ↔ 3D) повторяют `overlay.js`: без них виджеты
  чужой темы попадали бы на сцену и рисовались поверх её оформления.
*/
(function () {
  "use strict";

  const { EVENT_TYPES } = window.SharedEvents || {};
  const OW = window.OSEWidgets || {};
  const Catalog = window.WidgetCatalog || {};
  const WIDGET_TYPES = Catalog.WIDGET_TYPES || {};
  const WidgetManager = OW.WidgetManager;
  const bus = window.OSESceneBus;

  if (!EVENT_TYPES || !WidgetManager || !bus) return;

  // Канвас виджетов есть только у четырёх сцен: разговор, гости,
  // голосование и колесо.
  const WIDGET_SCENE_IDS = ["talk", "guests", "wheel", "poll"];

  let sceneType = "";
  let enabled = false;
  let sendCommand = null;
  let root = null;
  let manager = null;
  let currentWidgets = [];
  let lastAppearance = null;
  let connectionStatus = {};

  // ---- shared mutable state (widgets read from here via context.state) ----
  const state = {
    goal: { title: "Цель", current: 0, target: 1, currency: "RUB" },
    recentEvents: [],
    stats: { followerCount: null, subscriberCount: null },
    topDonation: { user: "", amount: 0, currency: "RUB" },
    sessionDonations: null,
    deathCount: 0,
    soundboardConfig: { volume: 0.8, queueMode: false },
    tts: { enabled: true, volume: 0.9, rate: 1, lang: "ru-RU", voice: "" },
    donationVoice: { donationAlerts: false, volume: 0.9 },
    micConfig: { sensitivity: 1.5, lineWidth: 2, color: "", opacity: 0.9, visualizer_mode: "sine", barCount: 32, barGap: 2 },
    remoteMicData: null,
    longshot: null,
    giveaway: { count: 0, participants: [] },
    donatex: { enabled: false, widgets: { donation: "", ai: "", music: "" } },
  };

  // ---- pure utils ----

  function formatMoney(value) {
    const locale = window.I18n && window.I18n.getLang() === "ru" ? "ru-RU" : "en-US";
    return Number(value || 0).toLocaleString(locale);
  }

  const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", UAH: "₴", KZT: "₸", GBP: "£" };
  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || code || "";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }

  function resolveMediaUrl(path) {
    if (!path) return "";
    if (/^(https?:)?\/\//i.test(path)) return path;
    return "/" + String(path).replace(/^\/+/, "");
  }

  function readCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function t(key, params) {
    return window.I18n ? window.I18n.t(key, params) : key;
  }

  const renderEmotes =
    window.TwitchEmotes && window.TwitchEmotes.renderEmotes
      ? window.TwitchEmotes.renderEmotes.bind(window.TwitchEmotes)
      : (message) => escapeHtml(message);

  const context = {
    bus,
    EVENT_TYPES,
    state,
    t,
    ICONS: window.SharedIcons ? window.SharedIcons.ICONS : {},
    renderEmotes,
    escapeHtml,
    escapeAttr,
    formatMoney,
    currencySymbol,
    resolveMediaUrl,
    readCssVar,
    send: (type, payload) => {
      if (typeof sendCommand === "function") sendCommand(type, payload);
    },
    theme: "nebula",
    threeDWidgets: [],
    enable3d: false,
    activeThemeId: "",
  };

  // ---- theme gating (same rules as overlay.js) ----

  const widgetDef = (item) => (item && WIDGET_TYPES[item.type]) || null;
  const widgetRole = Catalog.widgetRole || (() => null);
  const themeAllowsWidget = Catalog.themeAllowsWidget || (() => true);

  function active3dSet() {
    return Array.isArray(lastAppearance && lastAppearance.active3dWidgets) ? lastAppearance.active3dWidgets : [];
  }

  function resolveRenderType(item) {
    const def = widgetDef(item);
    const theme = def && def.theme ? def.theme : null;
    if (theme && active3dSet().includes(item.type)) return def.renderType || "canvas";
    return "2d";
  }

  function active3dCounterpartType(role) {
    const set = active3dSet();
    if (!role || !set.length) return null;
    const matches = set.filter((type) => widgetRole(type) === role);
    return matches.length === 1 ? matches[0] : null;
  }

  function hasActive3dReplacement(role) {
    if (!role || !active3dCounterpartType(role)) return false;
    return currentWidgets.some((other) => {
      const def = widgetDef(other);
      return !!def && !!def.theme && widgetRole(other.type) === role;
    });
  }

  function shouldMount(item) {
    const def = widgetDef(item);
    if (!def) return false;
    if (!themeAllowsWidget(def, lastAppearance)) return false;
    const theme = def.theme ? def.theme : null;
    const role = widgetRole(item.type);

    if (theme && !role) {
      if (!active3dSet().includes(item.type)) return false;
    } else if (theme && role) {
      if (!active3dSet().includes(item.type) && !active3dCounterpartType(role)) return false;
    } else if (!theme && role) {
      if (hasActive3dReplacement(role)) return false;
    }

    const services = (def && def.services) || null;
    if (services && services.length) {
      const allDisabled = services.every((service) => connectionStatus[service] === "disabled");
      if (allDisabled) return false;
    }
    return true;
  }

  function transform(item) {
    const role = widgetRole(item.type);
    if (!role) return item;
    const targetType = active3dCounterpartType(role);
    if (!targetType || item.type === targetType) return item;
    const targetDef = WIDGET_TYPES[targetType] || {};
    return Object.assign({}, item, {
      type: targetType,
      config: Object.assign({}, targetDef.defaultConfig, item.config),
    });
  }

  // ---- manager ----

  function registerAll(target) {
    const classes = {
      alerts: OW.AlertsWidget,
      goal: OW.GoalWidget,
      chat: OW.ChatWidget,
      recent: OW.RecentWidget,
      "grimhex-recent": OW.RecentWidget3d,
      "nuclear-recent": OW.RecentWidget3d,
      "cobra-recent": OW.RecentWidget3d,
      "teso-recent": OW.RecentWidget3d,
      "wardogs-recent": OW.RecentWidget3d,
      "md3-recent": OW.RecentWidget3d,
      "pixel-recent": OW.RecentWidget3d,
      "retrowave-recent": OW.RecentWidget3d,
      "sf-recent": OW.RecentWidget3d,
      ticker: OW.WidgetTicker,
      "grimhex-ticker": OW.WidgetTicker,
      "nuclear-ticker": OW.WidgetTicker,
      "cobra-ticker": OW.WidgetTicker,
      "teso-ticker": OW.WidgetTicker,
      "wardogs-ticker": OW.WidgetTicker,
      "md3-ticker": OW.WidgetTicker,
      "pixel-ticker": OW.WidgetTicker,
      "retrowave-ticker": OW.WidgetTicker,
      "sf-ticker": OW.WidgetTicker,
      stat: OW.StatWidget,
      social: OW.SocialWidget,
      participants: OW.ParticipantsWidget,
      timer: OW.TimerWidget,
      "grimhex-timer": OW.GrimHexTimerWidget,
      mic: OW.MicWidget,
      death: OW.DeathWidget,
      webcam: OW.WebcamWidget,
      soundboard: OW.SoundboardWidget,
      garland: OW.WidgetGarland,
      snow: OW.WidgetSnow,
      custom: OW.CustomWidget,
      grimhex: OW.WidgetGrimHex,
      musain: OW.WidgetMusain,
      "grimhex-chat": OW.WidgetGrimHexChat,
      "grimhex-goal": OW.WidgetGrimHexGoal,
      "grimhex-holo-alert": OW.WidgetGrimHexHoloAlert,
      "uec-transfer": OW.WidgetUecTransfer,
      nuclear: OW.WidgetNuclear,
      "nuclear-chat": OW.WidgetNuclearChat,
      "nuclear-goal": OW.WidgetNuclearGoal,
      "nuclear-holo-alert": OW.WidgetNuclearHoloAlert,
      cobra: OW.WidgetCobra,
      "elite-sign": OW.WidgetEliteSign,
      "teso-seal": OW.WidgetTesoSeal,
      "teso-chat": OW.WidgetTesoChat,
      "teso-goal": OW.WidgetTesoGoal,
      "teso-holo-alert": OW.WidgetTesoHoloAlert,
      "cobra-chat": OW.WidgetCobraChat,
      "cobra-goal": OW.WidgetCobraGoal,
      "wardogs-goal": OW.WidgetWardogsGoal,
      "wardogs-chat": OW.WidgetWardogsChat,
      "wardogs-holo-alert": OW.WidgetWardogsHoloAlert,
      "wardogs-cube": OW.WidgetWardogsCube,
      "cobra-holo-alert": OW.WidgetCobraHoloAlert,
      "cobra-shield": OW.WidgetCobraShield,
      "cobra-radar": OW.WidgetCobraRadar,
      "grimhex-radar": OW.WidgetGrimHexRadar,
      "md3-orb": OW.WidgetMd3Orb,
      "md3-chat": OW.WidgetMd3Chat,
      "md3-goal": OW.WidgetMd3Goal,
      "md3-holo-alert": OW.WidgetMd3HoloAlert,
      "pixel-cube": OW.WidgetPixelCube,
      "pixel-chat": OW.WidgetPixelChat,
      "pixel-goal": OW.WidgetPixelGoal,
      "pixel-holo-alert": OW.WidgetPixelHoloAlert,
      "retrowave-goal": OW.WidgetRetrowaveGoal,
      "retrowave-chat": OW.WidgetRetrowaveChat,
      "retrowave-holo-alert": OW.WidgetRetrowaveHoloAlert,
      "retrowave-symbol": OW.WidgetRetrowaveSymbol,
      "orbital-symbol": OW.WidgetOrbitalSymbol,
      "sf-tachometer": OW.WidgetSfTachometer,
      "sf-goal": OW.WidgetSfGoal,
      "sf-chat": OW.WidgetSfChat,
      "sf-holo-alert": OW.WidgetSfHoloAlert,
      "sf-cube": OW.WidgetSfCube,
      "win98-cube": OW.WidgetWin98Cube,
      "win98-goal": OW.WidgetWin98Goal,
      "win98-chat": OW.WidgetWin98Chat,
      "win98-holo-alert": OW.WidgetWin98HoloAlert,
      "donatex-ai": OW.DonatexAiWidget,
      music: OW.MusicWidget,
    };
    for (const [type, WidgetClass] of Object.entries(classes)) {
      if (WidgetClass) target.register(type, WidgetClass);
    }
  }

  function ensureManager() {
    if (manager) return manager;
    const wrapper = document.querySelector(".scene-wrapper");
    if (!wrapper) return null;
    root = document.createElement("div");
    root.className = "scene-canvas-layer";
    wrapper.appendChild(root);
    manager = new WidgetManager(root, {
      context,
      resolveRenderType,
      shouldMount,
      transform,
      widgetTheme: (item) => {
        const def = widgetDef(item);
        return def && def.theme ? def.theme : "";
      },
    });
    registerAll(manager);
    // Виджеты из пакетов: `onWidget` отдаёт и уже загруженные классы, и те,
    // что догрузятся после первого снимка раскладки.
    if (window.OSE && typeof window.OSE.onWidget === "function") {
      window.OSE.onWidget((type, WidgetClass) => {
        if (manager && typeof WidgetClass === "function") manager.register(type, WidgetClass);
      });
    }
    return manager;
  }

  function syncWidgets(widgets) {
    currentWidgets = Array.isArray(widgets) ? widgets : [];
    if (!ensureManager()) return;
    manager.syncLayout(currentWidgets);
  }

  function applyTheme(appearance) {
    if (!appearance || !appearance.tokens) return;
    const rootEl = document.documentElement;
    Object.entries(appearance.tokens).forEach(([key, value]) => rootEl.style.setProperty(key, value));
    document.body.dataset.decoration = appearance.tokens["--panel-decoration"] || "none";
    document.body.dataset.theme = appearance.activeThemeId || "";
    lastAppearance = appearance;
    context.threeDWidgets = Array.isArray(appearance.active3dWidgets) ? appearance.active3dWidgets : [];
    context.enable3d = !!appearance.enable3d;
    context.activeThemeId = appearance.activeThemeId || "";
    // Тема могла сменить 2D/3D-набор — пересобираем раскладку.
    syncWidgets(currentWidgets);
  }

  // ---- messages ----

  function handleMessage(msg) {
    if (!enabled) return;
    switch (msg.type) {
      case EVENT_TYPES.STATE: {
        const payload = msg.payload || {};
        state.goal = payload.goal || state.goal;
        state.recentEvents = payload.recentEvents || [];
        state.stats = payload.stats || state.stats;
        state.topDonation = payload.topDonation || state.topDonation;
        if (payload.sessionDonations) state.sessionDonations = payload.sessionDonations;
        state.deathCount = payload.deathCount || 0;
        state.soundboardConfig = payload.soundboard || state.soundboardConfig;
        state.tts = payload.tts || state.tts;
        state.donationVoice = payload.donationVoice || state.donationVoice;
        state.longshot = payload.longshot || state.longshot;
        state.giveaway = payload.giveaway || state.giveaway;
        state.donatex = payload.donatex || state.donatex;
        connectionStatus = payload.connectionStatus || connectionStatus;
        if (payload.appearance) applyTheme(payload.appearance);
        const scene = payload.scenes && payload.scenes[sceneType];
        syncWidgets(scene && scene.widgets);
        break;
      }
      case EVENT_TYPES.SCENE_LAYOUT_UPDATE:
        if (msg.payload && msg.payload.scene === sceneType) {
          syncWidgets(msg.payload.layout);
        }
        break;
      case EVENT_TYPES.SCENES_UPDATE: {
        const scene = msg.payload && msg.payload[sceneType];
        syncWidgets(scene && scene.widgets);
        break;
      }
      case EVENT_TYPES.THEME_UPDATE:
        applyTheme(msg.payload);
        break;
      case EVENT_TYPES.STAT_UPDATE:
        state.stats = msg.payload || state.stats;
        bus.emit(EVENT_TYPES.STAT_UPDATE, msg.payload);
        break;
      case EVENT_TYPES.GIVEAWAY_UPDATE:
        if (msg.payload && msg.payload.giveaway) state.giveaway = msg.payload.giveaway;
        bus.emit(EVENT_TYPES.GIVEAWAY_UPDATE, msg.payload);
        break;
      case EVENT_TYPES.GIVEAWAY_PARTICIPANTS:
        if (state.giveaway) {
          if (msg.payload && msg.payload.count != null) state.giveaway.count = msg.payload.count;
          if (msg.payload && Array.isArray(msg.payload.participants)) state.giveaway.participants = msg.payload.participants;
        }
        bus.emit(EVENT_TYPES.GIVEAWAY_PARTICIPANTS, msg.payload);
        break;
      case EVENT_TYPES.DEATH_COUNT_UPDATE:
        state.deathCount = (msg.payload && msg.payload.count) || 0;
        bus.emit(EVENT_TYPES.DEATH_COUNT_UPDATE, msg.payload);
        break;
      case EVENT_TYPES.TOP_DONATION_UPDATE:
        state.topDonation = msg.payload || state.topDonation;
        bus.emit(EVENT_TYPES.TOP_DONATION_UPDATE, msg.payload);
        break;
      case EVENT_TYPES.SESSION_STATS:
        state.sessionDonations = msg.payload || state.sessionDonations;
        bus.emit(EVENT_TYPES.SESSION_STATS, msg.payload);
        break;
      case EVENT_TYPES.ALERT:
        bus.emit(EVENT_TYPES.ALERT, msg.payload);
        break;
      case EVENT_TYPES.CONNECTION_STATUS:
        connectionStatus[msg.payload.service] = msg.payload.status;
        syncWidgets(currentWidgets);
        break;
      case EVENT_TYPES.CHAT_MESSAGE:
        bus.emit(EVENT_TYPES.CHAT_MESSAGE, msg.payload);
        break;
      case EVENT_TYPES.TICKER_MESSAGE:
        bus.emit(EVENT_TYPES.TICKER_MESSAGE, msg.payload);
        break;
      case EVENT_TYPES.SOUNDBOARD_PLAY:
        bus.emit(EVENT_TYPES.SOUNDBOARD_PLAY, msg.payload);
        break;
      case EVENT_TYPES.RECENT_EVENT:
        state.recentEvents = [msg.payload, ...state.recentEvents].slice(0, 15);
        bus.emit(EVENT_TYPES.RECENT_EVENT, msg.payload);
        break;
      case EVENT_TYPES.REWARD_REDEEM:
        bus.emit(EVENT_TYPES.REWARD_REDEEM, msg.payload);
        break;
      case EVENT_TYPES.GOAL_UPDATE:
        state.goal = msg.payload || state.goal;
        bus.emit(EVENT_TYPES.GOAL_UPDATE, msg.payload);
        break;
      case EVENT_TYPES.DONATEX_AI_EVENT:
        bus.emit(EVENT_TYPES.DONATEX_AI_EVENT, msg.payload);
        break;
      case EVENT_TYPES.MUSIC_PLAY:
      case EVENT_TYPES.MUSIC_CONTROL:
        // Виджет музыки можно поставить и на сцену — кадры трека и
        // управления плеером идут туда же.
        bus.emit(msg.type, msg.payload || {});
        break;
      case EVENT_TYPES.LONGSHOT_UPDATE:
        state.longshot = (msg.payload && msg.payload.longshot) || state.longshot;
        bus.emit(EVENT_TYPES.LONGSHOT_UPDATE, state.longshot);
        break;
      case EVENT_TYPES.OVERLAY_MIC_CONFIG:
        state.micConfig = (msg.payload && msg.payload.config) || state.micConfig;
        bus.emit(EVENT_TYPES.OVERLAY_MIC_CONFIG, msg.payload);
        break;
      case EVENT_TYPES.MIC_AUDIO_DATA:
        state.remoteMicData = msg.payload || null;
        break;
      case EVENT_TYPES.OVERLAY_CAMERA_CONFIG:
        state.cameraConfig = (msg.payload && msg.payload.config) || state.cameraConfig;
        bus.emit(EVENT_TYPES.OVERLAY_CAMERA_CONFIG, msg.payload);
        break;
      case EVENT_TYPES.CAMERA_STREAM_CONFIG:
        bus.emit(EVENT_TYPES.CAMERA_STREAM_CONFIG, msg.payload || {});
        break;
      // Гостевые камеры на сценах работают так же, как на оверлее.
      case EVENT_TYPES.GUEST_ACCEPTED:
      case EVENT_TYPES.GUEST_SIGNAL:
      case EVENT_TYPES.GUEST_LEFT:
      case EVENT_TYPES.GUEST_DECLINED:
        bus.emit(msg.type, msg.payload || {});
        break;
      case EVENT_TYPES.LOCALES:
        if (window.I18n) {
          window.I18n.setLocales(msg.payload && msg.payload.locales);
          window.I18n.setLang(msg.payload && msg.payload.lang);
          window.I18n.apply();
        }
        bus.emit(EVENT_TYPES.LOCALES, msg.payload);
        break;
      default:
        break;
    }
  }

  function handleBinary(data) {
    if (!enabled || !data) return;
    const h264 = window.CameraFrame && window.CameraFrame.decodeH264(data);
    if (h264) {
      bus.emit(EVENT_TYPES.CAMERA_VIDEO_FRAME, h264);
      return;
    }
    const camera = window.CameraFrame && window.CameraFrame.decode(data);
    if (camera) {
      bus.emit(EVENT_TYPES.CAMERA_VIDEO_FRAME, camera);
      return;
    }
    const frame = window.MicFrame && window.MicFrame.decode(data);
    if (frame) state.remoteMicData = frame;
  }

  function init(id, send) {
    sceneType = String(id || "");
    enabled = WIDGET_SCENE_IDS.includes(sceneType);
    sendCommand = typeof send === "function" ? send : null;
    if (enabled) ensureManager();
  }

  window.SceneCanvas = { init, handleMessage, handleBinary };
})();
