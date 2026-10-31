//! Снимок состояния — то, из чего собирается `STATE` для панели и оверлея.
//!
//! Порт `snapshot()` из `server/state.js`. Это не «ещё одно состояние», а сборка
//! ответа из уже перенесённых частей: настройки читаются из [`ConfigFile`],
//! раскладка и пресеты — из [`Database`], счётчики и ход розыгрыша — из
//! [`Runtime`], темы собирает `state::appearance`, опрос — `state::poll`.
//!
//! Снимок уходит **всем** клиентам (оверлею, пульту, чату), поэтому секретов в
//! нём нет: пароль OBS подменяется пустой строкой с признаком `hasPassword`, а
//! про ключ DonationAlerts сообщается только факт заполнения (`hasClientSecret`)
//! и признак `clientSecretUnreadable`. Секреты расшифровываются при открытии
//! настроек ([`ConfigFile`]), поэтому нечитаемый сохранённый ключ виден как
//! пустой, а флаг говорит панели «введите заново», а не «не заполнено».
//!
//! Ключи идут в том же порядке, что в JS: снимок сравнивают при отладке, и
//! перестановка полей создавала бы лишний шум.

use serde_json::{json, Map, Value};

use crate::state::{appearance, layout, poll, runtime::Runtime, string_trim};
use crate::storage::config_file::ConfigFile;
use crate::storage::db::Database;
use crate::storage::history::{js_number_or_zero, js_truthy};
use crate::storage::secrets::labels;

