//! Автоматическая модерация чата: ссылки, мат, капс, смайлы и варны.
//!
//! Порт `server/integrations/chat-moderation.js`. Движок только **решает**, что
//! делать: сами таймауты и баны отправляет тот, кто подключён к чату
//! (`chat_bot_control.rs` поверх `twitch-chat`). Поэтому здесь нет ни сокетов,
//! ни таймеров — всё проверяется значениями.
//!
//! Три места, где легко ошибиться, и как они решены:
//!
//! * **Делейтизация** — латиница и цифры, которыми прячут кириллицу (`дypaк`,
//!   `6лять`), сводятся к кириллице одной таблицей. Вторым проходом слово ещё и
//!   «сжимается» до одних кириллических букв — так ловится разбивка пробелами и
//!   знаками (`д у р а к`).
//! * **Кэш текстовых вердиктов** — ссылка, мат и капс зависят только от строки,
//!   поэтому считаются один раз на сообщение; смайлы и счётчик варнов зависят от
//!   метаданных и кэшируются отдельно (то есть не кэшируются по тексту).
//! * **Ссылки** — регулярного выражения здесь нет (как и в `support_bundle`):
//!   адрес ищется по словам, а не по всей строке сразу. Разбор совпадает с
//!   `URL_RE` на практике; отличие одно — если в одном слове склеены два адреса
//!   без пробела, берётся первый, а не первый запрещённый среди всех.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};

use crate::storage::history::{js_number_or_zero, js_truthy, number_value};

/// Сколько текстовых вердиктов держим в кэше (FIFO).
const STATIC_CACHE_MAX: usize = 500;

/// Латинские и цифровые двойники кириллицы, которыми прячут слова.
fn leet(ch: char) -> Option<char> {
    Some(match ch {
        '0' | 'o' => 'о',
        'a' => 'а',
        'e' | 'ё' => 'е',
        'y' => 'у',
        'k' => 'к',
        'x' => 'х',
        'b' => 'в',
        'm' => 'м',
        'n' | 'h' => 'н',
        't' => 'т',
        'c' => 'с',
        'p' => 'р',
        '3' => 'з',
        '4' => 'ч',
        '6' => 'б',
        '7' => 'т',
        '9' => 'д',
        '@' => 'а',
        _ => return None,
    })
}

/// `deleetize`: нижний регистр и замена двойников.
pub fn deleetize(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|ch| leet(ch).unwrap_or(ch))
        .collect()
}

/// Только кириллические буквы в нижнем регистре — `compactCyrillic`.
pub fn compact_cyrillic(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|ch| is_cyrillic(*ch))
        .collect()
}

fn is_cyrillic(ch: char) -> bool {
    ('а'..='я').contains(&ch) || ch == 'ё'
}

/// Сколько смайлов в сообщении: объект из IRC-тегов или сырая строка.
pub fn count_emotes(emotes: &Value) -> usize {
    let positions = |value: &Value| -> usize {
        match value {
            Value::Array(items) => items.len(),
            other => {
                let text = if js_truthy(Some(other)) {
                    crate::state::js_string(other)
                } else {
                    String::new()
                };
                text.split(',').filter(|part| !part.is_empty()).count()
            }
        }
    };

    match emotes {
        Value::String(text) => text
            .split('/')
            .map(|part| match part.find(':') {
                Some(sep) => part[sep + 1..]
                    .split(',')
                    .filter(|part| !part.is_empty())
                    .count(),
                None => 0,
            })
            .sum(),
        Value::Object(map) => map.values().map(positions).sum(),
        Value::Array(items) => items.iter().map(positions).sum(),
        _ => 0,
    }
}

/// Доля заглавных букв среди букв — `capsRatio`.
pub fn caps_ratio(message: &str) -> f64 {
    let letters = message.chars().filter(|ch| is_letter(*ch)).count();
    if letters == 0 {
        return 0.0;
    }
    let upper = message.chars().filter(|ch| is_upper(*ch)).count();
    upper as f64 / letters as f64
}

fn is_letter(ch: char) -> bool {
    ch.is_ascii_alphabetic() || is_cyrillic(ch.to_lowercase().next().unwrap_or(ch))
}

fn is_upper(ch: char) -> bool {
    ch.is_ascii_uppercase() || ('А'..='Я').contains(&ch) || ch == 'Ё'
}

