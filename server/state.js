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

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { seal, open } = require("./secret-store");
const { WIDGET_TYPES } = require("../shared/widget-catalog");
const { BUILTIN_THEMES } = require("../shared/themes");
const { buildThemeTokens } = require("../shared/theme-engine");
const { defaultScenes } = require("../shared/scenes-catalog");
const { getConfigPath, getExamplePath } = require("./storage-paths");

function loadConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    const example = fs.readFileSync(getExamplePath(), "utf-8");
    fs.writeFileSync(configPath, example);
  }
  return decryptConfig(JSON.parse(fs.readFileSync(configPath, "utf-8")));
}

function saveConfig(config) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(encryptConfig(config), null, 2));
}

function encryptConfig(config) {
  const twitch = config.twitch || {};
  const donationAlerts = config.donationAlerts || {};
  const youtube = config.youtube || {};
  const obs = config.obs || {};
  return {
    ...config,
    twitch: {
      ...twitch,
      clientSecret: seal(twitch.clientSecret),
      userAccessToken: seal(twitch.userAccessToken),
      refreshToken: seal(twitch.refreshToken),
    },
    donationAlerts: {
      ...donationAlerts,
      clientSecret: seal(donationAlerts.clientSecret),
      accessToken: seal(donationAlerts.accessToken),
      refreshToken: seal(donationAlerts.refreshToken),
    },
    youtube: {
      ...youtube,
      clientSecret: seal(youtube.clientSecret),
      accessToken: seal(youtube.accessToken),
      refreshToken: seal(youtube.refreshToken),
    },
    obs: {
      ...obs,
      password: seal(obs.password),
    },
  };
}

