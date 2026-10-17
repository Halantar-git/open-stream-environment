//! Медиа для донатов: правила «донат от суммы → звук / картинка / видео».
//!
//! Секция `donationMedia` живёт рядом с шумотекой, но триггер у неё другой:
//! правила проверяются на каждом донат-алерте, а медиа проигрывается в момент
//! показа алерта (а не при постановке в очередь). Само воспроизведение — в
//! оверлее (`overlay/donation-media.js`), здесь только данные и выбор правила.
//!
//! Сумма в правиле — порог «от»: если подходят несколько правил, побеждает
//! правило с самым высоким порогом. Так общий звук на 100 и особый на 1000 не
//! конфликтуют.

use serde_json::{json, Map, Value};

use crate::state::string_trim;
use crate::storage::config_file::ConfigFile;
use crate::storage::history::{js_number_or_zero, js_truthy};

/// Ключ секции в `config.json`.
pub const KEY: &str = "donationMedia";
const DEFAULT_VOLUME: f64 = 0.8;
const DEFAULT_DURATION_MS: f64 = 5000.0;
const MIN_DURATION_MS: f64 = 1000.0;
const MAX_DURATION_MS: f64 = 60000.0;

pub fn default_config() -> Value {
    json!({ "enabled": true, "volume": DEFAULT_VOLUME, "rules": [] })
}

