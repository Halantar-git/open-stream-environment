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
  Ставим раньше всего остального, ещё до require("electron"): фильтр глушит
  единственное чужое предупреждение (punycode, DEP0040 — см.
  server/deprecation-filter.js) и должен успеть до того, как его породит
  внутренний код Electron. Идемпотентен — server/index.js ставит его же для
  режима `npm run server:only`.
*/
const { installDeprecationFilter } = require("./server/deprecation-filter");
installDeprecationFilter();

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, shell, dialog, globalShortcut, screen, session, clipboard, Tray, Menu, nativeImage, Notification } = require("electron");

const { createServer } = require("./server");
const { buildTwitchAuthorizeUrl, buildDonationAlertsAuthorizeUrl, buildYoutubeAuthorizeUrl } = require("./server/oauth");
const { createDatabase } = require("./server/db");
const { getSecretIssues, clearSecretIssues, SECRET_ISSUE } = require("./server/secret-store");
const { getRecoveryEvents, clearRecoveryEvents } = require("./server/data-integrity");
const { installCrashHandlers } = require("./server/crash-guard");
const { configureStorage, getUserMediaDir, getConfigDir, getLogsDir } = require("./server/storage-paths");
const { collectMediaForExport, importMedia } = require("./server/media");
const { eventsToCsv } = require("./server/export-events");
const { parseUpdateCheckResult } = require("./server/update-check");

// electron-updater is a runtime dependency; guard the require so a dev run
// without `npm install` (no electron-updater yet) doesn't crash the main process.
let autoUpdater = null;
try {
  autoUpdater = require("electron-updater").autoUpdater;
} catch {
  /* auto-updates disabled until the dependency is installed */
}

const SPLASH_MIN_MS = 3500; // matches the progress-bar animation duration in splash.html

// Windows: set a stable AppUserModelID as early as possible. It must match the
// packaged app's shortcut AUMID so the window/taskbar icon and toast
// notifications (`new Notification()`) resolve correctly.
app.setAppUserModelId("com.openstreamenvironment.app");

// Страховка от фатальных ошибок главного процесса: отчёт на диск, финальный
// сброс состояния, диалог вместо молча исчезнувшего окна (см. crash-guard.js).
// Обработчики живут до конца процесса — снимать их некому.
installCrashHandlers({
  appName: app.getName(),
  version: app.getVersion(),
  getLogsDir,
  // Состояние сбрасываем синхронно: после непойманной ошибки ждать нельзя.
  flush: () => {
    try {
      if (serverHandle && serverHandle.state) serverHandle.state.flushConfigSync();
    } catch (_) {
      /* конфиг мог ещё не подняться */
    }
    try {
      if (db && typeof db.flushSync === "function") db.flushSync();
    } catch (_) {
      /* БД могла ещё не подняться */
    }
  },
  onFatal: ({ kind, error, reportPath }) => {
    let isRu = false;
    try {
      isRu = !!(db && db.getLanguage() === "ru");
    } catch (_) {
      /* db ещё не создана — покажем по-английски */
    }
    const title = "Open Stream Environment";
    const message = isRu ? `Критическая ошибка приложения (${kind})` : `The application hit a fatal error (${kind})`;
    const reason = (error && (error.stack || error.message)) || String(error || "");
    const report = reportPath
      ? isRu
        ? `\n\nОтчёт сохранён: ${reportPath}`
        : `\n\nA crash report was saved to: ${reportPath}`
      : "";
    dialog.showErrorBox(title, `${message}\n\n${reason}${report}`);
  },
  // Окна закрывать нельзя (в редакторе темы спрашивается подтверждение),
  // поэтому выходим принудительно — состояние уже сброшено.
  exit: (code) => app.exit(code),
});

let mainWindow;
let splashWindow;
let chatWindow = null;
let hudWindow = null;
let chatHudWindow = null;
let themePreviewWindow = null;
let themeSamplesWindow = null;
let themeEditorWindow = null;
let themeEditorInit = { theme: null };
const widgetEditorWindows = new Map(); // widgetId -> BrowserWindow
let serverHandle;
let db;
let gameMode = false;
let chatPinned = true; // выбор пользователя кнопкой 📌
let hudEditMode = false; // оверлей поверх игры: true = ловим мышь, false = сквозной клик
let hudHotkey = null; // текущий зарегистрированный глобальный хоткей HUD
let chatHudEnabled = false; // чат поверх игры (одномониторный режим)
let chatHudHotkey = null; // текущий зарегистрированный глобальный хоткей чата HUD
let quitting = false;
let tray = null;
let trayNotificationShown = false;

// Single-instance guard: opening a second copy would clash on the local server
// port and show a duplicate overlay. Focus the already-running window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---- Window state persistence ----

function windowStatePath() {
  return path.join(getConfigDir(), "window-state.json");
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(windowStatePath(), "utf-8"));
  } catch {
    return {};
  }
}

function saveWindowState() {
  try {
    fs.writeFileSync(
      windowStatePath(),
      JSON.stringify(
        {
          main: mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null,
          chat: chatWindow && !chatWindow.isDestroyed() ? chatWindow.getBounds() : null,
        },
        null,
        2
      )
    );
  } catch {}
}

// Защита от «окна за пределами экрана» (например, монитор был отключён).
function isBoundsVisible(bounds) {
  if (!bounds || !bounds.width || !bounds.height) return false;
  const displays = screen.getAllDisplays();
  return displays.some((d) => {
    const a = d.workArea;
    return (
      bounds.x < a.x + a.width &&
      bounds.x + bounds.width > a.x &&
      bounds.y < a.y + a.height &&
      bounds.y + bounds.height > a.y
    );
  });
}

