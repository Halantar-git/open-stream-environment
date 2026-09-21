/*
  Copyright (C) 2026  Halantar

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://gnu.org>.
*/

/*
  Отчёт для поддержки: один текстовый файл, по которому можно разобрать
  «что-то не работает» без переписки на десять сообщений.

  Что попадает внутрь: окружение (версия, платформа, Electron/Node), отчёт
  о состоянии (health), телеметрия записи на диск, следы восстановлений и
  карантина, список файлов данных с размерами, отчёты о падениях, сводка
  настроек БЕЗ секретов и хвост сегодняшнего лога.

  Чего внутри нет и не должно быть: токенов, client secret, паролей. Работает
  это в два слоя:

    1. Сводка настроек собирается по явному списку полей — сырой config.json в
       отчёт не попадает никогда; вместо значений секретов стоят только пометки
       «поле заполнено/пусто».
    2. Прогон `sanitize()` по готовому отчёту: ключи вида `*secret*`, `*token*`,
       `*password*` превращаются в «<скрыто>», а в тексте маскируются значения
       `enc:…`, `?token=…`, `Bearer …` и домашний каталог пользователя (путь
       выдаёт имя в системе).

  Отчёт отдаётся пользователю файлом (диалог сохранения) и доступен только
  локально по HTTP — см. GET /support-bundle в server/index.js.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const BOM = "\uFEFF";

// Ключи, содержимое которых в отчёт не идёт в принципе.
const SECRET_KEY = /(secret|token|password|passwd|apikey|api[_-]?key|authorization|credential|cookie)/i;

// Маскировка в тексте: зашифрованные значения, токены в URL/заголовках.
const SECRET_TEXT = [
  [/enc:[A-Za-z0-9+/=]+/g, "enc:<скрыто>"],
  [/([?&](?:access_token|refresh_token|token|client_secret|api_key|code)=)[^&\s"']+/gi, "$1<скрыто>"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<скрыто>"],
];

function maskHome(text) {
  let out = String(text);
  const homes = new Set();
  try {
    if (os.homedir()) {
      homes.add(os.homedir());
      homes.add(os.homedir().split(path.sep).join("/"));
    }
  } catch (_) {
    /* нет домашнего каталога — маскировать нечего */
  }
  homes.forEach((home) => {
    if (home) out = out.split(home).join("~");
  });
  return out;
}

function maskText(text) {
  let out = String(text);
  SECRET_TEXT.forEach(([pattern, replacement]) => {
    out = out.replace(pattern, replacement);
  });
  return maskHome(out);
}

// Рекурсивная чистка готового отчёта: второй слой защиты после сборки по списку.
function sanitize(value, depth = 0) {
  if (depth > 12) return "<слишком глубоко>";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return maskText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, depth + 1));
  if (typeof value !== "object") return maskText(String(value));
  const out = {};
  Object.keys(value).forEach((key) => {
    if (SECRET_KEY.test(key)) out[key] = "<скрыто>";
    else out[key] = sanitize(value[key], depth + 1);
  });
  return out;
}

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

// Код доступа в отчёт не идёт — только признак «он есть и нужной длины».
function normalizeAccessCode(value) {
  const token = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : "";
}

