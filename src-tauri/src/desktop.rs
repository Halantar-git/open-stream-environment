//! Слой оболочки: `window.desktop.*` из `preload.js` в терминах Tauri.
//!
//! Порт `main.js` в той части, где окно панели просит главный процесс: чтение
//! базы, список резервных копий, адрес оверлея, окна, диалоги, буфер обмена,
//! внешние ссылки и обновление. Трей, хоткеи и окна поверх игры живут в
//! `hud.rs`/`lib.rs`, а сюда попадают команды моста `window.desktop.*`.
//!
//! Команды возвращают JSON: фронт остаётся JS и ждёт те же формы, что отдавал
//! `ipcMain.handle` в Electron. Имена команд — с подчёркиваниями (так их зовёт
//! `preload-tauri.js`), потому что в Tauri `invoke` работает по имени функции.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use crate::diagnostics::Diagnostics;
use crate::hud::Hud;
use crate::storage::history::js_truthy;
use crate::storage::history::{Page, QueryOptions};

/// Состояние, доступное командам оболочки.
pub struct DesktopState {
    pub diagnostics: Arc<Diagnostics>,
    /// Что отдать редактору тем при открытии — как `themeEditorInit` в JS.
    pub theme_editor_init: Mutex<Value>,
}

/// `app:get-info` — порт и адрес оверлея для панели.
///
/// Порт берётся из диагностики на момент вызова: после смены порта на ходу
/// панель должна увидеть новый адрес (по нему она и переподключается).
#[tauri::command]
pub fn get_info(state: tauri::State<'_, DesktopState>) -> Value {
    let port = state.diagnostics.port();
    json!({
        "port": port,
        "overlayUrl": format!("http://localhost:{port}/overlay/overlay.html"),
    })
}

/// `app:get-displays` — экраны для выбора HUD/чата поверх игры.
///
/// У монитора в Tauri нет числового `id`, как у `screen.getAllDisplays()` в
/// Electron, поэтому и `id`, и `label` — его имя (оно же ключ выбора).
#[tauri::command]
pub fn get_displays(window: tauri::Window) -> Value {
    let primary = window
        .primary_monitor()
        .ok()
        .flatten()
        .and_then(|monitor| monitor.name().cloned());
    let monitors = window.available_monitors().unwrap_or_default();
    Value::Array(
        monitors
            .iter()
            .map(|monitor| {
                let name = monitor.name().cloned().unwrap_or_default();
                json!({
                    "id": name,
                    "label": name,
                    "primary": primary.as_deref() == Some(name.as_str()),
                })
            })
            .collect(),
    )
}

/// `db:get-sessions`.
#[tauri::command]
pub fn db_get_sessions(state: tauri::State<'_, DesktopState>) -> Value {
    Value::Array(state.diagnostics.database().sessions())
}

/// `db:get-sessions-with-stats`.
#[tauri::command]
pub fn db_get_sessions_with_stats(state: tauri::State<'_, DesktopState>) -> Value {
    Value::Array(state.diagnostics.database().sessions_with_stats())
}

/// `db:get-chat` — вся история чата или только одной сессии.
#[tauri::command]
pub fn db_get_chat(state: tauri::State<'_, DesktopState>, opts: Option<Value>) -> Value {
    // Как `if (opts.sessionId)`: пустая строка/`0`/`null` — фильтра нет.
    let session_id = opts
        .as_ref()
        .and_then(|opts| opts.get("sessionId"))
        .filter(|value| js_truthy(Some(*value)));
    Value::Array(state.diagnostics.database().chat(session_id))
}

/// `db:get-chat-page` — страница истории чата.
#[tauri::command]
pub fn db_get_chat_page(state: tauri::State<'_, DesktopState>, opts: Option<Value>) -> Value {
    page_json(&state.diagnostics.database().chat_page(&options(opts)))
}

/// `db:get-stream-events` — страница истории событий.
#[tauri::command]
pub fn db_get_stream_events(state: tauri::State<'_, DesktopState>, opts: Option<Value>) -> Value {
    page_json(&state.diagnostics.database().stream_events(&options(opts)))
}

/// `db:remove-stream-events` — удалить события по фильтру, вернуть число.
#[tauri::command]
pub fn db_remove_stream_events(
    state: tauri::State<'_, DesktopState>,
    filter: Option<Value>,
) -> Value {
    json!(state
        .diagnostics
        .database()
        .remove_stream_events(&options(filter)))
}

/// `db:clear-stream-events`.
#[tauri::command]
pub fn db_clear_stream_events(state: tauri::State<'_, DesktopState>) -> Value {
    json!(state.diagnostics.database().clear_stream_events())
}

/// `db:clear-sessions`.
#[tauri::command]
pub fn db_clear_sessions(state: tauri::State<'_, DesktopState>) -> Value {
    json!(state.diagnostics.database().clear_sessions())
}

