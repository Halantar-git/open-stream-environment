//! Счётчики рантайма: переподключения, сцена, камера, фильтры, розыгрыш,
//! статистика и касса текущего стрима.
//!
//! Порт блока `this.runtime` из `server/state.js` (там он заполняется в
//! конструкторе, а методы живут рядом с раскладкой).
//!
//! Отличие от раскладки: это состояние **не** хранится на диске и не выводится из
//! настроек — оно живёт ровно столько, сколько работает процесс. Поэтому оно и
//! не разложено по `ConfigFile`/`Database`, а лежит одним [`Runtime`] в памяти.
//! Кто им владеет и как синхронизирует — решает вызывающий (в приложении это
//! `Arc<Mutex<Runtime>>` в диагностике: его делят шина и фоновые задачи).
//!
//! Часы сюда передают снаружи (`now_ms`), как и в остальных перенесённых частях:
//! в JS внутри стоял `Date.now()`, но проверить «сцена началась в этот момент»
//! можно только подставив время. Случайность для колеса берётся из `uuid` — ради
//! одного числа заводить генератор не нужно (там же так и было с именем
//! тестового зрителя).
//!
//! Розыгрыш хранит участников **упорядоченно и без дублей** (в JS это `Set`):
//! порядок виден в снимке, поэтому `Vec` с проверкой вхождения, а не `HashSet`.

use serde_json::{json, Map, Value};

use crate::state::{js_string, string_trim};
use crate::storage::history::{js_number_or_zero, js_truthy, number_value};

/// Сколько последних событий держит панель.
const RECENT_EVENTS_LIMIT: usize = 15;

/// Розыгрыш «Колесо Фортуны».
struct Giveaway {
    active: bool,
    command: String,
    elimination_mode: bool,
    /// Участники в порядке добавления, без дублей (в JS — `Set`).
    participants: Vec<String>,
    winner: Option<String>,
    is_final_winner: bool,
    /// Победитель, выбранный случайно и ждущий подтверждения призом.
    pending_winner: Option<String>,
}

impl Default for Giveaway {
    fn default() -> Self {
        Self {
            active: false,
            command: "!go".to_string(),
            elimination_mode: false,
            participants: Vec::new(),
            winner: None,
            is_final_winner: false,
            pending_winner: None,
        }
    }
}

/// Состояние, которое живёт только в памяти.
pub struct Runtime {
    started_at: i64,
    /// Служба → сколько раз начиналась попытка подключиться.
    reconnects: Map<String, Value>,
    /// Служба → состояние связи (`connecting`, `disconnected`, …).
    connection_status: Map<String, Value>,
    recent_events: Vec<Value>,
    follower_count: Option<f64>,
    subscriber_count: Option<f64>,
    session_donations: i64,
    session_amount: f64,
    session_currency: String,
    /// Счётчик смертей: в JS это обычное число, дробное значение не округляется.
    death_count: f64,
    longshot: Option<Value>,
    active_scene: String,
    scene_started_at: Option<i64>,
    active_camera_angle: Option<String>,
    /// Активные фильтры камеры в порядке включения (в JS — `Set`).
    active_filters: Vec<String>,
    giveaway: Giveaway,
    /// Идёт ли голосование прямо сейчас.
    poll_active: bool,
    /// Голоса: зритель → идентификатор пункта, в порядке голосования.
    poll_votes: Map<String, Value>,
}

