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
        "TICKER_MESSAGE" => ticker_message(diagnostics, &payload),
        // Музыка донатов: те же действия, что кнопки в инспекторе виджета.
        "MUSIC_SKIP" => music_control(diagnostics, "skip"),
        "MUSIC_STOP" => music_control(diagnostics, "stop"),
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
    let return_splash = ["start", "brb", "talk", "guests", "end", "wheel", "poll"];
    let enter_splash = ["brb", "talk", "guests", "end", "wheel", "poll"];
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
    // Заставка живёт в отдельной сцене OBS. Если её там нет (или список сцен ещё
    // не получен), откладывать переход нельзя: `video_splash_ended` не придёт,
    // и OBS останется на сцене заставки навсегда. Лучше переключиться сразу.
    let video_scene_ready = obs_connected && !video_scene.is_empty() && obs.has_scene(&video_scene);
    if !splash_scene.is_empty() && video_scene_ready {
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
        if !splash_scene.is_empty() && !video_scene.is_empty() {
            diagnostics.logger("server").warn(
                "splash scene missing in OBS — switching directly",
                Some(&json!({ "scene": scene, "videoScene": video_scene })),
            );
        }
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

/// Выключить/включить камеру в OBS — тот же путь, что у кнопки пульта.
/// Зовётся глобальным хоткеем: если источник не настроен, молча ничего не
/// делаем, чтобы не засорять журнал на каждом нажатии.
pub fn toggle_webcam_source_if_configured(diagnostics: &Diagnostics) {
    let configured = diagnostics
        .config()
        .get("obs")
        .and_then(|obs| obs.get("webcamSource"))
        .map(crate::state::js_string)
        .is_some_and(|name| !name.is_empty());
    if configured {
        toggle_source(diagnostics, "webcamSource", ToggleKind::Webcam);
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

/// Управление плеером музыки: `skip` берёт следующий трек из очереди, `stop`
/// гасит его и очищает очередь. Слушает виджет, поэтому донат-алерты
/// и цель не трогаются.
fn music_control(diagnostics: &Diagnostics, action: &str) {
    broadcast(
        diagnostics,
        event_types::MUSIC_CONTROL,
        json!({ "action": action }),
    );
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

/// Максимальная длина сообщения в новостной ленте: длинная строка занимала бы
/// весь экран и мешала читать остальные события.
const TICKER_TEXT_LIMIT: usize = 300;

/// Произвольное сообщение в новостную ленту. `breaking` уходит отдельной
/// приоритетной полосой, остальное — в общий поток.
fn ticker_message(diagnostics: &Diagnostics, payload: &Value) {
    let body: String = text(payload, "text")
        .trim()
        .chars()
        .take(TICKER_TEXT_LIMIT)
        .collect();
    if body.is_empty() {
        return;
    }
    let breaking = text(payload, "priority").eq_ignore_ascii_case("breaking");
    let mut frame = json!({
        "text": body,
        "priority": if breaking { "breaking" } else { "normal" },
    });
    if let Some(ms) = payload.get("durationMs").and_then(Value::as_f64) {
        frame["durationMs"] = json!(ms.round().clamp(2000.0, 60_000.0) as i64);
    }
    broadcast(diagnostics, event_types::TICKER_MESSAGE, frame);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::paths::Storage;
    use axum::extract::ws::Message;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::sync::mpsc;

    /// Диагностика во временном каталоге и слушатель рассылки.
    struct Fixture {
        dir: PathBuf,
        diagnostics: Diagnostics,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let index = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir()
                .join(format!("ose-remote-{}-{label}-{index}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            fs::write(dir.join("config.example.json"), "{\n  \"port\": 8710\n}\n")
                .expect("шаблон должен записываться");
            let mut diagnostics =
                Diagnostics::open(Storage::beside_sources(dir.clone())).expect("диагностика");
            diagnostics.normalize();
            Self { dir, diagnostics }
        }

        fn listen(&self) -> mpsc::UnboundedReceiver<Message> {
            let (sender, receiver) = mpsc::unbounded_channel();
            self.diagnostics
                .clients()
                .add("scene".to_string(), false, sender);
            receiver
        }

        fn switch(&self, scene: &str) -> i64 {
            handle(
                &self.diagnostics,
                &json!({ "action": "SCENE_SET", "payload": { "scene": scene } }),
            );
            self.diagnostics
                .runtime()
                .scene_started_at()
                .expect("момент активации записан")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.dir).ok();
        }
    }

    fn frame(receiver: &mut mpsc::UnboundedReceiver<Message>) -> Value {
        match receiver.try_recv().expect("кадр должен быть") {
            Message::Text(text) => serde_json::from_str(text.as_str()).expect("кадр — JSON"),
            other => panic!("ожидался текст, пришло {other:?}"),
        }
    }

    #[test]
    fn the_remote_can_skip_and_stop_music() {
        let fixture = Fixture::new("music-control");
        let mut receiver = fixture.listen();

        for (command, action) in [("MUSIC_SKIP", "skip"), ("MUSIC_STOP", "stop")] {
            handle(
                &fixture.diagnostics,
                &json!({ "action": command, "payload": {} }),
            );
            let frame = frame(&mut receiver);
            assert_eq!(frame["type"], json!(event_types::MUSIC_CONTROL));
            assert_eq!(frame["payload"]["action"], json!(action));
        }
    }

    #[test]
    fn a_scene_switch_gives_the_overlay_a_start_moment() {
        let fixture = Fixture::new("scene-set");
        let mut receiver = fixture.listen();

        let before = now_ms();
        let started_at = fixture.switch("brb");
        let after = now_ms();

        // Оверлей запускает отсчёт именно от этой метки, поэтому она должна
        // совпадать с моментом переключения и с тем, что ушло в кадр.
        assert!(started_at >= before && started_at <= after);

        let frame = frame(&mut receiver);
        assert_eq!(frame["type"], json!(event_types::REMOTE_ACTION));
        assert_eq!(frame["payload"]["action"], json!("SCENE_SET"));
        assert_eq!(frame["payload"]["payload"]["scene"], json!("brb"));
        assert_eq!(frame["payload"]["payload"]["startedAt"], json!(started_at));

        assert_eq!(fixture.diagnostics.runtime().active_scene(), "brb");
        assert_eq!(
            fixture.diagnostics.runtime().scene_started_at(),
            Some(started_at)
        );
    }

    #[test]
    fn switching_to_the_same_scene_restarts_the_countdown() {
        let fixture = Fixture::new("same-scene");
        let first = fixture.switch("start");
        std::thread::sleep(Duration::from_millis(5));
        let second = fixture.switch("start");

        // Вернуться на ту же сцену — значит начать её заново, как в Electron-версии.
        assert!(second > first, "{second} должно быть позже {first}");
    }

    #[test]
    fn an_empty_scene_falls_back_to_main() {
        let fixture = Fixture::new("main-fallback");
        fixture.switch("");
        assert_eq!(fixture.diagnostics.runtime().active_scene(), "main");
    }

    #[test]
    fn a_ticker_message_reaches_the_overlay() {
        let fixture = Fixture::new("ticker");
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            &json!({
                "action": "TICKER_MESSAGE",
                "payload": { "text": "  Привет  ", "priority": "breaking", "durationMs": 5000 },
            }),
        );

        let frame = frame(&mut receiver);
        assert_eq!(frame["type"], json!(event_types::TICKER_MESSAGE));
        assert_eq!(frame["payload"]["text"], json!("Привет"));
        assert_eq!(frame["payload"]["priority"], json!("breaking"));
        assert_eq!(frame["payload"]["durationMs"], json!(5000));
    }

    #[test]
    fn an_empty_ticker_message_is_ignored() {
        let fixture = Fixture::new("ticker-empty");
        let mut receiver = fixture.listen();

        handle(
            &fixture.diagnostics,
            &json!({ "action": "TICKER_MESSAGE", "payload": { "text": "   " } }),
        );

        assert!(receiver.try_recv().is_err());
    }
}
