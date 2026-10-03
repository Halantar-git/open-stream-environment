//! Очередь алертов на стороне сервера.
//!
//! Порт `server/alert-queue.js`. Раньше очередь жила внутри виджета алертов в
//! оверлее: он складывал приходящее в массив и показывал по одному. Это работало,
//! пока страница OBS жива — но панель не знала, что происходит, перезагрузка
//! страницы выбрасывала всё непоказанное, а повлиять на порядок было нельзя.
//!
//! Здесь очередь одна на всё приложение:
//!
//! * сервер решает, что играет сейчас, и рассылает алерты по одному, соблюдая
//!   паузу между ними (длительность алерта плюс хвост на анимацию ухода);
//! * панель и пульт видят состояние (что играет, что ждёт) и могут вмешаться:
//!   пропустить, убрать, поднять наверх, проиграть сейчас, очистить, поставить
//!   на паузу;
//! * правила: не показывать донаты ниже суммы и объединять подряд идущие донаты
//!   одного зрителя в один алерт с суммой и счётчиком.
//!
//! Что здесь намеренно **не** происходит: история, цель сбора и «последние
//! события» обновляются в момент прихода доната (это делает вызывающий), а не в
//! момент показа. Донат случился тогда, когда случился, — очередь управляет
//! только картинкой.
//!
//! Модуль чистый: часы и таймеры инжектируются, поэтому правила и порядок
//! проверяются тестами без ожиданий и без оверлея. Отличие от JS: там умолчание
//! таймеров — `setTimeout`/`clearTimeout`, здесь постановку и снятие таймера
//! даёт вызывающий ([`ScheduleFn`]/[`CancelFn`]) — в приложении это цикл на
//! `tokio`. Умолчания нет и быть не может: таймер живёт вне очереди.
//!
//! Осторожно с колбэками: `onPlay` и `onChange` вызываются **под замком**, как и
//! в JS, где вызовы синхронные. Значит, колбэк не должен трогать саму очередь —
//! иначе будет зависание на замке.

use std::sync::{Arc, Mutex, MutexGuard, Weak};

use serde_json::{json, Map, Value};

use crate::storage::history::{js_key, js_number_or_zero, js_truthy, number_value};

/// Хвост после алерта: виджету нужно время на анимацию ухода, иначе следующий
/// алерт начнётся поверх уезжающего.
pub const TAIL_MS: u64 = 400;

/// Длительность алерта, если её не дали вместе с ним.
const DEFAULT_DURATION_MS: u64 = 5000;

/// Часы — подменяются в тестах, чтобы окна и паузы проверялись без ожидания.
pub type ClockFn = dyn Fn() -> i64 + Send + Sync + 'static;

/// Идентификатор таймера: очередь его только хранит и возвращает.
pub type TimerId = u64;

/// Поставить таймер: `(что сделать, через сколько миллисекунд) -> таймер`.
pub type ScheduleFn = dyn Fn(Box<dyn FnOnce() + Send>, u64) -> TimerId + Send + Sync;

/// Снять таймер.
pub type CancelFn = dyn Fn(TimerId) + Send + Sync;

/// Алерт ушёл в эфир.
pub type PlayFn = dyn Fn(&Value) + Send + Sync;

/// Состояние изменилось: в значении есть `reason` и весь [`AlertQueue::snapshot`].
pub type ChangeFn = dyn Fn(&Value) + Send + Sync;

/// Правила очереди.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rules {
    /// Не показывать донаты ниже этой суммы (`0` — показывать все).
    pub min_amount: f64,
    /// Объединять подряд идущие донаты одного зрителя.
    pub merge_same_user: bool,
    /// Окно, в котором объединение ещё работает.
    pub merge_window_sec: f64,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            min_amount: 0.0,
            merge_same_user: true,
            merge_window_sec: 20.0,
        }
    }
}

impl Rules {
    fn to_json(self) -> Value {
        json!({
            "minAmount": number_value(self.min_amount),
            "mergeSameUser": self.merge_same_user,
            "mergeWindowSec": number_value(self.merge_window_sec),
        })
    }
}

/// Счётчики очереди — по ним видно, что происходило, не читая журнал.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    pub received: u64,
    pub played: u64,
    pub skipped: u64,
    pub merged: u64,
    pub filtered: u64,
    pub recovered: u64,
}

impl Stats {
    fn to_json(self) -> Value {
        json!({
            "received": self.received,
            "played": self.played,
            "skipped": self.skipped,
            "merged": self.merged,
            "filtered": self.filtered,
            "recovered": self.recovered,
        })
    }
}

/// Алерт в очереди или в эфире.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub user: String,
    pub amount: Option<f64>,
    pub currency: Option<Value>,
    pub message: String,
    pub count: u64,
    pub tier: Option<Value>,
    pub is_test: bool,
    pub recovered: bool,
    /// Идентификатор доната на стороне сервиса: по нему пропущенное не
    /// подтянется дважды. Строкой — конфиг и история хранят его так же.
    pub source_id: Option<String>,
    pub duration_ms: u64,
    pub queued_at: i64,
    /// Поставлено, когда алерт вышел в эфир.
    pub started_at: Option<i64>,
}

impl Item {
    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".to_string(), Value::from(self.id.clone()));
        out.insert("kind".to_string(), Value::from(self.kind.clone()));
        out.insert("user".to_string(), Value::from(self.user.clone()));
        out.insert(
            "amount".to_string(),
            self.amount.map(number_value).unwrap_or(Value::Null),
        );
        out.insert(
            "currency".to_string(),
            self.currency.clone().unwrap_or(Value::Null),
        );
        out.insert("message".to_string(), Value::from(self.message.clone()));
        out.insert("count".to_string(), Value::from(self.count));
        out.insert("tier".to_string(), self.tier.clone().unwrap_or(Value::Null));
        out.insert("isTest".to_string(), Value::from(self.is_test));
        out.insert("recovered".to_string(), Value::from(self.recovered));
        out.insert(
            "sourceId".to_string(),
            self.source_id
                .clone()
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
        out.insert("durationMs".to_string(), Value::from(self.duration_ms));
        out.insert("queuedAt".to_string(), Value::from(self.queued_at));
        if let Some(started_at) = self.started_at {
            out.insert("startedAt".to_string(), Value::from(started_at));
        }
        Value::Object(out)
    }
}

