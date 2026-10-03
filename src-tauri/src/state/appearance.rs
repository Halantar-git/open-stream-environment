//! Внешний вид: темы, свои темы, настройки редактора и HUD.
//!
//! Порт части `server/state.js`: `_migrateAppearance`, `resolveTheme`,
//! `resolvedTheme`/`resolvedTheme3d`, `_active3dWidgets`, `listThemes`,
//! `_defaultEnable3d`, `setActiveTheme`, `setEnabled3dWidget`,
//! `saveCustomTheme`/`deleteCustomTheme`/`duplicateCustomTheme`,
//! `setEditorPrefs` и сеттеры HUD (`setHudHotkey`, `setHudDisplay`,
//! `setChatHudHotkey`, `setChatHudDisplay`, `setChatHudConfig`).
//!
//! Тема — это «семейство»: выбранная базовая тема плюс необязательный 3D-вариант,
//! включаемый флагом `enable3d` (`resolvedTheme3d`). Токены считает движок
//! (`theme_engine`), здесь — выбор, миграция старых форм и хранение.
//!
//! Отличие от JS одно и то же во всех перенесённых частях: там конструктор держит
//! `this.config.appearance` уже нормализованным и правит его на месте; здесь
//! настройки читаются и пишутся через [`ConfigFile`], а нормализация старых форм
//! вынесена в [`migrate_appearance`] — её должен позвать тот, кто открывает
//! настройки при запуске.

use serde_json::{json, Map, Value};

use crate::catalog;
use crate::state::{find_custom_theme, js_string, string_trim};
use crate::storage::config_file::ConfigFile;
use crate::storage::history::{js_number, js_number_or_zero, js_truthy, number_value};
use crate::theme_engine::{self, SCHEMES, SHAPE_MODES};
use crate::themes;

/// Допустимые пропорции холста в редакторе — как `EDITOR_ASPECT_RATIOS`.
const EDITOR_ASPECT_RATIOS: [&str; 8] =
    ["16:9", "16:10", "21:9", "32:9", "4:3", "1:1", "9:16", "3:4"];

/// Внешний вид по умолчанию — как `defaultAppearance()`.
pub(crate) fn default_appearance() -> Map<String, Value> {
    let mut appearance = Map::new();
    appearance.insert("activeThemeId".to_string(), Value::from("nebula"));
    appearance.insert("enable3d".to_string(), Value::Bool(false));
    appearance.insert("customThemes".to_string(), Value::Array(Vec::new()));
    appearance
}

/// Внешний вид по умолчанию для редактора — как `defaultEditor()`.
pub(crate) fn default_editor() -> Map<String, Value> {
    json!({ "gridSize": 5, "snapEnabled": true, "aspectRatio": "16:9" })
        .as_object()
        .cloned()
        .expect("объект")
}

/// Нормализованный внешний вид: сюда же сводятся старые формы.
///
/// Повторяет `_migrateAppearance` вместе с проверками конструктора. Чистая
/// функция: пишет [`migrate_appearance`], а читающие вызовы просто получают
/// готовую форму, не трогая файл.
pub fn appearance_config(config: &ConfigFile) -> Map<String, Value> {
    migrated_appearance(config.get("appearance"))
}

/// Привести внешний вид в настройках к текущей форме и вернуть его.
///
/// Вызывается при открытии настроек — как конструктор `state.js`.
pub fn migrate_appearance(config: &mut ConfigFile) -> Map<String, Value> {
    let appearance = migrated_appearance(config.get("appearance"));
    config.set("appearance", Value::Object(appearance.clone()));
    appearance
}

fn migrated_appearance(raw: Option<&Value>) -> Map<String, Value> {
    let mut appearance = match raw.and_then(Value::as_object) {
        Some(map) => map.clone(),
        None => default_appearance(),
    };
    if !appearance.get("customThemes").is_some_and(Value::is_array) {
        appearance.insert("customThemes".to_string(), Value::Array(Vec::new()));
    }

    // Старая форма до 2.3.1: один `activeThemeId` (иногда — 3D-вариант).
    let single = appearance
        .get("activeThemeId")
        .is_some_and(|value| js_truthy(Some(value)));
    let has_slots = appearance.contains_key("activeThemeId2d")
        || appearance.contains_key("activeThemeId3d")
        || appearance.contains_key("enable3d");
    if single && !has_slots {
        let id = appearance
            .get("activeThemeId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if is_variant(&id) || builtin_dimension(&id).as_deref() == Some("3d") {
            appearance.insert("enable3d".to_string(), Value::Bool(true));
        }
        if is_variant(&id) {
            if let Some(base) = base_2d(&id) {
                appearance.insert("activeThemeId".to_string(), Value::from(base));
            }
        }
    }

    // Двухслотовая форма 2.3.1–2.x: `activeThemeId2d` + `activeThemeId3d`.
    let slot_2d = appearance
        .get("activeThemeId2d")
        .is_some_and(|value| js_truthy(Some(value)));
    let slot_3d = appearance
        .get("activeThemeId3d")
        .is_some_and(|value| js_truthy(Some(value)));
    if slot_2d || slot_3d {
        let id_2d =
            truthy_string(appearance.get("activeThemeId2d")).unwrap_or_else(|| "nebula".into());
        let id_3d = truthy_string(appearance.get("activeThemeId3d")).unwrap_or_default();
        if id_3d.is_empty() {
            appearance.insert("activeThemeId".to_string(), Value::from(id_2d));
            appearance.insert("enable3d".to_string(), Value::Bool(false));
        } else {
            let base = base_2d(&id_3d).unwrap_or(id_2d);
            appearance.insert("activeThemeId".to_string(), Value::from(base));
            appearance.insert("enable3d".to_string(), Value::Bool(true));
        }
        appearance.remove("activeThemeId2d");
        appearance.remove("activeThemeId3d");
    }

    // Страховка: затесавшийся 3D-вариант возвращается к базовой теме.
    if let Some(id) = truthy_string(appearance.get("activeThemeId")) {
        if is_variant(&id) {
            if let Some(base) = base_2d(&id) {
                appearance.insert("activeThemeId".to_string(), Value::from(base));
            }
            appearance.insert("enable3d".to_string(), Value::Bool(true));
        }
    }

    if !appearance
        .get("activeThemeId")
        .is_some_and(|value| js_truthy(Some(value)))
    {
        appearance.insert("activeThemeId".to_string(), Value::from("nebula"));
    }
    if !appearance.get("enable3d").is_some_and(Value::is_boolean) {
        appearance.insert("enable3d".to_string(), Value::Bool(false));
    }
    // В конструкторе это отдельная проверка после миграции — здесь она рядом.
    if !appearance.get("enabled3d").is_some_and(Value::is_object) {
        appearance.insert("enabled3d".to_string(), Value::Object(Map::new()));
    }
    appearance
}

