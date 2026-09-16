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

/*
  Ставим первым делом: фильтр глушит единственное чужое предупреждение
  (punycode, DEP0040 — см. server/deprecation-filter.js) и должен успеть до
  того, как его породит код Electron. В Electron-режиме его уже поставил main.js,
  поэтому вызов идемпотентен; здесь он нужен для `npm run server:only`.
*/
const { installDeprecationFilter } = require("./deprecation-filter");
installDeprecationFilter();

const { AppState } = require("./state");
const { getUserMediaDir, getLogsDir, getConfigDir } = require("./storage-paths");
const { EVENT_TYPES, ALERT_DURATIONS_MS } = require("../shared/events");
const MicFrame = require("../shared/mic-frame");
const { buildHealthReport } = require("./health");
const { createLongRunMonitor } = require("./longrun-monitor");
const { createAuditLog, summarizePayload } = require("./audit-log");
const { isLoopbackRequest, checkUpgrade, createCommandLimiter } = require("./access-control");
const { buildSupportBundle, renderSupportBundle } = require("./support-bundle");
const { getRecoveryEvents } = require("./data-integrity");

// Версия нужна в отчётах (/healthz и отчёт для поддержки). В Electron её
// передаёт main.js из app.getVersion(); в режиме server:only берём из package.json.
let pkgVersion = null;
try {
  pkgVersion = require("../package.json").version || null;
} catch (_) {
  /* package.json рядом нет — версию просто не покажем */
}

// Роль WebSocket-клиента берётся из query строки подключения (?role=overlay).
// Нужна, чтобы высокочастотные микрокадры не рассылались панели управления,
// чату, remote и редакторам — они их всё равно игнорируют.
const MIC_FRAME_ROLES = new Set(["overlay"]);

function roleFromUrl(url, fallback = "other") {
  const query = String(url || "").split("?")[1] || "";
  const role = new URLSearchParams(query).get("role");
  return role ? String(role) : fallback;
}
const { createAlertQueue } = require("./alert-queue");
const { createLogger, enableFileLogging } = require("./logger");
const { installCrashHandlers } = require("./crash-guard");
const { mountOAuthRoutes, buildTwitchAuthorizeUrl, buildDonationAlertsAuthorizeUrl, buildYoutubeAuthorizeUrl } = require("./oauth");
const { startTwitchChat, sendTwitchChatMessage } = require("./integrations/twitch-chat");
const { startChatBot } = require("./integrations/chat-bot");
const { startTwitchEvents } = require("./integrations/twitch-eventsub");
const { triggerRewardActions } = require("./integrations/twitch-eventsub");
const { createTwitchClip, createStreamMarker } = require("./integrations/twitch-helix");
const { startDonationAlerts, fetchRecentDonations } = require("./integrations/donationalerts");
const { startYoutube } = require("./integrations/youtube-live");
const { startObsWebSocket } = require("./integrations/obs-websocket");
const { createCliHandler } = require("./cli");
const { createLongshotSync } = require("./longshot-sync");
const { createEventLoopMonitor } = require("./perf-monitor");
const I18n = require("../shared/i18n");

const LOCALES = {
  ru: require("../shared/locales/ru.json"),
  en: require("../shared/locales/en.json"),
};

I18n.setLocales(LOCALES);

const bus = new EventEmitter();

function isPrivateIPv4(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function getLocalIp() {
  // Interface names that are virtual/software adapters, not the physical LAN
  // (VPN, Hyper-V/WSL, VirtualBox/VMware, Docker, TAP/TUN, Tailscale/ZeroTier,
  // Hamachi/Radmin, bridges). These are skipped so the remote URL points at the
  // real local-network address.
  const VIRTUAL = /virtual|vmware|vbox|veth|docker|wsl|hyper|vethernet|tap|tun|vpn|zerotier|tailscale|hamachi|radmin|loopback|bridge|br-/i;
  const PHYSICAL = /(^|[\s_-])(eth|en|wlan|wi-?fi|wireless|ethernet|local area|realtek|intel|enp|wlp)/i;

  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const iface of interfaces[name] || []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      const ip = iface.address;
      let score = 0;
      if (PHYSICAL.test(name)) score += 2;
      if (isPrivateIPv4(ip)) score += 3;
      if (/^169\.254\./.test(ip)) score -= 2; // link-local (APIPA) — not routable
      candidates.push({ address: ip, score });
    }
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].address;
  }

  // Last resort: any non-internal IPv4.
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

// Mic frames are ~371 bytes and JSON commands are small, so a 256 KB cap is
// generous. The ws default (~100 MB) would let one client exhaust memory.
const WS_MAX_PAYLOAD = 256 * 1024;

function isLoopbackOrPrivateHost(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  if (/^127\./.test(h)) return true;
  if (/\.local$/i.test(h)) return true;
  // Single-label names (NetBIOS/computer name), e.g. DESKTOP-ABC:8710.
  if (!h.includes(".") && !h.includes(":")) return true;
  return isPrivateIPv4(h);
}

// Browsers exempt WebSockets from the same-origin policy, so without this a
// page the streamer happens to have open could drive the local bus. Allow only
// same-machine/LAN origins; requests with no Origin header come from
// non-browser clients (Stream Deck plugin, tests) and stay allowed.
function isAllowedWsOrigin(req, port) {
  const origin = req && req.headers && req.headers.origin;
  if (!origin) return true;
  // Electron windows are loaded from file:// (opaque origin).
  if (origin === "file://" || origin === "null") return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.port !== String(port)) return false;
  return isLoopbackOrPrivateHost(parsed.hostname);
}

