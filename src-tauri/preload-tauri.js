/*
 * Мост `window.desktop.*` для нативной версии (Tauri 2).
 *
 * Замена `preload.js` из Electron: панель, оверлей и окна-редакторы остаются
 * тем же JS и зовут те же методы, а здесь они превращаются в `invoke`.
 * Подключается инициализационным скриптом окна (`lib.rs`), поэтому доступен
 * до первой строки страницы.
 *
 * Готово (см. `src/desktop.rs`, `src/hud.rs`): чтение базы и её сброс, резервные
 * копии (список и откат), адрес оверлея, отчёт для поддержки, окна и редакторы,
 * трей, HUD и глобальные хоткеи, диалоги, буфер обмена, OAuth, обновление и
 * смена языка. Заглушек `not_implemented` больше нет.
 */
(() => {
  const invoke = (command, args) =>
    window.__TAURI__.core.invoke(command, args || {});

  window.desktop = {
    getInfo: () => invoke("get_info"),
    getDisplays: () => invoke("get_displays"),
    openExternal: (url) => invoke("open_external", { url }),
    copyText: (text) => invoke("copy_text", { text }),
    connectTwitch: (creds) => invoke("connect_twitch", { creds }),
    connectDonationAlerts: (creds) => invoke("connect_donation_alerts", { creds }),
    connectYoutube: (creds) => invoke("connect_youtube", { creds }),
    exportConfig: () => invoke("export_config"),
    importConfig: () => invoke("import_config"),
    saveSupportBundle: () => invoke("save_support_bundle"),
    exportTheme: (theme) => invoke("export_theme", { theme: theme ?? null }),
    importTheme: () => invoke("import_theme"),
    openChatWindow: () => invoke("open_chat_window"),
    changeLanguage: (lang) => invoke("change_language", { lang }),
    openWidgetEditor: (widgetId) => invoke("open_widget_editor", { widgetId }),
    openThemePreview: () => invoke("open_theme_preview"),
    openThemeSamples: () => invoke("open_theme_samples"),
    openThemeEditor: (init) => invoke("open_theme_editor", { init: init ?? null }),
    getThemeEditorInit: () => invoke("get_theme_editor_init"),
    onThemeEditorInit: (cb) =>
      window.__TAURI__.event.listen("theme-editor:init", (event) => cb(event.payload)),
    closeCurrentWindow: () => invoke("close_current_window"),
    quitAndInstall: () => invoke("quit_and_install"),
    downloadAndInstall: () => invoke("download_and_install"),
    checkForUpdates: () => invoke("check_for_updates"),
    onUpdateAvailable: (cb) =>
      window.__TAURI__.event.listen("update:available", (event) => cb(event.payload)),
    pickSoundFile: (kind) => invoke("pick_sound_file", { kind: kind ?? null }),
    replayEvent: (id) => invoke("replay_event", { id }),
    db: {
      getSessions: () => invoke("db_get_sessions"),
      getSessionsWithStats: () => invoke("db_get_sessions_with_stats"),
      getChat: (opts) => invoke("db_get_chat", { opts: opts ?? null }),
      getChatPage: (opts) => invoke("db_get_chat_page", { opts: opts ?? null }),
      getStreamEvents: (opts) => invoke("db_get_stream_events", { opts: opts ?? null }),
      removeStreamEvents: (filter) =>
        invoke("db_remove_stream_events", { filter: filter ?? null }),
      clearStreamEvents: () => invoke("db_clear_stream_events"),
      clearSessions: () => invoke("db_clear_sessions"),
      clearChat: () => invoke("db_clear_chat"),
      getStorageStats: () => invoke("db_get_storage_stats"),
      openDataFolder: () => invoke("open_data_folder"),
      getHistoryLimit: () => invoke("db_get_history_limit"),
      setHistoryLimit: (value) => invoke("db_set_history_limit", { value: value ?? null }),
      getChatHistoryEnabled: () => invoke("db_get_chat_history_enabled"),
      setChatHistoryEnabled: (on) => invoke("db_set_chat_history_enabled", { on: !!on }),
      resetAll: () => invoke("db_reset_all"),
      exportStreamEvents: (opts) => invoke("export_stream_events", { opts: opts ?? null }),
    },
    backups: {
      list: () => invoke("backup_list"),
      restore: (target, slot) => invoke("backup_restore", { target, slot }),
    },
    rotateAccessCode: () => invoke("rotate_access_code"),
  };

  // Мост окна чата — замена `chatwindow/chat-window-preload.js`: кнопка 📌
  // закрепления поверх окон и подписка на смену состояния.
  window.chatDesktop = {
    getAlwaysOnTop: () => invoke("get_chat_always_on_top"),
    toggleAlwaysOnTop: () => invoke("toggle_chat_always_on_top"),
    onAlwaysOnTopChanged: (callback) => {
      const unlisten = window.__TAURI__.event.listen(
        "app:chat-always-on-top-changed",
        (event) => callback(!!event.payload),
      );
      return () => unlisten.then((off) => off());
    },
  };
  // F11 — полный экран панели, как `before-input-event` в `main.js`. Шов тот же:
  // нативная подсказка на месте, а вешаем её на страницу панели, не трогая её код.
  if (location.pathname.includes("/control/")) {
    window.addEventListener("keydown", (event) => {
      if (event.key === "F11") {
        event.preventDefault();
        invoke("toggle_fullscreen").catch(() => {});
      }
    });
  }
})();
