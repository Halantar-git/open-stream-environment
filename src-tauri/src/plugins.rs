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
//! готовые определения хранятся в памяти. Манифесты перечитываются по запросу
//! `/api/plugins`: панель и оверлей спрашивают его при загрузке страницы,
//! поэтому новый пакет виден без перезапуска приложения — хватает обновить
//! страницу или источник в OBS.
//!
//! Безопасность: путь `entry`/`styles`/`css` не может выйти за каталог пакета
//! (никаких `..` и абсолютных путей), идентификатор совпадает с именем папки.
//! Код пакета исполняется в оверлее с полными правами страницы, поэтому ставить
//! можно только доверенные пакеты; песочница — отдельный этап.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Map, Value};
use zip::ZipArchive;

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
    widgets: BTreeMap<String, Value>,
    /// Идентификатор темы (`plugin:<id>`) -> тема в форме `themes.js`.
    themes: BTreeMap<String, Value>,
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
            // Скрытые каталоги — служебные: туда попадает распаковка архива и
            // заменённый старый пакет, пока установка не закончилась.
            .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
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
        // 3D-виджет — тот, который рисует на canvas или в WebGL. Псевдо-3D
        // (перспектива на DOM) остаётся `2d` и в набор темы не попадает.
        let render_type = match text(&manifest, "renderType").as_deref() {
            None | Some("2d") => "2d",
            Some("canvas") => "canvas",
            Some("3d-webgl") => "3d-webgl",
            Some(other) => {
                return Err(format!(
                    "renderType «{other}» неизвестен: 2d, canvas или 3d-webgl"
                ))
            }
        };
        let family = text(&manifest, "theme").unwrap_or_default();
        // Без семейства менеджер виджетов не знает, к какой теме привязать
        // 3D-виджет, и не сможет его включить или выключить вместе с набором.
        if render_type != "2d" && family.is_empty() {
            return Err(
                "3D-виджету (canvas или 3d-webgl) нужно поле theme — семейство темы".to_string(),
            );
        }
        let dimension = if render_type == "2d" { "2d" } else { "3d" };

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
            "renderType": render_type,
            "dimension": dimension,
            "theme": family.clone(),
            "defaultGeometry": geometry.clone(),
            "minW": min_w,
            "minH": min_h,
            "defaultConfig": Value::Object(defaults),
            "settings": settings.clone(),
        });
        self.widgets.insert(plugin_type.clone(), def);

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
            "renderType": render_type,
            "dimension": dimension,
            "theme": family,
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

        // Набор 3D-виджетов темы: те же типы, что у своих тем. Без списка тема
        // остаётся 2D, а тумблер «3D» на её карточке не появляется.
        let mut three_d: Vec<Value> = Vec::new();
        for item in array(&manifest, "threeDWidgets") {
            let raw = item
                .as_str()
                .ok_or("threeDWidgets должен перечислять строки")?;
            let kind = raw.trim();
            if kind.is_empty() {
                continue;
            }
            let value = Value::from(kind);
            if !three_d.contains(&value) {
                three_d.push(value);
            }
        }

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
            "threeDWidgets": Value::Array(three_d.clone()),
            "tokens": Value::Object(tokens.clone()),
        });
        self.themes.insert(id.clone(), theme);

        self.list.push(json!({
            "kind": "theme",
            "id": id,
            "pluginId": name,
            "name": title,
            "version": text(&manifest, "version").unwrap_or_default(),
            "author": text(&manifest, "author").unwrap_or_default(),
            "baseUrl": format!("/plugins/{name}/"),
            "css": css,
            "has3d": !three_d.is_empty(),
            "threeDWidgets": three_d,
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

/// Реестр на весь процесс вместе с каталогом, который он читает.
pub struct Plugins {
    dir: PathBuf,
    registry: Mutex<Registry>,
}

static INSTALLED: OnceLock<Plugins> = OnceLock::new();

impl Plugins {
    fn new(dir: &Path) -> Plugins {
        // Пустой каталог создаём: так пользователь видит, куда класть пакет.
        fs::create_dir_all(dir).ok();
        let registry = Registry::scan(dir);
        report_errors(&registry);
        Plugins {
            dir: dir.to_path_buf(),
            registry: Mutex::new(registry),
        }
    }

    /// Перечитать манифесты. Ошибка одного пакета не мешает остальным: новый
    /// реестр заменяет старый целиком, поэтому удалённые пакеты тоже исчезают.
    pub fn refresh(&self) {
        let registry = Registry::scan(&self.dir);
        report_errors(&registry);
        *self.lock() = registry;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.registry
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn payload(&self) -> Value {
        self.lock().payload()
    }

    fn widget_def(&self, kind: &str) -> Option<Value> {
        self.lock().widgets.get(kind).cloned()
    }

    fn theme(&self, id: &str) -> Option<Value> {
        self.lock().themes.get(id).cloned()
    }

    fn themes(&self) -> Vec<Value> {
        self.lock().themes.values().cloned().collect()
    }
}

fn report_errors(registry: &Registry) {
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
}

/// Поставить реестр на весь процесс. Повторный вызов возвращает первый.
pub fn install(dir: &Path) -> &'static Plugins {
    INSTALLED.get_or_init(|| Plugins::new(dir))
}

/// Перечитать пакеты из каталога, если реестр уже поставлен.
pub fn refresh() {
    if let Some(plugins) = INSTALLED.get() {
        plugins.refresh();
    }
}

/// Определение виджета из пакета.
pub fn widget_def(kind: &str) -> Option<Value> {
    INSTALLED.get()?.widget_def(kind)
}

/// Тема из пакета.
pub fn theme(id: &str) -> Option<Value> {
    INSTALLED.get()?.theme(id)
}

/// Темы пакетов в порядке имени папки.
pub fn themes() -> Vec<Value> {
    INSTALLED.get().map(Plugins::themes).unwrap_or_default()
}

/// Ответ `/api/plugins` из установленного реестра.
pub fn api_payload() -> Value {
    match INSTALLED.get() {
        Some(plugins) => plugins.payload(),
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

// ---- установка из архива ----

/// Сколько принимается архив и сколько — распакованные файлы. Пакет — это код
/// и картинки; всё, что больше, похоже на попытку забить диск, а не на виджет.
pub(crate) const MAX_ARCHIVE_BYTES: usize = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 32 * 1024 * 1024;
/// Столько файлов в honest-пакете не бывает: ограничение режет архивы-бомбы.
const MAX_ENTRIES: usize = 512;

static INSTALL_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

/// Установка — это распаковка во временную папку и переименование. Два
/// одновременных архива перемешали бы временные файлы, поэтому пускаем по одному.
static INSTALLING: Mutex<()> = Mutex::new(());

/// Установить пакет из zip-архива в каталог пакетов.
///
/// Архив — ровно один пакет: манифест в корне или в единственной папке. Пути
/// проверяются до распаковки (никаких `..` и абсолютных путей), а манифест —
/// теми же правилами, что и при чтении с диска: битый пакет на диск не ляжет.
/// Пакет с тем же `id` заменяется в одном шаге, без ручного удаления папки.
pub fn install_zip(dir: &Path, bytes: &[u8]) -> Result<Value, String> {
    let _guard = INSTALLING.lock().unwrap_or_else(|error| error.into_inner());
    if bytes.is_empty() {
        return Err("архив пустой".to_string());
    }
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "архив больше {} МБ",
            MAX_ARCHIVE_BYTES / (1024 * 1024)
        ));
    }
    let mut archive = ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("это не zip-архив: {error}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err(format!("в архиве больше {MAX_ENTRIES} файлов"));
    }

    // Первый проход — только имена и размеры: путь проверяется до того, как хоть
    // один файл ляжет на диск.
    let mut entries: Vec<(usize, String, u64)> = Vec::new();
    let mut declared = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("архив повреждён: {error}"))?;
        if entry.is_dir() {
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!(
                "символические ссылки в архиве не поддерживаются: {}",
                entry.name()
            ));
        }
        let Some(relative) = safe_relative(entry.name()) else {
            return Err(format!("недопустимый путь в архиве: {}", entry.name()));
        };
        let name = relative.to_string_lossy().replace('\\', "/");
        if junk(&name) {
            continue;
        }
        declared = declared.saturating_add(entry.size());
        if declared > MAX_UNPACKED_BYTES {
            return Err(format!(
                "распакованный пакет больше {} МБ",
                MAX_UNPACKED_BYTES / (1024 * 1024)
            ));
        }
        entries.push((index, name, entry.size()));
    }
    if entries.is_empty() {
        return Err("в архиве нет файлов".to_string());
    }

    let root = package_root(&entries)?;
    let sequence = INSTALL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = dir.join(format!(".incoming-{}-{sequence}", std::process::id()));
    fs::remove_dir_all(&temp).ok();
    fs::create_dir_all(&temp).map_err(|error| format!("временный каталог: {error}"))?;

    let result = extract_and_place(dir, &temp, &root, &mut archive, &entries);
    fs::remove_dir_all(&temp).ok();
    result
}

