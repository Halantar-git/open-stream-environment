//! Ядро нативной версии OSE (Tauri 2).
//!
//! Отдельной библиотекой, а не кодом в `main`: так правила (формат кадра,
//! конвейер микрофона, отдача страниц) проверяются тестами без запуска окна —
//! так же, как в Electron-версии правила живут в `server/` и покрыты Jest.
//!
//! План переноса — `docs/tauri-migration.md`.

pub mod alerts;
pub mod audio;
pub mod catalog;
pub mod desktop;
pub mod diagnostics;
pub mod hud;
pub mod integrations;
pub mod protocol;
pub mod server;
pub mod state;
pub mod storage;
pub mod theme_engine;
pub mod themes;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

use crate::diagnostics::{Diagnostics, HudHost};
use crate::storage::paths::{resolve_config_dir, Storage};

/// Сколько держать стартовую заставку — как `SPLASH_MIN_MS` в `main.js`
/// (совпадает с длительностью анимации прогресс-бара в `splash.html`).
const SPLASH_MIN_MS: u64 = 3500;
/// Страховка: если страница панели так и не догрузилась, показываем окно всё
/// равно — лучше готовая панель раньше заставки, чем чёрный экран.
const SPLASH_FALLBACK_MS: u64 = 12000;

/// Поднять сервер и открыть окно панели.
pub fn run() {
    // Сессию стрима закрываем при выходе: её `id` нужен снаружи `setup`.
    let session_slot: Arc<Mutex<Option<Arc<Diagnostics>>>> = Arc::new(Mutex::new(None));
    let setup_slot = Arc::clone(&session_slot);

    let app = tauri::Builder::default()
        // Один экземпляр: второй запуск показывает главное окно и уходит.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        // Разрешение на микрофон: панель считает звук сама (Web Audio), и в Electron
        // выдача была автоматической (`setPermissionRequestHandler` — только audio).
        // Камеру (её роль играет OBS) и прочие виды не выдаём.
        .on_permission_request(|_webview, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            PermissionKind::Camera => PermissionResponse::Deny,
            _ => PermissionResponse::Default,
        })
        // Состояние окон (позиция, размер, развёрнутость) переживает перезапуск.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            desktop::get_info,
            desktop::get_displays,
            desktop::db_get_sessions,
            desktop::db_get_sessions_with_stats,
            desktop::db_get_chat,
            desktop::db_get_chat_page,
            desktop::db_get_stream_events,
            desktop::db_remove_stream_events,
            desktop::db_clear_stream_events,
            desktop::db_clear_sessions,
            desktop::db_clear_chat,
            desktop::db_get_storage_stats,
            desktop::db_get_history_limit,
            desktop::db_set_history_limit,
            desktop::db_get_chat_history_enabled,
            desktop::db_set_chat_history_enabled,
            desktop::backup_list,
            desktop::backup_restore,
            desktop::replay_event,
            desktop::db_reset_all,
            desktop::open_chat_window,
            desktop::open_widget_editor,
            desktop::open_theme_preview,
            desktop::open_theme_samples,
            desktop::open_theme_editor,
            desktop::get_theme_editor_init,
            desktop::close_current_window,
            desktop::rotate_access_code,
            desktop::copy_text,
            desktop::open_external,
            desktop::open_data_folder,
            desktop::support_bundle_text,
            desktop::save_support_bundle,
            desktop::export_stream_events,
            desktop::export_config,
            desktop::import_config,
            desktop::export_theme,
            desktop::import_theme,
            desktop::pick_sound_file,
            desktop::connect_twitch,
            desktop::connect_donation_alerts,
            desktop::connect_youtube,
            desktop::get_chat_always_on_top,
            desktop::toggle_chat_always_on_top,
            desktop::change_language,
            desktop::toggle_fullscreen,
            desktop::check_for_updates,
            desktop::download_and_install,
            desktop::quit_and_install,
        ])
        .setup(move |app| {
            // Корень статики: в сборке — ресурсы приложения, в разработке —
            // репозиторий. Признак сборки — именно наличие страниц в ресурсах, а
            // не `debug_assertions`: `cargo run --release` тоже идёт из исходников.
            let (root, packaged) = match bundled_root(app.handle()) {
                Some(root) => (root, true),
                None => (repository_root(), false),
            };
            // Каталог данных: в разработке — рядом с исходниками; в сборке —
            // портативный (если его дал упаковщик) или системный каталог данных.
            let template_dir = root.join("config");
            let portable = std::env::var_os("PORTABLE_EXECUTABLE_DIR").map(PathBuf::from);
            let user_data = app.path().app_data_dir()?;
            let config_dir =
                resolve_config_dir(&template_dir, packaged, portable.as_deref(), &user_data);
            let storage = Storage::new(template_dir, config_dir);
            // Каталог данных на первом запуске может не существовать (свежий
            // `%APPDATA%\com.openstreamenvironment.app`) — создаём, как
            // `mkdirSync(recursive: true)` в JS, иначе первая же запись настроек
            // падает с «путь не найден».
            storage
                .ensure_config_dir()
                .map_err(|error| format!("каталог данных {:?}: {error}", storage.config_dir()))?;
            // Суточный файл журнала (`logs/ose-YYYY-MM-DD.log`) — его же
            // читает отчёт для поддержки.
            crate::storage::logger::enable_file_logging(&storage.logs_dir());
            // Состояние диагностики живёт в роутах; волны 2+ берут его отсюда
            // же — благо, `spawn` его и возвращает.
            let (port, diagnostics) =
                server::spawn(&root, storage).map_err(|error| format!("server::spawn: {error}"))?;
            // Команды оболочки (`window.desktop.*`) берут состояние отсюда.
            app.manage(desktop::DesktopState {
                diagnostics: Arc::clone(&diagnostics),
                theme_editor_init: Mutex::new(serde_json::json!({ "theme": null })),
            });
            // Окна поверх игры и глобальные хоткеи — как `main.js`. Оболочка
            // ставится в диагностику, чтобы команды панели могли её звать.
            let hud = crate::hud::Hud::new(app.handle().clone());
            app.manage(Arc::clone(&hud));
            let host: Arc<dyn HudHost> = hud.clone();
            diagnostics.install_hud(host);
            hud.install();
            // Нативные уведомления о событиях стрима — как `onStreamAlert` в JS.
            {
                let notify_handle = app.handle().clone();
                diagnostics.set_notifier(Arc::new(move |alert: &serde_json::Value| {
                    desktop::notify_stream_alert(&notify_handle, alert);
                }));
            }
            // Стартовая проверка обновления без скачивания: если оно есть, панель
            // зажжёт кнопку «Обновить» — как `update-available` в JS.
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(payload) = desktop::startup_update_notice(&update_handle).await {
                    let _ = update_handle.emit("update:available", payload);
                }
            });
            // Службы стартуют вместе с сервером — как `startIntegrations` в JS.
            diagnostics.restart_twitch_chat();
            // Бот пересобирается по тем же настройкам — канал и команды.
            diagnostics.restart_chat_bot();
            // События (follow/sub/cheer/баллы) — отдельное соединение.
            diagnostics.restart_twitch_events();
            // Донаты DonationAlerts — своё соединение (Centrifugo).
            diagnostics.restart_donation_alerts();
            // OBS WebSocket — сцена, камеры, фильтры.
            diagnostics.restart_obs();
            // YouTube Live — поиск эфира и опрос чата.
            diagnostics.restart_youtube();
            // Пауза очереди алертов переживает перезапуск: срок живёт в настройках.
            diagnostics.restore_alert_pause();
            // Сессия стрима — её начало и есть граница «только этот стрим».
            diagnostics.start_stream_session();
            // Longshot: фоновый цикл опроса, активность — по видимому таймеру в
            // раскладке (как `syncLongshotActivity` в `startIntegrations`).
            diagnostics.start_longshot_poll();
            diagnostics.sync_longshot_activity();
            *setup_slot.lock().unwrap_or_else(|error| error.into_inner()) =
                Some(Arc::clone(&diagnostics));

            // Секреты, которые не удалось прочитать (сменился ключ DPAPI/Keychain,
            // конфиг принесли с другой машины), и повреждённые файлы — это то, что
            // пользователь должен узнать при старте, а не по невнятному
            // `invalid_client` или пустым настройкам. Как блоки `getSecretIssues` и
            // `getRecoveryEvents` в `main.js`.
            show_startup_notices(app.handle(), &diagnostics);

            // Панель грузим по HTTP (а не через ассет-протокол): так у неё
            // заполнен `location.host`, и она сама подключается к шине по
            // WebSocket — как в Electron-версии, где оверлей грузится по HTTP
            // именно из-за этого.
            let url = format!("http://127.0.0.1:{port}/control/control.html?port={port}");

            // Стартовая заставка: показывается, пока панель не готова, и не
            // меньше `SPLASH_MIN_MS` — как `createSplashWindow` в `main.js`.
            let splash = create_splash(app.handle(), port);
            let has_splash = splash.is_some();
            let splash_started = std::time::Instant::now();

            let mut builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(tauri::Url::parse(&url)?),
            )
            .title("Open Stream Environment — панель управления")
            // Мост `window.desktop.*`: панель остаётся тем же JS.
            .initialization_script(include_str!("../preload-tauri.js"))
            .inner_size(1440.0, 900.0)
            .min_inner_size(1100.0, 700.0)
            // Без заставки показываем сразу; с ней — только когда страница готова.
            .visible(!has_splash);
            if has_splash {
                builder = builder.on_page_load(move |window, payload| {
                    if payload.event() != PageLoadEvent::Finished {
                        return;
                    }
                    let remaining = SPLASH_MIN_MS.saturating_sub(
                        u64::try_from(splash_started.elapsed().as_millis()).unwrap_or(u64::MAX),
                    );
                    let window = window.clone();
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(remaining)).await;
                        finish_startup(&app, &window);
                    });
                });
            }
            let main_window = builder.build()?;

            if has_splash {
                // Если страница так и не сообщила о готовности — показываем окно
                // сами, а заставку убираем.
                let app = app.handle().clone();
                let window = main_window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        SPLASH_MIN_MS + SPLASH_FALLBACK_MS,
                    ))
                    .await;
                    finish_startup(&app, &window);
                });
            }

            // Трей и сворачивание в него — как `createTray` + обработчик `close`.
            let language = diagnostics.language();
            let quitting = Arc::new(AtomicBool::new(false));
            let notified = Arc::new(AtomicBool::new(false));
            setup_tray(app.handle(), language, Arc::clone(&quitting))?;
            intercept_close(&main_window, language, quitting, notified);

            println!("[ose] панель: {url}");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("окно панели не запустилось");

    app.run(move |_app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(diagnostics) = session_slot
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_ref()
            {
                diagnostics.end_stream_session();
            }
        }
    });
}

