//! Пакеты виджетов и тем: папки в данных пользователя.
//!
//! Пакет — это каталог `<данные>/plugins/<id>/` с манифестом `widget.json` или
//! `theme.json`, кодом и ресурсами. Ничего не линкуется в бинарник и не
//! переписывается руками: сервер читает манифесты на старте, отдаёт их панели
//! по `/api/plugins`, а файлы — статикой по `/plugins/<id>/`.
//!
//! Зачем реестр, а не чтение на каждый запрос: виджет из пакета должен попасть
//! в каталог (`catalog::def`) и пережить чистку раскладки, а тема — в список
//! тем и в `resolve_theme`. Оба живут в горячем пути снимка состояния, поэтому
//! манифесты разбираются один раз. Установка и удаление пакета требуют
//! перезапуска — в API это описано.
//!
//! Безопасность: путь `entry`/`styles`/`css` не может выйти за каталог пакета
//! (никаких `..` и абсолютных путей), идентификатор совпадает с именем папки.
//! Код пакета исполняется в оверлее с полными правами страницы, поэтому ставить
//! можно только доверенные пакеты; песочница — отдельный этап.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Map, Value};

/// Версия формата манифеста. Пакет с другой версией не загружается.
pub const API_VERSION: i64 = 1;
/// Каталог пакетов внутри данных пользователя.
pub const DIRECTORY: &str = "plugins";
/// Манифест виджета.
pub const WIDGET_FILE: &str = "widget.json";
/// Манифест темы.
pub const THEME_FILE: &str = "theme.json";

/// Какие настройки умеет рисовать инспектор. Незнакомый тип — ошибка
/// манифеста, а не молчаливое поле без редактора.
const SETTING_TYPES: &[&str] = &[
    "string", "text", "number", "range", "color", "boolean", "select",
];

/// Разобранные пакеты.
#[derive(Debug, Default)]
pub struct Registry {
    /// Тип виджета (`plugin:<id>`) -> определение для каталога.
    widgets: BTreeMap<String, &'static Value>,
    /// Идентификатор темы (`plugin:<id>`) -> тема в форме `themes.js`.
    themes: BTreeMap<String, &'static Value>,
    /// Список для `/api/plugins`.
    list: Vec<Value>,
    /// Пакеты, которые не удалось прочитать: `{ dir, error }`.
    errors: Vec<Value>,
}

impl Registry {
    /// Прочитать каталог пакетов. Ошибка одного пакета не мешает остальным.
    pub fn scan(dir: &Path) -> Registry {
        let mut registry = Registry::default();
        let Ok(entries) = fs::read_dir(dir) else {
            return registry;
        };
        let mut dirs: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|entry| entry.path())
            .collect();
        dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

