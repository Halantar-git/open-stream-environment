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

/// Гостевая плитка раскладки сцены «Гости»: слот мультикама в сетке 2×2.
///
/// Ширина и высота в процентах равны: холст 16:9, поэтому одинаковые
/// проценты по осям дают кадр 16:9. Бейдж «LIVE» — как у остальных рамок,
/// имя гостя вписывают в инспекторе, если нужно.
fn guest_cam(slot: &str, x: i64, y: i64, z: i64) -> Value {
    json!({
        "id": format!("guests-{slot}"),
        "type": "webcam",
        "x": x,
        "y": y,
        "w": 36,
        "h": 36,
        "z": z,
        "visible": true,
        "config": { "source": "remote", "guestSlot": slot, "label": "LIVE", "showLabel": true, "showGuestName": true },
    })
}

/// Сцены по умолчанию — порт `defaultScenes()`.
///
/// Порядок сцен и полей повторён по JS. У `pause` нет `splashEnabled` — так в
/// исходнике, и повторяем это как есть, чтобы диффы конфига не появлялись на
/// ровном месте.
pub fn default_scenes() -> Value {
    let socials = default_socials();
    json!({
        "start": {
            "statusLabel": "СТРИМ СКОРО НАЧНЁТСЯ",
            "title": "Скоро начнём",
            "subtitle": "Стрим начнётся через несколько минут. Не переключайтесь!",
            "splashFile": "",
            "splashDuration": 0,
            "splashEnabled": true,
            "backgroundFile": "",
            "showTimer": true,
            "timerDuration": 600,
            "timerDoneText": "Начинаем прямо сейчас!",
            "showEvents": true,
            "showSocials": true,
            "socials": socials.clone(),
            "widgets": [],
        },
        "brb": {
            "statusLabel": "ПЕРЕРЫВ НА СТРИМЕ",
            "title": "Скоро вернусь",
            "subtitle": "Стрим возобновится через несколько минут. Не переключайтесь!",
            "splashFile": "",
            "splashDuration": 0,
            "splashEnabled": true,
            "backgroundFile": "",
            "showTimer": true,
            "timerDuration": 300,
            "timerDoneText": "Стрим возобновится прямо сейчас!",
            "showEvents": true,
            "showSocials": true,
            "socials": socials.clone(),
            "widgets": [],
        },
        "talk": {
            "statusLabel": "ОБЩАЕМСЯ",
            "title": "Разговор со зрителями",
            "subtitle": "Задавайте вопросы в чате!",
            "splashFile": "",
            "splashDuration": 0,
            "splashEnabled": true,
            "backgroundFile": "",
            "showTimer": false,
            "timerDuration": 0,
            "timerDoneText": "",
            "showEvents": true,
            "showSocials": true,
            "socials": socials.clone(),
            "widgets": [],
        },
        "guests": {
            "statusLabel": "В ЭФИРЕ С ГОСТЯМИ",
            "title": "Гости",
            "subtitle": "",
            "splashFile": "",
            "splashDuration": 0,
            "splashEnabled": true,
            "backgroundFile": "",
            "showTimer": false,
            "timerDuration": 0,
            "timerDoneText": "",
            "showEvents": false,
            "showSocials": false,
            "socials": [],
            "widgets": [
                guest_cam("cam2", 2, 3, 1),
                guest_cam("cam3", 40, 3, 2),
                guest_cam("cam4", 2, 41, 3),
                guest_cam("cam5", 40, 41, 4),
                {
                    "id": "guests-chat",
                    "type": "chat",
                    "x": 78,
                    "y": 3,
                    "w": 20,
                    "h": 74,
                    "z": 5,
                    "visible": true,
                    "config": { "maxMessages": 12 },
                },
            ],
        },
        "end": {
            "statusLabel": "СТРИМ ЗАВЕРШЁН",
            "title": "Спасибо за просмотр!",
            "subtitle": "Увидимся в следующий раз",
            "splashFile": "",
            "splashDuration": 0,
            "splashEnabled": true,
            "backgroundFile": "",
            "showTimer": false,
            "timerDuration": 0,
            "timerDoneText": "",
            "showEvents": true,
            "showSocials": true,
            "socials": socials.clone(),
            "widgets": [],
        },
        "wheel": {
            "statusLabel": "РОЗЫГРЫШ",
            "title": "Колесо Фортуны",
            "subtitle": "Победителя определит колесо",
            "splashFile": "",
            "splashDuration": 0,
            "splashEnabled": true,
            "backgroundFile": "",
            "showTimer": false,
            "timerDuration": 0,
            "timerDoneText": "",
            "showEvents": false,
            "showSocials": false,
            "socials": [],
            "widgets": [],
        },
        "poll": {
            "statusLabel": "ГОЛОСОВАНИЕ",
            "title": "Голосование",
            "subtitle": "Голосуйте в чате!",
            "splashFile": "",
            "splashDuration": 0,
            "splashEnabled": true,
            "backgroundFile": "",
            "showTimer": false,
            "timerDuration": 0,
            "timerDoneText": "",
            "showEvents": false,
            "showSocials": false,
            "socials": [],
            "widgets": [],
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
            "widgets": [],
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
            let mut merged = merge(
                default.as_object().expect("сцена — объект"),
                Some(&existing),
            );
            // Раскладка сцены — массив виджетов; мусор из старого конфига
            // не должен ломать сервер при обходе сцен.
            if !merged.get("widgets").is_some_and(Value::is_array) {
                merged.insert("widgets".to_string(), Value::Array(Vec::new()));
            }
            scenes.insert(id.clone(), Value::Object(merged));
        }
    }

    upgrade_guest_badges(&mut scenes);
    config.set("scenes", Value::Object(scenes));
}

/// Вернуть бейдж рамкам сцены «Гости» из первых сборок.
///
/// Та раскладка рождалась с пустой подписью и выключенным бейджем: имена гостей
/// до подключения неизвестны. На эфире рамка без бейджа выглядела “голой” на
/// фоне остальных, и владельцу пришлось бы включать подпись у четырёх
/// виджетов вручную. Трогаем только нетронутые рамки (`guests-cam*` с пустой
/// подписью): переименованные и добавленные вручную остаются как есть.
fn upgrade_guest_badges(scenes: &mut Map<String, Value>) {
    let Some(widgets) = scenes
        .get_mut("guests")
        .and_then(Value::as_object_mut)
        .and_then(|scene| scene.get_mut("widgets"))
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for widget in widgets {
        let id = widget.get("id").and_then(Value::as_str).unwrap_or_default();
        if !id.starts_with("guests-cam") {
            continue;
        }
        let Some(config) = widget.get_mut("config").and_then(Value::as_object_mut) else {
            continue;
        };
        // Имя подключённого гостя вместо общей подписи — новая настройка: в
        // старой раскладке её нет, и без неё бейдж так и остался бы «LIVE».
        if !config.contains_key("showGuestName") {
            config.insert("showGuestName".to_string(), Value::Bool(true));
        }
        let empty = config
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .is_empty();
        if !empty {
            continue;
        }
        config.insert("label".to_string(), Value::from("LIVE"));
        if config.get("showLabel").and_then(Value::as_bool) == Some(false) {
            config.insert("showLabel".to_string(), Value::Bool(true));
        }
    }
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
    let currency = crate::state::currency_code(patch.get("currency").unwrap_or(&Value::Null));
    let current = config
        .get("topDonation")
        .and_then(|top| top.get("amount"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    // Курсов в приложении нет: сравниваем только суммы в одной валюте, иначе
    // $100 оказывались бы «больше» 500 ₽, а 100 иен — «больше» $50.
    let current_currency = config
        .get("topDonation")
        .and_then(|top| top.get("currency"))
        .map(crate::state::currency_code)
        .unwrap_or_else(|| crate::state::currency_code(&Value::Null));
    if current > 0.0 && currency != current_currency {
        return None;
    }
    if amount <= current {
        return None;
    }

    let user = patch
        .get("user")
        .filter(|value| js_truthy(Some(value)))
        .map(js_string)
        .unwrap_or_else(|| "Аноним".to_string());
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

/// `String(x || "").trim().slice(0, len)` или `String(x).slice(0, len)`.
///
/// `fallback_empty` — брать ли `|| ""` (подписи уходят в оверлей): у `splashFile`
/// и соцсетей JS берёт `x || ""`, а у подписей сцены — просто `String(x)`.
fn sliced(value: &Value, len: usize, raw: bool) -> Value {
    let text = if raw {
        js_string(value)
    } else {
        plain(value).trim().to_string()
    };
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
            ["start", "brb", "talk", "guests", "end", "wheel", "poll", "pause"]
        );
        assert_eq!(scenes["start"]["timerDuration"], json!(600));
        assert_eq!(scenes["start"]["socials"].as_array().unwrap().len(), 3);
        assert_eq!(scenes["wheel"]["socials"], json!([]));

        // У сцены гостей уже готовая раскладка: четыре слота мультикама и чат.
        let guests = scenes["guests"]["widgets"].as_array().unwrap();
        let slots: Vec<&str> = guests
            .iter()
            .filter_map(|widget| widget["config"]["guestSlot"].as_str())
            .collect();
        assert_eq!(slots, ["cam2", "cam3", "cam4", "cam5"]);
        assert!(guests.iter().any(|widget| widget["type"] == json!("chat")));
        // Бейдж на рамках такой же, как у остальных камер темы.
        assert_eq!(guests[0]["config"]["label"], json!("LIVE"));
        assert_eq!(guests[0]["config"]["showLabel"], json!(true));
        assert_eq!(guests[0]["config"]["showGuestName"], json!(true));
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
    fn guest_frames_from_the_first_layout_get_a_badge() {
        let fixture = Fixture::new("guests-badge");
        let mut config = fixture.config();
        // Раскладка из первой сборки: подпись пустая, бейдж выключен.
        config.set(
            "scenes",
            json!({
                "guests": {
                    "widgets": [
                        { "id": "guests-cam2", "type": "webcam", "config": { "source": "remote", "guestSlot": "cam2", "label": "", "showLabel": false } },
                        // Переименованная рамка и виджет, добавленный вручную, остаются как есть.
                        { "id": "guests-cam3", "type": "webcam", "config": { "label": "Гость", "showLabel": true } },
                        { "id": "abc", "type": "webcam", "config": { "label": "", "showLabel": false } }
                    ]
                }
            }),
        );

        normalize_scenes(&mut config);
        let scenes = config.get("scenes").unwrap();
        let widgets = scenes["guests"]["widgets"].as_array().unwrap();
        assert_eq!(widgets[0]["config"]["label"], json!("LIVE"));
        assert_eq!(widgets[0]["config"]["showLabel"], json!(true));
        // Новая настройка бейджа — тоже из умолчаний, в старом конфиге её нет.
        assert_eq!(widgets[0]["config"]["showGuestName"], json!(true));
        assert_eq!(widgets[1]["config"]["label"], json!("Гость"));
        assert_eq!(widgets[1]["config"]["showGuestName"], json!(true));
        // Добавленный вручную виджет не трогаем.
        assert!(widgets[2]["config"].get("showGuestName").is_none());
        assert_eq!(widgets[2]["config"]["label"], json!(""));
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
                "backgroundFile": "  media/bg.mp4  ",
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
        assert_eq!(scene["backgroundFile"], json!("media/bg.mp4"));
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
        // Другая валюта не сравнивается по числу: 900 рублей не «больше» $500.
        assert!(maybe_update_top_donation(
            &mut config,
            &json!({ "user": "bob", "amount": 900, "currency": "RUB" })
        )
        .is_none());
        // В той же валюте — заменяет.
        assert_eq!(
            maybe_update_top_donation(
                &mut config,
                &json!({ "user": "bob", "amount": 900, "currency": "usd" })
            ),
            Some(json!({ "user": "bob", "amount": 900, "currency": "USD" }))
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
