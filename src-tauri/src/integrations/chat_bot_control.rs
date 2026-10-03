//! Обвязка чат-бота: кормит движок сообщениями чата и отвечает через Helix.
//!
//! Порт `startChatBot` из `server/integrations/chat-bot.js`: уровень прав по
//! бейджам, команды модерации (`!timeout`/`!ban`), авто-модерация, ответы команд
//! и таймеры. Сам движок — в [`crate::integrations::chat_bot`], модерация — в
//! [`crate::integrations::chat_moderation`], отправка — в
//! [`crate::integrations::twitch_chat::ChatSender`]; здесь только их связка.
//!
//! Отличие от JS: отправка асинхронная, поэтому задачи уходят в инжектируемый
//! `spawn` (в приложении — рантайм Tauri, в тестах — место под задачу). Эхо
//! собственных ответов бот помнит и пропускает: ответы уходят через Helix и
//! возвращаются обычным `chat_message`, как и в JS.
//!
//! Варны модерации живут поверх базы ([`store_from_database`]), поэтому
//! переживают пересборку движка и перезапуск — как `state.db` в JS; счётчик
//! один на бота, а не создаётся заново на каждый `restart`.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::oneshot;

use crate::integrations::chat_bot::{self, BotEngine, Clock, ModCommand};
use crate::integrations::chat_moderation::{ModerationEngine, ModerationStore, WarnsBackend};
use crate::integrations::twitch_chat::ChatSender;
use crate::integrations::twitch_chat_control::SpawnFn;
use crate::storage::db::Database;
use crate::storage::history::{js_number_or_zero, js_truthy};

/// Как часто проверяются таймеры — как `setInterval(..., 15000)` в JS.
const TICK_MS: u64 = 15_000;
/// Сколько держим недавние ответы, чтобы не отвечать на собственное эхо.
const RECENT_LIMIT: usize = 20;
const RECENT_WINDOW_MS: i64 = 10_000;

/// Собранный бот: движок команд, модерация и основные реквизиты.
struct BotRuntime {
    engine: BotEngine,
    moderation: ModerationEngine,
    prefix: String,
    channel: String,
}

