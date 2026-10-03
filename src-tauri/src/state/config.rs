//! Настройки приложения: цель сбора, очередь алертов, интеграции, звук, бот.
//!
//! Порт части `server/state.js`: `setGoal`/`addToGoal`, `alertQueueConfig`/
//! `setAlertQueueConfig`, `setAppConfig`, `setObsConfig`, `setSoundboardConfig`,
//! `setStreamDeckConfig`, `setTtsConfig`, `setDonationVoiceConfig`,
//! `setChatBotConfig`, `setTwitchRewards`/`getTwitchRewardById`, сохранение
//! ключей приложения и токенов (`saveTwitchApp`/`saveTwitchTokens` и такие же у
//! DonationAlerts и YouTube), `setYoutubeVideoId`, `setIntegrationEnabled` и
//! уведомления (`setNotificationSound`/`Volume`/`Repeats`).
//!
//! Здесь же — нормализация того, что приходит из панели: команды и таймеры бота,
//! правила модерации, товары Twitch. Это чистые функции, поэтому их можно
//! проверить отдельно.
//!
//! Два правила, повторённые дословно, — иначе интерфейсу больно:
//!
//! * **секрет не сохраняется пустым**: панель никогда не показывает сохранённый
//!   ключ обратно, поэтому пустое поле означает «не менять», а не «стереть»;
//! * **пароль OBS стирается только `clearPassword`**, по той же причине.
//!
//! Сцены (`setSceneConfig`/`setSplashConfig`), снимок крупного доната и
//! `replaceConfig` идут следом: им нужны данные каталога сцен, а он ещё не
//! перенесён.

use serde_json::{json, Map, Value};

use crate::state::{js_string, string_trim};
use crate::storage::config_file::ConfigFile;
use crate::storage::db::Database;
use crate::storage::history::{js_number, js_number_or_zero, js_truthy, number_value};

/// Уровни доступа команд бота — как `BOT_LEVELS`.
const BOT_LEVELS: [&str; 4] = ["everyone", "subscriber", "moderator", "broadcaster"];

/// Сцены, к которым можно привязать товар Twitch — как `REWARD_SCENES`.
const REWARD_SCENES: [&str; 9] = [
    "", "main", "start", "brb", "talk", "end", "wheel", "poll", "pause",
];

/// Сколько команд и таймеров бота принимаем.
const MAX_BOT_COMMANDS: usize = 100;
const MAX_BOT_TIMERS: usize = 50;

// ---- Цель сбора ----

pub fn set_goal(config: &mut ConfigFile, patch: &Value) -> Value {
    let mut goal = section(config, "goal");
    if let Some(title) = patch.get("title") {
        goal.insert(
            "title".to_string(),
            Value::from(js_string(title).chars().take(80).collect::<String>()),
        );
    }
    if let Some(current) = patch.get("current") {
        goal.insert(
            "current".to_string(),
            number_value(js_number_or_zero(Some(current)).max(0.0)),
        );
    }
    if let Some(target) = patch.get("target") {
        let raw = js_number_or_zero(Some(target));
        let value = if raw == 0.0 { 1.0 } else { raw };
        goal.insert("target".to_string(), number_value(value.max(1.0)));
    }
    if let Some(currency) = patch.get("currency") {
        goal.insert(
            "currency".to_string(),
            Value::from(js_string(currency).chars().take(8).collect::<String>()),
        );
    }
    put_section(config, "goal", goal)
}

pub fn add_to_goal(config: &mut ConfigFile, amount: &Value) -> Value {
    let mut goal = section(config, "goal");
    let current = js_number_or_zero(goal.get("current"));
    goal.insert(
        "current".to_string(),
        number_value((current + js_number_or_zero(Some(amount))).max(0.0)),
    );
    put_section(config, "goal", goal)
}

// ---- Очередь алертов ----

pub fn alert_queue_config(config: &ConfigFile) -> Value {
    Value::Object(section(config, "alert_queue"))
}

pub fn set_alert_queue_config(config: &mut ConfigFile, patch: &Value) -> Value {
    let mut queue = section(config, "alert_queue");
    if let Some(value) = patch.get("enabled") {
        queue.insert("enabled".to_string(), Value::Bool(js_truthy(Some(value))));
    }
    if let Some(value) = patch.get("minAmount") {
        queue.insert(
            "min_amount".to_string(),
            number_value(js_number_or_zero(Some(value)).max(0.0)),
        );
    }
    if let Some(value) = patch.get("mergeSameUser") {
        queue.insert(
            "merge_same_user".to_string(),
            Value::Bool(js_truthy(Some(value))),
        );
    }
    if let Some(value) = patch.get("mergeWindowSec") {
        let seconds = js_number_or_zero(Some(value)).round().clamp(0.0, 600.0);
        queue.insert("merge_window_sec".to_string(), number_value(seconds));
    }
    if let Some(value) = patch.get("pauseUntil") {
        queue.insert(
            "pause_until".to_string(),
            number_value(js_number_or_zero(Some(value)).max(0.0)),
        );
    }
    put_section(config, "alert_queue", queue)
}

// ---- Приложение ----

/// Канал и порт; порт зажат в 1024–65535.
pub fn set_app_config(config: &mut ConfigFile, patch: &Value) {
    if let Some(channel) = patch.get("twitchChannel") {
        let mut twitch = section(config, "twitch");
        twitch.insert(
            "channel".to_string(),
            Value::from(js_string(channel).trim().to_lowercase()),
        );
        config.set("twitch", Value::Object(twitch));
    }
    if let Some(port) = patch.get("port") {
        let raw = js_number_or_zero(Some(port));
        let port = if raw == 0.0 { 8710.0 } else { raw };
        config.set("port", number_value(port.clamp(1024.0, 65535.0)));
    }
    config.save();
}

// ---- OBS ----

pub fn set_obs_config(config: &mut ConfigFile, patch: &Value) -> Value {
    let mut obs = section(config, "obs");

    if let Some(host) = patch.get("host") {
        obs.insert("host".to_string(), Value::from(string_trim(host)));
    }
    if let Some(port) = patch.get("port") {
        let raw = js_number_or_zero(Some(port));
        let port = if raw == 0.0 { 4455.0 } else { raw };
        obs.insert("port".to_string(), number_value(port));
    }

    // Пароль: пустая строка и отсутствие поля означают «не менять»; стирает его
    // только явный `clearPassword` из настроек.
    if patch.get("clearPassword").and_then(Value::as_bool) == Some(true) {
        obs.insert("password".to_string(), Value::from(""));
    } else if let Some(value) = patch.get("password") {
        let text = js_string(value);
        if !text.is_empty() {
            obs.insert("password".to_string(), Value::from(text));
        }
    }

    if let Some(source) = patch.get("webcamSource") {
        obs.insert("webcamSource".to_string(), Value::from(string_trim(source)));
    }
    if let Some(source) = patch.get("micSource") {
        obs.insert("micSource".to_string(), Value::from(string_trim(source)));
    }
    if let Some(scene_map) = patch.get("sceneMap").and_then(Value::as_object) {
        let mut merged = obs
            .get("sceneMap")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (key, value) in scene_map {
            merged.insert(key.clone(), value.clone());
        }
        obs.insert("sceneMap".to_string(), Value::Object(merged));
    }
    if let Some(commands) = patch.get("customCommands").and_then(Value::as_array) {
        let cleaned: Vec<Value> = commands
            .iter()
            .take(50)
            .map(|command| {
                json!({
                    "id": string_trim(command.get("id").unwrap_or(&Value::Null)),
                    "label": string_trim(command.get("label").unwrap_or(&Value::Null)),
                    "requestType": string_trim(command.get("requestType").unwrap_or(&Value::Null)),
                    "requestData": command
                        .get("requestData")
                        .filter(|value| value.is_object())
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                })
            })
            .collect();
        obs.insert("customCommands".to_string(), Value::Array(cleaned));
    }
    if let Some(angles) = patch.get("cameraAngles").and_then(Value::as_array) {
        let cleaned: Vec<Value> = angles
            .iter()
            .take(30)
            .map(|angle| {
                json!({
                    "id": string_trim(angle.get("id").unwrap_or(&Value::Null)),
                    "label": string_trim(angle.get("label").unwrap_or(&Value::Null)),
                    "twitchRewardTitle": string_trim(angle.get("twitchRewardTitle").unwrap_or(&Value::Null)),
                    "sceneName": string_trim(angle.get("sceneName").unwrap_or(&Value::Null)),
                    "cameraSource": string_trim(angle.get("cameraSource").unwrap_or(&Value::Null)),
                })
            })
            .collect();
        obs.insert("cameraAngles".to_string(), Value::Array(cleaned));
    }
    if let Some(filters) = patch.get("cameraFilters").and_then(Value::as_array) {
        let cleaned: Vec<Value> = filters
            .iter()
            .take(50)
            .map(|filter| {
                json!({
                    "id": string_trim(filter.get("id").unwrap_or(&Value::Null)),
                    "label": string_trim(filter.get("label").unwrap_or(&Value::Null)),
                    "twitchRewardTitle": string_trim(filter.get("twitchRewardTitle").unwrap_or(&Value::Null)),
                    "sourceName": string_trim(filter.get("sourceName").unwrap_or(&Value::Null)),
                    "filterName": string_trim(filter.get("filterName").unwrap_or(&Value::Null)),
                    "durationSec": number_value(js_number_or_zero(filter.get("durationSec")).max(0.0)),
                })
            })
            .collect();
        obs.insert("cameraFilters".to_string(), Value::Array(cleaned));
    }

    put_section(config, "obs", obs)
}

