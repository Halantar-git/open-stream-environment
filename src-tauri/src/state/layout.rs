//! Раскладка оверлея: виджеты на холсте и её пресеты.
//!
//! Порт части `server/state.js`: `addWidget`, `updateWidget`, `removeWidget`,
//! `reorderWidget`, `saveLayout`, `hasTimerWidget` и пресеты раскладки.
//!
//! Геометрия виджетов — проценты холста (`catalog::canvas`), поэтому раскладка не
//! зависит от разрешения: и редактор в панели, и Browser Source в OBS рисуют одно
//! и то же. Границы (минимум по `minW`/`minH`, максимум — 100%) берутся из
//! каталога, а не из головы: те же числа ограничивают растягивание мышью в панели.
//!
//! Отличие от JS: там раскладка живёт в памяти (`this._layout`) и правится на
//! месте, здесь каждый вызов читает и пишет `Database`. Для сервера это лучше —
//! нет второй копии, — но означает, что «в памяти» ничего не задерживается:
//! вернулся результат вызова, и он же лежит на диске.

use serde_json::{json, Map, Value};

use crate::catalog;
use crate::state::theme_dimension;
use crate::storage::config_file::ConfigFile;
use crate::storage::db::Database;
use crate::storage::history::{js_number, js_number_or_zero, js_truthy, number_value};

/// Границы размера виджета, если каталог о типе ничего не знает.
const FALLBACK_MIN_W: f64 = 5.0;
const FALLBACK_MIN_H: f64 = 5.0;

/// Длина имени пресета — как в панели.
const PRESET_NAME_LIMIT: usize = 60;

/// Раскладка оверлея.
///
/// Если в базе ничего нет, берётся старая раскладка из настроек
/// (`config.layout`) и сразу переносится в базу; виджеты, чей тип исчез из
/// каталога (раскладки прошлых версий), отбрасываются — и на диске тоже.
pub fn widgets(db: &Database, config: &ConfigFile) -> Vec<Value> {
    let stored = db.widgets();
    if !stored.is_empty() {
        let clean = clean_widgets(&stored);
        if clean.len() != stored.len() {
            db.save_widgets(clean.clone());
        }
        return clean;
    }

    let legacy = clean_widgets(&config_layout(config));
    if !legacy.is_empty() {
        db.save_widgets(legacy.clone());
    }
    legacy
}

/// Есть ли в раскладке видимый таймер Executive Hangar.
///
/// Роль `timer` есть и у 2D-таймера, и у 3D `grimhex-timer`. Отсчёт всегда идёт от
/// Longshot, поэтому пока такого виджета нет или он скрыт, внешний API не
/// опрашивается вовсе.
pub fn has_timer_widget(db: &Database) -> bool {
    db.widgets().iter().any(|widget| {
        widget.get("visible") != Some(&Value::Bool(false))
            && catalog::widget_role(widget_type(widget)).as_deref() == Some("timer")
    })
}

/// Поставить виджет по умолчанию: геометрия, слой и настройки — из каталога.
///
/// `None` — такого типа в каталоге нет (панель могла прислать старое имя).
pub fn add_widget(db: &Database, kind: &str) -> Option<Value> {
    let def = catalog::def(kind)?;
    let current = db.widgets();
    let max_z = current
        .iter()
        .map(|widget| js_number_or_zero(widget.get("z")))
        .fold(0.0, f64::max);

    let mut widget = Map::new();
    widget.insert(
        "id".to_string(),
        Value::from(uuid::Uuid::new_v4().to_string()),
    );
    widget.insert("type".to_string(), Value::from(kind));
    if let Some(Value::Object(geometry)) = def.get("defaultGeometry") {
        for (key, value) in geometry {
            widget.insert(key.clone(), value.clone());
        }
    }
    widget.insert("z".to_string(), number_value(max_z + 1.0));
    widget.insert("visible".to_string(), Value::Bool(true));
    widget.insert("config".to_string(), catalog::default_config(kind));

    let mut layout = current;
    layout.push(Value::Object(widget.clone()));
    db.save_widgets(layout);
    Some(Value::Object(widget))
}

