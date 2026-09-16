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
const crypto = require("crypto");

const { seal, open, isSealed, isSecretUnreadable } = require("./secret-store");
const { WIDGET_TYPES, widgetsForTheme, widgetRole } = require("../shared/widget-catalog");
const { BUILTIN_THEMES } = require("../shared/themes");
const { buildThemeTokens, SHAPE_MODES, SCHEMES, ALERT_EASINGS } = require("../shared/theme-engine");
const { defaultScenes } = require("../shared/scenes-catalog");
const { defaultModerationConfig } = require("./integrations/chat-moderation");
const { getConfigPath, getExamplePath } = require("./storage-paths");
const { atomicWriteFileSync, AsyncAtomicStore, writeStatsIntervalMs, backupPath, DEFAULT_BACKUP_SLOTS } = require("./atomic-write");
const { recoverJsonFile, tryReadJson, describeBackups } = require("./data-integrity");
const { createLogger } = require("./logger");

// Свой логер для состояния: строки о конфиге должны попадать в файл журнала
// рядом с остальными, иначе «настройки сбросились» разбирать не по чему.
const configLog = createLogger(null, "config");

/*
  Загрузка config.json.

  Раньше файл парсился без обработки ошибок: обрыв записи, правка руками или
  неудачное копирование файла в каталог данных — и приложение просто не
  запускалось, а пользователь видел только ошибку в консоли. Теперь битый файл
  сначала уходит в карантин (`config.json.corrupt-<метка>`), потом конфиг
  поднимается из последнего удачного бэкапа, а если и его нет — из шаблона
  поставки. Любой из этих случаев виден в логе и в диалоге при старте.
*/
function loadConfig() {
  const configPath = getConfigPath();
  const config = readConfig(configPath);
  logLoadedConfig(configPath, config);
  return config;
}

function readConfig(configPath) {
  const recovered = recoverJsonFile(configPath, { label: "config.json" });

  if (recovered.source === "file") return decryptConfig(recovered.value);

  if (recovered.source === "backup") {
    // Восстановленное состояние сразу делаем рабочим файлом, чтобы дальше
    // приложение жило обычным порядком и сохраняло поверх валидного конфига.
    atomicWriteFileSync(configPath, JSON.stringify(recovered.value, null, 2));
    return decryptConfig(recovered.value);
  }

  // Файла нет (первый запуск) или восстанавливать нечего — берём шаблон поставки.
  const example = fs.readFileSync(getExamplePath(), "utf-8");
  atomicWriteFileSync(configPath, example);
  return decryptConfig(JSON.parse(example));
}

/*
  Что приложение на самом деле прочитало с диска.

  Без этой строки «настройки сбрасываются при перезапуске» неотличимо от
  «приложение берёт не тот файл» или «в каталоге данных лежит канал от другого
  профиля»: панель показывает одно, журнал молчит, и остаётся только гадать.
  Печатаем факты о файле и о том, что в нём заполнено, — без самих секретов:
  про секрет сообщается только его состояние (пусто / зашифрован / открытый текст).
*/
function describeSecretState(value) {
  const text = typeof value === "string" ? value : "";
  if (!text) return "empty";
  if (isSealed(text)) return `encrypted (${text.length} chars)`;
  return `plain (${text.length} chars)`;
}

function logLoadedConfig(configPath, config) {
  const twitch = config.twitch || {};
  const donationAlerts = config.donationAlerts || {};
  configLog.info("config loaded", {
    file: configPath,
    sections: Object.keys(config).length,
    twitchChannel: twitch.channel || "(not set)",
    donationAlertsClientId: donationAlerts.clientId || "(not set)",
    donationAlertsClientSecret: describeSecretState(donationAlerts.clientSecret),
    // Код доступа из сети здесь важен: если он пуст, каждый запуск выдает новый
    // адрес пульта — по этой строке сразу видно, что конфиг не сохраняется.
    remoteToken: config.remote_token ? "set" : "missing",
  });
}

function saveConfig(config) {
  getConfigStore().write(encryptConfig(config));
}

// store создаётся лениво и пересоздаётся при смене пути (используется в тестах).
let configStore = null;
let configStorePath = null;

function getConfigStore() {
  const p = getConfigPath();
  if (!configStore || configStorePath !== p) {
    configStore = new AsyncAtomicStore(p, {
      // ENOENT при смене каталога в тестах — не шум; остальное логируем.
      logger: (err) => {
        if (err && err.code !== "ENOENT") console.warn("[config] save failed:", err.message || err);
      },
      label: "config.json",
      reportEveryMs: writeStatsIntervalMs(),
    });
    configStorePath = p;
  }
  return configStore;
}

// Финальный синхронный сброс конфига — для выхода из приложения.
function flushConfigSync() {
  return configStore ? configStore.flushSync() : false;
}

/*
  Человекочитаемые имена секретов в конфиге.

  Ими же подписываются сообщения «секрет не удалось прочитать» в диалоге при
  старте и в панели сервиса: пользователь должен видеть, какой именно ключ надо
  вставить заново, а не «секрет №3».
*/
const SECRET_LABELS = {
  twitchClientSecret: "Twitch Client Secret",
  twitchAccessToken: "Twitch User Access Token",
  twitchRefreshToken: "Twitch Refresh Token",
  donationAlertsClientSecret: "DonationAlerts Client Secret",
  donationAlertsAccessToken: "DonationAlerts Access Token",
  donationAlertsRefreshToken: "DonationAlerts Refresh Token",
  youtubeClientSecret: "YouTube Client Secret",
  youtubeAccessToken: "YouTube Access Token",
  youtubeRefreshToken: "YouTube Refresh Token",
  obsPassword: "OBS Password",
};

function encryptConfig(config) {
  const twitch = config.twitch || {};
  const donationAlerts = config.donationAlerts || {};
  const youtube = config.youtube || {};
  const obs = config.obs || {};
  return {
    ...config,
    twitch: {
      ...twitch,
      clientSecret: seal(twitch.clientSecret, SECRET_LABELS.twitchClientSecret),
      userAccessToken: seal(twitch.userAccessToken, SECRET_LABELS.twitchAccessToken),
      refreshToken: seal(twitch.refreshToken, SECRET_LABELS.twitchRefreshToken),
    },
    donationAlerts: {
      ...donationAlerts,
      clientSecret: seal(donationAlerts.clientSecret, SECRET_LABELS.donationAlertsClientSecret),
      accessToken: seal(donationAlerts.accessToken, SECRET_LABELS.donationAlertsAccessToken),
      refreshToken: seal(donationAlerts.refreshToken, SECRET_LABELS.donationAlertsRefreshToken),
    },
    youtube: {
      ...youtube,
      clientSecret: seal(youtube.clientSecret, SECRET_LABELS.youtubeClientSecret),
      accessToken: seal(youtube.accessToken, SECRET_LABELS.youtubeAccessToken),
      refreshToken: seal(youtube.refreshToken, SECRET_LABELS.youtubeRefreshToken),
    },
    obs: {
      ...obs,
      password: seal(obs.password, SECRET_LABELS.obsPassword),
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
      clientSecret: open(twitch.clientSecret, SECRET_LABELS.twitchClientSecret),
      userAccessToken: open(twitch.userAccessToken, SECRET_LABELS.twitchAccessToken),
      refreshToken: open(twitch.refreshToken, SECRET_LABELS.twitchRefreshToken),
    },
    donationAlerts: {
      ...donationAlerts,
      clientSecret: open(donationAlerts.clientSecret, SECRET_LABELS.donationAlertsClientSecret),
      accessToken: open(donationAlerts.accessToken, SECRET_LABELS.donationAlertsAccessToken),
      refreshToken: open(donationAlerts.refreshToken, SECRET_LABELS.donationAlertsRefreshToken),
    },
    youtube: {
      ...youtube,
      clientSecret: open(youtube.clientSecret, SECRET_LABELS.youtubeClientSecret),
      accessToken: open(youtube.accessToken, SECRET_LABELS.youtubeAccessToken),
      refreshToken: open(youtube.refreshToken, SECRET_LABELS.youtubeRefreshToken),
    },
    obs: {
      ...obs,
      password: open(obs.password, SECRET_LABELS.obsPassword),
    },
  };
}

// Код доступа из сети: 32 hex-символа (16 байт) из CSPRNG.
function generateRemoteToken() {
  return crypto.randomBytes(16).toString("hex");
}