/// Как поставить алерт в очередь.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EnqueueMeta {
    /// Не фильтровать по минимальной сумме: тестовые алерты и ручной повтор —
    /// пользователь нажал кнопку, значит хочет видеть.
    pub force: bool,
    /// Поставить в начало очереди (повтор «сейчас»).
    pub front: bool,
    /// Играть даже на паузе (тестовые алерты).
    pub ignore_pause: bool,
    /// Донат, который подтянули с DonationAlerts как пропущенный.
    pub recovered: bool,
}

/// Почему алерт не попал в очередь.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueRejection {
    /// Это не алерт: `null` или не объект.
    Empty,
    /// Донат ниже минимальной суммы.
    BelowMinAmount,
}

impl EnqueueRejection {
    /// Как причина называется в ответе — те же слова, что в JS.
    pub fn as_str(self) -> &'static str {
        match self {
            EnqueueRejection::Empty => "empty",
            EnqueueRejection::BelowMinAmount => "below-min-amount",
        }
    }
}

/// Что вышло из постановки в очередь.
#[derive(Debug, Clone, PartialEq)]
pub struct EnqueueOutcome {
    pub accepted: bool,
    pub reason: Option<EnqueueRejection>,
    /// Алерт слился с ожидающим хвостом очереди.
    pub merged: bool,
    /// Что в итоге в очереди: принятый или объединённый алерт.
    pub item: Option<Item>,
}

impl EnqueueOutcome {
    fn rejected(reason: EnqueueRejection) -> Self {
        Self {
            accepted: false,
            reason: Some(reason),
            merged: false,
            item: None,
        }
    }
}

/// Почему текущий алерт закончился.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishReason {
    /// Пришло время: длительность алерта и хвост анимации вышли.
    Auto,
    /// Пользователь нажал «пропустить».
    Skip,
    /// Всё остальное (панель, пульт, остановка).
    Manual,
}

/// Почему пауза снята.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeReason {
    /// Срок паузы истёк сам.
    Timeout,
    /// Снял пользователь (или код при старте).
    Manual,
}

/// Настройки очереди. Часы необязательны, таймеры — нет: их даёт вызывающий.
pub struct AlertQueueOptions {
    pub clock: Option<Arc<ClockFn>>,
    pub schedule: Arc<ScheduleFn>,
    pub cancel: Arc<CancelFn>,
    pub on_play: Option<Arc<PlayFn>>,
    pub on_change: Option<Arc<ChangeFn>>,
    pub rules: Option<Rules>,
    pub tail_ms: Option<u64>,
}

#[derive(Default)]
struct State {
    rules: Rules,
    /// Алерт в эфире.
    now: Option<Item>,
    /// Ожидающие: первый — следующий.
    items: Vec<Item>,
    paused: bool,
    /// `0` — пауза без срока.
    paused_until: i64,
    timer: Option<TimerId>,
    pause_timer: Option<TimerId>,
    seq: u64,
    stats: Stats,
}

/// Очередь алертов.
pub struct AlertQueue {
    clock: Arc<ClockFn>,
    schedule: Arc<ScheduleFn>,
    cancel: Arc<CancelFn>,
    on_play: Option<Arc<PlayFn>>,
    on_change: Option<Arc<ChangeFn>>,
    tail_ms: u64,
    state: Mutex<State>,
    /// Нужна таймерам: они приходят позже и должны найти очередь, если она ещё
    /// жива.
    self_weak: Weak<AlertQueue>,
}

impl AlertQueue {
    /// Собрать очередь. Возвращается `Arc`: таймеры ссылаются на очередь, а она
    /// на них — без общего владения здесь не обойтись.
    pub fn new(options: AlertQueueOptions) -> Arc<Self> {
        let clock = options
            .clock
            .unwrap_or_else(|| Arc::new(|| chrono::Utc::now().timestamp_millis()));
        let tail_ms = options.tail_ms.unwrap_or(TAIL_MS);
        let rules = options.rules.unwrap_or_default();

        Arc::new_cyclic(|self_weak| AlertQueue {
            clock,
            schedule: options.schedule,
            cancel: options.cancel,
            on_play: options.on_play,
            on_change: options.on_change,
            tail_ms,
            state: Mutex::new(State {
                rules,
                ..State::default()
            }),
            self_weak: self_weak.clone(),
        })
    }

    pub fn rules(&self) -> Rules {
        self.state().rules
    }

    /// Снимок: что играет, что ждёт, на паузе ли очередь, правила и счётчики.
    pub fn snapshot(&self) -> Value {
        let state = self.state();
        self.snapshot_locked(&state)
    }

    /// Поставить алерт в очередь.
    ///
    /// `ignore_pause` подразумевает `front`: человек нажал кнопку «тестовый
    /// алерт» и ждёт картинку сейчас, а не после пяти реальных донатов.
    pub fn enqueue(&self, alert: &Value, meta: &EnqueueMeta) -> EnqueueOutcome {
        let meta = if meta.ignore_pause {
            EnqueueMeta {
                front: true,
                ..*meta
            }
        } else {
            *meta
        };
        self.enqueue_internal(alert, &meta)
    }

    /// Дать очередь дальше, если сейчас ничего не играет.
    pub fn drain(&self) {
        let mut state = self.state();
        self.drain_locked(&mut state, false);
    }

    /// Закончить текущий алерт; `None` — играть было нечего.
    pub fn finish_current(&self, reason: FinishReason) -> Option<Item> {
        let mut state = self.state();
        let finished = state.now.take()?;
        if reason == FinishReason::Skip {
            state.stats.skipped += 1;
        }
        self.clear_timers(&mut state);
        self.changed(&state, "finished");
        self.drain_locked(&mut state, false);
        Some(finished)
    }

    /// Убрать ожидающий алерт.
    pub fn remove(&self, id: &str) -> bool {
        let mut state = self.state();
        let Some(index) = state.items.iter().position(|item| item.id == id) else {
            return false;
        };
        state.items.remove(index);
        self.changed(&state, "removed");
        true
    }

    /// Поднять ожидающий наверх: следующий алерт выйдет раньше остальных.
    pub fn move_up(&self, id: &str) -> bool {
        let mut state = self.state();
        let Some(index) = state.items.iter().position(|item| item.id == id) else {
            return false;
        };
        if index == 0 {
            return false;
        }
        let item = state.items.remove(index);
        state.items.insert(0, item);
        self.changed(&state, "reordered");
        true
    }

