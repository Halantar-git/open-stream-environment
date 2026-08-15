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

const path = require("path");
const os = require("os");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { EventEmitter } = require("events");

const { AppState } = require("./state");
const { getUserMediaDir } = require("./storage-paths");
const { EVENT_TYPES, ALERT_DURATIONS_MS } = require("../shared/events");
const { createLogger } = require("./logger");
const { mountOAuthRoutes, buildTwitchAuthorizeUrl, buildDonationAlertsAuthorizeUrl, buildYoutubeAuthorizeUrl } = require("./oauth");
const { startTwitchChat } = require("./integrations/twitch-chat");
const { startTwitchEvents } = require("./integrations/twitch-eventsub");
const { startDonationAlerts } = require("./integrations/donationalerts");
const { startYoutube } = require("./integrations/youtube-live");
const { startObsWebSocket } = require("./integrations/obs-websocket");

const LOCALES = {
  ru: require("../shared/locales/ru.json"),
  en: require("../shared/locales/en.json"),
};

const bus = new EventEmitter();

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function createServer({ db } = {}) {
  const state = new AppState(db);
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  app.use(express.static(path.join(__dirname, "..", "overlay"), { redirect: false }));
  app.use("/overlay", express.static(path.join(__dirname, "..", "overlay")));
  app.use("/shared", express.static(path.join(__dirname, "..", "shared")));
  app.use("/assets", express.static(path.join(__dirname, "..", "assets")));
  app.use("/media", express.static(getUserMediaDir()));
  app.use("/remote", express.static(path.join(__dirname, "..", "remote")));

  let twitchChatCtrl = null;
  let twitchEventsCtrl = null;
  let donationAlertsCtrl = null;
  let youtubeCtrl = null;
  let obsCtrl = null;
  let currentSession = null;
  let autoSpinTimer = null;
  let isSpinning = false;
  let language = db ? db.getLanguage() : "en";
  const serverLog = createLogger(bus, "server");
  const remoteUrl = `http://${getLocalIp()}:${state.config.port || 8710}/remote`;

  function stateSnapshot() {
    return { ...state.snapshot(), remoteUrl };
  }

  function broadcast(type, payload) {
    const message = JSON.stringify({ type, payload });
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(message);
    });
  }

  function setLanguage(code) {
    language = code === "ru" ? "ru" : "en";
    if (db) db.saveLanguage(language);
    broadcast(EVENT_TYPES.LOCALES, { lang: language, locales: LOCALES });
    return language;
  }

  function broadcastGiveaway(giveaway) {
    broadcast(EVENT_TYPES.GIVEAWAY_UPDATE, { giveaway });
    broadcast(EVENT_TYPES.GIVEAWAY_PARTICIPANTS, {
      count: giveaway.count,
      participants: giveaway.participants,
    });
  }

  function clearAutoSpin() {
    clearTimeout(autoSpinTimer);
    autoSpinTimer = null;
  }

  function scheduleAutoSpin() {
    clearAutoSpin();
    autoSpinTimer = setTimeout(() => {
      autoSpinTimer = null;
      if (isSpinning) return; // предыдущий цикл ещё не завершён
      // Re-sync the wheel sectors right before the next spin so the already
      // eliminated participant disappears from the barrel without yanking the
      // arrow away from the winner while the result alert is still on screen.
      broadcast(EVENT_TYPES.GIVEAWAY_WHEEL, { sectors: state.giveawaySnapshot().participants });
      const winner = state.pickRandomWinner();
      if (winner) {
        isSpinning = true;
        broadcast(EVENT_TYPES.GIVEAWAY_SPIN, { winner });
      }
    }, 1800);
  }

  function restartTwitchChat() {
    if (twitchChatCtrl) twitchChatCtrl.stop();
    twitchChatCtrl = null;
    if (!state.config.twitch.enabled) {
      bus.emit("connection_status", { service: "twitchChat", status: "disabled" });
      return;
    }
    twitchChatCtrl = startTwitchChat({ bus, channel: state.config.twitch.channel });
  }

  function restartTwitchEvents() {
    if (twitchEventsCtrl) twitchEventsCtrl.stop();
    twitchEventsCtrl = null;
    if (!state.config.twitch.enabled) {
      bus.emit("connection_status", { service: "twitchEvents", status: "disabled" });
      return;
    }
    if (state.config.twitch.userAccessToken && state.config.twitch.broadcasterId) {
      twitchEventsCtrl = startTwitchEvents({ bus, state });
    } else {
      bus.emit("connection_status", { service: "twitchEvents", status: "not_configured" });
    }
  }

  function restartDonationAlerts() {
    if (donationAlertsCtrl) donationAlertsCtrl.stop();
    donationAlertsCtrl = null;
    if (!state.config.donationAlerts.enabled) {
      bus.emit("connection_status", { service: "donationAlerts", status: "disabled" });
      return;
    }
    if (state.config.donationAlerts.accessToken) {
      donationAlertsCtrl = startDonationAlerts({ bus, state });
    } else {
      bus.emit("connection_status", { service: "donationAlerts", status: "not_configured" });
    }
  }

  function restartYoutube() {
    if (youtubeCtrl) youtubeCtrl.stop();
    youtubeCtrl = null;
    if (!state.config.youtube.enabled) {
      bus.emit("connection_status", { service: "youtube", status: "disabled" });
      return;
    }
    if (state.config.youtube.accessToken) {
      youtubeCtrl = startYoutube({ bus, state });
    } else {
      bus.emit("connection_status", { service: "youtube", status: "not_configured" });
    }
  }

  function restartObs() {
    if (obsCtrl) obsCtrl.stop();
    obsCtrl = null;
    if (!state.config.obs.enabled) {
      bus.emit("connection_status", { service: "obs", status: "disabled" });
      return;
    }
    if (state.config.obs.host && state.config.obs.port) {
      obsCtrl = startObsWebSocket({ bus, config: state.config });
    } else {
      bus.emit("connection_status", { service: "obs", status: "not_configured" });
    }
  }

  function runObsCommand(id) {
    const cmd = (state.config.obs.customCommands || []).find((c) => c.id === id);
    if (!cmd) return false;
    if (!obsCtrl) {
      serverLog.warn("OBS command skipped (OBS not connected)", { id });
      return false;
    }
    obsCtrl.sendRawRequest(cmd.requestType, cmd.requestData || {}).catch((err) =>
      serverLog.warn("OBS raw command failed", { id, message: err.message })
    );
    return true;
  }

  // Play a configured Soundboard sound on the overlay. Shared by the control
  // panel test button and external triggers (Web Remote / Stream Deck).
  function triggerSoundboardSound(soundId, user) {
    const sound = (state.config.soundboard.sounds || []).find((s) => s.id === soundId);
    if (!sound) {
      serverLog.warn("soundboard trigger skipped (unknown sound)", { soundId });
      return false;
    }
    bus.emit("soundboard_play", {
      soundId: sound.id,
      title: sound.title || sound.rewardTitle || sound.id,
      user: user || "Stream Deck",
      audioFile: sound.audioFile,
      imageFile: sound.imageFile,
    });
    return true;
  }

  // Permanent camera-angle switch (no timer). Delegates the OBS work to the
  // obs-websocket module and returns immediately; the result is broadcast back
  // via the `camera_angle_changed` bus event.
  function setCameraAngle(angleId) {
    if (!obsCtrl) {
      serverLog.warn("camera angle skipped (OBS not connected)", { angleId });
      return false;
    }
    obsCtrl.setCameraAngle(angleId).catch((err) =>
      serverLog.warn("camera angle failed", { angleId, message: err.message })
    );
    return true;
  }

  // Camera filter (OBS source filter toggle, timed or permanent). Delegates to
  // the obs-websocket module; active state is broadcast back via
  // `camera_filter_changed`.
  function setCameraFilter(filterId) {
    if (!obsCtrl) {
      serverLog.warn("camera filter skipped (OBS not connected)", { filterId });
      return false;
    }
    obsCtrl.triggerCameraFilter(filterId).catch((err) =>
      serverLog.warn("camera filter failed", { filterId, message: err.message })
    );
    return true;
  }

  mountOAuthRoutes(app, {
    state,
    hooks: {
      onTwitchConnected: restartTwitchEvents,
      onDonationAlertsConnected: restartDonationAlerts,
      onYoutubeConnected: restartYoutube,
    },
  });

  // ---- IPC-style commands over the same WS the overlay listens on ----
  app.get("/api/oauth-urls", (req, res) => {
    res.json({
      twitch: buildTwitchAuthorizeUrl(state.config, state.config.port),
      donationAlerts: buildDonationAlertsAuthorizeUrl(state.config, state.config.port),
      youtube: buildYoutubeAuthorizeUrl(state.config, state.config.port),
    });
  });

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: EVENT_TYPES.LOCALES, payload: { lang: language, locales: LOCALES } }));
    socket.send(JSON.stringify({ type: EVENT_TYPES.STATE, payload: stateSnapshot() }));
    if (db) {
      socket.send(JSON.stringify({ type: EVENT_TYPES.OVERLAY_PARTICIPANTS_CONFIG, payload: { config: db.getParticipantsConfig() } }));
      socket.send(JSON.stringify({ type: EVENT_TYPES.WHEEL_CONFIG, payload: { config: db.getWheelConfig() } }));
      socket.send(JSON.stringify({ type: EVENT_TYPES.WHEEL_SPEED_CONFIG, payload: { config: db.getWheelSpeedConfig() } }));
      socket.send(JSON.stringify({ type: EVENT_TYPES.OVERLAY_MIC_CONFIG, payload: { config: db.getMicConfig() } }));
    }

    socket.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      handleClientCommand(msg);
    });
  });

  function handleRemoteAction(action, payload) {
    action = String(action || "").toUpperCase();
    switch (action) {
      case "SCENE_SET": {
        const scene = String((payload && payload.scene) || "main").toLowerCase();
        const sceneName = (state.config.obs.sceneMap && state.config.obs.sceneMap[scene]) || "";
        if (obsCtrl && sceneName) obsCtrl.switchScene(sceneName);
        state.setActiveScene(scene);
        broadcast(EVENT_TYPES.REMOTE_ACTION, { action: "SCENE_SET", payload: { scene } });
        serverLog.info("remote scene switch", { scene, sceneName });
        break;
      }
      case "WHEEL_START": {
        clearAutoSpin();
        isSpinning = false;
        const giveaway = state.startGiveaway(payload && payload.command);
        broadcastGiveaway(giveaway);
        bus.emit("alert", { kind: "wheel_start", command: giveaway.command });
        break;
      }
      case "WHEEL_STOP": {
        clearAutoSpin();
        isSpinning = false;
        broadcastGiveaway(state.stopGiveaway());
        break;
      }
      case "WHEEL_SPIN": {
        if (isSpinning) break;
        broadcast(EVENT_TYPES.GIVEAWAY_WHEEL, { sectors: state.giveawaySnapshot().participants });
        const winner = state.pickRandomWinner();
        if (winner) {
          isSpinning = true;
          broadcast(EVENT_TYPES.GIVEAWAY_SPIN, { winner });
        }
        break;
      }
      case "WHEEL_GENERATE": {
        broadcast(EVENT_TYPES.GIVEAWAY_WHEEL, { sectors: state.giveawaySnapshot().participants });
        break;
      }
      case "WHEEL_RESET_PARTICIPANTS": {
        clearAutoSpin();
        isSpinning = false;
        broadcastGiveaway(state.clearGiveawayParticipants());
        broadcast(EVENT_TYPES.GIVEAWAY_WHEEL, { sectors: [] });
        break;
      }
      case "WHEEL_CLEAR_RESULT": {
        broadcastGiveaway(state.clearGiveawayResult());
        broadcast(EVENT_TYPES.GIVEAWAY_WHEEL, { sectors: state.giveawaySnapshot().participants });
        break;
      }
      case "DEATH_INCREMENT": {
        broadcast(EVENT_TYPES.DEATH_COUNT_UPDATE, state.adjustDeathCount(1));
        break;
      }
      case "DEATH_DECREMENT": {
        broadcast(EVENT_TYPES.DEATH_COUNT_UPDATE, state.adjustDeathCount(-1));
        break;
      }
      case "DEATH_RESET": {
        broadcast(EVENT_TYPES.DEATH_COUNT_UPDATE, state.resetDeathCount());
        break;
      }
      case "TEST_ALERT": {
        bus.emit("alert", { ...buildTestAlert(payload && payload.kind), isTest: true });
        break;
      }
      case "THEME_SET": {
        const id = payload && (payload.themeId || payload.id);
        if (id && state.setActiveTheme(id)) broadcastTheme();
        break;
      }
      case "OBS_RAW_COMMAND": {
        runObsCommand(payload && payload.id);
        break;
      }
      case "SOUNDBOARD_TRIGGER": {
        triggerSoundboardSound(payload && payload.soundId, payload && payload.user);
        break;
      }
      case "CAMERA_SET": {
        setCameraAngle(payload && payload.angleId);
        break;
      }
      case "CAMERA_FILTER": {
        setCameraFilter(payload && payload.filterId);
        break;
      }
      default:
        serverLog.warn("unknown remote action", { action });
    }
  }

  function handleClientCommand(msg) {
    switch (msg.type) {
      case EVENT_TYPES.REMOTE_ACTION: {
        handleRemoteAction(msg.action, msg.payload || {});
        break;
      }
      case EVENT_TYPES.CMD_ADD_WIDGET: {
        const instance = state.addWidget(msg.payload && msg.payload.type);
        if (instance) broadcast(EVENT_TYPES.LAYOUT_UPDATE, { layout: state.layout });
        break;
      }
      case EVENT_TYPES.CMD_UPDATE_WIDGET: {
        const { id, patch } = msg.payload || {};
        const updated = state.updateWidget(id, patch || {});
        if (updated) broadcast(EVENT_TYPES.LAYOUT_UPDATE, { layout: state.layout });
        break;
      }
      case EVENT_TYPES.CMD_REMOVE_WIDGET: {
        const { id } = msg.payload || {};
        if (state.removeWidget(id)) broadcast(EVENT_TYPES.LAYOUT_UPDATE, { layout: state.layout });
        break;
      }
      case EVENT_TYPES.CMD_REORDER_WIDGET: {
        const { id, direction } = msg.payload || {};
        if (state.reorderWidget(id, direction)) broadcast(EVENT_TYPES.LAYOUT_UPDATE, { layout: state.layout });
        break;
      }
      case EVENT_TYPES.CMD_SET_GOAL: {
        const goal = state.setGoal(msg.payload || {});
        broadcast(EVENT_TYPES.GOAL_UPDATE, goal);
        break;
      }
      case EVENT_TYPES.CMD_SET_APP_CONFIG: {
        state.setAppConfig(msg.payload || {});
        restartTwitchChat();
        broadcast(EVENT_TYPES.STATE, stateSnapshot());
        break;
      }
      case EVENT_TYPES.CMD_SET_ACTIVE_THEME: {
        const { id } = msg.payload || {};
        if (state.setActiveTheme(id)) broadcastTheme();
        break;
      }
      case EVENT_TYPES.CMD_SAVE_CUSTOM_THEME: {
        state.saveCustomTheme(msg.payload || {});
        broadcastTheme();
        break;
      }
      case EVENT_TYPES.CMD_DELETE_CUSTOM_THEME: {
        const { id } = msg.payload || {};
        if (state.deleteCustomTheme(id)) broadcastTheme();
        break;
      }
      case EVENT_TYPES.CMD_SET_EDITOR_PREFS: {
        const prefs = state.setEditorPrefs(msg.payload || {});
        broadcast(EVENT_TYPES.EDITOR_PREFS_UPDATE, prefs);
        break;
      }
      case EVENT_TYPES.CMD_SET_SCENE_CONFIG: {
        const { sceneId, patch } = msg.payload || {};
        if (state.setSceneConfig(sceneId, patch || {})) broadcast(EVENT_TYPES.SCENES_UPDATE, state.config.scenes);
        break;
      }
      case EVENT_TYPES.CMD_RESET_TOP_DONATION: {
        const top = state.resetTopDonation();
        broadcast(EVENT_TYPES.TOP_DONATION_UPDATE, top);
        break;
      }
      case EVENT_TYPES.CMD_TEST_ALERT: {
        bus.emit("alert", { ...buildTestAlert(msg.payload && msg.payload.kind), isTest: true });
        break;
      }
      case EVENT_TYPES.CMD_TEST_CHAT: {
        const count = Math.max(1, Math.min(20, Number((msg.payload && msg.payload.count)) || 1));
        const users = [
          { name: "test_viewer", color: "#7ee0d6" },
          { name: "chat_fan", color: "#f4b8e4" },
          { name: "pixel_lover", color: "#a6d189" },
          { name: "stream_buddy", color: "#e5c890" },
          { name: "lurker_42", color: "#8caaee" },
        ];
        const messages = [
          "Привет всем! 👋",
          "Классный стрим 🔥",
          "Как дела, чат?",
          "Погнали!",
          "Это тестовое сообщение",
          "Ловлю каждое слово 😄",
        ];
        for (let i = 0; i < count; i++) {
          const u = users[i % users.length];
          bus.emit("chat_message", {
            user: u.name,
            color: u.color,
            badges: i % 3 === 0 ? ["moderator"] : (i % 3 === 1 ? ["subscriber"] : []),
            message: messages[i % messages.length],
            isTest: true,
          });
        }
        break;
      }
      case EVENT_TYPES.CMD_START_GIVEAWAY: {
        clearAutoSpin();
        isSpinning = false;
        const giveaway = state.startGiveaway(msg.payload && msg.payload.command);
        broadcastGiveaway(giveaway);
        bus.emit("alert", {
          kind: "wheel_start",
          command: giveaway.command,
        });
        break;
      }
      case EVENT_TYPES.CMD_STOP_GIVEAWAY: {
        clearAutoSpin();
        isSpinning = false;
        broadcastGiveaway(state.stopGiveaway());
        break;
      }
      case EVENT_TYPES.CMD_SHUFFLE_GIVEAWAY: {
        broadcastGiveaway(state.shuffleGiveaway());
        break;
      }
      case EVENT_TYPES.CMD_SET_GIVEAWAY_ELIMINATION: {
        broadcastGiveaway(state.setGiveawayEliminationMode(msg.payload && msg.payload.enabled));
        break;
      }
      case EVENT_TYPES.CMD_GENERATE_WHEEL: {
        broadcast(EVENT_TYPES.GIVEAWAY_WHEEL, { sectors: state.giveawaySnapshot().participants });
        break;
      }
      case EVENT_TYPES.CMD_SPIN_WHEEL: {
        if (isSpinning) break; // вращение уже запущено
        broadcast(EVENT_TYPES.GIVEAWAY_WHEEL, { sectors: state.giveawaySnapshot().participants });
        const winner = state.pickRandomWinner();
        if (winner) {
          isSpinning = true;
          broadcast(EVENT_TYPES.GIVEAWAY_SPIN, { winner });
        }
        break;
      }
      case EVENT_TYPES.CMD_SET_GIVEAWAY_WINNER: {
        const username = msg.payload && msg.payload.username;
        if (!state.consumePendingWinner(username)) break;
        isSpinning = false; // текущий цикл завершён, pendingWinner очищен
        const giveaway = state.setGiveawayWinner(username);
        const isFinalWinner = !!giveaway.isFinalWinner;
        const isElimination = !!giveaway.eliminationMode && !isFinalWinner;
        broadcastGiveaway(giveaway);
        // The wheel keeps showing the winner under the marker until the next
        // spin re-syncs sectors; resetting here would move the arrow to a
        // different participant while the elimination alert is still visible.
        const alert = {
          kind: "wheel_winner",
          user: giveaway.winner,
          isElimination,
          isFinalWinner,
        };
        if (isElimination) {
          alert.durationMs = 3000;
          scheduleAutoSpin();
        }
        bus.emit("alert", alert);
        break;
      }
      case EVENT_TYPES.CMD_ADD_GIVEAWAY_PARTICIPANT: {
        const giveaway = state.addGiveawayParticipant(msg.payload && msg.payload.username);
        if (giveaway) broadcastGiveaway(giveaway);
        break;
      }
      case EVENT_TYPES.CMD_REMOVE_GIVEAWAY_PARTICIPANT: {
        broadcastGiveaway(state.removeGiveawayParticipant(msg.payload && msg.payload.username));
        break;
      }
      case EVENT_TYPES.CMD_SET_PARTICIPANTS_CONFIG: {
        const patch = (msg.payload && msg.payload.config) || {};
        const config = db ? db.saveParticipantsConfig(patch) : patch;
        broadcast(EVENT_TYPES.OVERLAY_PARTICIPANTS_CONFIG, { config });
        break;
      }
      case EVENT_TYPES.CMD_SET_WHEEL_CONFIG: {
        const patch = (msg.payload && msg.payload.config) || {};
        const config = db ? db.saveWheelConfig(patch) : patch;
        broadcast(EVENT_TYPES.WHEEL_CONFIG, { config });
        break;
      }
      case EVENT_TYPES.CMD_SET_WHEEL_SPEED_CONFIG: {
        const patch = (msg.payload && msg.payload.config) || {};
        const config = db ? db.saveWheelSpeedConfig(patch) : patch;
        broadcast(EVENT_TYPES.WHEEL_SPEED_CONFIG, { config });
        break;
      }
      case EVENT_TYPES.CMD_SET_MIC_CONFIG: {
        const patch = (msg.payload && msg.payload.config) || {};
        const config = db ? db.saveMicConfig(patch) : patch;
        broadcast(EVENT_TYPES.OVERLAY_MIC_CONFIG, { config });
        break;
      }
      case EVENT_TYPES.CMD_SET_LANGUAGE: {
        setLanguage(msg.payload && msg.payload.lang);
        break;
      }
      case EVENT_TYPES.CMD_SET_YOUTUBE_VIDEO_ID: {
        state.setYoutubeVideoId(msg.payload && msg.payload.videoId);
        break;
      }
      case EVENT_TYPES.CMD_SET_INTEGRATION_ENABLED: {
        const { service, enabled } = msg.payload || {};
        state.setIntegrationEnabled(service, enabled);
        if (service === "twitch") {
          restartTwitchChat();
          restartTwitchEvents();
        } else if (service === "donationAlerts") {
          restartDonationAlerts();
        } else if (service === "youtube") {
          restartYoutube();
        } else if (service === "obs") {
          restartObs();
        }
        broadcast(EVENT_TYPES.STATE, stateSnapshot());
        break;
      }
      case EVENT_TYPES.CMD_SET_OBS_CONFIG: {
        state.setObsConfig(msg.payload || {});
        restartObs();
        broadcast(EVENT_TYPES.STATE, stateSnapshot());
        break;
      }
      case EVENT_TYPES.CMD_SET_SOUNDBOARD_CONFIG: {
        state.setSoundboardConfig((msg.payload && msg.payload.config) || {});
        broadcast(EVENT_TYPES.STATE, stateSnapshot());
        break;
      }
      case EVENT_TYPES.CMD_SET_STREAMDECK_CONFIG: {
        state.setStreamDeckConfig((msg.payload && msg.payload.config) || {});
        broadcast(EVENT_TYPES.STATE, stateSnapshot());
        break;
      }
      case EVENT_TYPES.CMD_TEST_SOUNDBOARD: {
        triggerSoundboardSound(msg.payload && msg.payload.soundId, "Тест");
        break;
      }
      case EVENT_TYPES.CMD_RUN_OBS_COMMAND: {
        runObsCommand(msg.payload && msg.payload.id);
        break;
      }
      case EVENT_TYPES.CMD_SET_CAMERA_ANGLE: {
        setCameraAngle(msg.payload && msg.payload.angleId);
        break;
      }
      case EVENT_TYPES.CMD_TRIGGER_CAMERA_FILTER: {
        setCameraFilter(msg.payload && msg.payload.filterId);
        break;
      }
      default:
        break;
    }
  }

  function broadcastTheme() {
    const snap = state.snapshot();
    broadcast(EVENT_TYPES.THEME_UPDATE, snap.appearance);
  }

  bus.on("alert", (alert) => {
    const withDuration = { durationMs: ALERT_DURATIONS_MS[alert.kind] || 5000, ...alert };
    broadcast(EVENT_TYPES.ALERT, withDuration);

    const isWheelAlert = alert.kind === "wheel_start" || alert.kind === "wheel_winner";
    if (!isWheelAlert) {
      state.pushRecentEvent({ kind: alert.kind, user: alert.user, amount: alert.amount ?? alert.count, message: alert.message });
      broadcast(EVENT_TYPES.RECENT_EVENT, state.runtime.recentEvents[0]);

      if (db) {
        db.appendStreamEvent(toStreamEvent(alert, !!alert.isTest));
      }
    }

    if (alert.kind === "donation" && typeof alert.amount === "number") {
      const goal = state.addToGoal(alert.amount);
      broadcast(EVENT_TYPES.GOAL_UPDATE, goal);
      const top = state.maybeUpdateTopDonation({ user: alert.user, amount: alert.amount, currency: alert.currency });
      if (top) broadcast(EVENT_TYPES.TOP_DONATION_UPDATE, top);
    }
  });

  bus.on("chat_message", (chatMessage) => {
    broadcast(EVENT_TYPES.CHAT_MESSAGE, chatMessage);
    if (db && currentSession && !chatMessage.isTest) {
      db.appendChat({ ...chatMessage, sessionId: currentSession.id });
    }

    if (!chatMessage.isTest) {
      const giveaway = state.handleGiveawayChat(chatMessage.user, chatMessage.message);
      if (giveaway) broadcastGiveaway(giveaway);
    }
  });

  bus.on("connection_status", ({ service, status }) => {
    state.setConnectionStatus(service, status);
    broadcast(EVENT_TYPES.CONNECTION_STATUS, { service, status });
  });

  bus.on("goal_external_update", ({ current, target }) => {
    const goal = state.setGoal({ current, target });
    broadcast(EVENT_TYPES.GOAL_UPDATE, goal);
  });

  bus.on("stat_snapshot", (snapshot) => {
    const stats = state.setStats(snapshot);
    broadcast(EVENT_TYPES.STAT_UPDATE, stats);
  });

  bus.on("stat_delta", (delta) => {
    const stats = state.adjustStats(delta);
    broadcast(EVENT_TYPES.STAT_UPDATE, stats);
  });

  bus.on("terminal_log", (entry) => {
    broadcast(EVENT_TYPES.TERMINAL_LOG, entry);
  });

  bus.on("soundboard_play", (payload) => {
    broadcast(EVENT_TYPES.SOUNDBOARD_PLAY, payload);
  });

  bus.on("camera_angle_changed", ({ activeCameraAngle }) => {
    state.setActiveCameraAngle(activeCameraAngle);
    broadcast(EVENT_TYPES.CAMERA_ANGLE_UPDATE, { activeCameraAngle });
  });

  bus.on("camera_angle_request", ({ angleId }) => {
    setCameraAngle(angleId);
  });

  bus.on("camera_filter_changed", ({ filterId, active }) => {
    state.setActiveFilter(filterId, active);
    broadcast(EVENT_TYPES.CAMERA_FILTER_UPDATE, { filterId, active });
  });

  bus.on("camera_filter_request", ({ filterId }) => {
    setCameraFilter(filterId);
  });

  function start() {
    const port = state.config.port || 8710;
    server.listen(port, () => {
      serverLog.success("overlay + control bus listening", { url: `http://localhost:${port}` });
      serverLog.success("web remote ready", { url: remoteUrl });
    });

    restartTwitchChat();
    restartTwitchEvents();
    restartDonationAlerts();
    restartYoutube();
    restartObs();

    if (db) {
      currentSession = db.startSession(state.config.twitch.channel);
    }

    return { port, remoteUrl };
  }

  function importConfig(newConfig) {
    state.replaceConfig(newConfig);
    restartTwitchChat();
    restartTwitchEvents();
    restartDonationAlerts();
    restartYoutube();
    broadcast(EVENT_TYPES.STATE, stateSnapshot());
  }

  function stop() {
    serverLog.info("stopping server");
    clearAutoSpin();
    if (currentSession) {
      if (db) db.endSession(currentSession.id);
      currentSession = null;
    }
    if (twitchChatCtrl) twitchChatCtrl.stop();
    if (twitchEventsCtrl) twitchEventsCtrl.stop();
    if (donationAlertsCtrl) donationAlertsCtrl.stop();
    if (youtubeCtrl) youtubeCtrl.stop();
    wss.close();
    server.close();
  }

  function getStreamEvents(opts = {}) {
    if (!db) return [];
    return db.getStreamEvents(opts);
  }

  function replayEvent(id) {
    if (!db) return null;
    const record = db.getStreamEventById(id);
    if (!record) return null;
    const alert = {
      kind: record.kind || record.type,
      user: record.username,
      amount: record.amount,
      currency: record.currency,
      message: record.message,
      count: record.count,
      tier: record.tier,
    };
    const withDuration = { durationMs: ALERT_DURATIONS_MS[alert.kind] || 5000, ...alert };
    broadcast(EVENT_TYPES.ALERT, withDuration);
    return record;
  }

  return {
    app,
    server,
    wss,
    state,
    bus,
    start,
    stop,
    broadcast,
    restartTwitchChat,
    restartTwitchEvents,
    restartDonationAlerts,
    importConfig,
    getStreamEvents,
    replayEvent,
    setLanguage,
  };
}