function mergeBounds(defaults, saved) {
  if (!isBoundsVisible(saved)) return defaults;
  return { width: saved.width, height: saved.height, x: saved.x, y: saved.y };
}

function resolveConfigDir() {
  if (app.isPackaged) {
    // Портативная сборка electron-builder выставляет каталог exe, чтобы
    // настройки переносились вместе с приложением.
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) {
      try {
        fs.mkdirSync(portableDir, { recursive: true });
        return portableDir;
      } catch {
        // Read-only носитель и т.п. — падаем на userData.
      }
    }
    return app.getPath("userData");
  }

  // В dev-режиме (npm start) пишем рядом с исходниками, как и раньше.
  return path.join(__dirname, "config");
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 600,
    height: 400,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.loadFile(path.join(__dirname, "splash", "splash.html"), {
    query: { version: app.getVersion() },
  });
  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

function createWindow(port) {
  const bounds = mergeBounds({ width: 1440, height: 900 }, (loadWindowState() || {}).main);
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 1100,
    minHeight: 700,
    // Windows: feed the .ico path directly so the window icon reliably loads from disk.
    icon: process.platform === "win32"
      ? path.join(__dirname, "assets", "icons", "icon.ico")
      : path.join(__dirname, "assets", "icons", "256x256.png"),
    backgroundColor: "#0e0b17",
    // No autoHideMenuBar: on Windows it makes the hidden menu bar react to Alt
    // and can leave focus stuck on it, so mouse clicks on inputs stop working
    // until Alt is pressed again. The menu is already removed globally below.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "control", "control.html"), {
    query: { port: String(port), version: app.getVersion() },
  });

  const splashStartedAt = Date.now();
  mainWindow.once("ready-to-show", () => {
    const elapsed = Date.now() - splashStartedAt;
    const remaining = Math.max(0, SPLASH_MIN_MS - elapsed);
    setTimeout(() => {
      if (splashWindow) splashWindow.destroy();
      mainWindow.maximize(); // open maximized instead of fullscreen
      mainWindow.show();
    }, remaining);
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && String(input.key).toLowerCase() === "f11") {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();

    if (!trayNotificationShown) {
      const isRu = db && db.getLanguage() === "ru";
      new Notification({
        title: "Open Stream Environment",
        body: isRu
          ? "Приложение свёрнуто в трей. Нажмите на значок в трее, чтобы открыть."
          : "App minimized to tray. Click the tray icon to open it.",
      }).show();
      trayNotificationShown = true;
    }
  });
}

function openChatWindow(port) {
  if (chatWindow) {
    chatWindow.focus();
    return;
  }
  const bounds = mergeBounds({ width: 380, height: 640 }, (loadWindowState() || {}).chat);
  chatWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 300,
    minHeight: 320,
    // Windows: feed the .ico path directly so the window icon reliably loads from disk.
    icon: process.platform === "win32"
      ? path.join(__dirname, "assets", "icons", "icon.ico")
      : path.join(__dirname, "assets", "icons", "256x256.png"),
    alwaysOnTop: true,
    backgroundColor: "#0e0b17",
    webPreferences: {
      preload: path.join(__dirname, "chatwindow", "chat-window-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      spellcheck: false,
    },
  });
  chatPinned = true;
  applyPerformanceDefaults(chatWindow, 30);
  chatWindow.loadFile(path.join(__dirname, "chatwindow", "chat-window.html"), {
    query: { port: String(port) },
  });
  chatWindow.on("closed", () => {
    chatWindow = null;
    saveWindowState();
  });
}

function openWidgetEditorWindow(port, widgetId) {
  const existing = widgetEditorWindows.get(widgetId);
  if (existing) {
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    // Windows: feed the .ico path directly so the window icon reliably loads from disk.
    icon: process.platform === "win32"
      ? path.join(__dirname, "assets", "icons", "icon.ico")
      : path.join(__dirname, "assets", "icons", "256x256.png"),
    backgroundColor: "#0e0b17",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "widgeteditor", "widget-editor.html"), {
    query: { port: String(port), widgetId },
  });
  win.on("closed", () => {
    widgetEditorWindows.delete(widgetId);
  });
  widgetEditorWindows.set(widgetId, win);
}