/// Тема по идентификатору: встроенная как есть, своя — собранная в форму панели.
pub fn resolve_theme(config: &ConfigFile, id: &str) -> Option<Value> {
    if let Some(theme) = themes::builtin_theme(id) {
        return Some(theme.clone());
    }
    let custom = find_custom_theme(config, id)?;
    let seeds = custom.get("seeds");
    Some(json!({
        "id": custom.get("id").cloned().unwrap_or(Value::Null),
        "name": custom.get("name").cloned().unwrap_or(Value::Null),
        "builtin": false,
        "tokens": custom.get("tokens").cloned().unwrap_or_else(|| json!({})),
        "customCss": seeds
            .and_then(|seeds| seeds.get("customCss"))
            .filter(|value| js_truthy(Some(value)))
            .cloned()
            .unwrap_or_else(|| Value::from("")),
        "threeDWidgets": seeds
            .and_then(|seeds| seeds.get("threeDWidgets"))
            .filter(|value| js_truthy(Some(value)))
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    }))
}

/// Базовая тема для глобальных токенов; при отсутствии выбора — `nebula`.
pub fn resolved_theme(config: &ConfigFile) -> Value {
    let id = active_theme_id(config);
    resolve_theme(config, &id).unwrap_or_else(|| {
        themes::builtin_theme("nebula")
            .cloned()
            .expect("встроенная тема nebula")
    })
}

/// Активный 3D-вариант выбранной темы или `None`, если 3D выключен/его нет.
pub fn resolved_theme_3d(config: &ConfigFile) -> Option<Value> {
    if !appearance_config(config)
        .get("enable3d")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let base = resolved_theme(config);
    if !base
        .get("builtin")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let variant = base.get("variant3d").and_then(Value::as_str)?;
    resolve_theme(config, variant)
}

