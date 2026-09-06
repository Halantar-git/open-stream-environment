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
  Nightbot-style chat bot.

  Reads every `chat_message` from the shared bus, matches a configured command
  by prefix, checks the caller's permission level and cooldowns, renders a
  response template and sends it back through the existing Helix chat sender
  (`sendTwitchChatMessage`). Timers send periodic messages and can be gated on
  a minimum amount of chat activity between posts.

  The parsing/matching/templating logic is kept in `createBotEngine` so it can
  be unit-tested without a live Twitch connection.
*/

const { createLogger } = require("../logger");
const { sendTwitchChatMessage, moderateUser } = require("./twitch-chat");
const { createModerationEngine } = require("./chat-moderation");

const LEVELS = ["everyone", "subscriber", "moderator", "broadcaster"];
const LEVEL_RANK = { everyone: 0, subscriber: 1, moderator: 2, broadcaster: 3 };

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/^[!./]/, "");
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function formatUptime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}ч ${m}м ${s}с`;
  if (m > 0) return `${m}м ${s}с`;
  return `${s}с`;
}

const EIGHT_BALL = [
  "Да",
  "Нет",
  "Определённо да",
  "Скорее всего",
  "Не сейчас",
  "Сомнительно",
  "Однозначно нет",
  "Знаки говорят — да",
];

function userLevel({ user, badges, channel }) {
  const set = new Set((badges || []).map((b) => String(b).toLowerCase()));
  if (set.has("broadcaster") || (channel && String(user || "").toLowerCase() === String(channel).toLowerCase())) {
    return "broadcaster";
  }
  if (set.has("moderator")) return "moderator";
  if (set.has("subscriber") || set.has("founder") || set.has("vip")) return "subscriber";
  return "everyone";
}

function renderTemplate(template, ctx) {
  let out = String(template || "");
  out = out.replace(/\$\(user\)/gi, ctx.user || "");
  out = out.replace(/\$\(channel\)/gi, ctx.channel || "");
  out = out.replace(/\$\(args\)/gi, ctx.args || "");
  out = out.replace(/\$\(count\)/gi, String(ctx.count == null ? 0 : ctx.count));
  out = out.replace(/\$\(random\s+([^)]+)\)/gi, (_match, list) => {
    const items = String(list)
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    return items.length ? pickRandom(items) : "";
  });
  return out.trim();
}

/**
 * Pure command/timer engine. `commands` and `timers` are the normalized config
 * arrays from state.config.chatBot. `now` is an injectable clock for tests.
 */
function createBotEngine({ prefix, channel, commands, timers, now, startedAt }) {
  const nowFn = now || (() => Date.now());
  const startedAtMs = typeof startedAt === "number" ? startedAt : null;
  const cmds = new Map((commands || []).map((c) => [normalizeName(c.name), c]));
  const timerList = (timers || []).map((t) => ({ ...t }));
  const counters = new Map(); // command name -> usage count
  const timerCounters = new Map(); // timer id -> fire count
  const globalLast = new Map(); // command name -> last used timestamp
  const userLast = new Map(); // "user:name" -> last used timestamp
  const timerLast = new Map(); // timer id -> last fired timestamp
  let chatLinesSinceTimer = 0;

  function matchCommand(message) {
    const text = String(message || "").trim();
    const p = prefix || "!";
    if (!text.startsWith(p)) return null;
    const body = text.slice(p.length).trim();
    if (!body) return null;
    const parts = body.split(/\s+/);
    return {
      name: normalizeName(parts[0]),
      args: parts.slice(1).join(" ").trim(),
    };
  }

  function levelOk(required, actual) {
    return LEVEL_RANK[actual] >= LEVEL_RANK[required || "everyone"];
  }

  function builtinReply(matched, user) {
    switch (matched.name) {
      case "uptime": {
        if (startedAtMs == null) return null;
        return `Стрим идёт: ${formatUptime(nowFn() - startedAtMs)}`;
      }
      case "so": {
        const target = String(matched.args || "").replace(/^@/, "").trim();
        if (!target) return "Использование: !so <ник>";
        return `Шаут-аут ${target}! Загляните: https://twitch.tv/${target}`;
      }
      case "8ball":
        return pickRandom(EIGHT_BALL);
      case "roll": {
        const max = Math.max(1, Math.min(100000, Math.round(Number(matched.args) || 100)));
        const n = 1 + Math.floor(Math.random() * max);
        return `@${user || "viewer"} выбросил ${n} (1–${max})`;
      }
      default:
        return null;
    }
  }

  function handleChat({ user, badges, message }) {
    chatLinesSinceTimer += 1;

    const matched = matchCommand(message);
    if (!matched) return null;

    const level = userLevel({ user, badges, channel });

    // Built-in command listing: shows the built-ins plus the custom commands
    // the caller is allowed to use.
    if (matched.name === "commands" || matched.name === "help") {
      const isMod = level === "moderator" || level === "broadcaster";
      const builtins = ["uptime", "so", "8ball", "roll", ...(isMod ? ["timeout", "ban"] : [])];
      const custom = (commands || [])
        .filter((c) => normalizeName(c.name) && levelOk(c.level, level))
        .map((c) => (prefix || "!") + normalizeName(c.name));
      const names = [...builtins.map((n) => (prefix || "!") + n), ...custom];
      return { reply: `Команды: ${names.join(" ")}` };
    }

    const builtin = builtinReply(matched, user);
    if (builtin != null) return { reply: builtin };

    const cmd = cmds.get(matched.name);
    if (!cmd) return null;
    if (!levelOk(cmd.level, level)) return null;

    const t = nowFn();
    const globalCd = Math.max(0, Number(cmd.cooldown) || 0);
    const userCd = Math.max(0, Number(cmd.userCooldown) || 0);

    if (globalCd > 0) {
      const last = globalLast.get(matched.name);
      if (last != null && t - last < globalCd * 1000) return null;
    }
    if (userCd > 0) {
      const key = `${String(user || "").toLowerCase()}:${matched.name}`;
      const last = userLast.get(key);
      if (last != null && t - last < userCd * 1000) return null;
    }

    globalLast.set(matched.name, t);
    if (userCd > 0) userLast.set(`${String(user || "").toLowerCase()}:${matched.name}`, t);

    const count = (counters.get(matched.name) || 0) + 1;
    counters.set(matched.name, count);

    const reply = renderTemplate(cmd.response, {
      user: user || "",
      channel: channel || "",
      args: matched.args,
      count,
    });
    return reply ? { reply } : null;
  }

  function tick() {
    const t = nowFn();
    const replies = [];
    let fired = false;

    for (const timer of timerList) {
      const responseTemplate = String(timer.response || "").trim();
      if (!responseTemplate) continue;

      const intervalMin = Math.max(1, Math.round(Number(timer.interval) || 0));
      const intervalMs = intervalMin * 60000;
      const last = timerLast.get(timer.id) || 0;
      if (t - last < intervalMs) continue;

      const minChat = Math.max(0, Math.round(Number(timer.minChat) || 0));
      if (minChat > chatLinesSinceTimer) continue;

      const count = (timerCounters.get(timer.id) || 0) + 1;
      timerCounters.set(timer.id, count);
      timerLast.set(timer.id, t);

      const reply = renderTemplate(responseTemplate, {
        user: "",
        channel: channel || "",
        args: "",
        count,
      });
      if (reply) {
        replies.push(reply);
        fired = true;
      }
    }

    if (fired) chatLinesSinceTimer = 0;
    return replies;
  }

  return { handleChat, tick, matchCommand };
}