/// Служебные файлы Finder и Windows в пакете не нужны: из-за `__MACOSX` архив
/// перестал бы выглядеть как «одна папка», и установка отвергла бы годный пакет.
fn junk(name: &str) -> bool {
    name.split('/').any(|part| {
        part == "__MACOSX" || part == ".DS_Store" || part == "Thumbs.db" || part.starts_with("._")
    })
}

/// Общая папка пакета внутри архива: пустая строка — манифест лежит в корне,
/// иначе единственная папка, в которой он есть.
fn package_root(entries: &[(usize, String, u64)]) -> Result<String, String> {
    if entries
        .iter()
        .any(|(_, name, _)| name == WIDGET_FILE || name == THEME_FILE)
    {
        return Ok(String::new());
    }
    let mut roots: Vec<&str> = entries
        .iter()
        .filter_map(|(_, name, _)| name.split('/').next())
        .collect();
    roots.sort_unstable();
    roots.dedup();
    if roots.len() != 1 {
        return Err(
            "в архиве должно быть ровно одно: манифест в корне или одна папка с ним".to_string(),
        );
    }
    let root = roots[0].to_string();
    let widget = format!("{root}/{WIDGET_FILE}");
    let theme = format!("{root}/{THEME_FILE}");
    if !entries
        .iter()
        .any(|(_, name, _)| *name == widget || *name == theme)
    {
        return Err(format!(
            "{WIDGET_FILE} или {THEME_FILE} должен лежать в корне архива или в единственной папке"
        ));
    }
    Ok(root)
}