function openThemePreviewWindow(port) {
  if (themePreviewWindow) {
    themePreviewWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    backgroundColor: "#000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // The real overlay, but with a flag so it applies the editor's live draft
  // (and never the saved theme) while the theme editor is open.
  win.loadURL(`http://localhost:${port}/overlay/overlay.html?themePreview=1`);
  win.on("closed", () => {
    themePreviewWindow = null;
  });
  themePreviewWindow = win;
}

function openThemeSamplesWindow(port) {
  if (themeSamplesWindow) {
    themeSamplesWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 720,
    height: 900,
    minWidth: 480,
    minHeight: 640,
    backgroundColor: "#000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://localhost:${port}/overlay/samples.html`);
  win.on("closed", () => {
    themeSamplesWindow = null;
  });
  themeSamplesWindow = win;
}

function openThemeEditorWindow(port, init) {
  themeEditorInit = init || { theme: null };
  if (themeEditorWindow) {
    themeEditorWindow.focus();
    themeEditorWindow.webContents.send("theme-editor:init", themeEditorInit);
    return;
  }
  const win = new BrowserWindow({
    // Restore size — the window opens maximized, like the main panel window;
    // this is what it falls back to when un-maximized.
    width: 1320,
    height: 900,
    minWidth: 1040,
    minHeight: 640,
    // Фон окна — как в панели управления, до первой отрисовки.
    backgroundColor: "#0e0b17",
    // Разворачиваем до показа, чтобы не мигало маленькое окно (как createWindow).
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "themeeditor", "theme-editor.html"), {
    query: { port: String(port) },
  });
  win.once("ready-to-show", () => {
    win.maximize(); // open maximized instead of fullscreen
    win.show();
  });
  // Страховка: при show: false неудачная загрузка оставила бы окно невидимым.
  win.webContents.on("did-fail-load", () => {
    if (!win.isVisible()) win.show();
  });
  win.on("closed", () => {
    themeEditorWindow = null;
    themeEditorInit = { theme: null };
  });
  themeEditorWindow = win;
}

// ---- Game HUD overlay (одномониторный режим) ----
// Прозрачное окно поверх игры (Borderless Window), которое показывает тот же
// оверлей, что и OBS Browser Source. В обычном режиме оно пропускает клики
// насквозь (setIgnoreMouseEvents), поэтому не тратит ресурсы ОС на обработку
// мыши. Ctrl+Shift+H переключает режим редактирования, в котором окно ловит
// мышь и стример перетаскивает/ресайзит виджеты по неоновой сетке.
function resolveHudDisplay() {
  const displays = screen.getAllDisplays();
  const desired = serverHandle && serverHandle.state ? serverHandle.state.config.hud_display_id : null;
  if (desired != null) {
    const match = displays.find((d) => String(d.id) === String(desired));
    if (match) return match;
  }
  return screen.getPrimaryDisplay();
}

function createHudWindow(port) {
  const display = resolveHudDisplay();
  hudWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    fullscreen: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      spellcheck: false,
    },
  });

  hudEditMode = false;
  // Сквозной клик по умолчанию: оверлей не перехватывает мышь во время игры.
  hudWindow.setIgnoreMouseEvents(true, { forward: true });
  applyPerformanceDefaults(hudWindow, 30);

  // Оверлей подключается к шине по WebSocket через location.host, поэтому
  // грузим его по HTTP, а не через loadFile (иначе ws-адрес окажется пустым).
  hudWindow.loadURL(`http://localhost:${port}/overlay/overlay.html`);

  hudWindow.on("closed", () => {
    hudWindow = null;
    hudEditMode = false;
    if (serverHandle && serverHandle.setHudEditMode) serverHandle.setHudEditMode(false);
  });

  return hudWindow;
}

// При смене монитора пересоздаём окно на новом дисплее. Если шло
// редактирование — сразу возвращаемся в режим редактирования на новом мониторе.
function onHudDisplayChanged() {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  const wasEditing = hudEditMode;
  hudWindow.removeAllListeners("closed");
  hudWindow.destroy();
  hudWindow = null;
  hudEditMode = false;
  if (wasEditing) toggleHudEditMode();
}

function ensureHudWindow() {
  if (hudWindow && !hudWindow.isDestroyed()) return hudWindow;
  if (!serverHandle) return null;
  return createHudWindow(serverHandle.state.config.port);
}

function toggleHudEditMode() {
  const win = ensureHudWindow();
  if (!win) return;
  hudEditMode = !hudEditMode;
  win.setIgnoreMouseEvents(!hudEditMode, { forward: true });
  // Оверлей-превью видим только во время редактирования. В обычном режиме
  // окно скрыто, чтобы виджеты не отрисовывались поверх игры (и не тратили
  // ресурсы), а сквозной клик нужен уже на случай, если окно вдруг показано.
  if (hudEditMode) win.show();
  else win.hide();
  if (serverHandle && serverHandle.setHudEditMode) serverHandle.setHudEditMode(hudEditMode);
}

// ---- Chat HUD overlay (чат поверх игры на одном мониторе) ----
// Прозрачное безрамочное плавающее окно, которое показывает только ленту чата
// поверх игры и всегда пропускает клики насквозь (setIgnoreMouseEvents). В
// отличие от HUD-оверлея тут нет режима редактирования — чат только читается,
// окно показывается/скрывается глобальным хоткеем, а размер/положение/
// прозрачность задаются в настройках.
function resolveChatHudDisplay() {
  const displays = screen.getAllDisplays();
  const desired = serverHandle && serverHandle.state ? serverHandle.state.config.chat_hud_display_id : null;
  if (desired != null) {
    const match = displays.find((d) => String(d.id) === String(desired));
    if (match) return match;
  }
  return screen.getPrimaryDisplay();
}

function resolveChatHudBounds(display) {
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const cfg = (serverHandle && serverHandle.state && serverHandle.state.config.chatHud) || {};
  const width = Math.round(clamp(cfg.width ?? 360, 240, 1200));
  const height = Math.round(clamp(cfg.height ?? 560, 160, 2000));
  // Если позиция не задана — прижимаем панель к правому верхнему углу монитора.
  const x = cfg.x != null && Number.isFinite(Number(cfg.x))
    ? Math.round(Number(cfg.x))
    : Math.round(display.bounds.x + display.bounds.width - width - 16);
  const y = cfg.y != null && Number.isFinite(Number(cfg.y))
    ? Math.round(Number(cfg.y))
    : Math.round(display.bounds.y + 16);
  return { x, y, width, height };
}