function decryptConfig(config) {
  const twitch = config.twitch || {};
  const donationAlerts = config.donationAlerts || {};
  const youtube = config.youtube || {};
  const obs = config.obs || {};
  return {
    ...config,
    twitch: {
      ...twitch,
      clientSecret: open(twitch.clientSecret),
      userAccessToken: open(twitch.userAccessToken),
      refreshToken: open(twitch.refreshToken),
    },
    donationAlerts: {
      ...donationAlerts,
      clientSecret: open(donationAlerts.clientSecret),
      accessToken: open(donationAlerts.accessToken),
      refreshToken: open(donationAlerts.refreshToken),
    },
    youtube: {
      ...youtube,
      clientSecret: open(youtube.clientSecret),
      accessToken: open(youtube.accessToken),
      refreshToken: open(youtube.refreshToken),
    },
    obs: {
      ...obs,
      password: open(obs.password),
    },
  };
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function fisherYates(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function defaultAppearance() {
  return { activeThemeId: "nebula", customThemes: [] };
}

function defaultEditor() {
  return { gridSize: 5, snapEnabled: true };
}

class AppState {
  constructor(db, config) {
    this.db = db || null;
    this.config = config || loadConfig();
    if (!this.config.appearance) this.config.appearance = defaultAppearance();
    if (!Array.isArray(this.config.appearance.customThemes)) this.config.appearance.customThemes = [];
    if (!this.config.editor) this.config.editor = defaultEditor();
    const scenesDefaults = defaultScenes();
    this.config.scenes = this.config.scenes || {};
    Object.keys(scenesDefaults).forEach((sceneId) => {
      this.config.scenes[sceneId] = { ...scenesDefaults[sceneId], ...(this.config.scenes[sceneId] || {}) };
    });
    if (!this.config.topDonation) this.config.topDonation = { user: "", amount: 0, currency: "RUB" };
    this.config.youtube = { clientId: "", clientSecret: "", accessToken: "", refreshToken: "", videoId: "", ...(this.config.youtube || {}) };
    this.config.obs = {
      enabled: false,
      host: "127.0.0.1",
      port: 4455,
      password: "",
      ...(this.config.obs || {}),
      sceneMap: { main: "", start: "", brb: "", talk: "", end: "", wheel: "", ...((this.config.obs && this.config.obs.sceneMap) || {}) },
      customCommands: Array.isArray(this.config.obs && this.config.obs.customCommands) ? this.config.obs.customCommands : [],
      cameraAngles: Array.isArray(this.config.obs && this.config.obs.cameraAngles) ? this.config.obs.cameraAngles : [],
      cameraFilters: Array.isArray(this.config.obs && this.config.obs.cameraFilters) ? this.config.obs.cameraFilters : [],
    };
    const sb = this.config.soundboard || {};
    this.config.soundboard = {
      enabled: sb.enabled !== false,
      volume: typeof sb.volume === "number" ? sb.volume : 0.8,
      queueMode: !!sb.queueMode,
      sounds: Array.isArray(sb.sounds) ? sb.sounds : [],
    };
    const sd = this.config.streamdeck || {};
    this.config.streamdeck = {
      icons: {
        start: "",
        brb: "",
        wheel: "",
        talk: "",
        end: "",
        ...(sd.icons || {}),
      },
    };
    if (this.config.twitch.enabled === undefined) this.config.twitch.enabled = true;
    if (this.config.donationAlerts.enabled === undefined) this.config.donationAlerts.enabled = true;
    if (this.config.youtube.enabled === undefined) this.config.youtube.enabled = true;

    if (this.db) {
      this._layout = this._loadLayoutFromDb();
      delete this.config.layout;
    } else {
      this._layout = Array.isArray(this.config.layout) ? this.config.layout : [];
    }

    this.runtime = {
      connectionStatus: {
        twitchChat: "disconnected",
        twitchEvents: this.config.twitch.userAccessToken ? "connecting" : "not_configured",
        donationAlerts: this.config.donationAlerts.accessToken ? "connecting" : "not_configured",
        youtube: this.config.youtube.accessToken ? "connecting" : "not_configured",
        obs: "not_configured",
      },
      recentEvents: [],
      stats: { followerCount: null, subscriberCount: null },
      deathCount: 0,
      activeScene: "main",
      activeCameraAngle: null,
      activeFilters: new Set(),
      giveaway: {
        active: false,
        command: "!go",
        eliminationMode: false,
        participants: new Set(),
        winner: null,
        isFinalWinner: false,
        pendingWinner: null,
      },
    };
  }

  get layout() {
    return this._layout;
  }

  _loadLayoutFromDb() {
    const widgets = this.db.getWidgets();
    if (Array.isArray(widgets) && widgets.length) return widgets;
    const legacy = Array.isArray(this.config.layout) ? this.config.layout : [];
    if (legacy.length) this.db.saveWidgets(legacy);
    return legacy;
  }

  _persistLayout() {
    if (this.db) {
      this.db.saveWidgets(this._layout);
    } else {
      this.config.layout = this._layout;
      saveConfig(this.config);
    }
  }

  get goal() {
    return this.config.goal;
  }

  // ---- Layout (Figma-style canvas) ----

  addWidget(type) {
    const def = WIDGET_TYPES[type];
    if (!def) return null;
    const maxZ = this._layout.reduce((m, w) => Math.max(m, w.z || 0), 0);
    const instance = {
      id: crypto.randomUUID(),
      type,
      ...def.defaultGeometry,
      z: maxZ + 1,
      visible: true,
      config: { ...def.defaultConfig },
    };
    this._layout.push(instance);
    this._persistLayout();
    return instance;
  }

  updateWidget(id, patch = {}) {
    const widget = this._layout.find((w) => w.id === id);
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
    this._persistLayout();
    return widget;
  }

  removeWidget(id) {
    const before = this._layout.length;
    this._layout = this._layout.filter((w) => w.id !== id);
    this._persistLayout();
    return this._layout.length !== before;
  }

  reorderWidget(id, direction) {
    const sorted = [...this._layout].sort((a, b) => (a.z || 0) - (b.z || 0));
    const idx = sorted.findIndex((w) => w.id === id);
    if (idx === -1) return false;
    const swapIdx = direction === "forward" ? idx + 1 : idx - 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return false;
    const a = sorted[idx];
    const b = sorted[swapIdx];
    const za = a.z;
    a.z = b.z;
    b.z = za;
    this._persistLayout();
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

  setAppConfig({ twitchChannel, port }) {
    if (twitchChannel !== undefined) this.config.twitch.channel = String(twitchChannel).trim().toLowerCase();
    if (port !== undefined) this.config.port = Math.max(1024, Math.min(65535, Number(port) || 8710));
    saveConfig(this.config);
  }

  setObsConfig(patch = {}) {
    if (patch.host !== undefined) this.config.obs.host = String(patch.host).trim();
    if (patch.port !== undefined) this.config.obs.port = Number(patch.port) || 4455;
    if (patch.password !== undefined) this.config.obs.password = String(patch.password);
    if (patch.sceneMap && typeof patch.sceneMap === "object") {
      this.config.obs.sceneMap = { ...this.config.obs.sceneMap, ...patch.sceneMap };
    }
    if (Array.isArray(patch.customCommands)) {
      this.config.obs.customCommands = patch.customCommands.slice(0, 50).map((c) => ({
        id: String(c.id || "").trim(),
        label: String(c.label || "").trim(),
        requestType: String(c.requestType || "").trim(),
        requestData: c.requestData && typeof c.requestData === "object" ? c.requestData : {},
      }));
    }
    if (Array.isArray(patch.cameraAngles)) {
      this.config.obs.cameraAngles = patch.cameraAngles.slice(0, 30).map((a) => ({
        id: String(a.id || "").trim(),
        label: String(a.label || "").trim(),
        twitchRewardTitle: String(a.twitchRewardTitle || "").trim(),
        sceneName: String(a.sceneName || "").trim(),
        cameraSource: String(a.cameraSource || "").trim(),
      }));
    }
    if (Array.isArray(patch.cameraFilters)) {
      this.config.obs.cameraFilters = patch.cameraFilters.slice(0, 50).map((f) => ({
        id: String(f.id || "").trim(),
        label: String(f.label || "").trim(),
        twitchRewardTitle: String(f.twitchRewardTitle || "").trim(),
        sourceName: String(f.sourceName || "").trim(),
        filterName: String(f.filterName || "").trim(),
        durationSec: Math.max(0, Number(f.durationSec) || 0),
      }));
    }
    saveConfig(this.config);
    return this.config.obs;
  }

  setSoundboardConfig(patch = {}) {
    if (patch.enabled !== undefined) this.config.soundboard.enabled = !!patch.enabled;
    if (patch.volume !== undefined) this.config.soundboard.volume = clamp(Number(patch.volume) || 0, 0, 1);
    if (patch.queueMode !== undefined) this.config.soundboard.queueMode = !!patch.queueMode;
    if (Array.isArray(patch.sounds)) {
      this.config.soundboard.sounds = patch.sounds.slice(0, 50).map((s) => ({
        id: String(s.id || "").trim(),
        rewardTitle: String(s.rewardTitle || "").trim(),
        rewardId: String(s.rewardId || "").trim(),
        audioFile: String(s.audioFile || "").trim(),
        imageFile: String(s.imageFile || "").trim(),
        title: String(s.title || s.rewardTitle || "").trim(),
      }));
    }
    saveConfig(this.config);
    return this.config.soundboard;
  }

  setStreamDeckConfig(patch = {}) {
    if (patch.icons && typeof patch.icons === "object") {
      const next = { ...this.config.streamdeck.icons, ...patch.icons };
      Object.keys(next).forEach((key) => {
        next[key] = String(next[key] || "").trim();
      });
      this.config.streamdeck.icons = next;
    }
    saveConfig(this.config);
    return this.config.streamdeck;
  }

  // ---- Death counter (remote quick action) ----

  adjustDeathCount(delta) {
    this.runtime.deathCount = Math.max(0, (this.runtime.deathCount || 0) + (Number(delta) || 0));
    return { count: this.runtime.deathCount };
  }

  resetDeathCount() {
    this.runtime.deathCount = 0;
    return { count: 0 };
  }

  setActiveScene(scene) {
    this.runtime.activeScene = String(scene || "main");
    return this.runtime.activeScene;
  }

  setActiveCameraAngle(angleId) {
    this.runtime.activeCameraAngle = angleId ? String(angleId) : null;
    return this.runtime.activeCameraAngle;
  }

  setActiveFilter(filterId, active) {
    if (!filterId) return this.getActiveFilters();
    if (active) this.runtime.activeFilters.add(String(filterId));
    else this.runtime.activeFilters.delete(String(filterId));
    return this.getActiveFilters();
  }

  getActiveFilters() {
    return [...this.runtime.activeFilters];
  }

  // ---- Giveaway / Fortune Wheel ----

  giveawaySnapshot() {
    return {
      active: this.runtime.giveaway.active,
      command: this.runtime.giveaway.command,
      eliminationMode: this.runtime.giveaway.eliminationMode,
      winner: this.runtime.giveaway.winner,
      isFinalWinner: this.runtime.giveaway.isFinalWinner,
      count: this.runtime.giveaway.participants.size,
      participants: [...this.runtime.giveaway.participants],
    };
  }

  startGiveaway(command) {
    this.runtime.giveaway.command = String(command || "!go").trim() || "!go";
    this.runtime.giveaway.active = true;
    this.runtime.giveaway.participants = new Set();
    this.runtime.giveaway.winner = null;
    this.runtime.giveaway.isFinalWinner = false;
    this.runtime.giveaway.pendingWinner = null;
    return this.giveawaySnapshot();
  }

  stopGiveaway() {
    this.runtime.giveaway.active = false;
    return this.giveawaySnapshot();
  }

  addGiveawayParticipant(username) {
    const name = String(username || "").trim();
    if (!name) return null;
    if (this.runtime.giveaway.participants.has(name)) return null;
    this.runtime.giveaway.participants.add(name);
    return this.giveawaySnapshot();
  }

  removeGiveawayParticipant(username) {
    const name = String(username || "").trim();
    if (name) this.runtime.giveaway.participants.delete(name);
    return this.giveawaySnapshot();
  }

  clearGiveawayParticipants() {
    this.runtime.giveaway.participants = new Set();
    this.runtime.giveaway.winner = null;
    this.runtime.giveaway.isFinalWinner = false;
    this.runtime.giveaway.pendingWinner = null;
    return this.giveawaySnapshot();
  }

  clearGiveawayResult() {
    this.runtime.giveaway.winner = null;
    this.runtime.giveaway.isFinalWinner = false;
    this.runtime.giveaway.pendingWinner = null;
    return this.giveawaySnapshot();
  }

  handleGiveawayChat(username, message) {
    const g = this.runtime.giveaway;
    if (!g.active) return null;
    const cmd = g.command.trim().toLowerCase();
    const msg = String(message || "").trim().toLowerCase();
    if (!cmd || msg !== cmd) return null;
    return this.addGiveawayParticipant(username);
  }

  shuffleGiveaway() {
    const arr = [...this.runtime.giveaway.participants];
    fisherYates(arr);
    this.runtime.giveaway.participants = new Set(arr);
    return this.giveawaySnapshot();
  }

  setGiveawayEliminationMode(enabled) {
    this.runtime.giveaway.eliminationMode = !!enabled;
    return this.giveawaySnapshot();
  }

  setGiveawayWinner(username) {
    const name = String(username || "").trim();
    const g = this.runtime.giveaway;
    g.winner = name || null;

    // Финал определяем ДО удаления победителя: он был последним участником.
    const isFinalWinner = !!g.eliminationMode && !!name && g.participants.has(name) && g.participants.size === 1;
    g.isFinalWinner = isFinalWinner;

    if (name && g.eliminationMode) {
      g.participants.delete(name);
    }
    return this.giveawaySnapshot();
  }

  pickRandomWinner() {
    const participants = [...this.runtime.giveaway.participants];
    if (!participants.length) return null;
    const idx = Math.floor(Math.random() * participants.length);
    const winner = participants[idx];
    this.runtime.giveaway.pendingWinner = winner;
    return winner;
  }

  consumePendingWinner(username) {
    const name = String(username || "").trim();
    if (!name || name !== this.runtime.giveaway.pendingWinner) return false;
    this.runtime.giveaway.pendingWinner = null;
    return true;
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

  saveTwitchTokens({ userAccessToken, refreshToken, broadcasterId, expiresAt }) {
    if (userAccessToken !== undefined) this.config.twitch.userAccessToken = userAccessToken;
    if (refreshToken !== undefined) this.config.twitch.refreshToken = refreshToken;
    if (broadcasterId !== undefined) this.config.twitch.broadcasterId = broadcasterId;
    if (expiresAt !== undefined) this.config.twitch.expiresAt = expiresAt;
    saveConfig(this.config);
  }

  saveDonationAlertsApp({ clientId, clientSecret }) {
    if (clientId !== undefined) this.config.donationAlerts.clientId = String(clientId).trim();
    if (clientSecret !== undefined) this.config.donationAlerts.clientSecret = String(clientSecret).trim();
    saveConfig(this.config);
  }

  saveDonationAlertsTokens({ accessToken, refreshToken, userId, expiresAt }) {
    if (accessToken !== undefined) this.config.donationAlerts.accessToken = accessToken;
    if (refreshToken !== undefined) this.config.donationAlerts.refreshToken = refreshToken;
    if (userId !== undefined) this.config.donationAlerts.userId = userId;
    if (expiresAt !== undefined) this.config.donationAlerts.expiresAt = expiresAt;
    saveConfig(this.config);
  }

  saveYoutubeApp({ clientId, clientSecret }) {
    if (clientId !== undefined) this.config.youtube.clientId = String(clientId).trim();
    if (clientSecret !== undefined) this.config.youtube.clientSecret = String(clientSecret).trim();
    saveConfig(this.config);
  }

  saveYoutubeTokens({ accessToken, refreshToken, expiresAt }) {
    if (accessToken !== undefined) this.config.youtube.accessToken = accessToken;
    if (refreshToken !== undefined) this.config.youtube.refreshToken = refreshToken;
    if (expiresAt !== undefined) this.config.youtube.expiresAt = expiresAt;
    saveConfig(this.config);
  }

  setYoutubeVideoId(videoId) {
    this.config.youtube.videoId = String(videoId || "").trim();
    saveConfig(this.config);
    return this.config.youtube.videoId;
  }

  setIntegrationEnabled(service, enabled) {
    const key = { twitch: "twitch", donationAlerts: "donationAlerts", youtube: "youtube", obs: "obs" }[service];
    if (!key) return;
    this.config[key].enabled = !!enabled;
    saveConfig(this.config);
    return this.config[key].enabled;
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
    const builtins = Object.values(BUILTIN_THEMES).map((t) => ({
      id: t.id,
      name: t.name,
      builtin: true,
      category: t.category || "system",
      dimension: t.dimension || "2d",
    }));
    const custom = this.config.appearance.customThemes.map((t) => ({
      id: t.id,
      name: t.name,
      builtin: false,
      category: "custom",
      dimension: "2d",
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
      fontPreset: seeds.fontPreset === "orbital" ? "orbital" : "nebula",
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
    if (!newConfig || typeof newConfig !== "object" || Array.isArray(newConfig)) {
      throw new Error("Файл настроек повреждён или не в том формате");
    }

    // Входящие массивы принимаются только если они действительно массивы;
    // иначе сохраняем текущее значение, чтобы повреждённый файл не стирал данные.
    const keepArr = (incoming, existing) => (Array.isArray(incoming) ? incoming : existing);
    const port = Number(newConfig.port);
    const portValid = Number.isInteger(port) && port >= 1024 && port <= 65535;

    this.config = {
      port: portValid ? port : this.config.port,
      twitch: { ...this.config.twitch, ...(newConfig.twitch || {}) },
      donationAlerts: { ...this.config.donationAlerts, ...(newConfig.donationAlerts || {}) },
      youtube: { ...this.config.youtube, ...(newConfig.youtube || {}) },
      obs: {
        ...this.config.obs,
        ...(newConfig.obs || {}),
        sceneMap: { ...this.config.obs.sceneMap, ...((newConfig.obs && newConfig.obs.sceneMap) || {}) },
        customCommands: keepArr(newConfig.obs && newConfig.obs.customCommands, this.config.obs.customCommands),
        cameraAngles: keepArr(newConfig.obs && newConfig.obs.cameraAngles, this.config.obs.cameraAngles),
        cameraFilters: keepArr(newConfig.obs && newConfig.obs.cameraFilters, this.config.obs.cameraFilters),
      },
      goal: { ...this.config.goal, ...(newConfig.goal || {}) },
      soundboard: {
        ...this.config.soundboard,
        ...(newConfig.soundboard || {}),
        sounds: keepArr(newConfig.soundboard && newConfig.soundboard.sounds, this.config.soundboard.sounds),
      },
      streamdeck: {
        ...this.config.streamdeck,
        ...(newConfig.streamdeck || {}),
        icons: { ...this.config.streamdeck.icons, ...((newConfig.streamdeck && newConfig.streamdeck.icons) || {}) },
      },
      appearance: {
        ...defaultAppearance(),
        ...this.config.appearance,
        ...(newConfig.appearance || {}),
        customThemes: keepArr(newConfig.appearance && newConfig.appearance.customThemes, this.config.appearance.customThemes),
      },
      editor: { ...defaultEditor(), ...this.config.editor, ...(newConfig.editor || {}) },
      scenes: newConfig.scenes ? { ...defaultScenes(), ...newConfig.scenes } : this.config.scenes,
      topDonation: newConfig.topDonation || this.config.topDonation,
    };

    if (Array.isArray(newConfig.layout)) this._layout = newConfig.layout;
    if (this.db) {
      this.db.saveWidgets(this._layout);
    } else {
      this.config.layout = this._layout;
    }
    saveConfig(this.config);
  }

  snapshot() {
    const theme = this.resolvedTheme();
    return {
      layout: this._layout,
      goal: this.config.goal,
      port: this.config.port,
      twitchChannel: this.config.twitch.channel,
      twitchClientId: this.config.twitch.clientId,
      donationAlertsClientId: this.config.donationAlerts.clientId,
      youtubeClientId: this.config.youtube.clientId,
      youtubeVideoId: this.config.youtube.videoId,
      twitchEnabled: this.config.twitch.enabled,
      donationAlertsEnabled: this.config.donationAlerts.enabled,
      youtubeEnabled: this.config.youtube.enabled,
      obs: this.config.obs,
      soundboard: this.config.soundboard,
      streamdeck: this.config.streamdeck,
      connectionStatus: this.runtime.connectionStatus,
      recentEvents: this.runtime.recentEvents,
      stats: this.runtime.stats,
      deathCount: this.runtime.deathCount,
      activeScene: this.runtime.activeScene,
      activeCameraAngle: this.runtime.activeCameraAngle,
      activeFilters: this.getActiveFilters(),
      giveaway: this.giveawaySnapshot(),
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

module.exports = { AppState, saveConfig, fisherYates };