/// Чат-бот приложения.
pub struct ChatBot {
    sender: ChatSender,
    spawn: SpawnFn,
    clock: Clock,
    /// Настройки Twitch на момент отправки.
    twitch: Arc<dyn Fn() -> Value + Send + Sync>,
    /// Варны модерации: один счётчик на бота, чтобы они не терялись при
    /// пересборке движка (смена настроек, переподключение).
    moderation: Arc<ModerationStore>,
    runtime: Mutex<Option<BotRuntime>>,
    /// Логин (в нижнем регистре) → идентификатор: нужен для `!timeout`/`!ban`.
    user_ids: Mutex<HashMap<String, String>>,
    /// Недавние ответы (текст в нижнем регистре, момент) — против эха.
    recent: Mutex<VecDeque<(String, i64)>>,
    tick_stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl ChatBot {
    pub fn new(
        sender: ChatSender,
        spawn: SpawnFn,
        clock: Clock,
        twitch: Arc<dyn Fn() -> Value + Send + Sync>,
        moderation: Arc<ModerationStore>,
    ) -> Self {
        Self {
            sender,
            spawn,
            clock,
            twitch,
            moderation,
            runtime: Mutex::new(None),
            user_ids: Mutex::new(HashMap::new()),
            recent: Mutex::new(VecDeque::new()),
            tick_stop: Mutex::new(None),
        }
    }

    /// Пересобрать бота по настройкам: выключенный не собирается вовсе.
    pub fn restart(self: &Arc<Self>, chat_bot: &Value, channel: &str, started_at: Option<i64>) {
        self.stop_tick();
        if !chat_bot::is_enabled(chat_bot) {
            *self.lock(&self.runtime) = None;
            return;
        }

        // Движок ждёт канал и момент старта внутри своего конфига — как поля,
        // которые `startChatBot` передаёт отдельно.
        let mut engine_config = chat_bot.clone();
        if let Value::Object(map) = &mut engine_config {
            map.insert("channel".to_string(), Value::from(channel));
            if let Some(started_at) = started_at {
                map.insert("startedAt".to_string(), Value::from(started_at));
            }
        }
        let prefix = engine_config
            .get("prefix")
            .and_then(Value::as_str)
            .filter(|prefix| !prefix.is_empty())
            .unwrap_or("!")
            .to_string();
        let engine = BotEngine::new(&engine_config);
        let moderation = ModerationEngine::new(
            chat_bot.get("moderation").unwrap_or(&Value::Null),
            Arc::clone(&self.moderation),
        );

        *self.lock(&self.runtime) = Some(BotRuntime {
            engine,
            moderation,
            prefix,
            channel: channel.to_string(),
        });
        self.start_tick();
    }

    /// Остановить бота (выключение, конец работы).
    pub fn stop(self: &Arc<Self>) {
        self.stop_tick();
        *self.lock(&self.runtime) = None;
    }

    /// Обработать сообщение чата — как `onChat` в JS.
    pub fn handle_message(self: &Arc<Self>, msg: &Value) {
        if js_truthy(msg.get("isTest")) {
            return;
        }
        // Бот умеет только Twitch: уровни из Twitch-бейджей, ответы в Helix.
        if msg.get("source").and_then(Value::as_str) != Some("twitch") {
            return;
        }
        let text = msg.get("message").and_then(Value::as_str).unwrap_or("");
        if self.is_recent_reply(text) {
            return;
        }

        let (prefix, channel) = {
            let runtime = self.lock(&self.runtime);
            match runtime.as_ref() {
                Some(runtime) => (runtime.prefix.clone(), runtime.channel.clone()),
                None => return,
            }
        };

        let user = msg
            .get("user")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(user_id) = msg.get("userId").filter(|value| js_truthy(Some(value))) {
            self.lock(&self.user_ids)
                .insert(user.to_lowercase(), crate::state::js_string(user_id));
        }
        let badges = msg.get("badges").cloned().unwrap_or(Value::Null);
        let level = chat_bot::user_level(&user, &badges, &channel);

        if let Some(mod_cmd) = chat_bot::parse_mod_command(&prefix, text) {
            self.handle_mod_command(&user, &mod_cmd, level);
            return;
        }

        let verdict = {
            let runtime = self.lock(&self.runtime);
            runtime.as_ref().and_then(|runtime| {
                runtime.moderation.check(&serde_json::json!({
                    "user": user,
                    "userId": msg.get("userId").cloned().unwrap_or(Value::Null),
                    "badges": badges,
                    "message": text,
                    "emotes": msg.get("emotes").cloned().unwrap_or(Value::Null),
                    "level": level,
                }))
            })
        };
        if let Some(verdict) = verdict {
            if let Some(message) = verdict.get("message").and_then(Value::as_str) {
                if !message.is_empty() {
                    self.send_reply(message.to_string());
                }
            }
            let duration = verdict.get("timeoutSec").and_then(Value::as_f64);
            let reason = verdict
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            self.moderate(
                msg.get("userId").cloned().unwrap_or(Value::Null),
                duration,
                &reason,
            );
            return;
        }

        let reply = {
            let runtime = self.lock(&self.runtime);
            runtime.as_ref().and_then(|runtime| {
                runtime.engine.handle_chat(&serde_json::json!({
                    "user": user,
                    "badges": badges,
                    "message": text,
                }))
            })
        };
        if let Some(reply) = reply {
            self.send_reply(reply);
        }
    }

    fn handle_mod_command(self: &Arc<Self>, user: &str, mod_cmd: &ModCommand, level: &str) {
        if level != "moderator" && level != "broadcaster" {
            self.send_reply(format!("@{user}, у вас нет прав на модерацию."));
            return;
        }
        let target = mod_cmd.target.clone();
        if target.is_empty() {
            self.send_reply("Использование: !timeout @user [сек] | !ban @user".to_string());
            return;
        }
        let target_id = self
            .lock(&self.user_ids)
            .get(&target.to_lowercase())
            .cloned();
        let Some(target_id) = target_id else {
            self.send_reply(format!(
                "@{user}, не знаю ID пользователя {target} — он ещё не писал в чат."
            ));
            return;
        };

        let sender = self.sender.clone();
        let twitch = (self.twitch)();
        let this = Arc::clone(self);
        if mod_cmd.name == "ban" {
            let reason = format!("Бан по команде {user}");
            (self.spawn)(Box::pin(async move {
                let result = sender
                    .moderate_user(&twitch, &Value::from(target_id), None, &reason)
                    .await;
                if result["ok"] == Value::Bool(true) {
                    this.send_reply(format!("@{target} забанен."));
                }
            }));
        } else {
            let duration = timeout_seconds(mod_cmd.duration_raw.as_deref());
            let reason = format!("Таймаут по команде {user}");
            (self.spawn)(Box::pin(async move {
                let result = sender
                    .moderate_user(&twitch, &Value::from(target_id), Some(duration), &reason)
                    .await;
                if result["ok"] == Value::Bool(true) {
                    this.send_reply(format!("@{target} в таймауте на {duration} сек."));
                }
            }));
        }
    }

    /// Отправить ответ бота и запомнить его, чтобы не отвечать на собственное эхо.
    fn send_reply(self: &Arc<Self>, text: String) {
        let sender = self.sender.clone();
        let twitch = (self.twitch)();
        let this = Arc::clone(self);
        (self.spawn)(Box::pin(async move {
            let result = sender.send_message(&twitch, &text).await;
            if result["ok"] == Value::Bool(true) {
                this.remember_reply(&text);
            }
        }));
    }

    /// Забанить или затаймаутить без ответа (авто-модерация).
    fn moderate(self: &Arc<Self>, user_id: Value, duration: Option<f64>, reason: &str) {
        if !js_truthy(Some(&user_id)) {
            return;
        }
        let sender = self.sender.clone();
        let twitch = (self.twitch)();
        let reason = reason.to_string();
        (self.spawn)(Box::pin(async move {
            let _ = sender
                .moderate_user(&twitch, &user_id, duration, &reason)
                .await;
        }));
    }

    fn tick_once(self: &Arc<Self>) {
        let replies = {
            let runtime = self.lock(&self.runtime);
            match runtime.as_ref() {
                Some(runtime) => runtime.engine.tick(),
                None => return,
            }
        };
        for reply in replies {
            self.send_reply(reply);
        }
    }

    fn start_tick(self: &Arc<Self>) {
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        let this = Arc::clone(self);
        (self.spawn)(Box::pin(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(TICK_MS));
            // Первый тик `interval` — сразу; в JS `setInterval` ждёт полный срок.
            interval.tick().await;
            loop {
                tokio::select! {
                    _ = interval.tick() => this.tick_once(),
                    _ = &mut stop_rx => break,
                }
            }
        }));
        *self.lock(&self.tick_stop) = Some(stop_tx);
    }

    fn stop_tick(&self) {
        if let Some(stop) = self.lock(&self.tick_stop).take() {
            let _ = stop.send(());
        }
    }

    fn is_recent_reply(&self, text: &str) -> bool {
        let now = (self.clock)();
        let norm = text.trim().to_lowercase();
        let mut recent = self.lock(&self.recent);
        recent.retain(|(_, at)| now - at <= RECENT_WINDOW_MS);
        recent.iter().any(|(seen, _)| *seen == norm)
    }

    fn remember_reply(&self, text: &str) {
        let now = (self.clock)();
        let norm = text.trim().to_lowercase();
        let mut recent = self.lock(&self.recent);
        recent.push_back((norm, now));
        if recent.len() > RECENT_LIMIT {
            recent.pop_front();
        }
    }

    fn lock<'a, T>(&self, mutex: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
        mutex.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// `Math.max(1, Math.min(1209600, Math.round(Number(raw) || 600)))`.
