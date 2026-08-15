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

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  getInfo: () => ipcRenderer.invoke("app:get-info"),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  connectTwitch: (creds) => ipcRenderer.invoke("oauth:connect-twitch", creds),
  connectDonationAlerts: (creds) => ipcRenderer.invoke("oauth:connect-donationalerts", creds),
  connectYoutube: (creds) => ipcRenderer.invoke("oauth:connect-youtube", creds),
  exportConfig: () => ipcRenderer.invoke("app:export-config"),
  importConfig: () => ipcRenderer.invoke("app:import-config"),
  openChatWindow: () => ipcRenderer.invoke("app:open-chat-window"),
  changeLanguage: (lang) => ipcRenderer.invoke("app:change-language", lang),
  openWidgetEditor: (widgetId) => ipcRenderer.invoke("app:open-widget-editor", widgetId),
  replayEvent: (id) => ipcRenderer.invoke("trigger-event-replay", id),
  db: {
    getSessions: () => ipcRenderer.invoke("db:get-sessions"),
    getChat: (opts) => ipcRenderer.invoke("db:get-chat", opts),
    getStreamEvents: (opts) => ipcRenderer.invoke("db:get-stream-events", opts),
    clearStreamEvents: () => ipcRenderer.invoke("db:clear-stream-events"),
  },
});
