//! Twitch-чат: чтение IRC, сборка сообщения, отправка и модерация.
//!
//! Порт `server/integrations/twitch-chat.js`. Чтение чата — анонимный IRC
//! (`justinfan`), как в `tmi.js`: разбор строк ([`parse_irc_line`]), рукопожатие
//! ([`handshake_lines`]) и драйвер [`run_chat`], который гоняет их через
//! инжектируемый [`ChatTransport`] (в тестах — канал, в приложении — WebSocket).
//! Плюс то, что проверяется без живого чата: сборка сообщения из тегов
//! ([`chat_message_from_tags`]) и действия по Helix-API — отправка сообщения и
//! модерация ([`ChatSender`]).
//!
//! Сам сокет (`tokio-tungstenite`) и подключение драйвера к реестру — следующий
//! шаг: здесь транспорт отдан наружу, чтобы протокол проверялся без сети.
//!
//! Сеть и токены для отправки инжектируются так же, как в
//! [`crate::integrations::twitch_helix`]: `PostFn` для запросов и [`Tokens`] для
//! доступа к токену. Правило, ради которого это отдельный слой: сетевой сбой не
//! роняет обещание — вызывающий (панель, чат-бот) ждёт объект с ошибкой, а не
//! исключение.
//!
//! Отправка идёт через Helix (`/helix/chat/messages`), поэтому между сообщениями
//! выдерживается пауза (Twitch тихо режет после ~20 сообщений за 30 секунд).
//! Резерв слота — [`ChatRateLimiter`]; саму паузу делает переданный `sleep`
//! (в приложении — `tokio`), без него ожидания нет.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::integrations::nick_color::nick_color;
use crate::integrations::twitch_helix::{is_authorized, HttpOutcome, PostFn, Tokens};
use crate::protocol::event_types;
use crate::storage::history::{js_number_or_zero, js_truthy};

/// Куда уходит сообщение.
pub const CHAT_SEND_URL: &str = "https://api.twitch.tv/helix/chat/messages";
/// Куда уходит бан/таймаут.
pub const MODERATION_URL: &str = "https://api.twitch.tv/helix/moderation/bans";

/// Пауза между сообщениями: Twitch режет после ~20 за 30 секунд.
pub const CHAT_SEND_INTERVAL_MS: i64 = 1600;

/// Сколько символов причины принимает модерация.
const REASON_LIMIT: usize = 500;