/// Изменить виджет: геометрия ограничивается каталогом, настройки доливаются.
///
/// `None` — виджета с таким идентификатором нет.
pub fn update_widget(db: &Database, id: &str, patch: &Value) -> Option<Value> {
    let mut layout = db.widgets();
    let widget = layout
        .iter_mut()
        .find(|widget| widget.get("id").and_then(Value::as_str) == Some(id))?;

    let kind = widget_type(widget).to_string();
    let (min_w, min_h) = min_size(&kind);
    let number = |key: &str| -> Option<f64> {
        match patch.get(key) {
            Some(Value::Number(number)) => number.as_f64(),
            _ => None,
        }
    };

    // Порядок важен: `x` ограничивается уже новым `w` — так же, как в JS.
    if let Some(width) = number("w") {
        set_number(widget, "w", clamp(width, min_w, 100.0));
    }
    if let Some(height) = number("h") {
        set_number(widget, "h", clamp(height, min_h, 100.0));
    }
    let width = js_number_or_zero(widget.get("w"));
    let height = js_number_or_zero(widget.get("h"));
    if let Some(x) = number("x") {
        set_number(widget, "x", clamp(x, 0.0, 100.0 - width));
    }
    if let Some(y) = number("y") {
        set_number(widget, "y", clamp(y, 0.0, 100.0 - height));
    }
    if let Some(Value::Bool(visible)) = patch.get("visible") {
        widget["visible"] = Value::Bool(*visible);
    }
    // В JS `typeof config === "object"` пропускает и массив; здесь массив не
    // считается набором настроек — такого на входе не бывает, а ключи «0», «1»
    // вместо полей были бы сюрпризом.
    if let Some(Value::Object(patch_config)) = patch.get("config") {
        merge_config(widget, patch_config);
    }

    let updated = widget.clone();
    db.save_widgets(layout);
    Some(updated)
}

/// Убрать виджет; `false` — такого не было.
pub fn remove_widget(db: &Database, id: &str) -> bool {
    let layout = db.widgets();
    let kept: Vec<Value> = layout
        .iter()
        .filter(|widget| widget.get("id").and_then(Value::as_str) != Some(id))
        .cloned()
        .collect();
    if kept.len() == layout.len() {
        return false;
    }
    db.save_widgets(kept);
    true
}