pub fn section(config: &ConfigFile) -> Map<String, Value> {
    config
        .get(KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Привести секцию к предсказуемому виду при старте и загрузке настроек.
pub fn normalize_config(config: &mut ConfigFile) {
    let normalized = normalize_section(&Value::Object(section(config)));
    config.set(KEY, normalized);
}

/// Нормализовать секцию: булев флаг, громкость и правила.
pub fn normalize_section(section: &Value) -> Value {
    let enabled = section.get("enabled") != Some(&Value::Bool(false));
    let volume = match section.get("volume") {
        Some(value) => js_number_or_zero(Some(value)).clamp(0.0, 1.0),
        None => DEFAULT_VOLUME,
    };
    let rules = section
        .get("rules")
        .and_then(Value::as_array)
        .map(|rules| {
            rules
                .iter()
                .filter_map(normalize_rule)
                .collect::<Vec<Value>>()
        })
        .unwrap_or_default();
    json!({
        "enabled": enabled,
        "volume": volume,
        "rules": rules,
    })
}

/// Одно правило. Без `id` правило нечем обновлять и тестировать, поэтому оно
/// отбрасывается; пустые файлы допустимы — пользователь ещё заполняет правило.
fn normalize_rule(rule: &Value) -> Option<Value> {
    let id = text(rule.get("id"));
    if id.is_empty() {
        return None;
    }
    let duration = js_number_or_zero(rule.get("durationMs"));
    let duration_ms = if duration <= 0.0 {
        DEFAULT_DURATION_MS
    } else {
        duration.clamp(MIN_DURATION_MS, MAX_DURATION_MS).round()
    };
    let min_amount = js_number_or_zero(rule.get("minAmount")).max(0.0);
    Some(json!({
        "id": id,
        "minAmount": (min_amount * 100.0).round() / 100.0,
        "audioFile": text(rule.get("audioFile")),
        "imageFile": text(rule.get("imageFile")),
        "videoFile": text(rule.get("videoFile")),
        "durationMs": duration_ms,
    }))
}

/// Изменить секцию из панели: поля доливаются, `rules` заменяется целиком.
pub fn set_config(config: &mut ConfigFile, patch: &Value) -> Value {
    let mut current = section(config);
    if let Some(value) = patch.get("enabled") {
        current.insert("enabled".to_string(), Value::Bool(js_truthy(Some(value))));
    }
    if let Some(value) = patch.get("volume") {
        current.insert(
            "volume".to_string(),
            json!(js_number_or_zero(Some(value)).clamp(0.0, 1.0)),
        );
    }
    if let Some(Value::Array(rules)) = patch.get("rules") {
        current.insert(
            "rules".to_string(),
            Value::Array(rules.iter().filter_map(normalize_rule).collect()),
        );
    }
    let normalized = normalize_section(&Value::Object(current));
    config.set(KEY, normalized.clone());
    normalized
}

/// Правило, которое срабатывает на сумму: самое высокое из подходящих.
pub fn match_rule(section: &Value, amount: f64) -> Option<Value> {
    if section.get("enabled") == Some(&Value::Bool(false)) {
        return None;
    }
    let volume = section
        .get("volume")
        .map(|value| js_number_or_zero(Some(value)).clamp(0.0, 1.0))
        .unwrap_or(DEFAULT_VOLUME);
    let rules = section.get("rules")?.as_array()?;
    let mut best: Option<(&Value, f64)> = None;
    for rule in rules {
        if !has_media(rule) {
            continue;
        }
        let min_amount = js_number_or_zero(rule.get("minAmount")).max(0.0);
        if amount + f64::EPSILON < min_amount {
            continue;
        }
        if best.map_or(true, |(_, best_amount)| min_amount > best_amount) {
            best = Some((rule, min_amount));
        }
    }
    best.map(|(rule, _)| media_payload(rule, volume))
}

/// Кадр `donation_media_play` для подходящего доната; `None` — правила нет.
pub fn alert_payload(config: &ConfigFile, alert: &Value) -> Option<Value> {
    if alert.get("kind").and_then(Value::as_str) != Some("donation") {
        return None;
    }
    // Пропущенные донаты добираются пачкой при запуске — медиа для них было бы
    // неожиданным и могло бы наложиться на текущий эфир.
    if js_truthy(alert.get("recovered")) {
        return None;
    }
    let amount = js_number_or_zero(alert.get("amount"));
    let mut payload = match_rule(&Value::Object(section(config)), amount)?;
    if let Value::Object(map) = &mut payload {
        map.insert(
            "user".to_string(),
            alert.get("user").cloned().unwrap_or(Value::Null),
        );
        map.insert("amount".to_string(), json!(amount));
        map.insert(
            "currency".to_string(),
            alert.get("currency").cloned().unwrap_or(Value::Null),
        );
    }
    Some(payload)
}

/// Кадр для кнопки «Проверить»: правило ищется по `id` и работает даже при
/// выключенной секции — пользователь как раз настраивает её.
pub fn test_payload(config: &ConfigFile, rule_id: &str) -> Option<Value> {
    let section = section(config);
    let volume = section
        .get("volume")
        .map(|value| js_number_or_zero(Some(value)).clamp(0.0, 1.0))
        .unwrap_or(DEFAULT_VOLUME);
    let rule = section
        .get("rules")?
        .as_array()?
        .iter()
        .find(|rule| text(rule.get("id")) == rule_id && has_media(rule))?;
    let min_amount = js_number_or_zero(rule.get("minAmount")).max(0.0);
    let mut payload = media_payload(rule, volume);
    if let Value::Object(map) = &mut payload {
        map.insert("user".to_string(), Value::from("Тест"));
        map.insert("amount".to_string(), json!(min_amount));
        map.insert("currency".to_string(), Value::from("RUB"));
    }
    Some(payload)
}

fn media_payload(rule: &Value, volume: f64) -> Value {
    json!({
        "ruleId": text(rule.get("id")),
        "audioFile": text(rule.get("audioFile")),
        "imageFile": text(rule.get("imageFile")),
        "videoFile": text(rule.get("videoFile")),
        "durationMs": normalize_duration(rule),
        "volume": volume,
    })
}

fn normalize_duration(rule: &Value) -> f64 {
    let duration = js_number_or_zero(rule.get("durationMs"));
    if duration <= 0.0 {
        DEFAULT_DURATION_MS
    } else {
        duration.clamp(MIN_DURATION_MS, MAX_DURATION_MS).round()
    }
}

fn has_media(rule: &Value) -> bool {
    ["audioFile", "imageFile", "videoFile"]
        .iter()
        .any(|key| !text(rule.get(*key)).is_empty())
}

fn text(value: Option<&Value>) -> String {
    string_trim(value.unwrap_or(&Value::Null))
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
            let dir = std::env::temp_dir().join(format!(
                "ose-donation-media-{}-{label}-{index}",
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
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.dir).ok();
        }
    }

    fn section_with(rules: Value) -> Value {
        json!({ "enabled": true, "volume": 0.5, "rules": rules })
    }

    fn write_section(config: &mut ConfigFile, section: Value) {
        config.set(KEY, section);
    }

    #[test]
    fn normalization_fills_defaults_and_drops_rules_without_id() {
        let normalized = normalize_section(&json!({
            "volume": 9,
            "rules": [
                { "id": " a ", "minAmount": -5, "audioFile": " media/a.mp3 ", "durationMs": 999999 },
                { "minAmount": 100 },
            ],
        }));
        assert_eq!(normalized["enabled"], json!(true));
        assert_eq!(normalized["volume"], json!(1.0));
        assert_eq!(normalized["rules"].as_array().unwrap().len(), 1);
        assert_eq!(normalized["rules"][0]["id"], json!("a"));
        assert_eq!(normalized["rules"][0]["minAmount"], json!(0.0));
        assert_eq!(normalized["rules"][0]["audioFile"], json!("media/a.mp3"));
        // Потолок длительности — минута.
        assert_eq!(normalized["rules"][0]["durationMs"], json!(60000.0));
    }

    #[test]
    fn set_config_merges_fields_and_replaces_rules() {
        let fixture = Fixture::new("set");
        let mut config = fixture.config();
        write_section(&mut config, default_config());

        let saved = set_config(
            &mut config,
            &json!({
                "enabled": false,
                "volume": 1.5,
                "rules": [{ "id": "r1", "minAmount": 500, "imageFile": " media/a.png " }],
            }),
        );
        assert_eq!(saved["enabled"], json!(false));
        assert_eq!(saved["volume"], json!(1.0));
        assert_eq!(saved["rules"][0]["id"], json!("r1"));
        assert_eq!(saved["rules"][0]["imageFile"], json!("media/a.png"));

        // Поля не из патча остаются, `rules` заменяются целиком.
        let saved = set_config(&mut config, &json!({ "enabled": true }));
        assert_eq!(saved["volume"], json!(1.0));
        assert_eq!(saved["rules"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn the_highest_matching_threshold_wins() {
        let section = section_with(json!([
            { "id": "small", "minAmount": 100, "audioFile": "a.mp3" },
            { "id": "big", "minAmount": 1000, "imageFile": "b.png" },
            { "id": "empty", "minAmount": 5000 },
        ]));

        let small = match_rule(&section, 150.0).expect("малое правило");
        assert_eq!(small["ruleId"], json!("small"));
        assert_eq!(small["volume"], json!(0.5));

        let big = match_rule(&section, 1000.0).expect("большое правило");
        assert_eq!(big["ruleId"], json!("big"));

        // Правило без файлов не срабатывает — даже когда его порог выше всех.
        assert_eq!(
            match_rule(&section, 5000.0).unwrap()["ruleId"],
            json!("big")
        );
        let only_empty = section_with(json!([{ "id": "empty", "minAmount": 0 }]));
        assert!(match_rule(&only_empty, 5000.0).is_none());
        // Ниже самого низкого порога — тоже.
        assert!(match_rule(&section, 50.0).is_none());
    }

    #[test]
    fn a_disabled_section_never_matches() {
        let section = json!({
            "enabled": false,
            "volume": 0.8,
            "rules": [{ "id": "a", "minAmount": 1, "videoFile": "a.mp4" }],
        });
        assert!(match_rule(&section, 100.0).is_none());
    }

    #[test]
    fn only_donations_trigger_media_and_recovered_ones_are_skipped() {
        let fixture = Fixture::new("alert");
        let mut config = fixture.config();
        write_section(
            &mut config,
            section_with(json!([
                { "id": "a", "minAmount": 100, "audioFile": "a.mp3" },
            ])),
        );

        let payload = alert_payload(
            &config,
            &json!({ "kind": "donation", "user": "fan", "amount": 250, "currency": "RUB" }),
        )
        .expect("донат подходит");
        assert_eq!(payload["ruleId"], json!("a"));
        assert_eq!(payload["user"], json!("fan"));
        assert_eq!(payload["amount"], json!(250.0));
        assert_eq!(payload["currency"], json!("RUB"));

        // Не донат и пропущенный донат медиа не запускают.
        assert!(alert_payload(&config, &json!({ "kind": "follow", "amount": 500 })).is_none());
        assert!(alert_payload(
            &config,
            &json!({ "kind": "donation", "amount": 500, "recovered": true })
        )
        .is_none());
        // Сумма ниже порога.
        assert!(alert_payload(&config, &json!({ "kind": "donation", "amount": 50 })).is_none());
    }

    #[test]
    fn test_payload_finds_the_rule_even_when_the_section_is_disabled() {
        let fixture = Fixture::new("test-payload");
        let mut config = fixture.config();
        write_section(
            &mut config,
            json!({
                "enabled": false,
                "volume": 0.4,
                "rules": [{ "id": "r1", "minAmount": 250, "videoFile": "media/v.mp4", "durationMs": 2500 }],
            }),
        );

        let payload = test_payload(&config, "r1").expect("правило для проверки");
        assert_eq!(payload["ruleId"], json!("r1"));
        assert_eq!(payload["videoFile"], json!("media/v.mp4"));
        assert_eq!(payload["durationMs"], json!(2500.0));
        assert_eq!(payload["volume"], json!(0.4));
        assert_eq!(payload["user"], json!("Тест"));

        // Незнакомое правило и правило без файлов нечего проверять.
        assert!(test_payload(&config, "ghost").is_none());
        let mut empty = fixture.config();
        write_section(
            &mut empty,
            section_with(json!([{ "id": "empty", "minAmount": 10 }])),
        );
        assert!(test_payload(&empty, "empty").is_none());
    }

    #[test]
    fn normalize_config_turns_an_absent_section_into_defaults() {
        let fixture = Fixture::new("normalize");
        let mut config = fixture.config();
        normalize_config(&mut config);
        let section = config.get(KEY).expect("секция появилась");
        assert_eq!(section["enabled"], json!(true));
        assert_eq!(section["volume"], json!(0.8));
        assert_eq!(section["rules"], json!([]));
    }
}
