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
  Interactive CLI console for the OSE control panel.

  Receives a single command string over the WebSocket bus (`exec_cli_command`)
  and drives the existing subsystems (OBS scenes / camera angles / filters,
  soundboard, death counter, wheel/giveaway, themes, goal and simulated
  events) through the shared `bus` and `AppState`. Every result is emitted as
  a `terminal_log` entry with the `CLI` service so the control-panel log panel
  can render it inline.
*/

const { createLogger } = require("./logger");
const { EVENT_TYPES } = require("../shared/events");
const { matchCameraAngle, matchCameraFilter } = require("./integrations/twitch-eventsub");
const { cleanupOrphanedMedia, listMediaFiles } = require("./media");

const LOCALES = {
  ru: require("../shared/locales/ru.json"),
  en: require("../shared/locales/en.json"),
};

function resolveDict(pathStr, dict) {
  return String(pathStr).split(".").reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), dict);
}

function interpolate(str, params) {
  if (params) {
    Object.keys(params).forEach((k) => {
      str = str.split("{{" + k + "}}").join(String(params[k]));
    });
  }
  return str;
}

function makeT(lang) {
  return (key, params) => {
    let str = resolveDict(key, LOCALES[lang]);
    if (typeof str !== "string") str = resolveDict(key, LOCALES.en);
    if (typeof str !== "string") str = String(key);
    return interpolate(str, params);
  };
}

const HELP_KEYS = [
  "scene", "cam", "filter", "sound", "death", "wheel", "giveaway",
  "simSub", "simPoints", "simRaid", "alert", "chat", "theme", "goal",
  "obs", "lists", "logs", "media", "lang", "status", "clear", "help",
];