// ---- Звук, Stream Deck, TTS, озвучка донатов ----

pub fn set_soundboard_config(config: &mut ConfigFile, patch: &Value) -> Value {
    let mut soundboard = section(config, "soundboard");
    if let Some(value) = patch.get("enabled") {
        soundboard.insert("enabled".to_string(), Value::Bool(js_truthy(Some(value))));
    }
    if let Some(value) = patch.get("volume") {
        let volume = js_number_or_zero(Some(value)).clamp(0.0, 1.0);
        soundboard.insert("volume".to_string(), number_value(volume));
    }
    if let Some(value) = patch.get("queueMode") {
        soundboard.insert("queueMode".to_string(), Value::Bool(js_truthy(Some(value))));
    }
    if let Some(sounds) = patch.get("sounds").and_then(Value::as_array) {
        let cleaned: Vec<Value> = sounds
            .iter()
            .take(50)
            .map(|sound| {
                let reward_title = string_trim(sound.get("rewardTitle").unwrap_or(&Value::Null));
                let title = sound
                    .get("title")
                    .filter(|value| js_truthy(Some(value)))
                    .map(string_trim)
                    .unwrap_or_else(|| reward_title.clone());
                json!({
                    "id": string_trim(sound.get("id").unwrap_or(&Value::Null)),
                    "rewardTitle": reward_title,
                    "rewardId": string_trim(sound.get("rewardId").unwrap_or(&Value::Null)),
                    "audioFile": string_trim(sound.get("audioFile").unwrap_or(&Value::Null)),
                    "imageFile": string_trim(sound.get("imageFile").unwrap_or(&Value::Null)),
                    "videoFile": string_trim(sound.get("videoFile").unwrap_or(&Value::Null)),
                    "title": title,
                })
            })
            .collect();
        soundboard.insert("sounds".to_string(), Value::Array(cleaned));
    }
    put_section(config, "soundboard", soundboard)
}

pub fn set_streamdeck_config(config: &mut ConfigFile, patch: &Value) -> Value {
    let mut streamdeck = section(config, "streamdeck");
    if let Some(icons) = patch.get("icons").and_then(Value::as_object) {
        let mut merged = streamdeck
            .get("icons")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (key, value) in icons {
            merged.insert(key.clone(), value.clone());
        }
        let trimmed: Map<String, Value> = merged
            .into_iter()
            .map(|(key, value)| (key, Value::from(string_trim(&value))))
            .collect();
        streamdeck.insert("icons".to_string(), Value::Object(trimmed));
    }
    put_section(config, "streamdeck", streamdeck)
}

pub fn set_tts_config(config: &mut ConfigFile, patch: &Value) -> Value {
    let mut tts = section(config, "tts");
    if let Some(value) = patch.get("enabled") {
        tts.insert("enabled".to_string(), Value::Bool(js_truthy(Some(value))));
    }
    if let Some(value) = patch.get("volume") {
        tts.insert(
            "volume".to_string(),
            number_value(js_number_or_zero(Some(value)).clamp(0.0, 1.0)),
        );
    }
    if let Some(value) = patch.get("rate") {
        // `Number(rate) || 1`: ноль и мусор дают единицу.
        let raw = js_number_or_zero(Some(value));
        let rate = if raw == 0.0 { 1.0 } else { raw };
        tts.insert("rate".to_string(), number_value(rate.clamp(0.5, 2.0)));
    }
    if let Some(value) = patch.get("lang") {
        let lang = string_trim(value);
        let lang = if lang.is_empty() {
            "ru-RU".to_string()
        } else {
            lang
        };
        tts.insert("lang".to_string(), Value::from(lang));
    }
    if let Some(value) = patch.get("voice") {
        tts.insert("voice".to_string(), Value::from(string_trim(value)));
    }
    put_section(config, "tts", tts)
}

pub fn set_donation_voice_config(config: &mut ConfigFile, patch: &Value) -> Value {
    let mut voice = section(config, "donationVoice");
    if let Some(value) = patch.get("donationAlerts") {
        voice.insert(
            "donationAlerts".to_string(),
            Value::Bool(js_truthy(Some(value))),
        );
    }
    if let Some(value) = patch.get("volume") {
        voice.insert(
            "volume".to_string(),
            number_value(js_number_or_zero(Some(value)).clamp(0.0, 1.0)),
        );
    }
    put_section(config, "donationVoice", voice)
}

// ---- Чат-бот ----

pub fn set_chat_bot_config(config: &mut ConfigFile, patch: &Value) -> Value {
    let current = section(config, "chatBot");
    let mut next = current.clone();
    if let Some(object) = patch.as_object() {
        for (key, value) in object {
            next.insert(key.clone(), value.clone());
        }
    }

    next.insert(
        "enabled".to_string(),
        Value::Bool(next.get("enabled") != Some(&Value::Bool(false))),
    );
    let prefix = match next.get("prefix").and_then(Value::as_str) {
        Some(prefix) if !prefix.trim().is_empty() => prefix.trim().to_string(),
        _ => "!".to_string(),
    };
    next.insert("prefix".to_string(), Value::from(prefix));

    let commands = match next.get("commands").and_then(Value::as_array) {
        Some(commands) => Value::Array(
            commands
                .iter()
                .filter_map(normalize_bot_command)
                .take(MAX_BOT_COMMANDS)
                .collect(),
        ),
        None => current
            .get("commands")
            .cloned()
            .unwrap_or_else(|| json!([])),
    };
    next.insert("commands".to_string(), commands);

    let timers = match next.get("timers").and_then(Value::as_array) {
        Some(timers) => Value::Array(
            timers
                .iter()
                .filter_map(normalize_bot_timer)
                .take(MAX_BOT_TIMERS)
                .collect(),
        ),
        None => current.get("timers").cloned().unwrap_or_else(|| json!([])),
    };
    next.insert("timers".to_string(), timers);

    let moderation = merge_objects(current.get("moderation"), next.get("moderation"));
    next.insert(
        "moderation".to_string(),
        normalize_chat_bot_moderation(&moderation),
    );

    put_section(config, "chatBot", next)
}

/// Команда бота; `None` — прислали не объект.
pub fn normalize_bot_command(command: &Value) -> Option<Value> {
    if !command.is_object() {
        return None;
    }
    let name = js_string(command.get("name").unwrap_or(&Value::Null))
        .trim()
        .to_lowercase();
    // Как `.replace(/^[!./]/, "")`: срезаем ровно один ведущий символ.
    let name = match name.chars().next() {
        Some(first) if matches!(first, '!' | '.' | '/') => name[first.len_utf8()..].to_string(),
        _ => name,
    };
    let id = match command.get("id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => uuid::Uuid::new_v4().to_string(),
    };
    let level = command
        .get("level")
        .and_then(Value::as_str)
        .filter(|level| BOT_LEVELS.contains(level))
        .unwrap_or("everyone");
    Some(json!({
        "id": id,
        "name": name,
        "response": string_trim(command.get("response").unwrap_or(&Value::Null)),
        "level": level,
        "cooldown": number_value(js_number_or_zero(command.get("cooldown")).round().max(0.0)),
        "userCooldown": number_value(js_number_or_zero(command.get("userCooldown")).round().max(0.0)),
    }))
}