/// `db:clear-chat`.
#[tauri::command]
pub fn db_clear_chat(state: tauri::State<'_, DesktopState>) -> Value {
    json!(state.diagnostics.database().clear_chat())
}

/// `db:get-storage-stats`.
#[tauri::command]
pub fn db_get_storage_stats(state: tauri::State<'_, DesktopState>) -> Value {
    state.diagnostics.database().storage_stats()
}

/// `db:get-history-limit`.
#[tauri::command]
pub fn db_get_history_limit(state: tauri::State<'_, DesktopState>) -> Value {
    json!(state.diagnostics.database().history_limit())
}

/// `db:set-history-limit` — `0` или `null` снимают лимит; вернуть новый.
#[tauri::command]
pub fn db_set_history_limit(state: tauri::State<'_, DesktopState>, value: Option<Value>) -> Value {
    // `resolveMaxRecords` из JS: `0`/`false`/`null` — без лимита, отсутствие —
    // умолчание, положительное — мягкий предел, отрицательное/мусор — умолчание.
    let limit = match value {
        None => None,
        Some(Value::Null) | Some(Value::Bool(false)) => Some(0),
        Some(Value::Number(number)) => match number.as_f64() {
            Some(0.0) => Some(0),
            Some(n) if n > 0.0 && n.is_finite() => Some(n.floor() as usize),
            _ => None,
        },
        _ => None,
    };
    json!(state.diagnostics.database().set_history_limit(limit))
}

/// `db:get-chat-history-enabled`.
#[tauri::command]
pub fn db_get_chat_history_enabled(state: tauri::State<'_, DesktopState>) -> Value {
    json!(state.diagnostics.database().chat_history_enabled())
}

/// `db:set-chat-history-enabled`.
#[tauri::command]
pub fn db_set_chat_history_enabled(state: tauri::State<'_, DesktopState>, on: bool) -> Value {
    json!(state.diagnostics.database().set_chat_history_enabled(on))
}

/// `backup:list` — слоты резервных копий настроек и базы (`{config, database}`).
#[tauri::command]
pub fn backup_list(state: tauri::State<'_, DesktopState>) -> Value {
    json!({
        "config": state.diagnostics.list_config_backups(),
        "database": state.diagnostics.database().list_backups(),
    })
}

/// `backup:restore` — откат настроек или базы к слоту резервной копии.
#[tauri::command]
pub fn backup_restore(state: tauri::State<'_, DesktopState>, target: Value, slot: Value) -> Value {
    let target = target.as_str().unwrap_or_default();
    // Номер копии — целое неотрицательное, как `Number.isInteger(index) && index >= 0`.
    let Some(slot) = slot.as_u64() else {
        return json!({ "ok": false, "error": "неверный номер копии" });
    };
    state.diagnostics.restore_backup(target, slot as usize)
}

/// `trigger-event-replay` — повторить событие из истории (запись или `null`).
#[tauri::command]
pub fn replay_event(state: tauri::State<'_, DesktopState>, id: Value) -> Value {
    state.diagnostics.replay_event(&id)
}

/// `db:reset-all` — полный сброс базы и перезапуск приложения.
#[tauri::command]
pub fn db_reset_all(app: tauri::AppHandle, state: tauri::State<'_, DesktopState>) -> Value {
    state.diagnostics.reset_database();
    app.restart();
}

/// `app:open-chat-window` — окно чата поверх игры.
#[tauri::command]
pub fn open_chat_window(app: tauri::AppHandle, state: tauri::State<'_, DesktopState>) -> Value {
    if focus_existing(&app, "chat") {
        return json!({ "ok": true });
    }
    let port = state.diagnostics.port().to_string();
    open_window(
        &app,
        "chat",
        page_url(
            state.diagnostics.port(),
            "/chatwindow/chat-window.html",
            &[("port", &port)],
        ),
        (380.0, 640.0),
        (300.0, 320.0),
        true,
        false,
    )
}

/// `app:open-widget-editor` — отдельное окно на виджет.
#[tauri::command]
pub fn open_widget_editor(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    widget_id: Value,
) -> Value {
    let id = widget_id.as_str().unwrap_or_default();
    let label = format!("widget-editor-{}", sanitize_label(id));
    if focus_existing(&app, &label) {
        return json!({ "ok": true });
    }
    let port = state.diagnostics.port().to_string();
    open_window(
        &app,
        &label,
        page_url(
            state.diagnostics.port(),
            "/widgeteditor/widget-editor.html",
            &[("port", &port), ("widgetId", id)],
        ),
        (900.0, 680.0),
        (640.0, 480.0),
        false,
        false,
    )
}

/// `app:open-theme-preview` — живой оверлей с черновиком темы.
#[tauri::command]
pub fn open_theme_preview(app: tauri::AppHandle, state: tauri::State<'_, DesktopState>) -> Value {
    if focus_existing(&app, "theme-preview") {
        return json!({ "ok": true });
    }
    open_window(
        &app,
        "theme-preview",
        page_url(
            state.diagnostics.port(),
            "/overlay/overlay.html",
            &[("themePreview", "1")],
        ),
        (1280.0, 720.0),
        (640.0, 360.0),
        false,
        false,
    )
}

