//! Полноэкранные сцены, сплеш и крупный донат.
//!
//! Порт части `server/state.js`: данные `defaultScenes()` из
//! `shared/scenes-catalog.js` и методы `setSceneConfig`, `setSplashConfig`,
//! `resetTopDonation`, `maybeUpdateTopDonation`.
//!
//! Сцены — это отдельные Browser Source в OBS (начало, перерыв, разговор,
//! окончание, колесо, голосование, пауза), в отличие от виджетов оверлея. Их
//! умолчания лежат здесь же: конструктор `state.js` домазывает недостающие поля
//! сцен из этих значений, и без этого старый конфиг без поля «вёл себя» бы
//! иначе, чем свежий.
//!
//! Все тексты обрезаются по длине, как в JS: подписи сцен уезжают в оверлей и в
//! окно поверх игры, где длина строки видна глазом.

use serde_json::{json, Map, Value};

use crate::state::js_string;
use crate::storage::config_file::ConfigFile;
use crate::storage::history::{js_number_or_zero, js_truthy, number_value};

/// Соцсети по умолчанию в сценах — как `DEFAULT_SOCIALS`.
fn default_socials() -> Value {
    json!([
        { "platform": "TG", "text": "t.me/your_channel" },
        { "platform": "DC", "text": "discord.gg/your_server" },
        { "platform": "YT", "text": "youtube.com/@channel" },
    ])
}

/// Рамка камеры на сцене: положение/размер в процентах и настройки самого
/// виджета. Полей ровно столько, сколько читает `WebcamWidget`; радиус не
/// задан — значит, рамка берёт скругление темы.
fn default_camera() -> Value {
    json!({
        "enabled": false,
        "x": 3,
        "y": 60,
        "w": 24,
        "h": 24,
        "config": {
            "source": "camera",
            "label": "LIVE",
            "labelPosition": "top-left",
            "showLabel": true,
            "showBorder": true,
            "showCorners": true,
            "showBackground": false,
            "showVignette": false,
            "thickness": 4,
            "color": "",
            "mirror": false,
            "fit": "cover",
            "perspective": 0,
            "perspectiveDirection": "left",
        },
    })
}

/// Виджет алертов на сцене: положение/размер в процентах холста. Сами
/// настройки виджета не нужны — он использует карточки оверлея и токены темы.
fn default_alerts(enabled: bool) -> Value {
    json!({
        "enabled": enabled,
        "widget": "uec",
        "x": 68,
        "y": 2,
        "w": 28,
        "h": 30,
    })
}