impl Runtime {
    /// Начальное состояние: часть служб «не настроена», если нет токена.
    ///
    /// Правило взято из конструктора `state.js`: токен есть — служба ещё
    /// `connecting`, токена нет — `not_configured`. Так панель не показывает
    /// «подключается» там, где подключаться нечему.
    pub fn new(now_ms: i64, config: &Map<String, Value>) -> Self {
        let mut connection_status = Map::new();
        connection_status.insert("twitchChat".to_string(), Value::from("disconnected"));
        connection_status.insert(
            "twitchEvents".to_string(),
            Value::from(initial_status(config, "twitch", "userAccessToken")),
        );
        connection_status.insert(
            "donationAlerts".to_string(),
            Value::from(initial_status(config, "donationAlerts", "accessToken")),
        );
        connection_status.insert(
            "youtube".to_string(),
            Value::from(initial_status(config, "youtube", "accessToken")),
        );
        connection_status.insert("obs".to_string(), Value::from("not_configured"));

        Self {
            started_at: now_ms,
            reconnects: Map::new(),
            connection_status,
            recent_events: Vec::new(),
            follower_count: None,
            subscriber_count: None,
            session_donations: 0,
            session_amount: 0.0,
            session_currency: String::new(),
            death_count: 0.0,
            longshot: None,
            active_scene: "main".to_string(),
            scene_started_at: None,
            active_camera_angle: None,
            active_filters: Vec::new(),
            giveaway: Giveaway::default(),
            poll_active: false,
            poll_votes: Map::new(),
        }
    }

    pub fn started_at(&self) -> i64 {
        self.started_at
    }

    /// Состояние связи по службам — для `/healthz`.
    pub fn connection_status(&self) -> Value {
        Value::Object(self.connection_status.clone())
    }

    /// Попытки подключения по службам — для `/healthz` и отчёта о поддержке.
    pub fn reconnects(&self) -> Value {
        Value::Object(self.reconnects.clone())
    }

    // ---- Счётчик смертей (быстрое действие пульта) ----

    /// Изменить счётчик смертей; вниз он не уходит.
    ///
    /// `Number(delta) || 0` — как в JS: `undefined` и мусорный текст дают ноль.
    pub fn adjust_death_count(&mut self, delta: &Value) -> Value {
        self.death_count = clamp_deaths(self.death_count + js_number_or_zero(Some(delta)));
        json!({ "count": number_value(self.death_count) })
    }

    pub fn reset_death_count(&mut self) -> Value {
        self.death_count = 0.0;
        json!({ "count": number_value(0.0) })
    }

    /// Последний снимок конфига Longshot (Executive Hangar); `null` — ещё не было.
    ///
    /// В JS `snapshot || null`: ложное значение снова превращается в `null`.
    pub fn set_longshot(&mut self, snapshot: &Value) -> Option<Value> {
        self.longshot = if js_truthy(Some(snapshot)) {
            Some(snapshot.clone())
        } else {
            None
        };
        self.longshot.clone()
    }

    // ---- Сцена, камера, фильтры ----

    /// Сделать сцену активной и заново отсчитать её начало.
    pub fn set_active_scene(&mut self, scene: &Value, now_ms: i64) -> String {
        self.active_scene = if js_truthy(Some(scene)) {
            js_string(scene)
        } else {
            "main".to_string()
        };
        // Момент активации: к нему привязан обратный отсчёт в оверлее, поэтому он
        // сбрасывается даже при переключении на ту же сцену.
        self.scene_started_at = Some(now_ms);
        self.active_scene.clone()
    }

    /// Пересчитать начало отсчёта активной сцены, не меняя саму сцену.
    pub fn mark_scene_started(&mut self, now_ms: i64) -> i64 {
        self.scene_started_at = Some(now_ms);
        now_ms
    }

    pub fn scene_started_at(&self) -> Option<i64> {
        self.scene_started_at
    }

    /// Активный ракурс камеры; пустое значение выключает ракурс.
    pub fn set_active_camera_angle(&mut self, angle_id: &Value) -> Option<String> {
        self.active_camera_angle = if js_truthy(Some(angle_id)) {
            Some(js_string(angle_id))
        } else {
            None
        };
        self.active_camera_angle.clone()
    }

    /// Включить или выключить фильтр; возвращает список активных.
    pub fn set_active_filter(&mut self, filter_id: &Value, active: bool) -> Vec<String> {
        if !js_truthy(Some(filter_id)) {
            return self.active_filters.clone();
        }
        let id = js_string(filter_id);
        if active {
            if !self.active_filters.contains(&id) {
                self.active_filters.push(id);
            }
        } else {
            self.active_filters.retain(|current| current != &id);
        }
        self.active_filters.clone()
    }

    pub fn active_filters(&self) -> Vec<String> {
        self.active_filters.clone()
    }

    // ---- Голосование зрителей ----

