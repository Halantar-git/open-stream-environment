//! Шина: реестр подключённых к `/ws` клиентов, рассылка и счётчики доступа.
//!
//! Порт той части `server/index.js`, где `wss.clients` используется для рассылки
//! (`broadcast`, `broadcastMicFrame`) и для отчёта о состоянии (`byRole`).
//!
//! Отличие от JS одно и то же: там клиент — это объект `ws` с полями `role` и
//! `external`, здесь — запись реестра с каналом отправки. Само соединение живёт
//! в своей задаче (см. `server/mod.rs`), а реестр только помнит, кому и что
//! послать: так рассылка не может «застрять» на медленном клиенте и держать
//! остальных.
//!
//! Отправка в закрытый канал не считается ошибкой: клиент мог отключиться, а
//! запись о нём исчезнет по закрытию соединения.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use axum::extract::ws::Message;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

/// Номер соединения — уникален, пока живёт процесс.
pub type ClientId = u64;

/// Клиент шины.
struct Client {
    id: ClientId,
    role: String,
    /// Пришёл из сети, а не с этой машины.
    external: bool,
    sender: mpsc::UnboundedSender<Message>,
}

#[derive(Default)]
struct Registry {
    next_id: ClientId,
    /// Порядок подключения: по нему же строится `byRole`.
    clients: Vec<Client>,
}

/// Подключённые клиенты. Внутреннее состояние — под замком, наружу — только
/// снимки и рассылка.
pub struct ClientRegistry {
    inner: Mutex<Registry>,
}