/// `app:open-theme-samples` — все виджеты во всех формах.
#[tauri::command]
pub fn open_theme_samples(app: tauri::AppHandle, state: tauri::State<'_, DesktopState>) -> Value {
    if focus_existing(&app, "theme-samples") {
        return json!({ "ok": true });
    }
    open_window(
        &app,
        "theme-samples",
        page_url(state.diagnostics.port(), "/overlay/samples.html", &[]),
        (720.0, 900.0),
        (480.0, 640.0),
        false,
        false,
    )
}

/// `app:open-theme-editor` — окно редактора тем (разворачивается, как в JS).
#[tauri::command]
pub fn open_theme_editor(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    init: Option<Value>,
) -> Value {
    let init = init.unwrap_or_else(|| json!({ "theme": null }));
    *state
        .theme_editor_init
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = init.clone();
    if focus_existing(&app, "theme-editor") {
        let _ = app.emit_to("theme-editor", "theme-editor:init", init);
        return json!({ "ok": true });
    }
    let port = state.diagnostics.port().to_string();
    open_window(
        &app,
        "theme-editor",
        page_url(
            state.diagnostics.port(),
            "/themeeditor/theme-editor.html",
            &[("port", &port)],
        ),
        (1320.0, 900.0),
        (1040.0, 640.0),
        false,
        true,
    )
}

/// `theme-editor:get-init` — что редактор должен применить при открытии.
#[tauri::command]
pub fn get_theme_editor_init(state: tauri::State<'_, DesktopState>) -> Value {
    state
        .theme_editor_init
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

/// `app:close-current-window` — закрыть окно, из которого пришёл вызов.
#[tauri::command]
pub fn close_current_window(window: tauri::WebviewWindow) {
    let _ = window.close();
}

/// `app:get-chat-always-on-top` — закреплён ли чат поверх окон (кнопка 📌).
#[tauri::command]
pub fn get_chat_always_on_top(app: tauri::AppHandle) -> Value {
    match app.try_state::<Arc<Hud>>() {
        Some(hud) => Value::Bool(hud.chat_pinned()),
        // Без оболочки чат считается закреплённым — как `chatPinned = true`.
        None => Value::Bool(true),
    }
}

/// `app:toggle-chat-always-on-top` — переключить закрепление чата.
#[tauri::command]
pub fn toggle_chat_always_on_top(app: tauri::AppHandle) -> Value {
    match app.try_state::<Arc<Hud>>() {
        Some(hud) => Value::Bool(hud.toggle_chat_pin()),
        None => Value::Bool(false),
    }
}

/// `app:check-for-updates` — проверить наличие обновления без скачивания.
///
/// Без настроенного фида (`plugins.updater` в `tauri.conf.json`) проверка
/// недоступна — панель по этому ответу показывает «обновление недоступно».
#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<Value, String> {
    let Ok(updater) = app.updater() else {
        return Ok(json!({ "ok": false, "error": "not_available" }));
    };
    match updater.check().await {
        Ok(Some(update)) => Ok(json!({
            "ok": true,
            "updateAvailable": true,
            "version": update.version,
        })),
        Ok(None) => Ok(json!({
            "ok": true,
            "updateAvailable": false,
            "version": Value::Null,
        })),
        Err(error) => Ok(json!({ "ok": false, "error": error.to_string() })),
    }
}

/// `app:download-and-install` — скачать и установить обновление.
#[tauri::command]
pub async fn download_and_install(app: tauri::AppHandle) -> Result<Value, String> {
    let Ok(updater) = app.updater() else {
        return Ok(json!({ "ok": false, "error": "not_available" }));
    };
    match updater.check().await {
        Ok(Some(update)) => match update.download_and_install(|_, _| {}, || {}).await {
            Ok(()) => {
                // На Windows установщик сам перезапускает приложение; на прочих
                // платформах это делаем мы — как `quitAndInstall` в JS.
                #[cfg(not(target_os = "windows"))]
                app.restart();
                Ok(json!({ "ok": true }))
            }
            Err(error) => Ok(json!({ "ok": false, "error": error.to_string() })),
        },
        Ok(None) => Ok(json!({ "ok": false, "error": "not_available" })),
        Err(error) => Ok(json!({ "ok": false, "error": error.to_string() })),
    }
}

/// `app:quit-and-install` — применить обновление.
///
/// Фонового скачивания в Tauri-версии нет, поэтому это тот же путь, что у
/// `downloadAndInstall`: проверить и установить.
#[tauri::command]
pub async fn quit_and_install(app: tauri::AppHandle) -> Result<Value, String> {
    download_and_install(app).await
}

