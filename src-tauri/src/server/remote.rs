//! Приём команд пульта (смартфон, Stream Deck) — `handleRemoteAction` из `index.js`.
//!
//! Пульт говорит на той же шине, что и панель, но другим словарём: сообщение
//! `remote_action` несёт `action` и `payload`, а не `type` команды. Здесь порт
//! всех действий: переходы сцен со сплешем, колесо фортуны, счёт смертей,
//! тестовый алерт, тема, команды OBS (камера, фильтр, веб-камера, микрофон) и
//! саундборд — с теми же побочными эффектами, что в Electron-версии.
//!
//! Серверный цикл колеса (флаг спина, автоспин, автоскрытие) живёт в
//! [`Diagnostics::wheel`], а не здесь: его правят и действия пульта, и команды
//! панели (`cmd_spin_wheel`, `cmd_set_giveaway_winner`).

use serde_json::{json, Value};

use crate::alerts::build_test_alert;
use crate::diagnostics::Diagnostics;
use crate::protocol::event_types;
use crate::state::appearance;
use crate::storage::history::js_truthy;

/// Какие источники OBS переключает пульт.
#[derive(Clone, Copy)]
enum ToggleKind {
    Webcam,
    Mic,
}

/// Обработать сообщение `remote_action`.
pub fn handle(diagnostics: &Diagnostics, message: &Value) {
    let action = message
        .get("action")
        .map(crate::state::js_string)
        .unwrap_or_default()
        .to_uppercase();
    let payload = message.get("payload").cloned().unwrap_or_else(|| json!({}));

    match action.as_str() {
        "SCENE_SET" => scene_set(diagnostics, &payload),
        "WHEEL_START" => wheel_start(diagnostics, &payload),
        "WHEEL_STOP" => wheel_stop(diagnostics),
        "WHEEL_SPIN" => wheel_spin(diagnostics),
        "WHEEL_GENERATE" => wheel_generate(diagnostics),
        "WHEEL_RESET_PARTICIPANTS" => wheel_reset_participants(diagnostics),
        "WHEEL_CLEAR_RESULT" => wheel_clear_result(diagnostics),
        "DEATH_INCREMENT" => death(diagnostics, 1.0),
        "DEATH_DECREMENT" => death(diagnostics, -1.0),
        "DEATH_RESET" => {
            let value = { diagnostics.runtime().reset_death_count() };
            broadcast(diagnostics, event_types::DEATH_COUNT_UPDATE, value);
        }
        "TEST_ALERT" => test_alert(diagnostics, &payload),
        "THEME_SET" => theme_set(diagnostics, &payload),
        "OBS_RAW_COMMAND" => {
            diagnostics.run_obs_command(payload.get("id").cloned().unwrap_or(Value::Null));
        }
        "SOUNDBOARD_TRIGGER" => {
            let sound_id = text(&payload, "soundId");
            let user = text(&payload, "user");
            diagnostics.trigger_soundboard(&sound_id, &user);
        }
        "CAMERA_SET" => {
            let angle_id = text(&payload, "angleId");
            let obs = diagnostics.obs();
            std::mem::drop(tauri::async_runtime::spawn(async move {
                let _ = obs.set_camera_angle(&angle_id).await;
            }));
        }
        "CAMERA_FILTER" => {
            let filter_id = text(&payload, "filterId");
            let obs = diagnostics.obs();
            std::mem::drop(tauri::async_runtime::spawn(async move {
                let _ = obs.trigger_camera_filter(&filter_id, None).await;
            }));
        }
        "WEBCAM_TOGGLE" => toggle_source(diagnostics, "webcamSource", ToggleKind::Webcam),
        "MIC_TOGGLE" => toggle_source(diagnostics, "micSource", ToggleKind::Mic),
        _ => diagnostics
            .logger("server")
            .warn("unknown remote action", Some(&json!({ "action": action }))),
    }
}