function buildTestAlert(kind = "follow") {
  const names = ["nova_viewer", "star_gazer", "orbit_fan", "comet_watcher"];
  const user = names[Math.floor(Math.random() * names.length)];
  switch (kind) {
    case "sub":
      return { kind: "sub", user, tier: "1000" };
    case "gift_sub":
      return { kind: "gift_sub", user, count: 3 };
    case "cheer":
      return { kind: "cheer", user, amount: 250 };
    case "donation":
      return { kind: "donation", user, amount: 300, currency: "RUB", message: "Удачного стрима!" };
    case "follow":
    default:
      return { kind: "follow", user };
  }
}

function eventTypeForKind(kind) {
  if (kind === "follow") return "follow";
  if (kind === "sub" || kind === "gift_sub") return "subscription";
  if (kind === "donation") return "donation";
  return kind || "unknown";
}

function toStreamEvent(alert, isTest) {
  return {
    timestamp: Date.now(),
    type: eventTypeForKind(alert.kind),
    kind: alert.kind,
    username: alert.user || "Аноним",
    amount: typeof alert.amount === "number" ? alert.amount : null,
    currency: alert.currency || null,
    message: alert.message || "",
    is_test: !!isTest,
    count: typeof alert.count === "number" ? alert.count : null,
    tier: alert.tier || null,
  };
}

module.exports = { createServer, buildTestAlert, eventTypeForKind, toStreamEvent };

// `npm run server:only` runs the bus without Electron — handy for iterating
// on overlay/editor visuals in a normal browser tab.
if (require.main === module) {
  createServer().start();
}
