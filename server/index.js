const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { EventEmitter } = require("events");

const { AppState } = require("./state");
const { EVENT_TYPES, ALERT_DURATIONS_MS } = require("../shared/events");
const { mountOAuthRoutes, buildTwitchAuthorizeUrl, buildDonationAlertsAuthorizeUrl } = require("./oauth");
const { startTwitchChat } = require("./integrations/twitch-chat");
const { startTwitchEvents } = require("./integrations/twitch-eventsub");
const { startDonationAlerts } = require("./integrations/donationalerts");

const bus = new EventEmitter();

function createServer() {
  const state = new AppState();
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  app.use(express.static(path.join(__dirname, "..", "overlay"), { redirect: false }));
  app.use("/overlay", express.static(path.join(__dirname, "..", "overlay")));
  app.use("/shared", express.static(path.join(__dirname, "..", "shared")));
  app.use("/assets", express.static(path.join(__dirname, "..", "assets")));

  let twitchChatCtrl = null;
  let twitchEventsCtrl = null;
  let donationAlertsCtrl = null;

  function broadcast(type, payload) {
    const message = JSON.stringify({ type, payload });
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(message);
    });
  }

  function restartTwitchChat() {
    if (twitchChatCtrl) twitchChatCtrl.stop();
    twitchChatCtrl = startTwitchChat({ bus, channel: state.config.twitch.channel });
  }

  function restartTwitchEvents() {
    if (twitchEventsCtrl) twitchEventsCtrl.stop();
    if (state.config.twitch.userAccessToken && state.config.twitch.broadcasterId) {
      twitchEventsCtrl = startTwitchEvents({ bus, state });
    } else {
      bus.emit("connection_status", { service: "twitchEvents", status: "not_configured" });
    }
  }

  function restartDonationAlerts() {
    if (donationAlertsCtrl) donationAlertsCtrl.stop();
    if (state.config.donationAlerts.accessToken) {
      donationAlertsCtrl = startDonationAlerts({ bus, config: state.config });
    } else {
      bus.emit("connection_status", { service: "donationAlerts", status: "not_configured" });
    }
  }

  mountOAuthRoutes(app, {
    state,
    hooks: {
      onTwitchConnected: restartTwitchEvents,
      onDonationAlertsConnected: restartDonationAlerts,
    },
  });

  // ---- IPC-style commands over the same WS the overlay listens on ----
  app.get("/api/oauth-urls", (req, res) => {
    res.json({
      twitch: buildTwitchAuthorizeUrl(state.config, state.config.port),
      donationAlerts: buildDonationAlertsAuthorizeUrl(state.config, state.config.port),
    });
  });

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: EVENT_TYPES.STATE, payload: state.snapshot() }));

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

  function handleClientCommand(msg) {
    switch (msg.type) {
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
        bus.emit("alert", buildTestAlert(msg.payload && msg.payload.kind));
        break;
      }
      case EVENT_TYPES.CMD_TEST_CHAT: {
        bus.emit("chat_message", {
          user: "test_viewer",
          color: "#7ee0d6",
          badges: ["moderator"],
          message: (msg.payload && msg.payload.message) || "Привет из тестового сообщения!",
        });
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
    state.pushRecentEvent({ kind: alert.kind, user: alert.user, amount: alert.amount ?? alert.count, message: alert.message });
    broadcast(EVENT_TYPES.RECENT_EVENT, state.runtime.recentEvents[0]);

    if (alert.kind === "donation" && typeof alert.amount === "number") {
      const goal = state.addToGoal(alert.amount);
      broadcast(EVENT_TYPES.GOAL_UPDATE, goal);
      const top = state.maybeUpdateTopDonation({ user: alert.user, amount: alert.amount, currency: alert.currency });
      if (top) broadcast(EVENT_TYPES.TOP_DONATION_UPDATE, top);
    }
  });

  bus.on("chat_message", (chatMessage) => {
    broadcast(EVENT_TYPES.CHAT_MESSAGE, chatMessage);
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

  function start() {
    const port = state.config.port || 8710;
    server.listen(port, () => {
      console.log(`[server] overlay + control bus listening on http://localhost:${port}`);
    });

    restartTwitchChat();
    restartTwitchEvents();
    restartDonationAlerts();

    return { port };
  }

  function importConfig(newConfig) {
    state.replaceConfig(newConfig);
    restartTwitchChat();
    restartTwitchEvents();
    restartDonationAlerts();
    broadcast(EVENT_TYPES.STATE, state.snapshot());
  }

  return {
    app,
    server,
    wss,
    state,
    bus,
    start,
    broadcast,
    restartTwitchChat,
    restartTwitchEvents,
    restartDonationAlerts,
    importConfig,
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

module.exports = { createServer };

// `npm run server:only` runs the bus without Electron — handy for iterating
// on overlay/editor visuals in a normal browser tab.
if (require.main === module) {
  createServer().start();
}
