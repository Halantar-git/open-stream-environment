//! Голосование зрителей: настройки опроса, пресеты и ход голосования.
//!
//! Порт части `server/state.js`: `pollSnapshot`, `startPoll`/`stopPoll`/`resetPoll`,
//! `setPollConfig`, варианты (`add`/`remove`/`clearPollOptions`), `votePoll`,
//! `handlePollChat`, `testPollVotes` и пресеты (`listPollPresets`,
//! `savePollPreset`, `applyPollPreset`, `deletePollPreset`).
//!
//! Настройки опроса живут в `config.json` (ключ `poll`), а пресеты — в базе
//! (`poll_presets`). Так же, как в JS: команда, тип диаграммы и варианты должны
//! переживать перезапуск, поэтому они пишутся и в конфиг, и в базу
//! (`_savePollConfig`), а пресеты — только в базу.
//!
//! Отличие от JS одно и осознанное: там нормализация вариантов идёт **один раз**,
//! в конструкторе, а `setPollConfig` кладёт присланный массив как есть — мусор
//! (пункт без строкового `id`/`label`) доживает до следующего запуска. Здесь
//! варианты чистятся и при записи: иначе снимок для панели показывал бы пункты,
//! которые в голосовании всё равно не участвуют. Сами снимки (`pollSnapshot`)
//! читают конфиг через ту же нормализацию, поэтому «что записали — то и читаем».

use serde_json::{json, Map, Value};

use crate::state::runtime::Runtime;
use crate::state::{js_string, string_trim};
use crate::storage::config_file::ConfigFile;
use crate::storage::db::Database;
use crate::storage::history::{js_number, js_number_or_zero, js_truthy, number_value};

/// Длина имени пресета — как в панели.
const PRESET_NAME_LIMIT: usize = 60;

/// Настройки опроса в том виде, в каком их читает панель.
///
/// `config.poll` может отсутствовать, быть не объектом или содержать мусор —
/// значение нормализуется на чтение, как в конструкторе `state.js`.
pub fn poll_config(config: &ConfigFile) -> Map<String, Value> {
    let raw = config.get("poll");

    let command = match raw
        .and_then(|poll| poll.get("command"))
        .and_then(Value::as_str)
    {
        Some(command) if !command.trim().is_empty() => command.trim().to_string(),
        _ => "!poll".to_string(),
    };
    let chart_type = normalize_chart_type(raw.and_then(|poll| poll.get("chartType")));
    let options = raw
        .and_then(|poll| poll.get("options"))
        .map(normalize_options)
        .unwrap_or_default();

    let mut poll = Map::new();
    poll.insert("command".to_string(), Value::from(command));
    poll.insert("chartType".to_string(), chart_type);
    poll.insert("options".to_string(), Value::Array(options));
    poll
}

/// Снимок опроса для панели: настройки, счётчики голосов и их сумма.
pub fn poll_snapshot(runtime: &Runtime, config: &ConfigFile) -> Value {
    let poll = poll_config(config);
    json!({
        "active": runtime.poll_active(),
        "command": poll.get("command").cloned().unwrap_or(Value::Null),
        "chartType": poll.get("chartType").cloned().unwrap_or(Value::Null),
        "options": poll.get("options").cloned().unwrap_or(Value::Null),
        "votes": runtime.poll_vote_counts(),
        "total": number_value(runtime.poll_total() as f64),
    })
}

/// Начать голосование: команда из вызова (если она строка) и сброс голосов.
pub fn start_poll(
    runtime: &mut Runtime,
    config: &mut ConfigFile,
    db: &Database,
    command: &Value,
) -> Value {
    let mut poll = poll_config(config);
    if let Some(text) = command.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            poll.insert("command".to_string(), Value::from(trimmed));
        }
    }
    write_poll_config(config, db, &poll);
    runtime.poll_set_active(true);
    runtime.poll_reset_votes();
    poll_snapshot(runtime, config)
}

pub fn stop_poll(runtime: &mut Runtime, config: &ConfigFile) -> Value {
    runtime.poll_set_active(false);
    poll_snapshot(runtime, config)
}

pub fn reset_poll(runtime: &mut Runtime, config: &ConfigFile) -> Value {
    runtime.poll_reset_votes();
    poll_snapshot(runtime, config)
}