/// Сцены по умолчанию — порт `defaultScenes()`.
///
/// Порядок сцен и полей повторён по JS. У `pause` нет `splashEnabled` — так в
/// исходнике, и повторяем это как есть, чтобы диффы конфига не появлялись на
/// ровном месте.
pub fn default_scenes() -> Value {
    let socials = default_socials();
    let camera = default_camera();
    // На «Разговоре» алерты были и раньше; на остальных сценах — по желанию.
    let alerts_off = default_alerts(false);
    let alerts_on = default_alerts(true);
    json!({
        "start": {
            "statusLabel": "СТРИМ СКОРО НАЧНЁТСЯ",
            "title": "Скоро начнём",
            "subtitle": "Стрим начнётся через несколько минут. Не переключайтесь!",
            "splashFile": "",
            "splashDuration": 0,
            "splashEnabled": true,
            "showTimer": true,
            "timerDuration": 600,
            "timerDoneText": "Начинаем прямо сейчас!",
            "showEvents": true,
            "showSocials": true,
            "socials": socials.clone(),
            "camera": camera.clone(),
            "alerts": alerts_off.clone(),
        },
        "brb": {
            "statusLabel": "ПЕРЕРЫВ НА СТРИМЕ",
            "title": "Скоро вернусь",
            "subtitle": "Стрим возобновится через несколько минут. Не переключайтесь!",
            "splashFile": "",
            "splashDuration": 0,
            "splashEnabled": true,
            "showTimer": true,
            "timerDuration": 300,
            "timerDoneText": "Стрим возобновится прямо сейчас!",
            "showEvents": true,
            "showSocials": true,
            "socials": socials.clone(),
            "camera": camera.clone(),
            "alerts": alerts_off.clone(),
        },
        "talk": {
            "statusLabel": "ОБЩАЕМСЯ",
            "title": "Разговор со зрителями",
            "subtitle": "Задавайте вопросы в чате!",
            "splashFile": "",
            "splashDuration": 0,
            "splashEnabled": true,
            "showTimer": false,
            "timerDuration": 0,
            "timerDoneText": "",
            "showEvents": true,
            "showSocials": true,
            "socials": socials.clone(),
            "camera": camera.clone(),
            "alerts": alerts_on.clone(),
        },
        "end": {
            "statusLabel": "СТРИМ ЗАВЕРШЁН",
            "title": "Спасибо за просмотр!",
            "subtitle": "Увидимся в следующий раз",
            "splashFile": "",
            "splashDuration": 0,
            "splashEnabled": true,
            "showTimer": false,
            "timerDuration": 0,
            "timerDoneText": "",
            "showEvents": true,
            "showSocials": true,
            "socials": socials.clone(),
            "camera": camera.clone(),
            "alerts": alerts_off.clone(),
        },
        "wheel": {
            "statusLabel": "РОЗЫГРЫШ",
            "title": "Колесо Фортуны",
            "subtitle": "Победителя определит колесо",
            "splashFile": "",
            "splashDuration": 0,
            "splashEnabled": true,
            "showTimer": false,
            "timerDuration": 0,
            "timerDoneText": "",
            "showEvents": false,
            "showSocials": false,
            "socials": [],
            "camera": camera.clone(),
            "alerts": alerts_off.clone(),
        },
        "poll": {
            "statusLabel": "ГОЛОСОВАНИЕ",
            "title": "Голосование",
            "subtitle": "Голосуйте в чате!",
            "splashFile": "",
            "splashDuration": 0,
            "splashEnabled": true,
            "showTimer": false,
            "timerDuration": 0,
            "timerDoneText": "",
            "showEvents": false,
            "showSocials": false,
            "socials": [],
            "camera": camera.clone(),
            "alerts": alerts_off.clone(),
        },
        "pause": {
            "statusLabel": "ПАУЗА",
            "title": "Пауза",
            "subtitle": "",
            "splashFile": "",
            "splashDuration": 0,
            "backgroundFile": "",
            "showTimer": false,
            "timerDuration": 0,
            "timerDoneText": "",
            "showEvents": false,
            "showSocials": false,
            "socials": [],
            "camera": camera,
            "alerts": alerts_off,
        },
    })
}

/// Домешать умолчания в недостающие сцены и поля — как конструктор `state.js`.
///
/// Поля, уже лежащие в настройках, побеждают; посторонние сцены не трогаются.
pub fn normalize_scenes(config: &mut ConfigFile) {
    let mut scenes = config
        .get("scenes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    if let Some(defaults) = default_scenes().as_object() {
        for (id, default) in defaults {
            let existing = scenes
                .get(id)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let merged = merge(
                default.as_object().expect("сцена — объект"),
                Some(&existing),
            );
            let mut merged = merged;
            // Камера — вложенный объект, поэтому обычного поверхностного
            // слияния мало: иначе старый конфиг с одним полем камеры терял бы
            // остальные умолчания (источник, подпись, толщину).
            if let (Some(default_camera), Some(existing_camera)) = (
                default.get("camera").and_then(Value::as_object),
                existing.get("camera").and_then(Value::as_object),
            ) {
                merged.insert(
                    "camera".to_string(),
                    Value::Object(merge_camera(default_camera, existing_camera)),
                );
            }
            // Алерты — тоже вложенный объект: старый конфиг с одним
            // `enabled` не должен терять положение и размеры.
            if let (Some(default_alerts), Some(existing_alerts)) = (
                default.get("alerts").and_then(Value::as_object),
                existing.get("alerts").and_then(Value::as_object),
            ) {
                merged.insert(
                    "alerts".to_string(),
                    Value::Object(merge(default_alerts, Some(existing_alerts))),
                );
            }
            scenes.insert(id.clone(), Value::Object(merged));
        }
    }

    config.set("scenes", Value::Object(scenes));
}