    // Сами настройки опроса (команда, тип диаграммы, пункты) живут в конфиге и
    // разбираются в [`crate::state::poll`]; здесь только несохраняемая часть —
    // идёт ли голосование и кто за что успел проголосовать.

    pub fn poll_active(&self) -> bool {
        self.poll_active
    }

    pub fn poll_set_active(&mut self, active: bool) {
        self.poll_active = active;
    }

    pub fn poll_reset_votes(&mut self) {
        self.poll_votes.clear();
    }

    /// Записать голос зрителя: повторный голос перезаписывает прежний.
    pub fn poll_set_vote(&mut self, user: String, option_id: Value) {
        self.poll_votes.insert(user, option_id);
    }

    /// Убрать голоса за удалённый пункт.
    pub fn poll_remove_votes_for(&mut self, option_id: &str) {
        self.poll_votes
            .retain(|_, value| value.as_str() != Some(option_id));
    }

    /// Голоса по пунктам: идут в порядке первого голоса, как объект в JS.
    pub fn poll_vote_counts(&self) -> Value {
        let mut counts = Map::new();
        for option in self.poll_votes.values() {
            let key = js_string(option);
            let next = counts.get(&key).and_then(Value::as_i64).unwrap_or(0) + 1;
            counts.insert(key, number_value(next as f64));
        }
        Value::Object(counts)
    }

    pub fn poll_total(&self) -> usize {
        self.poll_votes.len()
    }

    // ---- Розыгрыш «Колесо Фортуны» ----

    pub fn giveaway_snapshot(&self) -> Value {
        let giveaway = &self.giveaway;
        json!({
            "active": giveaway.active,
            "command": giveaway.command,
            "eliminationMode": giveaway.elimination_mode,
            "winner": giveaway.winner,
            "isFinalWinner": giveaway.is_final_winner,
            "count": number_value(giveaway.participants.len() as f64),
            "participants": giveaway.participants,
        })
    }

    /// Начать розыгрыш: команда нормализуется, участники и итог обнуляются.
    pub fn start_giveaway(&mut self, command: &Value) -> Value {
        let command = match string_trim(command) {
            text if text.is_empty() => "!go".to_string(),
            text => text,
        };
        self.giveaway.command = command;
        self.giveaway.active = true;
        self.giveaway.participants.clear();
        self.giveaway.winner = None;
        self.giveaway.is_final_winner = false;
        self.giveaway.pending_winner = None;
        self.giveaway_snapshot()
    }

    pub fn stop_giveaway(&mut self) -> Value {
        self.giveaway.active = false;
        self.giveaway_snapshot()
    }

    /// Добавить участника; `None` — имя пустое или уже есть.
    pub fn add_giveaway_participant(&mut self, username: &Value) -> Option<Value> {
        let name = string_trim(username);
        if name.is_empty() || self.giveaway.participants.contains(&name) {
            return None;
        }
        self.giveaway.participants.push(name);
        Some(self.giveaway_snapshot())
    }

    pub fn remove_giveaway_participant(&mut self, username: &Value) -> Value {
        let name = string_trim(username);
        if !name.is_empty() {
            self.giveaway
                .participants
                .retain(|current| current != &name);
        }
        self.giveaway_snapshot()
    }

    pub fn clear_giveaway_participants(&mut self) -> Value {
        self.giveaway.participants.clear();
        self.clear_giveaway_result()
    }

    pub fn clear_giveaway_result(&mut self) -> Value {
        self.giveaway.winner = None;
        self.giveaway.is_final_winner = false;
        self.giveaway.pending_winner = None;
        self.giveaway_snapshot()
    }

    /// Учесть сообщение чата: если это команда розыгрыша — добавить участника.
    ///
    /// `None` — розыгрыш не идёт, сообщение не совпало с командой или участник
    /// уже есть (ровно те случаи, где JS возвращает `null`).
    pub fn handle_giveaway_chat(&mut self, username: &Value, message: &Value) -> Option<Value> {
        if !self.giveaway.active {
            return None;
        }
        let command = self.giveaway.command.trim().to_lowercase();
        let text = string_trim(message).to_lowercase();
        if command.is_empty() || text != command {
            return None;
        }
        self.add_giveaway_participant(username)
    }

