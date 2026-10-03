//! Отчёт для поддержки: сборка и чистка всего, что уезжает наружу.
//!
//! Порт `server/support-bundle.js` целиком. [`build_support_bundle`] собирает
//! отчёт из уже посчитанных частей, [`render_support_bundle`] превращает его в
//! текст, который читают глазами, — по нему разбирают «что-то не работает» без
//! переписки на десять сообщений.
//!
//! Защита в два слоя, и оба живут здесь:
//!
//! 1. Сборка берёт настройки по явному списку полей ([`summarize_config`]), так
//!    что сырой `config.json` в отчёт не попадает вообще: вместо значений
//!    секретов там пометки «поле заполнено/пусто».
//! 2. [`sanitize`] проходит по **готовому** отчёту: ключи вида `*secret*`,
//!    `*token*`, `*password*` заменяются на «<скрыто>», а в строках маскируются
//!    значения `enc:…`, `?token=…`, `Bearer …` и путь к домашнему каталогу (путь
//!    выдаёт имя пользователя в системе).
//!
//! Регулярные выражения из JS разобраны руками: правила короткие, а тащить
//! `regex` ради трёх шаблонов — лишняя зависимость в пути, который работает
//! при формировании архива.
//!
//! Ввод-вывод здесь минимальный и весь — чтение: каталоги данных и логов, хвост
//! сегодняшнего журнала, содержимое свежего отчёта о падении. Всё остальное
//! (здоровье, целостность, образцы долгого прогона) приходит уже посчитанным.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};
use serde_json::{json, Map, Value};

use super::crash_guard;
use super::health::{self, HealthContext};
use super::history::{js_key, js_truthy, number_value};
use super::integrity::{self, BackupSlot, RecoveryEvent, RecoveryKind};
use super::logger;
use super::longrun::LongRunSnapshot;

/// Метка «здесь было скрытое значение».
pub const HIDDEN: &str = "<скрыто>";

/// Как далеко вглубь заглядывает чистка: дальше — уже не отчёт, а мусор.
pub const MAX_DEPTH: usize = 12;

/// Ключи, содержимое которых в отчёт не идёт в принципе.
const SECRET_KEY_PARTS: [&str; 8] = [
    "secret",
    "token",
    "password",
    "passwd",
    "apikey",
    "authorization",
    "credential",
    "cookie",
];

/// Похоже ли имя поля на секрет (`SECRET_KEY` из JS).
pub fn is_secret_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    SECRET_KEY_PARTS.iter().any(|part| lower.contains(part)) || has_api_key(&lower)
}

/// `api[_-]?key`: «api», необязательный разделитель и «key».
fn has_api_key(text: &str) -> bool {
    text.match_indices("api").any(|(index, _)| {
        let tail = &text[index + "api".len()..];
        let tail = tail
            .strip_prefix('_')
            .or_else(|| tail.strip_prefix('-'))
            .unwrap_or(tail);
        tail.starts_with("key")
    })
}

/// Рекурсивная чистка готового отчёта — второй слой защиты.
///
/// Слишком глубокую вложенность не режем, а помечаем: так видно, что данные
/// были, но отчёт от этого не раздувается.
pub fn sanitize(value: &Value) -> Value {
    sanitize_depth(value, 0)
}

fn sanitize_depth(value: &Value, depth: usize) -> Value {
    if depth > MAX_DEPTH {
        return Value::from("<слишком глубоко>");
    }
    match value {
        Value::Null => Value::Null,
        Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(text) => Value::from(mask_text(text)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| sanitize_depth(item, depth + 1))
                .collect(),
        ),
        Value::Object(fields) => {
            let mut out = Map::new();
            for (key, entry) in fields {
                if is_secret_key(key) {
                    out.insert(key.clone(), Value::from(HIDDEN));
                } else {
                    out.insert(key.clone(), sanitize_depth(entry, depth + 1));
                }
            }
            Value::Object(out)
        }
    }
}

/// Сколько записей в значении: массив — его длина, всё остальное — ноль.
pub fn count(value: &Value) -> usize {
    value.as_array().map(Vec::len).unwrap_or(0)
}

/// Код доступа в отчёт не идёт — только сам код, если он правильной формы.
///
/// Пустая строка означает «кода нет»: так в отчёте видно, защищена ли локальная
/// сеть, но сам код не утекает.
pub fn normalize_access_code(value: &Value) -> String {
    let token = value.as_str().map(str::trim).unwrap_or_default();
    let valid = (16..=64).contains(&token.len())
        && token
            .chars()
            .all(|symbol| symbol.is_ascii_alphanumeric() || symbol == '_' || symbol == '-');
    if valid {
        token.to_string()
    } else {
        String::new()
    }
}

/// Маскировать домашний каталог в тексте: путь выдаёт имя пользователя.
pub fn mask_home(text: &str) -> String {
    let mut out = text.to_string();
    for home in home_paths() {
        if home.is_empty() {
            continue;
        }
        out = out.replace(&home, "~");
    }
    out
}

/// Домашний каталог в двух видах: как его даёт система и со слэшами вперёд.
///
/// Сама система отдаёт разное: на Windows — `USERPROFILE`, на остальных — `HOME`.
/// Ошибок не возвращаем: нет каталога — маскировать нечего.
fn home_paths() -> Vec<String> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let native = home.to_string_lossy().into_owned();
    let mut paths = vec![native.clone()];
    let forward = native.replace('\\', "/");
    if forward != native {
        paths.push(forward);
    }
    paths
}

fn home_dir() -> Option<PathBuf> {
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        if !profile.is_empty() {
            return Some(PathBuf::from(profile));
        }
    }
    match (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH")) {
        (Some(drive), Some(path)) if !path.is_empty() => {
            let mut full = PathBuf::from(drive);
            full.push(path);
            Some(full)
        }
        _ => std::env::var_os("HOME")
            .filter(|home| !home.is_empty())
            .map(PathBuf::from),
    }
}

/// Маскировать секреты внутри текста: значения в шифрованном виде, токены в
/// URL и `Bearer`-заголовки.
pub fn mask_text(text: &str) -> String {
    let masked = mask_bearer(&mask_url_tokens(&mask_encrypted(text)));
    mask_home(&masked)
}

/// `enc:[A-Za-z0-9+/=]+` → `enc:<скрыто>`.
fn mask_encrypted(text: &str) -> String {
    replace_runs(text, "enc:", |symbol| {
        symbol.is_ascii_alphanumeric() || symbol == '+' || symbol == '/' || symbol == '='
    })
}