/// Часы — подменяются в тестах.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
/// Пауза между сообщениями; в приложении — `tokio`, в тестах — своя.
pub type SleepFn = Arc<dyn Fn(i64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// Собрать сообщение для шины из IRC-тегов Twitch.
///
/// Цвет берётся из тега `color`; если тег пуст, считается по идентификатору
/// зрителя — так он остаётся стабильным, а не сваливается в один серый.
pub fn chat_message_from_tags(tags: Option<&Value>, message: &str) -> Value {
    let empty = Map::new();
    let tags = tags.and_then(Value::as_object).unwrap_or(&empty);

    let display = tags
        .get("display-name")
        .filter(|value| js_truthy(Some(value)));
    let username = tags.get("username").filter(|value| js_truthy(Some(value)));
    let user_id = tags.get("user-id").filter(|value| js_truthy(Some(value)));

    let user = display
        .or(username)
        .map(crate::state::js_string)
        .unwrap_or_else(|| "viewer".to_string());
    let user_id_text = user_id.map(crate::state::js_string).unwrap_or_default();
    let color = match tags.get("color").filter(|value| js_truthy(Some(value))) {
        Some(color) => crate::state::js_string(color),
        None => nick_color(user_id.or(username).or(display).unwrap_or(&Value::Null)),
    };
    let badges = tags
        .get("badges")
        .and_then(Value::as_object)
        .map(|badges| {
            badges
                .keys()
                .map(|key| Value::from(key.as_str()))
                .collect::<Vec<Value>>()
        })
        .unwrap_or_default();
    // Версии значков нужны, чтобы найти картинку на CDN (`badgeImages`); в
    // самом кадре их использует только сервер.
    let badge_versions = tags
        .get("badges")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let emotes = tags.get("emotes").cloned().unwrap_or_else(|| json!({}));

    let mut out = Map::new();
    out.insert("user".to_string(), Value::from(user));
    out.insert("userId".to_string(), Value::from(user_id_text));
    out.insert("color".to_string(), Value::from(color));
    out.insert("badges".to_string(), Value::Array(badges));
    out.insert("badgeVersions".to_string(), Value::Object(badge_versions));
    out.insert("message".to_string(), Value::from(message));
    out.insert("emotes".to_string(), emotes);
    Value::Object(out)
}

// ─── Чтение чата (IRC, режим justinfan) ──────────────────────────────────────

/// Адрес анонимного IRC-чата Twitch (WebSocket).
pub const IRC_WS_URL: &str = "wss://irc-ws.chat.twitch.tv:443";

/// Разобранная строка IRC.
#[derive(Debug, Clone, PartialEq)]
pub enum IrcLine {
    /// `PING <аргумент>` — на него отвечают `PONG <аргумент>`.
    Ping(String),
    /// Сообщение чата: теги в форме tmi.js и текст.
    Privmsg {
        tags: Map<String, Value>,
        text: String,
    },
    /// Числовой `001` — вход выполнен.
    Welcome,
    /// Всё прочее (`JOIN`, `NOTICE`, прочие числовые).
    Other,
}

/// Итог разбора одного кадра: что ответить, что отдать шине, подключились ли.
#[derive(Debug, Default)]
pub struct IrcOutcome {
    /// Строки, которые надо отправить обратно (ответы на `PING`).
    pub replies: Vec<String>,
    /// Сообщения чата для шины.
    pub messages: Vec<Value>,
    /// Пришёл `001` — вход выполнен.
    pub connected: bool,
}

/// Разобрать одну строку IRC.
///
/// Формат — `@теги :префикс КОМАНДА параметры`, где любой из первых двух кусков
/// может отсутствовать. `tmi.js` разбирает теги до формы сообщения, поэтому
/// `badges` и `emotes` здесь собираются в объекты, а `username` (которого в
/// тегах нет) берётся из префикса — иначе логин для цвета ника потеряется.
pub fn parse_irc_line(line: &str) -> IrcLine {
    let line = line.trim_end_matches(['\r', '\n']);

    // Теги: `@key=value;...` до первого пробела.
    let (tags, rest) = match line.strip_prefix('@') {
        Some(after) => match after.find(' ') {
            Some(space) => (parse_tags(&after[..space]), &after[space + 1..]),
            None => return IrcLine::Other,
        },
        None => (Map::new(), line),
    };

    // Префикс: `:nick!user@host` до первого пробела.
    let (nick, rest) = match rest.strip_prefix(':') {
        Some(after) => match after.find(' ') {
            Some(space) => (
                Some(after[..space].split('!').next().unwrap_or("")),
                &after[space + 1..],
            ),
            None => (None, ""),
        },
        None => (None, rest),
    };

    // Команда и её параметры.
    let (command, params) = match rest.find(' ') {
        Some(space) => (&rest[..space], &rest[space + 1..]),
        None => (rest, ""),
    };

    match command {
        "PING" => IrcLine::Ping(params.to_string()),
        "PRIVMSG" => {
            let text = match params.find(" :") {
                Some(index) => params[index + 2..].to_string(),
                None => String::new(),
            };
            let mut tags = tags;
            if let Some(nick) = nick.filter(|nick| !nick.is_empty()) {
                tags.insert("username".to_string(), Value::from(nick));
            }
            IrcLine::Privmsg { tags, text }
        }
        "001" => IrcLine::Welcome,
        _ => IrcLine::Other,
    }
}

/// Разобрать строку тегов IRC (`key=value;...`) в форму tmi.js.
///
/// Тег без `=` считается `true`, значения разэкранируются, а `emotes` и
/// `badges`/`badge-info` превращаются в объекты — ровно как это делает `tmi.js`.
fn parse_tags(raw: &str) -> Map<String, Value> {
    let mut tags = Map::new();
    for pair in raw.split(';') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = match pair.split_once('=') {
            Some((key, value)) => (key, unescape_tag(value)),
            None => {
                tags.insert(pair.to_string(), Value::Bool(true));
                continue;
            }
        };
        if key.is_empty() {
            continue;
        }
        let parsed = match key {
            "emotes" => Value::Object(parse_emotes(&value)),
            "badges" | "badge-info" => Value::Object(parse_badges(&value)),
            _ => Value::from(value),
        };
        tags.insert(key.to_string(), parsed);
    }
    tags
}