        for package in dirs {
            let Some(name) = package.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if let Err(error) = registry.read_package(name, &package) {
                registry.errors.push(json!({ "dir": name, "error": error }));
            }
        }
        registry
    }

    fn read_package(&mut self, name: &str, package: &Path) -> Result<(), String> {
        if !valid_id(name) {
            return Err(
                "имя папки должно быть латиницей в нижнем регистре: a-z, 0-9, «.», «-», «_»"
                    .to_string(),
            );
        }
        let widget_file = package.join(WIDGET_FILE);
        let theme_file = package.join(THEME_FILE);
        match (widget_file.is_file(), theme_file.is_file()) {
            (true, true) => Err(format!(
                "в пакете два манифеста: {WIDGET_FILE} и {THEME_FILE}"
            )),
            (true, false) => self.read_widget(name, package, &widget_file),
            (false, true) => self.read_theme(name, package, &theme_file),
            (false, false) => Err(format!("нет ни {WIDGET_FILE}, ни {THEME_FILE}")),
        }
    }

    fn read_widget(&mut self, name: &str, package: &Path, file: &Path) -> Result<(), String> {
        let manifest = read_manifest(file)?;
        check_common(&manifest, name, "widget")?;

        let entry = text(&manifest, "entry").ok_or("поле entry пустое")?;
        let entry =
            relative_file(package, &entry).ok_or("entry должен быть файлом внутри пакета")?;
        if entry.extension().and_then(|ext| ext.to_str()) != Some("js") {
            return Err("entry должен быть .js-файлом".to_string());
        }

        let mut styles = Vec::new();
        for style in array(&manifest, "styles") {
            let raw = style.as_str().ok_or("styles содержит не строку")?;
            let file = relative_file(package, raw).ok_or("styles указывает за пределы пакета")?;
            if file.extension().and_then(|ext| ext.to_str()) != Some("css") {
                return Err("styles должен перечислять .css-файлы".to_string());
            }
            styles.push(Value::from(file.to_string_lossy().replace('\\', "/")));
        }

        let geometry = geometry(&manifest)?;
        let (min_w, min_h) = min_size(&manifest)?;
        let settings = settings(&manifest)?;
        let icon = text(&manifest, "icon").unwrap_or_else(|| "widgetCustom".to_string());
        let title = text(&manifest, "name").unwrap_or_else(|| name.to_string());
        let description = text(&manifest, "description").unwrap_or_default();
        let plugin_type = format!("plugin:{name}");

        let mut defaults = Map::new();
        for (key, field) in &settings {
            if let Some(value) = field.get("default") {
                defaults.insert(key.clone(), value.clone());
            }
        }

        let def = json!({
            "type": plugin_type.clone(),
            "label": title.clone(),
            "description": description.clone(),
            "icon": icon.clone(),
            "plugin": true,
            "pluginId": name,
            "defaultGeometry": geometry.clone(),
            "minW": min_w,
            "minH": min_h,
            "defaultConfig": Value::Object(defaults),
            "settings": settings.clone(),
        });
        self.widgets.insert(plugin_type.clone(), leak(def));

        self.list.push(json!({
            "kind": "widget",
            "id": name,
            "type": plugin_type,
            "name": title,
            "description": description,
            "version": text(&manifest, "version").unwrap_or_default(),
            "author": text(&manifest, "author").unwrap_or_default(),
            "baseUrl": format!("/plugins/{name}/"),
            "entry": entry.to_string_lossy().replace('\\', "/"),
            "styles": styles,
            "icon": icon,
            "geometry": geometry,
            "minW": min_w,
            "minH": min_h,
            "settings": settings,
        }));
        Ok(())
    }

    fn read_theme(&mut self, name: &str, package: &Path, file: &Path) -> Result<(), String> {
        let manifest = read_manifest(file)?;
        check_common(&manifest, name, "theme")?;

        let tokens = manifest
            .get("tokens")
            .and_then(Value::as_object)
            .ok_or("tokens должен быть объектом")?;
        if tokens.is_empty() {
            return Err("tokens пуст: теме нечего применить".to_string());
        }
        for (token, value) in tokens {
            if !token.starts_with("--") {
                return Err(format!("токен {token} должен начинаться с «--»"));
            }
            if !value.is_string() {
                return Err(format!("значение токена {token} должно быть строкой"));
            }
        }

        let css = match text(&manifest, "css") {
            Some(raw) => {
                let file = relative_file(package, &raw).ok_or("css указывает за пределы пакета")?;
                if file.extension().and_then(|ext| ext.to_str()) != Some("css") {
                    return Err("css должен быть .css-файлом".to_string());
                }
                Some(file.to_string_lossy().replace('\\', "/"))
            }
            None => None,
        };

        let id = format!("plugin:{name}");
        let title = text(&manifest, "name").unwrap_or_else(|| name.to_string());
        let color = |key: &str| tokens.get(key).cloned().unwrap_or(Value::Null);
        let theme = json!({
            "id": id.clone(),
            "name": title.clone(),
            // Форма встроенной темы: панель не предлагает её редактировать
            // и берёт цвета из того же объекта, что у BuiltinThemes.
            "builtin": true,
            "plugin": true,
            "category": "plugin",
            "dimension": "2d",
            "tokens": Value::Object(tokens.clone()),
        });
        self.themes.insert(id.clone(), leak(theme));

        self.list.push(json!({
            "kind": "theme",
            "id": id,
            "pluginId": name,
            "name": title,
            "version": text(&manifest, "version").unwrap_or_default(),
            "author": text(&manifest, "author").unwrap_or_default(),
            "baseUrl": format!("/plugins/{name}/"),
            "css": css,
            "tokens": Value::Object(tokens.clone()),
            "colors": [color("--md-primary"), color("--md-secondary"), color("--md-tertiary")],
        }));
        Ok(())
    }

    /// Ответ `/api/plugins`.
    pub fn payload(&self) -> Value {
        json!({
            "apiVersion": API_VERSION,
            "plugins": self.list,
            "errors": self.errors,
        })
    }
}

