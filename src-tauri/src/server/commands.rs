//! Слой команд: разбор `handleClientCommand` из `server/index.js`.
//!
//! Каждая команда — ветка `match` по `event_types::CMD_*`: она зовёт уже
//! перенесённую функцию `state/*` и рассылает то, что рассылала бы Electron-версия
//! (раскладку, тему, опрос, состояние целиком). Блокировки берутся на время
//! работы с настройками и рантаймом и отпускаются **до** рассылки: `broadcast`
//! состояния сам берёт те же замки, и вложенный захват заклинил бы поток.
//!
//! Что перенесено полностью: раскладка и её пресеты, цель, темы и свои темы,
//! редактор, сцены и сплеш, крупный донат, опрос с пресетами, розыгрыш,
//! уведомления, HUD (хоткей, экран, окно чата), язык, настройки OBS/звука/
//! бота/TTS/озвучки/Stream Deck/товаров Twitch, конфиги наложения (микрофон,
//! участники колеса, само колесо), своя команда OBS (`cmd_run_obs_command`),
//! включение служб, сброс счёта стрима, пересылка микрокадров и очередь алертов
//! (`cmd_test_alert`, `cmd_alert_queue_*` — объект живёт в диагностике).
//!
//! Терминал CLI — в `server/cli.rs`, приём команд пульта — в `server/remote.rs`.
//! Порт на ходу меняет хост сервера ([`Diagnostics::server_host`]): сам разбор
//! команд ни о сокете, ни о фоновой задаче `axum::serve` не знает. Всё, что
//! требовало интеграций (Twitch, DonationAlerts, YouTube, OBS и саундборд),
//! подключено.
//! Управление окнами поверх игры (`cmd_toggle_hud_edit_mode`,
//! `cmd_toggle_chat_hud`, `cmd_set_hud_*`, `cmd_set_chat_hud_*`) уходит в
//! оболочку через [`Diagnostics`] (`HudHost`) — сам сервер окон не создаёт.
//! Неперенесённые команды просто игнорируются — как и в JS, где `default` ветки
//! `match` ничего не делает.

use serde_json::{json, Map, Value};

use crate::alerts::{build_test_alert, FinishReason, ResumeReason};
use crate::diagnostics::Diagnostics;
use crate::integrations::twitch_chat::test_chat_messages;
use crate::protocol::event_types;
use crate::server::cli;
use crate::server::locales::{self, Locales};
use crate::server::remote;
use crate::state::{appearance, config, layout, poll, scenes};
use crate::storage::history::{js_number, js_number_or_zero, js_truthy};

/// Разобрать и выполнить команду клиента без привязки к отправителю.
///
/// Так зовут команды тесты и внутренние вызовы; из шины приходит
/// [`handle_message`] с номером клиента (нужен автодополнению CLI).
pub fn handle(diagnostics: &Diagnostics, locales: Option<&Locales>, message: &Value) {
    handle_message(diagnostics, locales, None, message);
}