    /// Проиграть выбранный алерт сейчас. Текущий не выбрасывается: пользователь
    /// не просил его убрать — он возвращается в начало ожидающих.
    pub fn play_now(&self, id: &str) -> bool {
        let mut state = self.state();
        let Some(index) = state.items.iter().position(|item| item.id == id) else {
            return false;
        };
        let item = state.items.remove(index);
        if let Some(current) = state.now.take() {
            state.items.insert(0, current);
            self.clear_timers(&mut state);
        }
        state.items.insert(0, item);
        self.changed(&state, "play-now");
        self.drain_locked(&mut state, false);
        true
    }

    /// Убрать ожидающих; играющий остаётся. Возвращает, сколько убрали.
    pub fn clear(&self) -> usize {
        let mut state = self.state();
        let dropped = state.items.len();
        state.items.clear();
        self.changed(&state, "cleared");
        dropped
    }

    /// Поставить на паузу: `0` минут — до явного продолжения, больше нуля — на
    /// срок. Срок хранит вызывающий в конфиге, поэтому перезапуск приложения
    /// паузу не снимает.
    pub fn pause(&self, minutes: f64) -> Value {
        let mut state = self.state();
        state.paused = true;
        state.paused_until = if minutes > 0.0 {
            (self.clock)() + (minutes * 60_000.0) as i64
        } else {
            0
        };
        if let Some(timer) = state.pause_timer.take() {
            (self.cancel)(timer);
        }
        state.pause_timer = if minutes > 0.0 {
            Some(self.schedule_resume((minutes * 60_000.0).max(0.0) as u64))
        } else {
            None
        };
        self.changed(&state, "paused");
        self.snapshot_locked(&state)
    }

    /// Снять паузу и продолжить.
    pub fn resume(&self, reason: ResumeReason) -> Value {
        let mut state = self.state();
        self.resume_locked(&mut state, reason);
        self.snapshot_locked(&state)
    }

    /// Поменять правила на ходу.
    pub fn set_rules(&self, patch: &Value) -> Rules {
        let mut state = self.state();
        // Проверяем именно наличие поля: `null` в JSON — это «поле есть», и
        // `Number(null)` в JS даёт ноль.
        if let Some(value) = patch.get("minAmount") {
            state.rules.min_amount = js_number_or_zero(Some(value)).max(0.0);
        }
        if let Some(value) = patch.get("mergeSameUser") {
            state.rules.merge_same_user = js_truthy(Some(value));
        }
        if let Some(value) = patch.get("mergeWindowSec") {
            state.rules.merge_window_sec = js_number_or_zero(Some(value)).max(0.0);
        }
        self.changed(&state, "rules");
        state.rules
    }

    /// Восстановить паузу из конфига при старте.
    ///
    /// Истёкший срок паузой не считается — иначе перезапуск после долгого
    /// простоя оставил бы очередь стоять.
    pub fn restore_pause(&self, paused_until_ms: f64) -> bool {
        let mut state = self.state();
        let until = if paused_until_ms.is_nan() {
            0
        } else {
            paused_until_ms as i64
        };
        if until <= (self.clock)() {
            return false;
        }
        state.paused = true;
        state.paused_until = until;
        let ms = (until - (self.clock)()).max(0) as u64;
        if let Some(timer) = state.pause_timer.take() {
            (self.cancel)(timer);
        }
        if ms > 0 {
            state.pause_timer = Some(self.schedule_resume(ms));
        }
        true
    }

    /// Снять все таймеры — при остановке сервера.
    pub fn stop(&self) {
        let mut state = self.state();
        self.clear_timers(&mut state);
        if let Some(timer) = state.pause_timer.take() {
            (self.cancel)(timer);
        }
    }

    // ---- внутри замка ----

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn enqueue_internal(&self, alert: &Value, meta: &EnqueueMeta) -> EnqueueOutcome {
        // В JS проверка — `typeof alert !== "object"`, поэтому массив проходит,
        // а строка и число нет. Повторяем это, а не «очевидное» `is_object`.
        if alert.is_null() || !(alert.is_object() || alert.is_array()) {
            return EnqueueOutcome::rejected(EnqueueRejection::Empty);
        }

        let mut state = self.state();
        state.stats.received += 1;

        let amount = match alert.get("amount") {
            Some(Value::Number(number)) => number.as_f64(),
            _ => None,
        };
        let kind = text_or(alert.get("kind"), "unknown");
        if kind == "donation"
            && amount.is_some_and(|value| value < state.rules.min_amount)
            && !meta.force
            && state.rules.min_amount > 0.0
        {
            state.stats.filtered += 1;
            return EnqueueOutcome::rejected(EnqueueRejection::BelowMinAmount);
        }

        let at = (self.clock)();
        state.seq += 1;
        let item = Item {
            id: format!("al-{}", state.seq),
            kind,
            user: text_or(alert.get("user"), ""),
            amount,
            currency: truthy(alert.get("currency")),
            message: text_or(alert.get("message"), ""),
            count: js_number_or_zero(alert.get("count")).max(0.0) as u64,
            tier: truthy(alert.get("tier")),
            is_test: js_truthy(alert.get("isTest")),
            recovered: meta.recovered,
            // `!= null`, а не «истинно»: `0` и `""` — тоже идентификаторы.
            source_id: alert
                .get("sourceId")
                .filter(|value| !value.is_null())
                .map(js_key),
            duration_ms: duration_ms(alert.get("durationMs")),
            queued_at: at,
            started_at: None,
        };
        if item.recovered {
            state.stats.recovered += 1;
        }

        /*
          Объединяем только с ожидающим хвостом очереди: алерт, который уже
          играет, задним числом не меняется — виджет уже нарисовал сумму и текст,
          и подмена значения на экране была бы враньём. Поэтому при всплеске
          донатов от одного зрителя первый алерт выходит как есть, а второй и
          третий — одним алертом с суммой и счётчиком.
        */
        let can_merge = {
            let target = state.items.last();
            state.rules.merge_same_user
                && !meta.front
                && item.kind == "donation"
                && target.is_some_and(|target| {
                    target.kind == "donation"
                        && !target.user.is_empty()
                        && target.user.to_lowercase() == item.user.to_lowercase()
                        && (at - target.queued_at) as f64 <= state.rules.merge_window_sec * 1000.0
                })
        };

        if can_merge {
            let merged = {
                let target = state.items.last_mut().expect("цель объединения есть");
                target.amount = Some(target.amount.unwrap_or(0.0) + item.amount.unwrap_or(0.0));
                target.count = if target.count == 0 { 1 } else { target.count } + 1;
                if !item.message.is_empty() {
                    target.message = item.message.clone();
                }
                if item.recovered {
                    target.recovered = true;
                }
                target.clone()
            };
            state.stats.merged += 1;
            self.changed(&state, "merged");
            return EnqueueOutcome {
                accepted: true,
                reason: None,
                merged: true,
                item: Some(merged),
            };
        }

        if meta.front {
            state.items.insert(0, item.clone());
        } else {
            state.items.push(item.clone());
        }
        self.changed(&state, "queued");
        self.drain_locked(&mut state, meta.ignore_pause);
        EnqueueOutcome {
            accepted: true,
            reason: None,
            merged: false,
            item: Some(item),
        }
    }