/**
 * Parses the moderation chat commands `!timeout @user [sec]` and `!ban @user`.
 * Returns null when the message is not a moderation command.
 */
function parseModCommand(prefix, message) {
  const text = String(message || "").trim();
  const p = prefix || "!";
  if (!text.startsWith(p)) return null;
  const body = text.slice(p.length).trim();
  const parts = body.split(/\s+/);
  const name = (parts[0] || "").toLowerCase();
  if (name !== "timeout" && name !== "ban") return null;
  return {
    name,
    target: (parts[1] || "").replace(/^@/, "").trim(),
    durationRaw: name === "timeout" ? parts[2] : null,
  };
}

/**
 * Wires the engine onto the bus. Returns a controller with `stop()`.
 */
function startChatBot({ bus, state }) {
  const logger = createLogger(bus, "chat-bot");
  const config = state.config.chatBot || {};

  if (!config.enabled) {
    return { stop() {} };
  }

  const channel = (state.config.twitch && state.config.twitch.channel) || "";
  const engine = createBotEngine({
    prefix: config.prefix || "!",
    channel,
    commands: config.commands || [],
    timers: config.timers || [],
    startedAt: state.runtime && state.runtime.startedAt,
  });
  // Persist warn counts in local-db when available; otherwise fall back to an
  // in-memory store (session-scoped) so `server:only` still works.
  let moderationStore;
  if (state.db && typeof state.db.getModerationWarns === "function") {
    moderationStore = {
      get: (key) => state.db.getModerationWarns()[key] || 0,
      set: (key, count) => {
        const warns = state.db.getModerationWarns();
        warns[key] = count;
        state.db.saveModerationWarns(warns);
      },
      delete: (key) => {
        const warns = state.db.getModerationWarns();
        delete warns[key];
        state.db.saveModerationWarns(warns);
      },
    };
  }
  const moderation = createModerationEngine(config.moderation || {}, moderationStore);

  // The bot reads chat on the anonymous tmi socket but sends replies through
  // the Helix API, so its own messages come back as ordinary `chat_message`
  // events (`self` is not set). Remember recently sent replies and drop those
  // echoes so the bot never answers itself.
  const recentReplies = [];

  function isRecentReply(text) {
    const t = Date.now();
    const norm = String(text || "").trim().toLowerCase();
    for (let i = recentReplies.length - 1; i >= 0; i--) {
      if (t - recentReplies[i].at > 10000) recentReplies.splice(i, 1);
    }
    return recentReplies.some((r) => r.text === norm);
  }

  function rememberReply(text) {
    recentReplies.push({ text: String(text || "").trim().toLowerCase(), at: Date.now() });
    if (recentReplies.length > 20) recentReplies.shift();
  }

  function sendReply(text) {
    sendTwitchChatMessage({ bus, state, message: text }).then((result) => {
      if (result && result.ok) rememberReply(text);
      else if (result && result.error) logger.warn("bot reply failed", { error: result.error });
    });
  }

  const userIds = new Map(); // username (lowercase) -> userId

  function handleModCommand(msg, modCmd, level) {
    if (level !== "moderator" && level !== "broadcaster") {
      sendReply(`@${msg.user}, у вас нет прав на модерацию.`);
      return;
    }
    const targetName = modCmd.target;
    if (!targetName) {
      sendReply("Использование: !timeout @user [сек] | !ban @user");
      return;
    }
    const targetId = userIds.get(targetName.toLowerCase());
    if (!targetId) {
      sendReply(`@${msg.user}, не знаю ID пользователя ${targetName} — он ещё не писал в чат.`);
      return;
    }
    if (modCmd.name === "ban") {
      moderateUser({ bus, state, userId: targetId, reason: `Бан по команде ${msg.user}` }).then((result) => {
        if (result.ok) sendReply(`@${targetName} забанен.`);
        else logger.warn("ban command failed", { error: result.error });
      });
    } else {
      const duration = Math.max(1, Math.min(1209600, Math.round(Number(modCmd.durationRaw) || 600)));
      moderateUser({ bus, state, userId: targetId, duration, reason: `Таймаут по команде ${msg.user}` }).then((result) => {
        if (result.ok) sendReply(`@${targetName} в таймауте на ${duration} сек.`);
        else logger.warn("timeout command failed", { error: result.error });
      });
    }
  }

  function onChat(msg) {
    if (!msg || msg.isTest) return;
    if (isRecentReply(msg.message)) return;

    if (msg.userId) userIds.set(String(msg.user || "").toLowerCase(), msg.userId);

    const level = userLevel({ user: msg.user, badges: msg.badges || [], channel });

    const modCmd = parseModCommand(config.prefix, msg.message);
    if (modCmd) {
      handleModCommand(msg, modCmd, level);
      return;
    }

    const verdict = moderation.check({
      user: msg.user,
      userId: msg.userId,
      badges: msg.badges || [],
      message: msg.message,
      emotes: msg.emotes,
      level,
    });
    if (verdict) {
      if (verdict.message) sendReply(verdict.message);
      moderateUser({
        bus,
        state,
        userId: msg.userId,
        duration: verdict.timeoutSec,
        reason: verdict.reason,
      }).then((result) => {
        if (!result.ok && result.error) logger.warn("moderation action failed", { error: result.error });
      });
      return;
    }

    const result = engine.handleChat({
      user: msg.user,
      badges: msg.badges || [],
      message: msg.message,
    });
    if (result && result.reply) sendReply(result.reply);
  }

  bus.on("chat_message", onChat);

  const timerInterval = setInterval(() => {
    engine.tick().forEach(sendReply);
  }, 15000);

  logger.info("chat bot started", {
    channel,
    commands: (config.commands || []).length,
    timers: (config.timers || []).length,
    moderation: !!(config.moderation && config.moderation.enabled),
  });

  return {
    stop() {
      bus.off("chat_message", onChat);
      clearInterval(timerInterval);
    },
  };
}

module.exports = {
  startChatBot,
  createBotEngine,
  parseModCommand,
  formatUptime,
  userLevel,
  renderTemplate,
  normalizeName,
  LEVELS,
  LEVEL_RANK,
};