/// `([?&](access_token|refresh_token|token|client_secret|api_key|code)=)…` →
/// `$1<скрыто>`.
fn mask_url_tokens(text: &str) -> String {
    const NAMES: [&str; 6] = [
        "access_token",
        "refresh_token",
        "token",
        "client_secret",
        "api_key",
        "code",
    ];
    let mut out = String::with_capacity(text.len());
    // Всё, что не изменено, копируется целыми кусками: текст может быть любым,
    // включая кириллицу в именах пользователей и в сообщениях чата.
    let mut cursor = 0;
    let bytes = text.as_bytes();
    let mut index = 0;

    while index < text.len() {
        let current = bytes[index];
        if current == b'?' || current == b'&' {
            // Нашли начало параметра: имя до «=».
            let name_start = index + 1;
            if let Some(equals) = text[name_start..].find('=') {
                let name = &text[name_start..name_start + equals];
                if NAMES.iter().any(|known| name.eq_ignore_ascii_case(known)) {
                    let value_start = name_start + equals + 1;
                    // Значение кончается на разделителе — как `[^&\s"']+`.
                    let value_end = text[value_start..]
                        .find(['&', ' ', '\t', '\n', '\r', '"', '\''])
                        .map(|offset| value_start + offset)
                        .unwrap_or(text.len());
                    out.push_str(&text[cursor..value_start]);
                    out.push_str(HIDDEN);
                    cursor = value_end;
                    index = value_end;
                    continue;
                }
            }
        }
        // Пропускаем текущий символ целиком, а не один байт.
        index += text[index..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
    }

    out.push_str(&text[cursor..]);
    out
}

/// `(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}` → `Bearer <скрыто>`.
fn mask_bearer(text: &str) -> String {
    // Сравниваем байтами: нарезка строки по длине слова упала бы на кириллице,
    // а само слово — ASCII.
    const WORD: &[u8; 6] = b"bearer";
    let mut out = String::with_capacity(text.len());
    let mut index = 0;

    while index < text.len() {
        let rest = &text[index..];
        let matched =
            rest.len() >= WORD.len() && rest.as_bytes()[..WORD.len()].eq_ignore_ascii_case(WORD);
        if !matched {
            let symbol = rest.chars().next().unwrap_or_default();
            out.push(symbol);
            index += symbol.len_utf8();
            continue;
        }

        // После слова — пробел и токен: без пробела (и без длины токена) это
        // обычный текст, его не трогаем и пишем как было.
        let tail = &rest[WORD.len()..];
        let whitespace = tail.len() - tail.trim_start().len();
        if whitespace == 0 {
            out.push_str(&rest[..WORD.len()]);
            index += WORD.len();
            continue;
        }
        let token = tail[whitespace..]
            .find(|symbol: char| !is_bearer_symbol(symbol))
            .unwrap_or(tail.len() - whitespace);
        if token < 8 {
            out.push_str(&rest[..WORD.len() + whitespace]);
            index += WORD.len() + whitespace;
            continue;
        }

        out.push_str(&rest[..WORD.len() + whitespace]);
        out.push_str(HIDDEN);
        index += WORD.len() + whitespace + token;
    }
    out
}

/// Символы, из которых состоит токен в заголовке авторизации.
fn is_bearer_symbol(symbol: char) -> bool {
    symbol.is_ascii_alphanumeric() || matches!(symbol, '.' | '_' | '~' | '+' | '/' | '=' | '-')
}

/// Заменить «префикс + непрерывный ряд символов» на «префикс + <скрыто>».
fn replace_runs(text: &str, prefix: &str, is_symbol: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut index = 0;

    while index < text.len() {
        let rest = &text[index..];
        if !rest.starts_with(prefix) {
            let symbol = rest.chars().next().unwrap_or_default();
            out.push(symbol);
            index += symbol.len_utf8();
            continue;
        }

        let tail = &rest[prefix.len()..];
        let run = tail
            .find(|symbol: char| !is_symbol(symbol))
            .unwrap_or(tail.len());
        out.push_str(prefix);
        if run == 0 {
            // Значения нет — это не наше «enc:…», а обычный текст.
            index += prefix.len();
            continue;
        }
        out.push_str(HIDDEN);
        index += prefix.len() + run;
    }
    out
}

/// Путь без имени пользователя — для отчёта, который уходит наружу.
pub fn masked_path(path: &Path) -> String {
    mask_home(&path.to_string_lossy())
}

// ---- сборка отчёта ----

/// Имя приложения в отчёте, если вызывающий не назвал своё.
const DEFAULT_APP: &str = "Open Stream Environment";

/// Что печатается вместо ошибки, когда файла нет.
const NO_FILE: &str = "нет файла";

/// Отметка порядка байтов: блокнот в Windows без неё покажет кракозябры.
const BOM: char = '\u{FEFF}';

/// Сколько строк журнала показывать по умолчанию.
pub const LOG_TAIL_LINES: usize = 300;

/// Сколько строк отчёта о падении копировать в отчёт.
pub const CRASH_TAIL_LINES: usize = 200;

/// Файл для отчёта: имя, размер и время правки.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    pub name: String,
    pub bytes: u64,
    pub mtime_ms: u64,
}

/// Файлы каталога: только обычные файлы, по возрастанию имени.
///
/// Отсутствие или недоступность каталога — пустой список, а не ошибка: при
/// первом запуске каталога логов ещё нет, и это нормально.
pub fn list_files(dir: Option<&Path>) -> Vec<FileEntry> {
    let Some(dir) = dir else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut out: Vec<FileEntry> = entries
        .flatten()
        .filter_map(|entry| {
            // `fs::metadata` по пути, а не `DirEntry::metadata`: так же, как
            // `statSync` в JS, — каталог показывает, на что ведёт ссылка.
            let metadata = fs::metadata(entry.path()).ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some(FileEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                bytes: metadata.len(),
                mtime_ms: modified_ms(&metadata),
            })
        })
        .collect();
    // `localeCompare` из JS: в отчёте файлы идут по имени, а не как лёг диск.
    out.sort_by(|left, right| left.name.cmp(&right.name));
    out
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// Хвост файла: последние `max_lines` строк и признак обрезки.
///
/// Возвращается готовым куском отчёта (`file`, `totalLines`, `truncated`,
/// `text`) либо ошибкой, если файла нет. Ошибка — это не исключение: отчёт
/// собирается и тогда, когда журнала ещё нет.
pub fn tail_file(file: Option<&Path>, max_lines: usize) -> Value {
    let Some(file) = file else {
        return json!({ "file": Value::Null, "error": NO_FILE });
    };
    let path = masked_path(file);

    let content = match fs::read_to_string(file) {
        Ok(content) => content,
        Err(error) => {
            let message = if error.kind() == std::io::ErrorKind::NotFound {
                NO_FILE.to_string()
            } else {
                error.to_string()
            };
            return json!({ "file": path, "error": message });
        }
    };

    // Правило из JS — `\r?\n`: разбираем только перевод строки, одиночный `\r`
    // остаётся в строке, как и раньше.
    let text = content.replace("\r\n", "\n");
    let lines: Vec<&str> = text.split('\n').collect();
    let total = lines.len();
    // `slice(-0)` в JS отдаёт весь массив — ноль значит «не резать».
    let from = if max_lines == 0 {
        0
    } else {
        total.saturating_sub(max_lines)
    };

    json!({
        "file": path,
        "totalLines": total,
        "truncated": total > max_lines,
        "text": lines[from..].join("\n"),
    })
}