/// Подвинуть виджет на слой вперёд или назад: меняются местами `z` с соседом по
/// порядку слоёв.
pub fn reorder_widget(db: &Database, id: &str, direction: &str) -> bool {
    let mut layout = db.widgets();
    let mut order: Vec<usize> = (0..layout.len()).collect();
    order.sort_by(|left, right| {
        js_number_or_zero(layout[*left].get("z"))
            .partial_cmp(&js_number_or_zero(layout[*right].get("z")))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let Some(position) = order
        .iter()
        .position(|index| layout[*index].get("id").and_then(Value::as_str) == Some(id))
    else {
        return false;
    };
    let neighbour = if direction == "forward" {
        position.checked_add(1)
    } else {
        position.checked_sub(1)
    };
    let Some(neighbour) = neighbour.filter(|index| *index < order.len()) else {
        return false;
    };

    let (first, second) = (order[position], order[neighbour]);
    let first_z = layout[first].get("z").cloned().unwrap_or(Value::from(0));
    let second_z = layout[second].get("z").cloned().unwrap_or(Value::from(0));
    layout[first]["z"] = second_z;
    layout[second]["z"] = first_z;
    db.save_widgets(layout);
    true
}

/// Записать раскладку целиком — её присылает режим правки в HUD.
///
/// Каждый виджет ограничивается теми же границами, что и [`update_widget`]: одна
/// случайная перетасовка не должна записать за экран или меньше минимума.
pub fn save_layout(db: &Database, layout: &Value) -> bool {
    let Some(items) = layout.as_array() else {
        return false;
    };

    let saved: Vec<Value> = items
        .iter()
        .filter(|widget| widget_is_known(widget))
        .map(normalize_widget)
        .collect();
    db.save_widgets(saved);
    true
}

/// Список пресетов раскладки — то, что показывает панель.
pub fn list_layout_presets(db: &Database) -> Vec<Value> {
    db.layout_presets()
        .iter()
        .map(|preset| {
            let enable3d = match preset.get("enable3d") {
                Some(value) if !value.is_null() => js_truthy(Some(value)),
                _ => js_truthy(preset.get("theme3d")),
            };
            json!({
                "id": preset.get("id").cloned().unwrap_or(Value::Null),
                "name": preset.get("name").cloned().unwrap_or(Value::Null),
                "widgetCount": preset
                    .get("widgets")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0),
                // Старые пресеты хранили тему как `theme2d`/`theme3d`.
                "themeId": first_truthy(preset, &["themeId", "theme2d"]).unwrap_or_default(),
                "enable3d": enable3d,
                // Числа — через `number_value`: целое не должно уехать как `1000.0`.
                "createdAt": number_value(js_number_or_zero(preset.get("createdAt"))),
                "updatedAt": number_value(js_number_or_zero(preset.get("updatedAt"))),
            })
        })
        .collect()
}

/// Сохранить текущую раскладку под именем; с `id` — перезаписать существующий.
///
/// `None` — имени нет или пресета с таким `id` не существует (в JS то же самое).
pub fn save_layout_preset(
    db: &Database,
    config: &ConfigFile,
    id: Option<&str>,
    name: &str,
    now_ms: i64,
) -> Option<Vec<Value>> {
    let clean_name: String = name.trim().chars().take(PRESET_NAME_LIMIT).collect();
    if clean_name.is_empty() {
        return None;
    }

    let theme_id = appearance(config)
        .and_then(|appearance| first_string(appearance, "activeThemeId"))
        .unwrap_or_else(|| "nebula".to_string());
    let enable3d = js_truthy(appearance(config).and_then(|appearance| appearance.get("enable3d")));
    let snapshot = |widgets: &[Value]| -> Vec<Value> { widgets.iter().map(copy_widget).collect() };

    let mut presets = db.layout_presets();
    match id {
        Some(id) => {
            let existing = presets
                .iter_mut()
                .find(|preset| preset.get("id").and_then(Value::as_str) == Some(id))?;
            existing["name"] = Value::from(clean_name);
            existing["widgets"] = Value::Array(snapshot(&db.widgets()));
            existing["themeId"] = Value::from(theme_id);
            existing["enable3d"] = Value::Bool(enable3d);
            existing["updatedAt"] = Value::from(now_ms);
        }
        None => presets.push(json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "name": clean_name,
            "widgets": snapshot(&db.widgets()),
            "themeId": theme_id,
            "enable3d": enable3d,
            "createdAt": now_ms,
            "updatedAt": now_ms,
        })),
    }

    db.save_layout_presets(presets);
    Some(list_layout_presets(db))
}

/// Вернуть раскладку и тему из пресета; `None` — пресета нет или в нём нет виджетов.
pub fn apply_layout_preset(db: &Database, config: &mut ConfigFile, id: &str) -> Option<Vec<Value>> {
    let preset = db
        .layout_presets()
        .into_iter()
        .find(|preset| preset.get("id").and_then(Value::as_str) == Some(id))?;
    let stored = preset.get("widgets")?.as_array().cloned()?;

    let layout: Vec<Value> = stored.iter().map(copy_widget).collect();
    // Тема возвращается вместе с раскладкой: иначе виджеты 3D-темы остались бы в
    // раскладке, но невидимыми. Старые пресеты хранили `theme2d`/`theme3d`.
    let raw_theme_id = first_string(&preset, "themeId")
        .or_else(|| first_string(&preset, "theme2d"))
        .unwrap_or_default();
    let theme_id = match crate::themes::builtin_theme(&raw_theme_id) {
        // Вариант 3D — это надстройка: базовой остаётся его 2D-тема.
        Some(theme) if is_variant(theme) => theme
            .get("base2d")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        _ => raw_theme_id,
    };
    let enable3d = match preset.get("enable3d") {
        Some(value) if !value.is_null() => js_truthy(Some(value)),
        _ => js_truthy(preset.get("theme3d")),
    };

    let mut appearance = appearance(config).cloned().unwrap_or_else(|| json!({}));
    if !theme_id.is_empty() && theme_dimension(config, &theme_id).is_some() {
        appearance["activeThemeId"] = Value::from(theme_id);
    }
    appearance["enable3d"] = Value::Bool(enable3d);
    config.set("appearance", appearance);
    config.save();

    db.save_widgets(layout.clone());
    Some(layout)
}