function createChatHudWindow(port) {
  const display = resolveChatHudDisplay();
  const bounds = resolveChatHudBounds(display);
  const cfg = (serverHandle && serverHandle.state && serverHandle.state.config.chatHud) || {};
  chatHudWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    focusable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "chatwindow", "chat-window-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      spellcheck: false,
    },
  });

  // Чат только читается — окно не должно перехватывать мышь у игры.
  chatHudWindow.setIgnoreMouseEvents(true, { forward: true });
  // Поверх всех окон по умолчанию (максимальный z-order на Windows).
  applyChatHudAlwaysOnTop();
  applyPerformanceDefaults(chatHudWindow, 30);

  chatHudWindow.loadFile(path.join(__dirname, "chatwindow", "chat-window.html"), {
    query: {
      port: String(port),
      hud: "1",
      opacity: String(cfg.opacity ?? 70),
      fontSize: String(cfg.fontSize ?? 14),
    },
  });

  chatHudWindow.on("closed", () => {
    chatHudWindow = null;
    chatHudEnabled = false;
  });

  return chatHudWindow;
}

function ensureChatHudWindow() {
  if (chatHudWindow && !chatHudWindow.isDestroyed()) return chatHudWindow;
  if (!serverHandle) return null;
  return createChatHudWindow(serverHandle.state.config.port);
}

function toggleChatHudMode() {
  const win = ensureChatHudWindow();
  if (!win) return;
  chatHudEnabled = !chatHudEnabled;
  // showInactive, чтобы не уводить фокус из игры при показе/скрытии чата.
  if (chatHudEnabled) {
    applyChatHudAlwaysOnTop();
    win.showInactive();
  } else {
    win.hide();
  }
}

function onChatHudDisplayChanged() {
  if (!chatHudWindow || chatHudWindow.isDestroyed()) return;
  const wasEnabled = chatHudEnabled;
  chatHudWindow.removeAllListeners("closed");
  chatHudWindow.destroy();
  chatHudWindow = null;
  chatHudEnabled = false;
  if (wasEnabled) {
    chatHudEnabled = true;
    const win = ensureChatHudWindow();
    if (win) {
      applyChatHudAlwaysOnTop();
      win.showInactive();
    }
  }
}

// При изменении размеров/позиции чата HUD в настройках обновляем границы
// уже открытого окна без пересоздания (opacity/fontSize рендерер обновит сам
// через WebSocket-событие CHAT_HUD_CONFIG_UPDATE).
function onChatHudConfigChanged() {
  if (!chatHudWindow || chatHudWindow.isDestroyed()) return;
  const bounds = resolveChatHudBounds(resolveChatHudDisplay());
  chatHudWindow.setBounds(bounds);
}

function applyPerformanceDefaults(win, fps) {
  win.webContents.setBackgroundThrottling(true);
  if (fps) win.webContents.setFrameRate(fps);
}

// Чат HUD всегда поверх всех окон: уровень "screen-saver" — максимальный
// z-order, чтобы окно оставалось над игрой и другими topmost-окнами.
function applyChatHudAlwaysOnTop() {
  if (chatHudWindow && !chatHudWindow.isDestroyed()) {
    chatHudWindow.setAlwaysOnTop(true, "screen-saver");
  }
}

function applyChatAlwaysOnTop() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    // В игровом режиме чат всегда поверх; иначе — по выбору пользователя.
    chatWindow.setAlwaysOnTop(chatPinned || gameMode);
  }
}

function sendChatAlwaysOnTopState() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.webContents.send("app:chat-always-on-top-changed", chatPinned);
  }
}