fn timeout_seconds(raw: Option<&str>) -> f64 {
    let parsed = raw
        .map(|text| crate::storage::history::js_number_or_zero(Some(&Value::from(text))))
        .unwrap_or(0.0);
    let value = if parsed == 0.0 { 600.0 } else { parsed };
    value.round().clamp(1.0, 1_209_600.0)
}

/// Варны поверх базы: читаем и пишем целую карту, как `state.db` в JS
/// (`getModerationWarns`/`saveModerationWarns` сами отсеивают мусор).
struct DatabaseWarns {
    database: Arc<Database>,
}

impl WarnsBackend for DatabaseWarns {
    fn get(&self, key: &str) -> u64 {
        self.database
            .moderation_warns()
            .get(key)
            .map(|value| js_number_or_zero(Some(value)) as u64)
            .unwrap_or(0)
    }

    fn set(&self, key: &str, count: u64) {
        let mut warns = self.database.moderation_warns();
        if let Value::Object(map) = &mut warns {
            map.insert(key.to_string(), Value::from(count));
        }
        self.database.save_moderation_warns(Some(&warns));
    }

    fn delete(&self, key: &str) {
        let mut warns = self.database.moderation_warns();
        if let Value::Object(map) = &mut warns {
            map.remove(key);
        }
        self.database.save_moderation_warns(Some(&warns));
    }
}