    fn drain_locked(&self, state: &mut State, ignore_pause: bool) {
        if state.now.is_some() || state.items.is_empty() {
            return;
        }
        if self.pause_expired(state) {
            // Срок паузы вышел — продолжаем сами, без вмешательства пользователя.
            self.resume_locked(state, ResumeReason::Timeout);
            return;
        }
        // `ignore_pause` — для тестовых алертов: человек нажал кнопку и ждёт
        // картинку сейчас, но пауза при этом не снимается — очередь стоит.
        if state.paused && !ignore_pause {
            return;
        }

        let mut item = state.items.remove(0);
        item.started_at = Some((self.clock)());
        state.stats.played += 1;
        state.now = Some(item.clone());
        self.changed(state, "playing");
        if let Some(on_play) = &self.on_play {
            on_play(&item.to_json());
        }
        let wait = item.duration_ms + self.tail_ms;
        self.schedule_next(state, wait);
    }

    fn resume_locked(&self, state: &mut State, reason: ResumeReason) {
        state.paused = false;
        state.paused_until = 0;
        if let Some(timer) = state.pause_timer.take() {
            (self.cancel)(timer);
        }
        let name = match reason {
            ResumeReason::Timeout => "scroll-resumed",
            ResumeReason::Manual => "resumed",
        };
        self.changed(state, name);
        self.drain_locked(state, false);
    }

    fn is_paused(&self, state: &State) -> bool {
        state.paused && !self.pause_expired(state)
    }

    /// Пауза со сроком истекла сама — это не «на паузе», а ожидание продолжения.
    fn pause_expired(&self, state: &State) -> bool {
        state.paused && state.paused_until > 0 && state.paused_until <= (self.clock)()
    }

    fn clear_timers(&self, state: &mut State) {
        if let Some(timer) = state.timer.take() {
            (self.cancel)(timer);
        }
    }

    fn schedule_next(&self, state: &mut State, ms: u64) {
        self.clear_timers(state);
        let weak = self.self_weak.clone();
        let callback: Box<dyn FnOnce() + Send> = Box::new(move || {
            if let Some(queue) = weak.upgrade() {
                queue.timer_fired();
            }
        });
        state.timer = Some((self.schedule)(callback, ms));
    }

    fn schedule_resume(&self, ms: u64) -> TimerId {
        let weak = self.self_weak.clone();
        let callback: Box<dyn FnOnce() + Send> = Box::new(move || {
            if let Some(queue) = weak.upgrade() {
                let mut state = queue.state();
                if let Some(timer) = state.pause_timer.take() {
                    (queue.cancel)(timer);
                }
                queue.resume_locked(&mut state, ResumeReason::Timeout);
            }
        });
        (self.schedule)(callback, ms)
    }

    /// Сработал таймер текущего алерта.
    fn timer_fired(&self) {
        {
            let mut state = self.state();
            state.timer = None;
        }
        self.finish_current(FinishReason::Auto);
    }

    fn snapshot_locked(&self, state: &State) -> Value {
        json!({
            "now": state.now.as_ref().map(Item::to_json).unwrap_or(Value::Null),
            "items": state.items.iter().map(Item::to_json).collect::<Vec<_>>(),
            "paused": self.is_paused(state),
            "pausedUntil": if state.paused_until > 0 {
                Value::from(state.paused_until)
            } else {
                Value::Null
            },
            "rules": state.rules.to_json(),
            "stats": state.stats.to_json(),
            "pending": state.items.len(),
        })
    }

    fn changed(&self, state: &State, reason: &str) {
        let Some(on_change) = &self.on_change else {
            return;
        };
        let snapshot = self.snapshot_locked(state);
        let mut payload = Map::new();
        payload.insert("reason".to_string(), Value::from(reason));
        if let Value::Object(fields) = snapshot {
            for (key, value) in fields {
                payload.insert(key, value);
            }
        }
        on_change(&Value::Object(payload));
    }
}

/// `String(value || fallback)`: пустое значение заменяется умолчанием.
fn text_or(value: Option<&Value>, fallback: &str) -> String {
    if js_truthy(value) {
        value.map(js_key).unwrap_or_default()
    } else {
        fallback.to_string()
    }
}

/// `value || null`: пустое значение даёт `null`, остальное проходит как есть.
fn truthy(value: Option<&Value>) -> Option<Value> {
    if js_truthy(value) {
        value.cloned()
    } else {
        None
    }
}

/// `Number(value) || 5000`.
fn duration_ms(value: Option<&Value>) -> u64 {
    let number = js_number_or_zero(value);
    if number <= 0.0 {
        DEFAULT_DURATION_MS
    } else {
        number as u64
    }
}

/// Длинный текст доната: JS обрезает исходное пожелание до 200 символов,
/// чтобы в виджете было видно перенос и обрезку.
const LONG_TEST_DONATION: &str = "Спасибо за поддержку канала и за уютную атмосферу на каждом стриме! Твой вклад очень важен, он помогает каналу расти и развиваться дальше. Желаю тебе удачи, вдохновения, здоровья и как можно больше по";

/// Тестовый алерт для панели и пульта — `buildTestAlert` из `index.js`.
///
/// `kind` приходит из команды; неизвестный (или не строка) даёт `follow`, как
/// `default` в JS-переключателе.
pub fn build_test_alert(kind: &Value) -> Value {
    const NAMES: [&str; 4] = ["nova_viewer", "star_gazer", "orbit_fan", "comet_watcher"];
    let user = NAMES[random_index(NAMES.len())];
    match kind.as_str().unwrap_or("follow") {
        "sub" => json!({ "kind": "sub", "user": user, "tier": "1000" }),
        "gift_sub" => json!({ "kind": "gift_sub", "user": user, "count": 3 }),
        "cheer" => json!({ "kind": "cheer", "user": user, "amount": 250 }),
        "donation" => json!({
            "kind": "donation",
            "user": user,
            "amount": 300,
            "currency": "RUB",
            "message": "Удачного стрима!",
        }),
        "donation_long" => json!({
            "kind": "donation",
            "user": user,
            "amount": 750,
            "currency": "RUB",
            "message": LONG_TEST_DONATION,
        }),
        _ => json!({ "kind": "follow", "user": user }),
    }
}

