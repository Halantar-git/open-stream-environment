const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  getInfo: () => ipcRenderer.invoke("app:get-info"),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  connectTwitch: (creds) => ipcRenderer.invoke("oauth:connect-twitch", creds),
  connectDonationAlerts: (creds) => ipcRenderer.invoke("oauth:connect-donationalerts", creds),
  exportConfig: () => ipcRenderer.invoke("app:export-config"),
  importConfig: () => ipcRenderer.invoke("app:import-config"),
});