impl Default for ClientRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ClientRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Registry::default()),
        }
    }

    /// Зарегистрировать клиента, вернув его номер.
    pub fn add(
        &self,
        role: String,
        external: bool,
        sender: mpsc::UnboundedSender<Message>,
    ) -> ClientId {
        let mut registry = self.lock();
        registry.next_id += 1;
        let id = registry.next_id;
        registry.clients.push(Client {
            id,
            role,
            external,
            sender,
        });
        id
    }

    /// Убрать клиента по номеру; `None` — его уже нет.
    pub fn remove(&self, id: ClientId) -> Option<String> {
        let mut registry = self.lock();
        let index = registry.clients.iter().position(|client| client.id == id)?;
        Some(registry.clients.remove(index).role)
    }

    pub fn len(&self) -> usize {
        self.lock().clients.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Отключить всех внешних клиентов (смена кода доступа): их соединения
    /// закрываются, потому что вместе с записью пропадает отправитель.
    pub fn remove_external(&self) -> usize {
        let mut registry = self.lock();
        let before = registry.clients.len();
        registry.clients.retain(|client| !client.external);
        before - registry.clients.len()
    }

    /// Отключить всех клиентов — при смене порта на ходу.
    ///
    /// Соединения привязаны к прежнему адресу, а панель переподключится сама
    /// (она уже знает новый порт). Запись без отправителя бесполезна, поэтому
    /// реестр очищается целиком.
    pub fn remove_all(&self) -> usize {
        let mut registry = self.lock();
        let before = registry.clients.len();
        registry.clients.clear();
        before
    }

    /// Сколько клиентов каждого вида — то, что в отчёте `byRole`.
    pub fn counts(&self) -> (usize, Map<String, Value>) {
        let registry = self.lock();
        let mut by_role: Map<String, Value> = Map::new();
        for client in &registry.clients {
            let next = by_role
                .get(&client.role)
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + 1;
            by_role.insert(client.role.clone(), json!(next));
        }
        (registry.clients.len(), by_role)
    }

    /// Пришёл ли клиент из сети: из сети нужен код доступа, свои — без него.
    pub fn is_external(&self, id: ClientId) -> Option<bool> {
        self.lock()
            .clients
            .iter()
            .find(|client| client.id == id)
            .map(|client| client.external)
    }

    /// Отправить текстовый кадр всем.
    pub fn broadcast_text(&self, text: &str) {
        let registry = self.lock();
        for client in &registry.clients {
            let _ = client.sender.send(Message::Text(text.to_string().into()));
        }
    }

    /// Отправить текстовый кадр всем клиентам одной роли.
    pub fn broadcast_text_to_role(&self, role: &str, text: &str) {
        let registry = self.lock();
        for client in &registry.clients {
            if client.role == role {
                let _ = client.sender.send(Message::Text(text.to_string().into()));
            }
        }
    }

    /// Отправить двоичный кадр всем: микрокадры идут мимо JSON.
    pub fn broadcast_binary(&self, data: Vec<u8>) {
        let registry = self.lock();
        for client in &registry.clients {
            let _ = client.sender.send(Message::Binary(data.clone().into()));
        }
    }

    /// Отправить двоичный кадр клиентам одной роли.
    ///
    /// Микрокадры уходят только оверлеям (включая HUD и превью темы — они грузят
    /// тот же `overlay.html`): панель, чат и редакторы их всё равно игнорируют.
    pub fn broadcast_binary_to_role(&self, role: &str, data: Vec<u8>) {
        let registry = self.lock();
        for client in &registry.clients {
            if client.role == role {
                let _ = client.sender.send(Message::Binary(data.clone().into()));
            }
        }
    }

    /// Отправить текстовый кадр одному клиенту; `false` — такого нет.
    pub fn send_text(&self, id: ClientId, text: &str) -> bool {
        let registry = self.lock();
        match registry.clients.iter().find(|client| client.id == id) {
            Some(client) => client
                .sender
                .send(Message::Text(text.to_string().into()))
                .is_ok(),
            None => false,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Счётчики отказов доступа за запуск.
///
/// Отдельно от журнала команд: по этим числам видно, стучится ли кто-то в порт
/// без кода (`deniedUpgrade`), ломится ли в отчёт (`deniedHttp`) и упирается ли
/// панель в ограничитель частоты (`rateLimited`).
#[derive(Default)]
pub struct AccessCounters {
    denied_upgrade: AtomicU64,
    denied_http: AtomicU64,
    rate_limited: AtomicU64,
}

impl AccessCounters {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn increment_denied_upgrade(&self) {
        self.denied_upgrade.fetch_add(1, Ordering::Relaxed);
    }

    pub fn increment_denied_http(&self) {
        self.denied_http.fetch_add(1, Ordering::Relaxed);
    }

    pub fn increment_rate_limited(&self) {
        self.rate_limited.fetch_add(1, Ordering::Relaxed);
    }

    /// Снимок в форме, которую ждёт отчёт о состоянии.
    pub fn snapshot(&self) -> Value {
        json!({
            "tokenRequired": true,
            "deniedUpgrade": self.denied_upgrade.load(Ordering::Relaxed),
            "deniedHttp": self.denied_http.load(Ordering::Relaxed),
            "rateLimited": self.rate_limited.load(Ordering::Relaxed),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::ws::Message;

    fn registry_with(
        roles: &[(&str, bool)],
    ) -> (ClientRegistry, Vec<mpsc::UnboundedReceiver<Message>>) {
        let registry = ClientRegistry::new();
        let mut receivers = Vec::new();
        for (role, external) in roles {
            let (sender, receiver) = mpsc::unbounded_channel();
            registry.add((*role).to_string(), *external, sender);
            receivers.push(receiver);
        }
        (registry, receivers)
    }

    fn text_of(message: Message) -> String {
        match message {
            Message::Text(text) => text.to_string(),
            other => panic!("ожидался текст, пришло {other:?}"),
        }
    }

    #[test]
    fn counts_group_clients_by_role_in_connection_order() {
        let (registry, _receivers) =
            registry_with(&[("overlay", false), ("control", false), ("overlay", false)]);
        let (total, by_role) = registry.counts();
        assert_eq!(total, 3);
        assert_eq!(by_role["overlay"], json!(2));
        assert_eq!(by_role["control"], json!(1));
        // Порядок ролей — по первому появлению.
        let roles: Vec<&str> = by_role.keys().map(String::as_str).collect();
        assert_eq!(roles, ["overlay", "control"]);
    }

    #[test]
    fn broadcast_reaches_everyone_and_one_role_subset() {
        let (registry, mut receivers) = registry_with(&[("overlay", false), ("control", false)]);
        registry.broadcast_text("{\"type\":\"state\"}");
        assert_eq!(
            text_of(receivers[0].try_recv().unwrap()),
            "{\"type\":\"state\"}"
        );
        assert_eq!(
            text_of(receivers[1].try_recv().unwrap()),
            "{\"type\":\"state\"}"
        );

        registry.broadcast_text_to_role("overlay", "только оверлею");
        assert_eq!(text_of(receivers[0].try_recv().unwrap()), "только оверлею");
        assert!(receivers[1].try_recv().is_err());
    }

    #[test]
    fn binary_frames_reach_only_the_overlay() {
        let (registry, mut receivers) = registry_with(&[("overlay", false), ("chat", false)]);
        registry.broadcast_binary_to_role("overlay", vec![0x4f, 0x53, 0x01]);

        match receivers[0].try_recv().unwrap() {
            Message::Binary(data) => assert_eq!(data.as_ref(), &[0x4f, 0x53, 0x01]),
            other => panic!("ожидался бинарный кадр, пришло {other:?}"),
        }
        assert!(receivers[1].try_recv().is_err());
    }

    #[test]
    fn remove_all_disconnects_everyone_on_a_port_switch() {
        let (registry, mut receivers) = registry_with(&[("overlay", false), ("control", true)]);
        assert_eq!(registry.remove_all(), 2);
        assert!(registry.is_empty());
        // Записи пропали вместе с отправителями — приёмники видят закрытие канала.
        assert!(receivers[0].try_recv().is_err());
        assert!(receivers[1].try_recv().is_err());
        assert_eq!(registry.remove_all(), 0);
    }

    #[test]
    fn removing_a_client_drops_it_from_the_counts() {
        let (registry, _receivers) = registry_with(&[("overlay", false), ("control", false)]);
        let id = 1;
        assert_eq!(registry.remove(id), Some("overlay".to_string()));
        assert_eq!(registry.remove(id), None);
        let (total, by_role) = registry.counts();
        assert_eq!(total, 1);
        assert!(by_role.get("overlay").is_none());
    }

    #[test]
    fn access_counters_only_grow() {
        let counters = AccessCounters::new();
        counters.increment_denied_upgrade();
        counters.increment_denied_upgrade();
        counters.increment_denied_http();
        counters.increment_rate_limited();
        let snapshot = counters.snapshot();
        assert_eq!(snapshot["deniedUpgrade"], json!(2));
        assert_eq!(snapshot["deniedHttp"], json!(1));
        assert_eq!(snapshot["rateLimited"], json!(1));
        assert_eq!(snapshot["tokenRequired"], json!(true));
    }
}