/// Хост адреса — `extractHost`: без схемы, `www.`, пути, порта и регистра.
pub fn extract_host(raw: &str) -> String {
    let mut text = raw.to_lowercase();
    for prefix in ["https://", "http://"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.to_string();
            break;
        }
    }
    if let Some(rest) = text.strip_prefix("www.") {
        text = rest.to_string();
    }
    let text = text.split(['/', '?', '#']).next().unwrap_or_default();
    let text = text.split(':').next().unwrap_or_default();
    text.trim().to_string()
}

/// Первый недопустимый адрес в сообщении или `None`.
pub fn find_disallowed_link(message: &str, whitelist: &[String]) -> Option<String> {
    for token in message.split_whitespace() {
        let Some(raw) = url_in_token(token) else {
            continue;
        };
        let host = extract_host(&raw);
        if host.is_empty() || !host.contains('.') {
            continue;
        }
        let allowed = whitelist.iter().any(|allowed| {
            !allowed.is_empty() && (host == *allowed || host.ends_with(&format!(".{allowed}")))
        });
        if !allowed {
            return Some(host);
        }
    }
    None
}

/// Адрес внутри слова: со схемой/`www.` — до конца, иначе — по шаблону домена.
fn url_in_token(token: &str) -> Option<String> {
    let chars: Vec<char> = token.chars().collect();
    for start in 0..chars.len() {
        if starts_with_ci(&chars, start, "https://")
            || starts_with_ci(&chars, start, "http://")
            || starts_with_ci(&chars, start, "www.")
        {
            return Some(chars[start..].iter().collect());
        }
        if let Some(end) = match_domain(&chars, start) {
            return Some(chars[start..end].iter().collect());
        }
    }
    None
}

fn starts_with_ci(chars: &[char], start: usize, needle: &str) -> bool {
    let needle: Vec<char> = needle.chars().collect();
    if start + needle.len() > chars.len() {
        return false;
    }
    chars[start..start + needle.len()]
        .iter()
        .zip(&needle)
        .all(|(left, right)| left.eq_ignore_ascii_case(right))
}

/// `(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?` — конец совпадения, если оно есть.
fn match_domain(chars: &[char], start: usize) -> Option<usize> {
    if start >= chars.len() || !is_label_char(chars[start]) {
        return None;
    }
    let mut end = start;
    while end < chars.len() && (is_label_char(chars[end]) || chars[end] == '.') {
        end += 1;
    }

    let last_dot = (start..end).rev().find(|index| chars[*index] == '.')?;
    let tld = &chars[last_dot + 1..end];
    if tld.len() < 2 || !tld.iter().all(|ch| ch.is_ascii_alphabetic()) {
        return None;
    }
    if !is_label_dot_seq(&chars[start..=last_dot]) {
        return None;
    }

    let mut stop = end;
    if stop < chars.len() && chars[stop] == '/' {
        while stop < chars.len() && !chars[stop].is_whitespace() {
            stop += 1;
        }
    }
    Some(stop)
}

fn is_label_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '-'
}

/// `([a-z0-9-]+\.)+` — последовательность непустых меток с точкой в конце.
fn is_label_dot_seq(seq: &[char]) -> bool {
    if seq.last() != Some(&'.') {
        return false;
    }
    let mut empty = true;
    for &ch in &seq[..seq.len() - 1] {
        if ch == '.' {
            if empty {
                return false;
            }
            empty = true;
        } else if is_label_char(ch) {
            empty = false;
        } else {
            return false;
        }
    }
    !empty
}

/// Запрещённое слово, подготовленное к проверке.
#[derive(Clone)]
pub struct PreparedWord {
    raw: String,
    deleet: String,
    compact: String,
}

