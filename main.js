const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");

const { createServer } = require("./server");
const { buildTwitchAuthorizeUrl, buildDonationAlertsAuthorizeUrl } = require("./server/oauth");
const { CONFIG_PATH } = require("./server/state");

const SPLASH_MIN_MS = 3500; // matches the progress-bar animation duration in splash.html

let mainWindow;
let splashWindow;
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
