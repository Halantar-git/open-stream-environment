//! Чат-бот в стиле Nightbot: команды по префиксу, права, кулдауны, таймеры.
//!
//! Порт `server/integrations/chat-bot.js`. Здесь — только разбор и решение:
//! движок читает сообщение, сопоставляет команду с настройками, проверяет
//! уровень и кулдаун, подставляет шаблон. Отправку в чат делает слой подключения
//! (`chat_bot_control.rs` поверх `twitch-chat`), поэтому часы сюда передаются
//! снаружи — как и в остальных перенесённых частях, иначе кулдаун и таймеры не
//! проверить.
//!
//! Подключение к шине и Helix-чату — в `chat_bot_control.rs`: он собирает движок
//! по настройкам, кормит его сообщениями `chat_message` и выполняет решения
//! (ответы, таймауты, баны) через `ChatSender`. Модерация как побочное действие
//! (`!timeout`/`!ban` и срабатывание движка) тоже там.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::storage::history::{js_number_or_zero, js_truthy};

/// Уровни прав по возрастанию.
pub const LEVELS: [&str; 4] = ["everyone", "subscriber", "moderator", "broadcaster"];

/// Ответы «магического шара».
const EIGHT_BALL: [&str; 8] = [
    "Да",
    "Нет",
    "Определённо да",
    "Скорее всего",
    "Не сейчас",
    "Сомнительно",
    "Однозначно нет",
    "Знаки говорят — да",
];

/// Часы движка: подменяются в тестах.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// `normalizeName`: обрезать, привести к нижнему регистру, снять один префикс.
pub fn normalize_name(name: &str) -> String {
    let trimmed = name.trim().to_lowercase();
    let trimmed = trimmed.strip_prefix(['!', '.', '/']).unwrap_or(&trimmed);
    trimmed.to_string()
}

/// `formatUptime`: `1ч 1м 1с`, `1м 0с` или `45с`.
pub fn format_uptime(ms: i64) -> String {
    let total = (ms / 1000).max(0);
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours > 0 {
        format!("{hours}ч {minutes}м {seconds}с")
    } else if minutes > 0 {
        format!("{minutes}м {seconds}с")
    } else {
        format!("{seconds}с")
    }
}

/// Уровень участника по бейджам и каналу.
pub fn user_level(user: &str, badges: &Value, channel: &str) -> &'static str {
    let channel_matches = !channel.is_empty() && user.to_lowercase() == channel.to_lowercase();
    if has_badge(badges, "broadcaster") || channel_matches {
        return "broadcaster";
    }
    if has_badge(badges, "moderator") {
        return "moderator";
    }
    if has_badge(badges, "subscriber") || has_badge(badges, "founder") || has_badge(badges, "vip") {
        return "subscriber";
    }
    "everyone"
}

fn has_badge(badges: &Value, name: &str) -> bool {
    badges
        .as_array()
        .map(|badges| {
            badges
                .iter()
                .any(|badge| crate::state::js_string(badge).to_lowercase() == name)
        })
        .unwrap_or(false)
}

/// Разобранная команда модерации (`!timeout`/`!ban`).
#[derive(Debug, PartialEq, Eq)]
pub struct ModCommand {
    pub name: String,
    pub target: String,
    pub duration_raw: Option<String>,
}

/// Разобрать `!timeout @user [сек]` и `!ban @user`; `None` — не команда модерации.
pub fn parse_mod_command(prefix: &str, message: &str) -> Option<ModCommand> {
    let text = message.trim();
    let prefix = if prefix.is_empty() { "!" } else { prefix };
    if !text.starts_with(prefix) {
        return None;
    }
    let body = text[prefix.len()..].trim();
    let parts: Vec<&str> = body.split_whitespace().collect();
    let name = parts.first().unwrap_or(&"").to_lowercase();
    if name != "timeout" && name != "ban" {
        return None;
    }
    let target = parts
        .get(1)
        .map(|target| {
            target
                .strip_prefix('@')
                .unwrap_or(target)
                .trim()
                .to_string()
        })
        .unwrap_or_default();
    Some(ModCommand {
        duration_raw: (name == "timeout")
            .then(|| parts.get(2).map(|value| (*value).to_string()))
            .flatten(),
        name,
        target,
    })
}

