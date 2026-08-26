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
const widgetEditorWindows = new Map(); // widgetId -> BrowserWindow
let serverHandle;
let db;
let gameMode = false;
let chatPinned = true; // выбор пользователя кнопкой 📌
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

function applyPerformanceDefaults(win, fps) {
  win.webContents.setBackgroundThrottling(true);
  if (fps) win.webContents.setFrameRate(fps);
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
  const iconPath = path.join(__dirname, "assets", "icons", "icon.png");
  let icon = nativeImage.createFromPath(iconPath);
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

  serverHandle = createServer({ db });
  const { port } = serverHandle.start();

  createWindow(port);
  createTray();
  registerGlobalHotkeys();

  ipcMain.handle("app:get-info", () => ({
    port: serverHandle.state.config.port,
    overlayUrl: `http://localhost:${serverHandle.state.config.port}/overlay/overlay.html`,
  }));

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

  ipcMain.handle("app:pick-sound-file", async (_event, kind) => {
    const isImage = kind === "image";
    const isVideo = kind === "video";
    const filters = isImage
      ? [{ name: "Изображения / GIF", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }]
      : isVideo
        ? [{ name: "Видео", extensions: ["mp4", "webm", "mov"] }]
        : [{ name: "Аудио", extensions: ["mp3", "wav", "ogg", "m4a", "aac"] }];
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: isImage ? "Выберите картинку / GIF" : isVideo ? "Выберите видео" : "Выберите аудиофайл",
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