function createServer({ db, onSetHudHotkey, onSetChatHudHotkey, appName, version } = {}) {
  enableFileLogging(getLogsDir());
  const serverLog = createLogger(bus, "server");
  /*
    Отдельный логер для DonationAlerts.

    Те же строки уходят и в общий терминал (там они подписаны сервисом), но
    панель DonationAlerts копит только их — поэтому действия из неё самой
    (переподключение, подтягивание пропущенных) видно рядом с ответами сервиса,
    а не в общем потоке.
  */
  const donationsLog = createLogger(bus, "donationalerts");
  // Телеметрия: пик лага event loop за интервал — чтобы «почему отстал чат»
  // можно было подтвердить строкой в логе, а не догадками. Молчит, пока лаг
  // ниже порога (см. perf-monitor.js).
  const perfMonitor = createEventLoopMonitor();
  const state = new AppState(db);
  const app = express();
  // No upside to advertising the framework on a local overlay server.
  app.disable("x-powered-by");
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  /*
    Доступ: панель, оверлей в OBS, HUD и редакторы живут на этой же машине и
    ничего не спрашивают. Всё, что приходит из локальной сети (телефон, чужие
    скрипты), обязано предъявить код доступа: порт слушает все интерфейсы, и без
    такого разделения любой в той же Wi-Fi-сети мог бы переключать сцены.
    Правила и сравнение живут в access-control.js — там же их тесты.
  */

  // Отказы считаем отдельно от журнала команд: по этому числу видно,
  // стучится ли кто-то в порт без кода.
  const accessCounters = { deniedUpgrade: 0, deniedHttp: 0, rateLimited: 0 };

  /*
    Журнал команд: кольцевой буфер на 200 записей и запись в файловый лог —
    только для действий из сети и срабатываний ограничителя, чтобы лог не
    утонул в командах панели (см. audit-log.js).
  */
  const audit = createAuditLog({
    limit: 200,
    onEntry: (entry) => {
      if (!entry.external && !entry.limited) return;
      serverLog.warn(entry.limited ? "command rate limited" : "command from network", {
        type: entry.type,
        role: entry.role,
        details: entry.details,
      });
    },
  });

  // Ограничитель частоты на клиента: защита от самодеятельных скриптов и
  // зациклившегося пульта. Нормальный темп команд панели — единицы в секунду,
  // поэтому лимит с запасом, но не бесконечный.
  const commandLimiter = createCommandLimiter({ windowMs: 1000, max: 60 });

  function allowCommand(socket) {
    if (commandLimiter.allow(socket)) return true;
    accessCounters.rateLimited += 1;
    const now = Date.now();
    if (!socket._oseRateWarnedAt || now - socket._oseRateWarnedAt >= 5000) {
      socket._oseRateWarnedAt = now;
      serverLog.warn("command rate limit reached", { role: socket.role || "other", limit: commandLimiter.max });
    }
    return false;
  }

  server.on("upgrade", (req, socket, head) => {
    const pathname = String(req.url || "").split("?")[0] || "/";
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Источник (защита от чужой страницы в браузере) и код (защита от чужого
    // устройства в сети) проверяются вместе — решение принимает access-control.
    const decision = checkUpgrade(req, {
      port: state.config.port || 8710,
      isAllowedOrigin: isAllowedWsOrigin,
      matchesToken: (given) => state.checkRemoteToken(given),
    });
    if (!decision.ok) {
      accessCounters.deniedUpgrade += 1;
      serverLog.warn("rejected websocket upgrade", {
        reason: decision.reason,
        origin: (req.headers && req.headers.origin) || null,
        role: roleFromUrl(req.url, "other"),
        path: pathname,
      });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  app.use(express.static(path.join(__dirname, "..", "overlay"), { redirect: false }));
  app.use("/overlay", express.static(path.join(__dirname, "..", "overlay")));
  app.use("/shared", express.static(path.join(__dirname, "..", "shared")));
  app.use("/assets", express.static(path.join(__dirname, "..", "assets")));
  app.use("/media", express.static(getUserMediaDir()));
  app.use("/remote", express.static(path.join(__dirname, "..", "remote")));

  /*
    Диагностика.

    /healthz — короткий JSON о том, что происходит: жив ли сервер, сколько
    клиентов подключено, статусы интеграций, размеры хранилища, телеметрия
    записи, лаг event loop и список проблем. Путей и секретов в нём нет, поэтому
    отдаём всем, кто достучался до порта — на это удобно смотреть мониторингом
    и отвечать на вопрос «сервер точно работает?».

    /support-bundle — полный отчёт для поддержки: хвост лога, список файлов
    данных, сводка настроек без секретов (см. support-bundle.js). Он содержит
    пути и много деталей, поэтому отдаётся ТОЛЬКО локальным запросам: из
    локальной сети его не скачать.
  */
  const startedAt = Date.now();

  // След по времени — для «стрим шёл 6 часов, память выросла на 400 МБ» и
  // «чат переподключался 30 раз». Раз в 10 минут снимается образец, в лог
  // попадает только то, что заслуживает внимания (см. longrun-monitor.js).
  const longRun = createLongRunMonitor({
    log: (line) => serverLog.info(line),
    sample: () => ({
      wsClients: wss.clients.size,
      reconnects: state.runtimeStats().reconnects,
      lagMaxMs: perfMonitor.snapshot().max,
    }),
  });

  function healthReport() {
    const byRole = {};
    wss.clients.forEach((client) => {
      const role = client.role || "other";
      byRole[role] = (byRole[role] || 0) + 1;
    });
    const snapshot = state.snapshot();
    return buildHealthReport({
      appName: appName || "Open Stream Environment",
      version: version || pkgVersion,
      port: currentPort(),
      listening: !!server.listening,
      uptimeSec: (Date.now() - startedAt) / 1000,
      wsClients: wss.clients.size,
      wsByRole: byRole,
      integrations: snapshot.connectionStatus,
      session: currentSession
        ? { id: currentSession.id, channel: currentSession.channel, startedAt: currentSession.startedAt }
        : null,
      storage: db ? db.getStorageStats() : null,
      writes: db && typeof db.getWriteStats === "function" ? db.getWriteStats() : null,
      perf: perfMonitor.snapshot(),
      longrun: longRun.snapshot(),
      security: {
        tokenRequired: true,
        deniedUpgrade: accessCounters.deniedUpgrade,
        deniedHttp: accessCounters.deniedHttp,
        rateLimited: accessCounters.rateLimited,
        audit: audit.counters(),
      },
    });
  }

  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(healthReport());
  });

  // Один и тот же текст отдаётся и по HTTP, и в диалог сохранения в Electron:
  // собираем в одном месте, чтобы отчёты не разъехались.
  function supportBundleText() {
    const bundle = buildSupportBundle({
      appName: appName || "Open Stream Environment",
      version: version || pkgVersion,
      configDir: getConfigDir(),
      logsDir: getLogsDir(),
      remoteUrl,
      config: state.config,
      layout: state.layout,
      health: healthReport(),
      writes: db && typeof db.getWriteStats === "function" ? db.getWriteStats() : null,
      recoveryEvents: getRecoveryEvents(),
      audit: audit.recent(50),
    });
    return renderSupportBundle(bundle);
  }

  /*
    Ручное восстановление из резервных копий (кнопка в «Настройки → Данные»).

    config — меняет настройки и переподключает интеграции (иначе получились бы
    новые настройки при старых подключениях).
    database — возвращает раскладку/пресеты/сессии из снапшота; историю событий
    и чата это не трогает, она живёт в отдельных append-only файлах.
  */
  function listBackups() {
    return {
      config: state.listConfigBackups(),
      database: db ? db.listBackups() : [],
    };
  }

  function restoreBackup(target, slot) {
    const index = Number(slot);
    if (!Number.isInteger(index) || index < 0) return { ok: false, error: "неверный номер копии" };

    if (target === "config") {
      const result = state.restoreConfigFromBackup(index);
      if (!result.ok) return result;
      serverLog.warn("config restored from backup", { slot: index });
      importConfig(result.config);
      return { ok: true, slot: index, target };
    }

    if (target === "database") {
      if (!db) return { ok: false, error: "база недоступна" };
      const result = db.restoreFromBackup(index);
      if (!result.ok) return result;
      state.reloadFromDb();
      serverLog.warn("database restored from backup", { slot: index });
      broadcastTheme();
      broadcast(EVENT_TYPES.STATE, stateSnapshot());
      return { ok: true, slot: index, target };
    }

    return { ok: false, error: "неизвестная цель восстановления" };
  }

  app.get("/support-bundle", (req, res) => {
    if (!isLoopbackRequest(req)) {
      accessCounters.deniedHttp += 1;
      serverLog.warn("support bundle requested from outside localhost", {
        address: String((req.socket && req.socket.remoteAddress) || ""),
      });
      res.status(403).set("Content-Type", "text/plain; charset=utf-8").send("403: отчёт доступен только с этой машины");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    res.set("Cache-Control", "no-store");
    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="ose-support-${stamp}.txt"`);
    res.send(supportBundleText());
  });

  let twitchChatCtrl = null;
  let chatBotCtrl = null;
  let twitchEventsCtrl = null;
  let donationAlertsCtrl = null;
  let youtubeCtrl = null;
  let obsCtrl = null;
  let longshotSync = null;
  let currentSession = null;
  let autoSpinTimer = null;
  let wheelHideTimer = null;
  let isSpinning = false;
  let hudEditMode = false;
  let pendingVideoTarget = null; // { sceneName, splash } — advance after the splash ends
  let recovering = false; // идёт запрос списка донатов к DonationAlerts
  let language = db ? db.getLanguage() : "en";
  I18n.setLang(language);

  // Адрес пульта всегда с кодом доступа: он же нужен при подключении к шине из
  // сети (панель и оверлей на этой машине кода не требуют).
  function buildRemoteUrl(port) {
    return `http://${getLocalIp()}:${port}/remote?token=${state.remoteToken()}`;
  }
  let remoteUrl = buildRemoteUrl(state.config.port || 8710);

  function stateSnapshot() {
    return {
      ...state.snapshot(),
      remoteUrl,
      hudEditMode,
      alertQueue: queueSnapshot(),
      /*
        Начало текущей сессии. У стрим-событий нет sessionId — сессия считается
        по времени (так же, как в агрегатах сессий), поэтому панель просит
        «только этот стрим» именно границей времени. 0 — сессии ещё нет, тогда
        ограничения нет.
      */
      sessionStartedAt: (currentSession && currentSession.startedAt) || 0,
    };
  }

  function broadcast(type, payload) {
    const message = JSON.stringify({ type, payload });
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(message);
    });
  }

  // Правила очереди в терминах модуля (config хранит их в snake_case).
  function queueRulesFromConfig() {
    const config = state.alertQueueConfig();
    return {
      minAmount: config.min_amount,
      mergeSameUser: config.merge_same_user,
      mergeWindowSec: config.merge_window_sec,
    };
  }

  /*
    Снимок очереди для интерфейса.

    К снимку самой очереди добавляется флаг «очередь включена»: это настройка
    приложения (alert_queue.enabled), а не свойство очереди — сама очередь про
    него не знает, потому что при выключенной очереди в неё просто не кладут.
  */
  function queueSnapshot() {
    return { ...alertQueue.snapshot(), enabled: state.alertQueueConfig().enabled !== false };
  }

  /*
    Очередь алертов — одна на всё приложение (см. alert-queue.js).

    Раньше рассылка была прямой: что пришло на шину, то и ушло клиентам, а
    порядок и паузы держал виджет внутри страницы OBS. Из этого следовало, что
    панель не знает, что происходит в эфире, перезагрузка страницы OBS молча
    выбрасывает непоказанное, а повлиять на порядок нельзя.

    Теперь расписание держит сервер, а рассылка идёт веерно всем клиентам:
    очередь общая, и «показано» сервер отсчитывает по таймеру, а не по
    подтверждению от страницы (кто именно её получил — неважно).
  */
  const alertQueue = createAlertQueue({
    rules: queueRulesFromConfig(),
    onPlay: (item) => broadcast(EVENT_TYPES.ALERT, item),
    onChange: (change) => {
      broadcast(EVENT_TYPES.ALERT_QUEUE_UPDATE, { queue: queueSnapshot(), reason: change.reason });
    },
  });

  /*
    Отдать алерт в эфир: через очередь или напрямую.

    alert_queue.enabled === false — «простой режим»: алерты уходят клиентам сразу,
    без правил, объединения, паузы и списка очереди. Это запасной выход, если
    очередь мешает; всё остальное (история, цель сбора, озвучка) работает как есть.
  */
  function publishAlert(alert, meta) {
    if (state.alertQueueConfig().enabled === false) {
      broadcast(EVENT_TYPES.ALERT, alert);
      return { accepted: true, queued: false };
    }
    return alertQueue.enqueue(alert, meta);
  }

  // Микрокадры — только оверлеям (включая HUD и превью темы, они грузят тот
  // же overlay.html), а не всем клиентам.
  function broadcastMicFrame(buffer) {
    wss.clients.forEach((client) => {
      if (client.readyState === 1 && MIC_FRAME_ROLES.has(client.role)) {
        client.send(buffer, { binary: true });
      }
    });
  }

  // The game HUD window lives in Electron's main process; the server just
  // remembers the current edit-mode flag so freshly connected overlays get
  // the correct state in their initial snapshot (see stateSnapshot above).
  function setHudEditMode(enabled) {
    hudEditMode = !!enabled;
    broadcast(EVENT_TYPES.HUD_EDIT_MODE, { enabled: hudEditMode });
    return hudEditMode;
  }

  function setLanguage(code) {
    language = code === "ru" ? "ru" : "en";
    I18n.setLang(language);
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

  function broadcastPoll(poll) {
    broadcast(EVENT_TYPES.POLL_UPDATE, { poll });
  }

  function clearAutoSpin() {
    clearTimeout(autoSpinTimer);
    autoSpinTimer = null;
  }

  function clearWheelHide() {
    clearTimeout(wheelHideTimer);
    wheelHideTimer = null;
  }

  // Скрывает колесо, когда цикл розыгрыша закончился. Обычный режим: после
  // показа победителя (столько же, сколько висит карточка результата). В режиме
  // на выбывание следующий спин запускает scheduleAutoSpin и сам скрывать не даёт.
  function scheduleWheelHide(delayMs) {
    clearWheelHide();
    wheelHideTimer = setTimeout(() => {
      wheelHideTimer = null;
      if (isSpinning) return; // только что запустили новый спин — не скрываем
      broadcast(EVENT_TYPES.GIVEAWAY_WHEEL, { sectors: [] });
    }, Math.max(0, Number(delayMs) || 0));
  }

  function scheduleAutoSpin() {
    clearAutoSpin();
    autoSpinTimer = setTimeout(() => {
      autoSpinTimer = null;
      clearWheelHide(); // следующий спин покажет колесо заново
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

  function restartChatBot() {
    if (chatBotCtrl) chatBotCtrl.stop();
    chatBotCtrl = null;
    if (!state.config.chatBot || !state.config.chatBot.enabled) {
      return;
    }
    chatBotCtrl = startChatBot({ bus, state });
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

  /*
    Переподключение сервиса по кнопке.

    «Донаты перестали приходить» — почти всегда оборванный сокет, и самый
    быстрый способ это починить — перезапустить интеграцию, не трогая ни
    настройки, ни приложение. Идёт через те же restart*(), что и старт,
    поэтому состояние в панели обновляется как обычно (connection_status).
  */
  function restartIntegration(rawService) {
    const service = String(rawService || "");
    switch (service) {
      case "twitch":
        restartTwitchChat();
        restartTwitchEvents();
        break;
      case "twitchChat":
        restartTwitchChat();
        break;
      case "twitchEvents":
        restartTwitchEvents();
        break;
      case "donationAlerts":
        restartDonationAlerts();
        break;
      case "youtube":
        restartYoutube();
        break;
      case "obs":
        restartObs();
        break;
      default:
        serverLog.warn("unknown integration to restart", { service });
        return false;
    }
    // Для DonationAlerts строка идёт в его собственный журнал: панель
    // показывает её рядом с ответами сервиса, то есть там, где её ищут.
    const log = service === "donationAlerts" ? donationsLog : serverLog;
    log.info("integration restarted by request", { service });
    return true;
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
    if (!cmd) {
      serverLog.warn("OBS command skipped (unknown command)", { id });
      return false;
    }
    const requestType = String(cmd.requestType || "").trim();
    if (!requestType) {
      serverLog.warn("OBS command skipped (empty requestType)", { id });
      return false;
    }
    if (!obsCtrl) {
      serverLog.warn("OBS command skipped (OBS not connected)", { id });
      return false;
    }
    obsCtrl.sendRawRequest(requestType, cmd.requestData || {}).catch((err) =>
      serverLog.warn("OBS raw command failed", { id, requestType, message: err && err.message ? err.message : String(err) })
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

  // Interactive CLI console exposed to the control panel log panel.
  const cli = createCliHandler({
    state,
    bus,
    obsCtrl,
    broadcast,
    startedAt: Date.now(),
    handleRemoteAction,
    setLanguage,
    t: (key, params) => I18n.t(key, params),
  });

  mountOAuthRoutes(app, {
    state,
    /*
      Строки OAuth идут под именем самого сервиса.

      Так они попадают и в файл журнала (по нему разбирается «почему
      invalid_client» без скриншотов браузера), и в панель DonationAlerts —
      туда, где видно остальные строки этого сервиса, а не в общий поток.
    */
    loggerFor: (service) => createLogger(bus, service),
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

  wss.on("connection", (socket, req) => {
    socket.role = roleFromUrl(req && req.url);
    // Запоминаем происхождение: из сети или с этой машины. Нужно и для журнала,
    // и чтобы понимать, к каким клиентам применим код доступа.
    socket.external = !isLoopbackRequest(req);
    socket.send(JSON.stringify({ type: EVENT_TYPES.LOCALES, payload: { lang: language, locales: LOCALES } }));
    socket.send(JSON.stringify({ type: EVENT_TYPES.STATE, payload: stateSnapshot() }));
    if (db) {
      socket.send(JSON.stringify({ type: EVENT_TYPES.OVERLAY_PARTICIPANTS_CONFIG, payload: { config: db.getParticipantsConfig() } }));
      socket.send(JSON.stringify({ type: EVENT_TYPES.WHEEL_CONFIG, payload: { config: db.getWheelConfig() } }));
      socket.send(JSON.stringify({ type: EVENT_TYPES.WHEEL_SPEED_CONFIG, payload: { config: db.getWheelSpeedConfig() } }));
      socket.send(JSON.stringify({ type: EVENT_TYPES.OVERLAY_MIC_CONFIG, payload: { config: db.getMicConfig() } }));
    }

    /*
      Перезагрузка страницы OBS не должна съедать то, что играет: очередь уже
      знает текущий алерт, поэтому просто отдаём его заново. Второй записи в
      историю не будет — за историю отвечают побочные эффекты bus.on("alert"),
      а не рассылка.
    */
    if (socket.role === "overlay") {
      const current = alertQueue.snapshot().now;
      if (current) socket.send(JSON.stringify({ type: EVENT_TYPES.ALERT, payload: current }));
    }

    socket.on("message", (raw, isBinary) => {
      // Микрокадры идут бинарно и пересылаются без JSON как есть: серверу не
      // нужно парсить FFT-данные, чтобы их просто транслировать в оверлей.
      if (MicFrame.isFrame(raw)) {
        broadcastMicFrame(raw);
        return;
      }
      if (isBinary) return; // неизвестный бинарный фрейм — игнорируем

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Tab-completion is answered directly to the requesting socket (not
      // broadcast) to avoid noisy completion frames reaching other clients.
      if (msg.type === EVENT_TYPES.EXEC_CLI_COMPLETION) {
        const input = (msg.payload && msg.payload.input) || "";
        const completions = cli.getCompletions(input);
        socket.send(JSON.stringify({ type: EVENT_TYPES.CLI_COMPLETIONS, payload: { input, completions } }));
        return;
      }

      const external = !!socket.external;
      // Каждая команда оставляет след: тип, роль клиента, происхождение и пара
      // безопасных деталей (без самого payload — см. audit-log.js). Команды
      // сверх лимита тоже фиксируем, но не выполняем.
      const limited = !allowCommand(socket);
      audit.record({ type: msg.type, role: socket.role, external, limited, details: summarizePayload(msg.payload) });
      if (limited) return;
      handleClientCommand(msg);
    });
  });

  function handleRemoteAction(action, payload) {
    action = String(action || "").toUpperCase();
    switch (action) {
      case "SCENE_SET": {
        const scene = String((payload && payload.scene) || "main").toLowerCase();
        const sceneName = (state.config.obs.sceneMap && state.config.obs.sceneMap[scene]) || "";

        // Cancel any in-flight splash transition so a manual switch always wins.
        pendingVideoTarget = null;

        // Заставка (видео/картинка/GIF или стандартная) проигрывается при
        // переходах: start → main (интро), возврат brb/talk/end/wheel/poll → main
        // и вход → brb/talk/end/wheel/poll. Приоритет: файл сцены → общий файл
        // → стандартная.
        const current = state.runtime.activeScene;
        const RETURN_SPLASH = ["start", "brb", "talk", "end", "wheel", "poll"];
        const ENTER_SPLASH = ["brb", "talk", "end", "wheel", "poll"];
        let splashScene = "";
        if (scene === "main" && RETURN_SPLASH.includes(current)) splashScene = current;
        else if (ENTER_SPLASH.includes(scene)) splashScene = scene;
        // Переключатель в «Заставках»: выключенная сцена пропускает заставку
        // и переключается сразу на целевую сцену.
        if (splashScene && state.config.scenes[splashScene] && state.config.scenes[splashScene].splashEnabled === false) {
          splashScene = "";
        }
        const sceneSplashFile = splashScene
          ? (state.config.scenes[splashScene] && state.config.scenes[splashScene].splashFile) || ""
          : "";
        const globalSplashFile = (state.config.splash && state.config.splash.file) || "";
        const splashFile = sceneSplashFile || globalSplashFile;

        const sceneSplashDuration = splashScene
          ? (state.config.scenes[splashScene] && state.config.scenes[splashScene].splashDuration) || 0
          : 0;
        const globalSplashDuration = (state.config.splash && state.config.splash.duration) || 0;
        const splashDuration = sceneSplashDuration > 0 ? sceneSplashDuration : globalSplashDuration;

        const videoSceneName = (state.config.obs.sceneMap && state.config.obs.sceneMap.video) || "";

        if (splashScene && obsCtrl && videoSceneName) {
          const splashPayload = {
            mediaFile: splashFile,
            scene: splashScene,
            title: (state.config.scenes[splashScene] && state.config.scenes[splashScene].title) || "",
            duration: splashDuration,
            nextScene: scene,
          };
          obsCtrl.switchScene(videoSceneName);
          pendingVideoTarget = { sceneName, splash: splashPayload };
          broadcast(EVENT_TYPES.VIDEO_SPLASH_PLAY, splashPayload);
          serverLog.info("splash playing, pending scene switch", { scene, splashScene, mediaFile: splashFile, videoSceneName });
        } else if (obsCtrl && sceneName) {
          obsCtrl.switchScene(sceneName);
        }

        state.setActiveScene(scene);
        broadcast(EVENT_TYPES.REMOTE_ACTION, {
          action: "SCENE_SET",
          payload: { scene, startedAt: state.runtime.sceneStartedAt },
        });
        serverLog.info("remote scene switch", { scene, sceneName });
        break;
      }
      case "WHEEL_START": {
        clearAutoSpin();
        clearWheelHide();
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
        clearWheelHide();
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
        clearWheelHide();
        broadcast(EVENT_TYPES.GIVEAWAY_WHEEL, { sectors: state.giveawaySnapshot().participants });
        break;
      }
      case "WHEEL_RESET_PARTICIPANTS": {
        clearAutoSpin();
        clearWheelHide();
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
        const id = payload && (typeof payload.themeId === "string" ? payload.themeId : payload.id);
        const enable3d = payload && payload.enable3d;
        if (typeof id === "string" && state.setActiveTheme(id, enable3d)) broadcastTheme();
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
      case "WEBCAM_TOGGLE": {
        const sourceName = (state.config.obs && state.config.obs.webcamSource) || "";
        if (!sourceName) {
          serverLog.warn("webcam toggle skipped (no webcam source configured)");
          break;
        }
        if (obsCtrl) {
          obsCtrl
            .toggleWebcam(sourceName)
            .then((enabled) => serverLog.info("webcam toggled", { sourceName, enabled }))
            .catch((err) => serverLog.warn("webcam toggle failed", { message: err.message }));
        }
        break;
      }
      case "MIC_TOGGLE": {
        const sourceName = (state.config.obs && state.config.obs.micSource) || "";
        if (!sourceName) {
          serverLog.warn("mic toggle skipped (no mic source configured)");
          break;
        }
        if (obsCtrl) {
          obsCtrl
            .toggleMicMute(sourceName)
            .then((muted) => serverLog.info("mic toggled", { sourceName, muted }))
            .catch((err) => serverLog.warn("mic toggle failed", { message: err.message }));
        }
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
      case EVENT_TYPES.EXEC_CLI_COMMAND: {
        cli.execute(msg.payload && msg.payload.command);
        break;
      }
      case EVENT_TYPES.CMD_ADD_WIDGET: {
        const instance = state.addWidget(msg.payload && msg.payload.type);
        if (instance) broadcast(EVENT_TYPES.LAYOUT_UPDATE, { layout: state.layout });
        syncLongshotActivity();
        break;
      }
      case EVENT_TYPES.CMD_UPDATE_WIDGET: {
        const { id, patch } = msg.payload || {};
        const updated = state.updateWidget(id, patch || {});
        if (updated) broadcast(EVENT_TYPES.LAYOUT_UPDATE, { layout: state.layout });
        // Правка visible может включить или выключить опрос Longshot.
        syncLongshotActivity();
        break;
      }
      case EVENT_TYPES.CMD_REFRESH_LONGSHOT: {
        if (longshotSync) longshotSync.refresh();
        break;
      }
      case EVENT_TYPES.CMD_REMOVE_WIDGET: {
        const { id } = msg.payload || {};
        if (state.removeWidget(id)) broadcast(EVENT_TYPES.LAYOUT_UPDATE, { layout: state.layout });
        syncLongshotActivity();
        break;
      }
      case EVENT_TYPES.CMD_REORDER_WIDGET: {
        const { id, direction } = msg.payload || {};
        if (state.reorderWidget(id, direction)) broadcast(EVENT_TYPES.LAYOUT_UPDATE, { layout: state.layout });
        break;
      }
      case EVENT_TYPES.CMD_SAVE_LAYOUT: {
        const layout = (msg.payload && msg.payload.layout) || state.layout;
        if (state.saveLayout(layout)) broadcast(EVENT_TYPES.LAYOUT_UPDATE, { layout: state.layout });
        syncLongshotActivity();
        break;
      }
      case EVENT_TYPES.CMD_TOGGLE_HUD_EDIT_MODE: {
        // Window management (setIgnoreMouseEvents) lives in Electron's main
        // process; the server just relays the request onto the shared bus.
        bus.emit("hud-edit-toggle");
        break;
      }
      case EVENT_TYPES.CMD_SET_HUD_HOTKEY: {
        const requested = String((msg.payload && msg.payload.hotkey) || "").trim();
        if (!requested) break;
        // Регистрацией глобального хоткея владеет Electron (main.js). Если
        // акселератор невалиден/занят, колбэк вернёт false и мы оставим
        // прежнее значение, вернув клиенту актуальный хоткей с ok:false.
        const ok = onSetHudHotkey ? onSetHudHotkey(requested) : true;
        if (ok) {
          state.setHudHotkey(requested);
          broadcast(EVENT_TYPES.HUD_HOTKEY_UPDATE, { hotkey: requested, ok: true });
        } else {
          broadcast(EVENT_TYPES.HUD_HOTKEY_UPDATE, { hotkey: state.config.hud_edit_hotkey, ok: false });
        }
        break;
      }
      case EVENT_TYPES.CMD_SET_HUD_DISPLAY: {
        const raw = msg.payload && msg.payload.displayId;
        const displayId = raw == null || raw === "" ? null : raw;
        const saved = state.setHudDisplay(displayId);
        bus.emit("hud-display-changed", saved);
        broadcast(EVENT_TYPES.HUD_DISPLAY_UPDATE, { displayId: saved });
        break;
      }
      case EVENT_TYPES.CMD_TOGGLE_CHAT_HUD: {
        // Window management lives in Electron's main process; the server only
        // relays the request onto the shared bus (see main.js).
        bus.emit("chat-hud-toggle");
        break;
      }
      case EVENT_TYPES.CMD_SET_CHAT_HUD_HOTKEY: {
        const requested = String((msg.payload && msg.payload.hotkey) || "").trim();
        if (!requested) break;
        // The global hotkey is registered by Electron (main.js). If the
        // accelerator is invalid/taken the callback returns false and we keep
        // the previous value, returning the actual hotkey with ok:false.
        const ok = onSetChatHudHotkey ? onSetChatHudHotkey(requested) : true;
        if (ok) {
          state.setChatHudHotkey(requested);
          broadcast(EVENT_TYPES.CHAT_HUD_HOTKEY_UPDATE, { hotkey: requested, ok: true });
        } else {
          broadcast(EVENT_TYPES.CHAT_HUD_HOTKEY_UPDATE, { hotkey: state.config.chat_hud_hotkey, ok: false });
        }
        break;
      }
      case EVENT_TYPES.CMD_SET_CHAT_HUD_DISPLAY: {
        const raw = msg.payload && msg.payload.displayId;
        const displayId = raw == null || raw === "" ? null : raw;
        const saved = state.setChatHudDisplay(displayId);
        bus.emit("chat-hud-display-changed", saved);
        broadcast(EVENT_TYPES.CHAT_HUD_DISPLAY_UPDATE, { displayId: saved });
        break;
      }
      case EVENT_TYPES.CMD_SET_CHAT_HUD_CONFIG: {
        const saved = state.setChatHudConfig((msg.payload && msg.payload.config) || {});
        bus.emit("chat-hud-config-changed", saved);
        broadcast(EVENT_TYPES.CHAT_HUD_CONFIG_UPDATE, { config: saved });
        break;
      }
      case EVENT_TYPES.CMD_SAVE_LAYOUT_PRESET: {
        const presets = state.saveLayoutPreset(msg.payload || {});
        if (presets) broadcast(EVENT_TYPES.LAYOUT_PRESETS_UPDATE, { presets });
        break;
      }
      case EVENT_TYPES.CMD_APPLY_LAYOUT_PRESET: {
        const layout = state.applyLayoutPreset((msg.payload && msg.payload.id) || "");
        if (layout) {
          broadcast(EVENT_TYPES.LAYOUT_UPDATE, { layout });
          // Applying a preset can also restore the 2D/3D theme, so notify
          // clients to refresh the theme grid, library and overlay gating.
          broadcast(EVENT_TYPES.THEME_UPDATE, state.snapshot().appearance);
        }
        syncLongshotActivity();
        break;
      }
      case EVENT_TYPES.CMD_DELETE_LAYOUT_PRESET: {
        const presets = state.deleteLayoutPreset((msg.payload && msg.payload.id) || "");
        if (presets) broadcast(EVENT_TYPES.LAYOUT_PRESETS_UPDATE, { presets });
        break;
      }
      case EVENT_TYPES.CMD_SET_GOAL: {
        const goal = state.setGoal(msg.payload || {});
        broadcast(EVENT_TYPES.GOAL_UPDATE, goal);
        break;
      }
      case EVENT_TYPES.CMD_SET_APP_CONFIG: {
        const patch = msg.payload || {};
        const isPortSwitch = patch.port !== undefined && Number(patch.port) !== currentPort();
        if (isPortSwitch) {
          switchPort(patch.port);
          // The channel may be sent together with the port; reconnect Twitch
          // only for that part (switchPort already broadcasts fresh STATE).
          if (patch.twitchChannel !== undefined) {
            restartTwitchChat();
            restartChatBot();
          }
        } else {
          state.setAppConfig(patch);
          restartTwitchChat();
          restartChatBot();
          broadcast(EVENT_TYPES.STATE, stateSnapshot());
        }
        break;
      }
      case EVENT_TYPES.CMD_SET_ACTIVE_THEME: {
        const { id, enable3d } = msg.payload || {};
        if (state.setActiveTheme(id, enable3d)) broadcastTheme();
        break;
      }
      case EVENT_TYPES.CMD_SET_ENABLED_3D: {
        const { type, enabled } = msg.payload || {};
        if (state.setEnabled3dWidget(type, enabled)) broadcastTheme();
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
      case EVENT_TYPES.CMD_DUPLICATE_CUSTOM_THEME: {
        const { id } = msg.payload || {};
        if (state.duplicateCustomTheme(id)) broadcastTheme();
        break;
      }
      case EVENT_TYPES.CMD_IMPORT_CUSTOM_THEME: {
        state.saveCustomTheme(msg.payload || {});
        broadcastTheme();
        break;
      }
      case EVENT_TYPES.CMD_PREVIEW_THEME_DRAFT: {
        // Relay the editor's unsaved draft to the theme preview window. It is
        // broadcast globally, but only the preview overlay (opened with
        // ?themePreview=1) acts on this event.
        broadcast(EVENT_TYPES.THEME_DRAFT_PREVIEW, msg.payload || {});
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
      case EVENT_TYPES.CMD_SET_SPLASH_CONFIG: {
        state.setSplashConfig((msg.payload && msg.payload.config) || {});
        broadcast(EVENT_TYPES.STATE, stateSnapshot());
        break;
      }
      case EVENT_TYPES.VIDEO_SPLASH_ENDED: {
        const target = pendingVideoTarget;
        pendingVideoTarget = null;
        if (target && obsCtrl && target.sceneName) {
          obsCtrl.switchScene(target.sceneName);
          // Сцена становится видимой только сейчас, после заставки, — с этого
          // момента и стартует обратный отсчёт.
          const startedAt = state.markSceneStarted();
          const nextScene = target.splash && target.splash.nextScene;
          if (nextScene) {
            broadcast(EVENT_TYPES.REMOTE_ACTION, { action: "SCENE_SET", payload: { scene: nextScene, startedAt } });
          }
          serverLog.info("splash finished — switching to scene", { sceneName: target.sceneName });
        } else {
          serverLog.info("splash finished (no pending target)");
        }
        break;
      }
      case EVENT_TYPES.VIDEO_SPLASH_READY: {
        // The splash overlay just (re)connected — replay the pending splash so
        // it never misses the play command if OBS loaded it after the broadcast.
        if (pendingVideoTarget && pendingVideoTarget.splash) {
          broadcast(EVENT_TYPES.VIDEO_SPLASH_PLAY, pendingVideoTarget.splash);
        }
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
      case EVENT_TYPES.CMD_SEND_CHAT: {
        const text = String((msg.payload && msg.payload.message) || "");
        const clientId = (msg.payload && msg.payload.clientId) || null;
        sendTwitchChatMessage({ bus, state, message: text }).then((result) => {
          broadcast(EVENT_TYPES.CHAT_SENT, { clientId, ...result });
        });
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
      case EVENT_TYPES.CMD_TEST_POLL: {
        const poll = state.testPollVotes((msg.payload && msg.payload.count) || 12);
        if (poll) {
          broadcastPoll(poll);
        } else {
          serverLog.warn("poll test skipped (no poll options configured)");
        }
        break;
      }
      case EVENT_TYPES.CMD_START_GIVEAWAY: {
        clearAutoSpin();
        clearWheelHide();
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
        clearWheelHide();
        broadcast(EVENT_TYPES.GIVEAWAY_WHEEL, { sectors: state.giveawaySnapshot().participants });
        break;
      }
      case EVENT_TYPES.CMD_SPIN_WHEEL: {
        clearWheelHide();
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
        } else if (shouldHideWheelAfterSpin(giveaway)) {
          // Цикл закончен (обычный режим или финальный победитель): прячем
          // колесо после того, как покажется карточка результата.
          scheduleWheelHide(ALERT_DURATIONS_MS.wheel_winner || 8000);
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
      case EVENT_TYPES.CMD_CLEAR_GIVEAWAY_PARTICIPANTS: {
        clearAutoSpin();
        clearWheelHide();
        isSpinning = false;
        broadcastGiveaway(state.clearGiveawayParticipants());
        broadcast(EVENT_TYPES.GIVEAWAY_WHEEL, { sectors: [] });
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
      case EVENT_TYPES.CMD_START_POLL: {
        broadcastPoll(state.startPoll(msg.payload && msg.payload.command));
        break;
      }
      case EVENT_TYPES.CMD_STOP_POLL: {
        broadcastPoll(state.stopPoll());
        break;
      }
      case EVENT_TYPES.CMD_RESET_POLL: {
        broadcastPoll(state.resetPoll());
        break;
      }
      case EVENT_TYPES.CMD_SET_POLL_CONFIG: {
        broadcastPoll(state.setPollConfig((msg.payload && msg.payload.config) || {}));
        break;
      }
      case EVENT_TYPES.CMD_ADD_POLL_OPTION: {
        const poll = state.addPollOption(msg.payload && msg.payload.label);
        if (poll) broadcastPoll(poll);
        break;
      }
      case EVENT_TYPES.CMD_REMOVE_POLL_OPTION: {
        broadcastPoll(state.removePollOption(msg.payload && msg.payload.id));
        break;
      }
      case EVENT_TYPES.CMD_CLEAR_POLL_OPTIONS: {
        broadcastPoll(state.clearPollOptions());
        break;
      }
      case EVENT_TYPES.CMD_SAVE_POLL_PRESET: {
        const presets = state.savePollPreset(msg.payload || {});
        if (presets) broadcast(EVENT_TYPES.POLL_PRESETS_UPDATE, { presets });
        break;
      }
      case EVENT_TYPES.CMD_APPLY_POLL_PRESET: {
        const poll = state.applyPollPreset((msg.payload && msg.payload.id) || "");
        if (poll) broadcastPoll(poll);
        break;
      }
      case EVENT_TYPES.CMD_DELETE_POLL_PRESET: {
        const presets = state.deletePollPreset((msg.payload && msg.payload.id) || "");
        if (presets) broadcast(EVENT_TYPES.POLL_PRESETS_UPDATE, { presets });
        break;
      }
      case EVENT_TYPES.MIC_AUDIO_DATA: {
        // Mic bridge: the control panel captures audio (its getUserMedia works
        // in Electron) and forwards it here so the overlay visualizer works
        // even inside OBS Browser Source where mic capture is blocked.
        broadcast(EVENT_TYPES.MIC_AUDIO_DATA, msg.payload || {});
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
      case EVENT_TYPES.CMD_RESTART_INTEGRATION: {
        restartIntegration(msg.payload && msg.payload.service);
        break;
      }
      case EVENT_TYPES.CMD_SET_NOTIFICATION_SOUND: {
        state.setNotificationSound(!!(msg.payload && msg.payload.enabled));
        broadcast(EVENT_TYPES.STATE, stateSnapshot());
        break;
      }
      case EVENT_TYPES.CMD_SET_NOTIFICATION_VOLUME: {
        state.setNotificationVolume(msg.payload && msg.payload.volume);
        broadcast(EVENT_TYPES.STATE, stateSnapshot());
        break;
      }
      case EVENT_TYPES.CMD_SET_NOTIFICATION_REPEATS: {
        state.setNotificationRepeats(msg.payload && msg.payload.repeats);
        broadcast(EVENT_TYPES.STATE, stateSnapshot());
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
      case EVENT_TYPES.CMD_SET_CHAT_BOT_CONFIG: {
        state.setChatBotConfig((msg.payload && msg.payload.config) || {});
        restartChatBot();
        broadcast(EVENT_TYPES.STATE, stateSnapshot());
        break;
      }
      case EVENT_TYPES.CMD_SET_TTS_CONFIG: {
        state.setTtsConfig((msg.payload && msg.payload.config) || {});
        broadcast(EVENT_TYPES.STATE, stateSnapshot());
        break;
      }
      case EVENT_TYPES.CMD_SET_DONATION_VOICE: {
        state.setDonationVoiceConfig((msg.payload && msg.payload.config) || {});
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
      case EVENT_TYPES.CMD_SET_TWITCH_REWARDS: {
        state.setTwitchRewards((msg.payload && msg.payload.rewards) || []);
        broadcast(EVENT_TYPES.STATE, stateSnapshot());
        break;
      }
      case EVENT_TYPES.CMD_TEST_TWITCH_REWARD: {
        const rule = state.getTwitchRewardById((msg.payload && msg.payload.id) || "");
        if (!rule) {
          serverLog.warn("reward test skipped (unknown rule)", { id: (msg.payload && msg.payload.id) || "" });
          break;
        }
        triggerRewardActions({
          bus,
          state,
          rewardId: rule.rewardId,
          rewardTitle: rule.rewardTitle,
          user: "Тест",
          userInput: "",
        });
        break;
      }
      case EVENT_TYPES.CMD_CREATE_CLIP: {
        createTwitchClip({ bus, state }).then((result) => {
          broadcast(EVENT_TYPES.TWITCH_ACTION_RESULT, { action: "clip", ...result });
        });
        break;
      }
      case EVENT_TYPES.CMD_CREATE_STREAM_MARKER: {
        createStreamMarker({ bus, state, description: (msg.payload && msg.payload.description) || "" }).then((result) => {
          broadcast(EVENT_TYPES.TWITCH_ACTION_RESULT, { action: "marker", ...result });
        });
        break;
      }
      /*
        Очередь алертов: панель и пульт могут вмешаться в то, что играет и что
        ждёт. Отдельного ответа на команду нет — любое изменение очереди
        рассылает свежий снимок (ALERT_QUEUE_UPDATE), по нему UI и рисуется.
      */
      case EVENT_TYPES.CMD_ALERT_QUEUE_PAUSE: {
        const minutes = Math.max(0, Number(msg.payload && msg.payload.minutes) || 0);
        const snapshot = alertQueue.pause(minutes);
        // Срок паузы живёт в конфиге, чтобы перезапуск приложения её не снимал.
        state.setAlertQueueConfig({ pauseUntil: snapshot.pausedUntil || 0 });
        break;
      }
      case EVENT_TYPES.CMD_ALERT_QUEUE_RESUME: {
        alertQueue.resume();
        state.setAlertQueueConfig({ pauseUntil: 0 });
        break;
      }
      case EVENT_TYPES.CMD_ALERT_QUEUE_SKIP: {
        alertQueue.finishCurrent("skip");
        break;
      }
      case EVENT_TYPES.CMD_ALERT_QUEUE_REMOVE: {
        alertQueue.remove((msg.payload && msg.payload.id) || "");
        break;
      }
      case EVENT_TYPES.CMD_ALERT_QUEUE_UP: {
        alertQueue.moveUp((msg.payload && msg.payload.id) || "");
        break;
      }
      case EVENT_TYPES.CMD_ALERT_QUEUE_PLAY_NOW: {
        // Текущий алерт не выбрасывается: он встаёт в начало ожидающих.
        alertQueue.playNow((msg.payload && msg.payload.id) || "");
        break;
      }
      case EVENT_TYPES.CMD_ALERT_QUEUE_CLEAR: {
        alertQueue.clear();
        break;
      }
      case EVENT_TYPES.CMD_ALERT_QUEUE_CONFIG: {
        const patch = msg.payload || {};
        /*
          Порядок важен: сначала настройка, потом правила. Правила рассылают
          снимок очереди, а в нём уже должно стоять новое значение «очередь
          включена» — оно живёт в конфиге, а не в самой очереди.
        */
        state.setAlertQueueConfig(patch);
        alertQueue.setRules(queueRulesFromConfig());
        if (patch.enabled === false) {
          /*
            Выключенная очередь не должна выстрелить залежавшимся: то, что ждало
            своей очереди, показывать уже незачем — новые алерты пойдут напрямую.
          */
          alertQueue.clear();
        }
        break;
      }
      case EVENT_TYPES.CMD_RECOVER_DONATIONS: {
        recoverDonations(msg.payload || {});
        break;
      }
      case EVENT_TYPES.CMD_RESET_SESSION_STATS: {
        /*
          Сброс счёта стрима — руками, по кнопке.

          Иногда это нужно по делу: начали новый стрим, не перезапуская
          приложение, или счётчик пополнился тестовым донатом. Никаких данных
          при этом не теряется — счёт это только цифра на экране, история и цель
          сбора живут своей жизнью; поэтому рассылаем новый счёт, а не молчим.
        */
        const session = state.resetSessionDonations();
        broadcast(EVENT_TYPES.SESSION_STATS, session);
        serverLog.info("session donation counter reset by request");
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

  /*
    Подтянуть донаты, пришедшие пока приложение было выключено.

    Сокет DonationAlerts отдаёт только живые события, поэтому «что было в
    офлайне» можно узнать только из REST-списка донатов (scope
    oauth-donation-index — приложение с прежним набором scope получит 401/403).

    Новым считается донат, id которого нет в истории: id стабилен на стороне
    сервиса, а время — нет (в ответе нет часового пояса). Донаты, которые
    сервис сам помечает показанными, тоже пропускаем: их уже видели.

    Запрос только по кнопке: у DonationAlerts лимит 60 запросов в минуту, а
    фоновый опрос в цикле всё равно не нужен — новые донаты приходят сокетом.
  */
  async function recoverDonations(options = {}) {
    if (recovering) {
      return { ok: false, error: "in_progress", count: 0 };
    }
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 30));
    const report = (result) =>
      broadcast(EVENT_TYPES.ALERT_QUEUE_UPDATE, { queue: alertQueue.snapshot(), recover: result });

    const ctrl = donationAlertsCtrl;
    if (!ctrl || typeof ctrl.getAccessToken !== "function") {
      report({ ok: false, error: "not_authorized" });
      return { ok: false, error: "not_authorized", count: 0 };
    }

    recovering = true;
    // Сам факт «пошли за пропущенными» виден результатом ниже; в журнале
    // сервиса от него остаётся одна строка вместо двух.
    donationsLog.debug("fetching missed donations");
    let result;
    try {
      result = await fetchRecentDonations({ getAccessToken: ctrl.getAccessToken, limit });
    } finally {
      recovering = false;
    }

    if (!result.ok) {
      donationsLog.warn("missed donations fetch failed", { error: result.error });
      report({ ok: false, error: result.error });
      return { ok: false, error: result.error, count: 0 };
    }

    const known = db ? db.knownSourceIds() : new Set();
    const missed = result.donations
      .filter((donation) => !donation.shown)
      .filter((donation) => !(donation.sourceId && known.has(donation.sourceId)))
      // От старых к новым: подтянутое должно идти в эфир в том же порядке, в
      // каком приходило, иначе «пропущенное» перепутается местами.
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const donation of missed) {
      /*
        Через шину, а не сразу в очередь: подтянутый донат — настоящий донат, он
        должен попасть и в историю (с source_id, чтобы не подтянуться второй
        раз), и в цель сбора, и в «последние события».
      */
      bus.emit("alert", {
        kind: "donation",
        user: donation.user,
        amount: donation.amount,
        currency: donation.currency,
        message: donation.message,
        sourceId: donation.sourceId,
        recovered: true,
      });
    }

    donationsLog.success("missed donations fetched", { count: missed.length, checked: result.donations.length });
    report({ ok: true, count: missed.length });
    return { ok: true, count: missed.length };
  }

  // Ленивый опрос Longshot: включаем только пока в раскладке есть видимый таймер
  // Executive Hangar. Вызывается после правок раскладки.
  function syncLongshotActivity() {
    if (longshotSync) longshotSync.setActive(state.hasTimerWidget());
  }

  bus.on("alert", (alert) => {
    const withDuration = { durationMs: ALERT_DURATIONS_MS[alert.kind] || 5000, ...alert };

    /*
      Колесо — не донат: его показ привязан к сцене розыгрыша, которую
      scheduleWheelHide прячет по своему таймеру. Прогон карточки победителя
      через очередь означал бы либо задержку на время чужих алертов, либо показ
      поверх доната, — поэтому wheel-алерты идут напрямую, как и раньше, и в
      очередь объединения не попадают.

      Флаг enabled=false в конфиге возвращает прежнее поведение целиком
      (прямая рассылка без очереди) — это запасной выход, если пользователю
      нужен «простой режим».
    */
    const isWheelAlert = alert.kind === "wheel_start" || alert.kind === "wheel_winner";

    if (isWheelAlert) {
      broadcast(EVENT_TYPES.ALERT, withDuration);
    } else {
      /*
        Тестовый алерт — это нажатая кнопка: пользователь ждёт картинку сейчас,
        поэтому его не отсеивает правилом минимальной суммы и он не встаёт за
        очередью, но паузу при этом не снимает.
      */
      const meta = {};
      if (alert.isTest) {
        meta.force = true;
        meta.ignorePause = true;
      }
      // Подтянутый с DonationAlerts донат очередь помечает, чтобы в панели и на
      // пульте было видно, что это «пропущенное», а не прямой эфир.
      if (alert.recovered) meta.recovered = true;
      publishAlert(withDuration, meta);
    }

    /*
      Побочные эффекты остаются в момент прихода доната, а не показа: донат
      случился тогда, когда случился. Очередь управляет только картинкой, так
      что история, цель сбора и «последние события» не могут «опоздать».
    */
    if (!isWheelAlert) {
      state.pushRecentEvent({ kind: alert.kind, user: alert.user, amount: alert.amount ?? alert.count, message: alert.message });
      broadcast(EVENT_TYPES.RECENT_EVENT, state.runtime.recentEvents[0]);

      if (db) {
        db.appendStreamEvent(toStreamEvent(alert, !!alert.isTest));
      }
    }

    if (alert.kind === "donation" && typeof alert.amount === "number") {
      /*
        Счёт текущего стрима. Подтянутые с DonationAlerts донаты не считаем: они
        случились в прошлом (в другой сессии), а сложение их в «за этот стрим»
        дало бы цифру, которой не было.
      */
      if (!alert.recovered) {
        const session = state.addDonationToSession(alert.amount, alert.currency);
        broadcast(EVENT_TYPES.SESSION_STATS, session);
      }
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
      const poll = state.handlePollChat(chatMessage.user, chatMessage.message);
      if (poll) broadcastPoll(poll);
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

  bus.on("debug_log", (entry) => {
    broadcast(EVENT_TYPES.DEBUG_LOG, entry);
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

  bus.on("reward_tts", (payload) => {
    if (!payload || !payload.text) return;
    broadcast(EVENT_TYPES.REWARD_TTS, { text: payload.text });
  });

  bus.on("reward_scene_request", ({ scene }) => {
    if (!scene) return;
    handleRemoteAction("SCENE_SET", { scene });
  });

  function start() {
    const port = state.config.port || 8710;
    server.listen(port, () => {
      serverLog.success("overlay + control bus listening", { url: `http://localhost:${port}` });
      serverLog.success("web remote ready", { url: remoteUrl });
    });

    restartTwitchChat();
    restartChatBot();
    restartTwitchEvents();
    restartDonationAlerts();
    restartYoutube();
    restartObs();

    /*
      Пауза очереди переживает перезапуск приложения: «поставь на паузу на 30
      минут» не должно означать «пока приложение не перезапустят».
    */
    alertQueue.restorePause(state.alertQueueConfig().pause_until);

    // Executive Hangar: тянем публичный конфиг Longshot и рассылаем анкер.
    // Опрос ленивый — только пока в раскладке есть видимый таймер
    // (см. syncLongshotActivity), так что лишний виджет не создаёт фоновый
    // запрос каждые 5 минут.
    longshotSync = createLongshotSync({
      onUpdate: (snapshot) => {
        state.setLongshot(snapshot);
        broadcast(EVENT_TYPES.LONGSHOT_UPDATE, { longshot: snapshot });
      },
    });
    syncLongshotActivity();

    if (db) {
      currentSession = db.startSession(state.config.twitch.channel);
      // Новый стрим — новый счёт донатов.
      state.resetSessionDonations();
    }

    return { port, remoteUrl };
  }

  function currentPort() {
    return state.config.port || 8710;
  }

  // Live port switch: re-binds the HTTP + WebSocket listener without an app
  // restart. The control panel already knows the new port (it updated its
  // WebSocket target before sending the command) and reconnects on its own;
  // OBS Browser Sources keep their own URL and must be pointed at the new port
  // manually.
  function switchPort(rawPort) {
    const requested = Number(rawPort);
    const prev = currentPort();
    const next =
      Number.isInteger(requested) && requested >= 1024 && requested <= 65535
        ? requested
        : prev;

    if (next === prev && server.listening) {
      return { ok: true, port: next, remoteUrl };
    }

    serverLog.info("switching server port", { from: prev, to: next });

    // Persist first so main.js (get-info, OAuth URLs, HUD windows) reads the
    // new value. The control panel reconnects on its own to the new port (it
    // already updated its WebSocket target optimistically before sending the
    // command), so no broadcast is needed here.
    state.setAppConfig({ port: next });
    remoteUrl = buildRemoteUrl(next);

    wss.clients.forEach((client) => {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    });
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();

    server.close(() => {
      const onError = (err) => {
        server.removeListener("listening", onListening);
        serverLog.error("port switch failed, reverting", { port: next, error: err.message });
        state.setAppConfig({ port: prev });
        remoteUrl = buildRemoteUrl(prev);
        server.once("error", (err2) => serverLog.error("rollback listen failed", { error: err2.message }));
        server.once("listening", () => {
          serverLog.success("re-listening on previous port", { url: `http://localhost:${prev}` });
          broadcast(EVENT_TYPES.STATE, stateSnapshot());
        });
        server.listen(prev);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        serverLog.success("overlay + control bus listening", { url: `http://localhost:${next}` });
        serverLog.success("web remote ready", { url: remoteUrl });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(next);
    });

    return { ok: true, port: next, remoteUrl };
  }

  function importConfig(newConfig) {
    state.replaceConfig(newConfig);
    restartTwitchChat();
    restartChatBot();
    restartTwitchEvents();
    restartDonationAlerts();
    restartYoutube();
    // Импорт мог принести раскладку с таймером (или убрать его).
    syncLongshotActivity();
    broadcast(EVENT_TYPES.STATE, stateSnapshot());
  }

  function stop() {
    serverLog.info("stopping server");
    clearAutoSpin();
    clearWheelHide();
    alertQueue.stop();
    if (currentSession) {
      if (db) db.endSession(currentSession.id);
      currentSession = null;
    }
    if (twitchChatCtrl) twitchChatCtrl.stop();
    if (chatBotCtrl) chatBotCtrl.stop();
    if (twitchEventsCtrl) twitchEventsCtrl.stop();
    if (donationAlertsCtrl) donationAlertsCtrl.stop();
    if (youtubeCtrl) youtubeCtrl.stop();
    if (longshotSync) longshotSync.stop();
    longshotSync = null;
    perfMonitor.stop();
    longRun.stop();
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
    /*
      Ручной повтор: человек нажал кнопку в истории, значит хочет видеть этот
      алерт, а не тот, что сейчас в эфире. Поэтому повтор идёт без фильтра по
      сумме, в начало очереди и даже на паузе — но текущий алерт не выкидывается
      (он вернётся в начало ожидающих, см. alert-queue.playNow для «сейчас»).
    */
    publishAlert(withDuration, { force: true, front: true, ignorePause: true });
    return record;
  }

  // Новый код доступа: старый сразу перестаёт работать, адрес пульта меняется.
  // Подключённые из сети клиенты отваливаются и должны открыть новый адрес.
  function rotateRemoteToken() {
    state.rotateRemoteToken();
    remoteUrl = buildRemoteUrl(currentPort());
    serverLog.warn("remote access code rotated");
    wss.clients.forEach((client) => {
      if (!client.external) return;
      try {
        client.close();
      } catch {
        /* клиент уже отвалился */
      }
    });
    broadcast(EVENT_TYPES.STATE, stateSnapshot());
    return { ok: true, remoteUrl };
  }

  return {
    app,
    server,
    wss,
    state,
    bus,
    perfMonitor,
    start,
    stop,
    broadcast,
    setHudEditMode,
    restartTwitchChat,
    restartChatBot,
    restartTwitchEvents,
    restartDonationAlerts,
    importConfig,
    getStreamEvents,
    replayEvent,
    recoverDonations,
    // Живая очередь алертов — для диагностики и тестов; UI работает через шину.
    alertQueue,
    setLanguage,
    healthReport,
    supportBundleText,
    listBackups,
    restoreBackup,
    rotateRemoteToken,
    recentAudit: (count) => audit.recent(count),
    longRun,
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
    case "donation_long": {
      // ~200-char message to exercise wrapping/truncation in the alert widgets.
      const longText = (
        "Спасибо за поддержку канала и за уютную атмосферу на каждом стриме! " +
        "Твой вклад очень важен, он помогает каналу расти и развиваться дальше. " +
        "Желаю тебе удачи, вдохновения, здоровья и как можно больше позитивных эмоций!"
      ).slice(0, 200);
      return { kind: "donation", user, amount: 750, currency: "RUB", message: longText };
    }
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

/*
  Скрывать ли колесо после показа победителя. Цикл закончен, если это обычный
  режим или финальный победитель в режиме на выбывание. В остальных случаях
  следующий спин запускается автоматически, и колесо должно остаться на экране.
*/
function shouldHideWheelAfterSpin(giveaway) {
  const g = giveaway || {};
  const isElimination = !!g.eliminationMode && !g.isFinalWinner;
  return !isElimination;
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
    // id доната на стороне сервиса — по нему «пропущенные» донаты не попадают
    // в историю второй раз (см. db.knownSourceIds).
    source_id: alert.sourceId != null ? String(alert.sourceId) : null,
  };
}

module.exports = { createServer, buildTestAlert, eventTypeForKind, toStreamEvent, roleFromUrl, shouldHideWheelAfterSpin, isAllowedWsOrigin };

// `npm run server:only` runs the bus without Electron — handy for iterating
// on overlay/editor visuals in a normal browser tab.
if (require.main === module) {
  let handle = null;
  // Тот же страж, что и в Electron-режиме: отчёт на диск, сброс конфига и
  // понятный выход вместо тихого падения без лога. Ставим его ДО createServer:
  // именно старт (чтение конфига, привязка порта) чаще всего и падает.
  installCrashHandlers({
    appName: "Open Stream Environment (server only)",
    getLogsDir,
    flush: () => {
      if (handle) handle.state.flushConfigSync();
    },
  });
  handle = createServer();
  handle.start();
}
