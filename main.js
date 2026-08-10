const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");

const { createServer } = require("./server");
const { buildTwitchAuthorizeUrl, buildDonationAlertsAuthorizeUrl } = require("./server/oauth");
const { CONFIG_PATH } = require("./server/state");

const SPLASH_MIN_MS = 3500; // matches the progress-bar animation duration in splash.html

let mainWindow;
let splashWindow;
let chatWindow = null;
const widgetEditorWindows = new Map(); // widgetId -> BrowserWindow
let serverHandle;

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
    backgroundColor: "#0e0b17",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
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

app.whenReady().then(() => {
  createSplashWindow();

  serverHandle = createServer();
  const { port } = serverHandle.start();

  createWindow(port);

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
      fs.copyFileSync(CONFIG_PATH, filePath);
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