/// Показать и поднять главное окно (клик по трею, второй запуск).
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Трей с меню «Открыть/Выйти» — порт `createTray`/`buildTrayMenu`.
fn setup_tray(
    app: &tauri::AppHandle,
    language: &str,
    quitting: Arc<AtomicBool>,
) -> tauri::Result<()> {
    let (open, quit) = tray_labels(language);
    let open_item = MenuItem::with_id(app, "tray_open", open, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray_quit", quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Open Stream Environment")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "tray_open" => show_main(app),
            "tray_quit" => {
                quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Подписи меню трея по языку — как `trayMenuLabels` в JS.
fn tray_labels(language: &str) -> (&'static str, &'static str) {
    if language == "ru" {
        ("Открыть", "Выйти")
    } else {
        ("Open", "Quit")
    }
}

/// Пересобрать меню трея под новый язык — как `refreshTrayMenu` в JS.
///
/// Обработчик нажатий висит на самом значке трея, поэтому смена состава меню
/// его не теряет — идентификаторы пунктов те же.
pub(crate) fn refresh_tray_menu(app: &tauri::AppHandle, language: &str) {
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    let (open, quit) = tray_labels(language);
    let Ok(open_item) = MenuItem::with_id(app, "tray_open", open, true, None::<&str>) else {
        return;
    };
    let Ok(quit_item) = MenuItem::with_id(app, "tray_quit", quit, true, None::<&str>) else {
        return;
    };
    let Ok(menu) = Menu::with_items(app, &[&open_item, &quit_item]) else {
        return;
    };
    let _ = tray.set_menu(Some(menu));
}

/// Закрытие главного окна сворачивает его в трей (один раз — с подсказкой).
fn intercept_close(
    window: &tauri::WebviewWindow,
    language: &str,
    quitting: Arc<AtomicBool>,
    notified: Arc<AtomicBool>,
) {
    let window_handle = window.clone();
    let app = window.app_handle().clone();
    let body = if language == "ru" {
        "Приложение свёрнуто в трей. Нажмите на значок в трее, чтобы открыть."
    } else {
        "App minimized to tray. Click the tray icon to open it."
    }
    .to_string();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if quitting.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_close();
            let _ = window_handle.hide();
            if !notified.swap(true, Ordering::SeqCst) {
                let _ = app
                    .notification()
                    .builder()
                    .title("Open Stream Environment")
                    .body(body.clone())
                    .show();
            }
        }
    });
}