/// Значения для шаблона ответа.
#[derive(Default)]
pub struct TemplateContext {
    pub user: String,
    pub channel: String,
    pub args: String,
    pub count: i64,
}

/// Подстановка `$(user)`, `$(channel)`, `$(args)`, `$(count)` и `$(random a|b)`.
///
/// Регулярного выражения нет: разбираем по символам, как и адреса в модерации.
pub fn render_template(template: &str, ctx: &TemplateContext) -> String {
    let chars: Vec<char> = template.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '$' && chars.get(index + 1) == Some(&'(') {
            if let Some(close) = (index + 2..chars.len()).find(|position| chars[*position] == ')') {
                let inner: String = chars[index + 2..close].iter().collect();
                if let Some(replacement) = expand(&inner, ctx) {
                    out.push_str(&replacement);
                    index = close + 1;
                    continue;
                }
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out.trim().to_string()
}

/// Подстановка одного `$(...)`; `None` — оставить как есть.
fn expand(inner: &str, ctx: &TemplateContext) -> Option<String> {
    let trimmed = inner.trim();
    match trimmed.to_lowercase().as_str() {
        "user" => Some(ctx.user.clone()),
        "channel" => Some(ctx.channel.clone()),
        "args" => Some(ctx.args.clone()),
        "count" => Some(ctx.count.to_string()),
        _ => {
            let lower = trimmed.to_lowercase();
            let rest = lower.strip_prefix("random")?;
            if !rest.chars().next().is_some_and(char::is_whitespace) {
                return None;
            }
            // Длину префикса берём из исходной строки: регистр мог отличаться,
            // но `random` — латиница, и байтовая длина та же.
            let raw = trimmed.get("random".len()..).unwrap_or_default();
            let items: Vec<&str> = raw
                .split('|')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .collect();
            if items.is_empty() {
                Some(String::new())
            } else {
                Some(items[random_index(items.len())].to_string())
            }
        }
    }
}

/// Найденная команда: имя без префикса и остаток строки как аргументы.
struct Matched {
    name: String,
    args: String,
}

/// Движок команд и таймеров.
pub struct BotEngine {
    prefix: String,
    channel: String,
    commands: Vec<Value>,
    commands_by_name: HashMap<String, Value>,
    timers: Vec<Value>,
    started_at: Option<i64>,
    now: Clock,
    counters: Mutex<HashMap<String, i64>>,
    timer_counters: Mutex<HashMap<String, i64>>,
    global_last: Mutex<HashMap<String, i64>>,
    user_last: Mutex<HashMap<String, i64>>,
    timer_last: Mutex<HashMap<String, i64>>,
    chat_lines_since_timer: AtomicI64,
}

impl BotEngine {
    /// Движок с настоящими часами; момент старта берётся из `startedAt`.
    pub fn new(config: &Value) -> Self {
        let started_at = config.get("startedAt").and_then(Value::as_i64);
        Self::build(
            config,
            Arc::new(|| chrono::Utc::now().timestamp_millis()),
            started_at,
        )
    }

    /// Движок с подменяемыми часами — для проверки кулдаунов и таймеров.
    pub fn with_clock(config: &Value, now: Clock, started_at: Option<i64>) -> Self {
        Self::build(config, now, started_at)
    }

    fn build(config: &Value, now: Clock, started_at: Option<i64>) -> Self {
        let prefix = match config.get("prefix").and_then(Value::as_str) {
            Some(prefix) if !prefix.is_empty() => prefix.to_string(),
            _ => "!".to_string(),
        };
        let channel = config
            .get("channel")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let commands = config
            .get("commands")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let commands_by_name = commands
            .iter()
            .map(|command| {
                let name = normalize_name(
                    command
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                );
                (name, command.clone())
            })
            .collect();
        let timers = config
            .get("timers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        Self {
            prefix,
            channel,
            commands,
            commands_by_name,
            timers,
            started_at,
            now,
            counters: Mutex::new(HashMap::new()),
            timer_counters: Mutex::new(HashMap::new()),
            global_last: Mutex::new(HashMap::new()),
            user_last: Mutex::new(HashMap::new()),
            timer_last: Mutex::new(HashMap::new()),
            chat_lines_since_timer: AtomicI64::new(0),
        }
    }

    /// Разобрать сообщение на имя команды и аргументы.
    pub fn match_command(&self, message: &str) -> Option<(String, String)> {
        let text = message.trim();
        if !text.starts_with(&self.prefix) {
            return None;
        }
        let body = text[self.prefix.len()..].trim();
        if body.is_empty() {
            return None;
        }
        let mut parts = body.split_whitespace();
        let first = parts.next()?;
        let name = normalize_name(first);
        let args = parts.collect::<Vec<_>>().join(" ");
        Some((name, args))
    }

    /// Ответ на сообщение; `None` — бот молчит.
    pub fn handle_chat(&self, message: &Value) -> Option<String> {
        self.chat_lines_since_timer.fetch_add(1, Ordering::Relaxed);

        let user = message
            .get("user")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let text = message
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let badges = message.get("badges").cloned().unwrap_or(Value::Null);

        let (name, args) = self.match_command(text)?;
        let matched = Matched {
            name: name.clone(),
            args: args.clone(),
        };
        let level = user_level(user, &badges, &self.channel);

        if name == "commands" || name == "help" {
            return Some(self.command_list(level));
        }

        if let Some(reply) = self.builtin_reply(&matched, user) {
            return Some(reply);
        }

        let command = self.commands_by_name.get(&name)?.clone();
        let required = command
            .get("level")
            .and_then(Value::as_str)
            .unwrap_or("everyone");
        if !level_ok(required, level) {
            return None;
        }

        let now = (self.now)();
        let global_cd = js_number_or_zero(command.get("cooldown")).max(0.0);
        let user_cd = js_number_or_zero(command.get("userCooldown")).max(0.0);

        if global_cd > 0.0 {
            if let Some(last) = self.lock(&self.global_last).get(&name).copied() {
                if ((now - last) as f64) < global_cd * 1000.0 {
                    return None;
                }
            }
        }
        let user_key = format!("{}:{}", user.to_lowercase(), name);
        if user_cd > 0.0 {
            if let Some(last) = self.lock(&self.user_last).get(&user_key).copied() {
                if ((now - last) as f64) < user_cd * 1000.0 {
                    return None;
                }
            }
        }

        self.lock(&self.global_last).insert(name.clone(), now);
        if user_cd > 0.0 {
            self.lock(&self.user_last).insert(user_key, now);
        }

        let count = {
            let mut counters = self.lock(&self.counters);
            let count = counters.get(&name).copied().unwrap_or(0) + 1;
            counters.insert(name.clone(), count);
            count
        };

        let reply = render_template(
            command
                .get("response")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            &TemplateContext {
                user: user.to_string(),
                channel: self.channel.clone(),
                args,
                count,
            },
        );
        (!reply.is_empty()).then_some(reply)
    }

    /// Проверить таймеры; вернуть то, что нужно отправить.
    pub fn tick(&self) -> Vec<String> {
        let now = (self.now)();
        let mut replies = Vec::new();

        for timer in &self.timers {
            let response = timer
                .get("response")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if response.is_empty() {
                continue;
            }
            let id = timer
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();

            let interval_min = js_number_or_zero(timer.get("interval")).round().max(1.0);
            let interval_ms = interval_min * 60_000.0;
            let last = self.lock(&self.timer_last).get(&id).copied().unwrap_or(0);
            if ((now - last) as f64) < interval_ms {
                continue;
            }

            let min_chat = js_number_or_zero(timer.get("minChat")).round().max(0.0);
            if min_chat > self.chat_lines_since_timer.load(Ordering::Relaxed) as f64 {
                continue;
            }

            let count = {
                let mut counters = self.lock(&self.timer_counters);
                let count = counters.get(&id).copied().unwrap_or(0) + 1;
                counters.insert(id.clone(), count);
                count
            };
            self.lock(&self.timer_last).insert(id, now);

            let reply = render_template(
                &response,
                &TemplateContext {
                    user: String::new(),
                    channel: self.channel.clone(),
                    args: String::new(),
                    count,
                },
            );
            if !reply.is_empty() {
                replies.push(reply);
            }
        }

        if !replies.is_empty() {
            self.chat_lines_since_timer.store(0, Ordering::Relaxed);
        }
        replies
    }

    fn builtin_reply(&self, matched: &Matched, user: &str) -> Option<String> {
        match matched.name.as_str() {
            "uptime" => {
                let started_at = self.started_at?;
                Some(format!(
                    "Стрим идёт: {}",
                    format_uptime((self.now)() - started_at)
                ))
            }
            "so" => {
                let target = matched
                    .args
                    .strip_prefix('@')
                    .unwrap_or(&matched.args)
                    .trim();
                if target.is_empty() {
                    return Some("Использование: !so <ник>".to_string());
                }
                Some(format!(
                    "Шаут-аут {target}! Загляните: https://twitch.tv/{target}"
                ))
            }
            "8ball" => Some(EIGHT_BALL[random_index(EIGHT_BALL.len())].to_string()),
            "roll" => {
                let raw = js_number_or_zero(Some(&json!(matched.args)));
                let raw = if raw == 0.0 { 100.0 } else { raw };
                let max = raw.round().clamp(1.0, 100_000.0) as i64;
                let value = 1 + random_index(max as usize) as i64;
                let user = if user.is_empty() { "viewer" } else { user };
                Some(format!("@{user} выбросил {value} (1–{max})"))
            }
            _ => None,
        }
    }

    fn command_list(&self, level: &str) -> String {
        let is_mod = level == "moderator" || level == "broadcaster";
        let mut names: Vec<String> = ["uptime", "so", "8ball", "roll"]
            .iter()
            .map(|name| format!("{}{name}", self.prefix))
            .collect();
        if is_mod {
            names.push(format!("{}timeout", self.prefix));
            names.push(format!("{}ban", self.prefix));
        }
        for command in &self.commands {
            let name = normalize_name(
                command
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            if name.is_empty() {
                continue;
            }
            let required = command
                .get("level")
                .and_then(Value::as_str)
                .unwrap_or("everyone");
            if level_ok(required, level) {
                names.push(format!("{}{name}", self.prefix));
            }
        }
        format!("Команды: {}", names.join(" "))
    }

    fn lock<'a, T>(&self, mutex: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
        mutex.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn level_ok(required: &str, actual: &str) -> bool {
    rank(actual)
        >= rank(if required.is_empty() {
            "everyone"
        } else {
            required
        })
}

fn rank(level: &str) -> i32 {
    LEVELS.iter().position(|name| *name == level).unwrap_or(0) as i32
}

/// `Math.floor(Math.random() * len)` из байтов `uuid` — как в остальных частях.
fn random_index(len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    let mut value: u64 = 0;
    for byte in bytes.iter().take(8) {
        value = (value << 8) | u64::from(*byte);
    }
    (value % len as u64) as usize
}

/// Пригодится вызывающему: включён ли бот по настройкам.
pub fn is_enabled(config: &Value) -> bool {
    js_truthy(config.get("enabled"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicI64;

    fn commands() -> Value {
        json!([
            { "id": "discord", "name": "discord", "response": "Discord: discord.gg/test", "level": "everyone", "cooldown": 0, "userCooldown": 0 },
            { "id": "hello", "name": "hello", "response": "Привет, $(user)! Счёт: $(count)", "level": "everyone", "cooldown": 0, "userCooldown": 0 },
            { "id": "secret", "name": "secret", "response": "Только для модов", "level": "moderator", "cooldown": 0, "userCooldown": 0 },
            { "id": "slow", "name": "slow", "response": "Не спешу", "level": "everyone", "cooldown": 30, "userCooldown": 0 },
        ])
    }

    fn engine(config: Value) -> BotEngine {
        BotEngine::new(&config)
    }

    /// Движок с переводимыми часами.
    fn clocked(config: Value, clock: Arc<AtomicI64>) -> BotEngine {
        BotEngine::with_clock(
            &config,
            Arc::new(move || clock.load(Ordering::Relaxed)),
            config.get("startedAt").and_then(Value::as_i64),
        )
    }

    #[test]
    fn normalize_name_clears_the_prefix_and_case() {
        assert_eq!(normalize_name("!Discord"), "discord");
        assert_eq!(normalize_name("ДИСКОРД"), "дискорд");
        assert_eq!(normalize_name(".points"), "points");
    }

    #[test]
    fn uptime_is_formatted() {
        assert_eq!(format_uptime(60_000), "1м 0с");
        assert_eq!(format_uptime(3_661_000), "1ч 1м 1с");
        assert_eq!(format_uptime(45_000), "45с");
    }

    #[test]
    fn moderation_commands_are_parsed() {
        assert_eq!(
            parse_mod_command("!", "!ban @user"),
            Some(ModCommand {
                name: "ban".to_string(),
                target: "user".to_string(),
                duration_raw: None,
            })
        );
        assert_eq!(
            parse_mod_command("!", "!timeout @user 120"),
            Some(ModCommand {
                name: "timeout".to_string(),
                target: "user".to_string(),
                duration_raw: Some("120".to_string()),
            })
        );
        assert_eq!(parse_mod_command("!", "!hello"), None);
    }

    #[test]
    fn user_level_follows_badges_and_the_channel() {
        assert_eq!(
            user_level("HalanTar", &json!([]), "halantar"),
            "broadcaster"
        );
        assert_eq!(
            user_level("mod", &json!(["moderator"]), "chan"),
            "moderator"
        );
        assert_eq!(
            user_level("sub", &json!(["subscriber"]), "chan"),
            "subscriber"
        );
        assert_eq!(user_level("vip", &json!(["vip"]), "chan"), "subscriber");
        assert_eq!(user_level("guest", &json!([]), "chan"), "everyone");
    }

    #[test]
    fn templates_substitute_variables_and_random_lists() {
        let out = render_template(
            "Привет, $(user)! Счёт: $(count). $(args)",
            &TemplateContext {
                user: "Bob".to_string(),
                channel: "chan".to_string(),
                args: "привет мир".to_string(),
                count: 3,
            },
        );
        assert_eq!(out, "Привет, Bob! Счёт: 3. привет мир");

        let random = render_template("$(random a|b|c)", &TemplateContext::default());
        assert!(["a", "b", "c"].contains(&random.as_str()), "{random}");
    }

    #[test]
    fn a_command_is_found_and_rendered() {
        let engine = engine(json!({ "prefix": "!", "channel": "chan", "commands": commands() }));
        let reply = engine
            .handle_chat(&json!({ "user": "viewer", "badges": [], "message": "!discord" }))
            .expect("ответ");
        assert_eq!(reply, "Discord: discord.gg/test");
    }

    #[test]
    fn the_count_variable_grows_with_calls() {
        let engine = engine(json!({ "prefix": "!", "channel": "chan", "commands": commands() }));
        assert_eq!(
            engine.handle_chat(&json!({ "user": "a", "badges": [], "message": "!hello" })),
            Some("Привет, a! Счёт: 1".to_string())
        );
        assert_eq!(
            engine.handle_chat(&json!({ "user": "a", "badges": [], "message": "!hello" })),
            Some("Привет, a! Счёт: 2".to_string())
        );
    }

    #[test]
    fn the_global_cooldown_blocks_a_repeat() {
        let clock = Arc::new(AtomicI64::new(0));
        let engine = clocked(
            json!({ "prefix": "!", "channel": "chan", "commands": commands() }),
            clock.clone(),
        );
        assert!(engine
            .handle_chat(&json!({ "user": "a", "badges": [], "message": "!slow" }))
            .is_some());
        assert!(engine
            .handle_chat(&json!({ "user": "a", "badges": [], "message": "!slow" }))
            .is_none());
        clock.store(31 * 1000, Ordering::Relaxed);
        assert!(engine
            .handle_chat(&json!({ "user": "a", "badges": [], "message": "!slow" }))
            .is_some());
    }

    #[test]
    fn a_moderator_command_is_closed_to_viewers() {
        let engine = engine(json!({ "prefix": "!", "channel": "chan", "commands": commands() }));
        assert!(engine
            .handle_chat(&json!({ "user": "guest", "badges": [], "message": "!secret" }))
            .is_none());
        assert_eq!(
            engine.handle_chat(
                &json!({ "user": "mod", "badges": ["moderator"], "message": "!secret" })
            ),
            Some("Только для модов".to_string())
        );
    }

    #[test]
    fn the_commands_list_shows_builtins_and_allowed_customs() {
        let engine = engine(json!({ "prefix": "!", "channel": "chan", "commands": commands() }));
        let reply = engine
            .handle_chat(&json!({ "user": "guest", "badges": [], "message": "!commands" }))
            .expect("список");
        assert!(reply.contains("!discord"), "{reply}");
        assert!(reply.contains("!hello"), "{reply}");
        assert!(reply.contains("!uptime"), "{reply}");
        assert!(reply.contains("!8ball"), "{reply}");
        assert!(!reply.contains("!secret"), "{reply}");
        assert!(!reply.contains("!timeout"), "{reply}");
        assert!(!reply.contains("!ban"), "{reply}");
    }

    #[test]
    fn the_commands_list_gives_moderators_the_extra_builtins() {
        let engine = engine(json!({ "prefix": "!", "channel": "chan", "commands": commands() }));
        let reply = engine
            .handle_chat(&json!({ "user": "mod", "badges": ["moderator"], "message": "!commands" }))
            .expect("список");
        assert!(reply.contains("!timeout"), "{reply}");
        assert!(reply.contains("!ban"), "{reply}");
        assert!(reply.contains("!secret"), "{reply}");
    }

    #[test]
    fn a_timer_fires_after_its_interval_and_counts() {
        let clock = Arc::new(AtomicI64::new(0));
        let engine = clocked(
            json!({
                "prefix": "!",
                "channel": "chan",
                "commands": [],
                "timers": [
                    { "id": "t1", "name": "socials", "response": "Наши соцсети: $(count)", "interval": 10, "minChat": 0 },
                    { "id": "t2", "name": "quiet", "response": "Тихо не пишу", "interval": 1, "minChat": 3 },
                ],
            }),
            clock.clone(),
        );
        assert!(engine.tick().is_empty());
        clock.store(10 * 60_000, Ordering::Relaxed);
        assert_eq!(engine.tick(), vec!["Наши соцсети: 1".to_string()]);
        clock.store(20 * 60_000, Ordering::Relaxed);
        assert_eq!(engine.tick(), vec!["Наши соцсети: 2".to_string()]);
    }

    #[test]
    fn a_timer_with_min_chat_waits_for_activity() {
        let clock = Arc::new(AtomicI64::new(0));
        let engine = clocked(
            json!({
                "prefix": "!",
                "channel": "chan",
                "commands": [],
                "timers": [
                    { "id": "t1", "name": "socials", "response": "Наши соцсети: $(count)", "interval": 10, "minChat": 0 },
                    { "id": "t2", "name": "quiet", "response": "Тихо не пишу", "interval": 1, "minChat": 3 },
                ],
            }),
            clock.clone(),
        );
        clock.store(2 * 60_000, Ordering::Relaxed);
        assert!(engine.tick().is_empty());

        // Два сообщения (не команды) увеличивают счётчик активности.
        engine.handle_chat(&json!({ "user": "a", "badges": [], "message": "привет" }));
        engine.handle_chat(&json!({ "user": "b", "badges": [], "message": "как дела" }));
        assert!(engine.tick().is_empty());

        engine.handle_chat(&json!({ "user": "c", "badges": [], "message": "третье сообщение" }));
        assert_eq!(engine.tick(), vec!["Тихо не пишу".to_string()]);
    }

    #[test]
    fn builtin_commands_answer() {
        let clock = Arc::new(AtomicI64::new(60_000));
        let engine = clocked(
            json!({ "prefix": "!", "channel": "chan", "commands": [], "startedAt": 0 }),
            clock,
        );

        assert!(engine
            .handle_chat(&json!({ "user": "u", "badges": [], "message": "!so bob" }))
            .unwrap()
            .contains("bob"));
        assert_eq!(
            engine.handle_chat(&json!({ "user": "u", "badges": [], "message": "!uptime" })),
            Some("Стрим идёт: 1м 0с".to_string())
        );
        let ball = engine
            .handle_chat(&json!({ "user": "u", "badges": [], "message": "!8ball" }))
            .unwrap();
        assert!(!ball.is_empty());

        let roll = engine
            .handle_chat(&json!({ "user": "u", "badges": [], "message": "!roll 6" }))
            .unwrap();
        assert!(roll.starts_with("@u выбросил "), "{roll}");
        assert!(roll.ends_with("(1–6)"), "{roll}");
    }
}
