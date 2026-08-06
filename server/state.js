const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { WIDGET_TYPES } = require("../shared/widget-catalog");
const { BUILTIN_THEMES } = require("../shared/themes");
const { buildThemeTokens } = require("../shared/theme-engine");
const { defaultScenes } = require("../shared/scenes-catalog");

const CONFIG_DIR = path.join(__dirname, "..", "config");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const EXAMPLE_PATH = path.join(CONFIG_DIR, "config.example.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const example = fs.readFileSync(EXAMPLE_PATH, "utf-8");
    fs.writeFileSync(CONFIG_PATH, example);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function defaultAppearance() {
  return { activeThemeId: "nebula", customThemes: [] };
}

function defaultEditor() {
  return { gridSize: 5, snapEnabled: true };
}

class AppState {
  constructor() {
    this.config = loadConfig();
    if (!Array.isArray(this.config.layout)) this.config.layout = [];
    if (!this.config.appearance) this.config.appearance = defaultAppearance();
    if (!Array.isArray(this.config.appearance.customThemes)) this.config.appearance.customThemes = [];
    if (!this.config.editor) this.config.editor = defaultEditor();
    if (!this.config.scenes) this.config.scenes = defaultScenes();
    if (!this.config.topDonation) this.config.topDonation = { user: "", amount: 0, currency: "RUB" };
    this.runtime = {
      connectionStatus: {
        twitchChat: "disconnected",
        twitchEvents: this.config.twitch.userAccessToken ? "connecting" : "not_configured",
        donationAlerts: this.config.donationAlerts.accessToken ? "connecting" : "not_configured",
      },
      recentEvents: [],
      stats: { followerCount: null, subscriberCount: null },
    };
  }

  get layout() {
    return this.config.layout;
  }

  get goal() {
    return this.config.goal;
  }

  // ---- Layout (Figma-style canvas) ----

  addWidget(type) {
    const def = WIDGET_TYPES[type];
    if (!def) return null;
    const maxZ = this.config.layout.reduce((m, w) => Math.max(m, w.z || 0), 0);
    const instance = {
      id: crypto.randomUUID(),
      type,
      ...def.defaultGeometry,
      z: maxZ + 1,
      visible: true,
      config: { ...def.defaultConfig },
    };
    this.config.layout.push(instance);
    saveConfig(this.config);
    return instance;
  }

  updateWidget(id, patch = {}) {
    const widget = this.config.layout.find((w) => w.id === id);
    if (!widget) return null;
    const def = WIDGET_TYPES[widget.type] || { minW: 5, minH: 5 };

    if (typeof patch.w === "number") widget.w = clamp(patch.w, def.minW, 100);
    if (typeof patch.h === "number") widget.h = clamp(patch.h, def.minH, 100);
    if (typeof patch.x === "number") widget.x = clamp(patch.x, 0, 100 - widget.w);
    if (typeof patch.y === "number") widget.y = clamp(patch.y, 0, 100 - widget.h);
    if (typeof patch.visible === "boolean") widget.visible = patch.visible;
    if (patch.config && typeof patch.config === "object") {
      widget.config = { ...widget.config, ...patch.config };
    }
    saveConfig(this.config);
    return widget;
  }

  removeWidget(id) {
    const before = this.config.layout.length;
    this.config.layout = this.config.layout.filter((w) => w.id !== id);
    saveConfig(this.config);
    return this.config.layout.length !== before;
  }

  reorderWidget(id, direction) {
    const sorted = [...this.config.layout].sort((a, b) => (a.z || 0) - (b.z || 0));
    const idx = sorted.findIndex((w) => w.id === id);
    if (idx === -1) return false;
    const swapIdx = direction === "forward" ? idx + 1 : idx - 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return false;
    const a = sorted[idx];
    const b = sorted[swapIdx];
    const za = a.z;
    a.z = b.z;
    b.z = za;
    saveConfig(this.config);
    return true;
  }

  // ---- Goal / app config ----

  setGoal({ title, current, target, currency }) {
    if (title !== undefined) this.config.goal.title = String(title).slice(0, 80);
    if (current !== undefined) this.config.goal.current = Math.max(0, Number(current) || 0);
    if (target !== undefined) this.config.goal.target = Math.max(1, Number(target) || 1);
    if (currency !== undefined) this.config.goal.currency = String(currency).slice(0, 8);
    saveConfig(this.config);
    return this.config.goal;
  }

  addToGoal(amount) {
    this.config.goal.current = Math.max(0, (this.config.goal.current || 0) + (Number(amount) || 0));
    saveConfig(this.config);
    return this.config.goal;
  }

  setAppConfig({ twitchChannel }) {
    if (twitchChannel !== undefined) this.config.twitch.channel = String(twitchChannel).trim().toLowerCase();
    saveConfig(this.config);
  }

  pushRecentEvent(event) {
    this.runtime.recentEvents.unshift({ ...event, at: Date.now() });
    this.runtime.recentEvents = this.runtime.recentEvents.slice(0, 15);
  }

  setConnectionStatus(service, status) {
    this.runtime.connectionStatus[service] = status;
  }

  setStats(snapshot) {
    if (typeof snapshot.followerCount === "number") this.runtime.stats.followerCount = snapshot.followerCount;
    if (typeof snapshot.subscriberCount === "number") this.runtime.stats.subscriberCount = snapshot.subscriberCount;
    return this.runtime.stats;
  }

  adjustStats({ followerDelta, subscriberDelta }) {
    if (typeof followerDelta === "number" && typeof this.runtime.stats.followerCount === "number") {
      this.runtime.stats.followerCount = Math.max(0, this.runtime.stats.followerCount + followerDelta);
    }
    if (typeof subscriberDelta === "number" && typeof this.runtime.stats.subscriberCount === "number") {
      this.runtime.stats.subscriberCount = Math.max(0, this.runtime.stats.subscriberCount + subscriberDelta);
    }
    return this.runtime.stats;
  }

  saveTwitchApp({ clientId, clientSecret }) {
    if (clientId !== undefined) this.config.twitch.clientId = String(clientId).trim();
    if (clientSecret !== undefined) this.config.twitch.clientSecret = String(clientSecret).trim();
    saveConfig(this.config);
  }

  saveTwitchTokens({ userAccessToken, refreshToken, broadcasterId }) {
    if (userAccessToken !== undefined) this.config.twitch.userAccessToken = userAccessToken;
    if (refreshToken !== undefined) this.config.twitch.refreshToken = refreshToken;
    if (broadcasterId !== undefined) this.config.twitch.broadcasterId = broadcasterId;
    saveConfig(this.config);
  }

  saveDonationAlertsApp({ clientId, clientSecret }) {
    if (clientId !== undefined) this.config.donationAlerts.clientId = String(clientId).trim();
    if (clientSecret !== undefined) this.config.donationAlerts.clientSecret = String(clientSecret).trim();
    saveConfig(this.config);
  }

  saveDonationAlertsTokens({ accessToken, refreshToken, userId }) {
    if (accessToken !== undefined) this.config.donationAlerts.accessToken = accessToken;
    if (refreshToken !== undefined) this.config.donationAlerts.refreshToken = refreshToken;
    if (userId !== undefined) this.config.donationAlerts.userId = userId;
    saveConfig(this.config);
  }

  // ---- Appearance / themes ----

  findCustomTheme(id) {
    return this.config.appearance.customThemes.find((t) => t.id === id);
  }

  resolvedTheme() {
    const id = this.config.appearance.activeThemeId;
    if (BUILTIN_THEMES[id]) return BUILTIN_THEMES[id];
    const custom = this.findCustomTheme(id);
    if (custom) return { id: custom.id, name: custom.name, builtin: false, tokens: custom.tokens };
    return BUILTIN_THEMES.nebula;
  }

  listThemes() {
    const builtins = Object.values(BUILTIN_THEMES).map((t) => ({ id: t.id, name: t.name, builtin: true }));
    const custom = this.config.appearance.customThemes.map((t) => ({
      id: t.id,
      name: t.name,
      builtin: false,
      seeds: t.seeds,
    }));
    return [...builtins, ...custom];
  }

  setActiveTheme(id) {
    if (!BUILTIN_THEMES[id] && !this.findCustomTheme(id)) return false;
    this.config.appearance.activeThemeId = id;
    saveConfig(this.config);
    return true;
  }

  saveCustomTheme({ id, name, seeds }) {
    const cleanSeeds = {
      primary: seeds.primary || "#c6b8ff",
      secondary: seeds.secondary || "#7ee0d6",
      tertiary: seeds.tertiary || "#ffb0d8",
      surfaceSeed: seeds.surfaceSeed || seeds.primary || "#8878c8",
      shapeMode: seeds.shapeMode === "angular" ? "angular" : "rounded",
      fontPreset: seeds.fontPreset === "star-citizen" ? "star-citizen" : "nebula",
    };
    const tokens = buildThemeTokens(cleanSeeds);
    const cleanName = String(name || "Моя тема").slice(0, 40);

    let theme;
    if (id) {
      theme = this.findCustomTheme(id);
    }
    if (theme) {
      theme.name = cleanName;
      theme.seeds = cleanSeeds;
      theme.tokens = tokens;
    } else {
      theme = { id: crypto.randomUUID(), name: cleanName, seeds: cleanSeeds, tokens };
      this.config.appearance.customThemes.push(theme);
    }
    saveConfig(this.config);
    return theme;
  }

  deleteCustomTheme(id) {
    const before = this.config.appearance.customThemes.length;
    this.config.appearance.customThemes = this.config.appearance.customThemes.filter((t) => t.id !== id);
    if (this.config.appearance.activeThemeId === id) this.config.appearance.activeThemeId = "nebula";
    saveConfig(this.config);
    return this.config.appearance.customThemes.length !== before;
  }

  setEditorPrefs({ gridSize, snapEnabled }) {
    if (typeof gridSize === "number") this.config.editor.gridSize = clamp(gridSize, 0, 25);
    if (typeof snapEnabled === "boolean") this.config.editor.snapEnabled = snapEnabled;
    saveConfig(this.config);
    return this.config.editor;
  }

  // ---- Scenes (start / brb / end) ----

  setSceneConfig(sceneId, patch = {}) {
    const scene = this.config.scenes[sceneId];
    if (!scene) return null;
    if (patch.statusLabel !== undefined) scene.statusLabel = String(patch.statusLabel).slice(0, 60);
    if (patch.title !== undefined) scene.title = String(patch.title).slice(0, 80);
    if (patch.subtitle !== undefined) scene.subtitle = String(patch.subtitle).slice(0, 160);
    if (patch.timerDoneText !== undefined) scene.timerDoneText = String(patch.timerDoneText).slice(0, 120);
    if (typeof patch.showTimer === "boolean") scene.showTimer = patch.showTimer;
    if (typeof patch.timerDuration === "number") scene.timerDuration = Math.max(0, Math.round(patch.timerDuration));
    if (typeof patch.showEvents === "boolean") scene.showEvents = patch.showEvents;
    if (typeof patch.showSocials === "boolean") scene.showSocials = patch.showSocials;
    if (Array.isArray(patch.socials)) {
      scene.socials = patch.socials
        .slice(0, 6)
        .map((s) => ({ platform: String(s.platform || "").slice(0, 4), text: String(s.text || "").slice(0, 60) }));
    }
    saveConfig(this.config);
    return scene;
  }

  resetTopDonation() {
    this.config.topDonation = { user: "", amount: 0, currency: "RUB" };
    saveConfig(this.config);
    return this.config.topDonation;
  }

  maybeUpdateTopDonation({ user, amount, currency }) {
    if (typeof amount !== "number" || amount <= (this.config.topDonation.amount || 0)) return null;
    this.config.topDonation = { user: user || "Аноним", amount, currency: currency || "RUB" };
    saveConfig(this.config);
    return this.config.topDonation;
  }

  // ---- Import / export ----

  replaceConfig(newConfig) {
    if (!newConfig || typeof newConfig !== "object") throw new Error("Файл настроек повреждён или не в том формате");
    this.config = {
      port: typeof newConfig.port === "number" ? newConfig.port : this.config.port,
      twitch: { ...this.config.twitch, ...(newConfig.twitch || {}) },
      donationAlerts: { ...this.config.donationAlerts, ...(newConfig.donationAlerts || {}) },
      goal: { ...this.config.goal, ...(newConfig.goal || {}) },
      layout: Array.isArray(newConfig.layout) ? newConfig.layout : this.config.layout,
      appearance: {
        ...defaultAppearance(),
        ...this.config.appearance,
        ...(newConfig.appearance || {}),
        customThemes: Array.isArray(newConfig.appearance && newConfig.appearance.customThemes)
          ? newConfig.appearance.customThemes
          : this.config.appearance.customThemes,
      },
      editor: { ...defaultEditor(), ...this.config.editor, ...(newConfig.editor || {}) },
      scenes: newConfig.scenes ? { ...defaultScenes(), ...newConfig.scenes } : this.config.scenes,
      topDonation: newConfig.topDonation || this.config.topDonation,
    };
    saveConfig(this.config);
  }

  snapshot() {
    const theme = this.resolvedTheme();
    return {
      layout: this.config.layout,
      goal: this.config.goal,
      port: this.config.port,
      twitchChannel: this.config.twitch.channel,
      twitchClientId: this.config.twitch.clientId,
      donationAlertsClientId: this.config.donationAlerts.clientId,
      connectionStatus: this.runtime.connectionStatus,
      recentEvents: this.runtime.recentEvents,
      stats: this.runtime.stats,
      appearance: {
        activeThemeId: this.config.appearance.activeThemeId,
        tokens: theme.tokens,
        themes: this.listThemes(),
      },
      editor: this.config.editor,
      scenes: this.config.scenes,
      topDonation: this.config.topDonation,
    };
  }
}

module.exports = { AppState, saveConfig, CONFIG_PATH };