/// Изменить настройки опроса поверх текущих.
pub fn set_poll_config(
    runtime: &mut Runtime,
    config: &mut ConfigFile,
    db: &Database,
    patch: &Value,
) -> Value {
    let mut next = poll_config(config);
    if let Some(object) = patch.as_object() {
        for (key, value) in object {
            next.insert(key.clone(), value.clone());
        }
    }

    // Команда: строка обрезается, пустая откатывается к умолчанию.
    if let Some(command) = next.get("command").and_then(Value::as_str) {
        let command = command.trim();
        let command = if command.is_empty() { "!poll" } else { command };
        next.insert("command".to_string(), Value::from(command));
    }
    let chart_type = normalize_chart_type(next.get("chartType"));
    next.insert("chartType".to_string(), chart_type);

    // Не массив вариантов — значит, патч их не касается: остаются прежние
    // (их уже положил `poll_config`). Массив чистится от мусора.
    if next.get("options").map(Value::is_array).unwrap_or(false) {
        let options = normalize_options(next.get("options").unwrap());
        next.insert("options".to_string(), Value::Array(options));
    }

    write_poll_config(config, db, &next);
    poll_snapshot(runtime, config)
}

/// Добавить пункт; `None` — пустая подпись.
pub fn add_poll_option(
    runtime: &mut Runtime,
    config: &mut ConfigFile,
    db: &Database,
    label: &Value,
) -> Option<Value> {
    let text = string_trim(label);
    if text.is_empty() {
        return None;
    }
    let mut poll = poll_config(config);
    let mut options = poll
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    options.push(json!({ "id": uuid::Uuid::new_v4().to_string(), "label": text }));
    poll.insert("options".to_string(), Value::Array(options));
    write_poll_config(config, db, &poll);
    Some(poll_snapshot(runtime, config))
}

/// Убрать пункт; голоса за него снимаются вместе с ним.
pub fn remove_poll_option(
    runtime: &mut Runtime,
    config: &mut ConfigFile,
    db: &Database,
    id: &Value,
) -> Value {
    let option_id = if js_truthy(Some(id)) {
        js_string(id)
    } else {
        String::new()
    };

    let mut poll = poll_config(config);
    let matched = poll
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter(|option| {
                    option.get("id").and_then(Value::as_str) != Some(option_id.as_str())
                })
                .cloned()
                .collect::<Vec<Value>>()
        })
        .unwrap_or_default();
    let removed = matched.len()
        != poll
            .get("options")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
    poll.insert("options".to_string(), Value::Array(matched));

    if removed {
        runtime.poll_remove_votes_for(&option_id);
        write_poll_config(config, db, &poll);
    }
    poll_snapshot(runtime, config)
}

pub fn clear_poll_options(runtime: &mut Runtime, config: &mut ConfigFile, db: &Database) -> Value {
    let mut poll = poll_config(config);
    poll.insert("options".to_string(), Value::Array(Vec::new()));
    runtime.poll_reset_votes();
    write_poll_config(config, db, &poll);
    poll_snapshot(runtime, config)
}

/// Записать голос; `None` — опрос не идёт, имя пустое или пункт неизвестен.
pub fn vote_poll(
    runtime: &mut Runtime,
    config: &ConfigFile,
    username: &Value,
    option_id: &Value,
) -> Option<Value> {
    let name = string_trim(username);
    if name.is_empty() || option_id.is_null() || !runtime.poll_active() {
        return None;
    }
    let known = poll_config(config)
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .any(|option| option.get("id") == Some(option_id))
        })
        .unwrap_or(false);
    if !known {
        return None;
    }
    runtime.poll_set_vote(name, option_id.clone());
    Some(poll_snapshot(runtime, config))
}