/// Показать стартовые диалоги о том, что пользователь должен знать: нечитаемые
/// секреты и повреждённые файлы — как `main.js` сразу после чтения настроек.
///
/// Замечания о секретах забираются один раз и забываются (как `clearSecretIssues`),
/// иначе диалог вернулся бы при следующем показе. События порчи остаются в
/// диагностике: из них собирается отчёт для поддержки.
fn show_startup_notices(app: &tauri::AppHandle, diagnostics: &Diagnostics) {
    let language = diagnostics.language();

    let secret_issues = diagnostics.secret_issues();
    diagnostics.clear_secret_issues();
    if !secret_issues.is_empty() {
        app.dialog()
            .message(secrets_notice(language, &secret_issues))
            .title("Open Stream Environment")
            .kind(MessageDialogKind::Warning)
            .show(|_| {});
    }

    let recovery_events = diagnostics.recovery_events().to_vec();
    if !recovery_events.is_empty() {
        app.dialog()
            .message(recovery_notice(language, &recovery_events))
            .title("Open Stream Environment")
            .kind(MessageDialogKind::Warning)
            .show(|_| {});
    }
}

/// Текст о нечитаемых секретах — слово в слово как в `main.js`: пользователь
/// должен видеть, какой именно ключ вставлять заново, а не «секрет №3».
fn secrets_notice(language: &str, issues: &[crate::storage::secrets::IssueNote]) -> String {
    use crate::storage::secrets::{IssueNote, SecretIssue};
    let is_ru = language == "ru";
    let describe = |reason: SecretIssue| -> &'static str {
        match (reason, is_ru) {
            (SecretIssue::Locked, true) => {
                "системное хранилище секретов недоступно, значение прочитать нельзя"
            }
            (SecretIssue::Locked, false) => {
                "the system secret storage is unavailable, the value cannot be read"
            }
            (SecretIssue::Unreadable, true) => {
                "не удалось расшифровать: значение зашифровано другим ключом"
            }
            (SecretIssue::Unreadable, false) => {
                "decryption failed: the value was encrypted with a different key"
            }
        }
    };
    let lines: Vec<String> = issues
        .iter()
        .map(|issue: &IssueNote| format!("• {} — {}", issue.label, describe(issue.reason)))
        .collect();
    if is_ru {
        format!(
            "Нужно ввести ключи заново\n\nНе удалось прочитать сохранённые секреты:\n{}\n\nВведите их заново в разделе «Настройки».",
            lines.join("\n")
        )
    } else {
        format!(
            "Secrets need to be re-entered\n\nCould not read the following saved secrets:\n{}\n\nRe-enter them in Settings.",
            lines.join("\n")
        )
    }
}