    /// Перемешать участников (Фишер — Йетс, как `fisherYates` в JS).
    pub fn shuffle_giveaway(&mut self) -> Value {
        let len = self.giveaway.participants.len();
        for i in (1..len).rev() {
            let j = random_index(i + 1);
            self.giveaway.participants.swap(i, j);
        }
        self.giveaway_snapshot()
    }

    pub fn set_giveaway_elimination_mode(&mut self, enabled: &Value) -> Value {
        self.giveaway.elimination_mode = js_truthy(Some(enabled));
        self.giveaway_snapshot()
    }

    /// Объявить победителя.
    ///
    /// В режиме выбывания финал определяется **до** удаления: победитель, бывший
    /// последним участником, — это финал, и следующий раунд не начинается.
    pub fn set_giveaway_winner(&mut self, username: &Value) -> Value {
        let name = string_trim(username);
        let giveaway = &mut self.giveaway;
        giveaway.winner = if name.is_empty() {
            None
        } else {
            Some(name.clone())
        };
        giveaway.is_final_winner = giveaway.elimination_mode
            && !name.is_empty()
            && giveaway.participants.contains(&name)
            && giveaway.participants.len() == 1;
        if !name.is_empty() && giveaway.elimination_mode {
            giveaway.participants.retain(|current| current != &name);
        }
        self.giveaway_snapshot()
    }

    /// Выбрать случайного победителя и запомнить его как ожидающего приза.
    ///
    /// `None` — участников нет.
    pub fn pick_random_winner(&mut self) -> Option<String> {
        let participants = &self.giveaway.participants;
        if participants.is_empty() {
            return None;
        }
        let winner = participants[random_index(participants.len())].clone();
        self.giveaway.pending_winner = Some(winner.clone());
        Some(winner)
    }

    /// Подтвердить ожидающего победителя; `false` — имя не совпало.
    pub fn consume_pending_winner(&mut self, username: &Value) -> bool {
        let name = string_trim(username);
        if name.is_empty() || self.giveaway.pending_winner.as_deref() != Some(name.as_str()) {
            return false;
        }
        self.giveaway.pending_winner = None;
        true
    }

    // ---- Последние события, состояние связи, статистика, касса стрима ----