/// Разобрать сообщение чата: `!poll 2` — голос за второй пункт.
pub fn handle_poll_chat(
    runtime: &mut Runtime,
    config: &ConfigFile,
    username: &Value,
    message: &Value,
) -> Option<Value> {
    if !runtime.poll_active() {
        return None;
    }
    let poll = poll_config(config);
    let command = poll
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("!poll")
        .to_lowercase();
    let text = string_trim(message).to_lowercase();
    if command.is_empty() || (text != command && !text.starts_with(&format!("{command} "))) {
        return None;
    }

    // Берём хвост после команды по символам: строка пришла из чата и может быть
    // не ASCII, а резать её по байтам нельзя.
    let rest: String = text.chars().skip(command.chars().count()).collect();
    let rest = rest.trim();
    if rest.is_empty() {
        return None; // без номера пункта голос не засчитываем
    }

    let options = poll
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let index = js_number(Some(&Value::from(rest)));
    if !index.is_finite() || index.fract() != 0.0 || index < 1.0 || index > options.len() as f64 {
        return None;
    }
    let option_id = options[index as usize - 1]
        .get("id")
        .cloned()
        .unwrap_or(Value::Null);
    vote_poll(runtime, config, username, &option_id)
}

/// Накидать тестовых голосов (кнопка «проверить» в панели).
pub fn test_poll_votes(runtime: &mut Runtime, config: &ConfigFile, count: &Value) -> Option<Value> {
    let options = poll_config(config)
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if options.is_empty() {
        return None;
    }

    // `Number(count) || 12`, затем зажим в 1…50.
    let raw = js_number_or_zero(Some(count));
    let base = if raw == 0.0 { 12.0 } else { raw };
    let total = base.clamp(1.0, 50.0);
    let mut index = 0.0;
    while index < total {
        let user = format!("__test_{}", index as i64 + 1);
        let option_id = options[index as usize % options.len()]
            .get("id")
            .cloned()
            .unwrap_or(Value::Null);
        runtime.poll_set_vote(user, option_id);
        index += 1.0;
    }
    Some(poll_snapshot(runtime, config))
}

// ---- Пресеты ----

pub fn list_poll_presets(db: &Database) -> Vec<Value> {
    db.poll_presets().iter().map(preset_view).collect()
}

/// Сохранить текущие настройки как пресет; `None` — пустое имя или чужой `id`.
pub fn save_poll_preset(
    db: &Database,
    config: &ConfigFile,
    patch: &Value,
    now_ms: i64,
) -> Option<Vec<Value>> {
    let name = preset_name(patch.get("name"));
    if name.is_empty() {
        return None;
    }

    let poll = poll_config(config);
    let payload_command = poll.get("command").cloned().unwrap_or(Value::from("!poll"));
    let payload_chart = poll
        .get("chartType")
        .cloned()
        .unwrap_or(Value::from("bars"));
    let payload_options = Value::Array(
        poll.get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .map(|option| json!({ "id": option.get("id"), "label": option.get("label") }))
                    .collect()
            })
            .unwrap_or_default(),
    );

    let id = patch.get("id").filter(|id| js_truthy(Some(id))).cloned();
    let mut presets = db.poll_presets();
    match id {
        Some(id) => {
            let existing = presets
                .iter_mut()
                .find(|preset| preset.get("id") == Some(&id))?;
            let object = existing.as_object_mut()?;
            object.insert("name".to_string(), Value::from(name));
            object.insert("command".to_string(), payload_command);
            object.insert("chartType".to_string(), payload_chart);
            object.insert("options".to_string(), payload_options);
            object.insert("updatedAt".to_string(), number_value(now_ms as f64));
        }
        None => {
            presets.push(json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "name": name,
                "command": payload_command,
                "chartType": payload_chart,
                "options": payload_options,
                "createdAt": number_value(now_ms as f64),
                "updatedAt": number_value(now_ms as f64),
            }));
        }
    }

    db.save_poll_presets(presets);
    Some(list_poll_presets(db))
}

/// Вернуть настройки из пресета; `None` — пресета нет.
pub fn apply_poll_preset(
    runtime: &mut Runtime,
    config: &mut ConfigFile,
    db: &Database,
    id: &Value,
) -> Option<Value> {
    let presets = db.poll_presets();
    let preset = presets
        .iter()
        .find(|preset| preset.get("id") == Some(id))?
        .clone();

    let mut poll = Map::new();
    poll.insert(
        "command".to_string(),
        match preset.get("command").and_then(Value::as_str) {
            Some(command) if !command.trim().is_empty() => Value::from(command.trim()),
            _ => Value::from("!poll"),
        },
    );
    poll.insert(
        "chartType".to_string(),
        normalize_chart_type(preset.get("chartType")),
    );
    poll.insert(
        "options".to_string(),
        Value::Array(
            preset
                .get("options")
                .map(normalize_options)
                .unwrap_or_default(),
        ),
    );

    write_poll_config(config, db, &poll);
    Some(poll_snapshot(runtime, config))
}

