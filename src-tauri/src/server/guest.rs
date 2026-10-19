//! Гостевые камеры: слоты, одноразовые приглашения и signaling WebRTC.
//!
//! Медиа идёт напрямую между двумя OSE: панель гостя кодирует камеру и
//! микрофон, оверлей хоста их принимает. Сервер в этом не участвует — он
//! пересылает только SDP и ICE, не разбирая их. Поэтому здесь нет ни кадров,
//! ни медиасервера, а «комната» — это просто пара «слот + токен».
//!
//! Хост и гость используют один и тот же модуль с разных сторон:
//!
//! * хост принимает входящее соединение (`/ws?role=guest&slot=…&token=…`)
//!   и пересылает сигналы своему оверлею;
//! * гость сам подключается к серверу хоста и пересылает сигналы своей
//!   панели.
//!
//! Приглашение одноразовое и живёт [`INVITE_TTL`]; после подключения оно
//! больше не принимается, а отключение освобождает слот для нового.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::time::sleep;

use crate::protocol::event_types;
use crate::server::access;
use crate::server::bus::ClientRegistry;

/// Сколько живёт приглашение, если по нему так и не подключились.
pub const INVITE_TTL: Duration = Duration::from_secs(15 * 60);

/// Сколько ждём завершения upgrade после проверки токена. Если соединение
/// оборвалось между проверкой и регистрацией, резерв снимается — иначе слот
/// остался бы занятым навсегда.
const PENDING_TIMEOUT: Duration = Duration::from_secs(10);

/// Слоты гостевых камер. Первый слот — локальная камера хоста, поэтому
/// гостевым остаются три: этого хватает для мультикама и не превращает
/// интерфейс в список на десяток строк.
pub const GUEST_SLOTS: [&str; 3] = ["cam2", "cam3", "cam4"];

/// Ограничение на длину имени: оно приходит от гостя и показывается в панели.
const MAX_NAME_LEN: usize = 40;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    /// Приглашение ещё не создано.
    Free,
    /// Приглашение создано, гость не подключился.
    Open,
    /// Гость подключился, хост ещё не подтвердил.
    Waiting,
    /// Хост подтвердил, виджет-приёмник ещё не подписался.
    Accepted,
    /// Подтверждён, приёмник на месте — можно слать сигналы.
    Ready,
}

struct Slot {
    /// Подпись слота от хоста (необязательна).
    name: String,
    /// Одноразовый токен приглашения; пустой — приглашения нет.
    token: String,
    created: Instant,
    state: State,
    /// Номер входящего клиента (гость на сервере хоста).
    client: Option<u64>,
    /// Имя, которое сообщил гость.
    guest_name: String,
    /// Локальный клиент, принимающий поток: оверлей или сцена.
    receiver: Option<u64>,
    /// `open()` уже вызван, но соединение ещё не зарегистрировано.
    pending: bool,
    pending_at: Option<Instant>,
}

impl Slot {
    fn empty(name: &str) -> Self {
        Self {
            name: name.to_string(),
            token: String::new(),
            created: Instant::now(),
            state: State::Free,
            client: None,
            guest_name: String::new(),
            receiver: None,
            pending: false,
            pending_at: None,
        }
    }

    fn expired(&self, now: Instant) -> bool {
        self.state == State::Open && now.duration_since(self.created) > INVITE_TTL
    }

    fn state_name(&self) -> &'static str {
        match self.state {
            State::Free => "free",
            State::Open => "open",
            State::Waiting => "waiting",
            State::Accepted => "accepted",
            State::Ready => "connected",
        }
    }
}

struct Outgoing {
    slot: String,
    generation: u64,
    tx: mpsc::UnboundedSender<String>,
}

/// Исходящая хост-ссылка к публичному signaling. В отличие от входящего
/// гостя на LAN, здесь номер клиента не нужен: кадры уходят в сервис.
struct CloudLink {
    generation: u64,
    tx: mpsc::UnboundedSender<String>,
}

struct Inner {
    slots: HashMap<&'static str, Slot>,
    outgoing: Option<Outgoing>,
    cloud: HashMap<&'static str, CloudLink>,
}

impl Default for Inner {
    fn default() -> Self {
        let mut slots = HashMap::new();
        for slot in GUEST_SLOTS {
            slots.insert(slot, Slot::empty(""));
        }
        Self {
            slots,
            outgoing: None,
            cloud: HashMap::new(),
        }
    }
}

/// Слоты и приглашения обеих сторон. Состояние живёт только в памяти: это
/// эфемерная сессия, а не настройка, и после перезапуска приглашения должны
/// считаться недействительными.
pub struct GuestHub {
    inner: Mutex<Inner>,
    /// Счётчик для очистки присоединения: старая задача не должна сбросить
    /// новое соединение, открытое тем же слотом.
    generation: AtomicU64,
}

impl Default for GuestHub {
    fn default() -> Self {
        Self::new()
    }
}