/// Реестр на весь процесс: ставится один раз при старте сервера.
static INSTALLED: OnceLock<Registry> = OnceLock::new();

/// Прочитать пакеты и запомнить их. Повторный вызов возвращает первый реестр:
/// манифесты меняются только вместе с перезапуском приложения.
pub fn install(dir: &Path) -> &'static Registry {
    INSTALLED.get_or_init(|| {
        // Пустой каталог создаём: так пользователь видит, куда класть пакет.
        fs::create_dir_all(dir).ok();
        let registry = Registry::scan(dir);
        for error in &registry.errors {
            eprintln!(
                "[ose] пакет {}: {}",
                error.get("dir").and_then(Value::as_str).unwrap_or_default(),
                error
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            );
        }
        registry
    })
}

/// Реестр, если он уже поставлен (в тестах и до старта — пусто).
pub fn installed() -> Option<&'static Registry> {
    INSTALLED.get()
}

/// Определение виджета из пакета.
pub fn widget_def(kind: &str) -> Option<&'static Value> {
    installed()?.widgets.get(kind).copied()
}

/// Тема из пакета.
pub fn theme(id: &str) -> Option<&'static Value> {
    installed()?.themes.get(id).copied()
}

/// Темы пакетов в порядке имени папки.
pub fn themes() -> Vec<&'static Value> {
    installed()
        .map(|registry| registry.themes.values().copied().collect())
        .unwrap_or_default()
}

/// Ответ `/api/plugins` из установленного реестра.
pub fn api_payload() -> Value {
    match installed() {
        Some(registry) => registry.payload(),
        None => json!({ "apiVersion": API_VERSION, "plugins": [], "errors": [] }),
    }
}

// ---- разбор манифеста ----

fn read_manifest(file: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(file).map_err(|error| format!("чтение: {error}"))?;
    let value: Value = serde_json::from_str(&raw).map_err(|error| format!("JSON: {error}"))?;
    if !value.is_object() {
        return Err("манифест должен быть JSON-объектом".to_string());
    }
    Ok(value)
}

fn check_common(manifest: &Value, name: &str, kind: &str) -> Result<(), String> {
    match manifest.get("apiVersion").and_then(Value::as_i64) {
        Some(API_VERSION) => {}
        Some(other) => {
            return Err(format!(
                "apiVersion {other} не поддерживается (нужен {API_VERSION})"
            ))
        }
        None => return Err("нет apiVersion".to_string()),
    }
    match manifest.get("kind").and_then(Value::as_str) {
        Some(given) if given == kind => {}
        Some(other) => return Err(format!("kind «{other}» не совпадает с {kind}.json")),
        None => return Err("нет kind".to_string()),
    }
    match manifest.get("id").and_then(Value::as_str) {
        Some(id) if id == name => {}
        Some(_) => return Err("id должен совпадать с именем папки".to_string()),
        None => return Err("нет id".to_string()),
    }
    if text(manifest, "name").is_none() {
        return Err("нет name".to_string());
    }
    Ok(())
}

fn text(manifest: &Value, key: &str) -> Option<String> {
    manifest
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn array<'a>(manifest: &'a Value, key: &str) -> &'a [Value] {
    manifest
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn geometry(manifest: &Value) -> Result<Value, String> {
    let source = manifest
        .get("defaultGeometry")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let number = |key: &str, default: f64| -> Result<f64, String> {
        match source.get(key) {
            Some(value) => value
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| format!("defaultGeometry.{key} должен быть числом")),
            None => Ok(default),
        }
    };
    let width = number("w", 24.0)?.clamp(1.0, 100.0);
    let height = number("h", 12.0)?.clamp(1.0, 100.0);
    let x = number("x", 10.0)?.clamp(0.0, 100.0 - width);
    let y = number("y", 10.0)?.clamp(0.0, 100.0 - height);
    Ok(json!({ "x": x, "y": y, "w": width, "h": height }))
}