/// Явный список включённых 3D-виджетов под текущей темой.
///
/// У встроенных тем он выводится из активного варианта минус выключенные фишки,
/// у своих тем — из собственного списка (можно смешивать стили).
pub fn active_3d_widgets(
    config: &ConfigFile,
    theme_2d: &Value,
    theme_3d: Option<&Value>,
    is_custom_base: bool,
) -> Vec<String> {
    let appearance = appearance_config(config);
    if !appearance
        .get("enable3d")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Vec::new();
    }

    if is_custom_base {
        return theme_2d
            .get("threeDWidgets")
            .and_then(Value::as_array)
            .map(|types| {
                types
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|kind| is_three_d_widget(kind))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
    }

    let Some(theme_3d) = theme_3d else {
        return Vec::new();
    };
    let enabled = appearance.get("enabled3d").and_then(Value::as_object);
    let theme_id = theme_3d
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    catalog::widgets_for_theme(theme_id)
        .iter()
        .filter(|widget| {
            let kind = widget
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            enabled
                .and_then(|enabled| enabled.get(kind))
                .and_then(Value::as_bool)
                != Some(false)
        })
        .filter_map(|widget| {
            widget
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

/// Темы для панели: сначала встроенные, затем свои.
pub fn list_themes(config: &ConfigFile) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();

    for id in themes::builtin_ids() {
        let Some(theme) = themes::builtin_theme(id) else {
            continue;
        };
        // 3D-варианты (grimhex/cobra-mk2) — не самостоятельные темы.
        if theme
            .get("variant")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let tokens = theme.get("tokens");
        let color = |key: &str| {
            tokens
                .and_then(|tokens| tokens.get(key))
                .cloned()
                .unwrap_or(Value::Null)
        };
        out.push(json!({
            "id": theme.get("id").cloned().unwrap_or(Value::Null),
            "name": theme.get("name").cloned().unwrap_or(Value::Null),
            "builtin": true,
            "category": theme.get("category").cloned().unwrap_or_else(|| Value::from("system")),
            "dimension": theme.get("dimension").cloned().unwrap_or_else(|| Value::from("2d")),
            "has3d": theme.get("variant3d").is_some_and(|value| js_truthy(Some(value))),
            "variant3d": theme
                .get("variant3d")
                .filter(|value| js_truthy(Some(value)))
                .cloned()
                .unwrap_or(Value::Null),
            "colors": [color("--md-primary"), color("--md-secondary"), color("--md-tertiary")],
        }));
    }

    if let Some(custom) = appearance_config(config)
        .get("customThemes")
        .and_then(Value::as_array)
    {
        for theme in custom {
            let seeds = theme.get("seeds");
            let seed = |key: &str| {
                seeds
                    .and_then(|seeds| seeds.get(key))
                    .filter(|value| js_truthy(Some(value)))
                    .cloned()
                    .unwrap_or_else(|| Value::from("#888888"))
            };
            let three_d = seeds
                .and_then(|seeds| seeds.get("threeDWidgets"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            out.push(json!({
                "id": theme.get("id").cloned().unwrap_or(Value::Null),
                "name": theme.get("name").cloned().unwrap_or(Value::Null),
                "builtin": false,
                "category": "custom",
                "dimension": "2d",
                "has3d": !three_d.is_empty(),
                "threeDWidgets": three_d,
                "seeds": seeds.cloned().unwrap_or(Value::Null),
                "colors": [seed("primary"), seed("secondary"), seed("tertiary")],
            }));
        }
    }

    out
}

/// Выбрать тему. Пустой идентификатор выключает 3D, не меняя тему.
///
/// `false` — темы с таким идентификатором нет.
pub fn set_active_theme(config: &mut ConfigFile, id: &Value, enable3d: Option<bool>) -> bool {
    let mut appearance = appearance_config(config);

    if !js_truthy(Some(id)) {
        appearance.insert("enable3d".to_string(), Value::Bool(false));
        write_appearance(config, &appearance);
        return true;
    }

    let id_text = js_string(id);
    let Some(theme) = resolve_theme(config, &id_text) else {
        return false;
    };
    let builtin = theme
        .get("builtin")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let variant = theme
        .get("variant")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if builtin && variant {
        // Идентификатор 3D-варианта выбирает базовую тему плюс 3D.
        let base = theme
            .get("base2d")
            .and_then(Value::as_str)
            .unwrap_or(id_text.as_str())
            .to_string();
        appearance.insert("activeThemeId".to_string(), Value::from(base));
        appearance.insert("enable3d".to_string(), Value::Bool(true));
    } else {
        let theme_id = theme
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(id_text.as_str())
            .to_string();
        appearance.insert("activeThemeId".to_string(), Value::from(theme_id.clone()));
        let requested = enable3d.unwrap_or_else(|| default_enable_3d(&theme_id));
        let has_3d = if builtin {
            theme
                .get("variant3d")
                .is_some_and(|value| js_truthy(Some(value)))
        } else {
            theme
                .get("threeDWidgets")
                .and_then(Value::as_array)
                .is_some_and(|types| !types.is_empty())
        };
        // 3D нельзя включить у темы без 3D-набора виджетов.
        appearance.insert("enable3d".to_string(), Value::Bool(requested && has_3d));
    }

    write_appearance(config, &appearance);
    true
}

/// Включить/выключить отдельную 3D-фишку; храним только выключенные.
pub fn set_enabled_3d_widget(
    config: &mut ConfigFile,
    kind: &Value,
    enabled: bool,
) -> Option<Value> {
    let clean = string_trim(kind);
    if clean.is_empty() {
        return None;
    }
    let mut appearance = appearance_config(config);
    let mut enabled_map = appearance
        .get("enabled3d")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if enabled {
        enabled_map.remove(&clean);
    } else {
        enabled_map.insert(clean, Value::Bool(false));
    }
    let value = Value::Object(enabled_map);
    appearance.insert("enabled3d".to_string(), value.clone());
    write_appearance(config, &appearance);
    Some(value)
}

/// Сохранить свою тему: обновить по `id` или создать новую.
pub fn save_custom_theme(config: &mut ConfigFile, patch: &Value) -> Value {
    // Кадр может прийти без seeds (или с не-объектом): без приведения к объекту
    // обращение к `seeds.primary` бросило бы исключение и уронило сервер.
    let seeds = patch
        .get("seeds")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let seeds = normalize_seeds(&seeds);

    let mut appearance = appearance_config(config);
    let mut custom = appearance
        .get("customThemes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let name = match patch.get("name").filter(|value| js_truthy(Some(value))) {
        Some(name) => js_string(name).chars().take(40).collect::<String>(),
        None => "Моя тема".to_string(),
    };

    // Токены считаем до того, как семена уедут в тему — иначе после переноса
    // значения в объект брать его в долг уже нельзя.
    let tokens = theme_engine::build_theme_tokens(&seeds);

    let existing = patch
        .get("id")
        .filter(|value| js_truthy(Some(value)))
        .map(js_string)
        .and_then(|id| {
            custom
                .iter()
                .position(|theme| theme.get("id").and_then(Value::as_str) == Some(id.as_str()))
        });

    let theme = match existing {
        Some(index) => {
            let object = custom[index].as_object_mut().expect("своя тема — объект");
            object.insert("name".to_string(), Value::from(name));
            object.insert("seeds".to_string(), seeds);
            object.insert("tokens".to_string(), tokens);
            custom[index].clone()
        }
        None => {
            let theme = json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "name": name,
                "seeds": seeds,
                "tokens": tokens,
            });
            custom.push(theme.clone());
            theme
        }
    };

    appearance.insert("customThemes".to_string(), Value::Array(custom));
    write_appearance(config, &appearance);
    theme
}

/// Удалить свою тему; `true` — что-то удалили.
pub fn delete_custom_theme(config: &mut ConfigFile, id: &Value) -> bool {
    let mut appearance = appearance_config(config);
    let custom = appearance
        .get("customThemes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let before = custom.len();
    let filtered: Vec<Value> = custom
        .into_iter()
        .filter(|theme| theme.get("id") != Some(id))
        .collect();
    let changed = filtered.len() != before;

    appearance.insert("customThemes".to_string(), Value::Array(filtered));
    if appearance.get("activeThemeId") == Some(id) {
        appearance.insert("activeThemeId".to_string(), Value::from("nebula"));
    }
    write_appearance(config, &appearance);
    changed
}

/// Скопировать свою тему с новым идентификатором; `None` — исходной нет.
pub fn duplicate_custom_theme(config: &mut ConfigFile, id: &Value) -> Option<Value> {
    let source = find_custom_theme(config, &js_string(id))?;
    let name = format!(
        "{} (копия)",
        source
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(36)
            .collect::<String>()
    );
    let copy = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "name": name,
        "seeds": source.get("seeds").cloned().unwrap_or_else(|| json!({})),
        "tokens": source.get("tokens").cloned().unwrap_or_else(|| json!({})),
    });

    let mut appearance = appearance_config(config);
    let mut custom = appearance
        .get("customThemes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    custom.push(copy.clone());
    appearance.insert("customThemes".to_string(), Value::Array(custom));
    write_appearance(config, &appearance);
    Some(copy)
}

/// Настройки редактора: сетка, привязка, пропорции.
pub fn set_editor_prefs(config: &mut ConfigFile, patch: &Value) -> Value {
    let mut editor = config
        .get("editor")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(default_editor);

    if let Some(grid) = patch.get("gridSize").and_then(Value::as_f64) {
        editor.insert("gridSize".to_string(), number_value(clamp(grid, 0.0, 25.0)));
    }
    if let Some(snap) = patch.get("snapEnabled").and_then(Value::as_bool) {
        editor.insert("snapEnabled".to_string(), Value::Bool(snap));
    }
    if let Some(ratio) = patch.get("aspectRatio").and_then(Value::as_str) {
        if EDITOR_ASPECT_RATIOS.contains(&ratio) {
            editor.insert("aspectRatio".to_string(), Value::from(ratio));
        }
    }

    let editor = Value::Object(editor);
    config.set("editor", editor.clone());
    config.save();
    editor
}

pub fn set_hud_hotkey(config: &mut ConfigFile, hotkey: &Value) -> Value {
    let cleaned = hotkey.as_str().map(str::trim).unwrap_or_default();
    let value = if cleaned.is_empty() {
        "Control+Shift+H"
    } else {
        cleaned
    };
    config.set("hud_edit_hotkey", Value::from(value));
    config.save();
    Value::from(value)
}

pub fn set_hud_display(config: &mut ConfigFile, display_id: &Value) -> Value {
    let value = display_or_null(display_id);
    config.set("hud_display_id", value.clone());
    config.save();
    value
}

pub fn set_chat_hud_hotkey(config: &mut ConfigFile, hotkey: &Value) -> Value {
    let cleaned = hotkey.as_str().map(str::trim).unwrap_or_default();
    let value = if cleaned.is_empty() {
        "Control+Shift+L"
    } else {
        cleaned
    };
    config.set("chat_hud_hotkey", Value::from(value));
    config.save();
    Value::from(value)
}

pub fn set_chat_hud_display(config: &mut ConfigFile, display_id: &Value) -> Value {
    let value = display_or_null(display_id);
    config.set("chat_hud_display_id", value.clone());
    config.save();
    value
}

/// Размеры и положение окна чата поверх игры.
pub fn set_chat_hud_config(config: &mut ConfigFile, patch: &Value) -> Value {
    let current = config
        .get("chatHud")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let fallback =
        |key: &str, default: f64| current.get(key).and_then(Value::as_f64).unwrap_or(default);
    let clamp_num = |key: &str, min: f64, max: f64, default: f64| {
        let number = js_number(patch.get(key));
        if number.is_finite() {
            number.min(max).max(min)
        } else {
            fallback(key, default)
        }
    };
    let coordinate = |key: &str| -> Value {
        match patch.get(key) {
            None => Value::Null,
            Some(value) if value.is_null() || value.as_str() == Some("") => Value::Null,
            Some(value) => {
                let number = js_number(Some(value));
                if number.is_finite() {
                    number_value(number)
                } else {
                    Value::Null
                }
            }
        }
    };

    let next = json!({
        "width": number_value(clamp_num("width", 240.0, 1200.0, 360.0)),
        "height": number_value(clamp_num("height", 160.0, 2000.0, 560.0)),
        "x": coordinate("x"),
        "y": coordinate("y"),
        "opacity": number_value(clamp_num("opacity", 0.0, 100.0, 70.0)),
        "fontSize": number_value(clamp_num("fontSize", 10.0, 48.0, 14.0)),
    });
    config.set("chatHud", next.clone());
    config.save();
    next
}

// ---- Внутреннее ----

fn write_appearance(config: &mut ConfigFile, appearance: &Map<String, Value>) {
    config.set("appearance", Value::Object(appearance.clone()));
    config.save();
}

/// Идентификатор активной темы (после нормализации).
fn active_theme_id(config: &ConfigFile) -> String {
    appearance_config(config)
        .get("activeThemeId")
        .and_then(Value::as_str)
        .unwrap_or("nebula")
        .to_string()
}

/// Встроенная тема включает 3D по умолчанию, только если она сама 3D.
fn default_enable_3d(id: &str) -> bool {
    builtin_dimension(id).as_deref() == Some("3d")
}

fn builtin_dimension(id: &str) -> Option<String> {
    themes::builtin_theme(id)
        .and_then(|theme| theme.get("dimension"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn is_variant(id: &str) -> bool {
    themes::builtin_theme(id)
        .and_then(|theme| theme.get("variant"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn base_2d(id: &str) -> Option<String> {
    themes::builtin_theme(id)
        .and_then(|theme| theme.get("base2d"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// 3D-виджет ли это — по каталогу, а не по имени.
fn is_three_d_widget(kind: &str) -> bool {
    catalog::def(kind)
        .and_then(|def| def.get("dimension"))
        .and_then(Value::as_str)
        == Some("3d")
}

/// `String(value)` для правдивого значения; `None` — значение ложно.
fn truthy_string(value: Option<&Value>) -> Option<String> {
    value.filter(|value| js_truthy(Some(value))).map(js_string)
}

fn display_or_null(display_id: &Value) -> Value {
    if display_id.is_null() || display_id.as_str() == Some("") {
        Value::Null
    } else {
        Value::from(js_string(display_id))
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.min(max).max(min)
}

/// Очистка семян своей темы — порт `cleanSeeds` из `saveCustomTheme`.
fn normalize_seeds(src: &Map<String, Value>) -> Value {
    let text = |key: &str| -> String {
        let value = src.get(key);
        if !js_truthy(value) {
            return String::new();
        }
        js_string(value.unwrap()).trim().to_string()
    };
    let pick = |key: &str, default: &str| -> Value {
        match src.get(key) {
            Some(value) if js_truthy(Some(value)) => value.clone(),
            _ => Value::from(default),
        }
    };

    let primary = pick("primary", "#c6b8ff");
    let surface_seed = match src.get("surfaceSeed") {
        Some(value) if js_truthy(Some(value)) => value.clone(),
        _ => match src.get("primary") {
            Some(value) if js_truthy(Some(value)) => value.clone(),
            _ => Value::from("#8878c8"),
        },
    };

    let mode = match src.get("mode").and_then(Value::as_str) {
        Some(mode) if SCHEMES.contains(&mode) => Value::from(mode),
        _ => Value::from("dark"),
    };
    let shape_mode = match src.get("shapeMode").and_then(Value::as_str) {
        Some(mode) if SHAPE_MODES.contains(&mode) => Value::from(mode),
        _ => Value::from("rounded"),
    };
    let font_preset = if src.get("fontPreset").and_then(Value::as_str) == Some("orbital") {
        Value::from("orbital")
    } else {
        Value::from("nebula")
    };

    let panel_opacity = match src.get("panelOpacity") {
        None => Value::from(""),
        Some(value) if value.is_null() || value.as_str() == Some("") => Value::from(""),
        Some(value) => number_value(clamp(js_number_or_zero(Some(value)), 0.0, 100.0)),
    };
    let alert_duration = match src.get("alertEnterDuration") {
        None => Value::from(""),
        Some(value) if value.is_null() || value.as_str() == Some("") => Value::from(""),
        Some(value) => number_value(clamp(js_number_or_zero(Some(value)).round(), 0.0, 2000.0)),
    };
    let alert_easing = src
        .get("alertEnterEasing")
        .and_then(Value::as_str)
        .filter(|key| theme_engine::alert_easing(key).is_some())
        .map(Value::from)
        .unwrap_or_else(|| Value::from(""));

    let mut seeds = Map::new();
    seeds.insert("primary".to_string(), primary);
    seeds.insert("secondary".to_string(), pick("secondary", "#7ee0d6"));
    seeds.insert("tertiary".to_string(), pick("tertiary", "#ffb0d8"));
    seeds.insert("surfaceSeed".to_string(), surface_seed);
    seeds.insert("mode".to_string(), mode);
    seeds.insert("shapeMode".to_string(), shape_mode);
    seeds.insert("fontPreset".to_string(), font_preset);
    seeds.insert("fontDisplay".to_string(), Value::from(text("fontDisplay")));
    seeds.insert("fontBody".to_string(), Value::from(text("fontBody")));
    seeds.insert("fontMono".to_string(), Value::from(text("fontMono")));
    seeds.insert("panelRadius".to_string(), Value::from(text("panelRadius")));
    seeds.insert(
        "panelBorderWidth".to_string(),
        Value::from(text("panelBorderWidth")),
    );
    seeds.insert(
        "panelBorderStyle".to_string(),
        Value::from(text("panelBorderStyle")),
    );
    seeds.insert(
        "panelBorderColor".to_string(),
        Value::from(text("panelBorderColor")),
    );
    seeds.insert(
        "panelGlowColor".to_string(),
        Value::from(text("panelGlowColor")),
    );
    seeds.insert(
        "panelGlowStrength".to_string(),
        number_value(clamp(
            js_number_or_zero(src.get("panelGlowStrength")),
            0.0,
            100.0,
        )),
    );
    seeds.insert("background".to_string(), Value::from(text("background")));
    seeds.insert("text".to_string(), Value::from(text("text")));
    seeds.insert("panelOpacity".to_string(), panel_opacity);
    seeds.insert("panelBlur".to_string(), Value::from(text("panelBlur")));
    seeds.insert(
        "error".to_string(),
        if is_hex_color(&text("error")) {
            Value::from(text("error"))
        } else {
            Value::from("")
        },
    );
    seeds.insert("alertEnterDuration".to_string(), alert_duration);
    seeds.insert("alertEnterEasing".to_string(), alert_easing);
    seeds.insert(
        "threeDWidgets".to_string(),
        Value::Array(normalize_three_d_widgets(src)),
    );
    // customCss не обрезается — в нём значимы и пробелы.
    seeds.insert(
        "customCss".to_string(),
        Value::from(match src.get("customCss") {
            Some(value) if js_truthy(Some(value)) => js_string(value),
            _ => String::new(),
        }),
    );
    Value::Object(seeds)
}

/// Явный список 3D-виджетов темы: чистится от мусора и дублей.
///
/// Старые темы хранили `variant3d` — тогда список берётся из виджетов варианта,
/// как в `normalizeThreeDWidgets`.
fn normalize_three_d_widgets(src: &Map<String, Value>) -> Vec<Value> {
    let raw: Vec<Value> = if let Some(list) = src.get("threeDWidgets").and_then(Value::as_array) {
        list.clone()
    } else if let Some(variant) = src.get("variant3d").and_then(Value::as_str) {
        catalog::widgets_for_theme(variant)
            .iter()
            .filter_map(|widget| widget.get("type").cloned())
            .collect()
    } else {
        Vec::new()
    };

    let mut out: Vec<Value> = Vec::new();
    for item in raw {
        let kind = string_trim(&item);
        if is_three_d_widget(&kind) && !out.iter().any(|existing| existing.as_str() == Some(&kind))
        {
            out.push(Value::from(kind));
        }
    }
    out
}

/// `^#[0-9a-f]{6}$` без регистра — цвет ошибки принимается только таким.
fn is_hex_color(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
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
            let dir = std::env::temp_dir().join(format!(
                "ose-appearance-{}-{label}-{index}",
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

    fn appearance(config: &ConfigFile) -> Value {
        config.get("appearance").cloned().unwrap_or(Value::Null)
    }

    #[test]
    fn theme_and_3d_variant_are_controlled_by_active_theme_and_flag() {
        let fixture = Fixture::new("3d");
        let mut config = fixture.config();
        migrate_appearance(&mut config);

        assert!(set_active_theme(&mut config, &json!("orbital"), None));
        assert_eq!(appearance(&config)["activeThemeId"], json!("orbital"));
        assert_eq!(appearance(&config)["enable3d"], json!(false));
        assert_eq!(
            resolved_theme(&config)["tokens"],
            themes::builtin_theme("orbital").unwrap()["tokens"]
        );
        assert!(resolved_theme_3d(&config).is_none());

        assert!(set_active_theme(&mut config, &json!("orbital"), Some(true)));
        assert_eq!(appearance(&config)["activeThemeId"], json!("orbital"));
        assert_eq!(appearance(&config)["enable3d"], json!(true));
        // При включённом 3D его токены перекрывают базовые.
        let variant = resolved_theme_3d(&config).expect("3D-вариант");
        assert_eq!(variant["id"], json!("grimhex"));
        assert_eq!(
            variant["tokens"],
            themes::builtin_theme("grimhex").unwrap()["tokens"]
        );
    }

    #[test]
    fn selecting_a_3d_variant_id_selects_the_base_theme_and_3d() {
        let fixture = Fixture::new("variant");
        let mut config = fixture.config();
        migrate_appearance(&mut config);

        assert!(set_active_theme(&mut config, &json!("grimhex"), None));
        assert_eq!(appearance(&config)["activeThemeId"], json!("orbital"));
        assert_eq!(appearance(&config)["enable3d"], json!(true));
    }

    #[test]
    fn an_empty_theme_id_disables_3d_but_keeps_the_theme() {
        let fixture = Fixture::new("empty");
        let mut config = fixture.config();
        migrate_appearance(&mut config);

        set_active_theme(&mut config, &json!("orbital"), Some(true));
        assert_eq!(appearance(&config)["enable3d"], json!(true));

        assert!(set_active_theme(&mut config, &json!(""), Some(true)));
        assert_eq!(appearance(&config)["enable3d"], json!(false));
        assert_eq!(appearance(&config)["activeThemeId"], json!("orbital"));
    }

    #[test]
    fn a_theme_that_does_not_exist_is_refused() {
        let fixture = Fixture::new("missing");
        let mut config = fixture.config();
        migrate_appearance(&mut config);
        assert!(!set_active_theme(&mut config, &json!("nope"), None));
    }

    #[test]
    fn a_legacy_single_3d_id_migrates_to_theme_plus_flag() {
        let fixture = Fixture::new("legacy-single");
        let mut config = fixture.config();
        config.set(
            "appearance",
            json!({ "activeThemeId": "grimhex", "customThemes": [] }),
        );

        migrate_appearance(&mut config);
        assert_eq!(appearance(&config)["activeThemeId"], json!("orbital"));
        assert_eq!(appearance(&config)["enable3d"], json!(true));
    }

    #[test]
    fn a_legacy_two_slot_appearance_migrates() {
        let fixture = Fixture::new("legacy-slots");
        let mut config = fixture.config();
        config.set(
            "appearance",
            json!({ "activeThemeId2d": "elite", "activeThemeId3d": "cobra-mk2", "customThemes": [] }),
        );

        migrate_appearance(&mut config);
        let migrated = appearance(&config);
        assert_eq!(migrated["activeThemeId"], json!("elite"));
        assert_eq!(migrated["enable3d"], json!(true));
        assert!(migrated.get("activeThemeId2d").is_none());
        assert!(migrated.get("activeThemeId3d").is_none());
    }

    #[test]
    fn enabled_3d_widgets_store_only_disabled_entries() {
        let fixture = Fixture::new("widgets");
        let mut config = fixture.config();
        migrate_appearance(&mut config);
        set_active_theme(&mut config, &json!("nebula"), Some(true));
        assert_eq!(appearance(&config)["enabled3d"], json!({}));

        set_enabled_3d_widget(&mut config, &json!("md3-orb"), false);
        assert_eq!(appearance(&config)["enabled3d"]["md3-orb"], json!(false));

        set_enabled_3d_widget(&mut config, &json!("md3-orb"), true);
        assert!(appearance(&config)["enabled3d"]
            .as_object()
            .unwrap()
            .get("md3-orb")
            .is_none());
    }

    #[test]
    fn list_themes_has_builtins_without_variants_and_custom_themes() {
        let fixture = Fixture::new("list");
        let mut config = fixture.config();
        migrate_appearance(&mut config);
        save_custom_theme(&mut config, &json!({ "name": "Моя" }));

        let themes = list_themes(&config);
        let ids: Vec<&str> = themes
            .iter()
            .filter_map(|theme| theme["id"].as_str())
            .collect();
        // 3D-варианты самостоятельно в списке не показываются.
        assert!(!ids.contains(&"grimhex"));
        assert!(ids.contains(&"nebula"));
        let custom = themes
            .iter()
            .find(|theme| theme["builtin"] == json!(false))
            .unwrap();
        assert_eq!(custom["category"], json!("custom"));
        assert_eq!(custom["name"], json!("Моя"));
    }

    #[test]
    fn a_custom_theme_keeps_granular_overrides_and_gets_tokens() {
        let fixture = Fixture::new("granular");
        let mut config = fixture.config();
        migrate_appearance(&mut config);

        let theme = save_custom_theme(
            &mut config,
            &json!({
                "name": "Моя",
                "seeds": {
                    "primary": "#111111", "secondary": "#222222", "tertiary": "#333333",
                    "surfaceSeed": "#444444", "shapeMode": "angular", "fontPreset": "orbital",
                    "fontDisplay": "\"Arial\", sans-serif",
                    "panelRadius": "10px",
                    "panelBorderWidth": "2px",
                    "panelBorderColor": "#ff0000",
                    "panelGlowColor": "#00ff00",
                    "panelGlowStrength": 60,
                    "customCss": ".x { color: red; }",
                },
            }),
        );

        assert_eq!(
            theme["seeds"]["fontDisplay"],
            json!("\"Arial\", sans-serif")
        );
        assert_eq!(theme["seeds"]["panelRadius"], json!("10px"));
        assert_eq!(theme["seeds"]["panelBorderWidth"], json!("2px"));
        assert_eq!(theme["seeds"]["panelBorderColor"], json!("#ff0000"));
        assert_eq!(theme["seeds"]["panelGlowColor"], json!("#00ff00"));
        assert_eq!(theme["seeds"]["panelGlowStrength"], json!(60));
        assert_eq!(theme["seeds"]["customCss"], json!(".x { color: red; }"));
        assert_eq!(theme["tokens"]["--panel-radius"], json!("10px"));
        assert_eq!(
            theme["tokens"]["--panel-border"],
            json!("2px solid #ff0000")
        );
        assert!(theme["tokens"]["--panel-glow"]
            .as_str()
            .unwrap()
            .starts_with("0 0 "));
    }

    #[test]
    fn a_custom_theme_keeps_the_scheme_unknown_means_dark() {
        let fixture = Fixture::new("scheme");
        let mut config = fixture.config();
        migrate_appearance(&mut config);
        let base = json!({
            "primary": "#111111", "secondary": "#222222", "tertiary": "#333333", "surfaceSeed": "#444444",
        });

        let light = save_custom_theme(
            &mut config,
            &json!({ "name": "Светлая", "seeds": merge(&base, &json!({ "mode": "light" })) }),
        );
        assert_eq!(light["seeds"]["mode"], json!("light"));

        let fallback = save_custom_theme(
            &mut config,
            &json!({ "name": "Странная", "seeds": merge(&base, &json!({ "mode": "neon" })) }),
        );
        assert_eq!(fallback["seeds"]["mode"], json!("dark"));
    }

    #[test]
    fn custom_3d_widgets_are_sanitized_and_allow_mixing_styles() {
        let fixture = Fixture::new("mix");
        let mut config = fixture.config();
        migrate_appearance(&mut config);

        let bad = save_custom_theme(
            &mut config,
            &json!({
                "name": "Плохая",
                "seeds": {
                    "primary": "#123456", "secondary": "#654321", "tertiary": "#abcdef", "surfaceSeed": "#101010",
                    "threeDWidgets": ["nope", "teso-chat", "teso-chat", "  "],
                },
            }),
        );
        assert_eq!(bad["seeds"]["threeDWidgets"], json!(["teso-chat"]));

        let none = save_custom_theme(&mut config, &json!({ "name": "Без 3D" }));
        assert_eq!(none["seeds"]["threeDWidgets"], json!([]));
    }

    #[test]
    fn a_custom_theme_without_seeds_does_not_panic() {
        let fixture = Fixture::new("noseeds");
        let mut config = fixture.config();
        migrate_appearance(&mut config);

        let theme = save_custom_theme(&mut config, &json!({ "name": "Без семян" }));
        assert_eq!(theme["name"], json!("Без семян"));
        assert_eq!(theme["seeds"]["primary"], json!("#c6b8ff"));
        assert!(theme["tokens"].is_object());
    }

    #[test]
    fn the_error_color_and_alert_animation_are_sanitized() {
        let fixture = Fixture::new("error");
        let mut config = fixture.config();
        migrate_appearance(&mut config);

        let theme = save_custom_theme(
            &mut config,
            &json!({
                "name": "Сан",
                "seeds": {
                    "primary": "#111111", "secondary": "#222222", "tertiary": "#333333",
                    "error": "#ff0000", "alertEnterDuration": 5000, "alertEnterEasing": "spring",
                },
            }),
        );
        assert_eq!(theme["seeds"]["error"], json!("#ff0000"));
        assert_eq!(theme["seeds"]["alertEnterDuration"], json!(2000));
        assert_eq!(theme["seeds"]["alertEnterEasing"], json!("spring"));

        let bad = save_custom_theme(
            &mut config,
            &json!({
                "name": "Плохо",
                "seeds": {
                    "primary": "#111111", "secondary": "#222222", "tertiary": "#333333",
                    "error": "red", "alertEnterEasing": "nope",
                },
            }),
        );
        assert_eq!(bad["seeds"]["error"], json!(""));
        assert_eq!(bad["seeds"]["alertEnterEasing"], json!(""));
    }

    #[test]
    fn duplicating_a_custom_theme_creates_a_copy() {
        let fixture = Fixture::new("copy");
        let mut config = fixture.config();
        migrate_appearance(&mut config);
        let theme = save_custom_theme(
            &mut config,
            &json!({ "name": "Оригинал", "seeds": { "primary": "#111111" } }),
        );
        let id = theme["id"].clone();

        let copy = duplicate_custom_theme(&mut config, &id).expect("копия");
        assert_ne!(copy["id"], theme["id"]);
        assert_eq!(copy["name"], json!("Оригинал (копия)"));
        assert_eq!(copy["tokens"], theme["tokens"]);
        assert!(find_custom_theme(&config, copy["id"].as_str().unwrap()).is_some());
    }

    #[test]
    fn deleting_a_custom_theme_returns_to_nebula() {
        let fixture = Fixture::new("delete");
        let mut config = fixture.config();
        migrate_appearance(&mut config);
        let theme = save_custom_theme(&mut config, &json!({ "name": "Моя" }));
        let id = theme["id"].clone();
        set_active_theme(&mut config, &id, None);

        assert!(delete_custom_theme(&mut config, &id));
        assert_eq!(appearance(&config)["activeThemeId"], json!("nebula"));
        assert!(!delete_custom_theme(&mut config, &id));
    }

    #[test]
    fn editor_prefs_clamp_the_grid_and_keep_known_ratios() {
        let fixture = Fixture::new("editor");
        let mut config = fixture.config();

        let editor = set_editor_prefs(
            &mut config,
            &json!({ "gridSize": 999, "snapEnabled": false, "aspectRatio": "21:9" }),
        );
        assert_eq!(editor["gridSize"], json!(25));
        assert_eq!(editor["snapEnabled"], json!(false));
        assert_eq!(editor["aspectRatio"], json!("21:9"));

        // Неизвестная пропорция не заменяет сохранённую.
        let editor = set_editor_prefs(&mut config, &json!({ "aspectRatio": "5:4" }));
        assert_eq!(editor["aspectRatio"], json!("21:9"));
    }

    #[test]
    fn hud_hotkeys_fall_back_to_defaults() {
        let fixture = Fixture::new("hud");
        let mut config = fixture.config();

        assert_eq!(
            set_hud_hotkey(&mut config, &json!("  Alt+H ")),
            json!("Alt+H")
        );
        assert_eq!(
            set_hud_hotkey(&mut config, &json!("   ")),
            json!("Control+Shift+H")
        );
        assert_eq!(
            set_chat_hud_hotkey(&mut config, &json!("")),
            json!("Control+Shift+L")
        );
        assert_eq!(set_hud_display(&mut config, &json!("2")), json!("2"));
        assert_eq!(set_hud_display(&mut config, &json!("")), Value::Null);
        assert_eq!(set_chat_hud_display(&mut config, &Value::Null), Value::Null);
    }

    #[test]
    fn chat_hud_config_clamps_and_keeps_defaults() {
        let fixture = Fixture::new("chathud");
        let mut config = fixture.config();

        let next = set_chat_hud_config(
            &mut config,
            &json!({ "width": 5000, "height": 10, "opacity": 200, "fontSize": "abc" }),
        );
        assert_eq!(next["width"], json!(1200));
        assert_eq!(next["height"], json!(160));
        assert_eq!(next["opacity"], json!(100));
        // Мусорный шрифт — значение по умолчанию, а не поломка.
        assert_eq!(next["fontSize"], json!(14));
        assert_eq!(next["x"], Value::Null);

        let next = set_chat_hud_config(&mut config, &json!({ "x": 120, "y": "" }));
        assert_eq!(next["x"], json!(120));
        assert_eq!(next["y"], Value::Null);
    }

    /// Слить два объекта — как `{ ...a, ...b }`.
    fn merge(base: &Value, patch: &Value) -> Value {
        let mut merged = base.as_object().cloned().unwrap_or_default();
        if let Some(patch) = patch.as_object() {
            for (key, value) in patch {
                merged.insert(key.clone(), value.clone());
            }
        }
        Value::Object(merged)
    }
}