impl GuestHub {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            generation: AtomicU64::new(0),
        }
    }

    /// Создать приглашение для слота. `None` — слот занят или неизвестен.
    pub fn create(&self, slot: &str, name: &str) -> Option<Value> {
        let slot = valid_slot(slot)?;
        {
            let inner = self.lock();
            let entry = inner.slots.get(slot)?;
            if matches!(entry.state, State::Waiting | State::Accepted | State::Ready) {
                return None;
            }
        }
        // Приглашение для локальной сети и облачная ссылка не должны жить
        // одновременно на одном слоте.
        self.remove_cloud(slot);
        let mut inner = self.lock();
        let entry = inner.slots.get_mut(slot)?;
        if matches!(entry.state, State::Waiting | State::Accepted | State::Ready) {
            return None;
        }
        // Один uuid — 32 символа: столько же, сколько у кода доступа, и
        // перебирать его по сети бессмысленно.
        let token = uuid::Uuid::new_v4().simple().to_string();
        entry.name = clean_name(name);
        entry.token = token.clone();
        entry.created = Instant::now();
        entry.client = None;
        entry.guest_name.clear();
        // Подписку приёмника не сбрасываем: виджет в оверлее уже смонтирован
        // и ждёт гостя, а о сбросе он не узнает — повторно подписываться не будет.
        entry.pending = false;
        entry.pending_at = None;
        entry.state = State::Open;
        Some(json!({
            "mode": "lan",
            "slot": slot,
            "name": entry.name,
            "token": token,
        }))
    }

    /// Создать облачное приглашение и поднять исходящую ссылку к signaling.
    /// `None` — слот занят, адрес сервиса некорректен или ссылка уже была.
    pub fn create_cloud(
        self: &Arc<Self>,
        clients: Arc<ClientRegistry>,
        slot: &str,
        name: &str,
        signal: &str,
    ) -> Option<Value> {
        let slot = valid_slot(slot)?;
        let signal = valid_signal(signal)?;
        {
            let inner = self.lock();
            let entry = inner.slots.get(slot)?;
            if matches!(entry.state, State::Waiting | State::Accepted | State::Ready) {
                return None;
            }
        }
        self.remove_cloud(slot);

        let room = uuid::Uuid::new_v4().simple().to_string();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        {
            let mut inner = self.lock();
            let entry = inner.slots.get_mut(slot)?;
            if matches!(entry.state, State::Waiting | State::Accepted | State::Ready) {
                return None;
            }
            entry.name = clean_name(name);
            entry.token.clear();
            entry.created = Instant::now();
            entry.client = None;
            entry.guest_name.clear();
            // См. `create`: подписка виджета переживает новое приглашение.
            entry.pending = false;
            entry.pending_at = None;
            entry.state = State::Open;
            inner.cloud.insert(slot, CloudLink { generation, tx });
        }

        let url = format!("{signal}/ws?role=host&room={room}&token={token}&name=");
        cloud_link_loop(Arc::clone(self), clients, slot, generation, url, rx);
        Some(json!({
            "mode": "cloud",
            "slot": slot,
            "name": name,
            "room": room,
            "token": token,
            "signal": signal,
        }))
    }

    /// Проверить приглашение перед upgrade. Успех резервирует слот до
    /// регистрации соединения, иначе два гостя могли бы пройти одновременно.
    pub fn open(&self, slot: &str, token: &str, guest_name: &str) -> bool {
        let Some(slot) = valid_slot(slot) else {
            return false;
        };
        let mut inner = self.lock();
        let now = Instant::now();
        let Some(entry) = inner.slots.get_mut(slot) else {
            return false;
        };
        if entry.expired(now) {
            entry.token.clear();
            entry.state = State::Free;
        }
        if entry.token.is_empty() || entry.pending || entry.client.is_some() {
            return false;
        }
        if !access::tokens_match(&entry.token, token) {
            return false;
        }
        entry.pending = true;
        entry.pending_at = Some(now);
        entry.state = State::Waiting;
        entry.guest_name = clean_name(guest_name);
        true
    }

    /// Привязать зарегистрированное соединение к резерву. `false` — резерв
    /// пропал (например, соединение успело закрыться).
    pub fn bind(&self, slot: &str, client: u64) -> bool {
        let Some(slot) = valid_slot(slot) else {
            return false;
        };
        let mut inner = self.lock();
        let Some(entry) = inner.slots.get_mut(slot) else {
            return false;
        };
        if !entry.pending {
            return false;
        }
        entry.pending = false;
        entry.pending_at = None;
        entry.client = Some(client);
        true
    }

    /// Регистрация не состоялась: снимаем резерв, оставляя приглашение
    /// действительным — гость может попробовать ещё раз.
    pub fn cancel(&self, slot: &str) {
        let Some(slot) = valid_slot(slot) else {
            return;
        };
        let mut inner = self.lock();
        if let Some(entry) = inner.slots.get_mut(slot) {
            if entry.client.is_none() {
                entry.pending = false;
                entry.pending_at = None;
                entry.state = State::Open;
                entry.guest_name.clear();
            }
        }
    }

    /// Гость отключился: слот освобождается, старый токен больше не работает.
    /// Возвращает слот, если это был именно он.
    pub fn unbind(&self, client: u64) -> Option<String> {
        let mut inner = self.lock();
        for (slot, entry) in inner.slots.iter_mut() {
            if entry.client == Some(client) {
                entry.client = None;
                entry.pending = false;
                entry.pending_at = None;
                entry.guest_name.clear();
                // Виджет остаётся на месте и после переподключения гостя
                // должен получить `receiver_ready` — поэтому подписку не трогаем.
                // Приглашение остаётся действительным до TTL: оборвавшаяся
                // связь не должна требовать новой ссылки. Отозвать его можно
                // явно — через `decline`.
                entry.state = State::Open;
                return Some((*slot).to_string());
            }
            // Клиент-приёмник тоже мог отключиться.
            if entry.receiver == Some(client) {
                entry.receiver = None;
                if entry.state == State::Ready {
                    entry.state = State::Accepted;
                }
            }
        }
        None
    }

    /// Подтвердить гостя. Возвращает его номер соединения (для LAN) и слот.
    /// Для облачного гостя номера нет: кадры уйдут через исходящую ссылку.
    pub fn accept(&self, slot: &str) -> Option<(String, Option<u64>)> {
        let slot = valid_slot(slot)?;
        let mut inner = self.lock();
        let entry = inner.slots.get_mut(slot)?;
        let client = entry.client;
        if entry.state != State::Waiting {
            return None;
        }
        entry.state = if entry.receiver.is_some() {
            State::Ready
        } else {
            State::Accepted
        };
        Some((slot.to_string(), client))
    }

    /// Отклонить или отозвать приглашение. Возвращает номер гостя (если LAN),
    /// которому нужно сообщить об отказе.
    pub fn decline(&self, slot: &str) -> Option<(String, Option<u64>)> {
        let slot = valid_slot(slot)?;
        let mut inner = self.lock();
        let entry = inner.slots.get_mut(slot)?;
        let client = entry.client;
        entry.client = None;
        entry.pending = false;
        entry.pending_at = None;
        // Подписка виджета остаётся: он всё ещё на слоте и готов принять
        // следующего гостя без перезагрузки оверлея.
        entry.guest_name.clear();
        entry.token.clear();
        entry.state = State::Free;
        Some((slot.to_string(), client))
    }

    /// Виджет хоста готов принимать поток. Возвращает гостя, которому нужно
    /// послать `guest_receiver_ready` (номер есть только у LAN-гостя).
    pub fn subscribe(&self, slot: &str, client: u64) -> Option<(String, Option<u64>, bool)> {
        let slot = valid_slot(slot)?;
        let mut inner = self.lock();
        let entry = inner.slots.get_mut(slot)?;
        let previous = entry.receiver;
        entry.receiver = Some(client);
        // Повторная подписка того же окна приходит на каждый снимок состояния
        // и не должна перезапускать поток. Готовность нужна, когда приёмник
        // только появился или сменился (перезагрузка OBS, новый клиент).
        let ready = entry.state == State::Accepted
            || (entry.state == State::Ready && previous != Some(client));
        if entry.state == State::Accepted {
            entry.state = State::Ready;
        }
        let guest = entry.client;
        Some((slot.to_string(), guest, ready))
    }

    /// Отписать приёмник при размонтировании виджета.
    pub fn unsubscribe(&self, client: u64) {
        let mut inner = self.lock();
        for entry in inner.slots.values_mut() {
            if entry.receiver == Some(client) {
                entry.receiver = None;
                if entry.state == State::Ready {
                    entry.state = State::Accepted;
                }
            }
        }
    }

    /// Номер входящего гостя, готового принимать сигналы (хост -> гость).
    /// Отправляет вызывающий: реестр клиентов здесь не хранится, иначе
    /// модуль пришлось бы связывать с шиной.
    pub fn guest_client(&self, slot: &str) -> Option<u64> {
        let slot = valid_slot(slot)?;
        let inner = self.lock();
        inner.slots.get(slot).and_then(|entry| {
            if entry.state == State::Ready {
                entry.client
            } else {
                None
            }
        })
    }

    /// Отправить кадр исходящему соединению (гость -> хост), если оно
    /// относится к этому слоту.
    pub fn send_outgoing_for(&self, slot: &str, frame: &str) -> bool {
        let inner = self.lock();
        match &inner.outgoing {
            Some(outgoing) if outgoing.slot == slot => outgoing.tx.send(frame.to_string()).is_ok(),
            _ => false,
        }
    }

    /// Отправить кадр хост-ссылке публичного signaling.
    pub fn send_cloud(&self, slot: &str, frame: &str) -> bool {
        let inner = self.lock();
        match inner.cloud.get(slot) {
            Some(link) => link.tx.send(frame.to_string()).is_ok(),
            None => false,
        }
    }

    /// Куда отправить кадр, адресованный гостю: входящему LAN-клиенту или
    /// исходящей облачной ссылке. `false` — гостя нет.
    pub fn send_to_guest(&self, slot: &str, frame: &str, clients: &ClientRegistry) -> bool {
        let client = {
            let inner = self.lock();
            // Номер есть только у LAN-гостя; для облачного останется None.
            inner.slots.get(slot).and_then(|entry| entry.client)
        };
        if let Some(client) = client {
            return clients.send_text(client, frame);
        }
        self.send_cloud(slot, frame)
    }

    /// Сигнал от локального окна: хост отдаёт его гостю, гость — хосту.
    pub fn send_local_signal(&self, slot: &str, frame: &str, clients: &ClientRegistry) -> bool {
        let guest = {
            let inner = self.lock();
            inner
                .slots
                .get(slot)
                .filter(|entry| entry.state == State::Ready)
                .and_then(|entry| entry.client)
        };
        if let Some(client) = guest {
            return clients.send_text(client, frame);
        }
        if self.send_outgoing_for(slot, frame) {
            return true;
        }
        self.send_cloud(slot, frame)
    }

    fn has_cloud(&self, slot: &str, generation: u64) -> bool {
        let inner = self.lock();
        inner
            .cloud
            .get(slot)
            .is_some_and(|link| link.generation == generation)
    }

    /// Закрыть хост-ссылку к signaling (revoke/decline или новое приглашение).
    pub fn remove_cloud(&self, slot: &str) -> bool {
        let link = {
            let mut inner = self.lock();
            inner.cloud.remove(slot)
        };
        match link {
            Some(link) => {
                // Будим задачу, чтобы она вышла из select и закрыла сокет.
                let _ = link.tx.send("__close__".to_string());
                true
            }
            None => false,
        }
    }

    /// `Some(true)` — сессия уже подтверждена, `Some(false)` — нужен запрос
    /// подтверждения, `None` — слот свободен (приглашение истекло), впускать
    /// некого.
    fn cloud_peer_joined(&self, slot: &str, name: &str) -> Option<bool> {
        let slot = valid_slot(slot)?;
        let mut inner = self.lock();
        let entry = inner.slots.get_mut(slot)?;
        if entry.state == State::Free {
            return None;
        }
        // Если сессия уже установлена, повторный peer_joined после
        // переподключения signaling не должен сбрасывать её в ожидание.
        if entry.state == State::Ready {
            return Some(true);
        }
        entry.state = State::Waiting;
        entry.guest_name = clean_name(name);
        Some(false)
    }

    fn cloud_peer_left(&self, slot: &str) {
        let Some(slot) = valid_slot(slot) else {
            return;
        };
        let mut inner = self.lock();
        if let Some(entry) = inner.slots.get_mut(slot) {
            entry.client = None;
            entry.guest_name.clear();
            entry.pending = false;
            entry.pending_at = None;
            entry.state = State::Open;
        }
    }

    /// Принять сигнал от входящего гостя: он уходит подписанному приёмнику.
    pub fn receiver_client(&self, slot: &str) -> Option<u64> {
        let slot = valid_slot(slot)?;
        let inner = self.lock();
        inner.slots.get(slot).and_then(|entry| {
            if entry.state == State::Ready {
                entry.receiver
            } else {
                None
            }
        })
    }

    /// Имя, которое сообщил подключившийся гость.
    pub fn guest_name(&self, slot: &str) -> String {
        let Some(slot) = valid_slot(slot) else {
            return String::new();
        };
        let inner = self.lock();
        inner
            .slots
            .get(slot)
            .map(|entry| entry.guest_name.clone())
            .unwrap_or_default()
    }

    /// Подключиться к серверу хоста в локальной сети (сторона гостя).
    pub fn join(
        self: &Arc<Self>,
        clients: Arc<ClientRegistry>,
        host: &str,
        port: u16,
        slot: &str,
        token: &str,
        guest_name: &str,
    ) -> bool {
        let Some(slot) = valid_slot(slot) else {
            return false;
        };
        // Адрес и токен приходят из разобранного приглашения, но проверяем
        // ещё раз: строка собирается в URL, и посторонние символы не должны
        // дописывать собственные query-параметры.
        let host_ok = !host.is_empty()
            && host.len() <= 253
            && host
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-');
        if !host_ok || port == 0 || !valid_token(token) {
            return false;
        }
        let url = format!(
            "ws://{host}:{port}/ws?role=guest&slot={slot}&token={token}&name={}",
            encode_query(guest_name)
        );
        self.start_outgoing(clients, slot, url)
    }

    /// Подключиться через публичный signaling (сторона гостя).
    pub fn join_cloud(
        self: &Arc<Self>,
        clients: Arc<ClientRegistry>,
        signal: &str,
        room: &str,
        token: &str,
        slot: &str,
        guest_name: &str,
    ) -> bool {
        let Some(slot) = valid_slot(slot) else {
            return false;
        };
        let Some(signal) = valid_signal(signal) else {
            return false;
        };
        if !valid_room(room) || !valid_token(token) {
            return false;
        }
        let url = format!(
            "{signal}/ws?role=guest&room={room}&token={token}&name={}",
            encode_query(guest_name)
        );
        self.start_outgoing(clients, slot, url)
    }

    fn start_outgoing(
        self: &Arc<Self>,
        clients: Arc<ClientRegistry>,
        slot: &'static str,
        url: String,
    ) -> bool {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = mpsc::unbounded_channel::<String>();
        {
            let mut inner = self.lock();
            inner.outgoing = Some(Outgoing {
                slot: slot.to_string(),
                generation,
                tx,
            });
        }
        guest_link_loop(Arc::clone(self), clients, slot, generation, url, rx);
        true
    }

    fn outgoing_is(&self, slot: &str, generation: u64) -> bool {
        let inner = self.lock();
        inner
            .outgoing
            .as_ref()
            .is_some_and(|outgoing| outgoing.slot == slot && outgoing.generation == generation)
    }

    /// Закрыть исходящее соединение по просьбе панели.
    pub fn leave(&self) -> Option<String> {
        let mut inner = self.lock();
        let outgoing = inner.outgoing.take()?;
        Some(outgoing.slot)
    }

    fn clear_outgoing(&self, slot: &str, generation: u64) -> bool {
        let mut inner = self.lock();
        if inner
            .outgoing
            .as_ref()
            .is_some_and(|outgoing| outgoing.slot == slot && outgoing.generation == generation)
        {
            inner.outgoing = None;
            return true;
        }
        false
    }

    fn clear_cloud(&self, slot: &str, generation: u64) -> bool {
        let mut inner = self.lock();
        if inner
            .cloud
            .get(slot)
            .is_some_and(|link| link.generation == generation)
        {
            inner.cloud.remove(slot);
            return true;
        }
        false
    }

    fn broadcast_outgoing(
        &self,
        clients: &ClientRegistry,
        slot: &str,
        kind: &str,
        reason: Option<&str>,
    ) {
        let mut payload = json!({ "slot": slot });
        if let Some(reason) = reason {
            payload["reason"] = Value::from(reason);
        }
        let frame = json!({ "type": kind, "payload": payload }).to_string();
        clients.broadcast_text_to_role("control", &frame);
    }

    /// Снимок для панели и оверлея.
    pub fn snapshot(&self) -> Value {
        let mut inner = self.lock();
        let now = Instant::now();
        let mut expired_cloud: Vec<&'static str> = Vec::new();
        // Список облачных слотов снимаем заранее: замок `MutexGuard`
        // не даёт одновременно менять `slots` и читать `cloud`.
        let cloud_slots: Vec<&'static str> = inner.cloud.keys().copied().collect();
        for (slot, entry) in inner.slots.iter_mut() {
            if entry.expired(now) {
                entry.token.clear();
                entry.state = State::Free;
                if cloud_slots.contains(slot) {
                    expired_cloud.push(*slot);
                }
            }
            // Upgrade так и не завершился: снимаем резерв, чтобы слот не
            // остался занятым после оборвавшегося соединения.
            if entry.pending
                && entry
                    .pending_at
                    .is_some_and(|at| now.duration_since(at) > PENDING_TIMEOUT)
            {
                entry.pending = false;
                entry.pending_at = None;
                entry.state = State::Open;
                entry.guest_name.clear();
            }
        }
        let slots: Vec<Value> = GUEST_SLOTS
            .iter()
            .filter_map(|slot| inner.slots.get(slot).map(|entry| (*slot, entry)))
            .map(|(slot, entry)| {
                json!({
                    "slot": slot,
                    "name": entry.name,
                    "state": entry.state_name(),
                    "guest": entry.guest_name,
                })
            })
            .collect();
        let payload = json!({
            "slots": slots,
            "outgoing": inner.outgoing.as_ref().map(|outgoing| json!({
                "slot": outgoing.slot,
            })),
        });
        drop(inner);
        // Истёкшее облачное приглашение больше не должно держать комнату.
        for slot in expired_cloud {
            self.remove_cloud(slot);
        }
        payload
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Сокет signaling после завершения upgrade.
type SignalingSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/*
  Подключение к signaling с предпочтением IPv4.

  `connect_async` берёт первый адрес из системного резолвера. На Windows это
  обычно IPv6, а у части провайдеров маршрут до Cloudflare по IPv6 обрывается
  на TLS: TCP открывается, рукопожатие — нет. IPv4 при этом жив, поэтому адреса
  перебираем сами, IPv4 раньше IPv6. Таймаут на адрес короткий: зависший SYN
  не должен съедать весь бюджет подключения у вызывающей стороны.
*/
async fn connect_signaling(url: &str) -> Result<SignalingSocket, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let request = url
        .into_client_request()
        .map_err(|error| error.to_string())?;
    let uri = request.uri().clone();
    let host = uri
        .host()
        .ok_or_else(|| "адрес без хоста".to_string())?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let secure = uri.scheme_str() == Some("wss");
    let port = uri.port_u16().unwrap_or(if secure { 443 } else { 80 });

    let addrs = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|error| error.to_string())?;
    let addrs = ipv4_first(addrs.collect());

    let connector = if secure {
        let tls = native_tls::TlsConnector::new().map_err(|error| error.to_string())?;
        Some(tokio_tungstenite::Connector::NativeTls(tls))
    } else {
        None
    };

    let mut last_error = "адрес не разрешён".to_string();
    for addr in addrs {
        let connected =
            tokio::time::timeout(Duration::from_secs(3), tokio::net::TcpStream::connect(addr))
                .await;
        let tcp = match connected {
            Ok(Ok(tcp)) => tcp,
            Ok(Err(error)) => {
                last_error = format!("{addr}: {error}");
                continue;
            }
            Err(_) => {
                last_error = format!("{addr}: таймаут");
                continue;
            }
        };
        match tokio_tungstenite::client_async_tls_with_config(
            request.clone(),
            tcp,
            None,
            connector.clone(),
        )
        .await
        {
            Ok((socket, _)) => return Ok(socket),
            Err(error) => last_error = format!("{addr}: {error}"),
        }
    }
    Err(last_error)
}