/// Стартовая проверка обновления (без скачивания).
///
/// Возвращает полезную нагрузку события `update:available`, если обновление есть
/// и фид настроен, — как стартовая проверка `autoUpdater` в `main.js`.
pub async fn startup_update_notice(app: &tauri::AppHandle) -> Option<Value> {
    let updater = app.updater().ok()?;
    let update = updater.check().await.ok()??;
    Some(json!({ "version": update.version }))
}

/// `app:change-language` — смена языка: словари уходят клиентам кадром `locales`,
/// меню трея перерисовывается — как `setLanguage` + `refreshTrayMenu` в JS.
#[tauri::command]
pub fn change_language(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    lang: Value,
) -> Value {
    let saved = state
        .diagnostics
        .save_language(lang.as_str().unwrap_or_default());
    if let Some(locales) = crate::server::locales::Locales::load(&crate::repository_root()) {
        state.diagnostics.broadcast(
            crate::protocol::event_types::LOCALES,
            locales.payload(saved),
        );
    }
    crate::refresh_tray_menu(&app, saved);
    json!(saved)
}

/// `access:rotate-token` — новый код доступа; старый сразу перестаёт работать.
#[tauri::command]
pub fn rotate_access_code(state: tauri::State<'_, DesktopState>) -> Value {
    state.diagnostics.rotate_access_code()
}

/// `app:copy-to-clipboard` — как `clipboard.writeText` в Electron.
#[tauri::command]
pub fn copy_text(app: tauri::AppHandle, text: Value) -> Value {
    let text = text
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| crate::state::js_string(&text));
    match app.clipboard().write_text(text) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

/// `app:open-external` — в систему отдаём только `http(s)`, как в JS.
#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: Value) -> Value {
    let raw = url.as_str().unwrap_or_default();
    let Ok(parsed) = tauri::Url::parse(raw) else {
        return json!({ "ok": false, "error": "invalid-url" });
    };
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return json!({ "ok": false, "error": "unsupported-protocol" });
    }
    match app.opener().open_url(parsed.to_string(), None::<&str>) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