fn min_size(manifest: &Value) -> Result<(f64, f64), String> {
    let number = |key: &str, default: f64| -> Result<f64, String> {
        match manifest.get(key) {
            Some(value) => value
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| format!("{key} должен быть числом")),
            None => Ok(default),
        }
    };
    Ok((
        number("minW", 5.0)?.clamp(0.5, 100.0),
        number("minH", 5.0)?.clamp(0.5, 100.0),
    ))
}

/// Схема настроек: ключ -> поле. Ключ попадает в `config` и в id поля
/// инспектора, поэтому ограничен безопасным набором символов.
fn settings(manifest: &Value) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    let Some(source) = manifest.get("settings") else {
        return Ok(out);
    };
    let source = source.as_object().ok_or("settings должен быть объектом")?;
    for (key, field) in source {
        if key.is_empty()
            || key.len() > 40
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(format!(
                "имя настройки «{key}» должно быть латиницей, цифрами, «_» или «-»"
            ));
        }
        let field = field
            .as_object()
            .ok_or_else(|| format!("настройка {key} должна быть объектом"))?;
        let kind = field
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("у настройки {key} нет type"))?;
        if !SETTING_TYPES.contains(&kind) {
            return Err(format!("у настройки {key} неизвестный type «{kind}»"));
        }
        if let Some(options) = field.get("options") {
            let options = options
                .as_array()
                .ok_or_else(|| format!("options настройки {key} должны быть массивом"))?;
            for option in options {
                let value = option
                    .as_str()
                    .or_else(|| option.get("value").and_then(Value::as_str));
                if value.is_none() {
                    return Err(format!("options настройки {key} содержат не строку"));
                }
            }
        }
        let mut field = field.clone();
        // В `select` умолчание всегда одно из значений: иначе браузер покажет
        // первый пункт, а в config останется пусто, и виджет с сервера и
        // виджет в инспекторе разойдутся.
        if kind == "select" {
            let options = field
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let value_of = |option: &Value| {
                option
                    .as_str()
                    .or_else(|| option.get("value").and_then(Value::as_str))
                    .map(str::to_string)
            };
            let current = field
                .get("default")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let valid = options
                .iter()
                .filter_map(value_of)
                .any(|value| value == current);
            if !valid {
                if let Some(first) = options.iter().find_map(value_of) {
                    field.insert("default".to_string(), Value::from(first));
                }
            }
        }
        out.insert(key.clone(), Value::Object(field));
    }
    Ok(out)
}

fn valid_id(id: &str) -> bool {
    let Some(first) = id.chars().next() else {
        return false;
    };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && id.len() <= 64
        && id.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-' || c == '_'
        })
        && !id.contains("..")
}