/// Резолвер отдаёт адреса в порядке системы; IPv6 уводим в конец.
fn ipv4_first(mut addrs: Vec<std::net::SocketAddr>) -> Vec<std::net::SocketAddr> {
    addrs.sort_by_key(|addr| addr.is_ipv6());
    addrs
}

/// Гостевая ссылка (LAN или облако) с переподключением.
///
/// Панель может отменить соединение в любой момент: `rx` закрывается, и
/// задача выходит, не трогая новый слот. Пять неудачных попыток подряд —
/// сигнал панели, что хост недоступен, а не бесконечное «подключение».
fn guest_link_loop(
    hub: Arc<GuestHub>,
    clients: Arc<ClientRegistry>,
    slot: &'static str,
    generation: u64,
    url: String,
    mut rx: mpsc::UnboundedReceiver<String>,
) {
    tauri::async_runtime::spawn(async move {
        let mut failures = 0u32;
        loop {
            if !hub.outgoing_is(slot, generation) {
                break;
            }
            let connected =
                tokio::time::timeout(Duration::from_secs(10), connect_signaling(&url)).await;
            let Ok(Ok(socket)) = connected else {
                failures += 1;
                if failures >= 5 {
                    hub.clear_outgoing(slot, generation);
                    hub.broadcast_outgoing(
                        &clients,
                        slot,
                        event_types::GUEST_DECLINED,
                        Some("signaling-unreachable"),
                    );
                    return;
                }
                sleep(Duration::from_secs(2)).await;
                continue;
            };
            failures = 0;
            let (mut write, mut read) = socket.split();
            let mut declined = false;
            loop {
                tokio::select! {
                    incoming = read.next() => match incoming {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                            let kind = serde_json::from_str::<Value>(text.as_str())
                                .ok()
                                .and_then(|value| {
                                    value.get("type").and_then(Value::as_str).map(str::to_string)
                                });
                            // Служебные кадры signaling панели не нужны.
                            if matches!(kind.as_deref(), Some("joined") | Some("peer_joined") | Some("peer_left")) {
                                continue;
                            }
                            if let Some(forwarded) = forward_guest_frame(text.as_str()) {
                                clients.broadcast_text_to_role("control", &forwarded);
                            }
                            if kind.as_deref() == Some(event_types::GUEST_DECLINED) {
                                declined = true;
                                break;
                            }
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => break,
                        Some(Err(_)) => break,
                        _ => {}
                    },
                    outgoing = rx.recv() => match outgoing {
                        Some(frame) => {
                            if write
                                .send(tokio_tungstenite::tungstenite::Message::Text(frame.into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        None => {
                            hub.clear_outgoing(slot, generation);
                            return;
                        }
                    }
                }
            }
            if declined {
                hub.clear_outgoing(slot, generation);
                return;
            }
            if !hub.outgoing_is(slot, generation) {
                return;
            }
            failures += 1;
            if failures >= 5 {
                hub.clear_outgoing(slot, generation);
                hub.broadcast_outgoing(
                    &clients,
                    slot,
                    event_types::GUEST_DECLINED,
                    Some("signaling-unreachable"),
                );
                return;
            }
            sleep(Duration::from_secs(2)).await;
        }
    });
}

/// Хост-ссылка к публичному signaling: пока слот жив, соединение
/// переподнимается после обрыва.
fn cloud_link_loop(
    hub: Arc<GuestHub>,
    clients: Arc<ClientRegistry>,
    slot: &'static str,
    generation: u64,
    url: String,
    mut rx: mpsc::UnboundedReceiver<String>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            if !hub.has_cloud(slot, generation) {
                break;
            }
            let connected =
                tokio::time::timeout(Duration::from_secs(10), connect_signaling(&url)).await;
            let Ok(Ok(socket)) = connected else {
                sleep(Duration::from_secs(2)).await;
                continue;
            };
            let (mut write, mut read) = socket.split();
            loop {
                tokio::select! {
                    incoming = read.next() => match incoming {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                            if text.as_str() == "__close__" {
                                hub.clear_cloud(slot, generation);
                                return;
                            }
                            handle_cloud_host_frame(&hub, &clients, slot, text.as_str());
                        }
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => break,
                        Some(Err(_)) => break,
                        _ => {}
                    },
                    outgoing = rx.recv() => match outgoing {
                        Some(frame) if frame == "__close__" => {
                            hub.clear_cloud(slot, generation);
                            return;
                        }
                        Some(frame) => {
                            if write
                                .send(tokio_tungstenite::tungstenite::Message::Text(frame.into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        None => {
                            hub.clear_cloud(slot, generation);
                            return;
                        }
                    }
                }
            }
            if !hub.has_cloud(slot, generation) {
                break;
            }
            // Signaling потерян, но медиа может идти: не гасим виджет,
            // просто переподнимаем служебное соединение.
            sleep(Duration::from_secs(2)).await;
        }
    });
}

fn handle_cloud_host_frame(hub: &GuestHub, clients: &ClientRegistry, slot: &str, raw: &str) {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "peer_joined" => {
            let name = value
                .get("payload")
                .and_then(|payload| payload.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let joined = hub.cloud_peer_joined(slot, name);
            broadcast_hub_status(hub, clients);
            match joined {
                Some(true) => {
                    // Гость вернулся после обрыва signaling: сессия уже
                    // подтверждена, просим его заново прислать offer.
                    let frame = json!({
                        "type": event_types::GUEST_RECEIVER_READY,
                        "payload": { "slot": slot },
                    })
                    .to_string();
                    hub.send_to_guest(slot, &frame, clients);
                }
                Some(false) => {
                    let frame = json!({
                        "type": event_types::GUEST_JOIN_REQUEST,
                        "payload": { "slot": slot, "name": name },
                    })
                    .to_string();
                    clients.broadcast_text_to_role("control", &frame);
                }
                None => {
                    // Приглашение уже истекло: гостю нечего здесь делать.
                    let frame = json!({
                        "type": event_types::GUEST_DECLINED,
                        "payload": { "slot": slot },
                    })
                    .to_string();
                    hub.send_to_guest(slot, &frame, clients);
                }
            }
        }
        "peer_left" => {
            hub.cloud_peer_left(slot);
            broadcast_hub_status(hub, clients);
            broadcast_guest_left(clients, slot);
        }
        event_types::GUEST_SIGNAL => {
            if let Some(receiver) = hub.receiver_client(slot) {
                clients.send_text(receiver, raw);
            }
        }
        _ => {}
    }
}

fn broadcast_hub_status(hub: &GuestHub, clients: &ClientRegistry) {
    let frame = json!({
        "type": event_types::GUEST_STATUS,
        "payload": hub.snapshot(),
    })
    .to_string();
    clients.broadcast_text(&frame);
}

fn broadcast_guest_left(clients: &ClientRegistry, slot: &str) {
    let frame = json!({
        "type": event_types::GUEST_LEFT,
        "payload": { "slot": slot },
    })
    .to_string();
    clients.broadcast_text(&frame);
}

/// Снимок слотов для панели: состояние и адрес signaling (чтобы поле в
/// настройках было заполнено даже после перезапуска).
pub fn status_payload(diagnostics: &crate::diagnostics::Diagnostics) -> Value {
    let mut payload = diagnostics.guests().snapshot();
    payload["signalUrl"] = Value::from(diagnostics.guest_signal_url());
    payload
}

/// Разослать снимок слотов всем локальным окнам.
pub fn broadcast_status(diagnostics: &crate::diagnostics::Diagnostics) {
    let text = json!({
        "type": event_types::GUEST_STATUS,
        "payload": status_payload(diagnostics),
    })
    .to_string();
    diagnostics.clients().broadcast_text(&text);
}

/// Событие только панели управления: запрос подтверждения и приглашение не
/// должны шуметь в оверлее.
pub fn broadcast_control(
    diagnostics: &crate::diagnostics::Diagnostics,
    kind: &str,
    payload: Value,
) {
    let text = json!({ "type": kind, "payload": payload }).to_string();
    diagnostics
        .clients()
        .broadcast_text_to_role("control", &text);
}

/// Токен/идентификатор комнаты: тот же алфавит, что у кодов доступа.
fn valid_token(value: &str) -> bool {
    (16..=64).contains(&value.len())
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn valid_room(value: &str) -> bool {
    valid_token(value)
}

/// Адрес signaling: `ws://` или `wss://`, без query и якоря.
fn valid_signal(value: &str) -> Option<String> {
    let signal = value.trim().trim_end_matches('/');
    let rest = signal
        .strip_prefix("wss://")
        .or_else(|| signal.strip_prefix("ws://"))?;
    if rest.is_empty()
        || signal.len() > 200
        || rest.contains(['?', '#', ' '])
        || !rest.chars().all(|ch| ch.is_ascii_graphic())
    {
        return None;
    }
    Some(signal.to_string())
}

/// Слот в допустимом виде: только известные идентификаторы.
pub fn valid_slot(value: &str) -> Option<&'static str> {
    GUEST_SLOTS
        .iter()
        .find(|slot| **slot == value.trim())
        .copied()
}

/// Оставить от имени только безопасный текст.
fn clean_name(value: &str) -> String {
    value.trim().chars().take(MAX_NAME_LEN).collect()
}

/// Процентное кодирование для имени в query: имя может быть кириллицей.
fn encode_query(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Проверить и переслать кадр от хоста гостю. Всё, что не относится к
/// signaling, отбрасывается: удалённая сторона не должна уметь присылать
/// команды или состояние.
fn forward_guest_frame(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let kind = value.get("type").and_then(Value::as_str)?;
    if !matches!(
        kind,
        event_types::GUEST_ACCEPTED
            | event_types::GUEST_DECLINED
            | event_types::GUEST_LEFT
            | event_types::GUEST_RECEIVER_READY
            | event_types::GUEST_SIGNAL
    ) {
        return None;
    }
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub() -> GuestHub {
        GuestHub::new()
    }

    fn invite(hub: &GuestHub, slot: &str) -> String {
        let value = hub.create(slot, "Слот").expect("приглашение");
        value["token"].as_str().unwrap().to_string()
    }

    #[test]
    fn an_invite_opens_once_and_accepts_only_after_binding() {
        let hub = hub();
        let token = invite(&hub, "cam2");
        assert!(hub.open("cam2", &token, "Аня"));
        // Второй гость по тому же приглашению не пройдёт.
        assert!(!hub.open("cam2", &token, "Боря"));
        assert!(hub.bind("cam2", 7));
        assert!(hub.accept("cam2").is_some());
    }

    #[test]
    fn the_wrong_token_and_unknown_slot_are_rejected() {
        let hub = hub();
        let token = invite(&hub, "cam3");
        assert!(!hub.open("cam3", "00000000000000000000000000000000", "Аня"));
        assert!(!hub.open("cam9", &token, "Аня"));
        assert!(!hub.open("cam3", "short", "Аня"));
    }

    #[test]
    fn accept_transitions_to_ready_after_the_receiver_subscribes() {
        let hub = hub();
        let token = invite(&hub, "cam2");
        assert!(hub.open("cam2", &token, "Аня"));
        assert!(hub.bind("cam2", 11));
        let (slot, guest) = hub.accept("cam2").expect("подтверждение");
        assert_eq!(slot, "cam2");
        assert_eq!(guest, Some(11));
        assert_eq!(hub.snapshot()["slots"][0]["state"], json!("accepted"));

        let (slot, guest, ready) = hub.subscribe("cam2", 21).expect("подписка");
        assert_eq!(slot, "cam2");
        assert_eq!(guest, Some(11));
        assert!(ready);
        assert_eq!(hub.receiver_client("cam2"), Some(21));
        assert_eq!(hub.guest_client("cam2"), Some(11));
        assert_eq!(hub.snapshot()["slots"][0]["state"], json!("connected"));
    }

    #[test]
    fn a_widget_subscribed_before_the_invite_stays_the_receiver() {
        let hub = hub();
        // Оверлей открыт раньше приглашения: виджет подписался на пустой слот.
        let (_, _, ready) = hub.subscribe("cam2", 21).expect("подписка");
        assert!(!ready);

        let token = invite(&hub, "cam2");
        assert!(hub.open("cam2", &token, "Аня"));
        assert!(hub.bind("cam2", 11));
        assert!(hub.accept("cam2").is_some());
        // Подписка пережила создание приглашения — иначе готовый виджет молчал бы.
        assert_eq!(hub.receiver_client("cam2"), Some(21));
        assert_eq!(hub.snapshot()["slots"][0]["state"], json!("connected"));
    }

    #[test]
    fn a_reconnecting_guest_does_not_lose_the_receiver() {
        let hub = hub();
        hub.subscribe("cam2", 21);
        let token = invite(&hub, "cam2");
        assert!(hub.open("cam2", &token, "Аня"));
        assert!(hub.bind("cam2", 11));
        assert!(hub.accept("cam2").is_some());

        // Гость оборвался и вернулся по той же ссылке.
        assert_eq!(hub.unbind(11), Some("cam2".to_string()));
        assert!(hub.open("cam2", &token, "Аня"));
        assert!(hub.bind("cam2", 12));
        assert!(hub.accept("cam2").is_some());
        assert_eq!(hub.receiver_client("cam2"), Some(21));
    }

    #[test]
    fn a_declined_guest_leaves_the_widget_subscribed() {
        let hub = hub();
        hub.subscribe("cam2", 21);
        let token = invite(&hub, "cam2");
        assert!(hub.open("cam2", &token, "Аня"));
        assert!(hub.bind("cam2", 11));
        assert_eq!(hub.decline("cam2"), Some(("cam2".to_string(), Some(11))));

        // Новое приглашение на тот же слот: виджет перезагружать не нужно.
        let token = invite(&hub, "cam2");
        assert!(hub.open("cam2", &token, "Боря"));
        assert!(hub.bind("cam2", 12));
        assert!(hub.accept("cam2").is_some());
        assert_eq!(hub.receiver_client("cam2"), Some(21));
    }

    #[test]
    fn a_new_receiver_restarts_the_stream_and_the_same_one_does_not() {
        let hub = hub();
        let token = invite(&hub, "cam2");
        assert!(hub.open("cam2", &token, "Аня"));
        assert!(hub.bind("cam2", 11));
        assert!(hub.accept("cam2").is_some());

        let (_, _, ready) = hub.subscribe("cam2", 21).expect("подписка");
        assert!(ready);
        // Каждый снимок состояния повторяет подписку того же окна — поток не перезапускается.
        let (_, _, ready) = hub.subscribe("cam2", 21).expect("повторная подписка");
        assert!(!ready);
        // Оверлей перезагрузили: у нового приёмника свой номер клиента.
        let (_, _, ready) = hub.subscribe("cam2", 22).expect("новый приёмник");
        assert!(ready);
        assert_eq!(hub.receiver_client("cam2"), Some(22));
    }

    #[test]
    fn guest_signal_is_rejected_before_acceptance() {
        let hub = hub();
        let token = invite(&hub, "cam2");
        assert!(hub.open("cam2", &token, "Аня"));
        assert!(hub.bind("cam2", 11));
        assert_eq!(hub.guest_client("cam2"), None);
        assert_eq!(hub.receiver_client("cam2"), None);
    }

    #[test]
    fn a_disconnected_guest_frees_the_slot_and_allows_reconnect_until_ttl() {
        let hub = hub();
        let token = invite(&hub, "cam2");
        assert!(hub.open("cam2", &token, "Аня"));
        assert!(hub.bind("cam2", 11));
        assert_eq!(hub.unbind(11), Some("cam2".to_string()));
        assert_eq!(hub.snapshot()["slots"][0]["state"], json!("open"));
        // Ссылка ещё жива: гость может вернуться после обрыва.
        assert!(hub.open("cam2", &token, "Аня"));
    }

    #[test]
    fn decline_reports_the_guest_and_clears_the_slot() {
        let hub = hub();
        let token = invite(&hub, "cam4");
        assert!(hub.open("cam4", &token, "Аня"));
        assert!(hub.bind("cam4", 31));
        assert_eq!(hub.decline("cam4"), Some(("cam4".to_string(), Some(31))));
        assert_eq!(hub.snapshot()["slots"][2]["state"], json!("free"));
    }

    #[test]
    fn signaling_urls_are_checked() {
        assert_eq!(
            valid_signal("wss://signal.ose-overlay.ru/"),
            Some("wss://signal.ose-overlay.ru".to_string())
        );
        assert_eq!(
            valid_signal("ws://127.0.0.1:8787"),
            Some("ws://127.0.0.1:8787".to_string())
        );
        assert_eq!(valid_signal("https://signal.ose-overlay.ru"), None);
        assert_eq!(valid_signal("wss://signal.ose-overlay.ru?x=1"), None);
        assert!(valid_room("a1b2c3d4e5f60718"));
        assert!(!valid_room("short"));
    }

    #[test]
    fn signaling_addresses_prefer_ipv4() {
        let v4: std::net::SocketAddr = "104.21.58.161:443".parse().unwrap();
        let v6: std::net::SocketAddr = "[2606:4700::1]:443".parse().unwrap();
        // Резолвер может вернуть IPv6 первым — тогда TLS у части провайдеров
        // не поднимается, хотя IPv4 отвечает.
        assert_eq!(ipv4_first(vec![v6, v4]), vec![v4, v6]);
        assert_eq!(ipv4_first(vec![v4, v6]), vec![v4, v6]);
        assert_eq!(ipv4_first(vec![v6]), vec![v6]);
    }

    #[test]
    fn only_signaling_frames_come_back_from_the_host() {
        let signal = json!({"type": "guest_signal", "payload": {"slot": "cam2"}}).to_string();
        assert_eq!(
            forward_guest_frame(&signal).as_deref(),
            Some(signal.as_str())
        );
        // Команды и произвольные кадры от удалённой стороны не принимаются.
        assert!(forward_guest_frame(&json!({"type": "cmd_add_widget"}).to_string()).is_none());
        assert!(forward_guest_frame("junk").is_none());
    }

    #[test]
    fn unsubscribe_keeps_the_guest_but_returns_to_accepted() {
        let hub = hub();
        let token = invite(&hub, "cam2");
        assert!(hub.open("cam2", &token, "Аня"));
        assert!(hub.bind("cam2", 11));
        assert!(hub.accept("cam2").is_some());
        assert!(hub.subscribe("cam2", 21).is_some());
        assert_eq!(hub.snapshot()["slots"][0]["state"], json!("connected"));
        hub.unsubscribe(21);
        assert_eq!(hub.snapshot()["slots"][0]["state"], json!("accepted"));
        assert_eq!(hub.receiver_client("cam2"), None);
    }
}