/// Случайный индекс — то же, что `Math.floor(Math.random() * len)`, но через
/// `uuid`, как в `chat_bot`/`runtime`.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

    /// Таймер подставной: очередь хранит только идентификатор, а запускает
    /// колбэк заготовка — как `advance` в Jest-наборе.
    struct Timer {
        id: TimerId,
        callback: Option<Box<dyn FnOnce() + Send>>,
        at: i64,
        cancelled: bool,
    }

    /// Очередь с подменёнными часами и таймерами.
    struct Fixture {
        queue: Arc<AlertQueue>,
        played: Arc<Mutex<Vec<Value>>>,
        changes: Arc<Mutex<Vec<Value>>>,
        timers: Arc<Mutex<Vec<Timer>>>,
        time: Arc<AtomicI64>,
    }

    impl Fixture {
        fn new(rules: Option<Rules>, tail_ms: Option<u64>) -> Self {
            let time = Arc::new(AtomicI64::new(1_000_000));
            let timers: Arc<Mutex<Vec<Timer>>> = Arc::new(Mutex::new(Vec::new()));
            let played: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
            let changes: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
            let next_id = Arc::new(AtomicU64::new(1));

            let schedule = {
                let timers = timers.clone();
                let time = time.clone();
                let next_id = next_id.clone();
                Arc::new(move |callback: Box<dyn FnOnce() + Send>, ms: u64| {
                    let id = next_id.fetch_add(1, Ordering::SeqCst);
                    timers.lock().unwrap().push(Timer {
                        id,
                        callback: Some(callback),
                        at: time.load(Ordering::SeqCst) + ms as i64,
                        cancelled: false,
                    });
                    id
                }) as Arc<ScheduleFn>
            };
            let cancel = {
                let timers = timers.clone();
                Arc::new(move |id: TimerId| {
                    let mut timers = timers.lock().unwrap();
                    if let Some(timer) = timers.iter_mut().find(|timer| timer.id == id) {
                        timer.cancelled = true;
                    }
                }) as Arc<CancelFn>
            };
            let on_play = {
                let played = played.clone();
                Arc::new(move |alert: &Value| played.lock().unwrap().push(alert.clone()))
                    as Arc<PlayFn>
            };
            let on_change = {
                let changes = changes.clone();
                Arc::new(move |state: &Value| changes.lock().unwrap().push(state.clone()))
                    as Arc<ChangeFn>
            };
            let clock: Arc<ClockFn> = {
                let time = time.clone();
                Arc::new(move || time.load(Ordering::SeqCst))
            };

            let queue = AlertQueue::new(AlertQueueOptions {
                clock: Some(clock),
                schedule,
                cancel,
                on_play: Some(on_play),
                on_change: Some(on_change),
                rules,
                tail_ms,
            });

            Self {
                queue,
                played,
                changes,
                timers,
                time,
            }
        }

        fn advance(&self, ms: i64) {
            self.time.fetch_add(ms, Ordering::SeqCst);
            let now = self.time.load(Ordering::SeqCst);
            loop {
                // Запускаем всё, что «сработало» за прошедшее время, по порядку.
                let due = {
                    let mut timers = self.timers.lock().unwrap();
                    let index = timers
                        .iter()
                        .enumerate()
                        .filter(|(_, timer)| {
                            !timer.cancelled && timer.callback.is_some() && timer.at <= now
                        })
                        .min_by_key(|(_, timer)| timer.at)
                        .map(|(index, _)| index);
                    index.map(|index| timers[index].callback.take().expect("колбэк таймера"))
                };
                match due {
                    Some(callback) => callback(),
                    None => break,
                }
            }
        }

        fn played(&self) -> Vec<Value> {
            self.played.lock().unwrap().clone()
        }

        fn changes(&self) -> Vec<Value> {
            self.changes.lock().unwrap().clone()
        }

        fn snapshot(&self) -> Value {
            self.queue.snapshot()
        }

        fn stop(&self) {
            self.queue.stop();
        }
    }

    /// Донат с настройками поверх умолчаний — как `donation(overrides)` в Jest.
    fn donation(overrides: Value) -> Value {
        let mut base = json!({
            "kind": "donation",
            "user": "viewer",
            "amount": 100,
            "currency": "RUB",
            "durationMs": 5000,
        });
        if let (Some(base), Some(extra)) = (base.as_object_mut(), overrides.as_object()) {
            for (key, value) in extra {
                base.insert(key.clone(), value.clone());
            }
        }
        base
    }

    /// Поля ожидающего/играющего алерта списком — как `map(item => item.user)`.
    fn field_of(list: &[Value], key: &str) -> Vec<Value> {
        list.iter().map(|item| item[key].clone()).collect()
    }

    /// Проверка «содержит эти поля» — как `toMatchObject` в Jest: вложенные
    /// объекты тоже сравниваются частично.
    fn assert_fields(value: &Value, fields: Value) {
        let expected = fields.as_object().expect("ожидания — объект");
        for (key, want) in expected {
            if want.is_object() {
                assert_fields(&value[key], want.clone());
            } else {
                assert_eq!(value[key], *want, "поле {key} в {value}");
            }
        }
    }

    // ---- порядок и ритм ----

    #[test]
    fn the_first_alert_plays_at_once_and_the_rest_wait() {
        let fixture = Fixture::new(None, None);
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "a" })), &EnqueueMeta::default());
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "b" })), &EnqueueMeta::default());

        let played = fixture.played();
        assert_eq!(played.len(), 1);
        assert_eq!(played[0]["user"], json!("a"));
        assert_eq!(fixture.snapshot()["now"]["user"], json!("a"));
        assert_eq!(
            field_of(fixture.snapshot()["items"].as_array().unwrap(), "user"),
            vec![json!("b")]
        );
        fixture.stop();
    }

    #[test]
    fn the_next_one_starts_after_the_duration_and_the_animation_tail() {
        let fixture = Fixture::new(None, Some(400));
        fixture.queue.enqueue(
            &donation(json!({ "user": "a", "durationMs": 5000 })),
            &EnqueueMeta::default(),
        );
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "b" })), &EnqueueMeta::default());

        fixture.advance(5000);
        assert_eq!(fixture.played().len(), 1, "рано: ещё идёт хвост");
        fixture.advance(400);
        assert_eq!(
            field_of(&fixture.played(), "user"),
            vec![json!("a"), json!("b")]
        );
        fixture.stop();
    }

    #[test]
    fn nothing_happens_while_the_queue_is_empty() {
        let fixture = Fixture::new(None, None);
        fixture.advance(60_000);

        assert!(fixture.played().is_empty());
        assert_eq!(fixture.snapshot()["now"], Value::Null);
        assert_eq!(fixture.snapshot()["stats"]["played"], json!(0));
        fixture.stop();
    }

    // ---- правила ----

    #[test]
    fn the_minimum_amount_cuts_small_donations_but_not_other_events() {
        let fixture = Fixture::new(
            Some(Rules {
                min_amount: 500.0,
                ..Rules::default()
            }),
            None,
        );

        let small = fixture
            .queue
            .enqueue(&donation(json!({ "amount": 100 })), &EnqueueMeta::default());
        let follow = fixture.queue.enqueue(
            &json!({ "kind": "follow", "user": "fan", "durationMs": 5000 }),
            &EnqueueMeta::default(),
        );
        let big = fixture.queue.enqueue(
            &donation(json!({ "amount": 700, "user": "big" })),
            &EnqueueMeta::default(),
        );

        assert!(!small.accepted);
        assert_eq!(small.reason, Some(EnqueueRejection::BelowMinAmount));
        assert_eq!(
            small.reason.map(EnqueueRejection::as_str),
            Some("below-min-amount")
        );
        assert!(follow.accepted);
        assert!(big.accepted);
        assert_eq!(field_of(&fixture.played(), "kind"), vec![json!("follow")]);
        assert_eq!(fixture.snapshot()["stats"]["filtered"], json!(1));
        fixture.stop();
    }

    #[test]
    fn a_test_alert_plays_even_below_the_threshold() {
        let fixture = Fixture::new(
            Some(Rules {
                min_amount: 1000.0,
                ..Rules::default()
            }),
            None,
        );

        let result = fixture.queue.enqueue(
            &donation(json!({ "amount": 10, "isTest": true })),
            &EnqueueMeta {
                force: true,
                ..EnqueueMeta::default()
            },
        );

        assert!(result.accepted);
        assert_eq!(fixture.played().len(), 1);
        fixture.stop();
    }

    #[test]
    fn donations_from_the_same_viewer_merge_into_a_sum_with_a_counter() {
        let fixture = Fixture::new(Some(Rules::default()), None);

        fixture.queue.enqueue(
            &donation(json!({ "user": "fan", "amount": 100 })),
            &EnqueueMeta::default(),
        );
        fixture.queue.enqueue(
            &donation(json!({ "user": "fan", "amount": 250 })),
            &EnqueueMeta::default(),
        );
        fixture.queue.enqueue(
            &donation(json!({ "user": "fan", "amount": 50 })),
            &EnqueueMeta::default(),
        );

        let snapshot = fixture.snapshot();
        // Первый уже играет — его сумма задним числом не меняется.
        assert_fields(&snapshot["now"], json!({ "amount": 100 }));
        // Второй и третий слились в один ожидающий алерт: сумма и счётчик.
        assert_eq!(snapshot["items"].as_array().unwrap().len(), 1);
        assert_fields(&snapshot["items"][0], json!({ "amount": 300, "count": 2 }));
        assert_eq!(snapshot["stats"]["merged"], json!(1));
        fixture.stop();
    }

    #[test]
    fn merging_works_only_inside_the_window() {
        let fixture = Fixture::new(
            Some(Rules {
                merge_window_sec: 10.0,
                ..Rules::default()
            }),
            None,
        );

        fixture.queue.enqueue(
            &donation(json!({ "user": "fan", "amount": 100, "durationMs": 1000 })),
            &EnqueueMeta::default(),
        );
        fixture.advance(11_000); // первый уже отыграл, окно прошло
        fixture.queue.enqueue(
            &donation(json!({ "user": "fan", "amount": 100 })),
            &EnqueueMeta::default(),
        );

        assert_eq!(fixture.snapshot()["now"]["amount"], json!(100));
        assert_eq!(fixture.snapshot()["stats"]["merged"], json!(0));
        fixture.stop();
    }

    #[test]
    fn different_viewers_do_not_merge() {
        let fixture = Fixture::new(
            Some(Rules {
                merge_window_sec: 60.0,
                ..Rules::default()
            }),
            None,
        );

        fixture.queue.enqueue(
            &donation(json!({ "user": "fan", "amount": 100 })),
            &EnqueueMeta::default(),
        );
        fixture.queue.enqueue(
            &donation(json!({ "user": "other", "amount": 100 })),
            &EnqueueMeta::default(),
        );

        assert_eq!(
            field_of(fixture.snapshot()["items"].as_array().unwrap(), "user"),
            vec![json!("other")]
        );
        assert_eq!(fixture.snapshot()["stats"]["merged"], json!(0));
        fixture.stop();
    }

    #[test]
    fn merging_can_be_turned_off() {
        let fixture = Fixture::new(
            Some(Rules {
                merge_same_user: false,
                ..Rules::default()
            }),
            None,
        );

        fixture
            .queue
            .enqueue(&donation(json!({ "user": "fan" })), &EnqueueMeta::default());
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "fan" })), &EnqueueMeta::default());

        assert_eq!(
            field_of(fixture.snapshot()["items"].as_array().unwrap(), "amount"),
            vec![json!(100)]
        );
        fixture.stop();
    }

    #[test]
    fn rules_can_change_on_the_fly() {
        let fixture = Fixture::new(None, None);

        let rules = fixture
            .queue
            .set_rules(&json!({ "minAmount": 300, "mergeWindowSec": 5 }));
        assert_eq!(rules.min_amount, 300.0);
        assert_eq!(rules.merge_window_sec, 5.0);
        assert!(
            !fixture
                .queue
                .enqueue(&donation(json!({ "amount": 200 })), &EnqueueMeta::default())
                .accepted
        );
        assert!(
            fixture
                .queue
                .enqueue(&donation(json!({ "amount": 300 })), &EnqueueMeta::default())
                .accepted
        );
        fixture.stop();
    }

    // ---- управление ----

    #[test]
    fn skipping_ends_the_current_alert_and_starts_the_next() {
        let fixture = Fixture::new(None, None);
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "a" })), &EnqueueMeta::default());
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "b" })), &EnqueueMeta::default());

        let skipped = fixture
            .queue
            .finish_current(FinishReason::Skip)
            .expect("играющий алерт");

        assert_eq!(skipped.user, "a");
        assert_eq!(
            field_of(&fixture.played(), "user"),
            vec![json!("a"), json!("b")]
        );
        assert_eq!(fixture.snapshot()["stats"]["skipped"], json!(1));
        fixture.stop();
    }

    #[test]
    fn removing_and_raising_touch_only_the_waiting() {
        let fixture = Fixture::new(None, None);
        fixture.queue.enqueue(
            &donation(json!({ "user": "playing" })),
            &EnqueueMeta::default(),
        );
        let second = fixture.queue.enqueue(
            &donation(json!({ "user": "second" })),
            &EnqueueMeta::default(),
        );
        let third = fixture.queue.enqueue(
            &donation(json!({ "user": "third" })),
            &EnqueueMeta::default(),
        );

        let third_id = third.item.expect("алерт").id;
        let second_id = second.item.expect("алерт").id;
        assert!(fixture.queue.move_up(&third_id));
        assert_eq!(
            field_of(fixture.snapshot()["items"].as_array().unwrap(), "user"),
            vec![json!("third"), json!("second")]
        );
        assert!(fixture.queue.remove(&second_id));
        assert_eq!(
            field_of(fixture.snapshot()["items"].as_array().unwrap(), "user"),
            vec![json!("third")]
        );
        assert!(!fixture.queue.remove("нет-такого"));
        assert!(!fixture.queue.move_up("нет-такого"));
        fixture.stop();
    }

    #[test]
    fn play_now_brings_the_chosen_alert_forward_and_returns_the_current_one() {
        let fixture = Fixture::new(None, None);
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "a" })), &EnqueueMeta::default());
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "b" })), &EnqueueMeta::default());
        let target = fixture
            .queue
            .enqueue(&donation(json!({ "user": "c" })), &EnqueueMeta::default());
        let target_id = target.item.expect("алерт").id;

        assert!(fixture.queue.play_now(&target_id));

        assert_eq!(fixture.snapshot()["now"]["user"], json!("c"));
        assert_eq!(
            field_of(fixture.snapshot()["items"].as_array().unwrap(), "user"),
            vec![json!("a"), json!("b")]
        );
        assert!(!fixture.queue.play_now("нет-такого"));
        fixture.stop();
    }

    #[test]
    fn clearing_drops_the_waiting_and_keeps_the_current_playing() {
        let fixture = Fixture::new(None, None);
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "a" })), &EnqueueMeta::default());
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "b" })), &EnqueueMeta::default());
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "c" })), &EnqueueMeta::default());

        assert_eq!(fixture.queue.clear(), 2);

        assert_eq!(fixture.snapshot()["now"]["user"], json!("a"));
        assert_eq!(fixture.snapshot()["items"], json!([]));
        fixture.stop();
    }

    // ---- пауза ----

    #[test]
    fn alerts_pile_up_while_paused_and_do_not_play() {
        let fixture = Fixture::new(None, None);
        fixture.queue.pause(0.0);

        fixture
            .queue
            .enqueue(&donation(json!({ "user": "a" })), &EnqueueMeta::default());
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "b" })), &EnqueueMeta::default());

        assert!(fixture.played().is_empty());
        assert_eq!(fixture.snapshot()["paused"], json!(true));
        assert_eq!(fixture.snapshot()["pending"], json!(2));

        fixture.queue.resume(ResumeReason::Manual);
        assert_eq!(field_of(&fixture.played(), "user"), vec![json!("a")]);
        fixture.stop();
    }

    #[test]
    fn a_timed_pause_lifts_itself() {
        let fixture = Fixture::new(None, None);
        fixture.queue.pause(5.0);
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "a" })), &EnqueueMeta::default());

        fixture.advance(4 * 60_000);
        assert!(fixture.played().is_empty());

        fixture.advance(60_001);
        assert_eq!(field_of(&fixture.played(), "user"), vec![json!("a")]);
        assert_eq!(fixture.snapshot()["paused"], json!(false));
        fixture.stop();
    }

    #[test]
    fn a_test_alert_plays_while_paused_and_the_pause_stays() {
        let fixture = Fixture::new(None, None);
        fixture.queue.pause(0.0);
        fixture.queue.enqueue(
            &donation(json!({ "user": "waiting" })),
            &EnqueueMeta::default(),
        );

        fixture.queue.enqueue(
            &donation(json!({ "user": "test", "isTest": true })),
            &EnqueueMeta {
                force: true,
                ignore_pause: true,
                ..EnqueueMeta::default()
            },
        );

        assert_eq!(field_of(&fixture.played(), "user"), vec![json!("test")]);
        assert_eq!(fixture.snapshot()["paused"], json!(true));
        // После тестового очередь снова стоит: пауза не снята.
        fixture.advance(10_000);
        assert_eq!(field_of(&fixture.played(), "user"), vec![json!("test")]);
        fixture.stop();
    }

    #[test]
    fn a_pause_is_restored_from_config_and_expires_on_time() {
        let fixture = Fixture::new(None, None);
        let until = fixture.time.load(Ordering::SeqCst) + 10 * 60_000;

        assert!(fixture.queue.restore_pause(until as f64));
        assert_eq!(fixture.snapshot()["paused"], json!(true));
        assert_eq!(fixture.snapshot()["pausedUntil"], json!(until));
        fixture.stop();
    }

    #[test]
    fn an_expired_deadline_from_config_is_not_a_pause() {
        let fixture = Fixture::new(None, None);
        let past = fixture.time.load(Ordering::SeqCst) - 1000;

        assert!(!fixture.queue.restore_pause(past as f64));
        assert_eq!(fixture.snapshot()["paused"], json!(false));
        fixture.stop();
    }

    // ---- наблюдаемость ----

    #[test]
    fn the_snapshot_has_what_the_panel_needs() {
        let fixture = Fixture::new(None, None);
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "a" })), &EnqueueMeta::default());
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "b" })), &EnqueueMeta::default());

        let snapshot = fixture.snapshot();

        assert_fields(
            &snapshot,
            json!({
                "paused": false,
                "pending": 1,
                "rules": { "minAmount": 0, "mergeSameUser": true, "mergeWindowSec": 20 },
                "stats": { "received": 2, "played": 1 },
            }),
        );
        assert_fields(
            &snapshot["now"],
            json!({ "user": "a", "kind": "donation", "amount": 100 }),
        );
        assert!(snapshot["now"]["id"]
            .as_str()
            .is_some_and(|id| !id.is_empty()));
        assert_fields(&snapshot["items"][0], json!({ "user": "b" }));
        fixture.stop();
    }

    #[test]
    fn changes_are_broadcast_with_a_reason() {
        let fixture = Fixture::new(None, None);
        fixture
            .queue
            .enqueue(&donation(json!({ "user": "a" })), &EnqueueMeta::default());

        let reasons = field_of(&fixture.changes(), "reason");
        assert_eq!(reasons, vec![json!("queued"), json!("playing")]);
        // Снимок на момент старта проигрывания: алерт ушёл в эфир, ожидающих нет.
        assert_fields(&fixture.changes()[1], json!({ "pending": 0 }));
        assert_fields(&fixture.changes()[1]["now"], json!({ "user": "a" }));
        fixture.stop();
    }

    #[test]
    fn an_empty_object_never_reaches_the_queue() {
        let fixture = Fixture::new(None, None);

        let empty = fixture.queue.enqueue(&Value::Null, &EnqueueMeta::default());
        assert!(!empty.accepted);
        assert_eq!(empty.reason, Some(EnqueueRejection::Empty));
        assert_eq!(empty.reason.map(EnqueueRejection::as_str), Some("empty"));
        // Не объект — тоже не алерт (строка, число).
        assert!(
            !fixture
                .queue
                .enqueue(&json!("строка"), &EnqueueMeta::default())
                .accepted
        );
        assert_eq!(fixture.snapshot()["stats"]["received"], json!(0));
        fixture.stop();
    }

    // ---- подтянутые с DonationAlerts донаты ----

    #[test]
    fn the_recovered_mark_rides_with_the_alert_and_counts() {
        let fixture = Fixture::new(None, None);

        fixture.queue.enqueue(
            &donation(json!({ "user": "missed" })),
            &EnqueueMeta {
                recovered: true,
                ..EnqueueMeta::default()
            },
        );

        assert_eq!(fixture.snapshot()["now"]["recovered"], json!(true));
        assert_eq!(fixture.snapshot()["stats"]["recovered"], json!(1));
        fixture.stop();
    }

    #[test]
    fn an_ordinary_donation_is_not_considered_recovered() {
        let fixture = Fixture::new(None, None);

        fixture.queue.enqueue(
            &donation(json!({ "user": "live" })),
            &EnqueueMeta::default(),
        );

        assert_eq!(fixture.snapshot()["now"]["recovered"], json!(false));
        assert_eq!(fixture.snapshot()["stats"]["recovered"], json!(0));
        fixture.stop();
    }

    #[test]
    fn the_service_side_donation_id_is_kept_as_a_string() {
        let fixture = Fixture::new(None, None);

        fixture.queue.enqueue(
            &donation(json!({ "user": "missed", "sourceId": 42 })),
            &EnqueueMeta {
                recovered: true,
                ..EnqueueMeta::default()
            },
        );

        // Через очередь идентификатор едет строкой: конфиг и история хранят его
        // так же.
        assert_eq!(fixture.snapshot()["now"]["sourceId"], json!("42"));
        fixture.stop();
    }

    #[test]
    fn recovered_donations_merge_by_the_same_rules_as_live_ones() {
        let fixture = Fixture::new(Some(Rules::default()), None);

        fixture.queue.enqueue(
            &donation(json!({ "user": "fan", "amount": 100 })),
            &EnqueueMeta::default(),
        );
        fixture.queue.enqueue(
            &donation(json!({ "user": "fan", "amount": 50 })),
            &EnqueueMeta::default(),
        );
        fixture.queue.enqueue(
            &donation(json!({ "user": "fan", "amount": 25 })),
            &EnqueueMeta {
                recovered: true,
                ..EnqueueMeta::default()
            },
        );

        let waiting = fixture.snapshot()["items"][0].clone();
        assert_fields(&waiting, json!({ "user": "fan", "amount": 75, "count": 2 }));
        // Объединённый алерт помнит, что внутри было пропущенное.
        assert_eq!(waiting["recovered"], json!(true));
        // А играющий задним числом не меняется: виджет уже нарисовал сумму.
        assert_fields(
            &fixture.snapshot()["now"],
            json!({ "amount": 100, "count": 0 }),
        );
        fixture.stop();
    }

    #[test]
    fn recovered_donations_obey_the_minimum_amount_rule() {
        let fixture = Fixture::new(
            Some(Rules {
                min_amount: 500.0,
                ..Rules::default()
            }),
            None,
        );

        let result = fixture.queue.enqueue(
            &donation(json!({ "user": "tiny", "amount": 10 })),
            &EnqueueMeta {
                recovered: true,
                ..EnqueueMeta::default()
            },
        );

        // Правило одно на все донаты: подтянутый — такой же донат, как живой.
        assert!(!result.accepted);
        assert_eq!(result.reason, Some(EnqueueRejection::BelowMinAmount));
        assert_eq!(fixture.snapshot()["stats"]["filtered"], json!(1));
        fixture.stop();
    }

    #[test]
    fn a_test_alert_has_the_kind_the_button_asked_for() {
        assert_fields(
            &build_test_alert(&json!("sub")),
            json!({ "kind": "sub", "tier": "1000" }),
        );
        assert_fields(
            &build_test_alert(&json!("gift_sub")),
            json!({ "kind": "gift_sub", "count": 3 }),
        );
        assert_fields(
            &build_test_alert(&json!("cheer")),
            json!({ "kind": "cheer", "amount": 250 }),
        );
        assert_fields(
            &build_test_alert(&json!("donation")),
            json!({ "kind": "donation", "amount": 300, "currency": "RUB" }),
        );

        let long = build_test_alert(&json!("donation_long"));
        assert_fields(&long, json!({ "kind": "donation", "amount": 750 }));
        assert_eq!(long["message"].as_str().unwrap().chars().count(), 200);

        // Неизвестный (или не строковый) вид даёт обычный follow.
        assert_eq!(
            build_test_alert(&json!("нет такого"))["kind"],
            json!("follow")
        );
        assert_eq!(build_test_alert(&Value::Null)["kind"], json!("follow"));
        // Имя — из фиксированного списка, чтобы виджет было чем заполнить.
        let user = build_test_alert(&json!("follow"))["user"].clone();
        assert!(["nova_viewer", "star_gazer", "orbit_fan", "comet_watcher"]
            .contains(&user.as_str().unwrap()));
    }
}