fn extract_and_place<R: std::io::Read + std::io::Seek>(
    dir: &Path,
    temp: &Path,
    root: &str,
    archive: &mut ZipArchive<R>,
    entries: &[(usize, String, u64)],
) -> Result<Value, String> {
    let mut written = 0u64;
    for (index, name, _) in entries {
        let mut entry = archive
            .by_index(*index)
            .map_err(|error| format!("архив повреждён: {error}"))?;
        let target = temp.join(name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("каталог {}: {error}", parent.display()))?;
        }
        let mut file =
            fs::File::create(&target).map_err(|error| format!("файл {name}: {error}"))?;
        let copied = std::io::copy(&mut entry, &mut file)
            .map_err(|error| format!("файл {name}: {error}"))?;
        // Заявленный в заголовке размер может врать: считаем, сколько реально
        // записали, и обрываем распаковку на пределе.
        written = written.saturating_add(copied);
        if written > MAX_UNPACKED_BYTES {
            return Err(format!(
                "распакованный пакет больше {} МБ",
                MAX_UNPACKED_BYTES / (1024 * 1024)
            ));
        }
    }

    let package = if root.is_empty() {
        temp.to_path_buf()
    } else {
        temp.join(root)
    };
    let widget = package.join(WIDGET_FILE).is_file();
    let theme = package.join(THEME_FILE).is_file();
    let manifest_file = match (widget, theme) {
        (true, true) => {
            return Err(format!(
                "в пакете два манифеста: {WIDGET_FILE} и {THEME_FILE}"
            ))
        }
        (true, false) => WIDGET_FILE,
        (false, true) => THEME_FILE,
        (false, false) => return Err(format!("нет ни {WIDGET_FILE}, ни {THEME_FILE}")),
    };
    let manifest = read_manifest(&package.join(manifest_file))?;
    let id = text(&manifest, "id").unwrap_or_default();
    if !valid_id(&id) {
        return Err(
            "id в манифесте должен быть латиницей в нижнем регистре: a-z, 0-9, «.», «-», «_»"
                .to_string(),
        );
    }
    if !root.is_empty() && root != id {
        return Err(format!("папка «{root}» в архиве не совпадает с id «{id}»"));
    }
    // Тот же разбор, что и при чтении каталога: пакет с битым entry, стилями
    // или настройкой не должен оказаться на диске.
    let mut probe = Registry::default();
    probe.read_package(&id, &package)?;

    let target = dir.join(&id);
    let replaced = target.exists();
    let backup = if replaced {
        let sequence = INSTALL_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let backup = dir.join(format!(".replaced-{}-{sequence}", std::process::id()));
        fs::rename(&target, &backup)
            .map_err(|error| format!("не удалось заменить «{id}»: {error}"))?;
        Some(backup)
    } else {
        None
    };
    let placed = if root.is_empty() {
        fs::rename(temp, &target)
    } else {
        fs::rename(&package, &target)
    };
    if let Err(error) = placed {
        // Старый пакет возвращается на место: неудачная установка не должна
        // оставить пользователя без работающего виджета.
        if let Some(backup) = &backup {
            fs::rename(backup, &target).ok();
        }
        return Err(format!("не удалось установить «{id}»: {error}"));
    }
    if let Some(backup) = backup {
        fs::remove_dir_all(backup).ok();
    }
    refresh();
    Ok(json!({
        "id": id,
        "kind": if widget { "widget" } else { "theme" },
        "replaced": replaced,
    }))
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

    /// Примеры из репозитория проходят тот же разбор, что и установленные
    /// пакеты: иначе документация обещает рабочий пример, а загрузчик его
    /// отвергает — и узнаётся это только у пользователя.
    #[test]
    fn the_repository_examples_are_valid_packages() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/examples/plugins");
        let registry = Registry::scan(&dir);
        assert!(registry.errors.is_empty(), "{:?}", registry.errors);
        assert!(registry.widgets.contains_key("plugin:last-donation"));
        assert!(registry.widgets.contains_key("plugin:hello"));
        assert!(registry.themes.contains_key("plugin:plain-theme"));
    }

    /// Новый пакет виден после перечитывания, а удалённый — исчезает: именно это
    /// делает `/api/plugins`, когда страница панели или оверлея открывается.
    #[test]
    fn a_package_appears_and_disappears_without_a_restart() {
        let temp = TempDir::new("refresh");
        let plugins = Plugins::new(&temp.0);
        assert!(plugins.widget_def("plugin:hello").is_none());

        let manifest = widget_manifest("");
        temp.package(
            "hello",
            &[
                ("widget.json", manifest.as_str()),
                ("widget.js", ""),
                ("widget.css", ".x{}"),
            ],
        );
        plugins.refresh();
        assert!(plugins.widget_def("plugin:hello").is_some());

        fs::remove_dir_all(temp.0.join("hello")).expect("удаление пакета");
        plugins.refresh();
        assert!(plugins.widget_def("plugin:hello").is_none());
    }

    /// 3D-виджет получает семейство темы и размерность: по ним менеджер
    /// виджетов решает, включать ли его вместе с набором темы.
    #[test]
    fn a_three_d_widget_keeps_its_render_type_and_family() {
        let temp = TempDir::new("3d");
        let manifest = json!({
            "apiVersion": 1,
            "kind": "widget",
            "id": "orbit-test-3d",
            "name": "Ring",
            "entry": "widget.js",
            "renderType": "canvas",
            "theme": "orbit_test"
        })
        .to_string();
        temp.package(
            "orbit-test-3d",
            &[("widget.json", manifest.as_str()), ("widget.js", "")],
        );

        let registry = Registry::scan(&temp.0);
        assert!(registry.errors.is_empty(), "{:?}", registry.errors);
        let def = registry
            .widgets
            .get("plugin:orbit-test-3d")
            .expect("определение");
        assert_eq!(def["renderType"], json!("canvas"));
        assert_eq!(def["dimension"], json!("3d"));
        assert_eq!(def["theme"], json!("orbit_test"));

        let list = &registry.payload()["plugins"][0];
        assert_eq!(list["renderType"], json!("canvas"));
        assert_eq!(list["dimension"], json!("3d"));
        assert_eq!(list["theme"], json!("orbit_test"));
    }

    #[test]
    fn a_canvas_widget_without_a_family_is_refused() {
        let temp = TempDir::new("3d-no-family");
        let manifest = json!({
            "apiVersion": 1,
            "kind": "widget",
            "id": "ring",
            "name": "Ring",
            "entry": "widget.js",
            "renderType": "canvas"
        })
        .to_string();
        temp.package(
            "ring",
            &[("widget.json", manifest.as_str()), ("widget.js", "")],
        );

        let registry = Registry::scan(&temp.0);
        assert!(registry.widgets.is_empty());
        assert!(registry.errors[0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("theme"));
    }

    #[test]
    fn an_unknown_render_type_is_refused() {
        let temp = TempDir::new("render-type");
        let manifest = widget_manifest("").replace(
            "\"entry\": \"widget.js\",",
            "\"entry\": \"widget.js\", \"renderType\": \"dom\",",
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
        assert!(registry.widgets.is_empty());
        assert!(registry.errors[0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("renderType"));
    }

    #[test]
    fn a_theme_lists_its_three_d_widgets() {
        let temp = TempDir::new("3d-theme");
        let manifest = json!({
            "apiVersion": 1,
            "kind": "theme",
            "id": "orbit_test",
            "name": "Orbit Test",
            "tokens": { "--md-primary": "#00f0ff" },
            "threeDWidgets": ["plugin:orbit-test-3d", "plugin:orbit-test-3d", ""]
        })
        .to_string();
        temp.package("orbit_test", &[("theme.json", manifest.as_str())]);

        let registry = Registry::scan(&temp.0);
        assert!(registry.errors.is_empty(), "{:?}", registry.errors);
        let theme = registry.themes.get("plugin:orbit_test").expect("тема");
        assert_eq!(theme["threeDWidgets"], json!(["plugin:orbit-test-3d"]));

        let list = &registry.payload()["plugins"][0];
        assert_eq!(list["has3d"], json!(true));
        assert_eq!(list["threeDWidgets"], json!(["plugin:orbit-test-3d"]));
    }

    fn zip_bytes(files: &[(&str, &str)]) -> Vec<u8> {
        use std::io::Write;
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, body) in files {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .expect("файл в архиве");
            writer.write_all(body.as_bytes()).expect("тело файла");
        }
        writer.finish().expect("архив").into_inner()
    }

    /// Временные каталоги установки не должны оставаться рядом с пакетами:
    /// `Registry::scan` их пропускает, но мусор в данных пользователя ни к чему.
    fn hidden_leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .expect("каталог пакетов")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with('.'))
            .collect()
    }

    #[test]
    fn an_archive_installs_a_package_with_its_folder() {
        let temp = TempDir::new("install");
        let manifest = widget_manifest("");
        let archive = zip_bytes(&[
            ("hello/widget.json", manifest.as_str()),
            ("hello/widget.js", "OSE.defineWidget('hello', class {});"),
            ("hello/widget.css", ".x{}"),
            // Служебная папка Finder не должна ломать «одну папку в архиве».
            ("__MACOSX/hello/._widget.json", "junk"),
        ]);

        let installed = install_zip(&temp.0, &archive).expect("установка");
        assert_eq!(installed["id"], json!("hello"));
        assert_eq!(installed["kind"], json!("widget"));
        assert_eq!(installed["replaced"], json!(false));
        assert!(temp.0.join("hello/widget.js").is_file());
        assert!(!temp.0.join("__MACOSX").exists());
        assert!(hidden_leftovers(&temp.0).is_empty());
    }

    #[test]
    fn a_flat_archive_takes_the_id_from_the_manifest() {
        let temp = TempDir::new("flat");
        let manifest = widget_manifest("");
        let archive = zip_bytes(&[
            ("widget.json", manifest.as_str()),
            ("widget.js", ""),
            ("widget.css", ".x{}"),
        ]);

        install_zip(&temp.0, &archive).expect("установка");
        assert!(temp.0.join("hello/widget.json").is_file());
    }

    #[test]
    fn a_path_outside_the_package_is_refused() {
        let temp = TempDir::new("slip");
        let manifest = widget_manifest("");
        let archive = zip_bytes(&[
            ("hello/widget.json", manifest.as_str()),
            ("hello/widget.js", ""),
            ("hello/../../evil.txt", "x"),
        ]);

        let error = install_zip(&temp.0, &archive).expect_err("путь вне пакета");
        assert!(error.contains("недопустимый путь"), "{error}");
        assert!(!temp.0.parent().unwrap().join("evil.txt").exists());
        assert!(!temp.0.join("hello").exists());
    }

    #[test]
    fn an_archive_folder_must_match_the_manifest_id() {
        let temp = TempDir::new("mismatch");
        let manifest = widget_manifest("");
        let archive = zip_bytes(&[
            ("other/widget.json", manifest.as_str()),
            ("other/widget.js", ""),
        ]);

        let error = install_zip(&temp.0, &archive).expect_err("имя папки");
        assert!(error.contains("не совпадает с id"), "{error}");
        assert!(!temp.0.join("other").exists());
        assert!(hidden_leftovers(&temp.0).is_empty());
    }

    #[test]
    fn a_broken_package_is_not_left_on_disk() {
        let temp = TempDir::new("broken-zip");
        let archive = zip_bytes(&[
            ("hello/widget.json", "{\"apiVersion\": 1}"),
            ("hello/widget.js", ""),
        ]);

        assert!(install_zip(&temp.0, &archive).is_err());
        assert!(!temp.0.join("hello").exists());
        assert!(hidden_leftovers(&temp.0).is_empty());
    }

    #[test]
    fn installing_the_same_id_replaces_the_package() {
        let temp = TempDir::new("replace");
        let manifest = widget_manifest("");
        let first = zip_bytes(&[
            ("hello/widget.json", manifest.as_str()),
            ("hello/widget.js", "first"),
            ("hello/widget.css", ".x{}"),
        ]);
        install_zip(&temp.0, &first).expect("первая установка");

        let second = zip_bytes(&[
            ("hello/widget.json", manifest.as_str()),
            ("hello/widget.js", "second"),
            ("hello/widget.css", ".x{}"),
        ]);
        let installed = install_zip(&temp.0, &second).expect("замена");
        assert_eq!(installed["replaced"], json!(true));
        assert_eq!(
            fs::read_to_string(temp.0.join("hello/widget.js")).unwrap(),
            "second"
        );
        assert!(hidden_leftovers(&temp.0).is_empty());
    }
}