/// Разобрать и выполнить команду клиента; `client` — отправитель, если есть.
///
/// `locales` нужны `cmd_set_language` и терминалу CLI: остальным достаточно
/// диагностики.
pub fn handle_message(
    diagnostics: &Diagnostics,
    locales: Option<&Locales>,
    client: Option<u64>,
    message: &Value,
) {
    let kind = message
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = message.get("payload").cloned().unwrap_or_else(|| json!({}));

    match kind {
        // ---- Пульт ----
        // Сообщение `remote_action` несёт `action`, а не `type` команды: разбор
        // живёт в `server/remote.rs`.
        event_types::REMOTE_ACTION => {
            remote::handle(diagnostics, message);
        }

        // ---- Терминал CLI ----
        event_types::EXEC_CLI_COMMAND => {
            let command = payload
                .get("command")
                .map(crate::state::js_string)
                .unwrap_or_default();
            cli::execute(diagnostics, locales, &command);
        }
        event_types::EXEC_CLI_COMPLETION => {
            // Ответ уходит только запросившему: подсказки не шумят другим.
            let input = payload
                .get("input")
                .map(crate::state::js_string)
                .unwrap_or_default();
            let completions = cli::completions(diagnostics, &input);
            let frame = json!({
                "type": event_types::CLI_COMPLETIONS,
                "payload": { "input": input, "completions": completions },
            })
            .to_string();
            match client {
                Some(id) => {
                    diagnostics.clients().send_text(id, &frame);
                }
                None => diagnostics.clients().broadcast_text(&frame),
            }
        }

        // ---- Раскладка ----
        event_types::CMD_ADD_WIDGET => {
            let added = payload
                .get("type")
                .and_then(Value::as_str)
                .and_then(|kind| layout::add_widget(diagnostics.database(), kind))
                .is_some();
            if added {
                broadcast_layout(diagnostics);
            }
            // Новый виджет мог оказаться видимым таймером Executive Hangar.
            diagnostics.sync_longshot_activity();
        }
        event_types::CMD_UPDATE_WIDGET => {
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let patch = payload.get("patch").cloned().unwrap_or_else(|| json!({}));
            let updated = layout::update_widget(diagnostics.database(), id, &patch).is_some();
            if updated {
                broadcast_layout(diagnostics);
            }
            // Правка `visible` может включить или выключить опрос Longshot.
            diagnostics.sync_longshot_activity();
        }
        event_types::CMD_REMOVE_WIDGET => {
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if layout::remove_widget(diagnostics.database(), id) {
                broadcast_layout(diagnostics);
            }
            diagnostics.sync_longshot_activity();
        }
        event_types::CMD_REORDER_WIDGET => {
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let direction = payload
                .get("direction")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if layout::reorder_widget(diagnostics.database(), id, direction) {
                broadcast_layout(diagnostics);
            }
        }
        event_types::CMD_SAVE_LAYOUT => {
            let layout = match payload.get("layout") {
                Some(layout) => layout.clone(),
                None => {
                    let config = diagnostics.config();
                    Value::Array(layout::widgets(diagnostics.database(), &config))
                }
            };
            if layout::save_layout(diagnostics.database(), &layout) {
                broadcast_layout(diagnostics);
            }
            diagnostics.sync_longshot_activity();
        }
        event_types::CMD_REFRESH_LONGSHOT => {
            diagnostics.refresh_longshot();
        }
        event_types::CMD_SAVE_LAYOUT_PRESET => {
            let (id, name) = preset_name(&payload);
            let presets = {
                let config = diagnostics.config();
                layout::save_layout_preset(
                    diagnostics.database(),
                    &config,
                    id.as_deref(),
                    &name,
                    now_ms(),
                )
            };
            if let Some(presets) = presets {
                broadcast(
                    diagnostics,
                    event_types::LAYOUT_PRESETS_UPDATE,
                    json!({ "presets": presets }),
                );
            }
        }
        event_types::CMD_APPLY_LAYOUT_PRESET => {
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let applied = {
                let mut config = diagnostics.config();
                layout::apply_layout_preset(diagnostics.database(), &mut config, id)
            };
            if let Some(layout) = applied {
                broadcast(
                    diagnostics,
                    event_types::LAYOUT_UPDATE,
                    json!({ "layout": layout }),
                );
                broadcast_theme(diagnostics);
            }
            diagnostics.sync_longshot_activity();
        }
        event_types::CMD_DELETE_LAYOUT_PRESET => {
            let id = payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let Some(presets) = layout::delete_layout_preset(diagnostics.database(), id) {
                broadcast(
                    diagnostics,
                    event_types::LAYOUT_PRESETS_UPDATE,
                    json!({ "presets": presets }),
                );
            }
        }

        // ---- Цель и настройки ----
        event_types::CMD_SET_GOAL => {
            let goal = {
                let mut config = diagnostics.config();
                config::set_goal(&mut config, &payload)
            };
            broadcast(diagnostics, event_types::GOAL_UPDATE, goal);
        }
        event_types::CMD_SET_APP_CONFIG => {
            // Порт меняется на ходу: перепривязка слушателя — дело хоста сервера
            // (`switchPort` в JS), а не разбора команд. Сравниваем с текущим
            // портом, как `Number(patch.port) !== currentPort()` в JS.
            let wants_port_switch = payload
                .get("port")
                .is_some_and(|port| js_number(Some(port)) != f64::from(diagnostics.port()));
            if wants_port_switch {
                if let Some(host) = diagnostics.server_host() {
                    host.switch_port(payload.get("port").unwrap_or(&Value::Null));
                }
                // Остальные поля патча в этой ветке теряются — как и в JS:
                // `switchPort` сохраняет только порт. Канал перезапускаем, если
                // его прислали вместе с портом.
                if payload.get("twitchChannel").is_some() {
                    diagnostics.restart_twitch_chat();
                    diagnostics.restart_chat_bot();
                }
            } else {
                {
                    let mut config = diagnostics.config();
                    config::set_app_config(&mut config, &payload);
                }
                broadcast_state(diagnostics);
                // Смена канала перезапускает чтение чата — как в JS. Остальные
                // поля настройки чат не трогают, поэтому дёргаем только при
                // `twitchChannel`.
                if payload.get("twitchChannel").is_some() {
                    diagnostics.restart_twitch_chat();
                    diagnostics.restart_chat_bot();
                }
            }
        }
        event_types::CMD_RESTART_INTEGRATION => {
            // Службы Twitch перезапускаются вместе или по отдельности.
            match payload.get("service").and_then(Value::as_str) {
                Some("twitch") => {
                    diagnostics.restart_twitch_chat();
                    diagnostics.restart_twitch_events();
                }
                Some("twitchChat") => diagnostics.restart_twitch_chat(),
                Some("twitchEvents") => diagnostics.restart_twitch_events(),
                Some("donationAlerts") => diagnostics.restart_donation_alerts(),
                Some("youtube") => diagnostics.restart_youtube(),
                Some("obs") => diagnostics.restart_obs(),
                _ => {}
            }
        }
        event_types::CMD_TEST_CHAT => {
            let count = payload.get("count").cloned().unwrap_or(Value::Null);
            for mut message in test_chat_messages(&count) {
                // Показываем настоящие значки, если наборы уже загружены.
                diagnostics.add_chat_badge_images(&mut message);
                broadcast(diagnostics, event_types::CHAT_MESSAGE, message);
            }
        }
        event_types::CMD_SEND_CHAT => {
            // Отправка асинхронная, а команда синхронная: задачу заводим в фоне и
            // отвечаем кадром `chat_sent`, как `.then(...)` в JS.
            let text = payload
                .get("message")
                .map(crate::state::js_string)
                .unwrap_or_default();
            let client_id = payload.get("clientId").cloned().unwrap_or(Value::Null);
            let sender = diagnostics.chat_sender();
            let twitch = diagnostics.twitch_config();
            let clients = diagnostics.clients_arc();
            std::mem::drop(tauri::async_runtime::spawn(async move {
                let result = sender.send_message(&twitch, &text).await;
                let mut out = Map::new();
                out.insert("clientId".to_string(), client_id);
                if let Value::Object(fields) = result {
                    for (key, value) in fields {
                        out.insert(key, value);
                    }
                }
                let frame =
                    json!({ "type": event_types::CHAT_SENT, "payload": Value::Object(out) });
                clients.broadcast_text(&frame.to_string());
            }));
        }

        event_types::CMD_CREATE_CLIP => {
            // Создание клипа асинхронное: результат придёт кадром
            // `twitch_action_result` с `action: "clip"`.
            diagnostics.create_clip();
        }
        event_types::CMD_CREATE_STREAM_MARKER => {
            let description = payload
                .get("description")
                .filter(|value| js_truthy(Some(value)))
                .map(crate::state::js_string)
                .unwrap_or_default();
            diagnostics.create_marker(&description);
        }
        // ---- OBS: камеры ----
        event_types::CMD_SET_CAMERA_ANGLE => {
            // Работа с OBS асинхронная: задачу заводим в фоне, результат придёт
            // кадром `camera_angle_update`.
            let angle_id = payload
                .get("angleId")
                .map(crate::state::js_string)
                .unwrap_or_default();
            let obs = diagnostics.obs();
            std::mem::drop(tauri::async_runtime::spawn(async move {
                let _ = obs.set_camera_angle(&angle_id).await;
            }));
        }
        event_types::CMD_TRIGGER_CAMERA_FILTER => {
            let filter_id = payload
                .get("filterId")
                .map(crate::state::js_string)
                .unwrap_or_default();
            let duration = payload.get("durationSec").and_then(Value::as_f64);
            let obs = diagnostics.obs();
            std::mem::drop(tauri::async_runtime::spawn(async move {
                let _ = obs.trigger_camera_filter(&filter_id, duration).await;
            }));
        }

        // ---- Очередь алертов ----
        event_types::CMD_TEST_ALERT => {
            let mut alert = build_test_alert(payload.get("kind").unwrap_or(&Value::Null));
            if let Value::Object(map) = &mut alert {
                map.insert("isTest".to_string(), Value::Bool(true));
                // Длительность зависит от вида; сам алерт её не задаёт.
                let kind = map
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("follow")
                    .to_string();
                let duration = crate::protocol::alert_duration_ms(&kind).unwrap_or(5000);
                map.entry("durationMs".to_string())
                    .or_insert(Value::from(duration));
            }
            // Через шину, как `bus.emit("alert", …)`: очередь сама пометит тест
            // (`force`/`ignorePause`), а побочные эффекты запишут событие в историю
            // и в «последние события» — как в Electron.
            diagnostics.emit_bus(json!({ "type": event_types::ALERT, "payload": alert }));
        }
        event_types::CMD_ALERT_QUEUE_PAUSE => {
            let minutes = js_number_or_zero(payload.get("minutes")).max(0.0);
            let snapshot = diagnostics.alert_queue().pause(minutes);
            // Срок паузы живёт в настройках, чтобы перезапуск её не снимал.
            // `null` пишем как `0` — как `snapshot.pausedUntil || 0` в JS.
            let pause_until = snapshot
                .get("pausedUntil")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or_else(|| json!(0));
            let mut config = diagnostics.config();
            config::set_alert_queue_config(&mut config, &json!({ "pauseUntil": pause_until }));
        }
        event_types::CMD_ALERT_QUEUE_RESUME => {
            diagnostics.alert_queue().resume(ResumeReason::Manual);
            let mut config = diagnostics.config();
            config::set_alert_queue_config(&mut config, &json!({ "pauseUntil": 0 }));
        }
        event_types::CMD_ALERT_QUEUE_SKIP => {
            diagnostics.alert_queue().finish_current(FinishReason::Skip);
        }
        event_types::CMD_ALERT_QUEUE_REMOVE => {
            let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
            diagnostics.alert_queue().remove(id);
        }
        event_types::CMD_ALERT_QUEUE_UP => {
            let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
            diagnostics.alert_queue().move_up(id);
        }
        event_types::CMD_ALERT_QUEUE_PLAY_NOW => {
            let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
            diagnostics.alert_queue().play_now(id);
        }
        event_types::CMD_ALERT_QUEUE_CLEAR => {
            diagnostics.alert_queue().clear();
        }
        event_types::CMD_RECOVER_DONATIONS => {
            // Добор асинхронный: результат придёт кадром `alert_queue_update`.
            let limit = payload.get("limit").and_then(Value::as_f64);
            diagnostics.recover_donations(limit);
        }
        event_types::CMD_ALERT_QUEUE_CONFIG => {
            {
                let mut config = diagnostics.config();
                config::set_alert_queue_config(&mut config, &payload);
            }
            // Порядок важен: сперва настройка, потом правила. `set_rules`
            // рассылает снимок, а в нём уже должно стоять новое «включена».
            let rules = diagnostics.queue_rules();
            diagnostics.alert_queue().set_rules(&json!({
                "minAmount": rules.min_amount,
                "mergeSameUser": rules.merge_same_user,
                "mergeWindowSec": rules.merge_window_sec,
            }));
            if payload.get("enabled").and_then(Value::as_bool) == Some(false) {
                // Выключенная очередь не должна выстрелить залежавшимся.
                diagnostics.alert_queue().clear();
            }
        }

        // ---- Темы ----
        event_types::CMD_SET_ACTIVE_THEME => {
            let id = payload.get("id").cloned().unwrap_or(Value::Null);
            let enable3d = payload.get("enable3d").and_then(Value::as_bool);
            let changed = {
                let mut config = diagnostics.config();
                appearance::set_active_theme(&mut config, &id, enable3d)
            };
            if changed {
                broadcast_theme(diagnostics);
            }
        }
        event_types::CMD_SET_ENABLED_3D => {
            let kind = payload.get("type").cloned().unwrap_or(Value::Null);
            let enabled = payload
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let changed = {
                let mut config = diagnostics.config();
                appearance::set_enabled_3d_widget(&mut config, &kind, enabled).is_some()
            };
            if changed {
                broadcast_theme(diagnostics);
            }
        }
        event_types::CMD_SAVE_CUSTOM_THEME | event_types::CMD_IMPORT_CUSTOM_THEME => {
            {
                let mut config = diagnostics.config();
                appearance::save_custom_theme(&mut config, &payload);
            }
            broadcast_theme(diagnostics);
        }
        event_types::CMD_DELETE_CUSTOM_THEME => {
            let id = payload.get("id").cloned().unwrap_or(Value::Null);
            let changed = {
                let mut config = diagnostics.config();
                appearance::delete_custom_theme(&mut config, &id)
            };
            if changed {
                broadcast_theme(diagnostics);
            }
        }
        event_types::CMD_DUPLICATE_CUSTOM_THEME => {
            let id = payload.get("id").cloned().unwrap_or(Value::Null);
            let copy = {
                let mut config = diagnostics.config();
                appearance::duplicate_custom_theme(&mut config, &id)
            };
            if copy.is_some() {
                broadcast_theme(diagnostics);
            }
        }
        event_types::CMD_PREVIEW_THEME_DRAFT => {
            broadcast(diagnostics, event_types::THEME_DRAFT_PREVIEW, payload);
        }
        event_types::CMD_SET_EDITOR_PREFS => {
            let prefs = {
                let mut config = diagnostics.config();
                appearance::set_editor_prefs(&mut config, &payload)
            };
            broadcast(diagnostics, event_types::EDITOR_PREFS_UPDATE, prefs);
        }

        // ---- Сцены, сплеш, крупный донат ----
        event_types::CMD_SET_SCENE_CONFIG => {
            let scene_id = payload.get("sceneId").cloned().unwrap_or(Value::Null);
            let patch = payload.get("patch").cloned().unwrap_or_else(|| json!({}));
            let scenes = {
                let mut config = diagnostics.config();
                if scenes::set_scene_config(&mut config, &scene_id, &patch).is_some() {
                    config.get("scenes").cloned().unwrap_or(Value::Null)
                } else {
                    Value::Null
                }
            };
            if !scenes.is_null() {
                broadcast(diagnostics, event_types::SCENES_UPDATE, scenes);
            }
        }
        event_types::CMD_SET_SPLASH_CONFIG => {
            {
                let mut config = diagnostics.config();
                let patch = payload.get("config").cloned().unwrap_or_else(|| json!({}));
                scenes::set_splash_config(&mut config, &patch);
            }
            broadcast_state(diagnostics);
        }
        event_types::VIDEO_SPLASH_ENDED => {
            remote::splash_ended(diagnostics);
        }
        event_types::VIDEO_SPLASH_READY => {
            remote::splash_ready(diagnostics);
        }
        event_types::CMD_RESET_TOP_DONATION => {
            let top = {
                let mut config = diagnostics.config();
                scenes::reset_top_donation(&mut config)
            };
            broadcast(diagnostics, event_types::TOP_DONATION_UPDATE, top);
        }

        // ---- Опрос ----
        event_types::CMD_TEST_POLL => {
            let snapshot = {
                let config = diagnostics.config();
                let mut runtime = diagnostics.runtime();
                poll::test_poll_votes(
                    &mut runtime,
                    &config,
                    payload.get("count").unwrap_or(&Value::Null),
                )
            };
            if let Some(poll) = snapshot {
                broadcast_poll(diagnostics, poll);
            }
        }
        event_types::CMD_START_POLL => {
            let snapshot = {
                let mut config = diagnostics.config();
                let mut runtime = diagnostics.runtime();
                poll::start_poll(
                    &mut runtime,
                    &mut config,
                    diagnostics.database(),
                    payload.get("command").unwrap_or(&Value::Null),
                )
            };
            broadcast_poll(diagnostics, snapshot);
        }
        event_types::CMD_STOP_POLL => {
            let snapshot = {
                let config = diagnostics.config();
                let mut runtime = diagnostics.runtime();
                poll::stop_poll(&mut runtime, &config)
            };
            broadcast_poll(diagnostics, snapshot);
        }
        event_types::CMD_RESET_POLL => {
            let snapshot = {
                let config = diagnostics.config();
                let mut runtime = diagnostics.runtime();
                poll::reset_poll(&mut runtime, &config)
            };
            broadcast_poll(diagnostics, snapshot);
        }
        event_types::CMD_SET_POLL_CONFIG => {
            let snapshot = {
                let mut config = diagnostics.config();
                let mut runtime = diagnostics.runtime();
                let patch = payload.get("config").cloned().unwrap_or_else(|| json!({}));
                poll::set_poll_config(&mut runtime, &mut config, diagnostics.database(), &patch)
            };
            broadcast_poll(diagnostics, snapshot);
        }
        event_types::CMD_ADD_POLL_OPTION => {
            let snapshot = {
                let mut config = diagnostics.config();
                let mut runtime = diagnostics.runtime();
                poll::add_poll_option(
                    &mut runtime,
                    &mut config,
                    diagnostics.database(),
                    payload.get("label").unwrap_or(&Value::Null),
                )
            };
            if let Some(poll) = snapshot {
                broadcast_poll(diagnostics, poll);
            }
        }
        event_types::CMD_REMOVE_POLL_OPTION => {
            let snapshot = {
                let mut config = diagnostics.config();
                let mut runtime = diagnostics.runtime();
                poll::remove_poll_option(
                    &mut runtime,
                    &mut config,
                    diagnostics.database(),
                    payload.get("id").unwrap_or(&Value::Null),
                )
            };
            broadcast_poll(diagnostics, snapshot);
        }
        event_types::CMD_CLEAR_POLL_OPTIONS => {
            let snapshot = {
                let mut config = diagnostics.config();
                let mut runtime = diagnostics.runtime();
                poll::clear_poll_options(&mut runtime, &mut config, diagnostics.database())
            };
            broadcast_poll(diagnostics, snapshot);
        }
        event_types::CMD_SAVE_POLL_PRESET => {
            let presets = {
                let config = diagnostics.config();
                poll::save_poll_preset(diagnostics.database(), &config, &payload, now_ms())
            };
            if let Some(presets) = presets {
                broadcast(
                    diagnostics,
                    event_types::POLL_PRESETS_UPDATE,
                    json!({ "presets": presets }),
                );
            }
        }
        event_types::CMD_APPLY_POLL_PRESET => {
            let snapshot = {
                let mut config = diagnostics.config();
                let mut runtime = diagnostics.runtime();
                poll::apply_poll_preset(
                    &mut runtime,
                    &mut config,
                    diagnostics.database(),
                    payload.get("id").unwrap_or(&Value::Null),
                )
            };
            if let Some(poll) = snapshot {
                broadcast_poll(diagnostics, poll);
            }
        }
        event_types::CMD_DELETE_POLL_PRESET => {
            let presets = poll::delete_poll_preset(
                diagnostics.database(),
                payload.get("id").unwrap_or(&Value::Null),
            );
            if let Some(presets) = presets {
                broadcast(
                    diagnostics,
                    event_types::POLL_PRESETS_UPDATE,
                    json!({ "presets": presets }),
                );
            }
        }

        // ---- Розыгрыш ----
        event_types::CMD_START_GIVEAWAY => {
            // Как `WHEEL_START`: снять таймеры прошлого цикла, прежде чем начать новый.
            diagnostics.wheel().reset();
            let giveaway = {
                let mut runtime = diagnostics.runtime();
                runtime.start_giveaway(payload.get("command").unwrap_or(&Value::Null))
            };
            let command = giveaway.get("command").cloned().unwrap_or(Value::Null);
            broadcast_giveaway(diagnostics, giveaway);
            // Колесо начинается по алерту — как `bus.emit("alert", { kind: "wheel_start" })`.
            diagnostics
                .broadcast_wheel_alert(&json!({ "kind": "wheel_start", "command": command }));
        }
        event_types::CMD_STOP_GIVEAWAY => {
            diagnostics.wheel().clear_auto_spin();
            diagnostics.wheel().end_spin();
            let giveaway = { diagnostics.runtime().stop_giveaway() };
            broadcast_giveaway(diagnostics, giveaway);
        }
        event_types::CMD_SHUFFLE_GIVEAWAY => {
            let giveaway = {
                let mut runtime = diagnostics.runtime();
                runtime.shuffle_giveaway()
            };
            broadcast_giveaway(diagnostics, giveaway);
        }
        event_types::CMD_SET_GIVEAWAY_ELIMINATION => {
            let giveaway = {
                let mut runtime = diagnostics.runtime();
                runtime
                    .set_giveaway_elimination_mode(payload.get("enabled").unwrap_or(&Value::Null))
            };
            broadcast_giveaway(diagnostics, giveaway);
        }
        event_types::CMD_GENERATE_WHEEL => {
            diagnostics.wheel().clear_hide();
            let sectors = {
                let runtime = diagnostics.runtime();
                runtime.giveaway_snapshot()["participants"].clone()
            };
            broadcast(
                diagnostics,
                event_types::GIVEAWAY_WHEEL,
                json!({ "sectors": sectors }),
            );
        }
        event_types::CMD_SPIN_WHEEL => {
            // Спин может уже идти — тогда второй не начинаем и до этого прячем
            // таймер автоскрытия (как `clearWheelHide()` + `if (isSpinning) break`).
            diagnostics.wheel().spin_if_idle();
        }
        event_types::CMD_SET_GIVEAWAY_WINNER => {
            let username = payload.get("username").cloned().unwrap_or(Value::Null);
            let consumed = {
                let mut runtime = diagnostics.runtime();
                runtime.consume_pending_winner(&username)
            };
            if consumed {
                let giveaway = {
                    let mut runtime = diagnostics.runtime();
                    runtime.set_giveaway_winner(&username)
                };
                let is_final = js_truthy(giveaway.get("isFinalWinner"));
                let is_elimination = js_truthy(giveaway.get("eliminationMode")) && !is_final;
                broadcast_giveaway(diagnostics, giveaway.clone());
                // Конец раунда: `endSpin` и следующий шаг — автоспин при выбывании
                // или автоскрытие, когда цикл закончен.
                diagnostics.wheel().finish_round(&giveaway);
                let mut alert = json!({
                    "kind": "wheel_winner",
                    "user": giveaway.get("winner").cloned().unwrap_or(Value::Null),
                    "isElimination": is_elimination,
                    "isFinalWinner": is_final,
                });
                if is_elimination {
                    // Карточка выбывания висит меньше, затем крутится следующий.
                    alert["durationMs"] = json!(3000);
                }
                diagnostics.broadcast_wheel_alert(&alert);
            }
        }
        event_types::CMD_ADD_GIVEAWAY_PARTICIPANT => {
            let giveaway = {
                let mut runtime = diagnostics.runtime();
                runtime.add_giveaway_participant(payload.get("username").unwrap_or(&Value::Null))
            };
            if let Some(giveaway) = giveaway {
                broadcast_giveaway(diagnostics, giveaway);
            }
        }
        event_types::CMD_REMOVE_GIVEAWAY_PARTICIPANT => {
            let giveaway = {
                let mut runtime = diagnostics.runtime();
                runtime.remove_giveaway_participant(payload.get("username").unwrap_or(&Value::Null))
            };
            broadcast_giveaway(diagnostics, giveaway);
        }
        event_types::CMD_CLEAR_GIVEAWAY_PARTICIPANTS => {
            diagnostics.wheel().reset();
            let giveaway = {
                let mut runtime = diagnostics.runtime();
                runtime.clear_giveaway_participants()
            };
            broadcast_giveaway(diagnostics, giveaway);
            broadcast(
                diagnostics,
                event_types::GIVEAWAY_WHEEL,
                json!({ "sectors": [] }),
            );
        }
        event_types::CMD_SET_PARTICIPANTS_CONFIG => {
            let config = diagnostics
                .database()
                .save_participants_config(payload.get("config"));
            broadcast(
                diagnostics,
                event_types::OVERLAY_PARTICIPANTS_CONFIG,
                json!({ "config": config }),
            );
        }
        event_types::CMD_SET_WHEEL_CONFIG => {
            let config = diagnostics
                .database()
                .save_wheel_config(payload.get("config"));
            broadcast(
                diagnostics,
                event_types::WHEEL_CONFIG,
                json!({ "config": config }),
            );
        }
        event_types::CMD_SET_WHEEL_SPEED_CONFIG => {
            let config = diagnostics
                .database()
                .save_wheel_speed_config(payload.get("config"));
            broadcast(
                diagnostics,
                event_types::WHEEL_SPEED_CONFIG,
                json!({ "config": config }),
            );
        }

        // ---- HUD ----
        event_types::CMD_TOGGLE_HUD_EDIT_MODE => {
            // Окном владеет оболочка (`set_ignore_cursor_events`), сервер только
            // просит её переключить режим — как `bus.emit("hud-edit-toggle")` в JS.
            diagnostics.toggle_hud_edit_mode();
        }
        event_types::CMD_SET_HUD_HOTKEY => {
            let requested = payload
                .get("hotkey")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if requested.is_empty() {
                return;
            }
            // Регистрацией владеет оболочка: если акселератор невалиден или занят,
            // оставляем прежнее значение и отвечаем `ok:false` — как в JS.
            if diagnostics.register_hud_hotkey(&requested) {
                let hotkey = {
                    let mut config = diagnostics.config();
                    appearance::set_hud_hotkey(&mut config, &Value::from(requested))
                };
                broadcast(
                    diagnostics,
                    event_types::HUD_HOTKEY_UPDATE,
                    json!({ "hotkey": hotkey, "ok": true }),
                );
            } else {
                let current = {
                    let config = diagnostics.config();
                    config
                        .get("hud_edit_hotkey")
                        .cloned()
                        .unwrap_or(Value::Null)
                };
                broadcast(
                    diagnostics,
                    event_types::HUD_HOTKEY_UPDATE,
                    json!({ "hotkey": current, "ok": false }),
                );
            }
        }
        event_types::CMD_SET_HUD_DISPLAY => {
            let saved = {
                let mut config = diagnostics.config();
                appearance::set_hud_display(
                    &mut config,
                    payload.get("displayId").unwrap_or(&Value::Null),
                )
            };
            // Окно пересоздаётся на новом мониторе — это делает оболочка.
            diagnostics.hud_display_changed();
            broadcast(
                diagnostics,
                event_types::HUD_DISPLAY_UPDATE,
                json!({ "displayId": saved }),
            );
        }
        event_types::CMD_TOGGLE_CHAT_HUD => {
            // Показ/скрытие окна чата поверх игры — тоже оболочка.
            diagnostics.toggle_chat_hud();
        }
        event_types::CMD_SET_CHAT_HUD_HOTKEY => {
            let requested = payload
                .get("hotkey")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if requested.is_empty() {
                return;
            }
            if diagnostics.register_chat_hud_hotkey(&requested) {
                let hotkey = {
                    let mut config = diagnostics.config();
                    appearance::set_chat_hud_hotkey(&mut config, &Value::from(requested))
                };
                broadcast(
                    diagnostics,
                    event_types::CHAT_HUD_HOTKEY_UPDATE,
                    json!({ "hotkey": hotkey, "ok": true }),
                );
            } else {
                let current = {
                    let config = diagnostics.config();
                    config
                        .get("chat_hud_hotkey")
                        .cloned()
                        .unwrap_or(Value::Null)
                };
                broadcast(
                    diagnostics,
                    event_types::CHAT_HUD_HOTKEY_UPDATE,
                    json!({ "hotkey": current, "ok": false }),
                );
            }
        }
        event_types::CMD_SET_CHAT_HUD_DISPLAY => {
            let saved = {
                let mut config = diagnostics.config();
                appearance::set_chat_hud_display(
                    &mut config,
                    payload.get("displayId").unwrap_or(&Value::Null),
                )
            };
            diagnostics.chat_hud_display_changed();
            broadcast(
                diagnostics,
                event_types::CHAT_HUD_DISPLAY_UPDATE,
                json!({ "displayId": saved }),
            );
        }
        event_types::CMD_SET_CHAT_HUD_CONFIG => {
            let saved = {
                let mut config = diagnostics.config();
                let patch = payload.get("config").cloned().unwrap_or_else(|| json!({}));
                appearance::set_chat_hud_config(&mut config, &patch)
            };
            // Позиция/размер уже открытого окна обновляет оболочка без пересоздания.
            diagnostics.chat_hud_config_changed();
            broadcast(
                diagnostics,
                event_types::CHAT_HUD_CONFIG_UPDATE,
                json!({ "config": saved }),
            );
        }

        // ---- Язык, уведомления, службы ----
        event_types::CMD_SET_LANGUAGE => {
            let lang = locales::normalize_lang(
                payload
                    .get("lang")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            diagnostics.save_language(lang);
            if let Some(locales) = locales {
                broadcast(diagnostics, event_types::LOCALES, locales.payload(lang));
            }
        }
        event_types::CMD_SET_YOUTUBE_VIDEO_ID => {
            let mut config = diagnostics.config();
            config::set_youtube_video_id(
                &mut config,
                payload.get("videoId").unwrap_or(&Value::Null),
            );
        }
        event_types::CMD_SET_NOTIFICATION_SOUND => {
            {
                let mut config = diagnostics.config();
                config::set_notification_sound(
                    &mut config,
                    payload.get("enabled").unwrap_or(&Value::Null),
                );
            }
            broadcast_state(diagnostics);
        }
        event_types::CMD_SET_NOTIFICATION_VOLUME => {
            {
                let mut config = diagnostics.config();
                config::set_notification_volume(
                    &mut config,
                    payload.get("volume").unwrap_or(&Value::Null),
                );
            }
            broadcast_state(diagnostics);
        }
        event_types::CMD_SET_NOTIFICATION_REPEATS => {
            {
                let mut config = diagnostics.config();
                config::set_notification_repeats(
                    &mut config,
                    payload.get("repeats").unwrap_or(&Value::Null),
                );
            }
            broadcast_state(diagnostics);
        }
        event_types::CMD_SET_INTEGRATION_ENABLED => {
            let service = payload
                .get("service")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let enabled = payload
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            {
                let mut config = diagnostics.config();
                config::set_integration_enabled(&mut config, service, enabled);
            }
            // Галочка сама соединение не поднимает/не рвёт — перезапускаем службу,
            // как `restartTwitchChat`/`restartObs` в JS.
            match service {
                "twitch" => {
                    diagnostics.restart_twitch_chat();
                    diagnostics.restart_twitch_events();
                }
                "donationAlerts" => diagnostics.restart_donation_alerts(),
                "youtube" => diagnostics.restart_youtube(),
                "obs" => diagnostics.restart_obs(),
                _ => {}
            }
            broadcast_state(diagnostics);
        }

        // ---- Настройки разделов ----
        event_types::CMD_SET_OBS_CONFIG => {
            {
                let mut config = diagnostics.config();
                config::set_obs_config(&mut config, &payload);
            }
            // Смена host/port/пароля переподключает OBS — как `restartObs()` в JS.
            diagnostics.restart_obs();
            broadcast_state(diagnostics);
        }
        event_types::CMD_SET_SOUNDBOARD_CONFIG => {
            {
                let mut config = diagnostics.config();
                let patch = payload.get("config").cloned().unwrap_or_else(|| json!({}));
                config::set_soundboard_config(&mut config, &patch);
            }
            broadcast_state(diagnostics);
        }
        event_types::CMD_TEST_SOUNDBOARD => {
            let sound_id = payload
                .get("soundId")
                .filter(|value| js_truthy(Some(value)))
                .map(crate::state::js_string)
                .unwrap_or_default();
            diagnostics.trigger_soundboard(&sound_id, "Тест");
        }
        event_types::CMD_SET_CHAT_BOT_CONFIG => {
            {
                let mut config = diagnostics.config();
                let patch = payload.get("config").cloned().unwrap_or_else(|| json!({}));
                config::set_chat_bot_config(&mut config, &patch);
            }
            broadcast_state(diagnostics);
            // Команды и включение бота читаются при сборке — пересобираем.
            diagnostics.restart_chat_bot();
        }
        event_types::CMD_SET_TTS_CONFIG => {
            {
                let mut config = diagnostics.config();
                let patch = payload.get("config").cloned().unwrap_or_else(|| json!({}));
                config::set_tts_config(&mut config, &patch);
            }
            broadcast_state(diagnostics);
        }
        event_types::CMD_SET_DONATION_VOICE => {
            {
                let mut config = diagnostics.config();
                let patch = payload.get("config").cloned().unwrap_or_else(|| json!({}));
                config::set_donation_voice_config(&mut config, &patch);
            }
            broadcast_state(diagnostics);
        }
        event_types::CMD_SET_STREAMDECK_CONFIG => {
            {
                let mut config = diagnostics.config();
                let patch = payload.get("config").cloned().unwrap_or_else(|| json!({}));
                config::set_streamdeck_config(&mut config, &patch);
            }
            broadcast_state(diagnostics);
        }
        event_types::CMD_SET_TWITCH_REWARDS => {
            {
                let mut config = diagnostics.config();
                let rewards = payload.get("rewards").cloned().unwrap_or_else(|| json!([]));
                config::set_twitch_rewards(&mut config, &json!({ "rewards": rewards }));
            }
            broadcast_state(diagnostics);
        }
        event_types::CMD_TEST_TWITCH_REWARD => {
            // Тестовая кнопка у правила: прогоняем его действия (алерт, озвучка,
            // сцена, звук) с автором «Тест» — как `triggerRewardActions` в JS.
            let id = payload
                .get("id")
                .map(crate::state::js_string)
                .unwrap_or_default();
            diagnostics.test_twitch_reward(&id);
        }
        event_types::CMD_RUN_OBS_COMMAND => {
            // Своя команда OBS по id: уходит в OBS WebSocket как есть.
            diagnostics.run_obs_command(payload.get("id").cloned().unwrap_or(Value::Null));
        }

        // ---- Счёт текущего стрима и микрокадры ----
        event_types::CMD_RESET_SESSION_STATS => {
            let session = {
                let mut runtime = diagnostics.runtime();
                runtime.reset_session_donations()
            };
            broadcast(diagnostics, event_types::SESSION_STATS, session);
        }
        event_types::MIC_AUDIO_DATA => {
            broadcast(diagnostics, event_types::MIC_AUDIO_DATA, payload);
        }
        event_types::CMD_SET_MIC_CONFIG => {
            let config = diagnostics
                .database()
                .save_mic_config(payload.get("config"));
            broadcast(
                diagnostics,
                event_types::OVERLAY_MIC_CONFIG,
                json!({ "config": config }),
            );
        }

        _ => {}
    }
}

/// Раскладка целиком — как `broadcast(LAYOUT_UPDATE, { layout })`.
fn broadcast_layout(diagnostics: &Diagnostics) {
    let layout = {
        let config = diagnostics.config();
        layout::widgets(diagnostics.database(), &config)
    };
    broadcast(
        diagnostics,
        event_types::LAYOUT_UPDATE,
        json!({ "layout": layout }),
    );
}

/// Состояние целиком — самый частый ответ на правку настроек.
fn broadcast_state(diagnostics: &Diagnostics) {
    let snapshot = diagnostics.state_snapshot();
    broadcast(diagnostics, event_types::STATE, snapshot);
}

/// Тема: панель обновляет сетку, библиотеку и оверлей одним кадром.
fn broadcast_theme(diagnostics: &Diagnostics) {
    let appearance = diagnostics.state_snapshot()["appearance"].clone();
    broadcast(diagnostics, event_types::THEME_UPDATE, appearance);
}

/// Розыгрыш — двумя кадрами: сам снимок и список участников (как в JS).
fn broadcast_giveaway(diagnostics: &Diagnostics, giveaway: Value) {
    broadcast(
        diagnostics,
        event_types::GIVEAWAY_UPDATE,
        json!({ "giveaway": giveaway }),
    );
    broadcast(
        diagnostics,
        event_types::GIVEAWAY_PARTICIPANTS,
        json!({
            "count": giveaway.get("count").cloned().unwrap_or(Value::Null),
            "participants": giveaway.get("participants").cloned().unwrap_or(Value::Null),
        }),
    );
}

fn broadcast_poll(diagnostics: &Diagnostics, poll: Value) {
    broadcast(
        diagnostics,
        event_types::POLL_UPDATE,
        json!({ "poll": poll }),
    );
}

fn broadcast(diagnostics: &Diagnostics, kind: &str, payload: Value) {
    let text = json!({ "type": kind, "payload": payload }).to_string();
    diagnostics.clients().broadcast_text(&text);
}

/// `{ id, name }` из payload: `id` — строка, если пришла; имя — как есть.
fn preset_name(payload: &Value) -> (Option<String>, String) {
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let name = payload
        .get("name")
        .map(crate::state::js_string)
        .unwrap_or_default();
    (id, name)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::paths::Storage;
    use axum::extract::ws::Message;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::mpsc;

    /// Диагностика во временном каталоге плюс клиент, который слушает рассылку.
    struct Fixture {
        dir: PathBuf,
        diagnostics: Diagnostics,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let index = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "ose-commands-{}-{label}-{index}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            fs::write(dir.join("config.example.json"), "{\n  \"port\": 8710\n}\n")
                .expect("шаблон должен записываться");
            let mut diagnostics =
                Diagnostics::open(Storage::beside_sources(dir.clone())).expect("диагностика");
            diagnostics.normalize();
            Self { dir, diagnostics }
        }

        /// Подключить слушателя и вернуть приёмник его кадров.
        fn listen(&self) -> mpsc::UnboundedReceiver<Message> {
            let (sender, receiver) = mpsc::unbounded_channel();
            self.diagnostics
                .clients()
                .add("control".to_string(), false, sender);
            receiver
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// Первый кадр рассылки как JSON.
    fn frame(receiver: &mut mpsc::UnboundedReceiver<Message>) -> Value {
        match receiver.try_recv().expect("кадр должен быть") {
            Message::Text(text) => serde_json::from_str(text.as_str()).expect("кадр — JSON"),
            other => panic!("ожидался текст, пришло {other:?}"),
        }
    }

    #[test]
    fn setting_the_goal_updates_it_and_broadcasts() {
        let fixture = Fixture::new("goal");
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::CMD_SET_GOAL,
                "payload": { "title": "Цель", "target": 100 },
            }),
        );

        let message = frame(&mut receiver);
        assert_eq!(message["type"], json!(event_types::GOAL_UPDATE));
        assert_eq!(message["payload"]["target"], json!(100));
        assert_eq!(
            fixture.diagnostics.config().get("goal").unwrap()["title"],
            json!("Цель")
        );
        // Больше ничего не рассылалось.
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn a_cli_command_answers_with_a_terminal_log() {
        let fixture = Fixture::new("cli");
        let mut receiver = fixture.listen();

        // Словари не передаются — тексты остаются ключами, но служба и уровень верны.
        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::EXEC_CLI_COMMAND,
                "payload": { "command": "нет такой" },
            }),
        );

        let message = frame(&mut receiver);
        assert_eq!(message["type"], json!(event_types::TERMINAL_LOG));
        assert_eq!(message["payload"]["service"], json!("CLI"));
        assert_eq!(message["payload"]["level"], json!("error"));
    }

    #[test]
    fn cli_completion_is_answered_only_to_the_requester() {
        let fixture = Fixture::new("cli-completion");
        let mut receiver = fixture.listen();

        handle_message(
            &fixture.diagnostics,
            None,
            Some(1),
            &json!({
                "type": event_types::EXEC_CLI_COMPLETION,
                "payload": { "input": "sc" },
            }),
        );

        let message = frame(&mut receiver);
        assert_eq!(message["type"], json!(event_types::CLI_COMPLETIONS));
        assert_eq!(message["payload"]["input"], json!("sc"));
        assert_eq!(message["payload"]["completions"], json!(["scene "]));
    }

    #[test]
    fn a_twitch_reward_test_runs_the_rule_actions() {
        let fixture = Fixture::new("reward-test");
        {
            let mut config = fixture.diagnostics.config();
            config::set_twitch_rewards(
                &mut config,
                &json!({ "rewards": [
                    {
                        "id": "r1",
                        "rewardId": "abc",
                        "rewardTitle": "Похвала",
                        "tts": true,
                        "ttsText": "Привет, {user}!",
                    }
                ] }),
            );
        }
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::CMD_TEST_TWITCH_REWARD,
                "payload": { "id": "r1" },
            }),
        );

        let message = frame(&mut receiver);
        assert_eq!(message["type"], json!(event_types::REWARD_TTS));
        assert_eq!(message["payload"]["text"], json!("Привет, Тест!"));
    }

    #[test]
    fn remote_actions_are_routed_to_their_handlers() {
        let fixture = Fixture::new("remote");
        let mut receiver = fixture.listen();

        // Счёт смертей — простое действие без сети: приращение и сброс.
        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::REMOTE_ACTION,
                "action": "DEATH_INCREMENT",
                "payload": {},
            }),
        );
        let message = frame(&mut receiver);
        assert_eq!(message["type"], json!(event_types::DEATH_COUNT_UPDATE));
        assert_eq!(message["payload"]["count"], json!(1));

        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::REMOTE_ACTION,
                "action": "DEATH_RESET",
                "payload": {},
            }),
        );
        let message = frame(&mut receiver);
        assert_eq!(message["type"], json!(event_types::DEATH_COUNT_UPDATE));
        assert_eq!(message["payload"]["count"], json!(0));
    }

    #[test]
    fn overlay_config_commands_merge_and_broadcast() {
        let fixture = Fixture::new("overlay-config");
        let mut receiver = fixture.listen();

        // Микрокадр: частичная запись сохраняет остальные поля (как `{...current, ...patch}`).
        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::CMD_SET_MIC_CONFIG,
                "payload": { "config": { "barCount": 64 } },
            }),
        );
        let message = frame(&mut receiver);
        assert_eq!(message["type"], json!(event_types::OVERLAY_MIC_CONFIG));
        assert_eq!(message["payload"]["config"]["barCount"], json!(64));
        assert_eq!(
            message["payload"]["config"]["visualizer_mode"],
            json!("sine")
        );

        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::CMD_SET_WHEEL_CONFIG,
                "payload": { "config": { "musicVolume": 80 } },
            }),
        );
        let message = frame(&mut receiver);
        assert_eq!(message["type"], json!(event_types::WHEEL_CONFIG));
        assert_eq!(message["payload"]["config"]["musicVolume"], json!(80));

        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::CMD_SET_WHEEL_SPEED_CONFIG,
                "payload": { "config": { "speed": 3 } },
            }),
        );
        assert_eq!(
            frame(&mut receiver)["type"],
            json!(event_types::WHEEL_SPEED_CONFIG)
        );

        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::CMD_SET_PARTICIPANTS_CONFIG,
                "payload": { "config": { "maxNames": 20 } },
            }),
        );
        let message = frame(&mut receiver);
        assert_eq!(
            message["type"],
            json!(event_types::OVERLAY_PARTICIPANTS_CONFIG)
        );
        assert_eq!(message["payload"]["config"]["maxNames"], json!(20));
    }

    #[test]
    fn adding_a_widget_broadcasts_the_layout() {
        let fixture = Fixture::new("widget");
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            None,
            &json!({ "type": event_types::CMD_ADD_WIDGET, "payload": { "type": "chat" } }),
        );

        let message = frame(&mut receiver);
        assert_eq!(message["type"], json!(event_types::LAYOUT_UPDATE));
        assert_eq!(message["payload"]["layout"].as_array().unwrap().len(), 1);
        assert_eq!(message["payload"]["layout"][0]["type"], json!("chat"));
    }

    #[test]
    fn an_unknown_command_changes_nothing() {
        let fixture = Fixture::new("unknown");
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            None,
            &json!({ "type": "cmd_from_the_future", "payload": {} }),
        );

        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn the_language_command_saves_and_broadcasts_locales() {
        let fixture = Fixture::new("lang");
        let locales = Locales::load(&crate::repository_root()).expect("словари");
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            Some(&locales),
            &json!({ "type": event_types::CMD_SET_LANGUAGE, "payload": { "lang": "ru" } }),
        );

        let message = frame(&mut receiver);
        assert_eq!(message["type"], json!(event_types::LOCALES));
        assert_eq!(message["payload"]["lang"], json!("ru"));
        assert!(message["payload"]["locales"]["ru"].is_object());
        assert_eq!(fixture.diagnostics.language(), "ru");
    }

    /// Все кадры рассылки указанного типа, уже разобранные.
    fn frames_of_type(receiver: &mut mpsc::UnboundedReceiver<Message>, kind: &str) -> Vec<Value> {
        let mut found = Vec::new();
        while let Ok(message) = receiver.try_recv() {
            if let Message::Text(text) = message {
                let value: Value = serde_json::from_str(text.as_str()).expect("кадр — JSON");
                if value["type"] == json!(kind) {
                    found.push(value);
                }
            }
        }
        found
    }

    #[test]
    fn a_test_alert_plays_through_the_queue() {
        let fixture = Fixture::new("test-alert");
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            None,
            &json!({ "type": event_types::CMD_TEST_ALERT, "payload": { "kind": "donation" } }),
        );

        let alerts = frames_of_type(&mut receiver, event_types::ALERT);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0]["payload"]["kind"], json!("donation"));
        assert_eq!(alerts[0]["payload"]["isTest"], json!(true));
        // Длительность доната — из словаря, а не умолчание.
        assert_eq!(alerts[0]["payload"]["durationMs"], json!(7000));
        assert_eq!(
            fixture.diagnostics.queue_snapshot()["now"]["kind"],
            json!("donation")
        );
    }

    #[test]
    fn a_queue_config_change_updates_rules_and_snapshot() {
        let fixture = Fixture::new("queue-config");
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::CMD_ALERT_QUEUE_CONFIG,
                "payload": { "minAmount": 250, "mergeSameUser": false, "mergeWindowSec": 45 },
            }),
        );

        let snapshot = fixture.diagnostics.queue_snapshot();
        assert_eq!(snapshot["rules"]["minAmount"], json!(250));
        assert_eq!(snapshot["rules"]["mergeSameUser"], json!(false));
        assert_eq!(snapshot["rules"]["mergeWindowSec"], json!(45));
        assert_eq!(snapshot["enabled"], json!(true));
        // Правила разошлись снимком очереди.
        let updates = frames_of_type(&mut receiver, event_types::ALERT_QUEUE_UPDATE);
        assert!(updates
            .iter()
            .any(|update| update["payload"]["queue"]["rules"]["minAmount"] == json!(250)));
    }

    #[test]
    fn starting_a_giveaway_announces_the_wheel_start_alert() {
        let fixture = Fixture::new("wheel-start");
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::CMD_START_GIVEAWAY,
                "payload": { "command": "!go" },
            }),
        );

        let alerts = frames_of_type(&mut receiver, event_types::ALERT);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0]["payload"]["kind"], json!("wheel_start"));
        assert_eq!(alerts[0]["payload"]["command"], json!("!go"));
        // Длительность — из словаря `shared/events.js`.
        assert_eq!(alerts[0]["payload"]["durationMs"], json!(6000));
    }

    #[test]
    fn a_winner_finishes_the_round_with_a_winner_alert() {
        let fixture = Fixture::new("wheel-winner");
        // Готовим участника и «выбираем» его так же, как это делает спин.
        {
            let mut runtime = fixture.diagnostics.runtime();
            runtime.start_giveaway(&json!("!go"));
            runtime.add_giveaway_participant(&json!("alice"));
            runtime.pick_random_winner();
        }
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::CMD_SET_GIVEAWAY_WINNER,
                "payload": { "username": "alice" },
            }),
        );

        // `frames_of_type` вычерпывает очередь целиком, поэтому проверяем только
        // алерт: сам `giveaway_update` покрыт тестами рантайма.
        let alerts = frames_of_type(&mut receiver, event_types::ALERT);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0]["payload"]["kind"], json!("wheel_winner"));
        assert_eq!(alerts[0]["payload"]["user"], json!("alice"));
        assert_eq!(alerts[0]["payload"]["isElimination"], json!(false));
        assert_eq!(alerts[0]["payload"]["isFinalWinner"], json!(false));
        // Обычный режим: карточка победителя висит столько же, сколько в словаре.
        assert_eq!(alerts[0]["payload"]["durationMs"], json!(8000));
    }

    #[test]
    fn an_elimination_winner_marks_the_alert_for_the_next_round() {
        let fixture = Fixture::new("wheel-elimination");
        // Победителя выбирает тот же путь, что и спин, — берём его же в ответе,
        // иначе имя разошлось бы с `pendingWinner` и ход не зачлся бы.
        let winner = {
            let mut runtime = fixture.diagnostics.runtime();
            runtime.start_giveaway(&json!("!go"));
            runtime.add_giveaway_participant(&json!("alice"));
            runtime.add_giveaway_participant(&json!("bob"));
            runtime.set_giveaway_elimination_mode(&json!(true));
            runtime.pick_random_winner().expect("участники есть")
        };
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::CMD_SET_GIVEAWAY_WINNER,
                "payload": { "username": winner },
            }),
        );

        let alerts = frames_of_type(&mut receiver, event_types::ALERT);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0]["payload"]["user"], json!(winner));
        assert_eq!(alerts[0]["payload"]["isElimination"], json!(true));
        assert_eq!(alerts[0]["payload"]["isFinalWinner"], json!(false));
        // Карточка выбывания короче — затем крутится следующий.
        assert_eq!(alerts[0]["payload"]["durationMs"], json!(3000));
        // Победитель снят с барабана, остался один участник.
        let snapshot = fixture.diagnostics.runtime().giveaway_snapshot();
        assert_eq!(snapshot["count"], json!(1));
        let remaining = snapshot["participants"].as_array().unwrap();
        assert!(!remaining.iter().any(|name| name == &json!(winner)));
    }

    #[test]
    fn a_second_spin_does_not_start_while_the_first_is_running() {
        let fixture = Fixture::new("wheel-spin-guard");
        {
            let mut runtime = fixture.diagnostics.runtime();
            runtime.start_giveaway(&json!("!go"));
            runtime.add_giveaway_participant(&json!("alice"));
            runtime.add_giveaway_participant(&json!("bob"));
        }
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            None,
            &json!({ "type": event_types::CMD_SPIN_WHEEL, "payload": {} }),
        );
        assert!(fixture.diagnostics.wheel().is_spinning());
        assert_eq!(
            frames_of_type(&mut receiver, event_types::GIVEAWAY_SPIN).len(),
            1
        );

        // Пока идёт первый спин, второй молчит.
        handle(
            &fixture.diagnostics,
            None,
            &json!({ "type": event_types::CMD_SPIN_WHEEL, "payload": {} }),
        );
        assert!(receiver.try_recv().is_err());

        // Страница колеса ответила победителем — цикл завершён, запрет снят.
        fixture.diagnostics.wheel().end_spin();
        assert!(!fixture.diagnostics.wheel().is_spinning());
    }

    #[test]
    fn sending_chat_without_twitch_authorization_reports_not_configured() {
        let fixture = Fixture::new("send-chat");
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            None,
            &json!({
                "type": event_types::CMD_SEND_CHAT,
                "payload": { "message": "привет", "clientId": "c1" },
            }),
        );

        // Отправка идёт в фоновой задаче: ждём кадр с результатом (без сети —
        // Twitch не настроен, и запрос не уходит).
        let mut sent = None;
        for _ in 0..400 {
            match receiver.try_recv() {
                Ok(Message::Text(text)) => {
                    let value: Value = serde_json::from_str(text.as_str()).expect("кадр — JSON");
                    if value["type"] == json!(event_types::CHAT_SENT) {
                        sent = Some(value);
                        break;
                    }
                }
                Ok(_) => {}
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
            }
        }

        let sent = sent.expect("кадр chat_sent");
        assert_eq!(sent["payload"]["clientId"], json!("c1"));
        assert_eq!(sent["payload"]["ok"], json!(false));
        assert_eq!(sent["payload"]["error"], json!("not_configured"));
    }
}