/// Счётчик варнов поверх базы — общий для пересборок бота.
pub fn store_from_database(database: Arc<Database>) -> Arc<ModerationStore> {
    Arc::new(ModerationStore::with_backend(Arc::new(DatabaseWarns {
        database,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::twitch_chat::{ChatRateLimiter, CHAT_SEND_INTERVAL_MS};
    use crate::integrations::twitch_helix::{HttpOutcome, PostFn, Tokens};
    use serde_json::json;

    type BoxedTask = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

    /// Отправка в чат, которая складывает тела запросов в общий список.
    fn sender(recorded: Arc<Mutex<Vec<Value>>>) -> ChatSender {
        let http: PostFn = Arc::new(move |_url: &str, _token: &str, body: &Value| {
            let recorded = Arc::clone(&recorded);
            let body = body.clone();
            Box::pin(async move {
                recorded.lock().unwrap().push(body);
                HttpOutcome {
                    status: 200,
                    body: json!({ "data": [{ "message_id": "m1", "is_sent": true }] }),
                    network_error: None,
                }
            })
        });
        let tokens = Tokens {
            ensure: Arc::new(|| Box::pin(async { Ok("tok".to_string()) })),
            refresh: Arc::new(|| Box::pin(async { Ok("tok".to_string()) })),
        };
        ChatSender::new(http, tokens, ChatRateLimiter::new(CHAT_SEND_INTERVAL_MS))
            .with_clock(Arc::new(|| 1_000))
    }

    fn twitch() -> Arc<dyn Fn() -> Value + Send + Sync> {
        Arc::new(|| json!({ "clientId": "c", "userAccessToken": "t", "broadcasterId": "b" }))
    }

    /// Место под задачи: тест сам решает, что проиграть.
    fn slot() -> (SpawnFn, Arc<Mutex<Vec<BoxedTask>>>) {
        let tasks: Arc<Mutex<Vec<BoxedTask>>> = Arc::new(Mutex::new(Vec::new()));
        let store = Arc::clone(&tasks);
        let spawn: SpawnFn = Arc::new(move |task| store.lock().unwrap().push(task));
        (spawn, tasks)
    }

    fn bot(recorded: Arc<Mutex<Vec<Value>>>, spawn: SpawnFn) -> Arc<ChatBot> {
        Arc::new(ChatBot::new(
            sender(recorded),
            spawn,
            Arc::new(|| 1_000),
            twitch(),
            Arc::new(ModerationStore::new()),
        ))
    }

    fn config() -> Value {
        json!({
            "enabled": true,
            "prefix": "!",
            "commands": [{ "name": "hi", "response": "привет, $(user)!" }],
        })
    }

    async fn drain(tasks: &Arc<Mutex<Vec<BoxedTask>>>) {
        let pending: Vec<BoxedTask> = tasks.lock().unwrap().drain(..).collect();
        for task in pending {
            task.await;
        }
    }

    #[tokio::test]
    async fn a_command_gets_a_reply_sent_through_helix() {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let (spawn, tasks) = slot();
        let chat = bot(Arc::clone(&recorded), spawn);
        chat.restart(&config(), "chan", Some(0));
        tasks.lock().unwrap().clear(); // выбрасываем цикл таймеров

        chat.handle_message(&json!({
            "source": "twitch", "user": "viewer", "userId": "7", "badges": [], "message": "!hi",
        }));
        drain(&tasks).await;

        let recorded = recorded.lock().unwrap();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0]["message"], json!("привет, viewer!"));
    }

    #[tokio::test]
    async fn a_disabled_bot_ignores_messages() {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let (spawn, tasks) = slot();
        let chat = bot(Arc::clone(&recorded), spawn);
        chat.restart(&json!({ "enabled": false }), "chan", Some(0));

        chat.handle_message(&json!({
            "source": "twitch", "user": "viewer", "userId": "7", "badges": [], "message": "!hi",
        }));
        drain(&tasks).await;

        assert!(recorded.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_bot_does_not_answer_its_own_echo() {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let (spawn, tasks) = slot();
        let chat = bot(Arc::clone(&recorded), spawn);
        chat.restart(&config(), "chan", Some(0));
        tasks.lock().unwrap().clear();

        chat.handle_message(&json!({
            "source": "twitch", "user": "viewer", "userId": "7", "badges": [], "message": "!hi",
        }));
        drain(&tasks).await;
        assert_eq!(recorded.lock().unwrap().len(), 1);

        // Свой ответ приходит обычным сообщением — бот его пропускает.
        chat.handle_message(&json!({
            "source": "twitch", "user": "bot", "userId": "1", "badges": [], "message": "привет, viewer!",
        }));
        drain(&tasks).await;
        assert_eq!(recorded.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_timeout_command_needs_rights_and_a_known_target() {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let (spawn, tasks) = slot();
        let chat = bot(Arc::clone(&recorded), spawn);
        chat.restart(&config(), "chan", Some(0));
        tasks.lock().unwrap().clear();

        // Обычный зритель прав не имеет — уходит только отказ в ответе.
        chat.handle_message(&json!({
            "source": "twitch", "user": "viewer", "userId": "7", "badges": [], "message": "!timeout @bad 60",
        }));
        drain(&tasks).await;
        {
            let recorded = recorded.lock().unwrap();
            assert_eq!(recorded.len(), 1);
            assert_eq!(
                recorded[0]["message"],
                json!("@viewer, у вас нет прав на модерацию.")
            );
        }

        // Модератор без известного ID цели получает подсказку, а не бан.
        chat.handle_message(&json!({
            "source": "twitch", "user": "mod", "userId": "9",
            "badges": ["moderator"], "message": "!timeout @ghost 60",
        }));
        drain(&tasks).await;
        let recorded = recorded.lock().unwrap();
        assert_eq!(recorded.len(), 2);
        assert!(recorded[1]["message"]
            .as_str()
            .unwrap()
            .contains("не знаю ID"));
    }

    /// Временная база для проверки варнов поверх неё.
    fn temp_database(label: &str) -> (Arc<Database>, std::path::PathBuf) {
        use crate::storage::paths::Storage;
        use std::sync::atomic::{AtomicUsize, Ordering};

        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let index = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("ose-warns-{}-{label}-{index}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("временный каталог");
        (
            Arc::new(Database::open(&Storage::beside_sources(dir.clone()))),
            dir,
        )
    }

    #[test]
    fn warns_survive_a_store_rebuild_through_the_database() {
        let (database, dir) = temp_database("persist");
        let config = json!({
            "enabled": true,
            "linkProtection": false,
            "badWords": ["дурак"],
            "maxEmotes": 0,
            "maxWarns": 3,
        });
        let message =
            json!({ "user": "Вася", "userId": "U1", "message": "дурак", "level": "everyone" });

        // Первый движок поверх базы: два сообщения — два варна.
        let engine = ModerationEngine::new(&config, store_from_database(Arc::clone(&database)));
        assert_eq!(engine.check(&message).expect("варн")["warn"], json!(1));
        assert_eq!(engine.check(&message).expect("варн")["warn"], json!(2));

        // Новый счётчик поверх той же базы — как после перезапуска бота:
        // счёт продолжается, а не начинается с нуля.
        let rebuilt = ModerationEngine::new(&config, store_from_database(Arc::clone(&database)));
        let verdict = rebuilt.check(&message).expect("варн");
        assert_eq!(verdict["warn"], json!(3));
        assert_eq!(verdict["ban"], json!(true));
        // Ключ нормализуется в нижний регистр, как в JS.
        assert_eq!(database.moderation_warns(), json!({ "u1": 3 }));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