/// Удалить пресет; `None` — такого пресета не было.
pub fn delete_layout_preset(db: &Database, id: &str) -> Option<Vec<Value>> {
    let presets = db.layout_presets();
    let kept: Vec<Value> = presets
        .iter()
        .filter(|preset| preset.get("id").and_then(Value::as_str) != Some(id))
        .cloned()
        .collect();
    if kept.len() == presets.len() {
        return None;
    }
    db.save_layout_presets(kept);
    Some(list_layout_presets(db))
}

// ---- вспомогательное ----

/// `WIDGET_TYPES[w.type]`: тип виджета по имени.
fn catalog_def(kind: &str) -> Option<&'static Value> {
    catalog::def(kind)
}

fn widget_type(widget: &Value) -> &str {
    widget
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// `w && w.id != null && WIDGET_TYPES[w.type]`.
fn widget_is_known(widget: &Value) -> bool {
    widget.is_object()
        && widget.get("id").is_some_and(|id| !id.is_null())
        && catalog_def(widget_type(widget)).is_some()
}

fn clean_widgets(list: &[Value]) -> Vec<Value> {
    list.iter()
        .filter(|widget| widget_is_known(widget))
        .cloned()
        .collect()
}

/// Раскладка прошлых версий, лежавшая в настройках.
fn config_layout(config: &ConfigFile) -> Vec<Value> {
    config
        .get("layout")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Минимальные размеры из каталога; неизвестный тип — общий минимум.
fn min_size(kind: &str) -> (f64, f64) {
    match catalog_def(kind) {
        Some(def) => (
            js_number(def.get("minW")).max(0.0),
            js_number(def.get("minH")).max(0.0),
        ),
        None => (FALLBACK_MIN_W, FALLBACK_MIN_H),
    }
}

/// `{ ...widget, config: { ...(widget.config || {}) } }` — копия без общих ссылок.
fn copy_widget(widget: &Value) -> Value {
    let mut copy = match widget.as_object() {
        Some(fields) => fields.clone(),
        None => Map::new(),
    };
    let config = widget
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    copy.insert("config".to_string(), Value::Object(config));
    Value::Object(copy)
}

/// Привести виджет к границам каталога — как `saveLayout`.
fn normalize_widget(widget: &Value) -> Value {
    let kind = widget_type(widget).to_string();
    let (min_w, min_h) = min_size(&kind);
    let width = clamp(number_or(widget.get("w"), min_w), min_w, 100.0);
    let height = clamp(number_or(widget.get("h"), min_h), min_h, 100.0);

    let mut normalized = copy_widget(widget);
    normalized["w"] = number_value(round2(width));
    normalized["h"] = number_value(round2(height));
    normalized["x"] = number_value(round2(clamp(
        number_or(widget.get("x"), 0.0),
        0.0,
        100.0 - width,
    )));
    normalized["y"] = number_value(round2(clamp(
        number_or(widget.get("y"), 0.0),
        0.0,
        100.0 - height,
    )));
    normalized
}

/// Долить настройки виджета: `{ ...widget.config, ...patch }`.
fn merge_config(widget: &mut Value, patch: &Map<String, Value>) {
    let mut config = widget
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (key, value) in patch {
        config.insert(key.clone(), value.clone());
    }
    widget["config"] = Value::Object(config);
}

fn set_number(widget: &mut Value, key: &str, value: f64) {
    widget[key] = number_value(value);
}

/// `Math.min(max, Math.max(min, value))`.
fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value.is_nan() {
        return min;
    }
    value.max(min).min(max)
}

/// `Number(value) || fallback`: NaN и ноль дают запасное значение.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js_number(value);
    if number.is_nan() || number == 0.0 {
        fallback
    } else {
        number
    }
}