/// Таймер бота; `None` — прислали не объект.
pub fn normalize_bot_timer(timer: &Value) -> Option<Value> {
    if !timer.is_object() {
        return None;
    }
    let id = match timer.get("id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => uuid::Uuid::new_v4().to_string(),
    };
    Some(json!({
        "id": id,
        "name": string_trim(timer.get("name").unwrap_or(&Value::Null)),
        "response": string_trim(timer.get("response").unwrap_or(&Value::Null)),
        "interval": number_value(js_number_or_zero(timer.get("interval")).round().max(1.0)),
        "minChat": number_value(js_number_or_zero(timer.get("minChat")).round().max(0.0)),
    }))
}

/// Правила модерации — как `defaultModerationConfig()` плюс присланное поверх.
pub fn normalize_chat_bot_moderation(source: &Value) -> Value {
    let defaults = default_moderation_config();
    let source = source.as_object().cloned().unwrap_or_default();

    let list = |key: &str, limit: usize| -> Value {
        match source.get(key).and_then(Value::as_array) {
            Some(values) => Value::Array(
                values
                    .iter()
                    .map(|value| Value::from(js_string(value).trim().to_lowercase()))
                    .filter(|value| js_truthy(Some(value)))
                    .take(limit)
                    .collect(),
            ),
            None => defaults.get(key).cloned().unwrap_or_else(|| json!([])),
        }
    };
    let clamped = |key: &str, min: f64, max: f64| -> Value {
        let fallback = defaults.get(key).and_then(Value::as_f64).unwrap_or(min);
        match source.get(key).and_then(Value::as_f64) {
            Some(value) => number_value(value.round().clamp(min, max)),
            None => number_value(fallback.round()),
        }
    };

    json!({
        "enabled": source.get("enabled") == Some(&Value::Bool(true)),
        "linkProtection": source.get("linkProtection") != Some(&Value::Bool(false)),
        "whitelistDomains": list("whitelistDomains", 50),
        "badWords": list("badWords", 200),
        "capsThreshold": match source.get("capsThreshold").and_then(Value::as_f64) {
            Some(value) => number_value(value.clamp(0.0, 1.0)),
            None => defaults.get("capsThreshold").cloned().unwrap_or_else(|| json!(0.7)),
        },
        "maxEmotes": clamped("maxEmotes", 1.0, 100.0),
        "maxWarns": clamped("maxWarns", 1.0, 10.0),
        "warnTimeoutSec": clamped("warnTimeoutSec", 1.0, 86400.0),
    })
}

/// Значения по умолчанию для модерации — как `defaultModerationConfig()`.
fn default_moderation_config() -> Map<String, Value> {
    json!({
        "enabled": false,
        "linkProtection": true,
        "whitelistDomains": ["youtube.com", "youtu.be", "clips.twitch.tv", "twitch.tv", "boosty.to"],
        "badWords": [],
        "capsThreshold": 0.7,
        "maxEmotes": 15,
        "maxWarns": 3,
        "warnTimeoutSec": 600,
    })
    .as_object()
    .cloned()
    .expect("объект")
}

// ---- Товары Twitch ----

pub fn set_twitch_rewards(config: &mut ConfigFile, patch: &Value) -> Value {
    if let Some(rewards) = patch.get("rewards").and_then(Value::as_array) {
        let cleaned: Vec<Value> = rewards
            .iter()
            .take(100)
            .filter_map(normalize_twitch_reward)
            .collect();
        config.set("twitchRewards", Value::Array(cleaned));
        config.save();
    }
    config
        .get("twitchRewards")
        .cloned()
        .unwrap_or_else(|| json!([]))
}

pub fn twitch_reward_by_id(config: &ConfigFile, id: &Value) -> Value {
    config
        .get("twitchRewards")
        .and_then(Value::as_array)
        .and_then(|rewards| {
            rewards
                .iter()
                .find(|reward| reward.get("id") == Some(id))
                .cloned()
        })
        .unwrap_or(Value::Null)
}

/// Товар Twitch; `None` — не объект или без названия и идентификатора.
pub fn normalize_twitch_reward(reward: &Value) -> Option<Value> {
    if !reward.is_object() {
        return None;
    }
    let reward_title = string_trim(reward.get("rewardTitle").unwrap_or(&Value::Null));
    let reward_id = string_trim(reward.get("rewardId").unwrap_or(&Value::Null));
    if reward_title.is_empty() && reward_id.is_empty() {
        return None;
    }
    let id = match reward.get("id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => uuid::Uuid::new_v4().to_string(),
    };
    let scene = reward
        .get("scene")
        .and_then(Value::as_str)
        .filter(|scene| REWARD_SCENES.contains(scene))
        .unwrap_or("");
    Some(json!({
        "id": id,
        "rewardId": reward_id,
        "rewardTitle": reward_title,
        "alert": reward.get("alert") == Some(&Value::Bool(true)),
        "alertMessage": string_trim(reward.get("alertMessage").unwrap_or(&Value::Null)),
        "tts": reward.get("tts") == Some(&Value::Bool(true)),
        "ttsText": string_trim(reward.get("ttsText").unwrap_or(&Value::Null)),
        "scene": scene,
    }))
}

// ---- Ключи приложения и токены ----

pub fn save_twitch_app(config: &mut ConfigFile, patch: &Value) {
    save_app(config, "twitch", patch);
}

pub fn save_donation_alerts_app(config: &mut ConfigFile, patch: &Value) {
    save_app(config, "donationAlerts", patch);
}

pub fn save_youtube_app(config: &mut ConfigFile, patch: &Value) {
    save_app(config, "youtube", patch);
}

/// Общая часть `save*App`: `clientId` перезаписывается как есть, `clientSecret`
/// — только непустым.
fn save_app(config: &mut ConfigFile, key: &str, patch: &Value) {
    let mut application = section(config, key);
    if let Some(client_id) = patch.get("clientId") {
        application.insert(
            "clientId".to_string(),
            Value::from(js_string(client_id).trim()),
        );
    }
    if let Some(secret) = patch.get("clientSecret").and_then(Value::as_str) {
        let secret = secret.trim();
        if !secret.is_empty() {
            application.insert("clientSecret".to_string(), Value::from(secret));
        }
    }
    config.set(key, Value::Object(application));
    config.save();
}

pub fn save_twitch_tokens(config: &mut ConfigFile, patch: &Value) {
    save_tokens(
        config,
        "twitch",
        patch,
        &[
            "userAccessToken",
            "refreshToken",
            "broadcasterId",
            "expiresAt",
        ],
    );
}

pub fn save_donation_alerts_tokens(config: &mut ConfigFile, patch: &Value) {
    save_tokens(
        config,
        "donationAlerts",
        patch,
        &["accessToken", "refreshToken", "userId", "expiresAt"],
    );
}

pub fn save_youtube_tokens(config: &mut ConfigFile, patch: &Value) {
    save_tokens(
        config,
        "youtube",
        patch,
        &["accessToken", "refreshToken", "expiresAt"],
    );
}

fn save_tokens(config: &mut ConfigFile, key: &str, patch: &Value, fields: &[&str]) {
    let mut tokens = section(config, key);
    for field in fields {
        if let Some(value) = patch.get(*field) {
            tokens.insert((*field).to_string(), value.clone());
        }
    }
    config.set(key, Value::Object(tokens));
    config.save();
}

pub fn set_youtube_video_id(config: &mut ConfigFile, video_id: &Value) -> Value {
    let mut youtube = section(config, "youtube");
    let value = string_trim(video_id);
    youtube.insert("videoId".to_string(), Value::from(value.clone()));
    put_section(config, "youtube", youtube);
    Value::from(value)
}

