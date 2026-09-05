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
const fs = require("fs");
const { app, BrowserWindow, ipcMain, shell, dialog, globalShortcut, screen, session, clipboard, Tray, Menu, nativeImage, Notification } = require("electron");

const { createServer } = require("./server");
const { buildTwitchAuthorizeUrl, buildDonationAlertsAuthorizeUrl, buildYoutubeAuthorizeUrl } = require("./server/oauth");
const { createDatabase } = require("./server/db");
const { configureStorage, getUserMediaDir, getConfigDir } = require("./server/storage-paths");
const { collectMediaForExport, importMedia } = require("./server/media");

const SPLASH_MIN_MS = 3500; // matches the progress-bar animation duration in splash.html

let mainWindow;
let splashWindow;
let chatWindow = null;
let hudWindow = null;
let chatHudWindow = null;
let themePreviewWindow = null;
let themeSamplesWindow = null;
let cssEditorWindow = null;
let cssEditorInit = { css: "", tokens: [], strings: {} };
let cssEditorParent = null;
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

function openCssEditorWindow(init) {
  cssEditorInit = init || { css: "", tokens: [], strings: {} };
  if (cssEditorWindow) {
    cssEditorWindow.focus();
    cssEditorWindow.webContents.send("css-editor:init", cssEditorInit);
    return;
  }
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#0e0b17",
    webPreferences: {
      preload: path.join(__dirname, "csseditor", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "csseditor", "css-editor.html"));
  win.on("closed", () => {
    cssEditorWindow = null;
    cssEditorInit = { css: "", tokens: [], strings: {} };
  });
  cssEditorWindow = win;
}

function openThemeEditorWindow(port, init) {
  themeEditorInit = init || { theme: null };
  if (themeEditorWindow) {
    themeEditorWindow.focus();
    themeEditorWindow.webContents.send("theme-editor:init", themeEditorInit);
    return;
  }
  const win = new BrowserWindow({
    width: 720,
    height: 820,
    minWidth: 620,
    minHeight: 640,
    backgroundColor: "#0e0b17",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "themeeditor", "theme-editor.html"), {
    query: { port: String(port) },
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

  serverHandle = createServer({ db, onSetHudHotkey: registerHudHotkey, onSetChatHudHotkey: registerChatHudHotkey });
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

  createWindow(port);
  createTray();
  registerGlobalHotkeys();
  registerHudHotkey(serverHandle.state.config.hud_edit_hotkey);
  registerChatHudHotkey(serverHandle.state.config.chat_hud_hotkey);

  ipcMain.handle("app:get-info", () => ({
    port: serverHandle.state.config.port,
    overlayUrl: `http://localhost:${serverHandle.state.config.port}/overlay/overlay.html`,
  }));

  ipcMain.handle("app:get-displays", () => {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      label: d.label || "",
      primary: d.id === primaryId,
    }));
  });

  ipcMain.handle("app:open-external", (_event, url) => {
    shell.openExternal(url);
  });

  ipcMain.handle("app:copy-to-clipboard", (_event, text) => {
    clipboard.writeText(String(text ?? ""));
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
  ipcMain.handle("db:get-stream-events", (_event, opts) => serverHandle.getStreamEvents(opts || {}));
  ipcMain.handle("db:clear-stream-events", () => db.clearStreamEvents());
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

  ipcMain.handle("app:open-css-editor", (event, init) => {
    cssEditorParent = BrowserWindow.fromWebContents(event.sender);
    openCssEditorWindow(init);
  });

  ipcMain.handle("css-editor:get-init", () => cssEditorInit);

  ipcMain.on("css-editor:update", (_event, css) => {
    const target = cssEditorParent && !cssEditorParent.isDestroyed() ? cssEditorParent : mainWindow;
    if (target && !target.isDestroyed()) {
      target.webContents.send("css-editor:updated", css);
    }
  });

  ipcMain.on("css-editor:close", () => {
    if (cssEditorWindow) cssEditorWindow.close();
  });

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
  if (serverHandle) serverHandle.stop();
  globalShortcut.unregisterAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