/// Изменить сцену; `None` — такой сцены нет.
pub fn set_scene_config(config: &mut ConfigFile, scene_id: &Value, patch: &Value) -> Option<Value> {
    let id = js_string(scene_id);
    let mut scenes = config
        .get("scenes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let scene = scenes.get(&id).and_then(Value::as_object).cloned()?;

    let mut next = scene;
    if let Some(value) = patch.get("statusLabel") {
        next.insert("statusLabel".to_string(), sliced(value, 60, true));
    }
    if let Some(value) = patch.get("title") {
        next.insert("title".to_string(), sliced(value, 80, true));
    }
    if let Some(value) = patch.get("subtitle") {
        next.insert("subtitle".to_string(), sliced(value, 160, true));
    }
    if let Some(value) = patch.get("timerDoneText") {
        next.insert("timerDoneText".to_string(), sliced(value, 120, true));
    }
    if let Some(value) = patch.get("showTimer").and_then(Value::as_bool) {
        next.insert("showTimer".to_string(), Value::Bool(value));
    }
    if let Some(value) = patch.get("timerDuration").and_then(Value::as_f64) {
        next.insert(
            "timerDuration".to_string(),
            number_value(value.round().max(0.0)),
        );
    }
    if let Some(value) = patch.get("showEvents").and_then(Value::as_bool) {
        next.insert("showEvents".to_string(), Value::Bool(value));
    }
    if let Some(value) = patch.get("showSocials").and_then(Value::as_bool) {
        next.insert("showSocials".to_string(), Value::Bool(value));
    }
    if let Some(value) = patch.get("splashFile") {
        next.insert("splashFile".to_string(), sliced(value, 200, false));
    }
    if let Some(value) = patch.get("splashDuration").and_then(Value::as_f64) {
        next.insert(
            "splashDuration".to_string(),
            number_value(value.round().clamp(0.0, 30.0)),
        );
    }
    if let Some(value) = patch.get("splashEnabled").and_then(Value::as_bool) {
        next.insert("splashEnabled".to_string(), Value::Bool(value));
    }
    if let Some(value) = patch.get("backgroundFile") {
        next.insert("backgroundFile".to_string(), sliced(value, 200, false));
    }
    if let Some(camera) = patch.get("camera").and_then(Value::as_object) {
        let current = next
            .get("camera")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_else(|| default_camera().as_object().cloned().unwrap_or_default());
        let mut merged = current.clone();
        for (key, value) in camera {
            if key != "config" {
                merged.insert(key.clone(), value.clone());
            }
        }
        let mut config = current
            .get("config")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(patch_config) = camera.get("config").and_then(Value::as_object) {
            for (key, value) in patch_config {
                config.insert(key.clone(), value.clone());
            }
        }

        // Геометрия — проценты сцены; ширина/высота не меньше 5%, чтобы
        // рамку можно было взять мышью в панели.
        let enabled = merged
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let width = merged
            .get("w")
            .and_then(Value::as_f64)
            .unwrap_or(24.0)
            .clamp(5.0, 100.0);
        let height = merged
            .get("h")
            .and_then(Value::as_f64)
            .unwrap_or(24.0)
            .clamp(5.0, 100.0);
        let x = merged
            .get("x")
            .and_then(Value::as_f64)
            .unwrap_or(3.0)
            .clamp(0.0, 100.0 - width);
        let y = merged
            .get("y")
            .and_then(Value::as_f64)
            .unwrap_or(60.0)
            .clamp(0.0, 100.0 - height);

        merged.insert("enabled".to_string(), Value::Bool(enabled));
        merged.insert("x".to_string(), number_value(x.round()));
        merged.insert("y".to_string(), number_value(y.round()));
        merged.insert("w".to_string(), number_value(width.round()));
        merged.insert("h".to_string(), number_value(height.round()));
        merged.insert(
            "config".to_string(),
            Value::Object(sanitize_camera_config(&config)),
        );
        next.insert("camera".to_string(), Value::Object(merged));
    }
    if let Some(alerts) = patch.get("alerts").and_then(Value::as_object) {
        let defaults = default_alerts(false)
            .as_object()
            .cloned()
            .unwrap_or_default();
        let current = next
            .get("alerts")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut merged = merge(&defaults, Some(&current));
        for (key, value) in alerts {
            merged.insert(key.clone(), value.clone());
        }

        // То же правило, что и у камеры: проценты холста, минимум 5% и не
        // вылезаем за край — иначе виджет нельзя будет взять мышью.
        let enabled = merged
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let widget = match merged.get("widget").and_then(Value::as_str) {
            Some("card") => "card",
            _ => "uec",
        };
        let width = merged
            .get("w")
            .and_then(Value::as_f64)
            .unwrap_or(28.0)
            .clamp(5.0, 100.0);
        let height = merged
            .get("h")
            .and_then(Value::as_f64)
            .unwrap_or(30.0)
            .clamp(5.0, 100.0);
        let x = merged
            .get("x")
            .and_then(Value::as_f64)
            .unwrap_or(68.0)
            .clamp(0.0, 100.0 - width);
        let y = merged
            .get("y")
            .and_then(Value::as_f64)
            .unwrap_or(2.0)
            .clamp(0.0, 100.0 - height);

        merged.insert("enabled".to_string(), Value::Bool(enabled));
        merged.insert("widget".to_string(), Value::from(widget));
        merged.insert("x".to_string(), number_value(x.round()));
        merged.insert("y".to_string(), number_value(y.round()));
        merged.insert("w".to_string(), number_value(width.round()));
        merged.insert("h".to_string(), number_value(height.round()));
        next.insert("alerts".to_string(), Value::Object(merged));
    }
    if let Some(socials) = patch.get("socials").and_then(Value::as_array) {
        let cleaned: Vec<Value> = socials
            .iter()
            .take(6)
            .map(|social| {
                json!({
                    "platform": sliced(social.get("platform").unwrap_or(&Value::Null), 4, false),
                    "text": sliced(social.get("text").unwrap_or(&Value::Null), 60, false),
                })
            })
            .collect();
        next.insert("socials".to_string(), Value::Array(cleaned));
    }

    let scene = Value::Object(next);
    scenes.insert(id, scene.clone());
    put(config, "scenes", scenes);
    Some(scene)
}

/// Общий сплеш: файл и длительность.
pub fn set_splash_config(config: &mut ConfigFile, patch: &Value) -> Value {
    let mut splash = merge(
        &json!({ "file": "", "duration": 4 })
            .as_object()
            .cloned()
            .expect("объект"),
        config.get("splash").and_then(Value::as_object),
    );
    if let Some(value) = patch.get("file") {
        splash.insert("file".to_string(), Value::from(plain(value).trim()));
    }
    if let Some(value) = patch.get("duration") {
        let duration = js_number_or_zero(Some(value)).round().clamp(0.0, 30.0);
        splash.insert("duration".to_string(), number_value(duration));
    }
    put(config, "splash", splash)
}

pub fn reset_top_donation(config: &mut ConfigFile) -> Value {
    let value = json!({ "user": "", "amount": 0, "currency": "RUB" });
    config.set("topDonation", value.clone());
    config.save();
    value
}

/// Обновить крупный донат, если сумма больше прежней; `None` — не крупнее.
pub fn maybe_update_top_donation(config: &mut ConfigFile, patch: &Value) -> Option<Value> {
    let amount = patch.get("amount").and_then(Value::as_f64)?;
    let current = config
        .get("topDonation")
        .and_then(|top| top.get("amount"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if amount <= current {
        return None;
    }

    let user = patch
        .get("user")
        .filter(|value| js_truthy(Some(value)))
        .map(js_string)
        .unwrap_or_else(|| "Аноним".to_string());
    let currency = patch
        .get("currency")
        .filter(|value| js_truthy(Some(value)))
        .map(js_string)
        .unwrap_or_else(|| "RUB".to_string());
    let value = json!({ "user": user, "amount": number_value(amount), "currency": currency });
    config.set("topDonation", value.clone());
    config.save();
    Some(value)
}

// ---- Внутреннее ----

/// `String(x)` для правдивого значения, иначе пустая строка.
fn plain(value: &Value) -> String {
    if js_truthy(Some(value)) {
        js_string(value)
    } else {
        String::new()
    }
}

/// `String(x || "").slice(0, len)` или `String(x).slice(0, len)`.
///
/// `fallback_empty` — брать ли `|| ""` (подписи уходят в оверлей): у `splashFile`
/// и соцсетей JS берёт `x || ""`, а у подписей сцены — просто `String(x)`.
fn sliced(value: &Value, len: usize, raw: bool) -> Value {
    let text = if raw { js_string(value) } else { plain(value) };
    Value::from(text.chars().take(len).collect::<String>())
}

fn put(config: &mut ConfigFile, key: &str, map: Map<String, Value>) -> Value {
    config.set(key, Value::Object(map));
    config.save();
    config.get(key).cloned().unwrap_or(Value::Null)
}

fn merge(base: &Map<String, Value>, patch: Option<&Map<String, Value>>) -> Map<String, Value> {
    let mut merged = base.clone();
    if let Some(patch) = patch {
        for (key, value) in patch {
            merged.insert(key.clone(), value.clone());
        }
    }
    merged
}

/// Слияние камеры сцены: внешние поля (геометрия, `enabled`) и вложенный
/// `config` обновляются независимо, иначе правка одной настройки стирала бы
/// остальные, пришедшие из умолчаний.
fn merge_camera(base: &Map<String, Value>, patch: &Map<String, Value>) -> Map<String, Value> {
    let mut merged = merge(base, Some(patch));
    let mut config = base
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(patch_config) = patch.get("config").and_then(Value::as_object) {
        for (key, value) in patch_config {
            config.insert(key.clone(), value.clone());
        }
    }
    merged.insert("config".to_string(), Value::Object(config));
    merged
}

/// Оставить в настройках камеры только то, что читает `WebcamWidget`.
///
/// Значения приходят из панели, но конфиг можно править руками, поэтому числа
/// и перечисления ограничиваем здесь же — как у остальных полей сцены.
fn sanitize_camera_config(config: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();

    let source = match config.get("source").and_then(Value::as_str) {
        Some("frame") => "frame",
        _ => "camera",
    };
    out.insert("source".to_string(), Value::from(source));

    let label = config
        .get("label")
        .cloned()
        .unwrap_or_else(|| Value::from("LIVE"));
    out.insert("label".to_string(), sliced(&label, 40, true));

    let label_position = match config.get("labelPosition").and_then(Value::as_str) {
        Some("top-right") => "top-right",
        Some("bottom-left") => "bottom-left",
        Some("bottom-right") => "bottom-right",
        _ => "top-left",
    };
    out.insert("labelPosition".to_string(), Value::from(label_position));

    for (key, default) in [
        ("showLabel", true),
        ("showBorder", true),
        ("showCorners", true),
        ("showBackground", false),
        ("showVignette", false),
        ("mirror", false),
    ] {
        out.insert(
            key.to_string(),
            Value::Bool(config.get(key).and_then(Value::as_bool).unwrap_or(default)),
        );
    }

    let thickness = config
        .get("thickness")
        .and_then(Value::as_f64)
        .unwrap_or(4.0)
        .round()
        .clamp(1.0, 16.0);
    out.insert("thickness".to_string(), number_value(thickness));

    // Нет радиуса — рамка берёт скругление темы (см. `_themeRadius` в виджете).
    if let Some(radius) = config.get("radius").and_then(Value::as_f64) {
        out.insert(
            "radius".to_string(),
            number_value(radius.round().clamp(0.0, 64.0)),
        );
    }

    let color = config
        .get("color")
        .cloned()
        .unwrap_or_else(|| Value::from(""));
    out.insert("color".to_string(), sliced(&color, 32, false));

    let fit = match config.get("fit").and_then(Value::as_str) {
        Some("contain") => "contain",
        _ => "cover",
    };
    out.insert("fit".to_string(), Value::from(fit));

    let perspective = config
        .get("perspective")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .clamp(0.0, 100.0);
    out.insert("perspective".to_string(), number_value(perspective.round()));

    let direction = match config.get("perspectiveDirection").and_then(Value::as_str) {
        Some("right") => "right",
        Some("up") => "up",
        Some("down") => "down",
        _ => "left",
    };
    out.insert("perspectiveDirection".to_string(), Value::from(direction));

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::paths::Storage;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixture {
        dir: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let index = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir()
                .join(format!("ose-scenes-{}-{label}-{index}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            fs::write(dir.join("config.example.json"), "{\n  \"port\": 8710\n}\n")
                .expect("шаблон должен записываться");
            Self { dir }
        }

        fn config(&self) -> ConfigFile {
            ConfigFile::open(&Storage::beside_sources(self.dir.clone())).expect("настройки")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn default_scenes_cover_every_screen() {
        let scenes = default_scenes();
        let ids: Vec<&str> = scenes
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            ids,
            ["start", "brb", "talk", "end", "wheel", "poll", "pause"]
        );
        assert_eq!(scenes["start"]["timerDuration"], json!(600));
        assert_eq!(scenes["start"]["socials"].as_array().unwrap().len(), 3);
        assert_eq!(scenes["wheel"]["socials"], json!([]));
    }

    #[test]
    fn every_scene_carries_a_camera_default() {
        let scenes = default_scenes();
        for id in ["start", "brb", "talk", "end", "wheel", "poll", "pause"] {
            let camera = &scenes[id]["camera"];
            assert_eq!(camera["enabled"], json!(false), "{id}");
            assert_eq!(camera["config"]["source"], json!("camera"), "{id}");
            assert_eq!(camera["config"]["showBorder"], json!(true), "{id}");
            // Радиус не задан — рамка берёт скругление темы.
            assert!(camera["config"].get("radius").is_none(), "{id}");
        }
    }

    #[test]
    fn camera_patch_clamps_geometry_and_merges_config() {
        let fixture = Fixture::new("camera");
        let mut config = fixture.config();
        normalize_scenes(&mut config);

        let scene = set_scene_config(
            &mut config,
            &json!("talk"),
            &json!({
                "camera": {
                    "enabled": true,
                    "x": -10,
                    "y": 200,
                    "w": 120,
                    "h": 30,
                    "config": {
                        "source": "camera",
                        "label": "CAM",
                        "thickness": 99,
                        "radius": 999,
                        "perspective": 150,
                    },
                },
            }),
        )
        .expect("сцена есть");

        let camera = &scene["camera"];
        assert_eq!(camera["enabled"], json!(true));
        assert_eq!(camera["x"], json!(0));
        assert_eq!(camera["y"], json!(70));
        assert_eq!(camera["w"], json!(100));
        assert_eq!(camera["h"], json!(30));
        assert_eq!(camera["config"]["source"], json!("camera"));
        assert_eq!(camera["config"]["label"], json!("CAM"));
        assert_eq!(camera["config"]["thickness"], json!(16));
        assert_eq!(camera["config"]["radius"], json!(64));
        assert_eq!(camera["config"]["perspective"], json!(100));
        // Настройки, которых не было в патче, остались из умолчаний.
        assert_eq!(camera["config"]["showBorder"], json!(true));

        // Частичная правка геометрии не стирает настройки внешнего вида.
        // Ширину возвращаем к 40%, иначе x=12 прижмётся к нулю: рамка не
        // должна вылезать за правый край сцены.
        let moved = set_scene_config(
            &mut config,
            &json!("talk"),
            &json!({ "camera": { "x": 12, "w": 40 } }),
        )
        .expect("сцена есть");
        assert_eq!(moved["camera"]["x"], json!(12));
        assert_eq!(moved["camera"]["w"], json!(40));
        assert_eq!(moved["camera"]["config"]["label"], json!("CAM"));
    }

    #[test]
    fn alerts_are_on_only_for_talk_by_default() {
        let scenes = default_scenes();
        for id in ["start", "brb", "end", "wheel", "poll", "pause"] {
            assert_eq!(scenes[id]["alerts"]["enabled"], json!(false), "{id}");
            assert_eq!(scenes[id]["alerts"]["widget"], json!("uec"), "{id}");
            assert_eq!(scenes[id]["alerts"]["x"], json!(68), "{id}");
        }
        // На «Разговоре» алерты были и раньше — сохраняем поведение.
        assert_eq!(scenes["talk"]["alerts"]["enabled"], json!(true));
    }

    #[test]
    fn alerts_patch_clamps_geometry_and_keeps_other_fields() {
        let fixture = Fixture::new("alerts");
        let mut config = fixture.config();
        normalize_scenes(&mut config);

        let scene = set_scene_config(
            &mut config,
            &json!("brb"),
            &json!({
                "alerts": { "enabled": true, "x": -10, "y": 200, "w": 120, "h": 4 },
            }),
        )
        .expect("сцена есть");

        let alerts = &scene["alerts"];
        assert_eq!(alerts["enabled"], json!(true));
        assert_eq!(alerts["widget"], json!("uec"));
        assert_eq!(alerts["x"], json!(0));
        assert_eq!(alerts["y"], json!(95));
        assert_eq!(alerts["w"], json!(100));
        assert_eq!(alerts["h"], json!(5));

        let moved = set_scene_config(
            &mut config,
            &json!("brb"),
            &json!({ "alerts": { "x": 12, "w": 40 } }),
        )
        .expect("сцена есть");
        assert_eq!(moved["alerts"]["x"], json!(12));
        assert_eq!(moved["alerts"]["w"], json!(40));
        assert_eq!(moved["alerts"]["enabled"], json!(true));

        // Неизвестный вид виджета возвращается к UEC, явный «card» сохраняется.
        let card = set_scene_config(
            &mut config,
            &json!("brb"),
            &json!({ "alerts": { "widget": "card" } }),
        )
        .expect("сцена есть");
        assert_eq!(card["alerts"]["widget"], json!("card"));
        let bogus = set_scene_config(
            &mut config,
            &json!("brb"),
            &json!({ "alerts": { "widget": "что-то" } }),
        )
        .expect("сцена есть");
        assert_eq!(bogus["alerts"]["widget"], json!("uec"));
    }

    #[test]
    fn normalization_fills_missing_scenes_and_keeps_existing_fields() {
        let fixture = Fixture::new("normalize");
        let mut config = fixture.config();
        config.set(
            "scenes",
            json!({ "start": { "title": "Своё" }, "custom": { "x": 1 } }),
        );

        normalize_scenes(&mut config);
        let scenes = config.get("scenes").unwrap();
        // Своё значение побеждает умолчание…
        assert_eq!(scenes["start"]["title"], json!("Своё"));
        // …но остальные поля доливаются из умолчаний.
        assert_eq!(scenes["start"]["timerDuration"], json!(600));
        // Посторонняя сцена не трогается, остальные создаются.
        assert_eq!(scenes["custom"], json!({ "x": 1 }));
        assert!(scenes.get("brb").is_some());
    }

    #[test]
    fn scene_patch_clamps_and_slices_fields() {
        let fixture = Fixture::new("patch");
        let mut config = fixture.config();
        normalize_scenes(&mut config);

        let long_title = "О".repeat(100);
        let scene = set_scene_config(
            &mut config,
            &json!("start"),
            &json!({
                "title": long_title,
                "timerDuration": 4.7,
                "showTimer": false,
                "splashDuration": 120,
                "socials": [
                    { "platform": "TELEGRAM", "text": "t" },
                    { "platform": "DC", "text": "d" },
                    { "platform": "YT", "text": "y" },
                    { "platform": "1", "text": "1" },
                    { "platform": "2", "text": "2" },
                    { "platform": "3", "text": "3" },
                    { "platform": "4", "text": "4" },
                ],
            }),
        )
        .expect("сцена есть");

        assert_eq!(scene["title"].as_str().unwrap().chars().count(), 80);
        assert_eq!(scene["timerDuration"], json!(5));
        assert_eq!(scene["showTimer"], json!(false));
        // Сплеш зажат до 30 секунд, а соцсети — до шести, платформа — до четырёх знаков.
        assert_eq!(scene["splashDuration"], json!(30));
        assert_eq!(scene["socials"].as_array().unwrap().len(), 6);
        assert_eq!(scene["socials"][0]["platform"], json!("TELE"));
        // Не тронутые поля остались умолчаниями.
        assert_eq!(scene["subtitle"], default_scenes()["start"]["subtitle"]);
    }

    #[test]
    fn patching_an_unknown_scene_returns_nothing() {
        let fixture = Fixture::new("unknown");
        let mut config = fixture.config();
        normalize_scenes(&mut config);
        assert!(set_scene_config(&mut config, &json!("nope"), &json!({ "title": "x" })).is_none());
    }

    #[test]
    fn splash_is_clamped() {
        let fixture = Fixture::new("splash");
        let mut config = fixture.config();

        let splash = set_splash_config(
            &mut config,
            &json!({ "file": "  media/s.png  ", "duration": 99 }),
        );
        assert_eq!(splash["file"], json!("media/s.png"));
        assert_eq!(splash["duration"], json!(30));

        // Частичный патч не сбрасывает файл.
        let splash = set_splash_config(&mut config, &json!({ "duration": 2.6 }));
        assert_eq!(splash["file"], json!("media/s.png"));
        assert_eq!(splash["duration"], json!(3));
    }

    #[test]
    fn the_top_donation_grows_only() {
        let fixture = Fixture::new("top");
        let mut config = fixture.config();

        assert_eq!(
            maybe_update_top_donation(
                &mut config,
                &json!({ "user": "alice", "amount": 500, "currency": "USD" })
            ),
            Some(json!({ "user": "alice", "amount": 500, "currency": "USD" }))
        );
        // Меньшая сумма не заменяет крупный донат.
        assert!(
            maybe_update_top_donation(&mut config, &json!({ "user": "bob", "amount": 100 }))
                .is_none()
        );
        // Не число — тоже не донат.
        assert!(
            maybe_update_top_donation(&mut config, &json!({ "user": "bob", "amount": "abc" }))
                .is_none()
        );

        assert_eq!(
            reset_top_donation(&mut config),
            json!({ "user": "", "amount": 0, "currency": "RUB" })
        );
    }
}