/// Включить/выключить службу; `None` — такой службы нет.
pub fn set_integration_enabled(
    config: &mut ConfigFile,
    service: &str,
    enabled: bool,
) -> Option<bool> {
    let key = match service {
        "twitch" => "twitch",
        "donationAlerts" => "donationAlerts",
        "youtube" => "youtube",
        "obs" => "obs",
        _ => return None,
    };
    let mut section = section(config, key);
    section.insert("enabled".to_string(), Value::Bool(enabled));
    put_section(config, key, section);
    Some(enabled)
}

// ---- Уведомления ----

pub fn set_notification_sound(config: &mut ConfigFile, enabled: &Value) -> bool {
    let value = enabled != &Value::Bool(false);
    config.set("notificationSound", Value::Bool(value));
    config.save();
    value
}

pub fn set_notification_volume(config: &mut ConfigFile, volume: &Value) -> Value {
    let number = js_number(Some(volume));
    if number.is_finite() {
        let value = number_value(number.clamp(0.0, 1.0));
        config.set("notificationVolume", value.clone());
        config.save();
        return value;
    }
    config
        .get("notificationVolume")
        .cloned()
        .unwrap_or(Value::Null)
}

pub fn set_notification_repeats(config: &mut ConfigFile, repeats: &Value) -> Value {
    let number = js_number(Some(repeats)).round();
    let value = if number.is_finite() {
        number.clamp(1.0, 5.0)
    } else {
        1.0
    };
    let value = number_value(value);
    config.set("notificationRepeats", value.clone());
    config.save();
    value
}

// ---- Внутреннее ----