// Принимаем только свой формат: чужой (например, из правленого руками конфига)
// считаем отсутствующим и выдаём новый.
function normalizeRemoteToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : "";
}

// Сравнение кодов без утечки по времени: длину проверяем отдельно, потому что
// timingSafeEqual требует одинаковой длины буферов.
function tokensMatch(expected, given) {
  const a = Buffer.from(String(expected || ""), "utf8");
  const b = Buffer.from(String(given || ""), "utf8");
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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

// All 3D widget types — used to validate a custom theme's explicit widget list.
const THREE_D_WIDGET_TYPES = new Set(
  Object.values(WIDGET_TYPES)
    .filter((d) => d.dimension === "3d")
    .map((d) => d.type)
);

// Normalizes the custom-theme 3D widget selection. Accepts the explicit
// `threeDWidgets` array; migrates the older single `variant3d` style id by
// expanding it to that style's widgets.
function normalizeThreeDWidgets(seeds) {
  const raw = Array.isArray(seeds && seeds.threeDWidgets)
    ? seeds.threeDWidgets
    : seeds && seeds.variant3d
    ? widgetsForTheme(seeds.variant3d).map((d) => d.type)
    : [];
  const out = [];
  raw.forEach((t) => {
    const type = String(t || "").trim();
    if (THREE_D_WIDGET_TYPES.has(type) && !out.includes(type)) out.push(type);
  });
  return out;
}

function defaultAppearance() {
  // A theme is now a "family": one selected base theme plus an optional 3D
  // variant toggled by `enable3d` (see resolvedTheme/resolvedTheme3d below).
  return { activeThemeId: "nebula", enable3d: false, customThemes: [] };
}

function defaultEditor() {
  return { gridSize: 5, snapEnabled: true, aspectRatio: "16:9" };
}

const BOT_LEVELS = ["everyone", "subscriber", "moderator", "broadcaster"];

function normalizeBotCommand(command) {
  if (!command || typeof command !== "object") return null;
  const name = String(command.name || "")
    .trim()
    .toLowerCase()
    .replace(/^[!./]/, "");
  return {
    id: typeof command.id === "string" && command.id ? command.id : crypto.randomUUID(),
    name,
    response: String(command.response || "").trim(),
    level: BOT_LEVELS.includes(command.level) ? command.level : "everyone",
    cooldown: Math.max(0, Math.round(Number(command.cooldown) || 0)),
    userCooldown: Math.max(0, Math.round(Number(command.userCooldown) || 0)),
  };
}

function normalizeBotTimer(timer) {
  if (!timer || typeof timer !== "object") return null;
  const name = String(timer.name || "").trim();
  return {
    id: typeof timer.id === "string" && timer.id ? timer.id : crypto.randomUUID(),
    name,
    response: String(timer.response || "").trim(),
    interval: Math.max(1, Math.round(Number(timer.interval) || 0)),
    minChat: Math.max(0, Math.round(Number(timer.minChat) || 0)),
  };
}

function normalizeChatBotModeration(m) {
  const d = defaultModerationConfig();
  const src = m && typeof m === "object" ? m : {};
  return {
    enabled: src.enabled === true,
    linkProtection: src.linkProtection !== false,
    whitelistDomains: Array.isArray(src.whitelistDomains)
      ? src.whitelistDomains.map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 50)
      : d.whitelistDomains,
    badWords: Array.isArray(src.badWords)
      ? src.badWords.map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 200)
      : d.badWords,
    capsThreshold: typeof src.capsThreshold === "number" ? clamp(src.capsThreshold, 0, 1) : d.capsThreshold,
    maxEmotes: Math.round(typeof src.maxEmotes === "number" ? clamp(src.maxEmotes, 1, 100) : d.maxEmotes),
    maxWarns: Math.round(typeof src.maxWarns === "number" ? clamp(src.maxWarns, 1, 10) : d.maxWarns),
    warnTimeoutSec: Math.round(typeof src.warnTimeoutSec === "number" ? clamp(src.warnTimeoutSec, 1, 86400) : d.warnTimeoutSec),
  };
}

const REWARD_SCENES = ["", "main", "start", "brb", "talk", "end", "wheel", "poll", "pause"];

function normalizeTwitchReward(reward) {
  if (!reward || typeof reward !== "object") return null;
  const rewardTitle = String(reward.rewardTitle || "").trim();
  const rewardId = String(reward.rewardId || "").trim();
  if (!rewardTitle && !rewardId) return null;
  return {
    id: typeof reward.id === "string" && reward.id ? reward.id : crypto.randomUUID(),
    rewardId,
    rewardTitle,
    alert: reward.alert === true,
    alertMessage: String(reward.alertMessage || "").trim(),
    tts: reward.tts === true,
    ttsText: String(reward.ttsText || "").trim(),
    scene: REWARD_SCENES.includes(reward.scene) ? reward.scene : "",
  };
}

const EDITOR_ASPECT_RATIOS = ["16:9", "16:10", "21:9", "32:9", "4:3", "1:1", "9:16", "3:4"];