/// Собрать снимок состояния.
pub fn snapshot(config: &ConfigFile, db: &Database, runtime: &Runtime) -> Value {
    let theme_2d = appearance::resolved_theme(config);
    let theme_3d = appearance::resolved_theme_3d(config);
    let is_custom_base = theme_2d.get("builtin").and_then(Value::as_bool) != Some(true);
    let appearance_config = appearance::appearance_config(config);
    let enabled_3d = appearance_config
        .get("enabled3d")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let active_3d_widgets =
        appearance::active_3d_widgets(config, &theme_2d, theme_3d.as_ref(), is_custom_base);
    let has_3d_set = if is_custom_base {
        theme_2d
            .get("threeDWidgets")
            .and_then(Value::as_array)
            .is_some_and(|widgets| !widgets.is_empty())
    } else {
        theme_2d
            .get("variant3d")
            .is_some_and(|variant| js_truthy(Some(variant)))
    };
    // Встроенный 3D-вариант перекрывает базовую тему целиком (его токены
    // побеждают); у своей темы палитра остаётся своя.
    let effective =
        if theme_3d.is_some() && theme_2d.get("builtin").and_then(Value::as_bool) == Some(true) {
            theme_3d.clone().unwrap_or(theme_2d.clone())
        } else {
            theme_2d.clone()
        };

    let donation_alerts = object(config.get("donationAlerts"));
    let obs = obs_for_snapshot(config);
    let appearance = json!({
        "activeThemeId": config
            .get("appearance")
            .and_then(|appearance| appearance.get("activeThemeId"))
            .cloned()
            .unwrap_or(Value::Null),
        "activeThemeId3d": theme_3d
            .as_ref()
            .and_then(|theme| theme.get("id"))
            .cloned()
            .unwrap_or_else(|| Value::from("")),
        "active3dWidgets": active_3d_widgets,
        "enable3d": js_truthy(
            config
                .get("appearance")
                .and_then(|appearance| appearance.get("enable3d"))
        ) && has_3d_set,
        "enabled3d": enabled_3d,
        "tokens": effective.get("tokens").cloned().unwrap_or_else(|| json!({})),
        "customCss": theme_2d
            .get("customCss")
            .filter(|value| js_truthy(Some(value)))
            .cloned()
            .unwrap_or_else(|| Value::from("")),
        "themes": appearance::list_themes(config),
    });

    let scene_started_at = match runtime.scene_started_at() {
        Some(at) => Value::from(at),
        None => Value::Null,
    };

    // Собираем по ключу, а не одним `json!`: макрос раскрывается вложенно и на
    // таком числе полей упирается в предел рекурсии компилятора.
    let mut out = Map::new();
    out.insert(
        "layout".to_string(),
        Value::Array(layout::widgets(db, config)),
    );
    out.insert(
        "layoutPresets".to_string(),
        Value::Array(layout::list_layout_presets(db)),
    );
    out.insert("goal".to_string(), field(config, "goal"));
    // Базовая валюта итогов: по ней панель заполняет поле в настройках.
    out.insert(
        "baseCurrency".to_string(),
        Value::from(crate::state::currency_code(
            config.get("base_currency").unwrap_or(&Value::Null),
        )),
    );
    // Пауза новостной ленты — в снимке: оверлей, перезагрузившийся в OBS,
    // сразу знает, что строка стоит, и не ждёт отдельного кадра.
    out.insert(
        "tickerPaused".to_string(),
        Value::Bool(config.get("ticker_paused") == Some(&Value::Bool(true))),
    );
    out.insert("port".to_string(), field(config, "port"));
    out.insert(
        "notificationSound".to_string(),
        field(config, "notificationSound"),
    );
    out.insert(
        "notificationVolume".to_string(),
        field(config, "notificationVolume"),
    );
    out.insert(
        "notificationRepeats".to_string(),
        field(config, "notificationRepeats"),
    );
    out.insert(
        "twitchChannel".to_string(),
        nested(config, "twitch", "channel"),
    );
    // Числовой id канала нужен фронту для наборов смайлов BetterTTV и 7TV:
    // их API ищет канал только по нему, в отличие от FrankerFaceZ (по логину).
    out.insert(
        "twitchBroadcasterId".to_string(),
        nested(config, "twitch", "broadcasterId"),
    );
    out.insert(
        "twitchClientId".to_string(),
        nested(config, "twitch", "clientId"),
    );
    out.insert(
        "donationAlertsClientId".to_string(),
        nested(config, "donationAlerts", "clientId"),
    );
    out.insert(
        "donationAlertsAuth".to_string(),
        json!({
            "connected": js_truthy(donation_alerts.get("accessToken")),
            "refreshable": js_truthy(donation_alerts.get("refreshToken")),
            "userId": donation_alerts.get("userId").cloned().unwrap_or_else(|| Value::from("")),
            "expiresAt": number_or_zero(donation_alerts.get("expiresAt")),
            "hasClientSecret": !string_trim(donation_alerts.get("clientSecret").unwrap_or(&Value::Null)).is_empty(),
            // Секрет расшифрован при открытии: `true` — сохранённое значение
            // прочитать не удалось (сменился ключ или конфиг принесли с другой
            // машины), панель попросит ввести ключ заново.
            "clientSecretUnreadable": config.secrets().is_unreadable(labels::DONATION_ALERTS_CLIENT_SECRET),
        }),
    );
    out.insert(
        "youtubeClientId".to_string(),
        nested(config, "youtube", "clientId"),
    );
    out.insert(
        "youtubeVideoId".to_string(),
        nested(config, "youtube", "videoId"),
    );
    out.insert(
        "twitchEnabled".to_string(),
        nested(config, "twitch", "enabled"),
    );
    out.insert(
        "donationAlertsEnabled".to_string(),
        nested(config, "donationAlerts", "enabled"),
    );
    out.insert(
        "donatexEnabled".to_string(),
        nested(config, "donatex", "enabled"),
    );
    // Сам токен наверх не отдаём: панели достаточно знать, что он сохранён.
    // Ссылки на виджеты — не секрет: по ним оверлей открывает страницы DonateX.
    let donatex_widgets = config
        .get("donatex")
        .and_then(|service| service.get("widgets"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let widget_url = |key: &str| {
        donatex_widgets
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    out.insert(
        "donatex".to_string(),
        json!({
            "enabled": nested(config, "donatex", "enabled"),
            "hasToken": !string_trim(
                config
                    .get("donatex")
                    .and_then(|service| service.get("externalToken"))
                    .unwrap_or(&Value::Null)
            )
            .is_empty(),
            "widgets": {
                "donation": widget_url("donation"),
                "ai": widget_url("ai"),
                "music": widget_url("music"),
                "roulette": widget_url("roulette"),
            },
        }),
    );
    out.insert(
        "youtubeEnabled".to_string(),
        nested(config, "youtube", "enabled"),
    );
    out.insert("obs".to_string(), obs);
    out.insert("soundboard".to_string(), field(config, "soundboard"));
    out.insert(
        "tickerMessages".to_string(),
        field(config, "ticker_messages"),
    );
    out.insert("donationMedia".to_string(), field(config, "donationMedia"));
    out.insert("tts".to_string(), field(config, "tts"));
    out.insert("donationVoice".to_string(), field(config, "donationVoice"));
    out.insert("streamdeck".to_string(), field(config, "streamdeck"));
    out.insert("connectionStatus".to_string(), runtime.connection_status());
    out.insert("longshot".to_string(), runtime.longshot());
    out.insert(
        "recentEvents".to_string(),
        Value::Array(runtime.recent_events().to_vec()),
    );
    out.insert("stats".to_string(), runtime.stats());
    // `sessionDonations` добавляет `Diagnostics::state_snapshot`: итог зависит
    // от курсов, а в `Runtime` их нет.
    out.insert("deathCount".to_string(), runtime.death_count());
    out.insert(
        "activeScene".to_string(),
        Value::from(runtime.active_scene()),
    );
    out.insert("sceneStartedAt".to_string(), scene_started_at);
    out.insert(
        "activeCameraAngle".to_string(),
        runtime.active_camera_angle(),
    );
    out.insert(
        "activeFilters".to_string(),
        Value::Array(
            runtime
                .active_filters()
                .into_iter()
                .map(Value::from)
                .collect(),
        ),
    );
    out.insert("giveaway".to_string(), runtime.giveaway_snapshot());
    out.insert("poll".to_string(), poll::poll_snapshot(runtime, config));
    out.insert(
        "pollPresets".to_string(),
        Value::Array(poll::list_poll_presets(db)),
    );
    out.insert("chatBot".to_string(), field(config, "chatBot"));
    out.insert("twitchRewards".to_string(), field(config, "twitchRewards"));
    out.insert("appearance".to_string(), appearance);
    out.insert("editor".to_string(), field(config, "editor"));
    out.insert(
        "hud_edit_hotkey".to_string(),
        field(config, "hud_edit_hotkey"),
    );
    out.insert(
        "hud_display_id".to_string(),
        field(config, "hud_display_id"),
    );
    out.insert(
        "chat_hud_hotkey".to_string(),
        field(config, "chat_hud_hotkey"),
    );
    out.insert(
        "chat_hud_display_id".to_string(),
        field(config, "chat_hud_display_id"),
    );
    out.insert("chatHud".to_string(), field(config, "chatHud"));
    out.insert("scenes".to_string(), scenes_for_snapshot(config));
    out.insert("splash".to_string(), field(config, "splash"));
    out.insert("topDonation".to_string(), field(config, "topDonation"));
    Value::Object(out)
}

/// Сцены с почищенными раскладками: гостевые слоты раздаются и на сценах, а не
/// только на основном оверлее — иначе виджет, созданный до появления раздачи,
/// так и остался бы без приёмника до первой правки сцены.
fn scenes_for_snapshot(config: &ConfigFile) -> Value {
    let mut scenes = object(config.get("scenes"));
    for scene in layout::WIDGET_SCENE_IDS {
        let Some(fields) = scenes.get_mut(scene).and_then(Value::as_object_mut) else {
            continue;
        };
        // Сцены без канваса не должны обзавестись пустым `widgets`.
        if !fields.contains_key("widgets") {
            continue;
        }
        fields.insert(
            "widgets".to_string(),
            Value::Array(layout::scene_widgets(config, scene)),
        );
    }
    Value::Object(scenes)
}

/// Настройки OBS без пароля: подменяем пустой строкой и добавляем признак.
fn obs_for_snapshot(config: &ConfigFile) -> Value {
    let mut obs = object(config.get("obs"));
    let has_password = obs
        .get("password")
        .and_then(Value::as_str)
        .is_some_and(|password| !password.is_empty());
    obs.insert("password".to_string(), Value::from(""));
    obs.insert("hasPassword".to_string(), Value::Bool(has_password));
    Value::Object(obs)
}

fn field(config: &ConfigFile, key: &str) -> Value {
    config.get(key).cloned().unwrap_or(Value::Null)
}

fn nested(config: &ConfigFile, section: &str, key: &str) -> Value {
    config
        .get(section)
        .and_then(|section| section.get(key))
        .cloned()
        .unwrap_or(Value::Null)
}

fn number_or_zero(value: Option<&Value>) -> Value {
    crate::storage::history::number_value(js_number_or_zero(value))
}

fn object(value: Option<&Value>) -> serde_json::Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::config::{
        normalize_config, save_donation_alerts_app, set_app_config, set_obs_config,
    };
    use crate::state::layout::add_widget;
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
            let dir = std::env::temp_dir().join(format!(
                "ose-snapshot-{}-{label}-{index}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            fs::write(dir.join("config.example.json"), "{\n  \"port\": 8710\n}\n")
                .expect("шаблон должен записываться");
            Self { dir }
        }

        fn config(&self) -> ConfigFile {
            ConfigFile::open(&Storage::beside_sources(self.dir.clone())).expect("настройки")
        }

        fn db(&self) -> Database {
            Database::open(&Storage::beside_sources(self.dir.clone()))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.dir).ok();
        }
    }

    #[test]
    fn the_snapshot_hides_secrets_but_marks_them() {
        let fixture = Fixture::new("secrets");
        let mut config = fixture.config();
        let db = fixture.db();
        normalize_config(&mut config);
        set_obs_config(&mut config, &json!({ "password": "obs-secret-value" }));
        save_donation_alerts_app(
            &mut config,
            &json!({ "clientId": "id", "clientSecret": "super-secret-value" }),
        );

        let snap = snapshot(&config, &db, &Runtime::new(0, &serde_json::Map::new()));

        assert_eq!(snap["obs"]["password"], json!(""));
        assert_eq!(snap["obs"]["hasPassword"], json!(true));
        assert_eq!(snap["donationAlertsAuth"]["hasClientSecret"], json!(true));
        let text = snap.to_string();
        assert!(!text.contains("obs-secret-value"), "пароль OBS утёк");
        assert!(!text.contains("super-secret-value"), "секрет DA утёк");

        // Пустой секрет — честное «не заполнено». Здесь очистка идёт правкой
        // настройки, а не через `save_donation_alerts_app`: тот пустым секретом
        // осознанно ничего не стирает.
        let mut donation_alerts = config
            .get("donationAlerts")
            .and_then(Value::as_object)
            .cloned()
            .unwrap();
        donation_alerts.insert("clientSecret".to_string(), Value::from(""));
        config.set("donationAlerts", Value::Object(donation_alerts));
        let snap = snapshot(&config, &db, &Runtime::new(0, &serde_json::Map::new()));
        assert_eq!(snap["donationAlertsAuth"]["hasClientSecret"], json!(false));
    }

    #[test]
    fn the_snapshot_carries_donatex_widget_links() {
        let fixture = Fixture::new("donatex-widgets");
        let mut config = fixture.config();
        let db = fixture.db();
        normalize_config(&mut config);
        set_app_config(
            &mut config,
            &json!({"donatex": {"widgets": {
                "donation": "https://donatex.gg/widgets/donation/abc",
                "music": "https://donatex.gg/widgets/music/def",
                "roulette": "https://donatex.gg/widgets/roulette/ghi"
            }}}),
        );

        let snap = snapshot(&config, &db, &Runtime::new(0, &serde_json::Map::new()));
        assert_eq!(
            snap["donatex"]["widgets"]["donation"],
            json!("https://donatex.gg/widgets/donation/abc")
        );
        assert_eq!(
            snap["donatex"]["widgets"]["music"],
            json!("https://donatex.gg/widgets/music/def")
        );
        assert_eq!(
            snap["donatex"]["widgets"]["roulette"],
            json!("https://donatex.gg/widgets/roulette/ghi")
        );
        assert_eq!(snap["donatex"]["widgets"]["ai"], json!(""));
    }

    #[test]
    fn the_snapshot_carries_layout_runtime_and_theme() {
        let fixture = Fixture::new("shape");
        let mut config = fixture.config();
        let db = fixture.db();
        normalize_config(&mut config);
        add_widget(&db, "chat").expect("виджет чата");

        let mut runtime = Runtime::new(0, &serde_json::Map::new());
        runtime.set_active_scene(&json!("brb"), 1000);
        runtime.adjust_death_count(&json!(2));

        let snap = snapshot(&config, &db, &runtime);

        assert_eq!(snap["layout"].as_array().unwrap().len(), 1);
        assert_eq!(snap["activeScene"], json!("brb"));
        assert_eq!(snap["sceneStartedAt"], json!(1000));
        assert_eq!(snap["deathCount"], json!(2));
        // Тема по умолчанию — nebula, а её умолчание — без 3D.
        assert_eq!(snap["appearance"]["activeThemeId"], json!("nebula"));
        assert_eq!(snap["appearance"]["enable3d"], json!(false));
        assert_eq!(snap["appearance"]["active3dWidgets"], json!([]));
        assert!(snap["appearance"]["tokens"].is_object());
        // Опрос отдаётся вместе с настройками и пресетами.
        assert_eq!(snap["poll"]["command"], json!("!poll"));
        assert_eq!(snap["pollPresets"], json!([]));
        // Настройки, не требующие секретов, на месте.
        assert_eq!(snap["port"], json!(8710));
        assert!(snap["scenes"].get("brb").is_some());
    }

    #[test]
    fn the_snapshot_assigns_guest_slots_on_scenes_too() {
        let fixture = Fixture::new("scene-guest-slots");
        let mut config = fixture.config();
        let db = fixture.db();
        normalize_config(&mut config);
        config.set(
            "scenes",
            json!({
                "talk": {
                    "widgets": [
                        { "id": "a", "type": "webcam", "config": { "source": "remote", "guestSlot": "cam2" } },
                        { "id": "b", "type": "webcam", "config": { "source": "remote" } }
                    ]
                }
            }),
        );

        let snap = snapshot(&config, &db, &Runtime::new(0, &serde_json::Map::new()));
        let widgets = snap["scenes"]["talk"]["widgets"].as_array().unwrap();
        assert_eq!(widgets.len(), 2);
        // Сцена получает ту же раздачу, что и основной оверлей, ещё до правки.
        assert_eq!(widgets[1]["config"]["guestSlot"], json!("cam3"));
    }
}