/// Разэкранировать значение тега: Twitch прячет пробел, CR, LF, `;` и `\`.
fn unescape_tag(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some(':') => out.push(';'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Разобрать тег `emotes` (`25:0-4,6-9/1902:12-19`) в `{ "25": ["0-4", "6-9"] }`.
fn parse_emotes(raw: &str) -> Map<String, Value> {
    let mut emotes = Map::new();
    for emote in raw.split('/') {
        if let Some((id, ranges)) = emote.split_once(':') {
            if id.is_empty() || ranges.is_empty() {
                continue;
            }
            emotes.insert(
                id.to_string(),
                Value::Array(ranges.split(',').map(Value::from).collect()),
            );
        }
    }
    emotes
}

/// Разобрать тег `badges` (`moderator/1,subscriber/12`) в объект версий.
fn parse_badges(raw: &str) -> Map<String, Value> {
    let mut badges = Map::new();
    for badge in raw.split(',') {
        if badge.is_empty() {
            continue;
        }
        let (name, version) = badge.split_once('/').unwrap_or((badge, "1"));
        if name.is_empty() {
            continue;
        }
        badges.insert(name.to_string(), Value::from(version));
    }
    badges
}

/// Сообщение чата Twitch для шины: как [`chat_message_from_tags`], но с
/// источником — по нему чат-бот отличает Twitch от YouTube.
pub fn chat_message(tags: &Map<String, Value>, text: &str) -> Value {
    let mut message = chat_message_from_tags(Some(&Value::Object(tags.clone())), text);
    if let Value::Object(map) = &mut message {
        map.insert("source".to_string(), Value::from("twitch"));
    }
    message
}

/// Разобрать кадр IRC: в одном кадре может прийти несколько строк через `\r\n`.
pub fn handle_irc_frame(frame: &str) -> IrcOutcome {
    let mut outcome = IrcOutcome::default();
    for line in frame.split("\r\n") {
        match parse_irc_line(line) {
            IrcLine::Ping(argument) => outcome.replies.push(format!("PONG {argument}")),
            IrcLine::Privmsg { tags, text } => outcome.messages.push(chat_message(&tags, &text)),
            IrcLine::Welcome => outcome.connected = true,
            IrcLine::Other => {}
        }
    }
    outcome
}

/// Строки анонимного входа — режим `justinfan` из `tmi.js`: без токена,
/// запрашиваются только теги и команды (`membership` пропущен — значки и так
/// не нужны), затем `JOIN` канала.
pub fn handshake_lines(channel: &str, nick: &str) -> Vec<String> {
    vec![
        "CAP REQ :twitch.tv/tags twitch.tv/commands".to_string(),
        "PASS SCHMOOPIIE".to_string(),
        format!("NICK {nick}"),
        format!("JOIN #{}", normalize_channel(channel)),
    ]
}

/// Канал в форме Twitch: без `#`, в нижнем регистре — как это делает `tmi.js`.
pub fn normalize_channel(channel: &str) -> String {
    channel.trim().trim_start_matches('#').to_lowercase()
}

/// Анонимный ник `justinfan<номер>`: номер разносит запуски, чтобы Twitch не
/// принял второе подключение за дубль первого.
pub fn anonymous_nick(seed: u128) -> String {
    format!("justinfan{}", seed % 80_000 + 1_000)
}

/// Будущее отправки строки.
pub type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;
/// Будущее получения кадра.
pub type RecvFuture<'a> = Pin<Box<dyn Future<Output = Result<Option<String>, String>> + Send + 'a>>;
/// Будущее подключения к чату: `Ok` — готовый сокет, `Err` — текст сбоя.
pub type ConnectFuture =
    Pin<Box<dyn Future<Output = Result<Box<dyn ChatTransport>, String>> + Send>>;

/// Транспорт IRC-чата: соединение уже установлено, драйвер только шлёт строки и
/// читает кадры. В приложении это WebSocket на `tokio`, в тестах — канал.
pub trait ChatTransport: Send {
    /// Отправить строку; ошибка — соединение порвалось.
    fn send(&mut self, line: String) -> SendFuture<'_>;

    /// Получить следующий кадр; `Ok(None)` — соединение закрылось штатно.
    fn recv(&mut self) -> RecvFuture<'_>;
}

/// Ведёт одно подключение к анонимному чату: рукопожатие, ответы на `PING` и
/// раздача сообщений через `emit`. Возвращается, когда соединение закрылось.
///
/// `emit` получает готовое событие шины в форме `commands::broadcast`
/// (`{ "type": …, "payload": … }`), чтобы драйвер не зависел от транспорта шины.
/// Пустой канал — `not_configured`, как в JS.
pub async fn run_chat<T, E>(transport: &mut T, channel: &str, nick: &str, mut emit: E)
where
    T: ChatTransport + ?Sized,
    E: FnMut(Value),
{
    if normalize_channel(channel).is_empty() {
        emit(connection_status("not_configured"));
        return;
    }
    emit(connection_status("connecting"));
    for line in handshake_lines(channel, nick) {
        if transport.send(line).await.is_err() {
            emit(connection_status("error"));
            return;
        }
    }
    loop {
        match transport.recv().await {
            Ok(Some(frame)) => {
                let outcome = handle_irc_frame(&frame);
                if outcome.connected {
                    emit(connection_status("connected"));
                }
                for reply in outcome.replies {
                    if transport.send(reply).await.is_err() {
                        emit(connection_status("error"));
                        return;
                    }
                }
                for message in outcome.messages {
                    emit(bus_event(event_types::CHAT_MESSAGE, message));
                }
            }
            Ok(None) => {
                emit(connection_status("disconnected"));
                return;
            }
            Err(_) => {
                emit(connection_status("error"));
                return;
            }
        }
    }
}

/// Событие `connection_status` для сервиса чата.
fn connection_status(status: &str) -> Value {
    bus_event(
        event_types::CONNECTION_STATUS,
        json!({ "service": "twitchChat", "status": status }),
    )
}

/// Событие шины в той же форме, что рассылает `commands::broadcast`.
fn bus_event(kind: &str, payload: Value) -> Value {
    json!({ "type": kind, "payload": payload })
}

/// Тестовые сообщения для панели (`cmd_test_chat`): те же зрители, цвета,
/// значки и тексты, что в JS. `count` зажимается в `1..=20` (не число — единица),
/// а дробное число так же даёт лишнее сообщение, как цикл `i < count` в JS.
pub fn test_chat_messages(count: &Value) -> Vec<Value> {
    const USERS: [(&str, &str); 5] = [
        ("test_viewer", "#7ee0d6"),
        ("chat_fan", "#f4b8e4"),
        ("pixel_lover", "#a6d189"),
        ("stream_buddy", "#e5c890"),
        ("lurker_42", "#8caaee"),
    ];
    const MESSAGES: [&str; 6] = [
        "Привет всем! 👋",
        "Классный стрим 🔥",
        "Как дела, чат?",
        "Погнали!",
        "Это тестовое сообщение",
        "Ловлю каждое слово 😄",
    ];

    let total = js_number_or_zero(Some(count)).clamp(1.0, 20.0);
    let mut messages = Vec::new();
    let mut index = 0usize;
    while (index as f64) < total {
        let (user, color) = USERS[index % USERS.len()];
        let (badges, badge_versions) = match index % 3 {
            0 => (json!(["moderator"]), json!({ "moderator": "1" })),
            1 => (json!(["subscriber"]), json!({ "subscriber": "1" })),
            _ => (json!([]), json!({})),
        };
        messages.push(json!({
            "user": user,
            "color": color,
            "badges": badges,
            "badgeVersions": badge_versions,
            "message": MESSAGES[index % MESSAGES.len()],
            "isTest": true,
        }));
        index += 1;
    }
    messages
}

/// Счётчик паузы между сообщениями.
#[derive(Default)]
pub struct ChatRateLimiter {
    reserved_until: AtomicI64,
    interval_ms: i64,
}

impl ChatRateLimiter {
    pub fn new(interval_ms: i64) -> Self {
        Self {
            reserved_until: AtomicI64::new(0),
            interval_ms,
        }
    }

    /// Занять следующий слот и вернуть, сколько ждать до него.
    pub fn reserve(&self, now: i64) -> i64 {
        let reserved = self.reserved_until.load(Ordering::SeqCst);
        let wait = (reserved - now).max(0);
        let next = now.max(reserved) + self.interval_ms;
        self.reserved_until.store(next, Ordering::SeqCst);
        wait
    }
}

/// Отправка сообщений и модерация в канале.
///
/// Клонируется специально: вызовы из команд идут в фоновую задачу, а части
/// (`PostFn`, `Tokens`, счётчик слотов) общие — поэтому Clone дешёвый.
#[derive(Clone)]
pub struct ChatSender {
    http: PostFn,
    tokens: Tokens,
    limiter: Arc<ChatRateLimiter>,
    sleep: Option<SleepFn>,
    now: Clock,
}

impl ChatSender {
    pub fn new(http: PostFn, tokens: Tokens, limiter: ChatRateLimiter) -> Self {
        Self {
            http,
            tokens,
            limiter: Arc::new(limiter),
            sleep: None,
            now: Arc::new(|| chrono::Utc::now().timestamp_millis()),
        }
    }

    pub fn with_sleep(mut self, sleep: SleepFn) -> Self {
        self.sleep = Some(sleep);
        self
    }

    pub fn with_clock(mut self, now: Clock) -> Self {
        self.now = now;
        self
    }

    /// Отправить сообщение в чат канала.
    pub async fn send_message(&self, twitch: &Value, message: &str) -> Value {
        let text = message.trim();
        if text.is_empty() {
            return json!({ "ok": false, "error": "empty_message" });
        }
        if !is_authorized(twitch) {
            return not_configured();
        }
        let Some(mut token) = ensure_token(&self.tokens).await else {
            return auth_error();
        };

        let wait = self.limiter.reserve((self.now)());
        if wait > 0 {
            if let Some(sleep) = &self.sleep {
                sleep(wait).await;
            }
        }

        let body = json!({
            "broadcaster_id": text_of(twitch, "broadcasterId"),
            "sender_id": text_of(twitch, "broadcasterId"),
            "message": text,
        });
        let mut outcome = post(&self.http, CHAT_SEND_URL, &token, &body).await;
        if outcome.network_error.is_none() && outcome.status == 401 {
            let Some(refreshed) = refresh_token(&self.tokens).await else {
                return auth_error();
            };
            token = refreshed;
            outcome = post(&self.http, CHAT_SEND_URL, &token, &body).await;
        }

        finish(&outcome, |body| {
            let sent = body
                .get("data")
                .and_then(Value::as_array)
                .and_then(|data| data.first());
            json!({
                "messageId": sent
                    .and_then(|sent| sent.get("message_id"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "isSent": match sent {
                    Some(sent) => Value::Bool(sent.get("is_sent") == Some(&Value::Bool(true))),
                    None => Value::Bool(true),
                },
            })
        })
    }

    /// Забанить или затаймаутить пользователя.
    ///
    /// Бот действует как вещатель, поэтому `moderator_id` совпадает с
    /// `broadcaster_id`. `duration` > 0 — таймаут; `None` — перманентный бан.
    pub async fn moderate_user(
        &self,
        twitch: &Value,
        user_id: &Value,
        duration: Option<f64>,
        reason: &str,
    ) -> Value {
        let target = crate::state::js_string(user_id).trim().to_string();
        if target.is_empty() {
            return json!({ "ok": false, "error": "missing_user_id" });
        }
        if !is_authorized(twitch) {
            return not_configured();
        }
        let Some(mut token) = ensure_token(&self.tokens).await else {
            return auth_error();
        };

        let mut data = Map::new();
        data.insert("user_id".to_string(), Value::from(target));
        data.insert(
            "reason".to_string(),
            Value::from(
                reason_text(reason)
                    .chars()
                    .take(REASON_LIMIT)
                    .collect::<String>(),
            ),
        );
        if let Some(duration) = duration {
            if duration.is_finite() && duration > 0.0 {
                data.insert(
                    "duration".to_string(),
                    Value::from(duration.round().max(1.0) as i64),
                );
            }
        }

        let broadcaster = text_of(twitch, "broadcasterId");
        let url = format!(
            "{MODERATION_URL}?broadcaster_id={}&moderator_id={}",
            encode_query(&broadcaster),
            encode_query(&broadcaster)
        );
        let body = json!({ "data": Value::Object(data) });
        let mut outcome = post(&self.http, &url, &token, &body).await;
        if outcome.network_error.is_none() && outcome.status == 401 {
            let Some(refreshed) = refresh_token(&self.tokens).await else {
                return auth_error();
            };
            token = refreshed;
            outcome = post(&self.http, &url, &token, &body).await;
        }

        finish(&outcome, |_body| json!({}))
    }
}

async fn post(http: &PostFn, url: &str, token: &str, body: &Value) -> HttpOutcome {
    http(url, token, body).await
}

async fn ensure_token(tokens: &Tokens) -> Option<String> {
    (tokens.ensure)().await.ok()
}

async fn refresh_token(tokens: &Tokens) -> Option<String> {
    (tokens.refresh)().await.ok()
}

fn finish(outcome: &HttpOutcome, extract: impl FnOnce(&Value) -> Value) -> Value {
    if outcome.network_error.is_some() {
        return json!({ "ok": false, "error": "network" });
    }
    if !(200..300).contains(&outcome.status) {
        let message = outcome.body.get("message").and_then(Value::as_str);
        return json!({
            "ok": false,
            "error": message.map(str::to_string).unwrap_or_else(|| format!("http_{}", outcome.status)),
        });
    }
    let mut result = extract(&outcome.body);
    if let Some(object) = result.as_object_mut() {
        object.insert("ok".to_string(), Value::Bool(true));
    }
    result
}

fn reason_text(reason: &str) -> String {
    if reason.trim().is_empty() {
        "Нарушение правил чата".to_string()
    } else {
        reason.to_string()
    }
}

fn not_configured() -> Value {
    json!({ "ok": false, "error": "not_configured" })
}

fn auth_error() -> Value {
    json!({ "ok": false, "error": "auth" })
}

fn text_of(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(value) if js_truthy(Some(value)) => crate::state::js_string(value),
        _ => String::new(),
    }
}

/// `encodeURIComponent` для значений query: идентификаторы — цифры, но пусть
/// будет честно.
fn encode_query(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(char::from(byte));
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use super::*;
    use crate::integrations::nick_color::{nick_color, DEFAULT_NICK_COLOR};

    fn authorized() -> Value {
        json!({
            "channel": "chan",
            "clientId": "cid",
            "userAccessToken": "tok",
            "broadcasterId": "bid",
        })
    }

    fn tokens() -> Tokens {
        Tokens {
            ensure: Arc::new(|| Box::pin(async { Ok("tok".to_string()) })),
            refresh: Arc::new(|| Box::pin(async { Ok("newtok".to_string()) })),
        }
    }

    fn sender(http: PostFn) -> ChatSender {
        ChatSender::new(http, tokens(), ChatRateLimiter::new(CHAT_SEND_INTERVAL_MS))
    }

    fn offline() -> PostFn {
        Arc::new(|_url: &str, _token: &str, _body: &Value| {
            Box::pin(async {
                HttpOutcome {
                    status: 0,
                    body: json!({}),
                    network_error: Some("offline".to_string()),
                }
            })
        })
    }

    #[test]
    fn the_color_comes_from_the_tag() {
        let message = chat_message_from_tags(
            Some(&json!({ "display-name": "Зритель", "user-id": "42", "color": "#1e90ff" })),
            "привет",
        );
        assert_eq!(message["color"], json!("#1e90ff"));
        assert_eq!(message["user"], json!("Зритель"));
        assert_eq!(message["userId"], json!("42"));
        assert_eq!(message["message"], json!("привет"));
    }

    #[test]
    fn an_empty_color_tag_becomes_a_color_by_user_id() {
        let message = chat_message_from_tags(
            Some(&json!({ "display-name": "Зритель", "user-id": "42", "color": "" })),
            "привет",
        );
        assert_eq!(message["color"], json!(nick_color(&json!("42"))));
        assert_ne!(message["color"], json!(DEFAULT_NICK_COLOR));
    }

    #[test]
    fn without_a_user_id_the_color_uses_the_login() {
        let message = chat_message_from_tags(
            Some(&json!({ "display-name": "Зритель", "username": "zritel" })),
            "привет",
        );
        assert_eq!(message["color"], json!(nick_color(&json!("zritel"))));
    }

    #[test]
    fn without_an_author_the_old_solid_color_stays() {
        let message = chat_message_from_tags(Some(&json!({})), "привет");
        assert_eq!(message["user"], json!("viewer"));
        assert_eq!(message["userId"], json!(""));
        assert_eq!(message["color"], json!(DEFAULT_NICK_COLOR));
    }

    #[test]
    fn badges_and_emotes_come_from_the_tags() {
        let message = chat_message_from_tags(
            Some(
                &json!({ "badges": { "moderator": "1", "subscriber": "12" }, "emotes": { "25": ["0-4"] } }),
            ),
            "hi",
        );
        assert_eq!(message["badges"], json!(["moderator", "subscriber"]));
        // Версии нужны серверу, чтобы найти картинки значков (`badgeImages`).
        assert_eq!(
            message["badgeVersions"],
            json!({ "moderator": "1", "subscriber": "12" })
        );
        assert_eq!(message["emotes"], json!({ "25": ["0-4"] }));
    }

    #[test]
    fn empty_tags_still_build_a_message() {
        assert_eq!(
            chat_message_from_tags(None, "hi"),
            json!({
                "user": "viewer",
                "userId": "",
                "color": DEFAULT_NICK_COLOR,
                "badges": [],
                "badgeVersions": {},
                "message": "hi",
                "emotes": {},
            })
        );
    }

    #[tokio::test]
    async fn a_network_failure_is_reported_not_raised_when_sending() {
        let result = sender(offline())
            .send_message(&authorized(), "привет")
            .await;
        assert_eq!(result, json!({ "ok": false, "error": "network" }));
    }

    #[tokio::test]
    async fn a_network_failure_is_reported_not_raised_when_moderating() {
        let result = sender(offline())
            .moderate_user(&authorized(), &json!("42"), Some(60.0), "test")
            .await;
        assert_eq!(result, json!({ "ok": false, "error": "network" }));
    }

    #[tokio::test]
    async fn an_empty_message_is_refused_before_any_request() {
        let result = sender(offline()).send_message(&authorized(), "   ").await;
        assert_eq!(result, json!({ "ok": false, "error": "empty_message" }));
    }

    #[tokio::test]
    async fn missing_user_id_is_refused_before_any_request() {
        let result = sender(offline())
            .moderate_user(&authorized(), &json!("  "), None, "test")
            .await;
        assert_eq!(result, json!({ "ok": false, "error": "missing_user_id" }));
    }

    #[tokio::test]
    async fn a_sent_message_returns_its_id_and_marks_itself_sent() {
        let http: PostFn = Arc::new(|url: &str, _token: &str, _body: &Value| {
            let url = url.to_string();
            Box::pin(async move {
                assert_eq!(url, CHAT_SEND_URL);
                HttpOutcome {
                    status: 200,
                    body: json!({ "data": [{ "message_id": "m1", "is_sent": true }] }),
                    network_error: None,
                }
            })
        });
        let result = sender(http).send_message(&authorized(), "привет").await;
        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["messageId"], json!("m1"));
        assert_eq!(result["isSent"], json!(true));
    }

    #[test]
    fn the_rate_limiter_reserves_slots_in_order() {
        let limiter = ChatRateLimiter::new(1600);
        // Первый вызов свободен и занимает слот [1000, 2600).
        assert_eq!(limiter.reserve(1000), 0);
        // Второй сразу — ждёт до конца первого слота.
        assert_eq!(limiter.reserve(1000), 1600);
        // Третий в тот же момент — ждёт уже до конца второго слота.
        assert_eq!(limiter.reserve(1000), 3200);
        // Когда все занятые слоты прошли — снова не ждём.
        assert_eq!(limiter.reserve(1000 + 1600 * 3), 0);
    }

    // ─── Чтение IRC ───────────────────────────────────

    #[test]
    fn a_ping_line_asks_for_a_pong() {
        assert_eq!(
            parse_irc_line("PING :tmi.twitch.tv"),
            IrcLine::Ping(":tmi.twitch.tv".to_string())
        );
        let outcome = handle_irc_frame("PING :tmi.twitch.tv\r\n");
        assert_eq!(outcome.replies, ["PONG :tmi.twitch.tv"]);
        assert!(outcome.messages.is_empty());
    }

    #[test]
    fn a_privmsg_takes_the_login_from_the_prefix() {
        match parse_irc_line(":zritel!zritel@zritel.tmi.twitch.tv PRIVMSG #chan :привет мир")
        {
            IrcLine::Privmsg { tags, text } => {
                // Логина нет среди тегов — он берётся из префикса, иначе цвет
                // ника считается не по чему.
                assert_eq!(tags["username"], json!("zritel"));
                assert_eq!(text, "привет мир");
            }
            other => panic!("ожидалось сообщение, пришло {other:?}"),
        }
    }

    #[test]
    fn tags_are_unescaped_and_badges_and_emotes_become_objects() {
        let line = "@badges=moderator/1,subscriber/12;color=#1e90ff;display-name=Zritel\\sOne;emotes=25:0-4,6-9;user-id=42 :zritel!zritel@zritel.tmi.twitch.tv PRIVMSG #chan :hi";
        let outcome = handle_irc_frame(line);
        assert_eq!(outcome.messages.len(), 1);
        let message = &outcome.messages[0];
        assert_eq!(message["user"], json!("Zritel One"));
        assert_eq!(message["userId"], json!("42"));
        assert_eq!(message["color"], json!("#1e90ff"));
        assert_eq!(message["badges"], json!(["moderator", "subscriber"]));
        assert_eq!(message["emotes"], json!({ "25": ["0-4", "6-9"] }));
        assert_eq!(message["message"], json!("hi"));
        assert_eq!(message["source"], json!("twitch"));
    }

    #[test]
    fn a_frame_can_carry_several_lines_and_the_welcome_marks_connection() {
        let frame = concat!(
            ":tmi.twitch.tv 001 justinfan42 :Welcome, GLHF!\r\n",
            "PING :tmi.twitch.tv\r\n",
            ":zritel!zritel@zritel.tmi.twitch.tv PRIVMSG #chan :привет\r\n",
        );
        let outcome = handle_irc_frame(frame);
        assert!(outcome.connected);
        assert_eq!(outcome.replies, ["PONG :tmi.twitch.tv"]);
        assert_eq!(outcome.messages.len(), 1);
        assert_eq!(outcome.messages[0]["message"], json!("привет"));
    }

    #[test]
    fn the_handshake_joins_a_normalized_channel() {
        assert_eq!(normalize_channel("#Chan"), "chan");
        assert_eq!(normalize_channel(" chan "), "chan");
        let lines = handshake_lines("#Chan", "justinfan7");
        assert_eq!(lines[0], "CAP REQ :twitch.tv/tags twitch.tv/commands");
        assert_eq!(lines[1], "PASS SCHMOOPIIE");
        assert_eq!(lines[2], "NICK justinfan7");
        assert_eq!(lines[3], "JOIN #chan");
        assert!(anonymous_nick(0).starts_with("justinfan"));
        assert_ne!(anonymous_nick(0), anonymous_nick(1));
    }

    /// Транспорт-канал: кадры заготовлены заранее, отправленное складывается в
    /// общий список. Так драйвер проверяется без сети.
    struct FakeTransport {
        incoming: VecDeque<String>,
        sent: Arc<Mutex<Vec<String>>>,
    }

    impl FakeTransport {
        fn new(incoming: &[&str]) -> Self {
            Self {
                incoming: incoming.iter().map(|frame| (*frame).to_string()).collect(),
                sent: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl ChatTransport for FakeTransport {
        fn send(&mut self, line: String) -> SendFuture<'_> {
            let sent = Arc::clone(&self.sent);
            Box::pin(async move {
                sent.lock().unwrap().push(line);
                Ok(())
            })
        }

        fn recv(&mut self) -> RecvFuture<'_> {
            let next = self.incoming.pop_front();
            Box::pin(async move { Ok(next) })
        }
    }

    /// Транспорт, который сразу сообщает об обрыве.
    struct BrokenTransport;

    impl ChatTransport for BrokenTransport {
        fn send(&mut self, _line: String) -> SendFuture<'_> {
            Box::pin(async { Ok(()) })
        }

        fn recv(&mut self) -> RecvFuture<'_> {
            Box::pin(async { Err("обрыв".to_string()) })
        }
    }

    #[tokio::test]
    async fn the_reader_greets_replies_to_ping_and_reports_every_status() {
        let mut transport = FakeTransport::new(&[
            ":tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!\r\n",
            ":zritel!zritel@zritel.tmi.twitch.tv PRIVMSG #chan :привет\r\n",
            "PING :tmi.twitch.tv\r\n",
        ]);
        let sent = Arc::clone(&transport.sent);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        run_chat(&mut transport, "#Chan", "justinfan1", move |event| {
            sink.lock().unwrap().push(event);
        })
        .await;

        assert_eq!(
            *sent.lock().unwrap(),
            [
                "CAP REQ :twitch.tv/tags twitch.tv/commands",
                "PASS SCHMOOPIIE",
                "NICK justinfan1",
                "JOIN #chan",
                "PONG :tmi.twitch.tv",
            ]
        );

        let events = events.lock().unwrap();
        let statuses: Vec<&str> = events
            .iter()
            .filter(|event| event["type"] == json!("connection_status"))
            .map(|event| event["payload"]["status"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(statuses, ["connecting", "connected", "disconnected"]);
        let chat = events
            .iter()
            .find(|event| event["type"] == json!("chat_message"))
            .expect("сообщение чата");
        assert_eq!(chat["payload"]["message"], json!("привет"));
        assert_eq!(chat["payload"]["source"], json!("twitch"));
    }

    #[tokio::test]
    async fn an_empty_channel_reports_not_configured_without_connecting() {
        let mut transport = FakeTransport::new(&[]);
        let sent = Arc::clone(&transport.sent);
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        run_chat(&mut transport, "   ", "justinfan1", move |event| {
            sink.lock().unwrap().push(event);
        })
        .await;
        assert!(sent.lock().unwrap().is_empty());
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["payload"]["status"], json!("not_configured"));
    }

    #[tokio::test]
    async fn a_broken_socket_is_reported_as_an_error() {
        let mut transport = BrokenTransport;
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        run_chat(&mut transport, "chan", "justinfan1", move |event| {
            sink.lock().unwrap().push(event);
        })
        .await;
        let events = events.lock().unwrap();
        let last = events.last().expect("событие");
        assert_eq!(last["payload"]["status"], json!("error"));
    }

    #[test]
    fn test_chat_messages_cycle_viewers_and_badges() {
        let messages = test_chat_messages(&json!(3));
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["user"], json!("test_viewer"));
        assert_eq!(messages[0]["badges"], json!(["moderator"]));
        assert_eq!(messages[1]["user"], json!("chat_fan"));
        assert_eq!(messages[1]["badges"], json!(["subscriber"]));
        assert_eq!(messages[2]["badges"], json!([]));
        assert_eq!(messages[0]["isTest"], json!(true));
        assert_eq!(messages[0]["color"], json!("#7ee0d6"));
    }

    #[test]
    fn test_chat_count_is_clamped() {
        assert_eq!(test_chat_messages(&json!(0)).len(), 1);
        assert_eq!(test_chat_messages(&Value::Null).len(), 1);
        assert_eq!(test_chat_messages(&json!("мусор")).len(), 1);
        assert_eq!(test_chat_messages(&json!(100)).len(), 20);
        // Дробное число даёт лишнее сообщение — как цикл `i < count` в JS.
        assert_eq!(test_chat_messages(&json!(2.5)).len(), 3);
    }
}
