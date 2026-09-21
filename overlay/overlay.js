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
  Overlay composition root.

  Responsibilities (and nothing else):
    * own the WebSocket connection and turn incoming frames into typed bus events
      (Twitch / YouTube / OBS data arrives here — the data layer is untouched);
    * hold the shared mutable `state` that widgets read;
    * own the WidgetManager, which reconciles the layout into BaseWidget instances;
    * keep the overlay "chrome" that is not a widget: the alert/winner audio
      helpers.

  Widgets live in ./widgets/*.js and communicate only through the EventBus.
*/
(function () {
  "use strict";

  const { EVENT_TYPES } = window.SharedEvents;
  const { ICONS } = window.SharedIcons;
  const { WIDGET_TYPES } = window.WidgetCatalog || {};
  const widgetRole = (window.WidgetCatalog && window.WidgetCatalog.widgetRole) || (() => null);
  const themeAllowsWidget = (window.WidgetCatalog && window.WidgetCatalog.themeAllowsWidget) || (() => true);
  const t = (key, params) => (window.I18n ? window.I18n.t(key, params) : key);
  const renderEmotes =
    window.TwitchEmotes && window.TwitchEmotes.renderEmotes
      ? window.TwitchEmotes.renderEmotes.bind(window.TwitchEmotes)
      : (msg) => escapeHtml(msg);

  const canvas = document.getElementById("canvas");
  const bus = new window.OSEWidgets.EventBus();

  // ---- shared mutable state (widgets read from here via context.state) ----
  const state = {
    goal: { title: "Цель", current: 0, target: 1, currency: "RUB" },
    recentEvents: [],
    stats: { followerCount: null, subscriberCount: null },
    topDonation: { user: "", amount: 0, currency: "RUB" },
    // Счёт донатов текущего стрима (пусто — ещё не пришёл ни в снимке, ни событием).
    sessionDonations: null,
    deathCount: 0,
    soundboardConfig: { volume: 0.8, queueMode: false },
    tts: { enabled: true, volume: 0.9, rate: 1, lang: "ru-RU", voice: "" },
    donationVoice: { donationAlerts: false, volume: 0.9 },
    micConfig: { sensitivity: 1.5, lineWidth: 2, color: "", opacity: 0.9, visualizer_mode: "sine", barCount: 32, barGap: 2, peakFall: 2.5 },
    remoteMicData: null,
    // Последний снимок конфига Longshot (Executive Hangar), если он получен.
    longshot: null,
  };

  let ws;

  // Live connection status per service (from STATE / CONNECTION_STATUS frames),
  // used by shouldMount() to hide widgets whose data source is disabled.
  let connectionStatus = {};

  // ---- pure utils ----
  function formatMoney(n) {
    return Number(n || 0).toLocaleString("ru-RU");
  }
  const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", UAH: "₴", KZT: "₸", GBP: "£" };
  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || code || "";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }
  function resolveMediaUrl(path) {
    if (!path) return "";
    if (/^(https?:)?\/\//i.test(path)) return path;
    return "/" + String(path).replace(/^\/+/, "");
  }
  function readCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ---- DonationAlerts text-to-speech (озвучка) ----
  function buildDonationSpeech(alert) {
    const amount = formatMoney(alert.amount);
    const currency = currencySymbol(alert.currency);
    const ru = /^ru/i.test((state.tts && state.tts.lang) || "");
    const intro = ru
      ? `${alert.user} отправил ${amount} ${currency}`
      : `${alert.user} donated ${amount} ${currency}`;
    return alert.message ? `${intro}. ${alert.message}` : intro;
  }

  function pickTtsVoice() {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    const name = state.tts && state.tts.voice;
    if (name) {
      const match = voices.find((v) => v.name === name);
      if (match) return match;
    }
    const prefix = String((state.tts && state.tts.lang) || "ru-RU").slice(0, 2).toLowerCase();
    return voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(prefix)) || null;
  }

  function speakDonation(alert) {
    if (!state.tts || !state.tts.enabled) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const text = buildDonationSpeech(alert);
    if (!text) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = state.tts.lang || "ru-RU";
      u.volume = Math.max(0, Math.min(1, Number(state.tts.volume) || 0.9));
      u.rate = Math.max(0.5, Math.min(2, Number(state.tts.rate) || 1));
      const voice = pickTtsVoice();
      if (voice) u.voice = voice;
      window.speechSynthesis.speak(u);
    } catch (_) {
      /* speech unavailable */
    }
  }

  // Озвучка произвольной фразы (награда за баллы канала). Текст готовится на
  // сервере (плейсхолдеры уже подставлены) и приходит через REWARD_TTS.
  function speakReward(text) {
    if (!text) return;
    if (!state.tts || !state.tts.enabled) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = state.tts.lang || "ru-RU";
      u.volume = Math.max(0, Math.min(1, Number(state.tts.volume) || 0.9));
      u.rate = Math.max(0.5, Math.min(2, Number(state.tts.rate) || 1));
      const voice = pickTtsVoice();
      if (voice) u.voice = voice;
      window.speechSynthesis.speak(u);
    } catch (_) {
      /* speech unavailable */
    }
  }

  // Озвучка от самого сервиса (готовый аудиофайл доната: DonationAlerts voice).
  // Возвращает true, если взяла озвучку на себя — тогда встроенный TTS для
  // этого доната не запускается.
  function playDonationVoice(alert) {
    const voiceUrl = alert && alert.voiceUrl;
    if (!voiceUrl) return false;
    const dv = state.donationVoice || {};
    const enabled = dv.donationAlerts !== false;
    if (!enabled) return false;
    try {
      const audio = new Audio(voiceUrl);
      audio.volume = Math.max(0, Math.min(1, Number(dv.volume) || 0.9));
      const started = audio.play();
      if (started && typeof started.catch === "function") started.catch(() => {});
    } catch (_) {
      /* audio unavailable */
    }
    return true;
  }

  /*
    Звук победителя и выбывания в оверлее больше не играет: им владеет страница
    колеса (overlay/wheel-scene.js), которая и ведёт розыгрыш. Иначе в обычной
    раскладке OBS звук слышен дважды — в сцене с колесом лежит и основной оверлей,
    а окна HUD и превью темы добавляли к этому свои копии. Вместе с основными
    вызовами убраны и запасные «синтезированные» звуки: они стали мёртвым кодом,
    а из контекста виджетов убран `audio`.
  */

  // ---- shared widget context (theme is updated in applyTheme) ----
  const context = {
    bus,
    EVENT_TYPES,
    state,
    t,
    ICONS,
    renderEmotes,
    escapeHtml,
    escapeAttr,
    formatMoney,
    currencySymbol,
    resolveMediaUrl,
    readCssVar,
    theme: "nebula",
    threeDWidgets: [],
  };

  // Current layout, kept so a theme change can re-run syncLayout (and thus
  // re-evaluate shouldMount/resolveRenderType) without a fresh STATE frame.
  let currentLayout = [];

  // The theme preview window loads the same overlay with ?themePreview=1; only
  // there do we apply the editor's unsaved draft (never on the OBS/HUD overlay).
  const isThemePreview = /themePreview=1/.test(location.search);
  let lastAppearance = null;

  // ---- theme ----
  function applyCustomCss(css) {
    let style = document.getElementById("ose-custom-theme-css");
    if (!css) {
      if (style) style.remove();
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.id = "ose-custom-theme-css";
      document.head.appendChild(style);
    }
    style.textContent = css;
  }

  function applyTheme(appearance) {
    if (!appearance || !appearance.tokens) return;
    const root = document.documentElement;
    Object.entries(appearance.tokens).forEach(([k, v]) => root.style.setProperty(k, v));
    applyCustomCss(appearance.customCss || "");
    document.body.dataset.decoration = appearance.tokens["--panel-decoration"] || "none";
    document.body.dataset.theme = appearance.activeThemeId || "";
    // `context.threeDWidgets` gates the 3D widgets: the explicit set of enabled
    // 3D widget types under the current theme (a built-in variant's widgets, or
    // a custom theme's own selection). The manager hands each widget its own
    // family via `widgetTheme`, so widgets from several families can coexist.
    context.threeDWidgets = Array.isArray(appearance.active3dWidgets) ? appearance.active3dWidgets : [];
    context.activeThemeId = appearance.activeThemeId || "";
  }

  function applyDraftTheme(draft) {
    if (!draft || draft.clear || !draft.tokens) {
      if (lastAppearance) applyTheme(lastAppearance);
      return;
    }
    applyTheme({
      ...(lastAppearance || {}),
      tokens: draft.tokens,
      customCss: draft.customCss || "",
      activeThemeId: draft.themeId || (lastAppearance && lastAppearance.activeThemeId) || "",
      activeThemeId3d: "",
      active3dWidgets: Array.isArray(draft.threeDWidgets)
        ? draft.threeDWidgets
        : (lastAppearance && lastAppearance.active3dWidgets) || [],
    });
  }

  // ---- render mode + theme isolation -------
  // A widget may declare a `theme` in the catalog; 3D widgets are bound to their
  // theme and render on a canvas only while that theme is active. Everything
  // else is plain 2D DOM/CSS (zero GPU in idle).
  function widgetDef(item) {
    return (WIDGET_TYPES && WIDGET_TYPES[item && item.type]) || null;
  }

  // The active set of 3D widget types, as sent by the server (see
  // appearance.active3dWidgets). Built-in themes expose their variant's widgets
  // minus disabled фишки; custom themes expose their own list.
  function active3dSet() {
    return Array.isArray(context.threeDWidgets) ? context.threeDWidgets : [];
  }

  function resolveRenderType(item) {
    const def = widgetDef(item);
    const theme = def && def.theme ? def.theme : null;
    if (theme && active3dSet().includes(item.type)) return def.renderType || "canvas";
    return "2d";
  }

  // Manager-level guard: a widget is only created when it has a valid target
  // under the active theme and at least one of the services it depends on is
  // enabled.
  function shouldMount(item) {
    const def = widgetDef(item);
    // Тип убран из каталога (например, «Участники розыгрыша» переехали в сцену
    // колеса) — в раскладке ему делать нечего, не монтируем.
    if (!def) return false;
    // 2D-привязка к теме (например, «Таймер Executive Hangar» — Orbital и свои темы).
    if (!themeAllowsWidget(def, lastAppearance)) return false;
    const theme = def.theme ? def.theme : null;
    const role = widgetRole(item.type);

    if (theme && !role) {
      // Additive 3D widget with no role: mounted only when its type is in the
      // active 3D widget set.
      if (!active3dSet().includes(item.type)) return false;
    } else if (theme && role) {
      // 3D role widget (chat/goal/alerts, or a decorative sign/radar/shield):
      // mounted when its own type is enabled, or when a unique same-role
      // counterpart will remap it via transform(). It hides only when neither
      // applies (3D off, counterpart missing, or the role is ambiguous).
      if (!active3dSet().includes(item.type) && !active3dCounterpartType(role)) return false;
    } else if (!theme && role) {
      // 2D base role widget: gives way to an explicit 3D widget of the same role.
      if (hasActive3dReplacement(role)) return false;
    }

    const services = (def && def.services) || null;
    if (services && services.length) {
      const allDisabled = services.every((service) => connectionStatus[service] === "disabled");
      if (allDisabled) return false;
    }
    return true;
  }

  // True when an explicit 3D widget of the given role is present in the layout
  // and will actually render (i.e. the active theme has an enabled counterpart).
  function hasActive3dReplacement(role) {
    if (!role || !currentLayout || !currentLayout.length) return false;
    if (!active3dCounterpartType(role)) return false;
    return currentLayout.some((other) => {
      const def = widgetDef(other);
      return !!def && !!def.theme && widgetRole(other.type) === role;
    });
  }

  // The 3D widget type that replaces a given role under the active theme, or
  // null when there is none (3D off, or the counterpart фишка is disabled).
  function active3dCounterpartType(role) {
    const set = active3dSet();
    if (!role || !set.length) return null;
    const matches = set.filter((t) => widgetRole(t) === role);
    return matches.length === 1 ? matches[0] : null;
  }

  // Swap a role widget (a 2D base, an explicitly placed 3D variant, or a
  // decorative sign/radar/shield/orb/cube) for the active theme's 3D
  // counterpart. This makes chat/goal/alerts AND the decorative signs
  // "theme-following": a widget placed in one theme becomes the new theme's
  // equivalent on switch (or is hidden when the new theme has no counterpart).
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

  // In HUD edit mode we show a placeholder only for theme-gated widgets (e.g.
  // an additive 3D widget whose theme isn't active), so the streamer can still
  // arrange them. Role widgets (chat/goal/alerts/signs) are remapped, so they
  // are not ghosted. Service-disabled widgets stay hidden.
  function shouldGhost(item) {
    const def = widgetDef(item);
    const theme = def && def.theme ? def.theme : null;
    if (!theme) return false;
    if (widgetRole(item.type)) return false; // role widgets are remapped, not hidden
    return !active3dSet().includes(item.type);
  }

  // ---- widget manager ----
  const OW = window.OSEWidgets;
  const manager = new OW.WidgetManager(canvas, {
    resolveRenderType,
    shouldMount,
    transform,
    // Each widget gets its own family id so its hard internal theme gate
    // (`this.theme !== "cobra-mk2"`, etc.) passes even when a custom theme
    // mixes widgets from several 3D families.
    widgetTheme: (item) => {
      const def = widgetDef(item);
      return def && def.theme ? def.theme : "";
    },
    context,
  });

  manager.register("alerts", OW.AlertsWidget);
  manager.register("goal", OW.GoalWidget);
  manager.register("chat", OW.ChatWidget);
  manager.register("recent", OW.RecentWidget);
  manager.register("stat", OW.StatWidget);
  manager.register("social", OW.SocialWidget);
  manager.register("timer", OW.TimerWidget);
  manager.register("grimhex-timer", OW.GrimHexTimerWidget);
  manager.register("mic", OW.MicWidget);
  manager.register("death", OW.DeathWidget);
  manager.register("soundboard", OW.SoundboardWidget);
  manager.register("custom", OW.CustomWidget);
  manager.register("grimhex", OW.WidgetGrimHex);
  manager.register("musain", OW.WidgetMusain);
  manager.register("grimhex-chat", OW.WidgetGrimHexChat);
  manager.register("grimhex-goal", OW.WidgetGrimHexGoal);
  manager.register("grimhex-holo-alert", OW.WidgetGrimHexHoloAlert);
  manager.register("nuclear", OW.WidgetNuclear);
  manager.register("nuclear-chat", OW.WidgetNuclearChat);
  manager.register("nuclear-goal", OW.WidgetNuclearGoal);
  manager.register("nuclear-holo-alert", OW.WidgetNuclearHoloAlert);
  manager.register("cobra", OW.WidgetCobra);
  manager.register("elite-sign", OW.WidgetEliteSign);
  manager.register("teso-seal", OW.WidgetTesoSeal);
  manager.register("teso-chat", OW.WidgetTesoChat);
  manager.register("teso-goal", OW.WidgetTesoGoal);
  manager.register("teso-holo-alert", OW.WidgetTesoHoloAlert);
  manager.register("cobra-chat", OW.WidgetCobraChat);
  manager.register("cobra-goal", OW.WidgetCobraGoal);
  manager.register("cobra-holo-alert", OW.WidgetCobraHoloAlert);
  manager.register("cobra-shield", OW.WidgetCobraShield);
  manager.register("cobra-radar", OW.WidgetCobraRadar);
  manager.register("grimhex-radar", OW.WidgetGrimHexRadar);
  manager.register("md3-orb", OW.WidgetMd3Orb);
  manager.register("md3-chat", OW.WidgetMd3Chat);
  manager.register("md3-goal", OW.WidgetMd3Goal);
  manager.register("md3-holo-alert", OW.WidgetMd3HoloAlert);
  manager.register("pixel-cube", OW.WidgetPixelCube);
  manager.register("pixel-chat", OW.WidgetPixelChat);
  manager.register("pixel-goal", OW.WidgetPixelGoal);
  manager.register("pixel-holo-alert", OW.WidgetPixelHoloAlert);

  // ---- socket ----
  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE: {
        const p = msg.payload || {};
        state.goal = p.goal || state.goal;
        state.recentEvents = p.recentEvents || [];
        state.stats = p.stats || state.stats;
        state.topDonation = p.topDonation || state.topDonation;
        // Счёт донатов стрима приходит и в снимке: иначе виджет показывал бы
        // прочерк до первого доната после загрузки страницы.
        if (p.sessionDonations) state.sessionDonations = p.sessionDonations;
        state.deathCount = p.deathCount || 0;
        state.soundboardConfig = p.soundboard || state.soundboardConfig;
        state.tts = p.tts || state.tts;
        state.donationVoice = p.donationVoice || state.donationVoice;
        connectionStatus = p.connectionStatus || connectionStatus;
        state.longshot = p.longshot || state.longshot;
        currentLayout = p.layout || [];
        lastAppearance = p.appearance || lastAppearance;
        applyTheme(p.appearance);
        if (OW.HudEditor && p.hudEditMode !== undefined) OW.HudEditor.setEnabled(!!p.hudEditMode);
        manager.syncLayout(currentLayout);
        if (OW.HudEditor) OW.HudEditor.refresh();
        break;
      }
      case EVENT_TYPES.LAYOUT_UPDATE:
        currentLayout = (msg.payload && msg.payload.layout) || [];
        manager.syncLayout(currentLayout);
        if (OW.HudEditor) OW.HudEditor.refresh();
        break;
      case EVENT_TYPES.THEME_UPDATE:
        lastAppearance = msg.payload || lastAppearance;
        applyTheme(msg.payload);
        manager.syncLayout(currentLayout);
        if (OW.HudEditor) OW.HudEditor.refresh();
        break;
      case EVENT_TYPES.THEME_DRAFT_PREVIEW:
        if (isThemePreview) {
          applyDraftTheme(msg.payload);
          manager.syncLayout(currentLayout);
        }
        break;
      case EVENT_TYPES.STAT_UPDATE:
        state.stats = msg.payload || state.stats;
        bus.emit(EVENT_TYPES.STAT_UPDATE, msg.payload);
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
        manager.syncLayout(currentLayout);
        if (OW.HudEditor) OW.HudEditor.refresh();
        break;
      case EVENT_TYPES.CHAT_MESSAGE:
        bus.emit(EVENT_TYPES.CHAT_MESSAGE, msg.payload);
        break;
      case EVENT_TYPES.SOUNDBOARD_PLAY:
        bus.emit(EVENT_TYPES.SOUNDBOARD_PLAY, msg.payload);
        break;
      case EVENT_TYPES.REWARD_TTS:
        speakReward(msg.payload && msg.payload.text);
        break;
      case EVENT_TYPES.RECENT_EVENT:
        state.recentEvents = [msg.payload, ...state.recentEvents].slice(0, 15);
        bus.emit(EVENT_TYPES.RECENT_EVENT, msg.payload);
        break;
      case EVENT_TYPES.GOAL_UPDATE:
        state.goal = msg.payload || state.goal;
        bus.emit(EVENT_TYPES.GOAL_UPDATE, msg.payload);
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
      case EVENT_TYPES.LOCALES:
        if (window.I18n) {
          window.I18n.setLocales(msg.payload && msg.payload.locales);
          window.I18n.setLang(msg.payload && msg.payload.lang);
          window.I18n.apply();
        }
        bus.emit(EVENT_TYPES.LOCALES, msg.payload);
        break;
      case EVENT_TYPES.HUD_EDIT_MODE:
        if (OW.HudEditor) OW.HudEditor.setEnabled(!!(msg.payload && msg.payload.enabled));
        break;
      default:
        break;
    }
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?role=overlay`);
    // Микрокадры приходят бинарно — принимаем их как ArrayBuffer, чтобы не
    // создавать Blob на каждый кадр.
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        const frame = window.MicFrame && window.MicFrame.decode(ev.data);
        if (frame) state.remoteMicData = frame;
        return;
      }
      try {
        handleMessage(JSON.parse(ev.data));
      } catch (_) {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws.close();
  }

  function send(type, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
  }

  // Озвучка донатов: сначала голос от сервиса (DonationAlerts voice), затем
  // встроенный TTS как fallback.
  bus.on(EVENT_TYPES.ALERT, (alert) => {
    if (!alert || alert.kind !== "donation") return;
    if (playDonationVoice(alert)) return;
    speakDonation(alert);
  });

  // HUD direct-edit (game overlay): hand the composition root's internals to
  // the editor so drag/resize can mutate the live layout and commit it over
  // the bus. The editor stays inert (0 CPU) until a HUD_EDIT_MODE frame arrives.
  if (OW.HudEditor) {
    OW.HudEditor.init({ canvas, manager, send, EVENT_TYPES, getLayout: () => currentLayout, shouldGhost });
  }

  connect();
})();