class AppState {
  constructor(db, config) {
    this.db = db || null;
    /*
      Конфиг, переданный снаружи, живёт только в памяти: это не тот конфиг,
      который лежит на диске (тесты и импорт настроек передают свой). Писать его
      в рабочий config.json нельзя — переданный набор (например фикстура теста)
      затрёт настоящие настройки пользователя. Ниже это важно ровно в одном
      месте — при создании кода доступа.
    */
    const fromDisk = !config;
    this.config = config || loadConfig();
    if (!this.config.appearance) this.config.appearance = defaultAppearance();
    if (!Array.isArray(this.config.appearance.customThemes)) this.config.appearance.customThemes = [];
    this._migrateAppearance();
    if (!this.config.appearance.enabled3d || typeof this.config.appearance.enabled3d !== "object") {
      this.config.appearance.enabled3d = {};
    }
    if (!this.config.editor) this.config.editor = defaultEditor();
    if (!this.config.editor.aspectRatio) this.config.editor.aspectRatio = "16:9";
    this.config.hud_edit_hotkey =
      typeof this.config.hud_edit_hotkey === "string" && this.config.hud_edit_hotkey.trim()
        ? this.config.hud_edit_hotkey.trim()
        : "Control+Shift+H";
    this.config.hud_display_id = this.config.hud_display_id == null ? null : String(this.config.hud_display_id);
    this.config.chat_hud_hotkey =
      typeof this.config.chat_hud_hotkey === "string" && this.config.chat_hud_hotkey.trim()
        ? this.config.chat_hud_hotkey.trim()
        : "Control+Shift+L";
    this.config.chat_hud_display_id = this.config.chat_hud_display_id == null ? null : String(this.config.chat_hud_display_id);
    this.config.notificationSound = this.config.notificationSound !== false;
    this.config.notificationVolume = typeof this.config.notificationVolume === "number"
      ? Math.min(1, Math.max(0, this.config.notificationVolume))
      : 0.8;
    this.config.notificationRepeats = Math.min(5, Math.max(1, Math.round(Number(this.config.notificationRepeats) || 1)));
    // Код доступа из сети создаётся один раз и живёт в конфиге: иначе после
    // каждого перезапуска адрес пульта на телефоне перестал бы работать.
    // Сброс синхронный: обычная запись асинхронная, и падение процесса сразу
    // после старта оставило бы на диске пустой код — новый адрес на телефоне.
    const remoteToken = normalizeRemoteToken(this.config.remote_token);
    if (remoteToken) {
      this.config.remote_token = remoteToken;
    } else {
      this.config.remote_token = generateRemoteToken();
      // Сброс нужен только для конфига с диска: тогда новый код сразу ложится в
      // config.json, и адрес пульта не меняется после перезапуска.
      if (fromDisk) {
        saveConfig(this.config);
        flushConfigSync();
      }
    }
    const ch = this.config.chatHud || {};
    this.config.chatHud = {
      width: typeof ch.width === "number" ? ch.width : 360,
      height: typeof ch.height === "number" ? ch.height : 560,
      x: ch.x == null || ch.x === "" ? null : Number(ch.x),
      y: ch.y == null || ch.y === "" ? null : Number(ch.y),
      opacity: typeof ch.opacity === "number" ? ch.opacity : 70,
      fontSize: typeof ch.fontSize === "number" ? ch.fontSize : 14,
    };
    const scenesDefaults = defaultScenes();
    this.config.scenes = this.config.scenes || {};
    Object.keys(scenesDefaults).forEach((sceneId) => {
      this.config.scenes[sceneId] = { ...scenesDefaults[sceneId], ...(this.config.scenes[sceneId] || {}) };
    });
    if (!this.config.topDonation) this.config.topDonation = { user: "", amount: 0, currency: "RUB" };
    this.config.splash = {
      file: String((this.config.splash && this.config.splash.file) || ""),
      duration: Math.max(0, Math.min(30, Math.round(Number((this.config.splash && this.config.splash.duration) || 0)))),
    };
    this.config.youtube = { clientId: "", clientSecret: "", accessToken: "", refreshToken: "", videoId: "", ...(this.config.youtube || {}) };
    this.config.obs = {
      enabled: false,
      host: "127.0.0.1",
      port: 4455,
      password: "",
      ...(this.config.obs || {}),
      webcamSource: String((this.config.obs && this.config.obs.webcamSource) || ""),
      micSource: String((this.config.obs && this.config.obs.micSource) || ""),
      sceneMap: { main: "", start: "", brb: "", talk: "", end: "", wheel: "", video: "", poll: "", pause: "", ...((this.config.obs && this.config.obs.sceneMap) || {}) },
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
        main: "",
        end: "",
        pause: "",
        ...(sd.icons || {}),
      },
    };
    const tts = this.config.tts || {};
    this.config.tts = {
      enabled: tts.enabled !== false,
      volume: typeof tts.volume === "number" ? tts.volume : 0.9,
      rate: typeof tts.rate === "number" ? tts.rate : 1,
      lang: String(tts.lang || "ru-RU"),
      voice: String(tts.voice || ""),
    };
    // Озвучка от самого сервиса (готовый аудиофайл доната), отдельно от TTS.
    const dv = this.config.donationVoice || {};
    this.config.donationVoice = {
      donationAlerts: dv.donationAlerts === true,
      volume: typeof dv.volume === "number" ? dv.volume : 0.9,
    };
    const poll = this.config.poll || {};
    this.config.poll = {
      command: typeof poll.command === "string" && poll.command.trim() ? poll.command.trim() : "!poll",
      chartType: poll.chartType === "pie" ? "pie" : "bars",
      options: Array.isArray(poll.options)
        ? poll.options
            .filter((o) => o && typeof o.id === "string" && typeof o.label === "string")
            .map((o) => ({ id: o.id, label: o.label }))
        : [],
    };
    const cb = this.config.chatBot || {};
    this.config.chatBot = {
      enabled: cb.enabled === true,
      prefix: typeof cb.prefix === "string" && cb.prefix.trim() ? cb.prefix.trim() : "!",
      commands: Array.isArray(cb.commands) ? cb.commands.map(normalizeBotCommand).filter(Boolean) : [],
      timers: Array.isArray(cb.timers) ? cb.timers.map(normalizeBotTimer).filter(Boolean) : [],
      moderation: normalizeChatBotModeration(cb.moderation),
    };
    this.config.twitchRewards = Array.isArray(this.config.twitchRewards)
      ? this.config.twitchRewards.map(normalizeTwitchReward).filter(Boolean)
      : [];
    // Цель сбора и последний крупный донат — разделы, которых в конфиге может
    // не быть: его правят руками, он приходит из старой версии или из урезанного
    // экспорта. Без нормализации первый же донат ронял обработчик алерта:
    // addToGoal обращался к this.config.goal.current, когда goal ещё не было.
    const goal = this.config.goal || {};
    this.config.goal = {
      title: typeof goal.title === "string" ? goal.title.slice(0, 80) : "",
      current: Math.max(0, Number(goal.current) || 0),
      target: Math.max(0, Number(goal.target) || 0),
      currency: typeof goal.currency === "string" && goal.currency.trim() ? goal.currency.trim().slice(0, 8) : "RUB",
    };
    const topDonation = this.config.topDonation || {};
    this.config.topDonation = {
      user: typeof topDonation.user === "string" ? topDonation.user : "",
      amount: Math.max(0, Number(topDonation.amount) || 0),
      currency: typeof topDonation.currency === "string" && topDonation.currency.trim() ? topDonation.currency.trim().slice(0, 8) : "RUB",
    };
    // Настройки очереди алертов (см. server/alert-queue.js). Живут в конфиге,
    // чтобы правила объединения и минимальная сумма не терялись при перезапуске,
    // а срок паузы — чтобы пауза, поставленная на 30 минут, не снималась
    // перезапуском приложения.
    const alertQueue = this.config.alert_queue || {};
    const mergeWindow = Number(alertQueue.merge_window_sec);
    this.config.alert_queue = {
      enabled: alertQueue.enabled !== false,
      min_amount: Math.max(0, Number(alertQueue.min_amount) || 0),
      merge_same_user: alertQueue.merge_same_user !== false,
      merge_window_sec: Number.isFinite(mergeWindow) ? clamp(Math.round(mergeWindow), 0, 600) : 20,
      pause_until: Math.max(0, Number(alertQueue.pause_until) || 0),
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
      startedAt: Date.now(),
      reconnects: {},
      connectionStatus: {
        twitchChat: "disconnected",
        twitchEvents: this.config.twitch.userAccessToken ? "connecting" : "not_configured",
        donationAlerts: this.config.donationAlerts.accessToken ? "connecting" : "not_configured",
        youtube: this.config.youtube.accessToken ? "connecting" : "not_configured",
        obs: "not_configured",
      },
      recentEvents: [],
      stats: { followerCount: null, subscriberCount: null },
      /*
        Доход текущего стрима.

        Считается на приходе доната, а не разбором истории: история растёт, а
        счётчик — это одно сложение (см. addDonationToSession).
      */
      session: { donations: 0, amount: 0, currency: "" },
      deathCount: 0,
      // Последний снимок конфига Longshot (Executive Hangar); null — ещё не было.
      longshot: null,
      activeScene: "main",
      sceneStartedAt: null,
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
      poll: {
        active: false,
        votes: new Map(), // username -> optionId
      },
    };
  }

  get layout() {
    return this._layout;
  }

  _loadLayoutFromDb() {
    const widgets = this.db.getWidgets();
    // Виджеты, чей тип исчез из каталога (например, «Участники розыгрыша»
    // переехали в сцену колеса), в раскладке больше не нужны — чистим при загрузке.
    const clean = (list) => (Array.isArray(list) ? list.filter((w) => w && w.id != null && WIDGET_TYPES[w.type]) : []);
    if (Array.isArray(widgets) && widgets.length) {
      const filtered = clean(widgets);
      if (filtered.length !== widgets.length) this.db.saveWidgets(filtered);
      return filtered;
    }
    const legacy = clean(this.config.layout);
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

  // Migrates legacy appearance shapes into the current `{ activeThemeId,
  // enable3d }` model:
  //   * pre-2.3.1  — single `activeThemeId`;
  //   * 2.3.1–2.x  — `activeThemeId2d` + `activeThemeId3d`.
  _migrateAppearance() {
    const a = this.config.appearance;
    const isVariant = (id) => BUILTIN_THEMES[id] && BUILTIN_THEMES[id].variant === true;

    // Pre-2.3.1 single id.
    if (a.activeThemeId && a.activeThemeId2d === undefined && a.activeThemeId3d === undefined && a.enable3d === undefined) {
      if (isVariant(a.activeThemeId) || (BUILTIN_THEMES[a.activeThemeId] && BUILTIN_THEMES[a.activeThemeId].dimension === "3d")) {
        a.enable3d = true;
      }
      if (isVariant(a.activeThemeId)) a.activeThemeId = BUILTIN_THEMES[a.activeThemeId].base2d;
    }

    // Two-slot model.
    if (a.activeThemeId2d || a.activeThemeId3d) {
      const id2d = a.activeThemeId2d || "nebula";
      const id3d = a.activeThemeId3d || "";
      if (id3d) {
        a.activeThemeId = (BUILTIN_THEMES[id3d] && BUILTIN_THEMES[id3d].base2d) || id2d;
        a.enable3d = true;
      } else {
        a.activeThemeId = id2d;
        a.enable3d = false;
      }
      delete a.activeThemeId2d;
      delete a.activeThemeId3d;
    }

    // Safety net: a stray 3D variant id maps back to its base 2D theme.
    if (a.activeThemeId && isVariant(a.activeThemeId)) {
      a.activeThemeId = BUILTIN_THEMES[a.activeThemeId].base2d;
      a.enable3d = true;
    }

    if (!a.activeThemeId) a.activeThemeId = "nebula";
    if (typeof a.enable3d !== "boolean") a.enable3d = false;
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

  // Есть ли в раскладке видимый таймер Executive Hangar (роль "timer" — и 2D
  // `timer`, и 3D `grimhex-timer`). Отсчёт всегда идёт от Longshot, поэтому пока
  // такого виджета нет или он скрыт — внешний API не опрашивается вообще.
  hasTimerWidget() {
    return this._layout.some((w) => {
      if (!w || w.visible === false) return false;
      return widgetRole(w.type) === "timer";
    });
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

  // Commit a full layout array from the game HUD edit mode. Every item is
  // clamped to the same bounds as updateWidget so a stray drag can't write
  // off-screen or undersized geometry into the database.
  saveLayout(layout) {
    if (!Array.isArray(layout)) return false;
    const round2 = (n) => Math.round(n * 100) / 100;
    this._layout = layout
      .filter((w) => w && w.id != null && WIDGET_TYPES[w.type])
      .map((w) => {
        const def = WIDGET_TYPES[w.type] || { minW: 5, minH: 5 };
        const width = clamp(Number(w.w) || def.minW, def.minW, 100);
        const height = clamp(Number(w.h) || def.minH, def.minH, 100);
        return {
          ...w,
          w: round2(width),
          h: round2(height),
          x: round2(clamp(Number(w.x) || 0, 0, 100 - width)),
          y: round2(clamp(Number(w.y) || 0, 0, 100 - height)),
        };
      });
    this._persistLayout();
    return true;
  }

  // ---- Layout presets ----

  _getLayoutPresets() {
    if (this.db) return this.db.getLayoutPresets();
    if (!this._memoryPresets) this._memoryPresets = [];
    return this._memoryPresets;
  }

  _setLayoutPresets(presets) {
    if (this.db) return this.db.saveLayoutPresets(presets);
    this._memoryPresets = presets;
    return this._memoryPresets;
  }

  listLayoutPresets() {
    return this._getLayoutPresets().map((p) => ({
      id: p.id,
      name: p.name,
      widgetCount: Array.isArray(p.widgets) ? p.widgets.length : 0,
      themeId: p.themeId || p.theme2d || "",
      enable3d: p.enable3d != null ? !!p.enable3d : !!p.theme3d,
      createdAt: p.createdAt || 0,
      updatedAt: p.updatedAt || 0,
    }));
  }

  saveLayoutPreset({ id, name } = {}) {
    const cleanName = String(name || "").trim().slice(0, 60);
    if (!cleanName) return null;
    const presets = this._getLayoutPresets();
    const widgets = this._layout.map((w) => ({ ...w, config: { ...(w.config || {}) } }));
    const themeId = this.config.appearance.activeThemeId || "nebula";
    const enable3d = !!this.config.appearance.enable3d;
    if (id) {
      const existing = presets.find((p) => p.id === id);
      if (!existing) return null;
      existing.name = cleanName;
      existing.widgets = widgets;
      existing.themeId = themeId;
      existing.enable3d = enable3d;
      existing.updatedAt = Date.now();
    } else {
      presets.push({ id: crypto.randomUUID(), name: cleanName, widgets, themeId, enable3d, createdAt: Date.now(), updatedAt: Date.now() });
    }
    this._setLayoutPresets(presets);
    return this.listLayoutPresets();
  }

  applyLayoutPreset(id) {
    const preset = this._getLayoutPresets().find((p) => p.id === id);
    if (!preset || !Array.isArray(preset.widgets)) return null;
    this._layout = preset.widgets.map((w) => ({ ...w, config: { ...(w.config || {}) } }));
    // Restore the theme the preset was saved with so theme-bound (3D) widgets
    // actually become visible again. Older presets stored theme2d/theme3d; new
    // ones store themeId/enable3d.
    const rawThemeId = preset.themeId || preset.theme2d || "";
    const builtin = BUILTIN_THEMES[rawThemeId];
    const themeId = builtin && builtin.variant ? builtin.base2d : rawThemeId;
    const enable3d = preset.enable3d != null ? !!preset.enable3d : !!preset.theme3d;
    if (themeId && this.themeDimension(themeId)) {
      this.config.appearance.activeThemeId = themeId;
    }
    this.config.appearance.enable3d = enable3d;
    saveConfig(this.config);
    this._persistLayout();
    return this._layout;
  }

  deleteLayoutPreset(id) {
    const before = this._getLayoutPresets().length;
    this._setLayoutPresets(this._getLayoutPresets().filter((p) => p.id !== id));
    return this._getLayoutPresets().length !== before ? this.listLayoutPresets() : null;
  }

  // ---- Poll presets ----

  _getPollPresets() {
    if (this.db) return this.db.getPollPresets();
    if (!this._memoryPollPresets) this._memoryPollPresets = [];
    return this._memoryPollPresets;
  }

  _setPollPresets(presets) {
    if (this.db) return this.db.savePollPresets(presets);
    this._memoryPollPresets = presets;
    return this._memoryPollPresets;
  }

  listPollPresets() {
    return this._getPollPresets().map((p) => ({
      id: p.id,
      name: p.name,
      command: typeof p.command === "string" && p.command.trim() ? p.command.trim() : "!poll",
      chartType: p.chartType === "pie" ? "pie" : "bars",
      optionCount: Array.isArray(p.options) ? p.options.length : 0,
      createdAt: p.createdAt || 0,
      updatedAt: p.updatedAt || 0,
    }));
  }

  savePollPreset({ id, name } = {}) {
    const cleanName = String(name || "").trim().slice(0, 60);
    if (!cleanName) return null;
    const presets = this._getPollPresets();
    const payload = {
      command: this.config.poll.command || "!poll",
      chartType: this.config.poll.chartType === "pie" ? "pie" : "bars",
      options: (this.config.poll.options || []).map((o) => ({ id: o.id, label: o.label })),
    };
    if (id) {
      const existing = presets.find((p) => p.id === id);
      if (!existing) return null;
      existing.name = cleanName;
      existing.command = payload.command;
      existing.chartType = payload.chartType;
      existing.options = payload.options;
      existing.updatedAt = Date.now();
    } else {
      presets.push({ id: crypto.randomUUID(), name: cleanName, ...payload, createdAt: Date.now(), updatedAt: Date.now() });
    }
    this._setPollPresets(presets);
    return this.listPollPresets();
  }

  applyPollPreset(id) {
    const preset = this._getPollPresets().find((p) => p.id === id);
    if (!preset) return null;
    this.config.poll = {
      command: typeof preset.command === "string" && preset.command.trim() ? preset.command.trim() : "!poll",
      chartType: preset.chartType === "pie" ? "pie" : "bars",
      options: Array.isArray(preset.options)
        ? preset.options
            .filter((o) => o && typeof o.id === "string" && typeof o.label === "string")
            .map((o) => ({ id: o.id, label: o.label }))
        : [],
    };
    if (this.db) this.db.savePollConfig(this.config.poll);
    return this.pollSnapshot();
  }

  deletePollPreset(id) {
    const before = this._getPollPresets().length;
    this._setPollPresets(this._getPollPresets().filter((p) => p.id !== id));
    return this._getPollPresets().length !== before ? this.listPollPresets() : null;
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

  // ---- Очередь алертов ----

  alertQueueConfig() {
    return { ...this.config.alert_queue };
  }

  /*
    Правила очереди. Используются и панелью (минимальная сумма, объединение),
    и постановкой паузы: срок паузы хранится здесь, чтобы перезапуск приложения
    её не снимал.
  */
  setAlertQueueConfig(patch = {}) {
    const next = { ...this.config.alert_queue };
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.minAmount !== undefined) next.min_amount = Math.max(0, Number(patch.minAmount) || 0);
    if (patch.mergeSameUser !== undefined) next.merge_same_user = !!patch.mergeSameUser;
    if (patch.mergeWindowSec !== undefined) {
      next.merge_window_sec = clamp(Math.round(Number(patch.mergeWindowSec) || 0), 0, 600);
    }
    if (patch.pauseUntil !== undefined) next.pause_until = Math.max(0, Number(patch.pauseUntil) || 0);
    this.config.alert_queue = next;
    saveConfig(this.config);
    return { ...next };
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
    if (patch.webcamSource !== undefined) this.config.obs.webcamSource = String(patch.webcamSource).trim();
    if (patch.micSource !== undefined) this.config.obs.micSource = String(patch.micSource).trim();
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

  setTtsConfig(patch = {}) {
    // Защита: если по какой-то причине tts отсутствует в конфиге (например,
    // после импорта старого файла), не падаем, а создаём пустой объект.
    this.config.tts = this.config.tts || {};
    if (patch.enabled !== undefined) this.config.tts.enabled = !!patch.enabled;
    if (patch.volume !== undefined) this.config.tts.volume = clamp(Number(patch.volume) || 0, 0, 1);
    if (patch.rate !== undefined) this.config.tts.rate = clamp(Number(patch.rate) || 1, 0.5, 2);
    if (patch.lang !== undefined) this.config.tts.lang = String(patch.lang).trim() || "ru-RU";
    if (patch.voice !== undefined) this.config.tts.voice = String(patch.voice).trim();
    saveConfig(this.config);
    return this.config.tts;
  }

  setDonationVoiceConfig(patch = {}) {
    if (patch.donationAlerts !== undefined) this.config.donationVoice.donationAlerts = !!patch.donationAlerts;
    if (patch.volume !== undefined) this.config.donationVoice.volume = clamp(Number(patch.volume) || 0, 0, 1);
    saveConfig(this.config);
    return this.config.donationVoice;
  }

  setChatBotConfig(patch = {}) {
    const cur = this.config.chatBot;
    const next = { ...cur, ...(patch || {}) };
    next.enabled = next.enabled !== false;
    next.prefix = typeof next.prefix === "string" && next.prefix.trim() ? next.prefix.trim() : "!";
    next.commands = Array.isArray(next.commands)
      ? next.commands.map(normalizeBotCommand).filter(Boolean).slice(0, 100)
      : cur.commands;
    next.timers = Array.isArray(next.timers)
      ? next.timers.map(normalizeBotTimer).filter(Boolean).slice(0, 50)
      : cur.timers;
    next.moderation = normalizeChatBotModeration({ ...cur.moderation, ...(next.moderation || {}) });
    this.config.chatBot = next;
    saveConfig(this.config);
    return this.config.chatBot;
  }

  setTwitchRewards(patch = {}) {
    if (Array.isArray(patch.rewards)) {
      this.config.twitchRewards = patch.rewards.slice(0, 100).map(normalizeTwitchReward).filter(Boolean);
      saveConfig(this.config);
    }
    return this.config.twitchRewards;
  }

  getTwitchRewardById(id) {
    return this.config.twitchRewards.find((r) => r.id === id) || null;
  }

  // ---- Death counter (remote quick action) ----

  adjustDeathCount(delta) {
    this.runtime.deathCount = Math.max(0, (this.runtime.deathCount || 0) + (Number(delta) || 0));
    return { count: this.runtime.deathCount };
  }

  // Последний снимок конфига Longshot (Executive Hangar), полученный сервером.
  setLongshot(snapshot) {
    this.runtime.longshot = snapshot || null;
    return this.runtime.longshot;
  }

  resetDeathCount() {
    this.runtime.deathCount = 0;
    return { count: 0 };
  }

  setActiveScene(scene) {
    this.runtime.activeScene = String(scene || "main");
    // Момент активации сцены: к нему привязан обратный отсчёт в оверлее.
    // Благодаря этому таймер не сбрасывается при обычных обновлениях STATE
    // и переживает перезагрузку страницы OBS-источника.
    this.runtime.sceneStartedAt = Date.now();
    return this.runtime.activeScene;
  }

  // Повторно берёт текущий момент как начало отсчёта активной сцены — например,
  // когда сцена реально становится видимой после заставки.
  markSceneStarted() {
    this.runtime.sceneStartedAt = Date.now();
    return this.runtime.sceneStartedAt;
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

  pollSnapshot() {
    const votes = this.runtime.poll.votes;
    const counts = {};
    for (const optionId of votes.values()) counts[optionId] = (counts[optionId] || 0) + 1;
    return {
      active: this.runtime.poll.active,
      command: this.config.poll.command,
      chartType: this.config.poll.chartType,
      options: this.config.poll.options,
      votes: counts,
      total: votes.size,
    };
  }

  startPoll(command) {
    if (typeof command === "string" && command.trim()) this.config.poll.command = command.trim();
    if (this.db) this.db.savePollConfig(this.config.poll);
    this.runtime.poll.active = true;
    this.runtime.poll.votes = new Map();
    return this.pollSnapshot();
  }

  stopPoll() {
    this.runtime.poll.active = false;
    return this.pollSnapshot();
  }

  resetPoll() {
    this.runtime.poll.votes = new Map();
    return this.pollSnapshot();
  }

  setPollConfig(patch) {
    const next = { ...this.config.poll, ...(patch || {}) };
    if (typeof next.command === "string") next.command = next.command.trim() || "!poll";
    next.chartType = next.chartType === "pie" ? "pie" : "bars";
    if (!Array.isArray(next.options)) next.options = this.config.poll.options;
    this.config.poll = next;
    if (this.db) this.db.savePollConfig(this.config.poll);
    return this.pollSnapshot();
  }

  addPollOption(label) {
    const text = String(label || "").trim();
    if (!text) return null;
    const option = { id: crypto.randomUUID(), label: text };
    this.config.poll.options = [...this.config.poll.options, option];
    if (this.db) this.db.savePollConfig(this.config.poll);
    return this.pollSnapshot();
  }

  removePollOption(id) {
    const optionId = String(id || "");
    const before = this.config.poll.options.length;
    this.config.poll.options = this.config.poll.options.filter((o) => o.id !== optionId);
    // Удаляем голоса за удалённый пункт.
    if (this.config.poll.options.length !== before) {
      for (const [user, oid] of this.runtime.poll.votes) {
        if (oid === optionId) this.runtime.poll.votes.delete(user);
      }
      if (this.db) this.db.savePollConfig(this.config.poll);
    }
    return this.pollSnapshot();
  }

  clearPollOptions() {
    this.config.poll.options = [];
    this.runtime.poll.votes = new Map();
    if (this.db) this.db.savePollConfig(this.config.poll);
    return this.pollSnapshot();
  }

  votePoll(username, optionId) {
    const name = String(username || "").trim();
    if (!name || optionId == null) return null;
    if (!this.runtime.poll.active) return null;
    const valid = this.config.poll.options.some((o) => o.id === optionId);
    if (!valid) return null;
    this.runtime.poll.votes.set(name, optionId);
    return this.pollSnapshot();
  }

  handlePollChat(username, message) {
    const poll = this.runtime.poll;
    if (!poll.active) return null;
    const cmd = this.config.poll.command.toLowerCase();
    const msg = String(message || "").trim().toLowerCase();
    if (!cmd || (msg !== cmd && !msg.startsWith(cmd + " "))) return null;
    const rest = msg.slice(cmd.length).trim();
    if (!rest) return null; // без номера пункта голос не засчитываем
    const idx = Number(rest);
    if (!Number.isInteger(idx) || idx < 1 || idx > this.config.poll.options.length) return null;
    const optionId = this.config.poll.options[idx - 1].id;
    return this.votePoll(username, optionId);
  }

  testPollVotes(count) {
    const options = this.config.poll.options;
    if (!options.length) return null;
    const n = Math.max(1, Math.min(50, Number(count) || 12));
    for (let i = 0; i < n; i++) {
      const user = `__test_${i + 1}`;
      const optionId = options[i % options.length].id;
      this.runtime.poll.votes.set(user, optionId);
    }
    return this.pollSnapshot();
  }

  pushRecentEvent(event) {
    this.runtime.recentEvents.unshift({ ...event, at: Date.now() });
    this.runtime.recentEvents = this.runtime.recentEvents.slice(0, 15);
  }

  setConnectionStatus(service, status) {
    const key = String(service);
    const next = String(status);
    const prev = this.runtime.connectionStatus[key];
    // Переход «не connecting → connecting» — это попытка подключиться (в том
    // числе переподключение после обрыва). Считаем их, чтобы шторм обрывов был
    // виден числом (/healthz и отчёт для поддержки), а не только строками в логе.
    if (next === "connecting" && prev !== "connecting") {
      this.runtime.reconnects[key] = (this.runtime.reconnects[key] || 0) + 1;
    }
    this.runtime.connectionStatus[key] = next;
  }

  // Счётчики рантайма наружу: сколько живёт процесс и сколько раз интеграции
  // переподключались. В снапшот для панели не уходит — там это лишний шум.
  runtimeStats() {
    return {
      startedAt: this.runtime.startedAt,
      uptimeSec: Math.max(0, Math.round((Date.now() - this.runtime.startedAt) / 1000)),
      reconnects: { ...this.runtime.reconnects },
    };
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

  /*
    Доход текущего стрима.

    Донаты считаются в момент прихода (см. index.js:bus.on("alert")), а не
    разбором истории при отрисовке: история растёт, а счётчик — это одно
    сложение, поэтому панель может спрашивать его сколько угодно раз.

    Валюта — как у последнего доната. Как и в цели сбора, касса не пересчитывает
    валюты между собой: зрители платят в одной валюте, а курсы здесь были бы
    выдумкой.
  */
  addDonationToSession(amount, currency) {
    const value = Number(amount) || 0;
    if (value <= 0) return this.sessionDonations();
    this.runtime.session.donations += 1;
    this.runtime.session.amount += value;
    if (currency) this.runtime.session.currency = String(currency);
    return this.sessionDonations();
  }

  sessionDonations() {
    return {
      count: this.runtime.session.donations,
      amount: this.runtime.session.amount,
      currency: this.runtime.session.currency,
    };
  }

  // Новый стрим — новый счёт.
  resetSessionDonations() {
    this.runtime.session = { donations: 0, amount: 0, currency: "" };
    return this.sessionDonations();
  }

  /*
    Ключи приложения (Client ID/Secret) для OAuth.

    Секрет сохраняется только непустым. Причина не в аккуратности, а в том, как
    устроен интерфейс: панель НИКОГДА не отдаёт сохранённый секрет обратно в поле
    (это секрет), поэтому поле при каждом открытии пустое, а кнопка «Подключить»
    отправляет ровно то, что в нём есть. Без этой проверки одно нажатие кнопки
    стирало рабочие ключи, и сервис отвечал invalid_client на обмен токена —
    ровно та ошибка, которую в такой ситуации невозможно объяснить по интерфейсу.
  */
  saveTwitchApp({ clientId, clientSecret }) {
    if (clientId !== undefined) this.config.twitch.clientId = String(clientId).trim();
    const twitchSecret = typeof clientSecret === "string" ? clientSecret.trim() : "";
    if (twitchSecret) this.config.twitch.clientSecret = twitchSecret;
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
    const daSecret = typeof clientSecret === "string" ? clientSecret.trim() : "";
    if (daSecret) this.config.donationAlerts.clientSecret = daSecret;
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
    const youtubeSecret = typeof clientSecret === "string" ? clientSecret.trim() : "";
    if (youtubeSecret) this.config.youtube.clientSecret = youtubeSecret;
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

  setNotificationSound(enabled) {
    this.config.notificationSound = enabled !== false;
    saveConfig(this.config);
    return this.config.notificationSound;
  }

  setNotificationVolume(volume) {
    const n = Number(volume);
    this.config.notificationVolume = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : this.config.notificationVolume;
    saveConfig(this.config);
    return this.config.notificationVolume;
  }

  setNotificationRepeats(repeats) {
    const n = Math.round(Number(repeats));
    this.config.notificationRepeats = Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1;
    saveConfig(this.config);
    return this.config.notificationRepeats;
  }

  // ---- Appearance / themes ----

  findCustomTheme(id) {
    return this.config.appearance.customThemes.find((t) => t.id === id);
  }

  themeDimension(id) {
    if (BUILTIN_THEMES[id]) return BUILTIN_THEMES[id].dimension || "2d";
    if (this.findCustomTheme(id)) return "2d";
    return null;
  }

  resolveTheme(id) {
    if (BUILTIN_THEMES[id]) return BUILTIN_THEMES[id];
    const custom = this.findCustomTheme(id);
    if (custom) {
      return {
        id: custom.id,
        name: custom.name,
        builtin: false,
        tokens: custom.tokens,
        customCss: (custom.seeds && custom.seeds.customCss) || "",
        // Своя тема хранит явный список включённых 3D-виджетов.
        threeDWidgets: (custom.seeds && custom.seeds.threeDWidgets) || [],
      };
    }
    return null;
  }

  // The base theme (family) that drives the overlay's 2D look and global tokens.
  resolvedTheme() {
    return this.resolveTheme(this.config.appearance.activeThemeId) || BUILTIN_THEMES.nebula;
  }

  // The active 3D variant of the selected theme, or null when 3D is off or the
  // theme has no 3D variant. Its widgets are gated by this id in the overlay.
  resolvedTheme3d() {
    if (!this.config.appearance.enable3d) return null;
    const base = this.resolvedTheme();
    if (!base || !base.builtin || !base.variant3d) return null;
    return this.resolveTheme(base.variant3d) || null;
  }

  // The explicit list of enabled 3D widget types under the current theme.
  // Built-in themes derive it from the active variant minus disabled фишки;
  // custom themes use their own selection (any combination of widgets).
  _active3dWidgets(theme2d, theme3d, isCustomBase, enabled3d) {
    if (!this.config.appearance.enable3d) return [];
    if (isCustomBase) {
      return (theme2d.threeDWidgets || []).filter((t) => THREE_D_WIDGET_TYPES.has(t));
    }
    if (!theme3d) return [];
    return widgetsForTheme(theme3d.id)
      .filter((w) => enabled3d[w.type] !== false)
      .map((w) => w.type);
  }

  listThemes() {
    const builtins = Object.values(BUILTIN_THEMES)
      .filter((t) => !t.variant) // 3D variants (grimhex/cobra-mk2) are not standalone themes
      .map((t) => ({
        id: t.id,
        name: t.name,
        builtin: true,
        category: t.category || "system",
        dimension: t.dimension || "2d",
        has3d: !!t.variant3d,
        variant3d: t.variant3d || null,
        colors: [
          t.tokens["--md-primary"],
          t.tokens["--md-secondary"],
          t.tokens["--md-tertiary"],
        ],
      }));
    const custom = this.config.appearance.customThemes.map((t) => ({
      id: t.id,
      name: t.name,
      builtin: false,
      category: "custom",
      dimension: "2d",
      has3d: !!(t.seeds && Array.isArray(t.seeds.threeDWidgets) && t.seeds.threeDWidgets.length),
      threeDWidgets: (t.seeds && t.seeds.threeDWidgets) || [],
      seeds: t.seeds,
      colors: [
        (t.seeds && t.seeds.primary) || "#888888",
        (t.seeds && t.seeds.secondary) || "#888888",
        (t.seeds && t.seeds.tertiary) || "#888888",
      ],
    }));
    return [...builtins, ...custom];
  }

  // Selecting a 3D-only family (Nuclear) turns its 3D widgets on by default;
  // 2D families stay 2D until the user flips the 3D toggle.
  _defaultEnable3d(id) {
    const t = BUILTIN_THEMES[id];
    return !!(t && t.dimension === "3d");
  }

  setActiveTheme(id, enable3d) {
    // Backward-compat: an empty id used to mean "disable 3D".
    if (!id) {
      this.config.appearance.enable3d = false;
      saveConfig(this.config);
      return true;
    }
    const t = this.resolveTheme(id);
    if (!t) return false;
    if (t.builtin && t.variant) {
      // A 3D variant id (grimhex / cobra-mk2) selects its base 2D theme + 3D.
      this.config.appearance.activeThemeId = t.base2d;
      this.config.appearance.enable3d = true;
    } else {
      this.config.appearance.activeThemeId = t.id;
      const requested = typeof enable3d === "boolean" ? enable3d : this._defaultEnable3d(t.id);
      const has3d = t.builtin ? !!t.variant3d : Array.isArray(t.threeDWidgets) && t.threeDWidgets.length > 0;
      // 3D нельзя включить у темы без 3D-набора виджетов.
      this.config.appearance.enable3d = requested && has3d;
    }
    saveConfig(this.config);
    return true;
  }

  // Enable/disable an individual 3D widget (фишка) for the currently selected
  // theme's 3D variant. Absent key = enabled; we store only disabled entries
  // (false) to keep the config compact.
  setEnabled3dWidget(type, enabled) {
    const clean = String(type || "").trim();
    if (!clean) return null;
    if (enabled) delete this.config.appearance.enabled3d[clean];
    else this.config.appearance.enabled3d[clean] = false;
    saveConfig(this.config);
    return this.config.appearance.enabled3d;
  }

  saveCustomTheme({ id, name, seeds }) {
    const cleanSeeds = {
      primary: seeds.primary || "#c6b8ff",
      secondary: seeds.secondary || "#7ee0d6",
      tertiary: seeds.tertiary || "#ffb0d8",
      surfaceSeed: seeds.surfaceSeed || seeds.primary || "#8878c8",
      // Тёмная схема — как в приложении; светлая выводит ту же палитру из
      // светлой шкалы поверхностей.
      mode: SCHEMES.includes(seeds.mode) ? seeds.mode : "dark",
      shapeMode: SHAPE_MODES.includes(seeds.shapeMode) ? seeds.shapeMode : "rounded",
      fontPreset: seeds.fontPreset === "orbital" ? "orbital" : "nebula",
      fontDisplay: String(seeds.fontDisplay || "").trim(),
      fontBody: String(seeds.fontBody || "").trim(),
      fontMono: String(seeds.fontMono || "").trim(),
      panelRadius: String(seeds.panelRadius || "").trim(),
      panelBorderWidth: String(seeds.panelBorderWidth || "").trim(),
      panelBorderStyle: String(seeds.panelBorderStyle || "").trim(),
      panelBorderColor: String(seeds.panelBorderColor || "").trim(),
      panelGlowColor: String(seeds.panelGlowColor || "").trim(),
      panelGlowStrength: Math.max(0, Math.min(100, Number(seeds.panelGlowStrength) || 0)),
      background: String(seeds.background || "").trim(),
      text: String(seeds.text || "").trim(),
      panelOpacity: seeds.panelOpacity === "" || seeds.panelOpacity == null ? "" : Math.max(0, Math.min(100, Number(seeds.panelOpacity) || 0)),
      panelBlur: String(seeds.panelBlur || "").trim(),
      // Цвет ошибки и анимация появления алертов (пусто — значение по форме/дефолт).
      error: /^#[0-9a-f]{6}$/i.test(String(seeds.error || "").trim()) ? String(seeds.error).trim() : "",
      alertEnterDuration:
        seeds.alertEnterDuration === "" || seeds.alertEnterDuration == null
          ? ""
          : Math.max(0, Math.min(2000, Math.round(Number(seeds.alertEnterDuration) || 0))),
      alertEnterEasing: Object.prototype.hasOwnProperty.call(ALERT_EASINGS, seeds.alertEnterEasing)
        ? seeds.alertEnterEasing
        : "",
      // Явный список 3D-виджетов своей темы (можно смешивать стили).
      threeDWidgets: normalizeThreeDWidgets(seeds),
      customCss: String(seeds.customCss || ""),
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

  duplicateCustomTheme(id) {
    const source = this.findCustomTheme(id);
    if (!source) return null;
    const copy = {
      id: crypto.randomUUID(),
      name: String(source.name || "").slice(0, 36) + " (копия)",
      seeds: { ...(source.seeds || {}) },
      tokens: { ...(source.tokens || {}) },
    };
    this.config.appearance.customThemes.push(copy);
    saveConfig(this.config);
    return copy;
  }

  setEditorPrefs({ gridSize, snapEnabled, aspectRatio }) {
    if (typeof gridSize === "number") this.config.editor.gridSize = clamp(gridSize, 0, 25);
    if (typeof snapEnabled === "boolean") this.config.editor.snapEnabled = snapEnabled;
    if (typeof aspectRatio === "string" && EDITOR_ASPECT_RATIOS.includes(aspectRatio)) {
      this.config.editor.aspectRatio = aspectRatio;
    }
    saveConfig(this.config);
    return this.config.editor;
  }

  setHudHotkey(hotkey) {
    const cleaned = typeof hotkey === "string" ? hotkey.trim() : "";
    this.config.hud_edit_hotkey = cleaned || "Control+Shift+H";
    saveConfig(this.config);
    return this.config.hud_edit_hotkey;
  }

  setHudDisplay(displayId) {
    this.config.hud_display_id = displayId == null || displayId === "" ? null : String(displayId);
    saveConfig(this.config);
    return this.config.hud_display_id;
  }

  setChatHudHotkey(hotkey) {
    const cleaned = typeof hotkey === "string" ? hotkey.trim() : "";
    this.config.chat_hud_hotkey = cleaned || "Control+Shift+L";
    saveConfig(this.config);
    return this.config.chat_hud_hotkey;
  }

  setChatHudDisplay(displayId) {
    this.config.chat_hud_display_id = displayId == null || displayId === "" ? null : String(displayId);
    saveConfig(this.config);
    return this.config.chat_hud_display_id;
  }

  setChatHudConfig(patch = {}) {
    const cur = this.config.chatHud;
    const clampNum = (v, min, max, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    const next = {
      width: clampNum(patch.width, 240, 1200, cur.width),
      height: clampNum(patch.height, 160, 2000, cur.height),
      x: patch.x == null || patch.x === "" ? null : Number(patch.x),
      y: patch.y == null || patch.y === "" ? null : Number(patch.y),
      opacity: clampNum(patch.opacity, 0, 100, cur.opacity),
      fontSize: clampNum(patch.fontSize, 10, 48, cur.fontSize),
    };
    if (!Number.isFinite(next.x)) next.x = null;
    if (!Number.isFinite(next.y)) next.y = null;
    this.config.chatHud = next;
    saveConfig(this.config);
    return next;
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
    if (patch.splashFile !== undefined) scene.splashFile = String(patch.splashFile || "").slice(0, 200);
    if (patch.splashDuration !== undefined) scene.splashDuration = Math.max(0, Math.min(30, Math.round(Number(patch.splashDuration) || 0)));
    if (typeof patch.splashEnabled === "boolean") scene.splashEnabled = patch.splashEnabled;
    if (patch.backgroundFile !== undefined) scene.backgroundFile = String(patch.backgroundFile || "").slice(0, 200);
    if (Array.isArray(patch.socials)) {
      scene.socials = patch.socials
        .slice(0, 6)
        .map((s) => ({ platform: String(s.platform || "").slice(0, 4), text: String(s.text || "").slice(0, 60) }));
    }
    saveConfig(this.config);
    return scene;
  }

  setSplashConfig(patch = {}) {
    const splash = this.config.splash || { file: "", duration: 4 };
    if (patch.file !== undefined) splash.file = String(patch.file || "").trim();
    if (patch.duration !== undefined) splash.duration = Math.max(0, Math.min(30, Math.round(Number(patch.duration) || 0)));
    this.config.splash = splash;
    saveConfig(this.config);
    return this.config.splash;
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
      notificationSound: typeof newConfig.notificationSound === "boolean" ? newConfig.notificationSound : this.config.notificationSound,
      notificationVolume: typeof newConfig.notificationVolume === "number" ? newConfig.notificationVolume : this.config.notificationVolume,
      notificationRepeats: typeof newConfig.notificationRepeats === "number" ? newConfig.notificationRepeats : this.config.notificationRepeats,
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
      donationVoice: { ...this.config.donationVoice, ...(newConfig.donationVoice || {}) },
      appearance: {
        ...defaultAppearance(),
        ...this.config.appearance,
        ...(newConfig.appearance || {}),
        customThemes: keepArr(newConfig.appearance && newConfig.appearance.customThemes, this.config.appearance.customThemes),
      },
      editor: { ...defaultEditor(), ...this.config.editor, ...(newConfig.editor || {}) },
      poll: {
        ...this.config.poll,
        ...(newConfig.poll || {}),
        options: keepArr(newConfig.poll && newConfig.poll.options, this.config.poll.options),
      },
      chatBot: {
        ...this.config.chatBot,
        ...(newConfig.chatBot || {}),
        commands: keepArr(newConfig.chatBot && newConfig.chatBot.commands, this.config.chatBot.commands),
        timers: keepArr(newConfig.chatBot && newConfig.chatBot.timers, this.config.chatBot.timers),
        moderation: normalizeChatBotModeration({
          ...this.config.chatBot.moderation,
          ...((newConfig.chatBot && newConfig.chatBot.moderation) || {}),
        }),
      },
      twitchRewards: keepArr(newConfig.twitchRewards, this.config.twitchRewards),
      scenes: newConfig.scenes ? { ...defaultScenes(), ...newConfig.scenes } : this.config.scenes,
      topDonation: newConfig.topDonation || this.config.topDonation,
      tts: { ...this.config.tts, ...(newConfig.tts || {}) },
      splash: { ...this.config.splash, ...(newConfig.splash || {}) },
      chatHud: { ...this.config.chatHud, ...(newConfig.chatHud || {}) },
      hud_edit_hotkey: this.config.hud_edit_hotkey,
      hud_display_id: this.config.hud_display_id,
      chat_hud_hotkey: this.config.chat_hud_hotkey,
      chat_hud_display_id: this.config.chat_hud_display_id,
      // Код доступа не переносится вместе с чужим конфигом: остаётся свой.
      remote_token: this.config.remote_token,
      // Правила очереди переносим, а срок паузы — нет: чужая пауза не должна
      // заглушить алерты на чужом импорте.
      alert_queue: { ...(newConfig.alert_queue || this.config.alert_queue), pause_until: 0 },
    };

    this._migrateAppearance();

    if (Array.isArray(newConfig.layout)) this._layout = newConfig.layout;
    if (this.db) {
      this.db.saveWidgets(this._layout);
    } else {
      this.config.layout = this._layout;
    }
    saveConfig(this.config);
  }

  // ---- Восстановление из резервных копий ----

  listConfigBackups() {
    return describeBackups(getConfigPath(), DEFAULT_BACKUP_SLOTS);
  }

  /*
    Откат настроек к бэкапу. В бэкапе секреты лежат зашифрованными (как и в самом
    config.json), поэтому значение проходит через decryptConfig — без этого
    зашифрованная строка сохранилась бы как обычное значение и на следующей
    записи зашифровалась бы второй раз.

    Возвращаем только разобранный конфиг: применяет его вызывающий код
    (replaceConfig + перезапуск интеграций), чтобы не получилось «новые
    настройки при старых подключениях».
  */
  restoreConfigFromBackup(slot) {
    const attempt = tryReadJson(backupPath(getConfigPath(), slot));
    if (!attempt.ok) {
      return { ok: false, error: (attempt.error && attempt.error.message) || "резервная копия недоступна" };
    }
    return { ok: true, slot: Number(slot), config: decryptConfig(attempt.value) };
  }

  // Перечитать раскладку из БД: нужно после отката БД к бэкапу, иначе в памяти
  // останется старая раскладка и следующее сохранение затрёт восстановленную.
  reloadFromDb() {
    if (!this.db) return this._layout;
    this._layout = this._loadLayoutFromDb();
    return this._layout;
  }

  // ---- Доступ из сети ----

  remoteToken() {
    return this.config.remote_token || "";
  }

  // Проверка предъявленного кода (query или заголовок).
  checkRemoteToken(given) {
    return tokensMatch(this.remoteToken(), given);
  }

  /*
    Новый код доступа. Нужен, если адрес пульта ушёл не туда (показали в чате,
    на скриншоте, отдали гостю): старый перестаёт работать, и подключённые из
    сети устройства отваливаются при следующем переподключении.

    Сброс на диск синхронный: старая копия не должна пережить падение процесса —
    иначе отозванный код снова начнёт пускать в порт.
  */
  rotateRemoteToken() {
    this.config.remote_token = generateRemoteToken();
    saveConfig(this.config);
    flushConfigSync();
    return this.config.remote_token;
  }

  snapshot() {
    // A built-in 3D variant, when enabled, overrides the base theme for the
    // whole overlay (its tokens win) and enables that variant's widgets. A
    // custom base theme keeps its own palette and exposes an explicit list of
    // enabled 3D widgets via `appearance.active3dWidgets`.
    const theme2d = this.resolvedTheme();
    const theme3d = this.resolvedTheme3d();
    const isCustomBase = !!(theme2d && !theme2d.builtin);
    const enabled3d = this.config.appearance.enabled3d || {};
    const active3dWidgets = this._active3dWidgets(theme2d, theme3d, isCustomBase, enabled3d);
    const has3dSet = isCustomBase
      ? Array.isArray(theme2d.threeDWidgets) && theme2d.threeDWidgets.length > 0
      : !!(theme2d && theme2d.variant3d);
    const effective = theme3d && theme2d && theme2d.builtin ? theme3d : theme2d;
    return {
      layout: this._layout,
      layoutPresets: this.listLayoutPresets(),
      goal: this.config.goal,
      port: this.config.port,
      notificationSound: this.config.notificationSound,
      notificationVolume: this.config.notificationVolume,
      notificationRepeats: this.config.notificationRepeats,
      twitchChannel: this.config.twitch.channel,
      twitchClientId: this.config.twitch.clientId,
      donationAlertsClientId: this.config.donationAlerts.clientId,
      /*
        Состояние подключения DonationAlerts без секретов.

        Панель по нему показывает, есть ли токен, можно ли его обновить и до
        какого срока он действителен: без этого «донаты не приходят» приходится
        диагностировать по логам, а самый частый ответ — «сервис подключён,
        но токен просрочен и обновлять его нечем».

        expiresAt = 0 означает «срок неизвестен» (DonationAlerts не всегда его
        отдаёт) — в этом случае токен обновляется по refresh_token при обращении.
      */
      donationAlertsAuth: {
        connected: !!this.config.donationAlerts.accessToken,
        refreshable: !!this.config.donationAlerts.refreshToken,
        userId: this.config.donationAlerts.userId || "",
        expiresAt: Number(this.config.donationAlerts.expiresAt) || 0,
        /*
          Ключи приложения — только факты о секрете, без самого секрета.

          Без заполненного Client Secret обмен кода на токен заведомо провалится,
          и сервис ответит невнятным invalid_client: по ответу невозможно понять,
          что дело в пустом поле. Панель должна видеть это сама, не доводя до
          неудачной попытки.

          Пустой секрет и секрет, который не удалось прочитать (недоступно
          системное хранилище, конфиг перенесён с другой машины — см.
          server/secret-store.js), для сервиса равнозначны, а для пользователя
          нет: во втором случае ключ надо вставить заново, а не просто заполнить.
        */
        hasClientSecret: !!String(this.config.donationAlerts.clientSecret || "").trim(),
        clientSecretUnreadable: isSecretUnreadable(SECRET_LABELS.donationAlertsClientSecret),
      },
      youtubeClientId: this.config.youtube.clientId,
      youtubeVideoId: this.config.youtube.videoId,
      twitchEnabled: this.config.twitch.enabled,
      donationAlertsEnabled: this.config.donationAlerts.enabled,
      youtubeEnabled: this.config.youtube.enabled,
      obs: this.config.obs,
      soundboard: this.config.soundboard,
      tts: this.config.tts,
      donationVoice: this.config.donationVoice,
      streamdeck: this.config.streamdeck,
      connectionStatus: this.runtime.connectionStatus,
      longshot: this.runtime.longshot,
      recentEvents: this.runtime.recentEvents,
      stats: this.runtime.stats,
      // Счёт текущего стрима (см. addDonationToSession).
      sessionDonations: this.sessionDonations(),
      deathCount: this.runtime.deathCount,
      activeScene: this.runtime.activeScene,
      sceneStartedAt: this.runtime.sceneStartedAt,
      activeCameraAngle: this.runtime.activeCameraAngle,
      activeFilters: this.getActiveFilters(),
      giveaway: this.giveawaySnapshot(),
      poll: this.pollSnapshot(),
      pollPresets: this.listPollPresets(),
      chatBot: this.config.chatBot,
      twitchRewards: this.config.twitchRewards,
      appearance: {
        activeThemeId: this.config.appearance.activeThemeId,
        activeThemeId3d: theme3d ? theme3d.id : "",
        active3dWidgets,
        enable3d: !!this.config.appearance.enable3d && has3dSet,
        enabled3d,
        tokens: effective.tokens,
        customCss: (theme2d && theme2d.customCss) || "",
        themes: this.listThemes(),
      },
      editor: this.config.editor,
      hud_edit_hotkey: this.config.hud_edit_hotkey,
      hud_display_id: this.config.hud_display_id,
      chat_hud_hotkey: this.config.chat_hud_hotkey,
      chat_hud_display_id: this.config.chat_hud_display_id,
      chatHud: this.config.chatHud,
      scenes: this.config.scenes,
      splash: this.config.splash,
      topDonation: this.config.topDonation,
    };
  }

  // Синхронно сбрасывает отложенную запись config.json (вызывается при выходе).
  flushConfigSync() {
    return flushConfigSync();
  }
}

module.exports = { AppState, saveConfig, fisherYates, flushConfigSync };