    /// Положить событие в начало списка и подрезать хвост.
    pub fn push_recent_event(&mut self, event: &Value, now_ms: i64) {
        // В JS это `{ ...event, at }`. Не-объект (в командах такого нет, но
        // контракт шире) раскрылся бы в индексы строки — здесь такой случай
        // даёт пустую запись, а не мусорные ключи.
        let mut record = match event {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        record.insert("at".to_string(), number_value(now_ms as f64));
        self.recent_events.insert(0, Value::Object(record));
        self.recent_events.truncate(RECENT_EVENTS_LIMIT);
    }

    pub fn recent_events(&self) -> &[Value] {
        &self.recent_events
    }

    // ---- Чтение для снимка состояния ----

    /// Последний снимок Longshot; `null`, если его ещё не было.
    pub fn longshot(&self) -> Value {
        self.longshot.clone().unwrap_or(Value::Null)
    }

    /// Подписчики и фолловеры.
    pub fn stats(&self) -> Value {
        self.stats_snapshot()
    }

    pub fn death_count(&self) -> Value {
        number_value(self.death_count)
    }

    pub fn active_scene(&self) -> String {
        self.active_scene.clone()
    }

    pub fn active_camera_angle(&self) -> Value {
        self.active_camera_angle
            .clone()
            .map(Value::from)
            .unwrap_or(Value::Null)
    }

    /// Обновить состояние связи службы.
    ///
    /// Переход «не `connecting` → `connecting`» — это попытка подключиться (в том
    /// числе переподключение после обрыва); их считаем, чтобы шторм обрывов был
    /// виден числом, а не только строками в журнале.
    pub fn set_connection_status(&mut self, service: &str, status: &str) {
        let previous = self.connection_status.get(service);
        if status == "connecting" && previous.and_then(Value::as_str) != Some("connecting") {
            let next = self
                .reconnects
                .get(service)
                .and_then(Value::as_i64)
                .unwrap_or(0)
                + 1;
            self.reconnects
                .insert(service.to_string(), number_value(next as f64));
        }
        self.connection_status
            .insert(service.to_string(), Value::from(status));
    }

    /// Сколько живёт процесс и сколько раз интеграции переподключались.
    pub fn runtime_stats(&self, now_ms: i64) -> Value {
        // Как `Math.round((Date.now()-startedAt)/1000)`: округляем, не усекаем.
        let uptime = ((now_ms - self.started_at) as f64 / 1000.0)
            .round()
            .max(0.0);
        json!({
            "startedAt": number_value(self.started_at as f64),
            "uptimeSec": number_value(uptime),
            "reconnects": Value::Object(self.reconnects.clone()),
        })
    }

    /// Снимок подписчиков и фолловеров: обновляются только числами.
    pub fn set_stats(&mut self, snapshot: &Value) -> Value {
        if let Some(value) = snapshot.get("followerCount").and_then(Value::as_f64) {
            self.follower_count = Some(value);
        }
        if let Some(value) = snapshot.get("subscriberCount").and_then(Value::as_f64) {
            self.subscriber_count = Some(value);
        }
        self.stats_snapshot()
    }

    /// Сдвинуть подписчиков и фолловеров.
    ///
    /// Сдвиг применяется, только если текущее значение — число (в JS
    /// `typeof === "number"`; `null` — это «ещё не знаем», и сдвигать нечего).
    pub fn adjust_stats(&mut self, patch: &Value) -> Value {
        if let Some(delta) = patch.get("followerDelta").and_then(Value::as_f64) {
            if let Some(current) = self.follower_count {
                self.follower_count = Some((current + delta).max(0.0));
            }
        }
        if let Some(delta) = patch.get("subscriberDelta").and_then(Value::as_f64) {
            if let Some(current) = self.subscriber_count {
                self.subscriber_count = Some((current + delta).max(0.0));
            }
        }
        self.stats_snapshot()
    }

    fn stats_snapshot(&self) -> Value {
        json!({
            "followerCount": self.follower_count.map(number_value).unwrap_or(Value::Null),
            "subscriberCount": self.subscriber_count.map(number_value).unwrap_or(Value::Null),
        })
    }

    /// Доход текущего стрима.
    ///
    /// Считается на приходе доната, а не разбором истории: история растёт, а
    /// счётчик — это одно сложение. Нулевые и мусорные суммы не считаются —
    /// иначе касса разошлась бы с историей.
    pub fn add_donation_to_session(&mut self, amount: &Value, currency: &Value) -> Value {
        let value = js_number_or_zero(Some(amount));
        if value <= 0.0 {
            return self.session_donations();
        }
        self.session_donations += 1;
        self.session_amount += value;
        if js_truthy(Some(currency)) {
            self.session_currency = js_string(currency);
        }
        self.session_donations()
    }

    pub fn session_donations(&self) -> Value {
        json!({
            "count": number_value(self.session_donations as f64),
            "amount": number_value(self.session_amount),
            "currency": self.session_currency,
        })
    }

    /// Новый стрим — новый счёт.
    pub fn reset_session_donations(&mut self) -> Value {
        self.session_donations = 0;
        self.session_amount = 0.0;
        self.session_currency = String::new();
        self.session_donations()
    }
}

/// Начальное состояние службы по наличию токена.
fn initial_status(config: &Map<String, Value>, section: &str, token: &str) -> &'static str {
    let present = config
        .get(section)
        .and_then(|section| section.get(token))
        .is_some_and(|token| js_truthy(Some(token)));
    if present {
        "connecting"
    } else {
        "not_configured"
    }
}

/// `Math.max(0, (deathCount || 0) + delta)`.
fn clamp_deaths(value: f64) -> f64 {
    if value.is_nan() || value < 0.0 {
        0.0
    } else {
        value
    }
}