/// Дата для имени суточного журнала: `ose-YYYY-MM-DD.log`.
fn day_stamp(date: &DateTime<Local>) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// Сводка настроек по явному списку полей.
///
/// Сырой `config.json` в отчёт не идёт никогда: значения секретов заменяются на
/// пометку о том, что поле заполнено. По ней видно «токен есть, но не
/// работает», и при этом ничего не утекает.
pub fn summarize_config(config: &Value) -> Value {
    let twitch = field(config, "twitch");
    let donation_alerts = field(config, "donationAlerts");
    let youtube = field(config, "youtube");
    let obs = field(config, "obs");
    let appearance = field(config, "appearance");
    let chat_bot = field(config, "chatBot");
    let goal = field(config, "goal");
    let soundboard = field(config, "soundboard");
    let tts = field(config, "tts");
    let poll = field(config, "poll");
    let editor = field(config, "editor");
    let splash = field(config, "splash");
    let top_donation = field(config, "topDonation");

    let mut filled: Vec<Value> = Vec::new();
    for (source, key, label) in [
        (twitch, "clientSecret", "twitch.clientSecret"),
        (twitch, "userAccessToken", "twitch.userAccessToken"),
        (twitch, "refreshToken", "twitch.refreshToken"),
        (
            donation_alerts,
            "clientSecret",
            "donationAlerts.clientSecret",
        ),
        (donation_alerts, "accessToken", "donationAlerts.accessToken"),
        (youtube, "clientSecret", "youtube.clientSecret"),
        (youtube, "accessToken", "youtube.accessToken"),
        (obs, "password", "obs.password"),
    ] {
        if js_truthy(nested(source, key)) {
            filled.push(Value::from(label));
        }
    }

    json!({
        "language": or_null(field(config, "language")),
        "port": or_null(field(config, "port")),
        "notifications": {
            "sound": not_false(field(config, "notificationSound")),
            "volume": or_null(field(config, "notificationVolume")),
            "repeats": or_null(field(config, "notificationRepeats")),
        },
        "enabled": {
            "twitch": not_false(nested(twitch, "enabled")),
            "donationAlerts": not_false(nested(donation_alerts, "enabled")),
            "youtube": not_false(nested(youtube, "enabled")),
            "obs": js_truthy(nested(obs, "enabled")),
        },
        "twitch": {
            "channel": or_fallback(nested(twitch, "channel"), ""),
            "hasClientId": js_truthy(nested(twitch, "clientId")),
            "hasBroadcasterId": js_truthy(nested(twitch, "broadcasterId")),
        },
        "donationAlerts": {
            "hasClientId": js_truthy(nested(donation_alerts, "clientId")),
            "hasUserId": js_truthy(nested(donation_alerts, "userId")),
        },
        "youtube": {
            "hasClientId": js_truthy(nested(youtube, "clientId")),
            "videoId": or_fallback(nested(youtube, "videoId"), ""),
        },
        "obs": {
            "host": or_fallback(nested(obs, "host"), ""),
            "port": or_null(nested(obs, "port")),
            "sceneMapKeys": object_keys(nested(obs, "sceneMap")),
            "customCommands": nested(obs, "customCommands").map(count).unwrap_or(0),
            "cameraAngles": nested(obs, "cameraAngles").map(count).unwrap_or(0),
            "cameraFilters": nested(obs, "cameraFilters").map(count).unwrap_or(0),
        },
        "goal": {
            "hasTitle": js_truthy(nested(goal, "title")),
            "target": or_null(nested(goal, "target")),
            "currency": or_null(nested(goal, "currency")),
        },
        "soundboard": {
            "enabled": js_truthy(nested(soundboard, "enabled")),
            "volume": or_null(nested(soundboard, "volume")),
            "sounds": nested(soundboard, "sounds").map(count).unwrap_or(0),
        },
        "streamdeck": {
            "icons": object_keys(nested(field(config, "streamdeck"), "icons")),
        },
        "tts": {
            "enabled": js_truthy(nested(tts, "enabled")),
            "volume": or_null(nested(tts, "volume")),
            "lang": or_null(nested(tts, "lang")),
            "hasVoice": js_truthy(nested(tts, "voice")),
        },
        "donationVoice": {
            "enabled": js_truthy(nested(field(config, "donationVoice"), "enabled")),
        },
        "poll": {
            "command": or_fallback(nested(poll, "command"), ""),
            "chartType": or_fallback(nested(poll, "chartType"), ""),
            "options": nested(poll, "options").map(count).unwrap_or(0),
        },
        "chatBot": {
            "enabled": js_truthy(nested(chat_bot, "enabled")),
            "prefix": or_fallback(nested(chat_bot, "prefix"), ""),
            "commands": nested(chat_bot, "commands").map(count).unwrap_or(0),
            "timers": nested(chat_bot, "timers").map(count).unwrap_or(0),
            "moderation": js_truthy(nested(nested(chat_bot, "moderation"), "enabled")),
        },
        "appearance": {
            "activeThemeId": or_null_truthy(nested(appearance, "activeThemeId")),
            "themes": nested(appearance, "customThemes").map(count).unwrap_or(0),
            "themeNames": theme_names(nested(appearance, "customThemes")),
            "enable3d": js_truthy(nested(appearance, "enable3d")),
        },
        "editor": {
            "gridSize": or_null(nested(editor, "gridSize")),
            "snapEnabled": or_null(nested(editor, "snapEnabled")),
            "aspectRatio": or_null(nested(editor, "aspectRatio")),
        },
        "scenes": { "count": object_keys(field(config, "scenes")).len() },
        "hud": {
            "editHotkey": or_fallback(field(config, "hud_edit_hotkey"), ""),
            "chatHotkey": or_fallback(field(config, "chat_hud_hotkey"), ""),
            // Флага «чат поверх игры включён» в настройках нет: окно чата создаёт
            // main.js, а показывает его глобальный хоткей, — здесь только
            // выбранный монитор (`null` — основной).
            "chatHudDisplay": or_null(field(config, "chat_hud_display_id")),
            "chatHud": match field(config, "chatHud") {
                Some(hud) => json!({
                    "width": or_null(field(hud, "width")),
                    "height": or_null(field(hud, "height")),
                    "opacity": or_null(field(hud, "opacity")),
                    "fontSize": or_null(field(hud, "fontSize")),
                }),
                None => Value::Null,
            },
        },
        "twitchRewards": field(config, "twitchRewards").map(count).unwrap_or(0),
        // Пометка вместо самого кода: по ней видно, что доступ из сети настроен.
        "remote": {
            "accessCodeSet": field(config, "remote_token")
                .map(|value| !normalize_access_code(value).is_empty())
                .unwrap_or(false),
        },
        "splash": {
            "hasFile": js_truthy(nested(splash, "file")),
            "duration": or_null(nested(splash, "duration")),
        },
        "topDonation": {
            "hasUser": js_truthy(nested(top_donation, "user")),
            "amount": or_null(nested(top_donation, "amount")),
            "currency": or_null(nested(top_donation, "currency")),
        },
        "filledFields": filled,
    })
}

/// Сводка раскладки: сколько виджетов и каких типов, без координат и содержимого.
pub fn summarize_layout(layout: &Value) -> Value {
    let widgets = layout.as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut by_type: Map<String, Value> = Map::new();
    let mut hidden = 0usize;

    for widget in widgets {
        let kind = field(widget, "type")
            .filter(|value| js_truthy(Some(value)))
            .map(js_key)
            .unwrap_or_else(|| "unknown".to_string());
        let entry = by_type.entry(kind).or_insert_with(|| Value::from(0));
        *entry = Value::from(entry.as_u64().unwrap_or(0) + 1);

        if field(widget, "visible") == Some(&Value::Bool(false)) {
            hidden += 1;
        }
    }

    json!({
        "widgets": widgets.len(),
        "byType": Value::Object(by_type),
        "hidden": hidden,
    })
}

/// Всё, что нужно для сборки отчёта: уже посчитанные части и пути к каталогам.
#[derive(Debug, Default)]
pub struct SupportBundleInput {
    /// Момент сборки; `None` — сейчас. Задаёт `generatedAt` и имя суточного журнала.
    pub now: Option<DateTime<Local>>,
    pub app_name: Option<String>,
    pub version: Option<String>,
    /// Чем запущено приложение; по умолчанию — «tauri».
    pub mode: Option<String>,
    /// Каталог данных: файлы, бэкапы, карантин.
    pub config_dir: Option<PathBuf>,
    /// Каталог журналов: суточный лог, отчёты о падениях.
    pub logs_dir: Option<PathBuf>,
    pub remote_url: Option<String>,
    /// Настройки целиком — в отчёт идёт только [`summarize_config`].
    pub config: Value,
    /// Раскладка оверлея — в отчёт идёт только [`summarize_layout`].
    pub layout: Value,
    /// Здоровье: `storage` — из `Database::storage_stats()`, `writes` из
    /// [`Database::write_stats`](super::db::Database::write_stats),
    /// `security` — счётчики `AuditLog::counters()`.
    pub health: HealthContext,
    /// Последние команды: `AuditLog::recent()`.
    pub audit: Vec<Value>,
    pub longrun: Option<LongRunSnapshot>,
    /// Случаи восстановления за запуск (`integrity::recover_json_file`).
    pub recovery_events: Vec<RecoveryEvent>,
    /// Файлы состояния, для которых показываем слоты копий.
    pub backup_sources: Vec<PathBuf>,
    /// Сколько слотов копий смотреть; по умолчанию — как в целостности.
    pub backup_slots: Option<usize>,
    /// Сколько строк журнала показывать; по умолчанию [`LOG_TAIL_LINES`].
    pub log_lines: Option<usize>,
}