/// `db:open-data-folder` — открыть папку данных в проводнике.
#[tauri::command]
pub fn open_data_folder(app: tauri::AppHandle, state: tauri::State<'_, DesktopState>) -> Value {
    let dir = state.diagnostics.database().storage_stats()["dir"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| {
            state
                .diagnostics
                .storage()
                .config_dir()
                .to_string_lossy()
                .into_owned()
        });
    match app.opener().open_path(dir, None::<&str>) {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

/// `app:export-config` — настройки + раскладка + медиа.
#[tauri::command]
pub async fn export_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<Value, String> {
    let Some(path) = save_path(
        &app,
        "Экспорт настроек",
        "open-stream-environment-config.json",
        "json",
    )
    .await
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let (config, layout, media) = {
        let config = state.diagnostics.config();
        (
            Value::Object(config.value().clone()),
            state.diagnostics.database().widgets(),
            crate::storage::media::collect_media_for_export(
                &state.diagnostics.storage().media_dir(),
            ),
        )
    };
    let mut payload = match config {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    payload.insert("layout".to_string(), Value::Array(layout));
    payload.insert("_media".to_string(), Value::Object(media));
    let body = serde_json::to_string_pretty(&Value::Object(payload)).unwrap_or_default();
    Ok(written(&path, body))
}

/// `app:import-config` — прочитать чужой файл настроек и применить его.
#[tauri::command]
pub async fn import_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<Value, String> {
    let Some(path) = open_path(&app, "Импорт настроек", &["json"]).await else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    let mut parsed: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    // Медиа из экспорта кладём на диск до применения настроек.
    if let Value::Object(map) = &mut parsed {
        if let Some(Value::Object(media)) = map.remove("_media") {
            crate::storage::media::import_media(&state.diagnostics.storage().media_dir(), &media);
        }
    }
    state.diagnostics.import_config(&parsed);
    Ok(json!({ "ok": true }))
}

/// `app:export-theme` — тема в файл формата `ose-theme`.
#[tauri::command]
pub async fn export_theme(app: tauri::AppHandle, theme: Option<Value>) -> Result<Value, String> {
    let theme = theme.unwrap_or_else(|| json!({}));
    let name = theme_name(theme.get("name"));
    let Some(path) = save_path(&app, "Экспорт темы", &format!("{name}.json"), "json").await
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let payload = json!({
        "type": "ose-theme",
        "version": 1,
        "name": theme.get("name").cloned().unwrap_or(Value::Null),
        "seeds": theme.get("seeds").cloned().unwrap_or(Value::Null),
    });
    Ok(written(
        &path,
        serde_json::to_string_pretty(&payload).unwrap_or_default(),
    ))
}

/// `app:import-theme` — прочитать файл темы (черновик отдаётся панели).
#[tauri::command]
pub async fn import_theme(app: tauri::AppHandle) -> Result<Value, String> {
    let Some(path) = open_path(&app, "Импорт темы", &["json"]).await else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    let seeds = parsed.get("seeds");
    if !seeds.map(Value::is_object).unwrap_or(false) {
        return Ok(json!({ "ok": false, "error": "Неверный формат файла темы" }));
    }
    Ok(json!({
        "ok": true,
        "theme": {
            "name": parsed.get("name").cloned().unwrap_or(Value::Null),
            "seeds": seeds.cloned().unwrap_or(Value::Null),
        },
    }))
}

/// `app:pick-sound-file` — выбрать файл и положить его в каталог медиа.
#[tauri::command]
pub async fn pick_sound_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    kind: Option<Value>,
) -> Result<Value, String> {
    let kind = kind.as_ref().and_then(Value::as_str).unwrap_or("");
    let (title, exts): (&str, Vec<&str>) = match kind {
        "image" => (
            "Выберите картинку / GIF",
            vec!["png", "jpg", "jpeg", "gif", "webp"],
        ),
        "video" => ("Выберите видео", vec!["mp4", "webm", "mov"]),
        "media" => (
            "Выберите медиа (видео / картинку / GIF)",
            vec!["mp4", "webm", "mov", "png", "jpg", "jpeg", "gif", "webp"],
        ),
        _ => (
            "Выберите аудиофайл",
            vec!["mp3", "wav", "ogg", "m4a", "aac"],
        ),
    };
    let Some(src) = open_path(&app, title, &exts).await else {
        return Ok(json!({ "canceled": true }));
    };
    let ext = src
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    let stem = src
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let base = media_base(&stem);
    let dir = state.diagnostics.storage().media_dir();
    if let Err(error) = std::fs::create_dir_all(&dir) {
        return Ok(json!({ "ok": false, "error": error.to_string() }));
    }
    let mut dest = dir.join(format!("{base}{ext}"));
    let mut index = 1;
    while dest.exists() {
        dest = dir.join(format!("{base}_{index}{ext}"));
        index += 1;
    }
    if let Err(error) = std::fs::copy(&src, &dest) {
        return Ok(json!({ "ok": false, "error": error.to_string() }));
    }
    let name = dest
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(json!({ "ok": true, "relativePath": format!("media/{name}") }))
}

/// `oauth:connect-twitch` — сохранить ключи, перезапустить чат и открыть браузер.
#[tauri::command]
pub fn connect_twitch(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    creds: Value,
) -> Value {
    {
        let mut config = state.diagnostics.config();
        crate::state::config::save_twitch_app(&mut config, &app_keys(&creds));
        if let Some(channel) = creds.get("channel").filter(|value| js_truthy(Some(value))) {
            crate::state::config::set_app_config(&mut config, &json!({ "twitchChannel": channel }));
        }
    }
    // Перезапускаем службы только если канал задан (truthy), как в `main.js`.
    if creds
        .get("channel")
        .filter(|value| js_truthy(Some(value)))
        .is_some()
    {
        state.diagnostics.restart_twitch_chat();
        state.diagnostics.restart_chat_bot();
    }
    let config = Value::Object(state.diagnostics.config().value().clone());
    let url = crate::server::oauth::build_twitch_authorize_url(
        &config,
        state.diagnostics.port(),
        crate::server::oauth::pending(),
    );
    open_authorize(&app, url)
}

/// `oauth:connect-donationalerts`.
#[tauri::command]
pub fn connect_donation_alerts(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    creds: Value,
) -> Value {
    {
        let mut config = state.diagnostics.config();
        crate::state::config::save_donation_alerts_app(&mut config, &app_keys(&creds));
    }
    let config = Value::Object(state.diagnostics.config().value().clone());
    let url = crate::server::oauth::build_donation_alerts_authorize_url(
        &config,
        state.diagnostics.port(),
        crate::server::oauth::pending(),
    );
    open_authorize(&app, url)
}

/// `oauth:connect-youtube`.
#[tauri::command]
pub fn connect_youtube(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    creds: Value,
) -> Value {
    {
        let mut config = state.diagnostics.config();
        crate::state::config::save_youtube_app(&mut config, &app_keys(&creds));
    }
    let config = Value::Object(state.diagnostics.config().value().clone());
    let url = crate::server::oauth::build_youtube_authorize_url(
        &config,
        state.diagnostics.port(),
        crate::server::oauth::pending(),
    );
    open_authorize(&app, url)
}

/// Ключи приложения из присланного объекта — как `save*App` их ждёт.
fn app_keys(creds: &Value) -> Value {
    json!({
        "clientId": creds.get("clientId").cloned().unwrap_or(Value::Null),
        "clientSecret": creds.get("clientSecret").cloned().unwrap_or(Value::Null),
    })
}

/// Открыть адрес авторизации в системном браузере.
fn open_authorize(app: &tauri::AppHandle, url: String) -> Value {
    match app.opener().open_url(url.clone(), None::<&str>) {
        Ok(()) => json!({ "ok": true, "url": url }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

/// `app:support-bundle` как текст — тот же отчёт, что отдаёт `/support-bundle`.
#[tauri::command]
pub fn support_bundle_text(state: tauri::State<'_, DesktopState>) -> String {
    state
        .diagnostics
        .support_bundle_text(state.diagnostics.port(), true)
}

/// F11 — полный экран панели, как перехват клавиши в `main.js`.
#[tauri::command]
pub fn toggle_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    let next = !window.is_fullscreen().map_err(|error| error.to_string())?;
    window
        .set_fullscreen(next)
        .map_err(|error| error.to_string())?;
    Ok(next)
}

/// Нативное уведомление о событии стрима — порт `onStreamAlert` из `main.js`.
///
/// Реальные события не дублируем, когда панель в фокусе (там свой тост), а
/// тестовые показываем всегда — чтобы кнопку можно было проверить.
pub fn notify_stream_alert(app: &tauri::AppHandle, alert: &Value) {
    let kind = alert.get("kind").and_then(Value::as_str).unwrap_or("");
    if !matches!(
        kind,
        "follow" | "sub" | "gift_sub" | "cheer" | "donation" | "reward"
    ) {
        return;
    }
    if !js_truthy(alert.get("isTest")) {
        if let Some(window) = app.get_webview_window("main") {
            if window.is_focused().unwrap_or(false) {
                return;
            }
        }
    }
    let is_ru = app
        .try_state::<DesktopState>()
        .map(|state| state.diagnostics.language() == "ru")
        .unwrap_or(false);
    let (title, body) = format_stream_alert(alert, is_ru);
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Заголовок и текст уведомления по алерту — порт `formatStreamAlert`.
fn format_stream_alert(alert: &Value, is_ru: bool) -> (String, String) {
    let kind = alert.get("kind").and_then(Value::as_str).unwrap_or("");
    let user = match alert.get("user") {
        Some(value) if js_truthy(Some(value)) => crate::state::js_string(value),
        _ => String::new(),
    };
    let mut title = "Open Stream Environment".to_string();
    let mut body = user.clone();

    // `alert.count ?? alert.amount ?? 1` и `alert.amount ?? 0`.
    let number = |keys: &[&str], fallback: f64| {
        keys.iter()
            .find_map(|key| alert.get(*key).filter(|value| !value.is_null()))
            .map(|value| crate::storage::history::js_number(Some(value)))
            .unwrap_or(fallback)
    };
    let text = |key: &str| {
        alert
            .get(key)
            .filter(|value| js_truthy(Some(value)))
            .map(crate::state::js_string)
    };

    match kind {
        "follow" => {
            title = if is_ru {
                "Новый фолловер"
            } else {
                "New follower"
            }
            .to_string()
        }
        "sub" => {
            title = if is_ru {
                "Новая подписка"
            } else {
                "New subscription"
            }
            .to_string()
        }
        "gift_sub" => {
            let count = js_number_text(number(&["count", "amount"], 1.0));
            title = if is_ru {
                "Гифт-подписка"
            } else {
                "Gift subscription"
            }
            .to_string();
            body = if user.is_empty() {
                format!("× {count}")
            } else {
                format!("{user} × {count}")
            };
        }
        "cheer" => {
            let bits = js_number_text(number(&["amount"], 0.0));
            title = if is_ru {
                "Чир (биты)"
            } else {
                "Cheer (bits)"
            }
            .to_string();
            let unit = if is_ru { "бит" } else { "bits" };
            body = if user.is_empty() {
                format!("{bits} {unit}")
            } else {
                format!("{user} · {bits} {unit}")
            };
        }
        "donation" => {
            title = if is_ru {
                "Новый донат"
            } else {
                "New donation"
            }
            .to_string();
            let mut parts: Vec<String> = Vec::new();
            if !user.is_empty() {
                parts.push(user.clone());
            }
            if let Some(amount) = alert.get("amount").and_then(Value::as_f64) {
                let currency = text("currency").unwrap_or_default();
                parts.push(
                    format!("{} {}", js_number_text(amount), currency.trim())
                        .trim()
                        .to_string(),
                );
            }
            if let Some(message) = text("message") {
                parts.push(message);
            }
            body = parts.join(" · ");
        }
        "reward" => {
            title = if is_ru {
                "Награда канала"
            } else {
                "Channel reward"
            }
            .to_string();
            let mut parts: Vec<String> = Vec::new();
            if let Some(reward) = text("rewardTitle") {
                parts.push(reward);
            }
            if !user.is_empty() {
                parts.push(user.clone());
            }
            if let Some(message) = text("message") {
                parts.push(message);
            }
            body = parts.join(" · ");
        }
        _ => {}
    }
    (title, body)
}

/// Число как его напечатал бы JS в шаблоне: `3`, а не `3.0`.
fn js_number_text(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// `app:support-bundle` с выбором файла — текст отчёта кладётся на диск.
#[tauri::command]
pub async fn save_support_bundle(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<Value, String> {
    // Имя файла как в JS: UTC и без `T` (`toISOString().slice(0,19)` + замена
    // `[:T]` на `-`).
    let stamp = chrono::Utc::now().format("%Y-%m-%d-%H-%M-%S");
    let Some(path) = save_path(
        &app,
        "Отчёт для поддержки",
        &format!("ose-support-{stamp}.txt"),
        "txt",
    )
    .await
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let text = state
        .diagnostics
        .support_bundle_text(state.diagnostics.port(), true);
    Ok(match std::fs::write(&path, text) {
        // Ключ `path` — его читает панель (`res.path`), как в `main.js`.
        Ok(()) => json!({ "ok": true, "path": path.to_string_lossy() }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    })
}

/// `db:export-stream-events` — история событий в CSV или JSON.
#[tauri::command]
pub async fn export_stream_events(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    opts: Option<Value>,
) -> Result<Value, String> {
    let is_json = opts
        .as_ref()
        .and_then(|opts| opts.get("format"))
        .and_then(Value::as_str)
        == Some("json");
    let (ext, filter) = if is_json {
        ("json", "JSON")
    } else {
        ("csv", "CSV")
    };
    let name = format!("open-stream-environment-events.{ext}");
    let Some(path) = save_path(&app, "Экспорт истории событий", &name, filter).await
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };

    // Событий может быть много — берём всю историю того же фильтра, что даёт
    // панель (`limit`/`offset` снимаются, как `Number.MAX_SAFE_INTEGER` в JS).
    let mut query = opts
        .as_ref()
        .and_then(|opts| opts.get("filter"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Value::Object(map) = &mut query {
        map.insert("limit".to_string(), json!(9_007_199_254_740_991u64));
        map.insert("offset".to_string(), json!(0));
    }
    let items = state
        .diagnostics
        .database()
        .stream_events(&QueryOptions::from_json(&query))
        .items;
    let body = if is_json {
        serde_json::to_string_pretty(&Value::Array(items.clone())).unwrap_or_default()
    } else {
        crate::storage::export::events_to_csv(&items)
    };
    Ok(match std::fs::write(&path, body) {
        Ok(()) => json!({ "ok": true, "filePath": path.to_string_lossy(), "count": items.len() }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    })
}

/// Разобрать запрос из JS: `null` — как пустой объект.
fn options(opts: Option<Value>) -> QueryOptions {
    let empty = Value::Null;
    QueryOptions::from_json(opts.as_ref().unwrap_or(&empty))
}

/// Адрес страницы окна на нашем же сервере (окна грузятся по HTTP, как панель).
fn page_url(port: u16, path: &str, query: &[(&str, &str)]) -> tauri::Url {
    let mut url = tauri::Url::parse(&format!("http://127.0.0.1:{port}{path}")).expect("адрес окна");
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    url
}

/// Сфокусировать уже открытое окно; `true` — оно было.
fn focus_existing(app: &tauri::AppHandle, label: &str) -> bool {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.set_focus();
        true
    } else {
        false
    }
}

/// Открыть окно с уже подставленным мостом `window.desktop`.
#[allow(clippy::too_many_arguments)]
fn open_window(
    app: &tauri::AppHandle,
    label: &str,
    url: tauri::Url,
    size: (f64, f64),
    min: (f64, f64),
    top: bool,
    maximized: bool,
) -> Value {
    match WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .initialization_script(include_str!("../preload-tauri.js"))
        .inner_size(size.0, size.1)
        .min_inner_size(min.0, min.1)
        .always_on_top(top)
        .maximized(maximized)
        .build()
    {
        Ok(_) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

/// Метка окна Tauri допускает не всё, а `widgetId` приходит из настроек.
fn sanitize_label(text: &str) -> String {
    text.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

/// Выбрать путь для сохранения (диалог); `None` — отменили или путь не файловый.
async fn save_path(
    app: &tauri::AppHandle,
    title: &str,
    file_name: &str,
    ext: &str,
) -> Option<PathBuf> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(file_name)
        .add_filter(ext.to_uppercase(), &[ext])
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    receiver
        .await
        .ok()
        .flatten()
        .and_then(|path| path.into_path().ok())
}

/// Выбрать файл для открытия (диалог); `None` — отменили или путь не файловый.
async fn open_path(app: &tauri::AppHandle, title: &str, exts: &[&str]) -> Option<PathBuf> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let filter = exts
        .first()
        .map(|ext| ext.to_uppercase())
        .unwrap_or_default();
    app.dialog()
        .file()
        .set_title(title)
        .add_filter(filter, exts)
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    receiver
        .await
        .ok()
        .flatten()
        .and_then(|path| path.into_path().ok())
}

/// Записать файл и вернуть результат в форме `{ ok, filePath }`.
fn written(path: &Path, body: String) -> Value {
    match std::fs::write(path, body) {
        Ok(()) => json!({ "ok": true, "filePath": path.to_string_lossy() }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

/// Имя темы для файла: буквы/цифры/`_`/`-`/пробел, пустое — `theme`.
fn theme_name(value: Option<&Value>) -> String {
    let raw = value.and_then(Value::as_str).unwrap_or("theme");
    let cleaned: String = raw
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-' || *ch == ' ')
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "theme".to_string()
    } else {
        cleaned.to_string()
    }
}

/// Имя файла медиа без расширения: нижний регистр, `[a-z0-9_-]`, до 40 символов.
fn media_base(stem: &str) -> String {
    let mut out = String::new();
    let mut pending_separator = false;
    for ch in stem.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-' {
            out.push(ch);
            pending_separator = false;
        } else if !pending_separator {
            out.push('_');
            pending_separator = true;
        }
    }
    let trimmed = out.trim_matches('_');
    let limited: String = trimmed.chars().take(40).collect();
    if limited.is_empty() {
        "sound".to_string()
    } else {
        limited
    }
}

/// Страница истории в форме `{ items, total }`, как `query` в JS.
fn page_json(page: &Page) -> Value {
    json!({ "items": page.items, "total": page.total })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_becomes_the_shape_the_panel_expects() {
        let page = Page {
            items: vec![json!({ "id": "e1" })],
            total: 7,
        };
        assert_eq!(
            page_json(&page),
            json!({ "items": [{ "id": "e1" }], "total": 7 })
        );
    }

    #[test]
    fn missing_options_are_an_empty_query() {
        let empty = options(None);
        assert!(empty.kind.is_none() && empty.limit.is_none() && empty.offset.is_none());
        // Явный объект разбирается как в JS: `type` → `kind`.
        let explicit = options(Some(json!({ "type": "donation", "limit": 10 })));
        assert_eq!(explicit.kind, Some(json!("donation")));
        assert_eq!(explicit.limit, Some(10));
    }

    #[test]
    fn a_window_url_carries_the_query() {
        let chat = page_url(8710, "/chatwindow/chat-window.html", &[("port", "8710")]);
        assert_eq!(
            chat.as_str(),
            "http://127.0.0.1:8710/chatwindow/chat-window.html?port=8710"
        );
        let widget = page_url(
            8710,
            "/widgeteditor/widget-editor.html",
            &[("port", "8710"), ("widgetId", "w 1")],
        );
        assert_eq!(
            widget.as_str(),
            "http://127.0.0.1:8710/widgeteditor/widget-editor.html?port=8710&widgetId=w+1"
        );
        // Метка окна не должна содержать пробелов и чужих символов.
        assert_eq!(sanitize_label("w 1/тест"), "w-1-----");
    }

    #[test]
    fn theme_and_media_names_are_sanitized() {
        assert_eq!(theme_name(Some(&json!("Theme-A 1"))), "Theme-A 1");
        // Кириллица в имя файла темы не идёт — как `[^\w\- ]` в JS.
        assert_eq!(theme_name(Some(&json!("Моя тема!"))), "theme");
        assert_eq!(theme_name(Some(&json!("!!!"))), "theme");
        assert_eq!(theme_name(None), "theme");

        assert_eq!(media_base("My Sound"), "my_sound");
        assert_eq!(media_base("Песня 1"), "1");
        assert_eq!(media_base("..."), "sound");
        assert_eq!(media_base("a--b"), "a--b");
        // Длинное имя подрезается до 40 символов.
        assert_eq!(media_base(&"x".repeat(60)).len(), 40);
    }

    #[test]
    fn a_stream_alert_becomes_a_native_notification() {
        // Донат: ник, сумма с валютой и текст через «·» (валюта тримится).
        let (title, body) = format_stream_alert(
            &json!({ "kind": "donation", "user": "nova", "amount": 500, "currency": " RUB ", "message": "Спасибо!" }),
            true,
        );
        assert_eq!(title, "Новый донат");
        assert_eq!(body, "nova · 500 RUB · Спасибо!");

        // Гифт-подписка: счётчик берётся из `count`, целое — без `.0`.
        let (title, body) = format_stream_alert(
            &json!({ "kind": "gift_sub", "user": "alice", "count": 5 }),
            true,
        );
        assert_eq!(title, "Гифт-подписка");
        assert_eq!(body, "alice × 5");

        // Чир без ника — только биты.
        let (title, body) = format_stream_alert(&json!({ "kind": "cheer", "amount": 100 }), false);
        assert_eq!(title, "Cheer (bits)");
        assert_eq!(body, "100 bits");

        // Награда канала: название, ник и текст.
        let (title, body) = format_stream_alert(
            &json!({ "kind": "reward", "rewardTitle": "Сцена", "user": "bob", "message": "го" }),
            true,
        );
        assert_eq!(title, "Награда канала");
        assert_eq!(body, "Сцена · bob · го");

        // Фолловер без суммы — тело это ник.
        let (title, body) =
            format_stream_alert(&json!({ "kind": "follow", "user": "carol" }), false);
        assert_eq!(title, "New follower");
        assert_eq!(body, "carol");
    }
}