/// `SCENE_SET`: переход сцены; при настроенной заставке сначала играет она, а на
/// целевую сцену возвращает [`splash_ended`].
fn scene_set(diagnostics: &Diagnostics, payload: &Value) {
    let scene = payload
        .get("scene")
        .filter(|value| js_truthy(Some(value)))
        .map(crate::state::js_string)
        .unwrap_or_else(|| "main".to_string())
        .to_lowercase();

    let (scene_map, scenes, splash) = {
        let config = diagnostics.config();
        let obs = config.get("obs");
        (
            obs.and_then(|obs| obs.get("sceneMap"))
                .cloned()
                .unwrap_or(Value::Null),
            config.get("scenes").cloned().unwrap_or(Value::Null),
            config.get("splash").cloned().unwrap_or(Value::Null),
        )
    };
    let scene_name = scene_map
        .get(scene.as_str())
        .map(crate::state::js_string)
        .unwrap_or_default();
    let video_scene = scene_map
        .get("video")
        .map(crate::state::js_string)
        .unwrap_or_default();

    // Ручной переход отменяет незакончённую заставку.
    diagnostics.set_pending_video(None);

    // Заставка играется на переходах: возврат служебных сцен → main (интро) и
    // вход в служебную сцену. Приоритет файла: сцена → общий → стандартный.
    let current = diagnostics.runtime().active_scene();
    let return_splash = ["start", "brb", "talk", "end", "wheel", "poll"];
    let enter_splash = ["brb", "talk", "end", "wheel", "poll"];
    let mut splash_scene = String::new();
    if scene == "main" && return_splash.contains(&current.as_str()) {
        splash_scene = current.clone();
    } else if enter_splash.contains(&scene.as_str()) {
        splash_scene = scene.clone();
    }
    // Выключенная в «Заставках» сцена пропускает заставку.
    if !splash_scene.is_empty()
        && scenes
            .get(splash_scene.as_str())
            .and_then(|scene| scene.get("splashEnabled"))
            == Some(&Value::Bool(false))
    {
        splash_scene.clear();
    }

    let scene_splash_file = if splash_scene.is_empty() {
        String::new()
    } else {
        scenes
            .get(splash_scene.as_str())
            .and_then(|scene| scene.get("splashFile"))
            .map(crate::state::js_string)
            .unwrap_or_default()
    };
    let global_splash_file = splash
        .get("file")
        .map(crate::state::js_string)
        .unwrap_or_default();
    let splash_file = if scene_splash_file.is_empty() {
        global_splash_file
    } else {
        scene_splash_file
    };

    let scene_splash_duration = if splash_scene.is_empty() {
        0.0
    } else {
        scenes
            .get(splash_scene.as_str())
            .and_then(|scene| scene.get("splashDuration"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    };
    let global_splash_duration = splash
        .get("duration")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let splash_duration = if scene_splash_duration > 0.0 {
        scene_splash_duration
    } else {
        global_splash_duration
    };

    let obs = diagnostics.obs();
    let obs_connected = obs.is_connected();
    if !splash_scene.is_empty() && obs_connected && !video_scene.is_empty() {
        let title = scenes
            .get(splash_scene.as_str())
            .and_then(|scene| scene.get("title"))
            .map(crate::state::js_string)
            .unwrap_or_default();
        let splash_payload = json!({
            "mediaFile": splash_file,
            "scene": splash_scene,
            "title": title,
            "duration": splash_duration,
            "nextScene": scene,
        });
        obs.switch_scene(&video_scene);
        diagnostics.set_pending_video(Some(json!({
            "sceneName": scene_name,
            "splash": splash_payload.clone(),
        })));
        broadcast(diagnostics, event_types::VIDEO_SPLASH_PLAY, splash_payload);
        diagnostics.logger("server").info(
            "splash playing, pending scene switch",
            Some(&json!({
                "scene": scene,
                "splashScene": splash_scene,
                "mediaFile": splash_file,
                "videoSceneName": video_scene,
            })),
        );
    } else if obs_connected && !scene_name.is_empty() {
        obs.switch_scene(&scene_name);
    }

    let started_at = {
        let mut runtime = diagnostics.runtime();
        runtime.set_active_scene(&Value::from(scene.clone()), now_ms());
        runtime.scene_started_at()
    };
    broadcast(
        diagnostics,
        event_types::REMOTE_ACTION,
        json!({
            "action": "SCENE_SET",
            "payload": { "scene": scene, "startedAt": started_at },
        }),
    );
    diagnostics.logger("server").info(
        "remote scene switch",
        Some(&json!({ "scene": scene, "sceneName": scene_name })),
    );
}

/// Возврат с целевой сцены после заставки — `VIDEO_SPLASH_ENDED`.
pub fn splash_ended(diagnostics: &Diagnostics) {
    let target = diagnostics.take_pending_video();
    let scene_name = target
        .as_ref()
        .and_then(|target| target.get("sceneName"))
        .map(crate::state::js_string)
        .unwrap_or_default();
    let obs = diagnostics.obs();
    if target.is_none() || !obs.is_connected() || scene_name.is_empty() {
        diagnostics
            .logger("server")
            .info("splash finished (no pending target)", None);
        return;
    }

    obs.switch_scene(&scene_name);
    // Сцена становится видимой только сейчас — с этого момента и отсчёт.
    let started_at = {
        let mut runtime = diagnostics.runtime();
        runtime.mark_scene_started(now_ms())
    };
    let next_scene = target
        .as_ref()
        .and_then(|target| target.get("splash"))
        .and_then(|splash| splash.get("nextScene"))
        .cloned()
        .unwrap_or(Value::Null);
    if js_truthy(Some(&next_scene)) {
        broadcast(
            diagnostics,
            event_types::REMOTE_ACTION,
            json!({
                "action": "SCENE_SET",
                "payload": { "scene": next_scene, "startedAt": started_at },
            }),
        );
    }
    diagnostics.logger("server").info(
        "splash finished — switching to scene",
        Some(&json!({ "sceneName": scene_name })),
    );
}

/// Переподключение оверлея заставки — повторить незакончённую заставку.
pub fn splash_ready(diagnostics: &Diagnostics) {
    if let Some(splash) = diagnostics
        .pending_video()
        .and_then(|target| target.get("splash").cloned())
        .filter(|splash| js_truthy(Some(splash)))
    {
        broadcast(diagnostics, event_types::VIDEO_SPLASH_PLAY, splash);
    }
}

fn wheel_start(diagnostics: &Diagnostics, payload: &Value) {
    // Как `WHEEL_START`: снять таймеры прошлого цикла, прежде чем начинать новый.
    diagnostics.wheel().reset();
    let giveaway = {
        let mut runtime = diagnostics.runtime();
        runtime.start_giveaway(payload.get("command").unwrap_or(&Value::Null))
    };
    let command = giveaway.get("command").cloned().unwrap_or(Value::Null);
    broadcast_giveaway(diagnostics, &giveaway);
    // Колесо крутится по алерту — как `bus.emit("alert", { kind: "wheel_start" })`.
    diagnostics.broadcast_wheel_alert(&json!({ "kind": "wheel_start", "command": command }));
}

fn wheel_stop(diagnostics: &Diagnostics) {
    diagnostics.wheel().clear_auto_spin();
    diagnostics.wheel().end_spin();
    let giveaway = { diagnostics.runtime().stop_giveaway() };
    broadcast_giveaway(diagnostics, &giveaway);
}

fn wheel_spin(diagnostics: &Diagnostics) {
    // Спин может уже идти — тогда второй не начинаем.
    diagnostics.wheel().spin_if_idle();
}

fn wheel_generate(diagnostics: &Diagnostics) {
    diagnostics.wheel().clear_hide();
    let sectors = { diagnostics.runtime().giveaway_snapshot()["participants"].clone() };
    broadcast(
        diagnostics,
        event_types::GIVEAWAY_WHEEL,
        json!({ "sectors": sectors }),
    );
}

fn wheel_reset_participants(diagnostics: &Diagnostics) {
    diagnostics.wheel().reset();
    let giveaway = { diagnostics.runtime().clear_giveaway_participants() };
    broadcast_giveaway(diagnostics, &giveaway);
    broadcast(
        diagnostics,
        event_types::GIVEAWAY_WHEEL,
        json!({ "sectors": [] }),
    );
}

fn wheel_clear_result(diagnostics: &Diagnostics) {
    let giveaway = { diagnostics.runtime().clear_giveaway_result() };
    broadcast_giveaway(diagnostics, &giveaway);
    let sectors = { diagnostics.runtime().giveaway_snapshot()["participants"].clone() };
    broadcast(
        diagnostics,
        event_types::GIVEAWAY_WHEEL,
        json!({ "sectors": sectors }),
    );
}

fn death(diagnostics: &Diagnostics, delta: f64) {
    let value = { diagnostics.runtime().adjust_death_count(&json!(delta)) };
    broadcast(diagnostics, event_types::DEATH_COUNT_UPDATE, value);
}

fn test_alert(diagnostics: &Diagnostics, payload: &Value) {
    let mut alert = build_test_alert(payload.get("kind").unwrap_or(&Value::Null));
    if let Value::Object(map) = &mut alert {
        map.insert("isTest".to_string(), Value::Bool(true));
        let kind = map
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("follow")
            .to_string();
        let duration = crate::protocol::alert_duration_ms(&kind).unwrap_or(5000);
        map.entry("durationMs".to_string())
            .or_insert(Value::from(duration));
    }
    // Через шину, как `bus.emit("alert", …)`: тест играет даже на паузе и не
    // режется по сумме, а событие попадает в историю и «последние события».
    diagnostics.emit_bus(json!({ "type": event_types::ALERT, "payload": alert }));
}

fn theme_set(diagnostics: &Diagnostics, payload: &Value) {
    // `themeId` — если строка; иначе `id` — как в JS.
    let id = payload
        .get("themeId")
        .filter(|value| value.is_string())
        .cloned()
        .unwrap_or_else(|| payload.get("id").cloned().unwrap_or(Value::Null));
    if !id.is_string() {
        return;
    }
    let enable3d = payload.get("enable3d").and_then(Value::as_bool);
    let changed = {
        let mut config = diagnostics.config();
        appearance::set_active_theme(&mut config, &id, enable3d)
    };
    if changed {
        let appearance = diagnostics.state_snapshot()["appearance"].clone();
        broadcast(diagnostics, event_types::THEME_UPDATE, appearance);
    }
}

fn toggle_source(diagnostics: &Diagnostics, config_key: &str, kind: ToggleKind) {
    let source_name = {
        let config = diagnostics.config();
        config
            .get("obs")
            .and_then(|obs| obs.get(config_key))
            .map(crate::state::js_string)
            .unwrap_or_default()
    };
    let (label, field, missing) = match kind {
        ToggleKind::Webcam => (
            "webcam",
            "enabled",
            "webcam toggle skipped (no webcam source configured)",
        ),
        ToggleKind::Mic => (
            "mic",
            "muted",
            "mic toggle skipped (no mic source configured)",
        ),
    };
    if source_name.is_empty() {
        diagnostics.logger("server").warn(missing, None);
        return;
    }
    let obs = diagnostics.obs();
    let logger = diagnostics.logger("server");
    std::mem::drop(tauri::async_runtime::spawn(async move {
        let result = match kind {
            ToggleKind::Webcam => obs.toggle_webcam(&source_name).await,
            ToggleKind::Mic => obs.toggle_mic_mute(&source_name).await,
        };
        match result {
            Ok(state) => {
                let mut data = serde_json::Map::new();
                data.insert("sourceName".to_string(), Value::from(source_name));
                data.insert(field.to_string(), Value::from(state));
                logger.info(&format!("{label} toggled"), Some(&Value::Object(data)));
            }
            Err(message) => logger.warn(
                &format!("{label} toggle failed"),
                Some(&json!({ "message": message })),
            ),
        }
    }));
}

/// Текстовое значение поля payload — как `String(x)` там, где JS его ждёт.
fn text(payload: &Value, key: &str) -> String {
    payload
        .get(key)
        .map(crate::state::js_string)
        .unwrap_or_default()
}

fn broadcast(diagnostics: &Diagnostics, kind: &str, payload: Value) {
    let text = json!({ "type": kind, "payload": payload }).to_string();
    diagnostics.clients().broadcast_text(&text);
}

fn broadcast_giveaway(diagnostics: &Diagnostics, giveaway: &Value) {
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

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