/// Относительный путь внутри пакета: без корней, `..` и пустых имён.
fn safe_relative(raw: &str) -> Option<PathBuf> {
    let path = Path::new(raw);
    if path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => out.push(name),
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// Файл пакета, который существует и лежит внутри каталога.
fn relative_file(package: &Path, raw: &str) -> Option<PathBuf> {
    let relative = safe_relative(raw)?;
    package.join(&relative).is_file().then_some(relative)
}

/// Определения живут столько же, сколько процесс: каталог и темы читаются из
/// горячего пути снимка состояния и не должны аллоцироваться на каждый кадр.
fn leak(value: Value) -> &'static Value {
    Box::leak(Box::new(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let id = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir()
                .join(format!("ose-plugins-{name}-{}-{id}", std::process::id()));
            fs::remove_dir_all(&dir).ok();
            fs::create_dir_all(&dir).expect("каталог пакетов");
            TempDir(dir)
        }

        fn package(&self, name: &str, files: &[(&str, &str)]) -> PathBuf {
            let dir = self.0.join(name);
            fs::create_dir_all(&dir).expect("пакет");
            for (file, body) in files {
                let path = dir.join(file);
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).ok();
                }
                fs::write(path, body).expect("файл пакета");
            }
            dir
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    fn widget_manifest(extra: &str) -> String {
        format!(
            r#"{{
                "apiVersion": 1,
                "kind": "widget",
                "id": "hello",
                "name": "Привет",
                "description": "Карточка с текстом",
                "version": "1.0.0",
                "author": "Тест",
                "entry": "widget.js",
                "styles": ["widget.css"],
                "defaultGeometry": {{ "x": 40, "y": 30, "w": 20, "h": 10 }},
                "minW": 8,
                "minH": 4,
                "settings": {{
                    "text": {{ "type": "string", "label": "Текст", "default": "Привет" }},
                    "size": {{ "type": "range", "min": 8, "max": 72, "default": 24 }}
                }}
                {extra}
            }}"#
        )
    }

    #[test]
    fn a_widget_package_becomes_a_catalog_type() {
        let temp = TempDir::new("widget");
        temp.package(
            "hello",
            &[
                ("widget.json", widget_manifest("").as_str()),
                ("widget.js", "OSE.defineWidget('hello', class {});"),
                ("widget.css", ".x{}"),
            ],
        );

        let registry = Registry::scan(&temp.0);
        assert!(registry.errors.is_empty(), "{:?}", registry.errors);
        let def = registry.widgets.get("plugin:hello").expect("определение");
        assert_eq!(def["label"], json!("Привет"));
        assert_eq!(def["plugin"], json!(true));
        assert_eq!(
            def["defaultGeometry"],
            json!({"x":40.0,"y":30.0,"w":20.0,"h":10.0})
        );
        assert_eq!(def["defaultConfig"]["text"], json!("Привет"));
        assert_eq!(def["defaultConfig"]["size"], json!(24));
        assert_eq!(def["minW"], json!(8.0));

        let list = &registry.payload()["plugins"][0];
        assert_eq!(list["kind"], json!("widget"));
        assert_eq!(list["type"], json!("plugin:hello"));
        assert_eq!(list["baseUrl"], json!("/plugins/hello/"));
        assert_eq!(list["entry"], json!("widget.js"));
        assert_eq!(list["styles"], json!(["widget.css"]));
    }

    #[test]
    fn a_theme_package_gets_a_namespaced_id_and_tokens() {
        let temp = TempDir::new("theme");
        temp.package(
            "neon",
            &[
                (
                    "theme.json",
                    r##"{
                        "apiVersion": 1,
                        "kind": "theme",
                        "id": "neon",
                        "name": "Neon",
                        "version": "1.0.0",
                        "tokens": { "--md-primary": "#ff00ff", "--md-secondary": "#00ffff" },
                        "css": "theme.css"
                    }"##,
                ),
                ("theme.css", "[data-theme=\"plugin:neon\"] .x{}"),
            ],
        );

        let registry = Registry::scan(&temp.0);
        assert!(registry.errors.is_empty(), "{:?}", registry.errors);
        let theme = registry.themes.get("plugin:neon").expect("тема");
        assert_eq!(theme["builtin"], json!(true));
        assert_eq!(theme["tokens"]["--md-primary"], json!("#ff00ff"));

        let list = &registry.payload()["plugins"][0];
        assert_eq!(list["id"], json!("plugin:neon"));
        assert_eq!(list["css"], json!("theme.css"));
        assert_eq!(list["colors"], json!(["#ff00ff", "#00ffff", Value::Null]));
    }

    #[test]
    fn a_broken_package_does_not_hide_the_rest() {
        let temp = TempDir::new("broken");
        temp.package("bad", &[("widget.json", "{ это не json")]);
        temp.package(
            "hello",
            &[
                ("widget.json", widget_manifest("").as_str()),
                ("widget.js", ""),
                ("widget.css", ".x{}"),
            ],
        );

        let registry = Registry::scan(&temp.0);
        assert_eq!(registry.errors.len(), 1);
        assert_eq!(registry.errors[0]["dir"], json!("bad"));
        assert!(registry.widgets.contains_key("plugin:hello"));
    }

    #[test]
    fn an_entry_outside_the_package_is_refused() {
        let temp = TempDir::new("escape");
        let manifest =
            widget_manifest("").replace("\"entry\": \"widget.js\"", "\"entry\": \"../evil.js\"");
        temp.package("hello", &[("widget.json", manifest.as_str())]);
        fs::write(temp.0.join("evil.js"), "").expect("чужой файл");

        let registry = Registry::scan(&temp.0);
        assert!(!registry.widgets.contains_key("plugin:hello"));
        assert!(registry.errors[0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("entry"));
    }

    #[test]
    fn a_select_default_comes_from_its_first_option() {
        let temp = TempDir::new("select");
        let manifest = widget_manifest("")
            .replace(
                "\"size\": { \"type\": \"range\", \"min\": 8, \"max\": 72, \"default\": 24 }",
                "\"size\": { \"type\": \"range\", \"min\": 8, \"max\": 72, \"default\": 24 },\n                    \"align\": { \"type\": \"select\", \"options\": [\"left\", \"center\"] }",
            );
        temp.package(
            "hello",
            &[
                ("widget.json", manifest.as_str()),
                ("widget.js", ""),
                ("widget.css", ".x{}"),
            ],
        );

        let registry = Registry::scan(&temp.0);
        let def = registry.widgets.get("plugin:hello").expect("определение");
        assert_eq!(def["defaultConfig"]["align"], json!("left"));
    }

    #[test]
    fn a_manifest_without_a_file_is_reported() {
        let temp = TempDir::new("empty");
        temp.package("void", &[("readme.txt", "ничего")]);

        let registry = Registry::scan(&temp.0);
        assert!(registry.widgets.is_empty());
        assert!(registry.payload()["errors"][0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("widget.json"));
    }

    #[test]
    fn an_unknown_setting_type_is_refused() {
        let temp = TempDir::new("settings");
        let manifest = widget_manifest("").replace("\"string\"", "\"телефон\"");
        temp.package(
            "hello",
            &[
                ("widget.json", manifest.as_str()),
                ("widget.js", ""),
                ("widget.css", ".x{}"),
            ],
        );

        let registry = Registry::scan(&temp.0);
        assert!(registry.widgets.is_empty());
        assert!(registry.errors[0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("type"));
    }

    #[test]
    fn an_id_must_match_the_directory() {
        let temp = TempDir::new("id");
        let manifest = widget_manifest("").replace("\"id\": \"hello\"", "\"id\": \"other\"");
        temp.package(
            "hello",
            &[("widget.json", manifest.as_str()), ("widget.js", "")],
        );

        let registry = Registry::scan(&temp.0);
        assert!(registry.widgets.is_empty());
        assert!(registry.errors[0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("именем папки"));
    }

    #[test]
    fn an_unsupported_api_version_is_refused() {
        let temp = TempDir::new("api");
        let manifest = widget_manifest("").replace("\"apiVersion\": 1", "\"apiVersion\": 2");
        temp.package(
            "hello",
            &[("widget.json", manifest.as_str()), ("widget.js", "")],
        );

        let registry = Registry::scan(&temp.0);
        assert!(registry.widgets.is_empty());
        assert!(registry.errors[0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("apiVersion"));
    }

    #[test]
    fn a_missing_directory_is_an_empty_registry() {
        let temp = TempDir::new("absent");
        let registry = Registry::scan(&temp.0.join("nope"));
        assert!(registry.widgets.is_empty());
        assert!(registry.themes.is_empty());
        assert!(registry.errors.is_empty());
    }

    #[test]
    fn geometry_fits_the_canvas() {
        let temp = TempDir::new("geometry");
        let manifest = widget_manifest("")
            .replace("\"x\": 40", "\"x\": 95")
            .replace("\"w\": 20", "\"w\": 30");
        temp.package(
            "hello",
            &[
                ("widget.json", manifest.as_str()),
                ("widget.js", ""),
                ("widget.css", ".x{}"),
            ],
        );

        let registry = Registry::scan(&temp.0);
        let def = registry.widgets.get("plugin:hello").expect("определение");
        assert_eq!(def["defaultGeometry"]["x"], json!(70.0));
        assert_eq!(def["defaultGeometry"]["w"], json!(30.0));
    }
}