/// Секция настроек как объект; нет секции — пустой объект.
fn section(config: &ConfigFile, key: &str) -> Map<String, Value> {
    config
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Записать секцию и вернуть её.
fn put_section(config: &mut ConfigFile, key: &str, map: Map<String, Value>) -> Value {
    config.set(key, Value::Object(map));
    config.save();
    config.get(key).cloned().unwrap_or(Value::Null)
}

/// `{ ...base, ...patch }` из двух, возможно отсутствующих, объектов.
fn merge_objects(base: Option<&Value>, patch: Option<&Value>) -> Value {
    let mut merged = base.and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(patch) = patch.and_then(Value::as_object) {
        for (key, value) in patch {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

/// Привести настройки к текущей форме — порт нормализации конструктора `state.js`.
///
/// Вызывается при открытии настроек. Сюда **не** входят: код доступа
/// (`remote_token` нормализует `Diagnostics`), раскладка (она в [`Database`]) и
/// счётчики рантайма (они в `state::runtime`). Уже лежащие значения побеждают
/// умолчания, недостающие поля доливаются — так старый `config.json` «ведёт
/// себя» как свежий, а чужие ключи не теряются (`set` соседей не трогает).
pub fn normalize_config(config: &mut ConfigFile) {
    // Внешний вид: умолчания, миграция старых форм, объект выключенных 3D-фишек.
    crate::state::appearance::migrate_appearance(config);

    // Редактор.
    let mut editor = match config.get("editor").and_then(Value::as_object) {
        Some(editor) => editor.clone(),
        None => crate::state::appearance::default_editor(),
    };
    if !editor
        .get("aspectRatio")
        .is_some_and(|value| js_truthy(Some(value)))
    {
        editor.insert("aspectRatio".to_string(), Value::from("16:9"));
    }
    config.set("editor", Value::Object(editor));

    // HUD.
    let hotkey = normalized_hotkey(config.get("hud_edit_hotkey"), "Control+Shift+H");
    config.set("hud_edit_hotkey", Value::from(hotkey));
    config.set(
        "hud_display_id",
        display_value(config.get("hud_display_id")),
    );
    let hotkey = normalized_hotkey(config.get("chat_hud_hotkey"), "Control+Shift+L");
    config.set("chat_hud_hotkey", Value::from(hotkey));
    config.set(
        "chat_hud_display_id",
        display_value(config.get("chat_hud_display_id")),
    );

    // Уведомления.
    config.set(
        "notificationSound",
        Value::Bool(config.get("notificationSound") != Some(&Value::Bool(false))),
    );
    let volume = match config.get("notificationVolume").and_then(Value::as_f64) {
        Some(volume) => volume.clamp(0.0, 1.0),
        None => 0.8,
    };
    config.set("notificationVolume", number_value(volume));
    let repeats = js_number_or_zero(config.get("notificationRepeats"));
    let repeats = if repeats == 0.0 { 1.0 } else { repeats };
    config.set(
        "notificationRepeats",
        number_value(repeats.round().clamp(1.0, 5.0)),
    );

    // Окно чата поверх игры.
    let chat_hud = object_or_empty(config.get("chatHud"));
    let mut next_chat_hud = Map::new();
    next_chat_hud.insert("width".to_string(), number_field(&chat_hud, "width", 360.0));
    next_chat_hud.insert(
        "height".to_string(),
        number_field(&chat_hud, "height", 560.0),
    );
    next_chat_hud.insert("x".to_string(), coordinate_field(&chat_hud, "x"));
    next_chat_hud.insert("y".to_string(), coordinate_field(&chat_hud, "y"));
    next_chat_hud.insert(
        "opacity".to_string(),
        number_field(&chat_hud, "opacity", 70.0),
    );
    next_chat_hud.insert(
        "fontSize".to_string(),
        number_field(&chat_hud, "fontSize", 14.0),
    );
    config.set("chatHud", Value::Object(next_chat_hud));

    // Сцены и сплеш.
    crate::state::scenes::normalize_scenes(config);
    let splash = object_or_empty(config.get("splash"));
    let splash_file = match splash.get("file") {
        Some(file) => js_string(file),
        None => String::new(),
    };
    let splash_duration = match splash.get("duration") {
        Some(value) => js_number_or_zero(Some(value)).round().clamp(0.0, 30.0),
        None => 0.0,
    };
    config.set(
        "splash",
        json!({ "file": splash_file, "duration": number_value(splash_duration) }),
    );

    // YouTube.
    let youtube = merge_maps(
        object_or_empty(Some(
            &json!({ "clientId": "", "clientSecret": "", "accessToken": "", "refreshToken": "", "videoId": "" }),
        )),
        config.get("youtube"),
    );
    config.set("youtube", Value::Object(youtube));

    // OBS.
    let current_obs = object_or_empty(config.get("obs"));
    let mut obs = merge_maps(
        object_or_empty(Some(
            &json!({ "enabled": false, "host": "127.0.0.1", "port": 4455, "password": "" }),
        )),
        config.get("obs"),
    );
    obs.insert(
        "webcamSource".to_string(),
        Value::from(text_or_empty(current_obs.get("webcamSource"))),
    );
    obs.insert(
        "micSource".to_string(),
        Value::from(text_or_empty(current_obs.get("micSource"))),
    );
    let scene_map = merge_maps(
        object_or_empty(Some(
            &json!({ "main": "", "start": "", "brb": "", "talk": "", "end": "", "wheel": "", "video": "", "poll": "", "pause": "" }),
        )),
        current_obs.get("sceneMap"),
    );
    obs.insert("sceneMap".to_string(), Value::Object(scene_map));
    obs.insert(
        "customCommands".to_string(),
        array_or_empty(current_obs.get("customCommands")),
    );
    obs.insert(
        "cameraAngles".to_string(),
        array_or_empty(current_obs.get("cameraAngles")),
    );
    obs.insert(
        "cameraFilters".to_string(),
        array_or_empty(current_obs.get("cameraFilters")),
    );
    config.set("obs", Value::Object(obs));

    // Звуковая панель.
    let sb = object_or_empty(config.get("soundboard"));
    config.set(
        "soundboard",
        json!({
            "enabled": sb.get("enabled") != Some(&Value::Bool(false)),
            "volume": number_field(&sb, "volume", 0.8),
            "queueMode": js_truthy(sb.get("queueMode")),
            "sounds": array_or_empty(sb.get("sounds")),
        }),
    );

    // Stream Deck.
    let sd = object_or_empty(config.get("streamdeck"));
    let icons = merge_maps(
        object_or_empty(Some(
            &json!({ "start": "", "brb": "", "wheel": "", "talk": "", "main": "", "end": "", "pause": "" }),
        )),
        sd.get("icons"),
    );
    config.set("streamdeck", json!({ "icons": Value::Object(icons) }));

    // TTS и озвучка донатов.
    let tts = object_or_empty(config.get("tts"));
    config.set(
        "tts",
        json!({
            "enabled": tts.get("enabled") != Some(&Value::Bool(false)),
            "volume": number_field(&tts, "volume", 0.9),
            "rate": number_field(&tts, "rate", 1.0),
            "lang": text_or_default(tts.get("lang"), "ru-RU"),
            "voice": text_or_empty(tts.get("voice")),
        }),
    );
    let dv = object_or_empty(config.get("donationVoice"));
    config.set(
        "donationVoice",
        json!({
            "donationAlerts": dv.get("donationAlerts") == Some(&Value::Bool(true)),
            "volume": number_field(&dv, "volume", 0.9),
        }),
    );

    // Опрос (настройки нормализует уже перенесённый модуль).
    let poll = crate::state::poll::poll_config(config);
    config.set("poll", Value::Object(poll));

    // Чат-бот.
    let chat_bot = object_or_empty(config.get("chatBot"));
    config.set("chatBot", Value::Object(normalized_chat_bot(&chat_bot)));

    // Товары Twitch.
    let rewards = match config.get("twitchRewards").and_then(Value::as_array) {
        Some(rewards) => Value::Array(rewards.iter().filter_map(normalize_twitch_reward).collect()),
        None => json!([]),
    };
    config.set("twitchRewards", rewards);

    // Цель и крупный донат.
    let goal = object_or_empty(config.get("goal"));
    config.set(
        "goal",
        json!({
            "title": match goal.get("title").and_then(Value::as_str) {
                Some(title) => Value::from(title.chars().take(80).collect::<String>()),
                None => Value::from(""),
            },
            "current": number_value(js_number_or_zero(goal.get("current")).max(0.0)),
            "target": number_value(js_number_or_zero(goal.get("target")).max(0.0)),
            "currency": match goal.get("currency").and_then(Value::as_str) {
                // `typeof currency === "string" && currency.trim()` → trim + slice(0,8).
                Some(text) if !text.trim().is_empty() => {
                    Value::from(text.trim().chars().take(8).collect::<String>())
                }
                _ => Value::from("RUB"),
            },
        }),
    );
    let top = object_or_empty(config.get("topDonation"));
    config.set(
        "topDonation",
        json!({
            "user": match top.get("user").and_then(Value::as_str) {
                Some(user) => Value::from(user),
                None => Value::from(""),
            },
            "amount": number_value(js_number_or_zero(top.get("amount")).max(0.0)),
            "currency": match top.get("currency").and_then(Value::as_str) {
                Some(currency) if !currency.trim().is_empty() => Value::from(currency.trim().chars().take(8).collect::<String>()),
                _ => Value::from("RUB"),
            },
        }),
    );

    // Очередь алертов.
    let queue = object_or_empty(config.get("alert_queue"));
    let merge_window = queue.get("merge_window_sec").and_then(Value::as_f64);
    config.set(
        "alert_queue",
        json!({
            "enabled": queue.get("enabled") != Some(&Value::Bool(false)),
            "min_amount": number_value(js_number_or_zero(queue.get("min_amount")).max(0.0)),
            "merge_same_user": queue.get("merge_same_user") != Some(&Value::Bool(false)),
            "merge_window_sec": match merge_window {
                Some(seconds) => number_value(seconds.round().clamp(0.0, 600.0)),
                None => number_value(20.0),
            },
            "pause_until": number_value(js_number_or_zero(queue.get("pause_until")).max(0.0)),
        }),
    );

    // Службы по умолчанию включены, если флага ещё нет.
    for key in ["twitch", "donationAlerts", "youtube"] {
        let mut service = object_or_empty(config.get(key));
        if !service.contains_key("enabled") {
            service.insert("enabled".to_string(), Value::Bool(true));
            config.set(key, Value::Object(service));
        }
    }
}

/// Импорт настроек: собрать документ из известных разделов, как `replaceConfig`.
///
/// Код доступа и HUD-ключи остаются свои; чужая пауза очереди снимается
/// (`pause_until: 0`) — иначе импорт чужого файла заглушил бы алерты.
/// Возвращает ошибку, если пришёл не объект (битый файл).
pub fn replace_config(
    config: &mut ConfigFile,
    db: &Database,
    incoming: &Value,
) -> Result<(), String> {
    let Some(incoming) = incoming.as_object() else {
        return Err("Файл настроек повреждён или не в том формате".to_string());
    };

    let port = js_number(incoming.get("port"));
    let port_valid = port.is_finite() && port.fract() == 0.0 && (1024.0..=65535.0).contains(&port);

    let mut next = Map::new();
    next.insert(
        "port".to_string(),
        if port_valid {
            number_value(port)
        } else {
            config.get("port").cloned().unwrap_or(Value::Null)
        },
    );
    next.insert(
        "notificationSound".to_string(),
        typed_or(
            incoming.get("notificationSound"),
            config.get("notificationSound"),
            typed::BOOL,
        ),
    );
    next.insert(
        "notificationVolume".to_string(),
        typed_or(
            incoming.get("notificationVolume"),
            config.get("notificationVolume"),
            typed::NUMBER,
        ),
    );
    next.insert(
        "notificationRepeats".to_string(),
        typed_or(
            incoming.get("notificationRepeats"),
            config.get("notificationRepeats"),
            typed::NUMBER,
        ),
    );

    for key in [
        "twitch",
        "donationAlerts",
        "youtube",
        "goal",
        "donationVoice",
    ] {
        next.insert(
            key.to_string(),
            Value::Object(merge_maps(
                object_or_empty(config.get(key)),
                incoming.get(key),
            )),
        );
    }

    // OBS: соседние объекты сливаются, массивы берутся только настоящими.
    let current_obs = object_or_empty(config.get("obs"));
    let obs_patch = incoming.get("obs");
    let mut obs = merge_maps(current_obs.clone(), obs_patch);
    obs.insert(
        "sceneMap".to_string(),
        Value::Object(merge_maps(
            object_or_empty(current_obs.get("sceneMap")),
            obs_patch.and_then(|obs| obs.get("sceneMap")),
        )),
    );
    for field in ["customCommands", "cameraAngles", "cameraFilters"] {
        obs.insert(
            field.to_string(),
            keep_arr(
                obs_patch.and_then(|obs| obs.get(field)),
                current_obs.get(field).cloned().unwrap_or(Value::Null),
            ),
        );
    }
    next.insert("obs".to_string(), Value::Object(obs));

    // Звуковая панель.
    let current_soundboard = object_or_empty(config.get("soundboard"));
    let soundboard_patch = incoming.get("soundboard");
    let mut soundboard = merge_maps(current_soundboard.clone(), soundboard_patch);
    soundboard.insert(
        "sounds".to_string(),
        keep_arr(
            soundboard_patch.and_then(|soundboard| soundboard.get("sounds")),
            current_soundboard
                .get("sounds")
                .cloned()
                .unwrap_or(Value::Null),
        ),
    );
    next.insert("soundboard".to_string(), Value::Object(soundboard));

    // Stream Deck: иконки сливаются.
    let current_streamdeck = object_or_empty(config.get("streamdeck"));
    let streamdeck_patch = incoming.get("streamdeck");
    let mut streamdeck = merge_maps(current_streamdeck.clone(), streamdeck_patch);
    streamdeck.insert(
        "icons".to_string(),
        Value::Object(merge_maps(
            object_or_empty(current_streamdeck.get("icons")),
            streamdeck_patch.and_then(|streamdeck| streamdeck.get("icons")),
        )),
    );
    next.insert("streamdeck".to_string(), Value::Object(streamdeck));

    // Внешний вид: умолчания, текущее, затем чужое; свои темы — только массивом.
    let mut appearance = merge_maps(
        crate::state::appearance::default_appearance(),
        config.get("appearance"),
    );
    appearance = merge_maps(appearance, incoming.get("appearance"));
    appearance.insert(
        "customThemes".to_string(),
        keep_arr(
            incoming
                .get("appearance")
                .and_then(|appearance| appearance.get("customThemes")),
            config
                .get("appearance")
                .and_then(|appearance| appearance.get("customThemes"))
                .cloned()
                .unwrap_or_else(|| json!([])),
        ),
    );
    next.insert("appearance".to_string(), Value::Object(appearance));

    // Редактор.
    let mut editor = merge_maps(
        crate::state::appearance::default_editor(),
        config.get("editor"),
    );
    editor = merge_maps(editor, incoming.get("editor"));
    next.insert("editor".to_string(), Value::Object(editor));

    // Опрос.
    let current_poll = crate::state::poll::poll_config(config);
    let poll_options = current_poll
        .get("options")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let mut poll = merge_maps(current_poll, incoming.get("poll"));
    poll.insert(
        "options".to_string(),
        keep_arr(
            incoming.get("poll").and_then(|poll| poll.get("options")),
            poll_options,
        ),
    );
    next.insert("poll".to_string(), Value::Object(poll));

    // Чат-бот.
    let current_bot = object_or_empty(config.get("chatBot"));
    let bot_patch = incoming.get("chatBot");
    let mut bot = merge_maps(current_bot.clone(), bot_patch);
    for field in ["commands", "timers"] {
        bot.insert(
            field.to_string(),
            keep_arr(
                bot_patch.and_then(|bot| bot.get(field)),
                current_bot.get(field).cloned().unwrap_or_else(|| json!([])),
            ),
        );
    }
    let moderation = merge_maps(
        object_or_empty(current_bot.get("moderation")),
        bot_patch.and_then(|bot| bot.get("moderation")),
    );
    bot.insert(
        "moderation".to_string(),
        normalize_chat_bot_moderation(&Value::Object(moderation)),
    );
    next.insert("chatBot".to_string(), Value::Object(bot));

    next.insert(
        "twitchRewards".to_string(),
        keep_arr(
            incoming.get("twitchRewards"),
            config
                .get("twitchRewards")
                .cloned()
                .unwrap_or_else(|| json!([])),
        ),
    );

    // Сцены: чужой набор домазывается на умолчания, иначе остаётся свой.
    let scenes = match incoming.get("scenes") {
        Some(scenes) if js_truthy(Some(scenes)) => Value::Object(merge_maps(
            object_or_empty(Some(&crate::state::scenes::default_scenes())),
            Some(scenes),
        )),
        _ => config.get("scenes").cloned().unwrap_or(Value::Null),
    };
    next.insert("scenes".to_string(), scenes);

    next.insert(
        "topDonation".to_string(),
        match incoming.get("topDonation") {
            Some(top) if js_truthy(Some(top)) => top.clone(),
            _ => config.get("topDonation").cloned().unwrap_or(Value::Null),
        },
    );

    for key in ["tts", "splash", "chatHud"] {
        next.insert(
            key.to_string(),
            Value::Object(merge_maps(
                object_or_empty(config.get(key)),
                incoming.get(key),
            )),
        );
    }

    // Своё, не переносимое с чужим файлом.
    for key in [
        "hud_edit_hotkey",
        "hud_display_id",
        "chat_hud_hotkey",
        "chat_hud_display_id",
        "remote_token",
    ] {
        next.insert(
            key.to_string(),
            config.get(key).cloned().unwrap_or(Value::Null),
        );
    }

    // Правила очереди переносим, а срок паузы — нет.
    let mut queue = match incoming.get("alert_queue") {
        Some(queue) if js_truthy(Some(queue)) => object_or_empty(Some(queue)),
        _ => object_or_empty(config.get("alert_queue")),
    };
    queue.insert("pause_until".to_string(), number_value(0.0));
    next.insert("alert_queue".to_string(), Value::Object(queue));

    config.replace(next);
    crate::state::appearance::migrate_appearance(config);

    if let Some(layout) = incoming.get("layout").and_then(Value::as_array) {
        db.save_widgets(layout.clone());
    }
    config.save();
    Ok(())
}

/// Признак типа для [`typed_or`].
mod typed {
    pub const BOOL: u8 = 0;
    pub const NUMBER: u8 = 1;
}

/// Значение, если оно нужного типа; иначе прежнее.
fn typed_or(incoming: Option<&Value>, current: Option<&Value>, kind: u8) -> Value {
    let matches = match kind {
        typed::BOOL => incoming.is_some_and(Value::is_boolean),
        _ => incoming.is_some_and(Value::is_number),
    };
    if matches {
        incoming.cloned().unwrap_or(Value::Null)
    } else {
        current.cloned().unwrap_or(Value::Null)
    }
}

/// `Array.isArray(incoming) ? incoming : existing`.
fn keep_arr(incoming: Option<&Value>, existing: Value) -> Value {
    match incoming {
        Some(value) if value.is_array() => value.clone(),
        _ => existing,
    }
}

fn object_or_empty(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Массив как есть или пустой — когда поле не массив.
fn array_or_empty(value: Option<&Value>) -> Value {
    match value {
        Some(value) if value.is_array() => value.clone(),
        _ => Value::Array(Vec::new()),
    }
}

fn merge_maps(base: Map<String, Value>, patch: Option<&Value>) -> Map<String, Value> {
    let mut merged = base;
    if let Some(patch) = patch.and_then(Value::as_object) {
        for (key, value) in patch {
            merged.insert(key.clone(), value.clone());
        }
    }
    merged
}

/// Штатная нормализация бота конструктором: включён только при явном `true`.
fn normalized_chat_bot(current: &Map<String, Value>) -> Map<String, Value> {
    let mut bot = Map::new();
    bot.insert(
        "enabled".to_string(),
        Value::Bool(current.get("enabled") == Some(&Value::Bool(true))),
    );
    let prefix = match current.get("prefix").and_then(Value::as_str) {
        Some(prefix) if !prefix.trim().is_empty() => prefix.trim().to_string(),
        _ => "!".to_string(),
    };
    bot.insert("prefix".to_string(), Value::from(prefix));
    bot.insert(
        "commands".to_string(),
        match current.get("commands").and_then(Value::as_array) {
            Some(commands) => {
                Value::Array(commands.iter().filter_map(normalize_bot_command).collect())
            }
            None => json!([]),
        },
    );
    bot.insert(
        "timers".to_string(),
        match current.get("timers").and_then(Value::as_array) {
            Some(timers) => Value::Array(timers.iter().filter_map(normalize_bot_timer).collect()),
            None => json!([]),
        },
    );
    bot.insert(
        "moderation".to_string(),
        normalize_chat_bot_moderation(current.get("moderation").unwrap_or(&Value::Null)),
    );
    bot
}

/// Число из поля объекта или умолчание, если поля нет (или оно не число).
fn number_field(map: &Map<String, Value>, key: &str, default: f64) -> Value {
    match map.get(key).and_then(Value::as_f64) {
        Some(value) => number_value(value),
        None => number_value(default),
    }
}

/// Координата окна: `null` при отсутствии или пустой строке (`x == null || x === ""`),
/// иначе число.
fn coordinate_field(map: &Map<String, Value>, key: &str) -> Value {
    match map.get(key) {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(text)) if text.is_empty() => Value::Null,
        Some(value) => number_value(js_number_or_zero(Some(value))),
    }
}

/// `String(value || "")`.
fn text_or_empty(value: Option<&Value>) -> String {
    if js_truthy(value) {
        js_string(value.unwrap())
    } else {
        String::new()
    }
}

/// `String(value || default)`.
fn text_or_default(value: Option<&Value>, default: &str) -> String {
    if js_truthy(value) {
        js_string(value.unwrap())
    } else {
        default.to_string()
    }
}

/// Хоткей: обрезанная строка или умолчание.
fn normalized_hotkey(value: Option<&Value>, default: &str) -> String {
    match value.and_then(Value::as_str) {
        Some(hotkey) if !hotkey.trim().is_empty() => hotkey.trim().to_string(),
        _ => default.to_string(),
    }
}

/// Экран HUD: `null` при отсутствии, иначе строка.
fn display_value(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => Value::Null,
        Some(value) => Value::from(js_string(value)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::paths::Storage;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Настройки во временном каталоге — тест не трогает данные пользователя.
    struct Fixture {
        dir: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let index = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir()
                .join(format!("ose-config-{}-{label}-{index}", std::process::id()));
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
    fn obs_custom_commands_are_normalized() {
        let fixture = Fixture::new("obs-commands");
        let mut config = fixture.config();

        let obs = set_obs_config(
            &mut config,
            &json!({
                "customCommands": [
                    { "id": "  a  ", "label": "  Mute  ", "requestType": " ToggleInputMute ", "requestData": "bad" },
                    { "id": "b", "label": "", "requestType": "", "requestData": { "inputName": "Mic/Aux" } },
                ],
            }),
        );

        assert_eq!(
            obs["customCommands"],
            json!([
                { "id": "a", "label": "Mute", "requestType": "ToggleInputMute", "requestData": {} },
                { "id": "b", "label": "", "requestType": "", "requestData": { "inputName": "Mic/Aux" } },
            ])
        );
    }

    #[test]
    fn obs_camera_angles_are_normalized() {
        let fixture = Fixture::new("obs-angles");
        let mut config = fixture.config();

        let obs = set_obs_config(
            &mut config,
            &json!({
                "cameraAngles": [
                    { "id": " cam_main ", "label": " Основная ", "twitchRewardTitle": " Камера: Главная ", "sceneName": " Main ", "cameraSource": " Cam_Main " },
                ],
            }),
        );

        assert_eq!(
            obs["cameraAngles"],
            json!([
                { "id": "cam_main", "label": "Основная", "twitchRewardTitle": "Камера: Главная", "sceneName": "Main", "cameraSource": "Cam_Main" },
            ])
        );
    }

    #[test]
    fn the_obs_password_is_erased_only_explicitly() {
        let fixture = Fixture::new("obs-password");
        let mut config = fixture.config();

        set_obs_config(&mut config, &json!({ "password": "obs-secret-value" }));
        assert_eq!(
            config.get("obs").unwrap()["password"],
            json!("obs-secret-value")
        );

        // Пустая строка — «не менять».
        set_obs_config(&mut config, &json!({ "password": "" }));
        assert_eq!(
            config.get("obs").unwrap()["password"],
            json!("obs-secret-value")
        );

        set_obs_config(&mut config, &json!({ "clearPassword": true }));
        assert_eq!(config.get("obs").unwrap()["password"], json!(""));
    }

    #[test]
    fn soundboard_volume_is_clamped_and_fields_are_trimmed() {
        let fixture = Fixture::new("soundboard");
        let mut config = fixture.config();

        let soundboard = set_soundboard_config(
            &mut config,
            &json!({
                "volume": 5,
                "queueMode": true,
                "sounds": [{ "id": " s1 ", "rewardTitle": " Reward ", "audioFile": " media/a.mp3 " }],
            }),
        );

        assert_eq!(soundboard["volume"], json!(1));
        assert_eq!(soundboard["queueMode"], json!(true));
        assert_eq!(
            soundboard["sounds"][0],
            json!({
                "id": "s1",
                "rewardTitle": "Reward",
                "rewardId": "",
                "audioFile": "media/a.mp3",
                "imageFile": "",
                "videoFile": "",
                "title": "Reward",
            })
        );
    }

    #[test]
    fn streamdeck_icon_paths_are_trimmed() {
        let fixture = Fixture::new("streamdeck");
        let mut config = fixture.config();

        let streamdeck = set_streamdeck_config(
            &mut config,
            &json!({ "icons": { "scene": " media/scene.png ", "wheel": "" } }),
        );

        assert_eq!(streamdeck["icons"]["scene"], json!("media/scene.png"));
        assert_eq!(streamdeck["icons"]["wheel"], json!(""));
    }

    #[test]
    fn donation_voice_is_toggled_and_clamped() {
        let fixture = Fixture::new("voice");
        let mut config = fixture.config();

        let voice = set_donation_voice_config(
            &mut config,
            &json!({ "donationAlerts": true, "volume": 0.5 }),
        );
        assert_eq!(voice, json!({ "donationAlerts": true, "volume": 0.5 }));

        let voice = set_donation_voice_config(&mut config, &json!({ "volume": 42 }));
        assert_eq!(voice["volume"], json!(1));
    }

    #[test]
    fn chat_bot_commands_and_timers_are_normalized() {
        let fixture = Fixture::new("bot");
        let mut config = fixture.config();

        let bot = set_chat_bot_config(
            &mut config,
            &json!({
                "enabled": true,
                "prefix": "?",
                "commands": [
                    { "id": "c1", "name": "!Discord", "response": "  discord.gg/test  ", "level": "bad", "cooldown": -5, "userCooldown": 2.7 },
                    { "id": "c2", "name": "", "response": "", "level": "everyone", "cooldown": 0, "userCooldown": 0 },
                ],
                "timers": [
                    { "id": "t1", "name": "  Соцсети  ", "response": "текст", "interval": 0, "minChat": -3 },
                ],
            }),
        );

        assert_eq!(bot["enabled"], json!(true));
        assert_eq!(bot["prefix"], json!("?"));
        assert_eq!(
            bot["commands"][0],
            json!({ "id": "c1", "name": "discord", "response": "discord.gg/test", "level": "everyone", "cooldown": 0, "userCooldown": 3 })
        );
        // Пустая команда сохраняется как плейсхолдер.
        assert_eq!(bot["commands"][1]["name"], json!(""));
        assert_eq!(
            bot["timers"][0],
            json!({ "id": "t1", "name": "Соцсети", "response": "текст", "interval": 1, "minChat": 0 })
        );
    }

    #[test]
    fn a_missing_commands_array_keeps_the_previous_one() {
        let fixture = Fixture::new("bot-keep");
        let mut config = fixture.config();

        set_chat_bot_config(
            &mut config,
            &json!({ "commands": [{ "id": "c1", "name": "!a" }] }),
        );
        let bot = set_chat_bot_config(&mut config, &json!({ "prefix": "?" }));
        assert_eq!(bot["commands"].as_array().unwrap().len(), 1);
        assert_eq!(bot["commands"][0]["id"], json!("c1"));
    }

    #[test]
    fn moderation_merges_with_defaults() {
        let fixture = Fixture::new("moderation");
        let mut config = fixture.config();

        let bot = set_chat_bot_config(
            &mut config,
            &json!({ "moderation": { "enabled": true, "badWords": [" Bad ", "bad", ""], "maxWarns": 99 } }),
        );
        let moderation = &bot["moderation"];
        assert_eq!(moderation["enabled"], json!(true));
        assert_eq!(moderation["linkProtection"], json!(true));
        assert_eq!(moderation["badWords"], json!(["bad", "bad"]));
        // maxWarns зажат в 1…10, максимум по умолчанию — 3 участника.
        assert_eq!(moderation["maxWarns"], json!(10));
        assert_eq!(
            moderation["whitelistDomains"],
            json!([
                "youtube.com",
                "youtu.be",
                "clips.twitch.tv",
                "twitch.tv",
                "boosty.to"
            ])
        );
    }

    #[test]
    fn app_config_clamps_the_port() {
        let fixture = Fixture::new("port");
        let mut config = fixture.config();

        set_app_config(&mut config, &json!({ "port": 80 }));
        assert_eq!(config.get("port"), Some(&json!(1024)));

        set_app_config(&mut config, &json!({ "port": 99999 }));
        assert_eq!(config.get("port"), Some(&json!(65535)));

        set_app_config(
            &mut config,
            &json!({ "port": 9000, "twitchChannel": "  HALANTAR " }),
        );
        assert_eq!(config.get("port"), Some(&json!(9000)));
        assert_eq!(config.get("twitch").unwrap()["channel"], json!("halantar"));
    }

    #[test]
    fn an_empty_secret_does_not_erase_the_saved_one() {
        let fixture = Fixture::new("secrets");
        let mut config = fixture.config();

        for key in ["twitch", "donationAlerts", "youtube"] {
            let save = |config: &mut ConfigFile, patch: &Value| match key {
                "twitch" => save_twitch_app(config, patch),
                "donationAlerts" => save_donation_alerts_app(config, patch),
                _ => save_youtube_app(config, patch),
            };
            save(
                &mut config,
                &json!({ "clientId": "app-id", "clientSecret": "original-secret" }),
            );
            assert_eq!(
                config.get(key).unwrap()["clientSecret"],
                json!("original-secret")
            );

            save(
                &mut config,
                &json!({ "clientId": "app-id", "clientSecret": "" }),
            );
            save(
                &mut config,
                &json!({ "clientId": "app-id", "clientSecret": "   " }),
            );
            save(&mut config, &json!({ "clientId": "app-id" }));
            assert_eq!(
                config.get(key).unwrap()["clientSecret"],
                json!("original-secret")
            );

            // А новый секрет заменяет старый (и обрезается от пробелов).
            save(
                &mut config,
                &json!({ "clientId": "app-id", "clientSecret": "  rotated  " }),
            );
            assert_eq!(config.get(key).unwrap()["clientSecret"], json!("rotated"));
        }
    }

    #[test]
    fn the_client_id_keeps_its_value_but_loses_spaces() {
        let fixture = Fixture::new("client-id");
        let mut config = fixture.config();

        save_donation_alerts_app(
            &mut config,
            &json!({ "clientId": "  my-id  ", "clientSecret": "secret" }),
        );
        assert_eq!(
            config.get("donationAlerts").unwrap()["clientId"],
            json!("my-id")
        );

        // Асимметрия с секретом осознанная: пустое поле — это осознанная очистка.
        save_donation_alerts_app(
            &mut config,
            &json!({ "clientId": "", "clientSecret": "secret" }),
        );
        assert_eq!(config.get("donationAlerts").unwrap()["clientId"], json!(""));
    }

    #[test]
    fn tokens_are_stored_as_they_come() {
        let fixture = Fixture::new("tokens");
        let mut config = fixture.config();

        save_twitch_tokens(
            &mut config,
            &json!({ "userAccessToken": "tok", "broadcasterId": "42", "expiresAt": 1000 }),
        );
        let twitch = config.get("twitch").unwrap();
        assert_eq!(twitch["userAccessToken"], json!("tok"));
        assert_eq!(twitch["broadcasterId"], json!("42"));
        assert_eq!(twitch["expiresAt"], json!(1000));
    }

    #[test]
    fn rewards_drop_empty_ones_and_normalize_the_rest() {
        let fixture = Fixture::new("rewards");
        let mut config = fixture.config();

        let rewards = set_twitch_rewards(
            &mut config,
            &json!({
                "rewards": [
                    { "id": "r1", "rewardTitle": " Камера ", "rewardId": "  ", "alert": true, "scene": "brb" },
                    { "id": "r2", "rewardTitle": "", "rewardId": "" },
                    { "id": "r3", "rewardTitle": "T", "scene": "nope" },
                ],
            }),
        );

        assert_eq!(rewards.as_array().unwrap().len(), 2);
        assert_eq!(rewards[0]["rewardTitle"], json!("Камера"));
        assert_eq!(rewards[0]["rewardId"], json!(""));
        assert_eq!(rewards[0]["alert"], json!(true));
        assert_eq!(rewards[0]["scene"], json!("brb"));
        assert_eq!(rewards[1]["scene"], json!(""));
        assert_eq!(
            twitch_reward_by_id(&config, &json!("r1"))["id"],
            json!("r1")
        );
        assert_eq!(twitch_reward_by_id(&config, &json!("nope")), Value::Null);
    }

    #[test]
    fn integrations_can_be_toggled() {
        let fixture = Fixture::new("integrations");
        let mut config = fixture.config();

        assert_eq!(
            set_integration_enabled(&mut config, "twitch", false),
            Some(false)
        );
        assert_eq!(
            set_integration_enabled(&mut config, "obs", true),
            Some(true)
        );
        assert_eq!(config.get("obs").unwrap()["enabled"], json!(true));
        assert_eq!(set_integration_enabled(&mut config, "unknown", true), None);
    }

    #[test]
    fn notifications_clamp_their_values() {
        let fixture = Fixture::new("notifications");
        let mut config = fixture.config();

        assert!(set_notification_sound(&mut config, &json!(true)));
        assert!(!set_notification_sound(&mut config, &json!(false)));
        assert_eq!(set_notification_volume(&mut config, &json!(5)), json!(1));
        assert_eq!(set_notification_volume(&mut config, &json!(-1)), json!(0));
        // Мусор не ломает прежнее значение.
        assert_eq!(
            set_notification_volume(&mut config, &json!("abc")),
            json!(0)
        );
        assert_eq!(set_notification_repeats(&mut config, &json!(99)), json!(5));
        assert_eq!(set_notification_repeats(&mut config, &json!(0)), json!(1));
    }

    #[test]
    fn the_goal_is_clamped_on_every_field() {
        let fixture = Fixture::new("goal");
        let mut config = fixture.config();

        let goal = set_goal(
            &mut config,
            &json!({ "title": "Цель", "current": -5, "target": 0, "currency": "RUBLE" }),
        );
        assert_eq!(goal["current"], json!(0));
        // Цель не может быть нулевой, а валюта обрезается до восьми символов.
        assert_eq!(goal["target"], json!(1));
        assert_eq!(goal["currency"], json!("RUBLE"));

        let goal = add_to_goal(&mut config, &json!(200));
        assert_eq!(goal["current"], json!(200));
    }

    #[test]
    fn normalization_fills_defaults_without_touching_other_keys() {
        let fixture = Fixture::new("normalize");
        let mut config = fixture.config();
        config.set("ownKey", json!(42));

        normalize_config(&mut config);

        // Чужой ключ не потерян.
        assert_eq!(config.get("ownKey"), Some(&json!(42)));
        // Иконки Stream Deck и звуковая панель получили умолчания.
        assert!(config.get("streamdeck").unwrap()["icons"]
            .get("start")
            .is_some());
        assert_eq!(config.get("soundboard").unwrap()["volume"], json!(0.8));
        assert_eq!(config.get("chatHud").unwrap()["width"], json!(360));
        assert_eq!(config.get("tts").unwrap()["lang"], json!("ru-RU"));
        // Сцены появились, опрос нормализован, службы включены.
        assert!(config.get("scenes").unwrap().get("brb").is_some());
        assert_eq!(config.get("poll").unwrap()["command"], json!("!poll"));
        assert_eq!(config.get("twitch").unwrap()["enabled"], json!(true));
        assert_eq!(
            config.get("alert_queue").unwrap()["merge_window_sec"],
            json!(20)
        );
    }

    #[test]
    fn importing_settings_keeps_known_sections_and_ignores_bad_ones() {
        let fixture = Fixture::new("replace");
        let mut config = fixture.config();
        let db = fixture.db();
        normalize_config(&mut config);
        set_app_config(&mut config, &json!({ "port": 9000 }));
        config.set("hud_edit_hotkey", json!("Alt+H"));
        config.set("remote_token", json!("own-token"));

        replace_config(
            &mut config,
            &db,
            &json!({
                "port": 70000, // вне диапазона 1024–65535
                "soundboard": { "enabled": false, "volume": 0.5, "queueMode": true, "sounds": [{ "id": "s1", "rewardTitle": "R" }] },
                "streamdeck": { "icons": { "wheel": "media/w.png" } },
                "obs": { "customCommands": "not-an-array" },
            }),
        )
        .expect("импорт настроек");

        assert_eq!(config.get("port"), Some(&json!(9000)));
        assert_eq!(config.get("soundboard").unwrap()["enabled"], json!(false));
        // Массивы берутся как есть, без нормализации.
        assert_eq!(
            config.get("soundboard").unwrap()["sounds"],
            json!([{ "id": "s1", "rewardTitle": "R" }])
        );
        assert_eq!(
            config.get("streamdeck").unwrap()["icons"]["wheel"],
            json!("media/w.png")
        );
        // Существующие иконки сохранены.
        assert!(config.get("streamdeck").unwrap()["icons"]
            .get("start")
            .is_some());
        // Невалидный массив -> прежний.
        assert_eq!(config.get("obs").unwrap()["customCommands"], json!([]));
        // Свои ключи не переносятся вместе с чужим файлом.
        assert_eq!(config.get("hud_edit_hotkey"), Some(&json!("Alt+H")));
        assert_eq!(config.get("remote_token"), Some(&json!("own-token")));
    }

    #[test]
    fn importing_a_broken_file_is_refused() {
        let fixture = Fixture::new("replace-bad");
        let mut config = fixture.config();
        let db = fixture.db();
        assert!(replace_config(&mut config, &db, &json!([1, 2])).is_err());
        assert!(replace_config(&mut config, &db, &Value::Null).is_err());
    }
}