/// Удалить пресет; `None` — такого пресета не было.
pub fn delete_poll_preset(db: &Database, id: &Value) -> Option<Vec<Value>> {
    let presets = db.poll_presets();
    let before = presets.len();
    let filtered: Vec<Value> = presets
        .into_iter()
        .filter(|preset| preset.get("id") != Some(id))
        .collect();
    if filtered.len() == before {
        return None;
    }
    db.save_poll_presets(filtered);
    Some(list_poll_presets(db))
}

// ---- Внутреннее ----

/// Записать настройки и в конфиг, и в базу — как `_savePollConfig`.
fn write_poll_config(config: &mut ConfigFile, db: &Database, poll: &Map<String, Value>) {
    let value = Value::Object(poll.clone());
    config.set("poll", value.clone());
    db.save_poll_config(Some(&value));
    config.save();
}

/// Пункты только со строковыми `id` и `label` — как фильтр в конструкторе.
fn normalize_options(options: &Value) -> Vec<Value> {
    options
        .as_array()
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    let id = option.get("id")?.as_str()?;
                    let label = option.get("label")?.as_str()?;
                    Some(json!({ "id": id, "label": label }))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_chart_type(value: Option<&Value>) -> Value {
    match value.and_then(Value::as_str) {
        Some("pie") => Value::from("pie"),
        _ => Value::from("bars"),
    }
}

/// Короткое представление пресета для списка в панели.
fn preset_view(preset: &Value) -> Value {
    let option_count = preset
        .get("options")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    json!({
        "id": preset.get("id").cloned().unwrap_or(Value::Null),
        "name": preset.get("name").cloned().unwrap_or(Value::Null),
        "command": match preset.get("command").and_then(Value::as_str) {
            Some(command) if !command.trim().is_empty() => Value::from(command.trim()),
            _ => Value::from("!poll"),
        },
        "chartType": normalize_chart_type(preset.get("chartType")),
        "optionCount": number_value(option_count as f64),
        "createdAt": preset
            .get("createdAt")
            .filter(|value| js_truthy(Some(value)))
            .cloned()
            .unwrap_or(json!(0)),
        "updatedAt": preset
            .get("updatedAt")
            .filter(|value| js_truthy(Some(value)))
            .cloned()
            .unwrap_or(json!(0)),
    })
}

/// `String(name || "").trim().slice(0, 60)`.
fn preset_name(value: Option<&Value>) -> String {
    match value {
        Some(value) if js_truthy(Some(value)) => js_string(value)
            .trim()
            .chars()
            .take(PRESET_NAME_LIMIT)
            .collect(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::paths::Storage;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Настройки и база во временном каталоге — тест не трогает данные пользователя.
    struct Fixture {
        dir: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let index = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir()
                .join(format!("ose-poll-{}-{label}-{index}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            fs::write(dir.join("config.example.json"), "{\n  \"port\": 8710\n}\n")
                .expect("шаблон должен записываться");
            Self { dir }
        }

        fn storage(&self) -> Storage {
            Storage::beside_sources(self.dir.clone())
        }

        fn db(&self) -> Database {
            Database::open(&self.storage())
        }

        fn config(&self) -> ConfigFile {
            ConfigFile::open(&self.storage()).expect("настройки")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.dir).ok();
        }
    }

    fn runtime() -> Runtime {
        Runtime::new(0, &Map::new())
    }

    fn poll_with_two_options(fixture: &Fixture) -> (Runtime, ConfigFile, Database) {
        let mut config = fixture.config();
        let db = fixture.db();
        let mut runtime = runtime();
        set_poll_config(
            &mut runtime,
            &mut config,
            &db,
            &json!({
                "command": "!vote",
                "chartType": "pie",
                "options": [{ "id": "a", "label": "Да" }, { "id": "b", "label": "Нет" }],
            }),
        );
        (runtime, config, db)
    }

    #[test]
    fn an_empty_config_starts_with_the_default_poll() {
        let fixture = Fixture::new("default");
        let poll = poll_config(&fixture.config());
        assert_eq!(poll["command"], json!("!poll"));
        assert_eq!(poll["chartType"], json!("bars"));
        assert_eq!(poll["options"], json!([]));
    }

    #[test]
    fn poll_options_without_string_fields_are_dropped() {
        let fixture = Fixture::new("clean");
        let mut config = fixture.config();
        config.set(
            "poll",
            json!({
                "command": "  ",
                "chartType": "neon",
                "options": [
                    { "id": "a", "label": "Да" },
                    { "id": 2, "label": "Нет" },
                    { "label": "Без id" },
                ],
            }),
        );

        let poll = poll_config(&config);
        assert_eq!(poll["command"], json!("!poll"));
        assert_eq!(poll["chartType"], json!("bars"));
        assert_eq!(poll["options"], json!([{ "id": "a", "label": "Да" }]));
    }

    #[test]
    fn poll_settings_survive_a_restart() {
        let fixture = Fixture::new("restart");
        let mut config = fixture.config();
        let db = fixture.db();
        let mut runtime = runtime();

        set_poll_config(
            &mut runtime,
            &mut config,
            &db,
            &json!({ "command": "!vote", "chartType": "pie" }),
        );
        add_poll_option(&mut runtime, &mut config, &db, &json!("Да"));
        config.save_sync();

        // Новый экземпляр читает конфиг с диска — как при следующем запуске.
        let reopened = fixture.config();
        let poll = poll_config(&reopened);
        assert_eq!(poll["command"], json!("!vote"));
        assert_eq!(poll["chartType"], json!("pie"));
        let labels: Vec<&str> = poll["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|option| option["label"].as_str().unwrap())
            .collect();
        assert_eq!(labels, ["Да"]);
    }

    #[test]
    fn saving_loading_and_deleting_a_preset() {
        let fixture = Fixture::new("presets");
        let (mut runtime, mut config, db) = poll_with_two_options(&fixture);

        let saved = save_poll_preset(&db, &config, &json!({ "name": "  Опрос недели  " }), 1_000)
            .expect("пресет сохранён");
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0]["name"], json!("Опрос недели"));
        assert_eq!(saved[0]["command"], json!("!vote"));
        assert_eq!(saved[0]["chartType"], json!("pie"));
        assert_eq!(saved[0]["optionCount"], json!(2));
        let id = saved[0]["id"].clone();

        // Меняем конфигурацию, затем возвращаем её из пресета.
        set_poll_config(
            &mut runtime,
            &mut config,
            &db,
            &json!({ "command": "!poll", "chartType": "bars", "options": [] }),
        );
        let applied = apply_poll_preset(&mut runtime, &mut config, &db, &id).expect("пресет есть");
        assert_eq!(applied["command"], json!("!vote"));
        assert_eq!(applied["chartType"], json!("pie"));
        assert_eq!(applied["options"].as_array().unwrap().len(), 2);

        let deleted = delete_poll_preset(&db, &id).expect("пресет удалён");
        assert!(deleted.is_empty());
        assert!(apply_poll_preset(&mut runtime, &mut config, &db, &id).is_none());
    }

    #[test]
    fn rewriting_a_preset_by_id_does_not_duplicate_it() {
        let fixture = Fixture::new("rewrite");
        let (mut runtime, mut config, db) = poll_with_two_options(&fixture);

        let created =
            save_poll_preset(&db, &config, &json!({ "name": "Опрос" }), 1_000).expect("создан");
        let id = created[0]["id"].clone();

        set_poll_config(
            &mut runtime,
            &mut config,
            &db,
            &json!({
                "command": "!go",
                "chartType": "pie",
                "options": [{ "id": "a", "label": "Раз" }, { "id": "b", "label": "Два" }],
            }),
        );
        let updated = save_poll_preset(
            &db,
            &config,
            &json!({ "id": id, "name": "Опрос v2" }),
            2_000,
        )
        .expect("обновлён");

        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0]["id"], id);
        assert_eq!(updated[0]["name"], json!("Опрос v2"));
        assert_eq!(updated[0]["optionCount"], json!(2));
    }

    #[test]
    fn a_preset_without_a_name_is_not_saved() {
        let fixture = Fixture::new("noname");
        let config = fixture.config();
        let db = fixture.db();
        assert!(save_poll_preset(&db, &config, &json!({ "name": "   " }), 0).is_none());
    }

    #[test]
    fn voting_counts_and_validates_options() {
        let fixture = Fixture::new("voting");
        let (mut runtime, mut config, db) = poll_with_two_options(&fixture);

        start_poll(&mut runtime, &mut config, &db, &json!(""));
        assert!(runtime.poll_active());

        // За неизвестный пункт и от неактивного опроса голос не идёт.
        assert!(vote_poll(&mut runtime, &config, &json!("alice"), &json!("нет")).is_none());
        let snapshot = vote_poll(&mut runtime, &config, &json!("alice"), &json!("a")).unwrap();
        vote_poll(&mut runtime, &config, &json!("bob"), &json!("a")).unwrap();
        // Повторный голос переписывает прежний.
        let snapshot2 = vote_poll(&mut runtime, &config, &json!("bob"), &json!("b")).unwrap();
        assert_eq!(snapshot["votes"], json!({ "a": 1 }));
        assert_eq!(snapshot2["votes"], json!({ "a": 1, "b": 1 }));
        assert_eq!(snapshot2["total"], json!(2));

        // Остановка опроса запрещает голосовать.
        stop_poll(&mut runtime, &config);
        assert!(vote_poll(&mut runtime, &config, &json!("carol"), &json!("a")).is_none());
    }

    #[test]
    fn removing_an_option_drops_its_votes() {
        let fixture = Fixture::new("remove");
        let (mut runtime, mut config, db) = poll_with_two_options(&fixture);
        start_poll(&mut runtime, &mut config, &db, &json!(""));
        vote_poll(&mut runtime, &config, &json!("alice"), &json!("a")).unwrap();
        vote_poll(&mut runtime, &config, &json!("bob"), &json!("b")).unwrap();

        let snapshot = remove_poll_option(&mut runtime, &mut config, &db, &json!("a"));
        assert_eq!(snapshot["options"], json!([{ "id": "b", "label": "Нет" }]));
        assert_eq!(snapshot["votes"], json!({ "b": 1 }));
        assert_eq!(snapshot["total"], json!(1));
    }

    #[test]
    fn the_chat_command_understands_the_option_number() {
        let fixture = Fixture::new("chat");
        let (mut runtime, mut config, db) = poll_with_two_options(&fixture);
        start_poll(&mut runtime, &mut config, &db, &json!("!vote"));

        assert!(
            handle_poll_chat(&mut runtime, &config, &json!("alice"), &json!("!vote")).is_none()
        );
        assert!(
            handle_poll_chat(&mut runtime, &config, &json!("alice"), &json!("!vote 3")).is_none()
        );
        assert!(
            handle_poll_chat(&mut runtime, &config, &json!("alice"), &json!("!vote 0")).is_none()
        );
        // Второй пункт.
        let snapshot =
            handle_poll_chat(&mut runtime, &config, &json!("alice"), &json!(" !VOTE 2 ")).unwrap();
        assert_eq!(snapshot["votes"], json!({ "b": 1 }));
    }

    #[test]
    fn test_votes_are_capped_and_need_options() {
        let fixture = Fixture::new("test-votes");
        let (mut runtime, mut config, db) = poll_with_two_options(&fixture);

        // Нет вариантов — накидывать нечего.
        set_poll_config(&mut runtime, &mut config, &db, &json!({ "options": [] }));
        assert!(test_poll_votes(&mut runtime, &config, &json!(5)).is_none());

        let (mut runtime, config, _db) = poll_with_two_options(&fixture);
        let snapshot = test_poll_votes(&mut runtime, &config, &json!(5)).unwrap();
        assert_eq!(snapshot["total"], json!(5));
        // Пустой счёт даёт 12, но с двумя пунктами они делятся 3/2.
        let snapshot = test_poll_votes(&mut runtime, &config, &Value::Null).unwrap();
        assert_eq!(snapshot["total"], json!(12));
    }

    #[test]
    fn clearing_options_clears_votes_too() {
        let fixture = Fixture::new("clear");
        let (mut runtime, mut config, db) = poll_with_two_options(&fixture);
        start_poll(&mut runtime, &mut config, &db, &json!(""));
        vote_poll(&mut runtime, &config, &json!("alice"), &json!("a")).unwrap();

        let snapshot = clear_poll_options(&mut runtime, &mut config, &db);
        assert_eq!(snapshot["options"], json!([]));
        assert_eq!(snapshot["total"], json!(0));
    }
}