/// `Math.floor(Math.random() * len)`.
///
/// Источник — байты `uuid`, а не новый генератор: та же причина, что и у
/// случайного имени тестового зрителя (`server/utils.rs`). Небольшой перекос
/// modulo здесь несущественен — это выбор участника колеса, а не жребий с
/// криптографическими требованиями.
fn random_index(len: usize) -> usize {
    debug_assert!(len > 0);
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    let mut value: u64 = 0;
    for byte in bytes.iter().take(8) {
        value = (value << 8) | u64::from(*byte);
    }
    (value % len as u64) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Конфиг в форме, которую ждёт `Runtime::new`, — как `makeConfig` в Jest.
    fn config() -> Map<String, Value> {
        json!({
            "twitch": { "channel": "", "userAccessToken": "" },
            "donationAlerts": { "accessToken": "" },
            "youtube": { "accessToken": "" },
        })
        .as_object()
        .cloned()
        .expect("конфиг — объект")
    }

    fn runtime() -> Runtime {
        Runtime::new(1_000_000, &config())
    }

    #[test]
    fn services_without_a_token_start_as_not_configured() {
        let runtime = runtime();
        let status = runtime.connection_status();
        assert_eq!(status["twitchChat"], json!("disconnected"));
        assert_eq!(status["twitchEvents"], json!("not_configured"));
        assert_eq!(status["donationAlerts"], json!("not_configured"));
        assert_eq!(status["youtube"], json!("not_configured"));
        assert_eq!(status["obs"], json!("not_configured"));
    }

    #[test]
    fn a_token_makes_the_service_start_connecting() {
        let config = json!({ "twitch": { "userAccessToken": "tok" } })
            .as_object()
            .cloned()
            .unwrap();
        let runtime = Runtime::new(0, &config);
        assert_eq!(
            runtime.connection_status()["twitchEvents"],
            json!("connecting")
        );
    }

    #[test]
    fn a_second_connecting_counts_as_a_reconnect() {
        let mut runtime = runtime();
        runtime.set_connection_status("twitchEvents", "connecting");
        // Повторный «connecting» — это не новая попытка.
        runtime.set_connection_status("twitchEvents", "connecting");
        runtime.set_connection_status("twitchEvents", "disconnected");
        runtime.set_connection_status("twitchEvents", "connecting");

        assert_eq!(runtime.reconnects()["twitchEvents"], json!(2));
        // `Math.round`: 2.5 с → 3, а не усечение до 2.
        assert_eq!(runtime.runtime_stats(1_002_500)["uptimeSec"], json!(3));
        assert_eq!(
            runtime.runtime_stats(1_002_500)["startedAt"],
            json!(1_000_000)
        );
    }

    #[test]
    fn scene_and_camera_update_runtime() {
        let mut runtime = runtime();
        assert_eq!(runtime.set_active_scene(&json!("brb"), 10), "brb");
        assert_eq!(
            runtime.set_active_camera_angle(&json!("cam_top")),
            Some("cam_top".into())
        );
        // Пустой ракурс выключает его.
        assert_eq!(runtime.set_active_camera_angle(&json!("")), None);
    }

    #[test]
    fn scene_started_at_records_the_moment() {
        let mut runtime = runtime();
        assert_eq!(runtime.scene_started_at(), None);

        runtime.set_active_scene(&json!("start"), 5_000);
        let first = runtime.scene_started_at();
        assert_eq!(first, Some(5_000));

        let restarted = runtime.mark_scene_started(6_000);
        assert_eq!(restarted, 6_000);
        assert_eq!(runtime.scene_started_at(), Some(6_000));
    }

    #[test]
    fn a_scene_without_a_name_falls_back_to_main() {
        let mut runtime = runtime();
        assert_eq!(runtime.set_active_scene(&Value::Null, 1), "main");
        assert_eq!(runtime.set_active_scene(&json!(""), 1), "main");
    }

    #[test]
    fn active_filters_keep_insertion_order_without_duplicates() {
        let mut runtime = runtime();
        assert_eq!(runtime.set_active_filter(&json!("a"), true), vec!["a"]);
        assert_eq!(runtime.set_active_filter(&json!("b"), true), vec!["a", "b"]);
        // Повторное включение не дублирует.
        assert_eq!(runtime.set_active_filter(&json!("a"), true), vec!["a", "b"]);
        assert_eq!(runtime.set_active_filter(&json!("a"), false), vec!["b"]);
        // Пустой идентификатор — просто список, ничего не меняем.
        assert_eq!(runtime.set_active_filter(&Value::Null, true), vec!["b"]);
    }

    #[test]
    fn death_counter_does_not_go_below_zero_and_resets() {
        let mut runtime = runtime();
        assert_eq!(runtime.adjust_death_count(&json!(3)), json!({ "count": 3 }));
        assert_eq!(
            runtime.adjust_death_count(&json!(-5)),
            json!({ "count": 0 })
        );
        assert_eq!(runtime.reset_death_count(), json!({ "count": 0 }));
    }

    #[test]
    fn giveaway_filters_duplicates_like_a_set() {
        let mut runtime = runtime();
        runtime.start_giveaway(&json!("!go"));
        assert!(runtime.add_giveaway_participant(&json!("alice")).is_some());
        assert!(runtime.add_giveaway_participant(&json!("alice")).is_none());
        assert!(runtime.add_giveaway_participant(&json!("bob")).is_some());
        assert_eq!(runtime.giveaway_snapshot()["count"], json!(2));
    }

    #[test]
    fn giveaway_shuffle_keeps_every_participant() {
        let mut runtime = runtime();
        runtime.start_giveaway(&json!("!go"));
        for user in ["a", "b", "c", "d"] {
            runtime.add_giveaway_participant(&json!(user));
        }

        let snapshot = runtime.shuffle_giveaway();
        let mut participants: Vec<String> = snapshot["participants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        participants.sort();
        assert_eq!(participants, ["a", "b", "c", "d"]);
    }

    #[test]
    fn elimination_removes_the_winner_from_the_participants() {
        let mut runtime = runtime();
        runtime.start_giveaway(&json!("!go"));
        for user in ["a", "b", "c"] {
            runtime.add_giveaway_participant(&json!(user));
        }
        runtime.set_giveaway_elimination_mode(&json!(true));

        let snapshot = runtime.set_giveaway_winner(&json!("b"));
        assert_eq!(snapshot["winner"], json!("b"));
        assert_eq!(snapshot["participants"], json!(["a", "c"]));
        assert_eq!(snapshot["count"], json!(2));
    }

    #[test]
    fn the_final_winner_is_decided_before_removal() {
        let mut runtime = runtime();
        runtime.start_giveaway(&json!("!go"));
        runtime.add_giveaway_participant(&json!("a"));
        runtime.set_giveaway_elimination_mode(&json!(true));

        let snapshot = runtime.set_giveaway_winner(&json!("a"));
        assert_eq!(snapshot["winner"], json!("a"));
        assert_eq!(snapshot["isFinalWinner"], json!(true));
        assert_eq!(snapshot["count"], json!(0));
        assert_eq!(snapshot["participants"], json!([]));
    }

    #[test]
    fn elimination_with_several_participants_is_not_final() {
        let mut runtime = runtime();
        runtime.start_giveaway(&json!("!go"));
        runtime.add_giveaway_participant(&json!("a"));
        runtime.add_giveaway_participant(&json!("b"));
        runtime.set_giveaway_elimination_mode(&json!(true));

        let snapshot = runtime.set_giveaway_winner(&json!("b"));
        assert_eq!(snapshot["isFinalWinner"], json!(false));
        assert_eq!(snapshot["participants"], json!(["a"]));
    }

    #[test]
    fn the_chat_command_collects_participants_only_while_running() {
        let mut runtime = runtime();
        assert!(runtime
            .handle_giveaway_chat(&json!("alice"), &json!("!go"))
            .is_none());

        runtime.start_giveaway(&json!("!go"));
        assert!(runtime
            .handle_giveaway_chat(&json!("alice"), &json!("!go"))
            .is_some());
        assert!(runtime
            .handle_giveaway_chat(&json!("bob"), &json!("другое"))
            .is_none());
        // Регистр сообщения не важен.
        assert!(runtime
            .handle_giveaway_chat(&json!("bob"), &json!(" !GO "))
            .is_some());
    }

    #[test]
    fn a_started_giveaway_takes_the_command_from_the_call() {
        let mut runtime = runtime();
        let snapshot = runtime.start_giveaway(&json!("  !roll  "));
        assert_eq!(snapshot["command"], json!("!roll"));
        // Пустая команда откатывается к умолчанию.
        let snapshot = runtime.start_giveaway(&json!("   "));
        assert_eq!(snapshot["command"], json!("!go"));
    }

    #[test]
    fn random_winner_waits_for_confirmation() {
        let mut runtime = runtime();
        assert_eq!(runtime.pick_random_winner(), None);

        runtime.start_giveaway(&json!("!go"));
        runtime.add_giveaway_participant(&json!("a"));
        let winner = runtime.pick_random_winner().expect("участник есть");
        assert_eq!(winner, "a");
        // Чужое имя не подтверждает победителя, своё — подтверждает.
        assert!(!runtime.consume_pending_winner(&json!("b")));
        assert!(runtime.consume_pending_winner(&json!("a")));
        // Повторное подтверждение уже нечего гасить.
        assert!(!runtime.consume_pending_winner(&json!("a")));
    }

    #[test]
    fn recent_events_keep_newest_first_and_are_capped() {
        let mut runtime = runtime();
        for index in 0..20 {
            runtime.push_recent_event(&json!({ "kind": index }), index as i64);
        }
        let events = runtime.recent_events();
        assert_eq!(events.len(), RECENT_EVENTS_LIMIT);
        assert_eq!(events[0]["kind"], json!(19));
        assert_eq!(events[0]["at"], json!(19));
        assert_eq!(events[RECENT_EVENTS_LIMIT - 1]["kind"], json!(5));
    }

    #[test]
    fn stats_update_only_with_numbers() {
        let mut runtime = runtime();
        assert_eq!(
            runtime.set_stats(&json!({ "followerCount": 5, "subscriberCount": "не число" })),
            json!({ "followerCount": 5, "subscriberCount": null })
        );
        // Сдвиг по неизвестному счётчику ничего не делает.
        let stats = runtime.adjust_stats(&json!({ "subscriberDelta": 1 }));
        assert_eq!(stats["subscriberCount"], json!(null));
        let stats = runtime.adjust_stats(&json!({ "followerDelta": -2 }));
        assert_eq!(stats["followerCount"], json!(3));
        // В минус счётчик не уходит.
        let stats = runtime.adjust_stats(&json!({ "followerDelta": -100 }));
        assert_eq!(stats["followerCount"], json!(0));
    }

    #[test]
    fn a_session_starts_empty_and_is_empty_in_the_snapshot_shape() {
        let runtime = runtime();
        assert_eq!(
            runtime.session_donations(),
            json!({ "count": 0, "amount": 0, "currency": "" })
        );
    }

    #[test]
    fn donations_add_up_and_the_currency_is_the_last_one() {
        let mut runtime = runtime();
        runtime.add_donation_to_session(&json!(500), &json!("RUB"));
        runtime.add_donation_to_session(&json!(300), &json!("RUB"));
        assert_eq!(
            runtime.session_donations(),
            json!({ "count": 2, "amount": 800, "currency": "RUB" })
        );

        runtime.add_donation_to_session(&json!(10), &json!("USD"));
        assert_eq!(
            runtime.session_donations(),
            json!({ "count": 3, "amount": 810, "currency": "USD" })
        );
    }

    #[test]
    fn zero_and_garbage_amounts_do_not_count() {
        let mut runtime = runtime();
        runtime.add_donation_to_session(&json!(0), &json!("RUB"));
        runtime.add_donation_to_session(&json!(-5), &json!("RUB"));
        runtime.add_donation_to_session(&Value::Null, &json!("RUB"));
        runtime.add_donation_to_session(&json!("abc"), &json!("RUB"));
        assert_eq!(runtime.session_donations()["count"], json!(0));
    }

    #[test]
    fn a_new_stream_resets_the_counter() {
        let mut runtime = runtime();
        runtime.add_donation_to_session(&json!(700), &json!("RUB"));
        runtime.reset_session_donations();
        assert_eq!(
            runtime.session_donations(),
            json!({ "count": 0, "amount": 0, "currency": "" })
        );
    }
}
