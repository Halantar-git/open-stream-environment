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
  getDisplays: () => ipcRenderer.invoke("app:get-displays"),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  copyText: (text) => ipcRenderer.invoke("app:copy-to-clipboard", text),
  connectTwitch: (creds) => ipcRenderer.invoke("oauth:connect-twitch", creds),
  connectDonationAlerts: (creds) => ipcRenderer.invoke("oauth:connect-donationalerts", creds),
  connectYoutube: (creds) => ipcRenderer.invoke("oauth:connect-youtube", creds),
  exportConfig: () => ipcRenderer.invoke("app:export-config"),
  importConfig: () => ipcRenderer.invoke("app:import-config"),
  // Отчёт для поддержки: окружение, состояние, телеметрия записи, хвост лога и
  // сводка настроек без секретов (server/support-bundle.js).
  saveSupportBundle: () => ipcRenderer.invoke("app:support-bundle"),
  exportTheme: (theme) => ipcRenderer.invoke("app:export-theme", theme),
  importTheme: () => ipcRenderer.invoke("app:import-theme"),
  openChatWindow: () => ipcRenderer.invoke("app:open-chat-window"),
  changeLanguage: (lang) => ipcRenderer.invoke("app:change-language", lang),
  openWidgetEditor: (widgetId) => ipcRenderer.invoke("app:open-widget-editor", widgetId),
  openThemePreview: () => ipcRenderer.invoke("app:open-theme-preview"),
  openThemeSamples: () => ipcRenderer.invoke("app:open-theme-samples"),
  openThemeEditor: (init) => ipcRenderer.invoke("app:open-theme-editor", init),
  getThemeEditorInit: () => ipcRenderer.invoke("theme-editor:get-init"),
  onThemeEditorInit: (cb) => ipcRenderer.on("theme-editor:init", (_event, data) => cb(data)),
  closeCurrentWindow: () => ipcRenderer.send("app:close-current-window"),
  quitAndInstall: () => ipcRenderer.invoke("app:quit-and-install"),
  downloadAndInstall: () => ipcRenderer.invoke("app:download-and-install"),
  checkForUpdates: () => ipcRenderer.invoke("app:check-for-updates"),
  onUpdateAvailable: (cb) => ipcRenderer.on("update:available", (_event, info) => cb(info)),
  pickSoundFile: (kind) => ipcRenderer.invoke("app:pick-sound-file", kind),
  replayEvent: (id) => ipcRenderer.invoke("trigger-event-replay", id),
  db: {
    getSessions: () => ipcRenderer.invoke("db:get-sessions"),
    getSessionsWithStats: () => ipcRenderer.invoke("db:get-sessions-with-stats"),
    getChat: (opts) => ipcRenderer.invoke("db:get-chat", opts),
    getChatPage: (opts) => ipcRenderer.invoke("db:get-chat-page", opts),
    getStreamEvents: (opts) => ipcRenderer.invoke("db:get-stream-events", opts),
    removeStreamEvents: (filter) => ipcRenderer.invoke("db:remove-stream-events", filter),
    clearStreamEvents: () => ipcRenderer.invoke("db:clear-stream-events"),
    clearSessions: () => ipcRenderer.invoke("db:clear-sessions"),
    clearChat: () => ipcRenderer.invoke("db:clear-chat"),
    getStorageStats: () => ipcRenderer.invoke("db:get-storage-stats"),
    openDataFolder: () => ipcRenderer.invoke("db:open-data-folder"),
    getHistoryLimit: () => ipcRenderer.invoke("db:get-history-limit"),
    setHistoryLimit: (value) => ipcRenderer.invoke("db:set-history-limit", value),
    getChatHistoryEnabled: () => ipcRenderer.invoke("db:get-chat-history-enabled"),
    setChatHistoryEnabled: (on) => ipcRenderer.invoke("db:set-chat-history-enabled", on),
    resetAll: () => ipcRenderer.invoke("db:reset-all"),
    exportStreamEvents: (opts) => ipcRenderer.invoke("db:export-stream-events", opts),
  },
  // Резервные копии настроек/базы: список и откат к выбранной.
  backups: {
    list: () => ipcRenderer.invoke("backup:list"),
    restore: (target, slot) => ipcRenderer.invoke("backup:restore", target, slot),
  },
  // Доступ из локальной сети: новый код для пульта и сторонних скриптов.
  rotateAccessCode: () => ipcRenderer.invoke("access:rotate-token"),
});