/// `Math.round(value * 100) / 100`.
fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

/// Первое истинное строковое поле из списка — как `p.themeId || p.theme2d || ""`.
fn first_truthy(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| first_string(value, key))
}

/// Значение поля как строка, если оно истинно.
fn first_string(value: &Value, key: &str) -> Option<String> {
    let field = value.get(key)?;
    if !js_truthy(Some(field)) {
        return None;
    }
    field.as_str().map(str::to_string)
}

fn appearance(config: &ConfigFile) -> Option<&Value> {
    config.get("appearance")
}

/// Встроенная тема — 3D-вариант (надстройка над базовой 2D-темой).
fn is_variant(theme: &Value) -> bool {
    theme.get("variant") == Some(&Value::Bool(true))
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
                .join(format!("ose-layout-{}-{label}-{index}", std::process::id()));
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

    fn layout(db: &Database, config: &ConfigFile) -> Vec<Value> {
        widgets(db, config)
    }

    #[test]
    fn a_widget_is_added_from_the_catalog() {
        let fixture = Fixture::new("add");
        let (db, config) = (fixture.db(), fixture.config());

        let widget = add_widget(&db, "chat").expect("виджет чата");
        assert_eq!(widget["type"], json!("chat"));
        assert!(widget["id"].as_str().is_some_and(|id| !id.is_empty()));
        // Геометрия по умолчанию — из каталога, слоем выше всех и видимым.
        assert_eq!(widget["x"], json!(68));
        assert_eq!(widget["w"], json!(29));
        assert_eq!(widget["z"], json!(1));
        assert_eq!(widget["visible"], json!(true));
        assert_eq!(
            widget["config"],
            json!({ "maxMessages": 8, "showBadges": true })
        );

        let second = add_widget(&db, "goal").expect("виджет цели");
        assert_eq!(second["z"], json!(2));
        assert_eq!(layout(&db, &config).len(), 2);

        // Незнакомый тип не создаётся.
        assert!(add_widget(&db, "нет-такого").is_none());
        assert_eq!(layout(&db, &config).len(), 2);
    }

    #[test]
    fn updating_clamps_geometry_to_the_catalog_bounds() {
        let fixture = Fixture::new("update");
        let (db, config) = (fixture.db(), fixture.config());
        let widget = add_widget(&db, "chat").expect("виджет");
        let id = widget["id"].as_str().expect("id").to_string();

        // Чат не меньше 16×16 и не выходит за холст.
        let updated = update_widget(
            &db,
            &id,
            &json!({ "w": 5, "h": 200, "x": 500, "y": 500, "visible": false }),
        )
        .expect("виджет обновился");

        assert_eq!(updated["w"], json!(16));
        assert_eq!(updated["h"], json!(100));
        assert_eq!(updated["x"], json!(84)); // 100 − 16
        assert_eq!(updated["y"], json!(0)); // 100 − 100
        assert_eq!(updated["visible"], json!(false));

        // Настройки доливаются поверх, а не заменяют собой.
        let patched =
            update_widget(&db, &id, &json!({ "config": { "maxMessages": 3 } })).expect("настройки");
        assert_eq!(patched["config"]["maxMessages"], json!(3));
        assert_eq!(patched["config"]["showBadges"], json!(true));
        // Геометрия пережила правку настроек.
        assert_eq!(patched["w"], json!(16));

        assert!(update_widget(&db, "нет-такого", &json!({})).is_none());
        assert_eq!(layout(&db, &config).len(), 1);
    }

    #[test]
    fn a_widget_whose_type_left_the_catalog_is_dropped() {
        let fixture = Fixture::new("clean");
        let (db, config) = (fixture.db(), fixture.config());
        add_widget(&db, "chat").expect("виджет");

        // Так выглядит раскладка прошлой версии: тип, которого больше нет в каталоге.
        let mut stored = db.widgets();
        stored.push(
            json!({ "id": "old-1", "type": "participants", "x": 1, "y": 1, "w": 10, "h": 10 }),
        );
        stored.push(json!({ "type": "chat" })); // без id — тоже мусор
        db.save_widgets(stored);

        let loaded = layout(&db, &config);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0]["type"], json!("chat"));
        // На диске тоже стало чисто.
        assert_eq!(db.widgets().len(), 1);
    }

    #[test]
    fn the_legacy_layout_from_settings_moves_into_the_base() {
        let fixture = Fixture::new("legacy");
        let mut config = fixture.config();
        config.set(
            "layout",
            json!([
                { "id": "w1", "type": "goal", "x": 3, "y": 84, "w": 32, "h": 6, "z": 1 },
                { "id": "w2", "type": "нет-такого" },
            ]),
        );
        let db = fixture.db();

        let loaded = layout(&db, &config);

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0]["type"], json!("goal"));
        // Старая раскладка переехала в базу.
        assert_eq!(db.widgets().len(), 1);
        assert_eq!(db.widgets()[0]["id"], json!("w1"));
    }

    #[test]
    fn removing_and_reordering_touch_only_what_was_asked() {
        let fixture = Fixture::new("order");
        let (db, config) = (fixture.db(), fixture.config());
        let first = add_widget(&db, "recent").expect("виджет");
        let second = add_widget(&db, "chat").expect("виджет");
        let third = add_widget(&db, "goal").expect("виджет");
        let first_id = first["id"].as_str().unwrap().to_string();
        let second_id = second["id"].as_str().unwrap().to_string();
        let third_id = third["id"].as_str().unwrap().to_string();

        // Выше всех третий (z=3); двигаем его назад — меняется местами со вторым.
        assert!(reorder_widget(&db, &third_id, "backward"));
        let z_of = |id: &str| {
            layout(&db, &config)
                .iter()
                .find(|widget| widget["id"] == json!(id))
                .map(|widget| widget["z"].clone())
                .expect("виджет")
        };
        assert_eq!(z_of(&second_id), json!(3));
        assert_eq!(z_of(&third_id), json!(2));

        // На самом верхнем дальше двигать некуда.
        assert!(!reorder_widget(&db, &second_id, "forward"));
        assert!(!reorder_widget(&db, "нет-такого", "forward"));

        assert!(remove_widget(&db, &first_id));
        assert!(!remove_widget(&db, &first_id));
        assert_eq!(layout(&db, &config).len(), 2);
    }

    #[test]
    fn saving_a_layout_clamps_and_rounds_every_widget() {
        let fixture = Fixture::new("save");
        let (db, config) = (fixture.db(), fixture.config());

        let saved = save_layout(
            &db,
            &json!([
                { "id": "w1", "type": "chat", "x": -5, "y": 50.678, "w": 12.345, "h": 20 },
                { "id": "w2", "type": "нет-такого" },
                "мусор",
            ]),
        );

        assert!(saved);
        let stored = layout(&db, &config);
        assert_eq!(stored.len(), 1);
        let widget = &stored[0];
        // Минимум чата — 16, максимум — холст; числа округлены до сотых.
        assert_eq!(widget["w"], json!(16));
        assert_eq!(widget["h"], json!(20));
        assert_eq!(widget["x"], json!(0));
        assert_eq!(widget["y"], json!(50.68));
        // Виджет как был, так и остался известного типа.
        assert_eq!(widget["type"], json!("chat"));

        // Не массив — не раскладка.
        assert!(!save_layout(&db, &json!("нет")));
    }

    #[test]
    fn the_hangar_timer_is_seen_only_when_it_is_visible() {
        let fixture = Fixture::new("timer");
        let (db, config) = (fixture.db(), fixture.config());
        assert!(!has_timer_widget(&db));

        let timer = add_widget(&db, "timer").expect("таймер");
        assert!(has_timer_widget(&db));

        // 3D-вариант таймера — та же роль.
        let id = timer["id"].as_str().unwrap().to_string();
        update_widget(&db, &id, &json!({ "visible": false }));
        assert!(!has_timer_widget(&db));
        assert!(add_widget(&db, "grimhex-timer").is_some());
        assert!(has_timer_widget(&db));

        // А обычный виджет таймером не считается.
        let chat = add_widget(&db, "chat").expect("чат");
        let chat_id = chat["id"].as_str().unwrap().to_string();
        update_widget(&db, &chat_id, &json!({ "visible": false }));
        assert!(has_timer_widget(&db));
        assert_eq!(layout(&db, &config).len(), 3);
    }

    #[test]
    fn saving_applying_and_deleting_a_layout_preset() {
        let fixture = Fixture::new("preset");
        let db = fixture.db();
        let mut config = fixture.config();
        add_widget(&db, "recent").expect("виджет");
        add_widget(&db, "chat").expect("виджет");

        // Тема, с которой сохраняем пресет.
        config.set(
            "appearance",
            json!({ "activeThemeId": "orbital", "enable3d": true, "customThemes": [] }),
        );
        config.save_sync();

        let saved = save_layout_preset(&db, &config, None, "  Мой пресет  ", 1000).expect("пресет");
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0]["name"], json!("Мой пресет"));
        assert_eq!(saved[0]["widgetCount"], json!(2));
        assert_eq!(saved[0]["themeId"], json!("orbital"));
        assert_eq!(saved[0]["enable3d"], json!(true));
        assert_eq!(saved[0]["createdAt"], json!(1000));
        let preset_id = saved[0]["id"].as_str().unwrap().to_string();

        // Меняем раскладку и тему, затем возвращаем их из пресета.
        let first_id = layout(&db, &config)[0]["id"].as_str().unwrap().to_string();
        assert!(remove_widget(&db, &first_id));
        config.set(
            "appearance",
            json!({ "activeThemeId": "pixel", "enable3d": false, "customThemes": [] }),
        );
        assert_eq!(layout(&db, &config).len(), 1);

        let applied = apply_layout_preset(&db, &mut config, &preset_id).expect("раскладка");
        assert_eq!(applied.len(), 2);
        assert_eq!(
            config.get("appearance").unwrap()["activeThemeId"],
            json!("orbital")
        );
        assert_eq!(config.get("appearance").unwrap()["enable3d"], json!(true));
        assert_eq!(layout(&db, &config).len(), 2);

        let deleted = delete_layout_preset(&db, &preset_id).expect("список пресетов");
        assert!(deleted.is_empty());
        assert!(delete_layout_preset(&db, &preset_id).is_none());
        assert!(apply_layout_preset(&db, &mut config, &preset_id).is_none());
    }

    #[test]
    fn rewriting_a_preset_by_id_does_not_duplicate_it() {
        let fixture = Fixture::new("preset-update");
        let db = fixture.db();
        let config = fixture.config();
        add_widget(&db, "recent").expect("виджет");

        let created = save_layout_preset(&db, &config, None, "Пресет", 1000).expect("пресет");
        let id = created[0]["id"].as_str().unwrap().to_string();

        add_widget(&db, "chat").expect("виджет");
        let updated =
            save_layout_preset(&db, &config, Some(&id), "Пресет v2", 2000).expect("пресет");

        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0]["id"], json!(id));
        assert_eq!(updated[0]["name"], json!("Пресет v2"));
        assert_eq!(updated[0]["widgetCount"], json!(2));
        // Дата создания не переписывается, обновления — да.
        assert_eq!(updated[0]["createdAt"], json!(1000));
        assert_eq!(updated[0]["updatedAt"], json!(2000));

        // Пустое имя и несуществующий id — отказ.
        assert!(save_layout_preset(&db, &config, None, "   ", 1000).is_none());
        assert!(save_layout_preset(&db, &config, Some("нет"), "Пресет", 1000).is_none());
    }
}