/*
  Сводка настроек по явному списку полей. Значения секретов заменяются на
  пометку о том, что поле заполнено, — по ней видно «токен есть, но не работает»
  и при этом ничего не утекает.
*/
function summarizeConfig(config) {
  const c = config || {};
  const twitch = c.twitch || {};
  const donationAlerts = c.donationAlerts || {};
  const youtube = c.youtube || {};
  const obs = c.obs || {};
  const appearance = c.appearance || {};
  const chatBot = c.chatBot || {};
  const filled = [];
  if (twitch.clientSecret) filled.push("twitch.clientSecret");
  if (twitch.userAccessToken) filled.push("twitch.userAccessToken");
  if (twitch.refreshToken) filled.push("twitch.refreshToken");
  if (donationAlerts.clientSecret) filled.push("donationAlerts.clientSecret");
  if (donationAlerts.accessToken) filled.push("donationAlerts.accessToken");
  if (youtube.clientSecret) filled.push("youtube.clientSecret");
  if (youtube.accessToken) filled.push("youtube.accessToken");
  if (obs.password) filled.push("obs.password");

  return {
    language: c.language ?? null,
    port: c.port ?? null,
    notifications: {
      sound: c.notificationSound !== false,
      volume: c.notificationVolume ?? null,
      repeats: c.notificationRepeats ?? null,
    },
    enabled: {
      twitch: twitch.enabled !== false,
      donationAlerts: donationAlerts.enabled !== false,
      youtube: youtube.enabled !== false,
      obs: !!obs.enabled,
    },
    twitch: { channel: twitch.channel || "", hasClientId: !!twitch.clientId, hasBroadcasterId: !!twitch.broadcasterId },
    donationAlerts: { hasClientId: !!donationAlerts.clientId, hasUserId: !!donationAlerts.userId },
    youtube: { hasClientId: !!youtube.clientId, videoId: youtube.videoId || "" },
    obs: {
      host: obs.host || "",
      port: obs.port ?? null,
      sceneMapKeys: Object.keys(obs.sceneMap || {}),
      customCommands: count(obs.customCommands),
      cameraAngles: count(obs.cameraAngles),
      cameraFilters: count(obs.cameraFilters),
    },
    goal: { hasTitle: !!c.goal?.title, target: c.goal?.target ?? null, currency: c.goal?.currency ?? null },
    soundboard: { enabled: !!(c.soundboard && c.soundboard.enabled), volume: c.soundboard?.volume ?? null, sounds: count(c.soundboard?.sounds) },
    streamdeck: { icons: Object.keys(c.streamdeck?.icons || {}) },
    tts: { enabled: !!c.tts?.enabled, volume: c.tts?.volume ?? null, lang: c.tts?.lang ?? null, hasVoice: !!c.tts?.voice },
    donationVoice: { enabled: !!c.donationVoice?.enabled },
    poll: { command: c.poll?.command || "", chartType: c.poll?.chartType || "", options: count(c.poll?.options) },
    chatBot: {
      enabled: !!chatBot.enabled,
      prefix: chatBot.prefix || "",
      commands: count(chatBot.commands),
      timers: count(chatBot.timers),
      moderation: !!chatBot.moderation?.enabled,
    },
    appearance: {
      activeThemeId: appearance.activeThemeId || null,
      themes: count(appearance.customThemes),
      themeNames: (appearance.customThemes || []).map((theme) => (theme && theme.name ? String(theme.name) : "")).filter(Boolean),
      enable3d: !!appearance.enable3d,
    },
    editor: { gridSize: c.editor?.gridSize ?? null, snapEnabled: c.editor?.snapEnabled ?? null, aspectRatio: c.editor?.aspectRatio ?? null },
    scenes: { count: Object.keys(c.scenes || {}).length },
    hud: {
      editHotkey: c.hud_edit_hotkey || "",
      chatHotkey: c.chat_hud_hotkey || "",
      /*
        Флага «чат поверх игры включён» в конфиге нет: окно чата создаёт main.js,
        а показывает/скрывает его глобальный хоткей, — в настройках остаётся только
        выбранный монитор (null — основной). Раньше здесь читался несуществующий
        chatHud.enabled, поэтому в отчёте всегда стояло false.
      */
      chatHudDisplay: c.chat_hud_display_id ?? null,
      chatHud: c.chatHud ? { width: c.chatHud.width, height: c.chatHud.height, opacity: c.chatHud.opacity, fontSize: c.chatHud.fontSize } : null,
    },
    twitchRewards: count(c.twitchRewards),
    // Пометка вместо самого кода: по ней видно, что доступ из сети настроен.
    remote: { accessCodeSet: !!normalizeAccessCode(c.remote_token) },
    splash: { hasFile: !!c.splash?.file, duration: c.splash?.duration ?? null },
    topDonation: { hasUser: !!c.topDonation?.user, amount: c.topDonation?.amount ?? null, currency: c.topDonation?.currency ?? null },
    filledFields: filled,
  };
}

// Сводка раскладки: сколько виджетов и каких типов, без координат и содержимого.
function summarizeLayout(layout) {
  const widgets = Array.isArray(layout) ? layout : [];
  const byType = {};
  widgets.forEach((widget) => {
    const type = widget && widget.type ? String(widget.type) : "unknown";
    byType[type] = (byType[type] || 0) + 1;
  });
  return { widgets: widgets.length, byType, hidden: widgets.filter((widget) => widget && widget.visible === false).length };
}