function formatUptime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}ч ${m}м ${sec}с`;
  if (m > 0) return `${m}м ${sec}с`;
  return `${sec}с`;
}

const HELP_LINES = HELP_KEYS.map((k) => resolveDict(`cli.help.${k}`, LOCALES.ru));

const COMMANDS = [
  "scene", "cam", "filter", "sound", "death", "wheel", "giveaway",
  "sim", "alert", "chat", "theme", "themes", "goal", "obs",
  "sounds", "cameras", "filters", "logs", "media", "lang", "status", "clear", "help",
];

const SUBCOMMANDS = {
  sim: ["sub", "points", "raid"],
  wheel: ["spin", "generate", "reset", "clear"],
  giveaway: ["start", "stop", "add", "remove", "shuffle", "elimination", "list"],
  death: ["+1", "-1", "set", "reset"],
  goal: ["add"],
  lang: ["ru", "en"],
  alert: ["follow", "sub", "gift_sub", "cheer", "donation"],
  logs: ["info", "success", "warn", "error", "hint", "all"],
  media: ["list", "cleanup"],
};

function createCliHandler({ state, bus, obsCtrl, broadcast, startedAt, logger, handleRemoteAction, setLanguage, t }) {
  const logImpl = logger || createLogger(bus, "CLI");
  const translate = typeof t === "function" ? t : makeT("ru");

  // `createLogger` exposes info/success/warn/error methods (not a callable
  // `log`). Route a level string to the matching method and guard against a
  // missing/broken logger so a bad logger object can never crash a command.
  function log(level, message, data) {
    const method = logImpl && logImpl[level];
    if (typeof method === "function") {
      method(message, data);
    }
  }

  function broadcastGiveaway(giveaway) {
    if (!giveaway) return;
    broadcast(EVENT_TYPES.GIVEAWAY_UPDATE, { giveaway });
    broadcast(EVENT_TYPES.GIVEAWAY_PARTICIPANTS, { count: giveaway.count, participants: giveaway.participants });
  }

  // ---- scenes / camera / filters / soundboard / death ----

  function sceneCommand(name) {
    const scene = String(name || "").trim().toLowerCase();
    if (!scene) {
      log("error", translate("cli.scene.usage"));
      return;
    }
    const sceneMap = (state.config.obs && state.config.obs.sceneMap) || {};
    const sceneName = sceneMap[scene] || scene;
    const obsConnected = obsCtrl && obsCtrl.isConnected();

    if (obsConnected && obsCtrl) obsCtrl.switchScene(sceneName);
    state.setActiveScene(scene);
    broadcast(EVENT_TYPES.REMOTE_ACTION, { action: "SCENE_SET", payload: { scene } });
    log("success", translate("cli.scene.switched", { scene, name: sceneName }) + (obsConnected ? "" : translate("cli.obsOffline")));
  }

  function camCommand(angleId) {
    if (!angleId) {
      log("error", translate("cli.cam.usage"));
      return;
    }
    if (!obsCtrl || !obsCtrl.isConnected()) {
      log("error", translate("cli.cam.obsOffline"));
      return;
    }
    obsCtrl
      .setCameraAngle(angleId)
      .then(() => log("success", translate("cli.cam.switched", { id: angleId })))
      .catch((err) => log("error", translate("cli.cam.failed", { error: err.message })));
  }

  function filterCommand(filterId, durationArg) {
    if (!filterId) {
      log("error", translate("cli.filter.usage"));
      return;
    }
    if (!obsCtrl || !obsCtrl.isConnected()) {
      log("error", translate("cli.filter.obsOffline"));
      return;
    }
    const durationSec = durationArg !== undefined && durationArg !== "" ? Number(durationArg) : undefined;
    obsCtrl
      .triggerCameraFilter(filterId, durationSec)
      .then((res) => {
        const stateText = res && res.active === false ? translate("cli.filter.off") : "";
        log("success", translate("cli.filter.activated", { id: filterId, state: stateText }));
      })
      .catch((err) => log("error", translate("cli.filter.failed", { error: err.message })));
  }

  function soundCommand(soundId) {
    if (!soundId) {
      log("error", translate("cli.sound.usage"));
      return;
    }
    const sounds = (state.config.soundboard && state.config.soundboard.sounds) || [];
    const sound = sounds.find((s) => s.id === soundId);
    if (!sound) {
      log("error", translate("cli.sound.notFound", { id: soundId }));
      return;
    }
    bus.emit("soundboard_play", {
      soundId: sound.id,
      title: sound.title || sound.rewardTitle || sound.id,
      user: "CLI",
      audioFile: sound.audioFile,
      imageFile: sound.imageFile,
    });
    log("success", translate("cli.sound.played", { name: sound.title || sound.rewardTitle || sound.id }));
  }

  function deathCommand(arg, value) {
    let result;
    if (arg === "+1" || arg === "inc" || arg === "increase") {
      result = state.adjustDeathCount(1);
    } else if (arg === "-1" || arg === "dec" || arg === "decrease") {
      result = state.adjustDeathCount(-1);
    } else if (arg === "reset" || arg === "0") {
      result = state.resetDeathCount();
    } else if (arg === "set") {
      const target = Math.max(0, Math.round(Number(value) || 0));
      const delta = target - (state.runtime.deathCount || 0);
      result = state.adjustDeathCount(delta);
    } else {
      log("error", translate("cli.death.usage"));
      return;
    }
    broadcast(EVENT_TYPES.DEATH_COUNT_UPDATE, result);
    log("success", translate("cli.death.result", { count: result.count }));
  }

  // ---- wheel / giveaway ----

  function wheelCommand(sub) {
    if (typeof handleRemoteAction !== "function") {
      log("error", translate("cli.wheel.unavailable"));
      return;
    }
    const actions = { spin: "WHEEL_SPIN", generate: "WHEEL_GENERATE", reset: "WHEEL_RESET_PARTICIPANTS", clear: "WHEEL_CLEAR_RESULT" };
    const action = actions[sub];
    if (!action) {
      log("error", translate("cli.wheel.usage"));
      return;
    }
    handleRemoteAction(action, {});
    log("success", translate("cli.wheel.done", { sub }));
  }

  function giveawayCommand(args) {
    const sub = String((args[0] || "").toLowerCase());
    if (sub === "start" || sub === "stop") {
      if (typeof handleRemoteAction !== "function") {
        log("error", translate("cli.giveaway.unavailable"));
        return;
      }
      handleRemoteAction(sub === "start" ? "WHEEL_START" : "WHEEL_STOP", sub === "start" ? { command: args[1] } : {});
      log("success", sub === "start" ? translate("cli.giveaway.started") : translate("cli.giveaway.stopped"));
      return;
    }
    if (sub === "add") {
      const name = args[1];
      if (!name) {
        log("error", translate("cli.giveaway.addUsage"));
        return;
      }
      const g = state.addGiveawayParticipant(name);
      if (g) {
        broadcastGiveaway(g);
        log("success", translate("cli.giveaway.added", { name }));
      } else {
        log("warn", translate("cli.giveaway.duplicate", { name }));
      }
      return;
    }
    if (sub === "remove") {
      const name = args[1];
      if (!name) {
        log("error", translate("cli.giveaway.removeUsage"));
        return;
      }
      broadcastGiveaway(state.removeGiveawayParticipant(name));
      log("success", translate("cli.giveaway.removed", { name }));
      return;
    }
    if (sub === "shuffle") {
      broadcastGiveaway(state.shuffleGiveaway());
      log("success", translate("cli.giveaway.shuffled"));
      return;
    }
    if (sub === "elimination") {
      const on = args[1] === "on" || args[1] === "1" || args[1] === "true";
      broadcastGiveaway(state.setGiveawayEliminationMode(on));
      log("success", translate("cli.giveaway.elimination", { state: on ? translate("cli.on") : translate("cli.off") }));
      return;
    }
    if (sub === "list") {
      const g = state.giveawaySnapshot();
      log("info", translate("cli.giveaway.list", { count: g.count, names: g.participants.length ? g.participants.join(", ") : translate("cli.none") }));
      return;
    }
    log("error", translate("cli.giveaway.usage"));
  }

  // ---- simulation / test events ----

  function simSub(username, tier) {
    if (!username) {
      log("error", translate("cli.sim.subUsage"));
      return;
    }
    const t = tier || "1000";
    bus.emit("alert", { kind: "sub", user: username, tier: t, isTest: true });
    log("success", translate("cli.sim.subDone", { user: username, tier: t }));
  }

  function simPoints(rewardTitle) {
    const title = String(rewardTitle || "").trim();
    if (!title) {
      log("error", translate("cli.sim.pointsUsage"));
      return;
    }
    let matched = false;

    const sounds = (state.config.soundboard && state.config.soundboard.sounds) || [];
    const sound = sounds.find(
      (s) => (s.rewardTitle && s.rewardTitle.toLowerCase() === title.toLowerCase()) || (s.rewardId && s.rewardId === title)
    );
    if (sound) {
      bus.emit("soundboard_play", {
        soundId: sound.id,
        title: sound.title || sound.rewardTitle || sound.id,
        user: "CLI",
        audioFile: sound.audioFile,
        imageFile: sound.imageFile,
      });
      log("success", translate("cli.sim.pointsSound", { title, name: sound.title || sound.rewardTitle || sound.id }));
      matched = true;
    }

    const angle = matchCameraAngle((state.config.obs && state.config.obs.cameraAngles) || [], title);
    if (angle) {
      bus.emit("camera_angle_request", { angleId: angle.id, user: "CLI" });
      log("success", translate("cli.sim.pointsCam", { title, id: angle.id }));
      matched = true;
    }

    const filter = matchCameraFilter((state.config.obs && state.config.obs.cameraFilters) || [], title);
    if (filter) {
      bus.emit("camera_filter_request", { filterId: filter.id, user: "CLI" });
      log("success", translate("cli.sim.pointsFilter", { title, id: filter.id }));
      matched = true;
    }

    if (!matched) {
      log("warn", translate("cli.sim.pointsNone", { title }));
    }
  }

  function simRaid(username, viewers) {
    if (!username) {
      log("error", translate("cli.sim.raidUsage"));
      return;
    }
    const count = Math.max(0, Math.round(Number(viewers) || 0));
    bus.emit("chat_message", {
      user: username,
      color: "#e6e1e5",
      badges: [],
      message: translate("cli.sim.raidMessage", { user: username, count }),
      isTest: true,
    });
    log("success", translate("cli.sim.raidDone", { user: username, count }));
  }

  function simCommand(args) {
    const sub = String((args[0] || "").toLowerCase());
    if (sub === "sub") {
      simSub(args[1], args[2]);
    } else if (sub === "points") {
      simPoints(args.slice(1).join(" "));
    } else if (sub === "raid") {
      simRaid(args[1], args[2]);
    } else {
      log("error", translate("cli.sim.unknown"));
    }
  }

  function alertCommand(kind) {
    const valid = { follow: "follow", sub: "sub", gift_sub: "gift_sub", cheer: "cheer", donation: "donation" };
    const k = valid[kind];
    if (!k) {
      log("error", translate("cli.alert.unknown", { types: Object.keys(valid).join(", ") }));
      return;
    }
    const names = ["nova_viewer", "star_gazer", "orbit_fan", "comet_watcher"];
    const user = names[Math.floor(Math.random() * names.length)];
    const alert = { kind: k, user, isTest: true };
    if (k === "sub") alert.tier = "1000";
    if (k === "gift_sub") alert.count = 3;
    if (k === "cheer") alert.amount = 250;
    if (k === "donation") {
      alert.amount = 300;
      alert.currency = "RUB";
      alert.message = "Удачного стрима!";
    }
    bus.emit("alert", alert);
    log("success", translate("cli.alert.done", { kind: k }));
  }

  function chatCommand(message) {
    if (!message) {
      log("error", translate("cli.chat.usage"));
      return;
    }
    bus.emit("chat_message", { user: "CLI", color: "#e6e1e5", badges: [], message, isTest: true });
    log("success", translate("cli.chat.done", { message }));
  }

  // ---- theme / goal / obs / lists / lang ----

  function themeCommand(id) {
    if (!id) {
      log("error", translate("cli.theme.usage"));
      return;
    }
    if (state.setActiveTheme(id)) {
      broadcast(EVENT_TYPES.THEME_UPDATE, state.snapshot().appearance);
      log("success", translate("cli.theme.switched", { id }));
    } else {
      log("error", translate("cli.theme.notFound", { id }));
    }
  }

  function themesCommand() {
    const themes = (typeof state.listThemes === "function" && state.listThemes()) || [];
    if (!themes.length) {
      log("info", translate("cli.themes.none"));
      return;
    }
    log("info", translate("cli.themes.title"));
    themes.forEach((t) => log("info", `  ${t.id} — ${t.name}${t.builtin ? "" : translate("cli.themes.custom")}${t.category ? ` [${t.category}]` : ""}`));
  }

  function goalCommand(args) {
    if (args[0] === "add") {
      const amount = Number(args[1]) || 0;
      const goal = state.addToGoal(amount);
      broadcast(EVENT_TYPES.GOAL_UPDATE, goal);
      log("success", translate("cli.goal.added", { current: goal.current, target: goal.target, amount }));
      return;
    }
    const current = Number(args[0]);
    const target = Number(args[1]);
    if (!args.length || !isFinite(current) || !isFinite(target)) {
      log("error", translate("cli.goal.usage"));
      return;
    }
    const goal = state.setGoal({ current, target });
    broadcast(EVENT_TYPES.GOAL_UPDATE, goal);
    log("success", translate("cli.goal.updated", { current: goal.current, target: goal.target }));
  }

  function obsCommand(arg) {
    const commands = (state.config.obs && state.config.obs.customCommands) || [];
    if (!arg || arg === "list") {
      if (!commands.length) {
        log("info", translate("cli.obs.none"));
        return;
      }
      log("info", translate("cli.obs.title"));
      commands.forEach((c) => log("info", `  ${c.id} — ${c.label || c.requestType || "?"}`));
      return;
    }
    const cmd = commands.find((c) => c.id === arg);
    if (!cmd) {
      log("error", translate("cli.obs.notFound", { id: arg }));
      return;
    }
    if (!cmd.requestType) {
      log("error", translate("cli.obs.emptyRequestType", { id: arg }));
      return;
    }
    if (!obsCtrl || !obsCtrl.isConnected()) {
      log("error", translate("cli.obs.offline"));
      return;
    }
    obsCtrl
      .sendRawRequest(cmd.requestType, cmd.requestData || {})
      .then(() => log("success", translate("cli.obs.done", { id: arg })))
      .catch((err) => log("error", translate("cli.obs.failed", { error: err.message })));
  }

  function listSounds() {
    const sounds = (state.config.soundboard && state.config.soundboard.sounds) || [];
    if (!sounds.length) {
      log("info", translate("cli.sounds.none"));
      return;
    }
    log("info", translate("cli.sounds.title"));
    sounds.forEach((s) => log("info", `  ${s.id} — ${s.title || s.rewardTitle || "?"}`));
  }

  function listCameras() {
    const angles = (state.config.obs && state.config.obs.cameraAngles) || [];
    if (!angles.length) {
      log("info", translate("cli.cameras.none"));
      return;
    }
    log("info", translate("cli.cameras.title"));
    angles.forEach((a) => log("info", `  ${a.id} — ${a.label || "?"} (${a.sceneName || "?"}/${a.cameraSource || "?"})`));
  }

  function listFilters() {
    const filters = (state.config.obs && state.config.obs.cameraFilters) || [];
    if (!filters.length) {
      log("info", translate("cli.filters.none"));
      return;
    }
    log("info", translate("cli.filters.title"));
    filters.forEach((f) => log("info", `  ${f.id} — ${f.label || "?"} (${f.sourceName || "?"}/${f.filterName || "?"}, ${f.durationSec || 0}с)`));
  }

  function langCommand(code) {
    const lang = code === "ru" ? "ru" : "en";
    const result = typeof setLanguage === "function" ? setLanguage(lang) : lang;
    log("success", translate("cli.lang.done", { lang: result || lang }));
  }

  function logsCommand(arg) {
    const levels = ["info", "success", "warn", "error", "hint"];
    if (!arg) {
      log("info", translate("cli.logs.usage"));
      return;
    }
    const level = String(arg).toLowerCase();
    if (level === "all") {
      broadcast(EVENT_TYPES.TERMINAL_FILTER, { level: "all" });
      log("success", translate("cli.logs.all"));
    } else if (levels.includes(level)) {
      broadcast(EVENT_TYPES.TERMINAL_FILTER, { level });
      log("success", translate("cli.logs.set", { level }));
    } else {
      log("error", translate("cli.logs.unknown", { levels: levels.join(", ") }));
    }
  }

  function statusCommand() {
    const conn = (state.runtime.connectionStatus && state.runtime.connectionStatus.obs) || "not_configured";
    const scene = state.runtime.activeScene || "main";
    const cam = state.runtime.activeCameraAngle || "—";
    const snap = state.snapshot();
    const theme = (snap.appearance && snap.appearance.activeThemeId) || "—";
    const death = snap.deathCount ?? 0;
    const goal = snap.goal ? `${snap.goal.current} / ${snap.goal.target}` : "—";
    const channel = (state.config.twitch && state.config.twitch.channel) || "—";

    log("info", translate("cli.status.obs", { status: conn }));
    log("info", translate("cli.status.scene", { scene }));
    log("info", translate("cli.status.camera", { cam }));
    log("info", translate("cli.status.theme", { theme }));
    log("info", translate("cli.status.channel", { channel }));
    log("info", translate("cli.status.death", { death }));
    log("info", translate("cli.status.goal", { goal }));
    log("info", translate("cli.status.uptime", { uptime: formatUptime(Date.now() - (startedAt || Date.now())) }));
  }

  function mediaCommand(sub) {
    if (sub === "cleanup") {
      const result = cleanupOrphanedMedia(state.config, state.layout);
      if (result.removed) {
        log("success", translate("cli.media.cleaned", { count: result.removed }));
        result.removedNames.forEach((n) => log("info", "  - " + n));
      } else {
        log("info", translate("cli.media.none"));
      }
      return;
    }

    const files = listMediaFiles();
    if (!files.length) {
      log("info", translate("cli.media.empty"));
      return;
    }
    log("info", translate("cli.media.title"));
    files.forEach((f) => log("info", "  " + f.name));
  }

  // ---- Tab autocompletion -------

  function argListFor(cmd) {
    switch (cmd) {
      case "scene":
        return Object.keys((state.config.obs && state.config.obs.sceneMap) || {});
      case "sound":
        return ((state.config.soundboard && state.config.soundboard.sounds) || []).map((s) => s.id);
      case "cam":
        return ((state.config.obs && state.config.obs.cameraAngles) || []).map((a) => a.id);
      case "filter":
        return ((state.config.obs && state.config.obs.cameraFilters) || []).map((f) => f.id);
      case "theme":
        return (typeof state.listThemes === "function" ? state.listThemes() : []).map((t) => t.id);
      case "obs":
        return ["list", ...((state.config.obs && state.config.obs.customCommands) || []).map((c) => c.id)];
      default:
        return null;
    }
  }

  // Returns an array of full completed input strings (with a trailing space).
  function getCompletions(currentInput) {
    const input = String(currentInput || "");
    const trimmed = input.replace(/^\s+/, "");
    const endsWithSpace = /\s$/.test(trimmed);
    const parts = trimmed.split(/\s+/).filter(Boolean);

    // Empty input or completing the command name.
    if (!parts.length || (parts.length === 1 && !endsWithSpace)) {
      const prefix = (parts[0] || "").toLowerCase();
      return COMMANDS.filter((c) => c.startsWith(prefix)).map((c) => `${c} `);
    }

    const cmd = parts[0].toLowerCase();

    // Subcommand-style commands (sim, wheel, giveaway, death, goal, lang, alert).
    if (SUBCOMMANDS[cmd]) {
      if (parts.length === 1 && endsWithSpace) {
        return SUBCOMMANDS[cmd].map((s) => `${cmd} ${s} `);
      }
      if (parts.length === 2 && !endsWithSpace) {
        const prefix = parts[1].toLowerCase();
        return SUBCOMMANDS[cmd].filter((s) => s.toLowerCase().startsWith(prefix)).map((s) => `${cmd} ${s} `);
      }
      return [];
    }

    // Dynamic arguments (scene/sound/cam/filter/theme/obs).
    const list = argListFor(cmd);
    if (list) {
      if (parts.length === 1 && endsWithSpace) {
        return list.map((x) => `${cmd} ${x} `);
      }
      if (parts.length === 2 && !endsWithSpace) {
        const prefix = parts[1].toLowerCase();
        return list
          .filter((x) => String(x).toLowerCase().startsWith(prefix))
          .map((x) => `${cmd} ${x} `);
      }
    }

    return [];
  }

  function execute(rawLine) {
    const line = String(rawLine || "").trim();
    if (!line) return;

    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "help":
        log("info", translate("cli.availableCommands"));
        HELP_KEYS.forEach((k) => log("info", "  " + translate(`cli.help.${k}`)));
        break;
      case "status":
        statusCommand();
        break;
      case "scene":
        sceneCommand(args[0]);
        break;
      case "cam":
        camCommand(args[0]);
        break;
      case "filter":
        filterCommand(args[0], args[1]);
        break;
      case "sound":
        soundCommand(args[0]);
        break;
      case "death":
        deathCommand(args[0], args[1]);
        break;
      case "wheel":
        wheelCommand(String((args[0] || "").toLowerCase()));
        break;
      case "giveaway":
        giveawayCommand(args);
        break;
      case "sim":
        simCommand(args);
        break;
      case "alert":
        alertCommand(args[0]);
        break;
      case "chat":
        chatCommand(args.join(" "));
        break;
      case "theme":
        themeCommand(args[0]);
        break;
      case "themes":
        themesCommand();
        break;
      case "goal":
        goalCommand(args);
        break;
      case "obs":
        obsCommand(args[0]);
        break;
      case "sounds":
        listSounds();
        break;
      case "cameras":
        listCameras();
        break;
      case "filters":
        listFilters();
        break;
      case "lang":
        langCommand(args[0]);
        break;
      case "logs":
        logsCommand(args[0]);
        break;
      case "media":
        mediaCommand(args[0]);
        break;
      case "clear":
        broadcast(EVENT_TYPES.CLEAR_TERMINAL, {});
        log("success", translate("cli.clear.done"));
        break;
      default:
        log("error", translate("cli.unknownCommand"));
    }
  }

  return { execute, getCompletions, helpLines: () => HELP_LINES.slice() };
}

module.exports = { createCliHandler, HELP_LINES };