/// Подготовить слова один раз: делейтизация и сжатие — самая дорогая часть.
pub fn prepare_bad_words(bad_words: &Value) -> Vec<PreparedWord> {
    bad_words
        .as_array()
        .map(|words| {
            words
                .iter()
                .map(|word| crate::state::js_string(word).trim().to_lowercase())
                .filter(|word| !word.is_empty())
                .map(|raw| {
                    let deleet = deleetize(&raw);
                    let compact = compact_cyrillic(&deleet);
                    PreparedWord {
                        raw,
                        deleet,
                        compact,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Найти подготовленное запрещённое слово в сообщении.
pub fn match_bad_word(message: &str, prepared: &[PreparedWord]) -> Option<String> {
    if prepared.is_empty() {
        return None;
    }
    let deleet = deleetize(message);
    let compact = compact_cyrillic(&deleet);
    prepared
        .iter()
        .find(|word| {
            !word.compact.is_empty()
                && (compact.contains(&word.compact) || deleet.contains(&word.deleet))
        })
        .map(|word| word.raw.clone())
}

/// Удобная обёртка: подготовить список и найти слово за один вызов.
pub fn find_bad_word(message: &str, bad_words: &Value) -> Option<String> {
    match_bad_word(message, &prepare_bad_words(bad_words))
}

/// Умолчания модерации — как `defaultModerationConfig()`.
pub fn default_config() -> Map<String, Value> {
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

/// Хранилище варнов: в памяти сессии или поверх базы — как в `chat-bot.js`,
/// где движку отдавали `store` над `state.db.getModerationWarns`.
pub trait WarnsBackend: Send + Sync {
    fn get(&self, key: &str) -> u64;
    fn set(&self, key: &str, count: u64);
    fn delete(&self, key: &str);
}

/// Варны в памяти — умолчание (тесты, `with_own_store`).
#[derive(Default)]
pub struct MemoryWarns {
    map: Mutex<HashMap<String, u64>>,
}

impl WarnsBackend for MemoryWarns {
    fn get(&self, key: &str) -> u64 {
        self.lock().get(key).copied().unwrap_or(0)
    }

    fn set(&self, key: &str, count: u64) {
        self.lock().insert(key.to_string(), count);
    }

    fn delete(&self, key: &str) {
        self.lock().remove(key);
    }
}

impl MemoryWarns {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, u64>> {
        self.map.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Счётчик варнов, общий для движков, пересоздаваемых при смене настроек.
pub struct ModerationStore {
    backend: Arc<dyn WarnsBackend>,
}

impl Default for ModerationStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ModerationStore {
    pub fn new() -> Self {
        Self {
            backend: Arc::new(MemoryWarns::default()),
        }
    }

    /// Счётчик поверх своего хранилища (например, базы).
    pub fn with_backend(backend: Arc<dyn WarnsBackend>) -> Self {
        Self { backend }
    }

    fn get(&self, key: &str) -> u64 {
        self.backend.get(key)
    }

    fn set(&self, key: &str, count: u64) {
        self.backend.set(key, count);
    }

    fn reset(&self, key: &str) {
        self.backend.delete(key);
    }
}

/// Вердикт, зависящий только от текста (ссылка/мат/капс).
#[derive(Clone)]
struct StaticVerdict {
    kind: &'static str,
    reason: String,
}

#[derive(Default)]
struct Cache {
    map: HashMap<String, Option<StaticVerdict>>,
    order: VecDeque<String>,
}

/// Движок модерации одного набора настроек.
pub struct ModerationEngine {
    config: Map<String, Value>,
    whitelist: Vec<String>,
    bad_words: Vec<PreparedWord>,
    store: Arc<ModerationStore>,
    cache: Mutex<Cache>,
}

impl ModerationEngine {
    /// Собрать движок: настройки домазываются на умолчания.
    pub fn new(config: &Value, store: Arc<ModerationStore>) -> Self {
        let mut merged = default_config();
        if let Some(config) = config.as_object() {
            for (key, value) in config {
                merged.insert(key.clone(), value.clone());
            }
        }
        let whitelist = merged
            .get("whitelistDomains")
            .and_then(Value::as_array)
            .map(|domains| {
                domains
                    .iter()
                    .map(|domain| extract_host(&crate::state::js_string(domain)))
                    .filter(|domain| !domain.is_empty() && domain.contains('.'))
                    .collect()
            })
            .unwrap_or_default();
        let bad_words = prepare_bad_words(merged.get("badWords").unwrap_or(&Value::Null));

        Self {
            config: merged,
            whitelist,
            bad_words,
            store,
            cache: Mutex::new(Cache::default()),
        }
    }

    /// Движок со своим счётчиком варнов.
    pub fn with_own_store(config: &Value) -> Self {
        Self::new(config, Arc::new(ModerationStore::new()))
    }

    /// Проверить сообщение; `None` — всё чисто (или модерация выключена).
    pub fn check(&self, msg: &Value) -> Option<Value> {
        if !self
            .config
            .get("enabled")
            .map(|value| js_truthy(Some(value)))
            .unwrap_or(false)
        {
            return None;
        }

        let level = msg
            .get("level")
            .and_then(Value::as_str)
            .unwrap_or("everyone");
        if is_privileged(level, msg.get("badges")) {
            return None;
        }

        // `String(msg.message || "")` — без обрезки: движок видит исходный текст,
        // обрезка нужна только для проверки на пустоту.
        let message = match msg.get("message").filter(|value| js_truthy(Some(value))) {
            Some(value) => crate::state::js_string(value),
            None => String::new(),
        };
        // `String(msg.userId || msg.user || "")` — пустой userId уступает нику.
        let key = {
            let source = [msg.get("userId"), msg.get("user")]
                .into_iter()
                .flatten()
                .find(|value| js_truthy(Some(*value)))
                .map(crate::state::js_string)
                .unwrap_or_default();
            source.to_lowercase()
        };
        if key.is_empty() || message.trim().is_empty() {
            return None;
        }

        let (mut kind, mut reason) = match self.static_verdict(&message) {
            Some(verdict) => (Some(verdict.kind), verdict.reason),
            None => (None, String::new()),
        };

        if kind.is_none() && js_number_or_zero(self.config.get("maxEmotes")) > 0.0 {
            let count = count_emotes(msg.get("emotes").unwrap_or(&Value::Null));
            if count as f64 > js_number_or_zero(self.config.get("maxEmotes")) {
                kind = Some("emotes");
                reason = format!("слишком много смайлов ({count})");
            }
        }

        let kind = kind?;

        let max_warns = js_number_or_zero(self.config.get("maxWarns"))
            .round()
            .max(1.0);
        let count = self.store.get(&key) + 1;
        self.store.set(&key, count);

        let warn_timeout = js_number_or_zero(self.config.get("warnTimeoutSec"))
            .round()
            .max(1.0);
        let user = msg.get("user").and_then(Value::as_str).unwrap_or("viewer");

        // Таймаут в одну секунду убирает сообщение без права удалять его.
        let mut timeout_sec = 1.0;
        let ban;
        let warning;
        if count as f64 >= max_warns {
            ban = true;
            warning = format!("@{user}, {reason}. Перманентный бан.");
        } else if count == 1 {
            ban = false;
            warning = format!("@{user}, {reason}. Предупреждение 1/{max_warns:.0}");
        } else {
            ban = false;
            timeout_sec = warn_timeout;
            warning = format!(
                "@{user}, {reason}. Таймаут {:.0} мин. Предупреждение {count}/{max_warns:.0}",
                (warn_timeout / 60.0).round()
            );
        }

        Some(json!({
            "type": kind,
            "warn": number_value(count as f64),
            "timeoutSec": if ban { Value::Null } else { number_value(timeout_sec) },
            "ban": ban,
            "reason": reason,
            "message": warning,
        }))
    }

    /// Забыть варны пользователя.
    pub fn reset_warn(&self, key: &str) {
        self.store.reset(&key.to_lowercase());
    }

    fn static_verdict(&self, message: &str) -> Option<StaticVerdict> {
        if let Some(cached) = self.lock_cache().map.get(message).cloned() {
            return cached;
        }
        let verdict = self.compute_static_verdict(message);
        let mut cache = self.lock_cache();
        if cache.map.len() >= STATIC_CACHE_MAX {
            if let Some(oldest) = cache.order.pop_front() {
                cache.map.remove(&oldest);
            }
        }
        cache.order.push_back(message.to_string());
        cache.map.insert(message.to_string(), verdict.clone());
        verdict
    }

    fn compute_static_verdict(&self, message: &str) -> Option<StaticVerdict> {
        if js_truthy(self.config.get("linkProtection")) {
            if let Some(domain) = find_disallowed_link(message, &self.whitelist) {
                return Some(StaticVerdict {
                    kind: "link",
                    reason: format!("ссылка на {domain}"),
                });
            }
        }
        if !self.bad_words.is_empty() && match_bad_word(message, &self.bad_words).is_some() {
            return Some(StaticVerdict {
                kind: "badword",
                reason: "запрещённое слово".to_string(),
            });
        }
        let caps = self
            .config
            .get("capsThreshold")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if caps > 0.0 && caps < 1.0 && message.chars().count() > 10 && caps_ratio(message) > caps {
            return Some(StaticVerdict {
                kind: "caps",
                reason: "слишком много заглавных букв".to_string(),
            });
        }
        None
    }

    fn lock_cache(&self) -> std::sync::MutexGuard<'_, Cache> {
        self.cache.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Неприкосновенные: стример, модераторы и VIP.
fn is_privileged(level: &str, badges: Option<&Value>) -> bool {
    if level == "broadcaster" || level == "moderator" {
        return true;
    }
    badges
        .and_then(Value::as_array)
        .map(|badges| {
            badges
                .iter()
                .any(|badge| crate::state::js_string(badge).to_lowercase() == "vip")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whitelist(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_string()).collect()
    }

    #[test]
    fn deleetize_replaces_latin_lookalikes() {
        assert_eq!(deleetize("дypaк"), "дурак");
        assert_eq!(deleetize("6лять"), "блять");
        assert_eq!(deleetize("3абанен"), "забанен");
    }

    #[test]
    fn emotes_are_counted_from_objects_and_raw_irc() {
        assert_eq!(
            count_emotes(&json!({ "25": ["0-1", "2-3", "4-5"], "1902": ["6-7"] })),
            4
        );
        assert_eq!(count_emotes(&json!("25:0-4,6-10/1902:12-16")), 3);
        assert_eq!(count_emotes(&Value::Null), 0);
    }

    #[test]
    fn caps_ratio_counts_the_share_of_uppercase() {
        assert_eq!(caps_ratio("ПРИВЕТ ВСЕМ"), 1.0);
        assert!((caps_ratio("Привет всем") - 0.1).abs() < 0.001);
        assert_eq!(caps_ratio("..."), 0.0);
    }

    #[test]
    fn a_disallowed_link_respects_the_whitelist_and_subdomains() {
        let list = whitelist(&["youtube.com", "twitch.tv"]);
        assert_eq!(
            find_disallowed_link("go to evil.com", &list),
            Some("evil.com".to_string())
        );
        assert_eq!(
            find_disallowed_link("watch https://youtube.com/watch?v=x", &list),
            None
        );
        assert_eq!(
            find_disallowed_link("clip: clips.twitch.tv/abc", &list),
            None
        );
    }

    #[test]
    fn a_bad_word_is_found_through_deleeting_and_spacing() {
        assert_eq!(
            find_bad_word("ты дypaк", &json!(["дурак"])),
            Some("дурак".to_string())
        );
        assert_eq!(
            find_bad_word("д у р а к", &json!(["дурак"])),
            Some("дурак".to_string())
        );
        assert_eq!(find_bad_word("всё ок", &json!(["дурак"])), None);
    }

    #[test]
    fn prepared_words_and_match_are_equivalent_to_find() {
        let prepared = prepare_bad_words(&json!(["дурак", "спам"]));
        assert_eq!(prepared.len(), 2);
        assert_eq!(
            match_bad_word("ты дypaк", &prepared),
            Some("дурак".to_string())
        );
        assert_eq!(
            match_bad_word("д у р а к", &prepared),
            Some("дурак".to_string())
        );
        assert_eq!(match_bad_word("всё ок", &prepared), None);
        assert_eq!(match_bad_word("что угодно", &[]), None);
    }

    fn engine(config: Value) -> ModerationEngine {
        ModerationEngine::with_own_store(&config)
    }

    #[test]
    fn a_link_gives_the_first_warning_with_a_second_timeout() {
        let engine = engine(json!({
            "enabled": true,
            "linkProtection": true,
            "whitelistDomains": ["twitch.tv"],
        }));
        let verdict = engine
            .check(&json!({ "user": "u", "userId": "1", "message": "заходи evil.com", "level": "everyone" }))
            .expect("вердикт");
        assert_eq!(verdict["type"], json!("link"));
        assert_eq!(verdict["warn"], json!(1));
        assert_eq!(verdict["ban"], json!(false));
        assert_eq!(verdict["timeoutSec"], json!(1));
        assert!(verdict["message"].as_str().unwrap().contains("1/3"));
    }

    #[test]
    fn caps_and_emotes_are_detected() {
        let caps = engine(
            json!({ "enabled": true, "linkProtection": false, "capsThreshold": 0.7, "maxEmotes": 0 }),
        );
        assert_eq!(
            caps.check(&json!({ "user": "u", "userId": "2", "message": "ПРИВЕТ ВСЕМ КАК ДЕЛА", "level": "everyone" }))
                .unwrap()["type"],
            json!("caps")
        );

        let emotes = engine(
            json!({ "enabled": true, "linkProtection": false, "capsThreshold": 1, "maxEmotes": 2 }),
        );
        assert_eq!(
            emotes
                .check(&json!({ "user": "u", "userId": "3", "message": "hi", "emotes": { "25": ["0-1", "2-3", "4-5"] }, "level": "everyone" }))
                .unwrap()["type"],
            json!("emotes")
        );
    }

    #[test]
    fn the_blacklist_fires_through_deleeting() {
        let engine = engine(
            json!({ "enabled": true, "linkProtection": false, "badWords": ["дурак"], "maxEmotes": 0 }),
        );
        assert_eq!(
            engine
                .check(&json!({ "user": "u", "userId": "4", "message": "ты дypaк", "level": "everyone" }))
                .unwrap()["type"],
            json!("badword")
        );
    }

    #[test]
    fn moderators_and_the_broadcaster_are_untouchable() {
        let engine = engine(
            json!({ "enabled": true, "linkProtection": false, "badWords": ["дурак"], "maxEmotes": 0 }),
        );
        assert!(engine
            .check(&json!({ "user": "mod", "userId": "5", "message": "ты дурак", "level": "moderator" }))
            .is_none());
        assert!(engine
            .check(&json!({ "user": "owner", "userId": "6", "message": "evil.com", "level": "broadcaster" }))
            .is_none());
    }

    #[test]
    fn vip_badges_are_not_touched() {
        let engine = engine(
            json!({ "enabled": true, "linkProtection": false, "badWords": ["дурак"], "maxEmotes": 0 }),
        );
        assert!(engine
            .check(&json!({ "user": "vip", "userId": "8", "badges": ["vip"], "message": "ты дурак", "level": "subscriber" }))
            .is_none());
    }

    #[test]
    fn the_warn_chain_is_warning_timeout_ban() {
        let engine = engine(json!({
            "enabled": true,
            "linkProtection": false,
            "badWords": ["дурак"],
            "maxEmotes": 0,
            "maxWarns": 3,
            "warnTimeoutSec": 600,
        }));
        let first = engine
            .check(
                &json!({ "user": "u", "userId": "9", "message": "ты дурак", "level": "everyone" }),
            )
            .unwrap();
        assert_eq!(first["warn"], json!(1));
        assert_eq!(first["timeoutSec"], json!(1));
        let second = engine
            .check(
                &json!({ "user": "u", "userId": "9", "message": "ты дурак", "level": "everyone" }),
            )
            .unwrap();
        assert_eq!(second["warn"], json!(2));
        assert_eq!(second["timeoutSec"], json!(600));
        let third = engine
            .check(
                &json!({ "user": "u", "userId": "9", "message": "ты дурак", "level": "everyone" }),
            )
            .unwrap();
        assert_eq!(third["warn"], json!(3));
        assert_eq!(third["ban"], json!(true));
        assert_eq!(third["timeoutSec"], Value::Null);
    }

    #[test]
    fn disabled_moderation_does_nothing() {
        let engine = engine(json!({ "enabled": false, "linkProtection": true }));
        assert!(engine
            .check(
                &json!({ "user": "u", "userId": "7", "message": "evil.com", "level": "everyone" })
            )
            .is_none());
    }

    #[test]
    fn warns_live_in_the_shared_store_across_engines() {
        let store = Arc::new(ModerationStore::new());
        let make = || {
            ModerationEngine::new(
                &json!({ "enabled": true, "linkProtection": false, "badWords": ["дурак"], "maxEmotes": 0, "maxWarns": 3 }),
                store.clone(),
            )
        };
        let message =
            json!({ "user": "u", "userId": "10", "message": "ты дурак", "level": "everyone" });
        assert_eq!(make().check(&message).unwrap()["warn"], json!(1));
        assert_eq!(make().check(&message).unwrap()["warn"], json!(2));
        assert_eq!(make().check(&message).unwrap()["warn"], json!(3));
    }

    #[test]
    fn the_text_cache_does_not_affect_emote_checks() {
        let engine = engine(
            json!({ "enabled": true, "linkProtection": false, "capsThreshold": 1, "maxEmotes": 2 }),
        );
        // Один и тот же текст: со смайлами — флаг, без — чисто.
        assert_eq!(
            engine
                .check(&json!({ "user": "u", "userId": "cache2", "message": "hi", "emotes": { "25": ["0-1", "2-3", "4-5"] }, "level": "everyone" }))
                .unwrap()["type"],
            json!("emotes")
        );
        assert!(engine
            .check(&json!({ "user": "u", "userId": "cache2", "message": "hi", "emotes": {}, "level": "everyone" }))
            .is_none());
    }
}