function toggleGameMode() {
  gameMode = !gameMode;

  if (mainWindow) {
    if (gameMode) mainWindow.hide();
    else mainWindow.show();
  }

  if (chatWindow) {
    applyChatAlwaysOnTop();
    chatWindow.webContents.setFrameRate(gameMode ? 30 : 60);
  }

  if (serverHandle && serverHandle.broadcast) {
    serverHandle.broadcast("game_mode", { enabled: gameMode });
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function formatStreamAlert(alert, isRu) {
  const kind = alert.kind;
  const user = String(alert.user || "");
  let title = "Open Stream Environment";
  let body = user;

  if (kind === "follow") {
    title = isRu ? "Новый фолловер" : "New follower";
  } else if (kind === "sub") {
    title = isRu ? "Новая подписка" : "New subscription";
  } else if (kind === "gift_sub") {
    const count = Number(alert.count ?? alert.amount ?? 1);
    title = isRu ? "Гифт-подписка" : "Gift subscription";
    body = user ? `${user} × ${count}` : `× ${count}`;
  } else if (kind === "cheer") {
    const bits = Number(alert.amount ?? 0);
    title = isRu ? "Чир (биты)" : "Cheer (bits)";
    body = user ? `${user} · ${bits} ${isRu ? "бит" : "bits"}` : `${bits} ${isRu ? "бит" : "bits"}`;
  } else if (kind === "donation") {
    title = isRu ? "Новый донат" : "New donation";
    const parts = [];
    if (user) parts.push(user);
    if (typeof alert.amount === "number") parts.push(`${alert.amount} ${String(alert.currency || "").trim()}`.trim());
    if (alert.message) parts.push(String(alert.message));
    body = parts.join(" · ");
  } else if (kind === "reward") {
    title = isRu ? "Награда канала" : "Channel reward";
    const parts = [];
    if (alert.rewardTitle) parts.push(String(alert.rewardTitle));
    if (user) parts.push(user);
    if (alert.message) parts.push(String(alert.message));
    body = parts.join(" · ");
  }

  return { title, body };
}

function onStreamAlert(alert) {
  if (!alert) return;
  if (!["follow", "sub", "gift_sub", "cheer", "donation", "reward"].includes(alert.kind)) return;

  const isTest = !!alert.isTest;
  // Для реальных событий не дублируем уведомление, когда панель в фокусе
  // (там уже есть свой тост). Тестовые показываем всегда, чтобы можно было
  // проверить нативное уведомление по кнопке, не сворачивая панель.
  if (!isTest && mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return;

  const isRu = db && db.getLanguage() === "ru";
  const { title, body } = formatStreamAlert(alert, isRu);
  new Notification({ title, body }).show();
}

function trayMenuLabels() {
  const isRu = db && db.getLanguage() === "ru";
  return isRu
    ? { open: "Открыть", quit: "Выйти" }
    : { open: "Open", quit: "Quit" };
}

function buildTrayMenu() {
  const labels = trayMenuLabels();
  return Menu.buildFromTemplate([
    { label: labels.open, click: showMainWindow },
    { type: "separator" },
    { label: labels.quit, click: () => { quitting = true; app.quit(); } },
  ]);
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  // Иконки приложения разведены по размерам/платформам (см. assets/icons/),
  // поэтому грузим PNG нужного размера, а не несуществующий icon.png.
  let icon = nativeImage.createFromPath(path.join(__dirname, "assets", "icons", "256x256.png"));
  if (icon.isEmpty() && process.platform === "win32") {
    icon = nativeImage.createFromPath(path.join(__dirname, "assets", "icons", "icon.ico"));
  }
  if (!icon.isEmpty() && process.platform === "win32") {
    icon = icon.resize({ width: 16, height: 16 });
  }
  tray = new Tray(icon);
  tray.setToolTip("Open Stream Environment");
  refreshTrayMenu();
  tray.on("click", showMainWindow);
}

function registerGlobalHotkeys() {
  globalShortcut.register("CommandOrControl+Shift+C", () => {
    if (!chatWindow) return;
    chatPinned = !chatPinned;
    applyChatAlwaysOnTop();
    sendChatAlwaysOnTopState();
  });

  globalShortcut.register("CommandOrControl+Shift+G", toggleGameMode);
}

// Настраиваемый хоткей HUD. Сначала пробуем зарегистрировать новый, не
// отвязывая старый; если акселератор невалиден или занят — возвращаем false
// и оставляем прежний. Только после успешной регистрации отвязываем старый,
// чтобы не оставлять мусор в реестре глобальных горячих клавиш Windows.
function registerHudHotkey(hotkey) {
  if (!hotkey) return false;
  if (hudHotkey === hotkey) return true;

  if (!globalShortcut.register(hotkey, toggleHudEditMode)) return false;

  if (hudHotkey) globalShortcut.unregister(hudHotkey);
  hudHotkey = hotkey;
  return true;
}

// Тот же паттерн для глобального хоткея чата HUD (по умолчанию Control+Shift+L).
function registerChatHudHotkey(hotkey) {
  if (!hotkey) return false;
  if (chatHudHotkey === hotkey) return true;

  if (!globalShortcut.register(hotkey, toggleChatHudMode)) return false;

  if (chatHudHotkey) globalShortcut.unregister(chatHudHotkey);
  chatHudHotkey = hotkey;
  return true;
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;

  // Auto-updates. Only meaningful in packaged builds — `electron-updater`
  // reads the published release feed (app-update.yml) generated by
  // electron-builder, which is absent when running via `npm start`.
  //
  // При старте только ПРОВЕРЯЕМ наличие обновления (без скачивания).
  // Скачивание и установка — только по кнопке «Обновить» в панели управления
  // (см. ipcMain.handle("app:download-and-install")).
  if (app.isPackaged && autoUpdater) {
    autoUpdater.autoDownload = false;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on("update-available", (info) => {
      // Обновление найдено, но НЕ скачивается автоматически — только сообщаем.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("update:available", { version: info.version });
      }
    });

    autoUpdater.on("update-downloaded", (info) => {
      // Обновление скачано. Панель сразу вызывает quitAndInstall(), и приложение
      // перезапускается уже новой версией — ни баннера, ни системного уведомления
      // здесь нет намеренно: они только мелькали перед перезапуском.
      console.log(`[auto-updater] ${info.version} downloaded`);
    });
  }

  // Disable the default application menu so pressing Alt doesn't reveal a
  // menu bar (the overlay/control UI doesn't need it).
  Menu.setApplicationMenu(null);

  // Allow microphone access for the mic-visualizer bridge (the control panel
  // captures audio and forwards levels to the overlay over WebSocket).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });

  configureStorage({ configDir: resolveConfigDir() });
  createSplashWindow();

  db = createDatabase();

  serverHandle = createServer({
    db,
    appName: app.getName(),
    version: app.getVersion(),
    onSetHudHotkey: registerHudHotkey,
    onSetChatHudHotkey: registerChatHudHotkey,
  });

  // Если при загрузке конфига не удалось прочитать какие-то сохранённые секреты
  // (сменился ключ DPAPI/Keychain, конфиг перенесён с другой машины или
  // системное хранилище недоступно) — просим пользователя ввести их заново:
  // иначе ключ выглядит заполненным, а сервис отвечает невнятным invalid_client.
  const secretIssues = getSecretIssues();
  clearSecretIssues();
  if (secretIssues.length) {
    const isRu = db && db.getLanguage() === "ru";
    const describe = (issue) => {
      if (issue.reason === SECRET_ISSUE.LOCKED) {
        return isRu
          ? "системное хранилище секретов недоступно, значение прочитать нельзя"
          : "the system secret storage is unavailable, the value cannot be read";
      }
      return isRu
        ? "не удалось расшифровать: значение зашифровано другим ключом"
        : "decryption failed: the value was encrypted with a different key";
    };
    const lines = secretIssues.map((issue) => `• ${issue.label} — ${describe(issue)}`);
    const message = isRu
      ? `Не удалось прочитать сохранённые секреты:\n${lines.join("\n")}\n\nВведите их заново в разделе «Настройки».`
      : `Could not read the following saved secrets:\n${lines.join("\n")}\n\nRe-enter them in Settings.`;
    dialog.showMessageBox({
      type: "warning",
      title: "Open Stream Environment",
      message: isRu ? "Нужно ввести ключи заново" : "Secrets need to be re-entered",
      detail: message,
      buttons: ["OK"],
    });
  }

  // Если файл состояния был повреждён, оставшийся карантинный файл и бэкап — не
  // служебные детали, а то, что пользователь должен знать: он сам решает,
  // смириться с потерей или доставать данные из карантина.
  const recoveryEvents = getRecoveryEvents();
  clearRecoveryEvents();
  if (recoveryEvents.length) {
    const isRu = db && db.getLanguage() === "ru";
    const detail = recoveryEvents
      .map((event) => {
        const file = path.basename(event.file || "");
        const quarantined = path.basename(event.quarantinePath || "");
        if (event.kind === "restored-from-backup") {
          const backup = path.basename(event.backupPath || "");
          return isRu
            ? `• ${file} был повреждён (${event.reason}); испорченная версия отложена как «${quarantined}», данные восстановлены из «${backup}».`
            : `• ${file} was damaged (${event.reason}); the damaged copy was kept as "${quarantined}" and data was restored from "${backup}".`;
        }
        return isRu
          ? `• ${file} был повреждён (${event.reason}); пригодного бэкапа нет — файл отложен как «${quarantined}», приложение запустилось со значениями по умолчанию.`
          : `• ${file} was damaged (${event.reason}); no usable backup was found — the file was kept as "${quarantined}" and the app started with default values.`;
      })
      .join("\n");
    dialog.showMessageBox({
      type: "warning",
      title: "Open Stream Environment",
      message: isRu ? "Файлы настроек были повреждены" : "Settings files were damaged",
      detail: isRu ? `${detail}\n\nКарантинные файлы лежат рядом с рабочими (каталог данных).` : `${detail}\n\nThe quarantined files are stored next to the live ones (data directory).`,
      buttons: ["OK"],
    });
  }

  const { port } = serverHandle.start();

  // Команда из control-панели (CMD_TOGGLE_HUD_EDIT_MODE) приходит на шину
  // событий сервера; здесь её подхватывает главный процесс, который один
  // умеет переключать setIgnoreMouseEvents у окна оверлея.
  serverHandle.bus.on("hud-edit-toggle", toggleHudEditMode);

  // Смена монитора для HUD-оверлея.
  serverHandle.bus.on("hud-display-changed", onHudDisplayChanged);

  // То же для чата HUD: показ/скрытие, смена монитора и обновление геометрии.
  serverHandle.bus.on("chat-hud-toggle", toggleChatHudMode);
  serverHandle.bus.on("chat-hud-display-changed", onChatHudDisplayChanged);
  serverHandle.bus.on("chat-hud-config-changed", onChatHudConfigChanged);

  // Нативные OS-уведомления о событиях стрима (фоллоу/подписки/донаты),
  // когда панель управления не в фокусе.
  serverHandle.bus.on("alert", onStreamAlert);

  createWindow(port);
  createTray();
  registerGlobalHotkeys();
  registerHudHotkey(serverHandle.state.config.hud_edit_hotkey);
  registerChatHudHotkey(serverHandle.state.config.chat_hud_hotkey);

  // Проверяем наличие обновления при старте (без скачивания). Результат
  // придёт через событие "update-available" и покажет кнопку «Обновить».
  if (app.isPackaged && autoUpdater) {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("[auto-updater] check failed:", err && err.message);
    });
  }

  ipcMain.handle("app:get-info", () => ({
    port: serverHandle.state.config.port,
    overlayUrl: `http://localhost:${serverHandle.state.config.port}/overlay/overlay.html`,
  }));

  ipcMain.handle("app:get-displays", () => {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      label: d.label || "",
      primary: d.id === primaryId,
    }));
  });

  ipcMain.handle("app:open-external", (_event, url) => {
    // Only ever hand http(s) to the OS shell: shell.openExternal also launches
    // file:// and custom protocol handlers, turning a renderer-side link into
    // local code/application execution.
    let parsed;
    try {
      parsed = new URL(String(url || ""));
    } catch {
      return { ok: false, error: "invalid-url" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, error: "unsupported-protocol" };
    }
    shell.openExternal(parsed.toString());
    return { ok: true };
  });

  ipcMain.handle("app:copy-to-clipboard", (_event, text) => {
    clipboard.writeText(String(text ?? ""));
  });

  // Отчёт для поддержки: тот же текст, что отдаёт GET /support-bundle, но
  // пользователь сам выбирает, куда его положить. Секреты в отчёт не попадают
  // (см. server/support-bundle.js) — его можно отправлять как есть.
  ipcMain.handle("app:support-bundle", async () => {
    const isRu = db && db.getLanguage() === "ru";
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const name = `ose-support-${stamp}.txt`;
    let defaultPath = name;
    try {
      defaultPath = path.join(app.getPath("desktop"), name);
    } catch (_) {
      /* в редких окружениях desktop недоступен — оставим имя файла */
    }
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: isRu ? "Сохранить отчёт для поддержки" : "Save the support report",
      defaultPath,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      if (!serverHandle || typeof serverHandle.supportBundleText !== "function") {
        return { ok: false, error: "not-ready" };
      }
      fs.writeFileSync(filePath, serverHandle.supportBundleText(), "utf8");
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle("app:quit-and-install", () => {
    if (!autoUpdater) return false;
    // Перезапускает приложение и применяет уже скачанное обновление.
    autoUpdater.quitAndInstall();
    return true;
  });

  ipcMain.handle("app:download-and-install", async () => {
    if (!autoUpdater || !app.isPackaged) {
      return { ok: false, error: "not_available" };
    }
    try {
      await autoUpdater.downloadUpdate();
      autoUpdater.quitAndInstall();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle("app:check-for-updates", async () => {
    if (!autoUpdater || !app.isPackaged) {
      return { ok: false, error: "not_available" };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      // «Нет обновления» — это тоже объект, и `updateInfo` в нём заполнен
      // текущей версией, поэтому решение принимает parseUpdateCheckResult:
      // по одному лишь наличию updateInfo панель предлагала установленную
      // версию сама себе (на 3.2.6 — «доступно обновление 3.2.6»).
      return { ok: true, ...parseUpdateCheckResult(result) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle("app:open-chat-window", () => {
    openChatWindow(serverHandle.state.config.port);
  });

  ipcMain.handle("app:get-chat-always-on-top", () => {
    return chatPinned;
  });

  ipcMain.handle("app:toggle-chat-always-on-top", () => {
    if (!chatWindow) return false;
    chatPinned = !chatPinned;
    applyChatAlwaysOnTop();
    sendChatAlwaysOnTopState();
    return chatPinned;
  });

  ipcMain.handle("app:change-language", (_event, lang) => {
    const result = serverHandle.setLanguage(lang);
    refreshTrayMenu();
    return result;
  });

  ipcMain.handle("db:get-sessions", () => db.getSessions());
  ipcMain.handle("db:get-chat", (_event, opts) => db.getChat(opts || {}));
  ipcMain.handle("db:get-chat-page", (_event, opts) => db.getChatPage(opts || {}));
  ipcMain.handle("db:get-stream-events", (_event, opts) => serverHandle.getStreamEvents(opts || {}));
  ipcMain.handle("db:clear-stream-events", () => db.clearStreamEvents());
  ipcMain.handle("db:remove-stream-events", (_event, filter) => db.removeStreamEvents(filter || {}));
  ipcMain.handle("db:clear-sessions", () => db.clearSessions());
  ipcMain.handle("db:clear-chat", () => db.clearChat());
  ipcMain.handle("db:get-sessions-with-stats", () => db.getSessionsWithStats());
  ipcMain.handle("db:get-storage-stats", () => db.getStorageStats());
  // Список резервных копий и откат к одной из них (слоты .bak.0…2 ведёт
  // AsyncAtomicStore, описание и проверка — в server/data-integrity.js).
  ipcMain.handle("backup:list", () => (serverHandle ? serverHandle.listBackups() : { config: [], database: [] }));
  ipcMain.handle("backup:restore", (_event, target, slot) =>
    serverHandle ? serverHandle.restoreBackup(target, slot) : { ok: false, error: "not-ready" }
  );

  // Код доступа для клиентов из сети: новый код отключает уже подключённые
  // устройства и меняет адрес пульта (см. state.rotateRemoteToken).
  ipcMain.handle("access:rotate-token", () => (serverHandle ? serverHandle.rotateRemoteToken() : { ok: false, error: "not-ready" }));
  ipcMain.handle("db:open-data-folder", () => shell.openPath(db.getStorageStats().dir));
  ipcMain.handle("db:get-history-limit", () => db.getHistoryLimit());
  ipcMain.handle("db:set-history-limit", (_event, value) => db.setHistoryLimit(value));
  ipcMain.handle("db:get-chat-history-enabled", () => db.getChatHistoryEnabled());
  ipcMain.handle("db:set-chat-history-enabled", (_event, on) => db.setChatHistoryEnabled(on));
  ipcMain.handle("db:reset-all", async () => {
    // Полный сброс БД: раскладка/пресеты/сессии/история возвращаются к дефолтам.
    // Рабочая копия раскладки живёт в памяти сервера, поэтому без перезапуска
    // она вернулась бы в базу при первой же мутации — перезапускаем приложение.
    db.clearAll();
    try {
      await db.flush();
    } catch (_) {
      /* best-effort — перезапускаемся в любом случае */
    }
    if (serverHandle) serverHandle.stop();
    try {
      if (serverHandle && serverHandle.state) serverHandle.state.flushConfigSync();
    } catch (_) {
      /* не мешаем сбросу */
    }
    try {
      db.flushSync();
    } catch (_) {
      /* не мешаем сбросу */
    }
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
  ipcMain.handle("db:export-stream-events", async (_event, opts = {}) => {
    const format = opts.format === "json" ? "json" : "csv";
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Экспорт истории событий",
      defaultPath: `open-stream-environment-events.${format}`,
      filters: format === "json" ? [{ name: "JSON", extensions: ["json"] }] : [{ name: "CSV", extensions: ["csv"] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      const result = db.getStreamEvents({ ...(opts.filter || {}), limit: Number.MAX_SAFE_INTEGER, offset: 0 });
      const items = (result && result.items) || [];
      fs.writeFileSync(filePath, format === "json" ? JSON.stringify(items, null, 2) : eventsToCsv(items), "utf-8");
      return { ok: true, filePath, count: items.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("trigger-event-replay", (_event, id) => serverHandle.replayEvent(id));

  ipcMain.handle("app:open-widget-editor", (_event, widgetId) => {
    openWidgetEditorWindow(serverHandle.state.config.port, widgetId);
  });

  ipcMain.handle("app:open-theme-preview", () => {
    openThemePreviewWindow(serverHandle.state.config.port);
  });

  ipcMain.handle("app:open-theme-samples", () => {
    openThemeSamplesWindow(serverHandle.state.config.port);
  });

  ipcMain.handle("app:open-theme-editor", (_event, init) => {
    openThemeEditorWindow(serverHandle.state.config.port, init);
  });

  ipcMain.handle("theme-editor:get-init", () => themeEditorInit);

  ipcMain.on("app:close-current-window", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
  });

  ipcMain.handle("app:pick-sound-file", async (_event, kind) => {
    const isImage = kind === "image";
    const isVideo = kind === "video";
    const isMedia = kind === "media";
    const filters = isImage
      ? [{ name: "Изображения / GIF", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }]
      : isVideo
        ? [{ name: "Видео", extensions: ["mp4", "webm", "mov"] }]
        : isMedia
          ? [{ name: "Медиа (видео / картинка / GIF)", extensions: ["mp4", "webm", "mov", "png", "jpg", "jpeg", "gif", "webp"] }]
          : [{ name: "Аудио", extensions: ["mp3", "wav", "ogg", "m4a", "aac"] }];
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: isImage ? "Выберите картинку / GIF" : isVideo ? "Выберите видео" : isMedia ? "Выберите медиа (видео / картинку / GIF)" : "Выберите аудиофайл",
      filters,
      properties: ["openFile"],
    });
    if (canceled || !filePaths[0]) return { canceled: true };

    const src = filePaths[0];
    const ext = path.extname(src).toLowerCase();
    const base = (path.basename(src, path.extname(src)) || "sound")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "sound";
    const dir = getUserMediaDir();
    fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, `${base}${ext}`);
    let i = 1;
    while (fs.existsSync(dest)) {
      dest = path.join(dir, `${base}_${i}${ext}`);
      i++;
    }
    fs.copyFileSync(src, dest);
    return { ok: true, relativePath: `media/${path.basename(dest)}` };
  });

  ipcMain.handle("oauth:connect-twitch", (_event, { clientId, clientSecret, channel }) => {
    serverHandle.state.saveTwitchApp({ clientId, clientSecret });
    if (channel) {
      serverHandle.state.setAppConfig({ twitchChannel: channel });
      serverHandle.restartTwitchChat();
      serverHandle.restartChatBot();
    }
    const url = buildTwitchAuthorizeUrl(serverHandle.state.config, serverHandle.state.config.port);
    shell.openExternal(url);
  });

  ipcMain.handle("oauth:connect-donationalerts", (_event, { clientId, clientSecret }) => {
    serverHandle.state.saveDonationAlertsApp({ clientId, clientSecret });
    const url = buildDonationAlertsAuthorizeUrl(serverHandle.state.config, serverHandle.state.config.port);
    shell.openExternal(url);
  });

  ipcMain.handle("oauth:connect-youtube", (_event, { clientId, clientSecret }) => {
    serverHandle.state.saveYoutubeApp({ clientId, clientSecret });
    const url = buildYoutubeAuthorizeUrl(serverHandle.state.config, serverHandle.state.config.port);
    shell.openExternal(url);
  });

  ipcMain.handle("app:export-config", async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Экспорт настроек",
      defaultPath: "open-stream-environment-config.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      const config = {
        ...serverHandle.state.config,
        layout: db.getWidgets(),
        _media: collectMediaForExport(),
      };
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("app:import-config", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: "Импорт настроек",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (canceled || !filePaths[0]) return { ok: false, canceled: true };
    try {
      const raw = fs.readFileSync(filePaths[0], "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed._media && typeof parsed._media === "object") {
        importMedia(parsed._media);
      }
      delete parsed._media;
      serverHandle.importConfig(parsed);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("app:export-theme", async (_event, theme) => {
    const name = String((theme && theme.name) || "theme").replace(/[^\w\- ]+/g, "").trim() || "theme";
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Экспорт темы",
      defaultPath: `${name}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      const payload = { type: "ose-theme", version: 1, name: theme && theme.name, seeds: theme && theme.seeds };
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("app:import-theme", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: "Импорт темы",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (canceled || !filePaths[0]) return { ok: false, canceled: true };
    try {
      const raw = fs.readFileSync(filePaths[0], "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.seeds !== "object") {
        return { ok: false, error: "Неверный формат файла темы" };
      }
      return { ok: true, theme: { name: parsed.name, seeds: parsed.seeds } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on("before-quit", () => {
  quitting = true;
  saveWindowState();
  // stop() завершает сессию и сам пишет в БД, поэтому сбрасываем отложенные
  // async-записи (config.json / local-db.json) ПОСЛЕ остановки сервера.
  if (serverHandle) serverHandle.stop();
  try {
    if (serverHandle && serverHandle.state) serverHandle.state.flushConfigSync();
  } catch (_) {
    /* не мешаем выходу */
  }
  try {
    if (db && typeof db.flushSync === "function") db.flushSync();
  } catch (_) {
    /* не мешаем выходу */
  }
  globalShortcut.unregisterAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
