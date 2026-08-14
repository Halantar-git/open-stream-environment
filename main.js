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
const { app, BrowserWindow, ipcMain, shell, dialog, globalShortcut } = require("electron");

const { createServer } = require("./server");
const { buildTwitchAuthorizeUrl, buildDonationAlertsAuthorizeUrl } = require("./server/oauth");
const { createDatabase } = require("./server/db");

const SPLASH_MIN_MS = 3500; // matches the progress-bar animation duration in splash.html

let mainWindow;
let splashWindow;
let chatWindow = null;
const widgetEditorWindows = new Map(); // widgetId -> BrowserWindow
let serverHandle;
let gameMode = false;

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
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0e0b17",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "control", "control.html"), {
    query: { port: String(port) },
  });

  const splashStartedAt = Date.now();
  mainWindow.once("ready-to-show", () => {
    const elapsed = Date.now() - splashStartedAt;
    const remaining = Math.max(0, SPLASH_MIN_MS - elapsed);
    setTimeout(() => {
      if (splashWindow) splashWindow.destroy();
      mainWindow.show();
    }, remaining);
  });
}

function openChatWindow(port) {
  if (chatWindow) {
    chatWindow.focus();
    return;
  }
  chatWindow = new BrowserWindow({
    width: 380,
    height: 640,
    minWidth: 300,
    minHeight: 320,
    alwaysOnTop: true,
    backgroundColor: "#0e0b17",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "chatwindow", "chat-window-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      spellcheck: false,
    },
  });
  applyPerformanceDefaults(chatWindow, 30);
  chatWindow.loadFile(path.join(__dirname, "chatwindow", "chat-window.html"), {
    query: { port: String(port) },
  });
  chatWindow.on("closed", () => {
    chatWindow = null;
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
    autoHideMenuBar: true,
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

function toggleGameMode() {
  gameMode = !gameMode;

  if (mainWindow) {
    if (gameMode) mainWindow.hide();
    else mainWindow.show();
  }

  if (chatWindow) {
    chatWindow.setAlwaysOnTop(gameMode);
    chatWindow.webContents.setFrameRate(gameMode ? 30 : 60);
  }

  if (serverHandle && serverHandle.broadcast) {
    serverHandle.broadcast("game_mode", { enabled: gameMode });
  }
}

function registerGlobalHotkeys() {
  globalShortcut.register("CommandOrControl+Shift+C", () => {
    if (!chatWindow) return;
    chatWindow.isAlwaysOnTop()
      ? chatWindow.setAlwaysOnTop(false)
      : chatWindow.setAlwaysOnTop(true);
  });

  globalShortcut.register("CommandOrControl+Shift+G", toggleGameMode);
}

app.whenReady().then(() => {
  createSplashWindow();

  const db = createDatabase();

  serverHandle = createServer({ db });
  const { port } = serverHandle.start();

  createWindow(port);
  registerGlobalHotkeys();

  ipcMain.handle("app:get-info", () => ({
    port: serverHandle.state.config.port,
    overlayUrl: `http://localhost:${serverHandle.state.config.port}/overlay/overlay.html`,
  }));

  ipcMain.handle("app:open-external", (_event, url) => {
    shell.openExternal(url);
  });

  ipcMain.handle("app:open-chat-window", () => {
    openChatWindow(serverHandle.state.config.port);
  });

  ipcMain.handle("app:get-chat-always-on-top", () => {
    return !!chatWindow && chatWindow.isAlwaysOnTop();
  });

  ipcMain.handle("app:toggle-chat-always-on-top", () => {
    if (!chatWindow) return false;
    const next = !chatWindow.isAlwaysOnTop();
    chatWindow.setAlwaysOnTop(next);
    return next;
  });

  ipcMain.handle("app:change-language", (_event, lang) => {
    return serverHandle.setLanguage(lang);
  });

  ipcMain.handle("db:get-sessions", () => db.getSessions());
  ipcMain.handle("db:get-chat", (_event, opts) => db.getChat(opts || {}));
  ipcMain.handle("db:get-stream-events", (_event, opts) => serverHandle.getStreamEvents(opts || {}));
  ipcMain.handle("db:clear-stream-events", () => db.clearStreamEvents());
  ipcMain.handle("trigger-event-replay", (_event, id) => serverHandle.replayEvent(id));

  ipcMain.handle("app:open-widget-editor", (_event, widgetId) => {
    openWidgetEditorWindow(serverHandle.state.config.port, widgetId);
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

  ipcMain.handle("app:export-config", async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Экспорт настроек",
      defaultPath: "open-stream-environment-config.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      const config = { ...serverHandle.state.config, layout: db.getWidgets() };
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
  if (serverHandle) serverHandle.stop();
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