/// Собрать отчёт целиком.
///
/// Ошибок здесь не бывает намеренно: у пользователя, который просит отчёт, уже
/// что-то не работает, и второй отказ был бы издевательством. Нет каталога —
/// раздел пуст, нет файла — в отчёте написано, что файла нет.
pub fn build_support_bundle(input: &SupportBundleInput) -> Value {
    let now = input.now.unwrap_or_else(Local::now);
    let data_files = list_files(input.config_dir.as_deref());
    let logs_files = list_files(input.logs_dir.as_deref());

    let crash_reports: Vec<&FileEntry> = logs_files
        .iter()
        .filter(|file| is_crash_name(&file.name))
        .collect();
    let newest_report = match (input.logs_dir.as_deref(), crash_reports.last()) {
        (Some(dir), Some(entry)) => tail_file(Some(&dir.join(&entry.name)), CRASH_TAIL_LINES),
        _ => Value::Null,
    };

    let log_file = input
        .logs_dir
        .as_ref()
        .map(|dir| dir.join(format!("ose-{}.log", day_stamp(&now))));
    let log_lines = input
        .log_lines
        .filter(|lines| *lines > 0)
        .unwrap_or(LOG_TAIL_LINES);
    let log = tail_file(log_file.as_deref(), log_lines);

    let health = health::build_health_report(&input.health);
    let writes = health.get("writes").cloned().unwrap_or(Value::Null);

    let slots = input
        .backup_slots
        .filter(|slots| *slots > 0)
        .unwrap_or_else(integrity::default_backup_slots);
    let backups: Vec<Value> = input
        .backup_sources
        .iter()
        .flat_map(|file| integrity::describe_backups(file, slots))
        .map(|slot| backup_json(&slot))
        .collect();

    let bundle = json!({
        "generatedAt": logger::iso_from_unix_ms(now.timestamp_millis()).unwrap_or_default(),
        "environment": {
            "app": input.app_name.clone().unwrap_or_else(|| DEFAULT_APP.to_string()),
            "version": input.version.clone().map(Value::from).unwrap_or(Value::Null),
            "mode": input.mode.clone().unwrap_or_else(|| "tauri".to_string()),
            "platform": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
            "memoryMb": crash_guard::memory_rss_mb().unwrap_or(0),
            "pid": std::process::id(),
            // Пути с `~`: имя пользователя в системе в отчёт не идёт.
            "dataDir": input.config_dir.as_deref().map(masked_path).map(Value::from).unwrap_or(Value::Null),
            "logsDir": input.logs_dir.as_deref().map(masked_path).map(Value::from).unwrap_or(Value::Null),
            "remoteUrl": input.remote_url.clone().map(Value::from).unwrap_or(Value::Null),
        },
        "health": health,
        "writes": writes,
        // Последние команды: видно, кто и что переключал (см. `AuditLog`).
        "audit": input.audit,
        // Полная история образцов — именно она отличает «течёт» от «показалось».
        "longrun": input.longrun.as_ref().map(LongRunSnapshot::to_json).unwrap_or(Value::Null),
        "integrity": {
            "recoveryEvents": input.recovery_events.iter().map(recovery_event_json).collect::<Vec<_>>(),
            "backups": backups,
            "quarantined": data_files
                .iter()
                .filter(|file| file.name.contains(".corrupt-"))
                .map(file_entry_json)
                .collect::<Vec<_>>(),
        },
        "crashReports": crash_reports.iter().map(|file| file_entry_json(file)).collect::<Vec<_>>(),
        "newestCrashReport": newest_report,
        "dataFiles": data_files.iter().map(file_entry_json).collect::<Vec<_>>(),
        "logFiles": logs_files.iter().map(file_entry_json).collect::<Vec<_>>(),
        "config": summarize_config(&input.config),
        "layout": summarize_layout(&input.layout),
        "log": log,
    });

    sanitize(&bundle)
}

/// Имя файла отчёта о падении: `crash-*.log`.
fn is_crash_name(name: &str) -> bool {
    name.starts_with("crash-") && name.ends_with(".log")
}

fn iso_ms(timestamp_ms: i64) -> String {
    logger::iso_from_unix_ms(timestamp_ms).unwrap_or_default()
}

fn file_entry_json(entry: &FileEntry) -> Value {
    json!({
        "name": entry.name,
        "bytes": entry.bytes,
        "mtime": iso_ms(entry.mtime_ms as i64),
    })
}

/// Слот копии для отчёта: кроме имени и размера видно, годится ли он, — по этому
/// разбирают «бэкап есть, а восстановиться не удалось».
fn backup_json(slot: &BackupSlot) -> Value {
    json!({
        "name": slot.name,
        "bytes": slot.bytes,
        "mtime": iso_ms(slot.mtime_ms as i64),
        "valid": slot.valid,
        "error": slot.error,
    })
}

fn recovery_event_json(event: &RecoveryEvent) -> Value {
    json!({
        "at": event.at_ms,
        "kind": match event.kind {
            RecoveryKind::RestoredFromBackup => "restored-from-backup",
            RecoveryKind::Unrecoverable => "unrecoverable",
        },
        "file": masked_path(&event.file),
        "label": event.label,
        "reason": event.reason,
        "quarantinePath": event.quarantine_path.as_deref().map(masked_path),
        "backupPath": event.backup_path.as_deref().map(masked_path),
    })
}

/// `value[key]`, если `value` — объект.
fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

/// То же, но от необязательного значения: `value?[key]`.
fn nested<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

/// `x ?? null`: отсутствие и `null` дают `null`, остальное прошло бы как есть.
fn or_null(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => Value::Null,
        Some(value) => value.clone(),
    }
}

/// `x || fallback`: пустое значение заменяется, как `||` в JS.
fn or_fallback(value: Option<&Value>, fallback: &str) -> Value {
    if js_truthy(value) {
        Value::from(value.map(js_key).unwrap_or_default())
    } else {
        Value::from(fallback)
    }
}

/// `x || null` — как `activeThemeId` в сводке настроек.
fn or_null_truthy(value: Option<&Value>) -> Value {
    if js_truthy(value) {
        value.cloned().unwrap_or(Value::Null)
    } else {
        Value::Null
    }
}

/// `x !== false`: отсутствие поля считается «да».
fn not_false(value: Option<&Value>) -> bool {
    !matches!(value, Some(Value::Bool(false)))
}

/// `Object.keys(value)`: только у объекта, иначе пусто.
fn object_keys(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_object)
        .map(|fields| fields.keys().cloned().collect())
        .unwrap_or_default()
}