function listFiles(dir) {
  if (!dir) return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  return names
    .map((name) => {
      try {
        const stat = fs.statSync(path.join(dir, name));
        if (!stat.isFile()) return null;
        return { name, bytes: stat.size, mtime: stat.mtime.toISOString() };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function tailFile(file, maxLines = 300) {
  if (!file) return { file: null, error: "нет файла" };
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const tail = lines.slice(-maxLines);
    return { file, totalLines: lines.length, truncated: lines.length > maxLines, text: tail.join("\n") };
  } catch (err) {
    return { file, error: err && err.code === "ENOENT" ? "нет файла" : String((err && err.message) || err) };
  }
}

function dayStamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Собирает отчёт целиком. Ввод-вывод минимальный: каталоги данных и логов,
// хвост сегодняшнего лога, содержимое свежего отчёта о падении.
function buildSupportBundle(ctx = {}) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const configDir = ctx.configDir || null;
  const logsDir = ctx.logsDir || null;

  const dataFiles = listFiles(configDir);
  const logsFiles = listFiles(logsDir);
  const entry = (file) => ({ name: file.name, bytes: file.bytes, mtime: file.mtime });

  const crashReports = logsFiles.filter((file) => /^crash-.*\.log$/.test(file.name));
  const newestCrash = crashReports[crashReports.length - 1];

  const bundle = {
    generatedAt: now.toISOString(),
    environment: {
      app: ctx.appName || "Open Stream Environment",
      version: ctx.version || null,
      mode: process.versions.electron ? "electron" : "node (server:only)",
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      electron: process.versions.electron || null,
      chromium: process.versions.chrome || null,
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      pid: process.pid,
      dataDir: configDir,
      logsDir,
      remoteUrl: ctx.remoteUrl || null,
    },
    health: ctx.health || null,
    writes: ctx.writes || null,
    // Последние команды: видно, кто и что переключал (см. audit-log.js).
    audit: Array.isArray(ctx.audit) ? ctx.audit : [],
    // Полная история образцов (память/клиенты/переподключения по времени) —
    // именно она отличает «течёт» от «показалось».
    longrun: ctx.longrun || null,
    integrity: {
      recoveryEvents: Array.isArray(ctx.recoveryEvents) ? ctx.recoveryEvents : [],
      backups: dataFiles.filter((file) => /\.bak\.\d+$/.test(file.name)).map(entry),
      quarantined: dataFiles.filter((file) => /\.corrupt-/.test(file.name)).map(entry),
    },
    crashReports: crashReports.map(entry),
    newestCrashReport: newestCrash ? tailFile(path.join(logsDir, newestCrash.name), 200) : null,
    dataFiles: dataFiles.map(entry),
    logFiles: logsFiles.map(entry),
    config: summarizeConfig(ctx.config),
    layout: summarizeLayout(ctx.layout),
    log: tailFile(logsDir ? path.join(logsDir, `ose-${dayStamp(now)}.log`) : null, ctx.logLines || 300),
  };

  return sanitize(bundle);
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

// Для полей, которые живут в одной строке отчёта: переводы строк там мешают читать.
function inlineJson(value) {
  return JSON.stringify(value);
}

// Строка «Подпись:   значение» — подписи выровнены, чтобы отчёт читался глазом.
function field(label, value, width = 15) {
  return `  ${`${label}:`.padEnd(width, " ")}${value}`;
}

function bullets(list) {
  return list.length ? list.map((line) => `  - ${line}`).join("\n") : "  нет";
}

// Человекочитаемый текст: отчёт читают глазами в блокноте, а не парсером.
function renderSupportBundle(bundle) {
  const env = bundle.environment;
  const health = bundle.health || {};
  const lines = [];

  lines.push(`${BOM}${env.app} — отчёт для поддержки`);
  lines.push(`Создан: ${bundle.generatedAt}`);
  lines.push("");

  lines.push("== Приложение ==");
  lines.push(field("Версия", env.version || "—"));
  lines.push(field("Режим", env.mode));
  lines.push(field("Платформа", env.platform));
  lines.push(field("Node", `${env.node}${env.electron ? `, Electron ${env.electron}` : ""}`));
  lines.push(field("Память", `${env.memoryMb} MB (rss), pid ${env.pid}`));
  lines.push(field("Каталог данных", env.dataDir || "—", 16));
  lines.push(field("Каталог логов", env.logsDir || "—", 16));
  lines.push(field("Web Remote", env.remoteUrl || "—"));
  lines.push("");

  lines.push("== Состояние ==");
  lines.push(field("Работает", health.ok ? "да" : "нет"));
  lines.push(field("Аптайм", `${health.uptimeSec ?? "—"} с`));
  lines.push(field("Порт", health.port ?? "—"));
  lines.push(field("Клиенты WS", `${health.server ? health.server.clients : "—"} ${health.server ? inlineJson(health.server.byRole) : ""}`));
  lines.push("  Проблемы:");
  lines.push(bullets((health.problems || []).length ? health.problems : []));
  lines.push("");
  lines.push(field("Интеграции", inlineJson(health.integrations || {})));
  lines.push(field("Сессия", health.session ? inlineJson(health.session) : "—"));
  lines.push(field("Лаг loop", health.perf ? inlineJson(health.perf) : "—"));
  lines.push("");

  lines.push("== Хранилище ==");
  lines.push(json({ storage: health.storage, writes: bundle.writes }));
  lines.push("");

  lines.push("== Долгий прогон ==");
  if (bundle.longrun) {
    const run = bundle.longrun;
    lines.push(field("Наработка", `${(run.uptimeSec / 3600).toFixed(1)} ч`));
    lines.push(field("Память", `rss ${run.rssMb} MB (пик ${run.peakRssMb}), heap ${run.heapUsedMb} MB`));
    lines.push(field("Рост памяти", `${run.growthMbPerHour} MB/ч по ${run.samples} образцам`));
    lines.push(field("Переподключения", `${run.reconnectsTotal} ${inlineJson(run.reconnects || {})}`));
    lines.push(field("Образцы", `каждые ${Math.round((bundle.longrun.everyMs || 0) / 60000) || "—"} мин`));
    if (Array.isArray(run.history) && run.history.length) {
      lines.push("  время, наработка ч, rss MB, heap MB, WS, переподключения, лаг");
      run.history.forEach((entry) => {
        const total = Object.values(entry.reconnects || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
        lines.push(
          `  ${new Date(entry.at).toISOString()}, ${(entry.uptimeSec / 3600).toFixed(2)}, ` +
            `${entry.rssMb}, ${entry.heapUsedMb}, ${entry.wsClients}, ${total}, ${entry.lagMaxMs}`
        );
      });
    }
  } else {
    lines.push("  нет данных");
  }
  lines.push("");

  lines.push("== Целостность ==");
  lines.push(`  Восстановления за запуск: ${(bundle.integrity.recoveryEvents || []).length}`);
  (bundle.integrity.recoveryEvents || []).forEach((event) => {
    lines.push(`   * ${event.kind}: ${event.file} (${event.reason})`);
  });
  lines.push(`  Бэкапы:      ${bundle.integrity.backups.map((f) => f.name).join(", ") || "нет"}`);
  lines.push(`  Карантин:    ${bundle.integrity.quarantined.map((f) => f.name).join(", ") || "нет"}`);
  lines.push("");

  lines.push("== Отчёты о падениях ==");
  lines.push(bullets(bundle.crashReports.map((f) => `${f.name} (${f.bytes} Б, ${f.mtime})`)));
  if (bundle.newestCrashReport && bundle.newestCrashReport.text) {
    lines.push("  --- свежий отчёт ---");
    lines.push(bundle.newestCrashReport.text);
  }
  lines.push("");

  lines.push("== Файлы данных ==");
  lines.push(bullets(bundle.dataFiles.map((f) => `${f.name} — ${f.bytes} Б, ${f.mtime}`)));
  lines.push("");

  lines.push(`== Журнал команд (последние ${(bundle.audit || []).length}) ==`);
  if ((bundle.audit || []).length) {
    lines.push("  время, откуда, роль, команда, детали, ограничено");
    bundle.audit.forEach((entry) => {
      lines.push(
        `  ${new Date(entry.at).toISOString()}, ${entry.external ? "сеть" : "локально"}, ${entry.role}, ` +
          `${entry.type}, ${entry.details ? inlineJson(entry.details) : "—"}${entry.limited ? ", да" : ""}`
      );
    });
  } else {
    lines.push("  пока пусто");
  }
  lines.push("");

  lines.push("== Настройки (без секретов) ==");
  lines.push(json(bundle.config));
  lines.push("");
  lines.push("== Раскладка ==");
  lines.push(json(bundle.layout));
  lines.push("");

  lines.push(`== Лог (последние ${bundle.log ? bundle.log.totalLines : 0} строк, показано ${bundle.log && bundle.log.text ? bundle.log.text.split("\n").length : 0}) ==`);
  lines.push(bundle.log && bundle.log.text ? bundle.log.text : `  ${(bundle.log && bundle.log.error) || "нет данных"}`);
  lines.push("");

  return lines.join("\n");
}

module.exports = {
  buildSupportBundle,
  renderSupportBundle,
  summarizeConfig,
  summarizeLayout,
  sanitize,
  maskText,
  listFiles,
  tailFile,
};