/// Текст о повреждённых файлах состояния — как в `main.js`: карантин и бэкап не
/// служебные детали, а то, что решает пользователь.
fn recovery_notice(language: &str, events: &[crate::storage::integrity::RecoveryEvent]) -> String {
    use crate::storage::integrity::{RecoveryEvent, RecoveryKind};
    let is_ru = language == "ru";
    let base = |path: &Option<PathBuf>| -> String {
        path.as_deref()
            .and_then(|path| path.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let lines: Vec<String> = events
        .iter()
        .map(|event: &RecoveryEvent| {
            let quarantined = base(&event.quarantine_path);
            match (event.kind, is_ru) {
                (RecoveryKind::RestoredFromBackup, true) => format!(
                    "• {} был повреждён ({}); испорченная версия отложена как «{}», данные восстановлены из «{}».",
                    event.label,
                    event.reason,
                    quarantined,
                    base(&event.backup_path)
                ),
                (RecoveryKind::RestoredFromBackup, false) => format!(
                    "• {} was damaged ({}); the damaged copy was kept as \"{}\" and data was restored from \"{}\".",
                    event.label,
                    event.reason,
                    quarantined,
                    base(&event.backup_path)
                ),
                (RecoveryKind::Unrecoverable, true) => format!(
                    "• {} был повреждён ({}); пригодного бэкапа нет — файл отложен как «{}», приложение запустилось со значениями по умолчанию.",
                    event.label, event.reason, quarantined
                ),
                (RecoveryKind::Unrecoverable, false) => format!(
                    "• {} was damaged ({}); no usable backup was found — the file was kept as \"{}\" and the app started with default values.",
                    event.label, event.reason, quarantined
                ),
            }
        })
        .collect();
    let tail = if is_ru {
        "Карантинные файлы лежат рядом с рабочими (каталог данных)."
    } else {
        "The quarantined files are stored next to the live ones (data directory)."
    };
    if is_ru {
        format!(
            "Файлы настроек были повреждены\n\n{}\n\n{tail}",
            lines.join("\n")
        )
    } else {
        format!(
            "Settings files were damaged\n\n{}\n\n{tail}",
            lines.join("\n")
        )
    }
}

/// Показать стартовую заставку — как `createSplashWindow` в `main.js`:
/// прозрачное окно без рамки поверх всего, `splash/splash.html` с версией.
///
/// `None` — окно не создалось (тогда панель показывается сразу, без заставки).
fn create_splash(app: &tauri::AppHandle, port: u16) -> Option<WebviewWindow> {
    let url = format!(
        "http://127.0.0.1:{port}/splash/splash.html?version={}",
        env!("CARGO_PKG_VERSION")
    );
    let url = tauri::Url::parse(&url).ok()?;
    WebviewWindowBuilder::new(app, "splash", WebviewUrl::External(url))
        .title("Open Stream Environment")
        .inner_size(600.0, 400.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .shadow(false)
        .center()
        .build()
        .ok()
}

/// Закончить старт: убрать заставку, развернуть и показать панель — как
/// `ready-to-show` в `main.js`. Идемпотентно: повторный вызов безвреден.
fn finish_startup(app: &tauri::AppHandle, main: &WebviewWindow) {
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    let _ = main.maximize();
    let _ = main.show();
}

/// Корень репозитория: рядом лежат `control/`, `overlay/`, `shared/`, `assets/`.
///
/// Это режим разработки; в собранном приложении статику выбирает
/// [`bundled_root`].
fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri лежит в корне репозитория")
        .to_path_buf()
}

/// Корень статики собранного приложения — каталог ресурсов.
///
/// `None` — идёт разработка (`cargo run`, `tauri dev`): тогда работает
/// [`repository_root`]. Отличать сборку по наличию страниц в `resource_dir()`
/// нельзя: `tauri-build` копирует туда `bundle.resources` и в разработке, поэтому
/// признак берётся у Tauri — [`tauri::is_dev`] (её переключает фича
/// `custom-protocol`, которую включает `tauri build`).
fn bundled_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    if tauri::is_dev() {
        return None;
    }
    app.path().resource_dir().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Упаковщик должен везти ту же статику, что отдаёт сервер, и шаблон настроек.
    ///
    /// Список каталогов — один (`server::SERVED_DIRS`): разъехавшись, сборка
    /// отдала бы 404 на страницу, которую dev-режим открывает.
    #[test]
    fn packaging_ships_every_served_directory_and_the_config_template() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let text = std::fs::read_to_string(&path).expect("tauri.conf.json рядом с манифестом");
        let config: serde_json::Value =
            serde_json::from_str(&text).expect("tauri.conf.json — валидный JSON");
        let resources = config["bundle"]["resources"]
            .as_object()
            .expect("bundle.resources должен быть объектом");

        for name in crate::server::SERVED_DIRS {
            assert!(
                resources.contains_key(&format!("../{name}")),
                "в ресурсы должен попадать каталог {name}"
            );
        }
        assert!(
            resources.contains_key("../config/config.example.json"),
            "шаблон настроек должен ехать с приложением"
        );
        // Данные пользователя в сборку не попадают: каталог целиком не копируем.
        assert!(!resources.contains_key("../config"));
    }

    /// Стартовый текст о секретах — тот же, что в `main.js`: метка каждого ключа
    /// и что именно с ним случилось. Проверяем оба языка.
    #[test]
    fn the_secrets_notice_names_each_key_and_the_reason() {
        use crate::storage::secrets::{IssueNote, SecretIssue};
        let issues = vec![
            IssueNote {
                label: "Twitch Client Secret".to_string(),
                reason: SecretIssue::Unreadable,
            },
            IssueNote {
                label: "OBS Password".to_string(),
                reason: SecretIssue::Locked,
            },
        ];

        let ru = secrets_notice("ru", &issues);
        assert!(ru.contains("Нужно ввести ключи заново"), "{ru}");
        assert!(
            ru.contains("• Twitch Client Secret — не удалось расшифровать"),
            "{ru}"
        );
        assert!(
            ru.contains("• OBS Password — системное хранилище секретов недоступно"),
            "{ru}"
        );

        let en = secrets_notice("en", &issues);
        assert!(en.contains("Secrets need to be re-entered"), "{en}");
        assert!(
            en.contains("• Twitch Client Secret — decryption failed"),
            "{en}"
        );
        assert!(
            en.contains("• OBS Password — the system secret storage"),
            "{en}"
        );
    }

    /// Стартовый текст о порче: разные формулировки для «подняли из копии» и
    /// «поднимать нечего», имена файлов — без путей.
    #[test]
    fn the_recovery_notice_tells_apart_restore_and_loss() {
        use crate::storage::integrity::{RecoveryEvent, RecoveryKind};
        let events = vec![
            RecoveryEvent {
                at_ms: 0,
                kind: RecoveryKind::RestoredFromBackup,
                file: PathBuf::from("/data/config.json"),
                label: "config.json".to_string(),
                reason: "не разобрался".to_string(),
                quarantine_path: Some(PathBuf::from("/data/config.json.corrupt-1")),
                backup_path: Some(PathBuf::from("/data/config.json.bak0")),
            },
            RecoveryEvent {
                at_ms: 0,
                kind: RecoveryKind::Unrecoverable,
                file: PathBuf::from("/data/local-db.json"),
                label: "база".to_string(),
                reason: "пусто".to_string(),
                quarantine_path: Some(PathBuf::from("/data/local-db.json.corrupt-2")),
                backup_path: None,
            },
        ];

        let ru = recovery_notice("ru", &events);
        assert!(ru.contains("Файлы настроек были повреждены"), "{ru}");
        assert!(ru.contains("config.json был повреждён"), "{ru}");
        assert!(
            ru.contains("данные восстановлены из «config.json.bak0»"),
            "{ru}"
        );
        assert!(ru.contains("база был повреждён"), "{ru}");
        assert!(ru.contains("пригодного бэкапа нет"), "{ru}");
        // Путей в диалоге нет — только имена файлов.
        assert!(!ru.contains("/data"), "{ru}");

        let en = recovery_notice("en", &events);
        assert!(en.contains("Settings files were damaged"), "{en}");
        assert!(
            en.contains("was restored from \"config.json.bak0\""),
            "{en}"
        );
        assert!(en.contains("no usable backup was found"), "{en}");
    }

    /// Каждая команда моста из `preload-tauri.js` должна быть разрешена в
    /// `permissions/bridge.toml`: страницы грузятся с внешнего для Tauri
    /// HTTP-origin, и команда без разрешения молча отклоняется («not allowed»).
    /// На этом уже ломался весь мост — панель видела метод и не уходила
    /// на резервный путь через шину.
    #[test]
    fn bridge_permissions_cover_every_preload_command() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let preload = std::fs::read_to_string(manifest.join("preload-tauri.js"))
            .expect("preload-tauri.js рядом с манифестом");
        let permissions = std::fs::read_to_string(manifest.join("permissions").join("bridge.toml"))
            .expect("permissions/bridge.toml");

        let mut commands = Vec::new();
        let mut rest = preload.as_str();
        while let Some(position) = rest.find("invoke(\"") {
            let after = &rest[position + "invoke(\"".len()..];
            let Some(end) = after.find('"') else { break };
            commands.push(after[..end].to_string());
            rest = &after[end..];
        }

        assert!(
            commands.len() > 40,
            "команд моста подозрительно мало: {}",
            commands.len()
        );
        let missing: Vec<&String> = commands
            .iter()
            .filter(|command| !permissions.contains(&format!("\"{command}\"")))
            .collect();
        assert!(
            missing.is_empty(),
            "в permissions/bridge.toml нет команд: {missing:?}"
        );
    }

    /// Страницы грузятся по `http://127.0.0.1:порт` — для Tauri это внешний
    /// источник, поэтому capability и разрешение обязаны быть на месте.
    #[test]
    fn the_bridge_capability_covers_the_http_pages() {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let capability =
            std::fs::read_to_string(manifest.join("capabilities").join("default.json"))
                .expect("capabilities/default.json");

        assert!(capability.contains("\"remote\""), "{capability}");
        assert!(capability.contains("127.0.0.1"), "{capability}");
        assert!(capability.contains("\"bridge\""), "{capability}");
    }
}