/// Имена тем: не строки отбрасываются — как `.filter(Boolean)` в JS.
fn theme_names(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|themes| {
            themes
                .iter()
                .filter_map(|theme| {
                    let name = field(theme, "name");
                    js_truthy(name).then(|| Value::from(name.map(js_key).unwrap_or_default()))
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---- текстовое представление ----

/// Человекочитаемый текст: отчёт читают глазами в блокноте, а не парсером.
pub fn render_support_bundle(bundle: &Value) -> String {
    let env = bundle.get("environment").cloned().unwrap_or(Value::Null);
    let health = bundle.get("health").cloned().unwrap_or(Value::Null);
    let integrity = bundle.get("integrity").cloned().unwrap_or(Value::Null);
    let log = bundle.get("log").cloned().unwrap_or(Value::Null);
    let audit: Vec<Value> = array_of(bundle.get("audit"));
    let data_files: Vec<Value> = array_of(bundle.get("dataFiles"));
    let crash_reports: Vec<Value> = array_of(bundle.get("crashReports"));
    let events: Vec<Value> = array_of(integrity.get("recoveryEvents"));

    let env_text = |key: &str| -> String {
        env.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("{BOM}{} — отчёт для поддержки", env_text("app")));
    lines.push(format!("Создан: {}", json_text(bundle.get("generatedAt"))));
    lines.push(String::new());

    lines.push("== Приложение ==".to_string());
    lines.push(field_line("Версия", &or_dash(env.get("version")), 15));
    lines.push(field_line("Режим", &env_text("mode"), 15));
    lines.push(field_line("Платформа", &env_text("platform"), 15));
    lines.push(field_line(
        "Память",
        &format!(
            "{} MB (rss), pid {}",
            json_text(env.get("memoryMb")),
            json_text(env.get("pid"))
        ),
        15,
    ));
    lines.push(field_line(
        "Каталог данных",
        &or_dash(env.get("dataDir")),
        16,
    ));
    lines.push(field_line(
        "Каталог логов",
        &or_dash(env.get("logsDir")),
        16,
    ));
    lines.push(field_line("Web Remote", &or_dash(env.get("remoteUrl")), 15));
    lines.push(String::new());

    lines.push("== Состояние ==".to_string());
    lines.push(field_line(
        "Работает",
        if js_truthy(health.get("ok")) {
            "да"
        } else {
            "нет"
        },
        15,
    ));
    lines.push(field_line(
        "Аптайм",
        &format!("{} с", or_dash(health.get("uptimeSec"))),
        15,
    ));
    lines.push(field_line("Порт", &or_dash(health.get("port")), 15));
    let clients = match health.get("server") {
        Some(server) => json_text(server.get("clients")),
        None => "—".to_string(),
    };
    let by_role = match health.get("server") {
        Some(server) => inline_json(server.get("byRole").unwrap_or(&Value::Null)),
        None => String::new(),
    };
    lines.push(field_line(
        "Клиенты WS",
        &format!("{clients} {by_role}"),
        15,
    ));
    lines.push("  Проблемы:".to_string());
    let problems: Vec<String> = array_of(health.get("problems"))
        .iter()
        .map(|item| json_text(Some(item)))
        .collect();
    lines.push(bullets(&problems));
    lines.push(String::new());
    lines.push(field_line(
        "Интеграции",
        &inline_json(health.get("integrations").unwrap_or(&Value::Null)),
        15,
    ));
    lines.push(field_line("Сессия", &or_json(health.get("session")), 15));
    lines.push(field_line("Лаг loop", &or_json(health.get("perf")), 15));
    lines.push(String::new());

    lines.push("== Хранилище ==".to_string());
    lines.push(pretty_json(&json!({
        "storage": health.get("storage").cloned().unwrap_or(Value::Null),
        "writes": bundle.get("writes").cloned().unwrap_or(Value::Null),
    })));
    lines.push(String::new());

    lines.push("== Долгий прогон ==".to_string());
    match bundle.get("longrun").filter(|value| !value.is_null()) {
        Some(run) => {
            let uptime = run.get("uptimeSec").and_then(Value::as_f64).unwrap_or(0.0);
            lines.push(field_line(
                "Наработка",
                &format!("{:.1} ч", uptime / 3600.0),
                15,
            ));
            lines.push(field_line(
                "Память",
                &format!(
                    "rss {} MB (пик {}), heap {} MB",
                    json_text(run.get("rssMb")),
                    json_text(run.get("peakRssMb")),
                    json_text(run.get("heapUsedMb"))
                ),
                15,
            ));
            lines.push(field_line(
                "Рост памяти",
                &format!(
                    "{} MB/ч по {} образцам",
                    json_text(run.get("growthMbPerHour")),
                    json_text(run.get("samples"))
                ),
                15,
            ));
            lines.push(field_line(
                "Переподключения",
                &format!(
                    "{} {}",
                    json_text(run.get("reconnectsTotal")),
                    inline_json(run.get("reconnects").unwrap_or(&Value::Null))
                ),
                15,
            ));
            let every_ms = run.get("everyMs").and_then(Value::as_f64).unwrap_or(0.0);
            let minutes = (every_ms / 60_000.0).round();
            let minutes = if minutes == 0.0 {
                "—".to_string()
            } else {
                format!("{}", minutes as i64)
            };
            lines.push(field_line("Образцы", &format!("каждые {minutes} мин"), 15));

            let history = array_of(run.get("history"));
            if !history.is_empty() {
                lines.push(
                    "  время, наработка ч, rss MB, heap MB, WS, переподключения, лаг".to_string(),
                );
                for entry in &history {
                    let at = entry
                        .get("at")
                        .and_then(Value::as_i64)
                        .and_then(logger::iso_from_unix_ms)
                        .unwrap_or_default();
                    let uptime = entry
                        .get("uptimeSec")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                    let reconnects: f64 = entry
                        .get("reconnects")
                        .and_then(Value::as_object)
                        .map(|fields| {
                            fields
                                .values()
                                .map(|value| value.as_f64().unwrap_or(0.0))
                                .sum()
                        })
                        .unwrap_or(0.0);
                    lines.push(format!(
                        "  {at}, {:.2}, {}, {}, {}, {}, {}",
                        uptime / 3600.0,
                        json_text(entry.get("rssMb")),
                        json_text(entry.get("heapUsedMb")),
                        json_text(entry.get("wsClients")),
                        js_key(&number_value(reconnects)),
                        json_text(entry.get("lagMaxMs")),
                    ));
                }
            }
        }
        None => lines.push("  нет данных".to_string()),
    }
    lines.push(String::new());

    lines.push("== Целостность ==".to_string());
    lines.push(format!("  Восстановления за запуск: {}", events.len()));
    for event in &events {
        lines.push(format!(
            "   * {}: {} ({})",
            json_text(event.get("kind")),
            json_text(event.get("file")),
            json_text(event.get("reason"))
        ));
    }
    lines.push(format!(
        "  Бэкапы:      {}",
        file_names(&integrity, "backups")
    ));
    lines.push(format!(
        "  Карантин:    {}",
        file_names(&integrity, "quarantined")
    ));
    lines.push(String::new());

    lines.push("== Отчёты о падениях ==".to_string());
    let crash_bullets: Vec<String> = crash_reports
        .iter()
        .map(|file| {
            format!(
                "{} ({} Б, {})",
                json_text(file.get("name")),
                json_text(file.get("bytes")),
                json_text(file.get("mtime"))
            )
        })
        .collect();
    lines.push(bullets(&crash_bullets));
    let newest = bundle
        .get("newestCrashReport")
        .and_then(|report| report.get("text"))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty());
    if let Some(text) = newest {
        lines.push("  --- свежий отчёт ---".to_string());
        lines.push(text.to_string());
    }
    lines.push(String::new());

    lines.push("== Файлы данных ==".to_string());
    let data_bullets: Vec<String> = data_files
        .iter()
        .map(|file| {
            format!(
                "{} — {} Б, {}",
                json_text(file.get("name")),
                json_text(file.get("bytes")),
                json_text(file.get("mtime"))
            )
        })
        .collect();
    lines.push(bullets(&data_bullets));
    lines.push(String::new());

    lines.push(format!("== Журнал команд (последние {}) ==", audit.len()));
    if audit.is_empty() {
        lines.push("  пока пусто".to_string());
    } else {
        lines.push("  время, откуда, роль, команда, детали, ограничено".to_string());
        for entry in &audit {
            let at = entry
                .get("at")
                .and_then(Value::as_i64)
                .and_then(logger::iso_from_unix_ms)
                .unwrap_or_default();
            let origin = if js_truthy(entry.get("external")) {
                "сеть"
            } else {
                "локально"
            };
            let details = match entry.get("details") {
                Some(value) if !value.is_null() => inline_json(value),
                _ => "—".to_string(),
            };
            let limited = if js_truthy(entry.get("limited")) {
                ", да"
            } else {
                ""
            };
            lines.push(format!(
                "  {at}, {origin}, {}, {}, {details}{limited}",
                json_text(entry.get("role")),
                json_text(entry.get("type")),
            ));
        }
    }
    lines.push(String::new());

    lines.push("== Настройки (без секретов) ==".to_string());
    lines.push(pretty_json(bundle.get("config").unwrap_or(&Value::Null)));
    lines.push(String::new());
    lines.push("== Раскладка ==".to_string());
    lines.push(pretty_json(bundle.get("layout").unwrap_or(&Value::Null)));
    lines.push(String::new());

    let total = json_text(log.get("totalLines"));
    let total = if total.is_empty() {
        "0".to_string()
    } else {
        total
    };
    let shown = match log.get("text").and_then(Value::as_str) {
        Some(text) if !text.is_empty() => text.split('\n').count(),
        _ => 0,
    };
    lines.push(format!(
        "== Лог (последние {total} строк, показано {shown}) =="
    ));
    match log
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        Some(text) => lines.push(text.to_string()),
        None => lines.push(format!("  {}", log_error(&log))),
    }
    lines.push(String::new());

    lines.join("\n")
}

/// Поле «Подпись: значение» с выровненной подписью — так отчёт читается глазом.
fn field_line(label: &str, value: &str, width: usize) -> String {
    format!("  {:<width$}{value}", format!("{label}:"), width = width)
}

/// Строки списком; пустой список — это «нет», а не пустое место.
fn bullets(items: &[String]) -> String {
    if items.is_empty() {
        return "  нет".to_string();
    }
    items
        .iter()
        .map(|item| format!("  - {item}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Компактный JSON: для полей, которые живут в одной строке отчёта.
fn inline_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

/// JSON с отступом — для разделов, которые читают построчно.
fn pretty_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string())
}

/// Значение как текст для строки отчёта.
fn json_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_key(value),
    }
}

/// Значение или «—», если его нет.
fn or_dash(value: Option<&Value>) -> String {
    if js_truthy(value) {
        value.map(js_key).unwrap_or_default()
    } else {
        "—".to_string()
    }
}

/// JSON в строку или «—», если значения нет.
fn or_json(value: Option<&Value>) -> String {
    match value {
        Some(value) if !value.is_null() => inline_json(value),
        _ => "—".to_string(),
    }
}

/// Имена файлов из раздела целостности: `нет`, если пусто.
fn file_names(integrity: &Value, key: &str) -> String {
    let names: Vec<String> = array_of(integrity.get(key))
        .iter()
        .map(|item| json_text(item.get("name")))
        .collect();
    let joined = names.join(", ");
    if joined.is_empty() {
        "нет".to_string()
    } else {
        joined
    }
}

fn log_error(log: &Value) -> String {
    match log.get("error") {
        Some(value) if js_truthy(Some(value)) => js_key(value),
        _ => "нет данных".to_string(),
    }
}

/// Значение как массив: не массив и отсутствие дают пустой список.
fn array_of(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn secret_key_names_are_recognized() {
        for key in [
            "clientSecret",
            "access_token",
            "botToken",
            "obsPassword",
            "apiKey",
            "api_key",
            "api-key",
            "Authorization",
            "credentials",
            "cookie",
            "refreshToken",
        ] {
            assert!(is_secret_key(key), "должно быть секретом: {key}");
        }
        for key in ["channel", "port", "username", "language", "obscure"] {
            assert!(!is_secret_key(key), "не секрет: {key}");
        }
    }

    #[test]
    fn encrypted_values_are_masked() {
        assert_eq!(
            mask_text("clientSecret: enc:djEwQUJD+/=="),
            format!("clientSecret: enc:{HIDDEN}")
        );
        // Без значения — обычный текст, ничего не выдумываем.
        assert_eq!(mask_text("поле enc: пустое"), "поле enc: пустое");
    }

    #[test]
    fn url_tokens_are_masked_but_other_parameters_survive() {
        assert_eq!(
            mask_text("http://127.0.0.1:8710/?token=abc123&lang=ru"),
            format!("http://127.0.0.1:8710/?token={HIDDEN}&lang=ru")
        );
        assert_eq!(
            mask_text("?...&client_secret=topsecret"),
            format!("?...&client_secret={HIDDEN}")
        );
        // Обычные параметры не трогаем.
        assert_eq!(mask_text("?port=8710&host=x"), "?port=8710&host=x");
    }

    #[test]
    fn bearer_tokens_are_masked() {
        assert_eq!(
            mask_text("Authorization: Bearer abcdefghijkl.mnop"),
            format!("Authorization: Bearer {HIDDEN}")
        );
        // Короткий «токен» и слово без пробела — не токен.
        assert_eq!(mask_text("Bearer xyz"), "Bearer xyz");
        assert_eq!(mask_text("bearerless text"), "bearerless text");
    }

    #[test]
    fn home_directory_is_masked() {
        let home = home_paths();
        if home.is_empty() {
            return; // в окружении нет домашнего каталога — проверять нечего
        }
        let text = format!("файл: {}/config/config.json", home[0]);
        let masked = mask_home(&text);

        assert!(!masked.contains(&home[0]), "{masked}");
        assert!(masked.starts_with("файл: ~"), "{masked}");
    }

    #[test]
    fn sanitize_replaces_secret_keys_and_recurses() {
        let report = json!({
            "channel": "halantar",
            "twitch": { "clientSecret": "enc:abc", "clientId": "pub" },
            "list": [1, "?token=secretvote", { "botToken": "x" }],
            "numbers": 42,
            "flag": true,
            "nothing": null,
        });

        let clean = sanitize(&report);

        assert_eq!(clean["twitch"]["clientSecret"], json!(HIDDEN));
        assert_eq!(clean["twitch"]["clientId"], json!("pub"));
        assert_eq!(clean["channel"], json!("halantar"));
        assert_eq!(clean["list"][0], json!(1));
        assert_eq!(clean["list"][1], json!(format!("?token={HIDDEN}")));
        assert_eq!(clean["list"][2]["botToken"], json!(HIDDEN));
        assert_eq!(clean["numbers"], json!(42));
        assert_eq!(clean["flag"], json!(true));
        assert_eq!(clean["nothing"], Value::Null);
    }

    #[test]
    fn sanitize_marks_values_that_are_too_deep() {
        // Собираем башню глубже предела.
        let mut deep = json!(1);
        for _ in 0..(MAX_DEPTH + 3) {
            deep = json!({ "level": deep });
        }

        let clean = sanitize(&deep);
        let mut node = &clean;
        for _ in 0..(MAX_DEPTH + 1) {
            node = &node["level"];
        }
        assert_eq!(*node, json!("<слишком глубоко>"));
    }

    #[test]
    fn sanitize_keeps_arrays_and_objects_in_place() {
        let clean = sanitize(&json!([{ "port": 8710 }, [true, null]]));

        assert_eq!(clean, json!([{ "port": 8710 }, [true, null]]));
    }

    #[test]
    fn count_counts_only_arrays() {
        assert_eq!(count(&json!([])), 0);
        assert_eq!(count(&json!([1, 2, 3])), 3);
        assert_eq!(count(&json!("строка")), 0);
        assert_eq!(count(&Value::Null), 0);
        assert_eq!(count(&json!({ "a": 1 })), 0);
    }

    #[test]
    fn access_code_passes_only_in_the_expected_shape() {
        assert_eq!(
            normalize_access_code(&json!("  abcdefghijklmnop  ")),
            "abcdefghijklmnop"
        );
        assert_eq!(normalize_access_code(&json!("short")), "");
        assert_eq!(
            normalize_access_code(&json!("k".repeat(65))),
            "",
            "длиннее 64 символов — не код"
        );
        assert_eq!(normalize_access_code(&json!("плохой-код-12345678")), "");
        assert_eq!(normalize_access_code(&json!(12345)), "");
        assert_eq!(normalize_access_code(&Value::Null), "");
    }

    #[test]
    fn masked_path_hides_the_user_name() {
        let home = home_paths();
        if home.is_empty() {
            return;
        }
        let path = Path::new(&home[0]).join("config").join("config.json");
        let masked = masked_path(&path);

        assert!(masked.starts_with('~'), "{masked}");
        assert!(masked.ends_with("config.json"), "{masked}");
    }

    // ---- отчёт целиком ----

    use crate::storage::async_store::{Stats, StatsSnapshot};
    use crate::storage::longrun::Sample;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const TWITCH_SECRET: &str = "twitch-secret-VALUE";
    const TWITCH_TOKEN: &str = "twitch-token-VALUE";
    const OBS_PASSWORD: &str = "obs-password-VALUE";
    const DA_TOKEN: &str = "da-token-VALUE";
    const ENCODED: &str = "enc:SGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldA==";

    /// Временный каталог с уникальным именем: тесты идут параллельно.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let index = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir()
                .join(format!("ose-bundle-{}-{label}-{index}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            Self(dir)
        }

        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    fn config_with_secrets() -> Value {
        json!({
            "port": 8710,
            "language": "ru",
            "twitch": {
                "channel": "halantar",
                "clientId": "public-client-id",
                "clientSecret": TWITCH_SECRET,
                "userAccessToken": TWITCH_TOKEN,
                "refreshToken": ENCODED,
                "broadcasterId": "12345",
            },
            "donationAlerts": {
                "clientId": "da-client",
                "clientSecret": TWITCH_SECRET,
                "accessToken": DA_TOKEN,
                "userId": "u1",
            },
            "youtube": { "clientId": "yt-client", "clientSecret": "", "accessToken": "", "videoId": "v1" },
            "obs": {
                "enabled": true,
                "host": "127.0.0.1",
                "port": 4455,
                "password": OBS_PASSWORD,
                "sceneMap": { "main": "Scene" },
                "cameraAngles": [{}, {}],
            },
            "goal": { "title": "Донат", "target": 10000, "currency": "RUB" },
            "soundboard": { "enabled": true, "volume": 0.8, "sounds": [{}, {}] },
            "streamdeck": { "icons": { "scene": "a.png", "soundboard": "" } },
            "appearance": { "activeThemeId": "nebula", "enable3d": false, "customThemes": [{ "name": "Моя тема" }] },
            "editor": { "gridSize": 5, "snapEnabled": true, "aspectRatio": "16:9" },
            "chatBot": { "enabled": true, "prefix": "!", "commands": [{}, {}], "timers": [{}], "moderation": { "enabled": true } },
            "poll": { "command": "!poll", "chartType": "bars", "options": [{}, {}] },
            "scenes": { "start": {}, "brb": {} },
            "hud_edit_hotkey": "Control+Shift+H",
            "chatHud": { "enabled": false, "width": 360, "height": 560 },
            "twitchRewards": [{}, {}],
            "splash": { "file": "splash.png", "duration": 3000 },
            "topDonation": { "user": "viewer", "amount": 500, "currency": "RUB" },
        })
    }

    fn health_context() -> HealthContext {
        HealthContext {
            app_name: Some("Open Stream Environment".to_string()),
            version: Some("3.1.0".to_string()),
            uptime_sec: Some(10.0),
            port: Some(8710),
            ws_clients: Some(1),
            ws_by_role: Some(Map::from_iter([("overlay".to_string(), json!(1))])),
            storage: Some(json!({})),
            writes: Some(StatsSnapshot {
                label: "local-db.json".to_string(),
                window: Stats::default(),
                total: Stats {
                    writes: 5,
                    bytes: 100,
                    coalesced: 2,
                    backups: 1,
                    ..Stats::default()
                },
            }),
            perf: Some(health::PerfStats {
                max: Some(1.0),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn longrun_snapshot() -> LongRunSnapshot {
        LongRunSnapshot {
            uptime_sec: 7200,
            every_ms: 600_000,
            samples: 2,
            rss_mb: 140,
            peak_rss_mb: 160,
            heap_used_mb: 70,
            peak_heap_used_mb: 70,
            ws_clients: 2,
            reconnects: Map::from_iter([("twitchChat".to_string(), json!(3))]),
            reconnects_total: 3.0,
            growth_mb_per_hour: 12.5,
            lag_max_ms: 8.0,
            history: vec![
                Sample {
                    at: 1000,
                    uptime_sec: 0,
                    rss_mb: 120,
                    heap_used_mb: 60,
                    ws_clients: 1,
                    reconnects: Map::new(),
                    lag_max_ms: 2.0,
                },
                Sample {
                    at: 3_601_000,
                    uptime_sec: 3600,
                    rss_mb: 140,
                    heap_used_mb: 70,
                    ws_clients: 2,
                    reconnects: Map::from_iter([("twitchChat".to_string(), json!(3))]),
                    lag_max_ms: 8.0,
                },
            ],
        }
    }

    fn recovery_event(data: &TempDir) -> RecoveryEvent {
        RecoveryEvent {
            at_ms: 1_757_000_000_000,
            kind: RecoveryKind::RestoredFromBackup,
            file: data.file("config.json"),
            label: "config.json".to_string(),
            reason: "Unexpected token".to_string(),
            quarantine_path: Some(data.file("config.json.corrupt-20260915-101010")),
            backup_path: Some(data.file("config.json.bak.0")),
        }
    }

    struct Report {
        bundle: Value,
        text: String,
    }

    fn build_in_temp_dirs() -> Report {
        let data = TempDir::new("data");
        let logs = TempDir::new("logs");
        let now = Local::now();
        let stamp = now.format("%Y-%m-%d").to_string();

        fs::write(
            data.file("config.json"),
            json!({ "secret": TWITCH_SECRET }).to_string(),
        )
        .unwrap();
        fs::write(
            data.file("config.json.bak.0"),
            json!({ "port": 8710 }).to_string(),
        )
        .unwrap();
        fs::write(
            data.file("local-db.json.bak.1"),
            json!({ "overlay": { "widgets": [] } }).to_string(),
        )
        .unwrap();
        fs::write(
            data.file("config.json.corrupt-20260915-101010"),
            "битый json",
        )
        .unwrap();
        fs::write(
            logs.file(&format!("ose-{stamp}.log")),
            format!("[info] старт\n[debug] token={ENCODED}\n[info] готово"),
        )
        .unwrap();
        fs::write(
            logs.file("crash-2026-09-15T10-10-10-1-uncaught.log"),
            "TypeError: boom\n  at main.js:1",
        )
        .unwrap();
        fs::write(
            logs.file("recovery-2026-09-15.log"),
            "local-db.json восстановлен",
        )
        .unwrap();

        let input = SupportBundleInput {
            now: Some(now),
            app_name: Some("Open Stream Environment".to_string()),
            version: Some("3.1.0".to_string()),
            config_dir: Some(data.0.clone()),
            logs_dir: Some(logs.0.clone()),
            remote_url: Some("http://192.168.1.10:8710/remote".to_string()),
            config: config_with_secrets(),
            layout: json!([
                { "id": "w1", "type": "chat" },
                { "id": "w2", "type": "goal", "visible": false },
            ]),
            health: health_context(),
            longrun: Some(longrun_snapshot()),
            recovery_events: vec![recovery_event(&data)],
            backup_sources: vec![data.file("config.json"), data.file("local-db.json")],
            ..Default::default()
        };

        let bundle = build_support_bundle(&input);
        let text = render_support_bundle(&bundle);
        Report { bundle, text }
    }

    fn names(items: &Value) -> Vec<String> {
        items
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|item| item["name"].as_str().unwrap_or_default().to_string())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn config_summary_hides_secret_values() {
        let summary = summarize_config(&config_with_secrets()).to_string();

        for secret in [TWITCH_SECRET, TWITCH_TOKEN, OBS_PASSWORD, DA_TOKEN, ENCODED] {
            assert!(!summary.contains(secret), "секрет в сводке: {secret}");
        }
        assert!(!summary.contains("enc:"));
    }

    #[test]
    fn config_summary_marks_filled_fields() {
        let summary = summarize_config(&config_with_secrets());
        let filled = summary["filledFields"].as_array().unwrap();

        assert!(filled.contains(&json!("twitch.clientSecret")));
        assert!(filled.contains(&json!("obs.password")));
        assert_eq!(summary["twitch"]["hasClientId"], json!(true));
        assert!(summary["obs"].get("password").is_none());
        assert!(!summary["filledFields"].to_string().contains(TWITCH_SECRET));
    }

    #[test]
    fn report_contains_no_secret_even_from_the_log() {
        let report = build_in_temp_dirs();

        for secret in [TWITCH_SECRET, TWITCH_TOKEN, OBS_PASSWORD, DA_TOKEN, ENCODED] {
            assert!(!report.text.contains(secret), "секрет в отчёте: {secret}");
        }
        for home in home_paths() {
            assert!(
                !report.text.contains(&home),
                "домашний каталог виден: {home}"
            );
        }
        // Значение в логе маскируется, а имя параметра остаётся читаемым.
        assert!(report.text.contains("token=enc:<скрыто>"));
        assert!(!report.text.contains("SGVsbG8"));
        // Ключи секретов видны — по ним понятно, что поле заполнено.
        assert!(report.text.contains("twitch.clientSecret"));
    }

    #[test]
    fn report_has_every_section() {
        let report = build_in_temp_dirs();

        assert!(report.text.starts_with('\u{FEFF}'));
        for header in [
            "== Приложение ==",
            "== Состояние ==",
            "== Хранилище ==",
            "== Долгий прогон ==",
            "== Целостность ==",
            "== Отчёты о падениях ==",
            "== Файлы данных ==",
            "== Настройки (без секретов) ==",
            "== Раскладка ==",
            "== Лог",
        ] {
            assert!(report.text.contains(header), "нет раздела {header}");
        }
    }

    #[test]
    fn report_shows_backups_quarantine_and_recovery() {
        let report = build_in_temp_dirs();

        assert_eq!(
            names(&report.bundle["integrity"]["backups"]),
            ["config.json.bak.0", "local-db.json.bak.1"]
        );
        assert_eq!(
            names(&report.bundle["integrity"]["quarantined"]),
            ["config.json.corrupt-20260915-101010"]
        );
        assert_eq!(
            report.bundle["integrity"]["recoveryEvents"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(report.text.contains("config.json.bak.0"));
        assert!(report.text.contains("config.json.corrupt-20260915-101010"));
        assert!(report.text.contains("restored-from-backup"));
    }

    #[test]
    fn report_has_today_log_tail_and_newest_crash() {
        let report = build_in_temp_dirs();

        assert_eq!(report.bundle["log"]["totalLines"], json!(3));
        assert!(report.bundle["log"]["text"]
            .as_str()
            .unwrap()
            .contains("готово"));
        assert!(report.bundle["newestCrashReport"]["text"]
            .as_str()
            .unwrap()
            .contains("TypeError: boom"));
        assert!(report.text.contains("TypeError: boom"));
        assert_eq!(
            names(&report.bundle["crashReports"]),
            ["crash-2026-09-15T10-10-10-1-uncaught.log"]
        );
    }

    #[test]
    fn longrun_goes_into_report_with_history() {
        let report = build_in_temp_dirs();

        assert_eq!(report.bundle["longrun"]["samples"], json!(2));
        assert_eq!(
            report.bundle["longrun"]["history"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(report.text.contains("Рост памяти"));
        assert!(report.text.contains("12.5 MB/ч"));
        assert!(report.text.contains("Переподключения"));
        // Строка образца: время, наработка, память, клиенты, переподключения, лаг.
        assert!(
            report
                .text
                .contains("1970-01-01T00:00:01.000Z, 0.00, 120, 60, 1, 0, 2"),
            "строки образца нет в отчёте:\n{}",
            report.text
        );
    }

    #[test]
    fn layout_collapses_into_type_counters() {
        let report = build_in_temp_dirs();

        assert_eq!(
            report.bundle["layout"],
            json!({ "widgets": 2, "byType": { "chat": 1, "goal": 1 }, "hidden": 1 })
        );
        assert_eq!(
            summarize_layout(&Value::Null),
            json!({ "widgets": 0, "byType": {}, "hidden": 0 })
        );
    }

    #[test]
    fn empty_directories_do_not_break_the_build() {
        let data = TempDir::new("empty");
        let input = SupportBundleInput {
            config_dir: Some(data.0.clone()),
            logs_dir: Some(data.file("нет-такого")),
            config: json!({}),
            ..Default::default()
        };

        let bundle = build_support_bundle(&input);
        let text = render_support_bundle(&bundle);

        assert_eq!(bundle["dataFiles"], json!([]));
        assert_eq!(bundle["crashReports"], json!([]));
        assert_eq!(bundle["newestCrashReport"], Value::Null);
        assert!(text.contains("Бэкапы:      нет"));
        assert!(text.contains("нет файла"));
    }

    #[test]
    fn tail_file_returns_tail_and_truncation() {
        let dir = TempDir::new("tail");
        let file = dir.file("log.txt");
        let lines: Vec<String> = (0..500).map(|index| format!("строка {index}")).collect();
        fs::write(&file, lines.join("\n")).unwrap();

        let tail = tail_file(Some(&file), 100);
        let text = tail["text"].as_str().unwrap();

        assert_eq!(tail["totalLines"], json!(500));
        assert_eq!(tail["truncated"], json!(true));
        assert_eq!(text.split('\n').count(), 100);
        assert!(text.contains("строка 499"));
        assert!(!text.contains("строка 0\n"));
    }

    #[test]
    fn tail_file_without_a_file_reports_the_error() {
        let missing = TempDir::new("tail-missing").file("нет.log");
        let result = tail_file(Some(&missing), 300);

        assert_eq!(result["error"], json!("нет файла"));
        assert!(result.get("text").is_none());
        assert_eq!(tail_file(None, 300)["error"], json!("нет файла"));
    }

    #[test]
    fn sanitize_does_not_recurse_forever_on_deep_values() {
        let mut deep = json!("конец");
        for _ in 0..40 {
            deep = json!({ "next": deep });
        }

        assert!(sanitize(&deep).to_string().contains("слишком глубоко"));
    }
}
