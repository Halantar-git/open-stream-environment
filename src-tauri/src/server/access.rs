//! Правила доступа к локальному серверу и ограничитель частоты команд.
//!
//! Порт `server/access-control.js` вместе с проверками `roleFromUrl` и
//! `isAllowedWsOrigin` из `server/index.js`: они решают, кого пустить на шину и
//! как быстро ему можно слать команды.
//!
//! Почему отдельным модулем: это чистая логика принятия решений — «пустить или
//! нет», «принять команду или отбросить», — а проверять её через настоящие сокеты
//! неудобно и ненадёжно (адрес клиента в тесте не подменить). Решения описываются
//! функциями от адреса, заголовков и query, а сервер остаётся тонкой обвязкой.
//!
//! Модель доступа:
//!
//! * панель, оверлей в OBS, HUD и редакторы живут на этой же машине — их запросы
//!   приходят с loopback-адреса и код не спрашивают: иначе пришлось бы носить код
//!   по всем внутренним окнам и в адресе Browser Source;
//! * всё, что пришло из локальной сети (телефон, сторонние скрипты), обязано
//!   предъявить код доступа в query (`?token=…`) или заголовке `x-ose-token`;
//! * источник WebSocket проверяется отдельно ([`is_allowed_ws_origin`]) — это
//!   защита от чужой страницы в браузере, а код — от чужого устройства в сети;
//!   проверки дополняют друг друга.
//!
//! Отличие от JS: там «свой адрес» — это четыре строки из списка (`127.0.0.1`,
//! `::1` и их IPv4-в-IPv6 виды), здесь — весь диапазон loopback (`127.0.0.0/8`).
//! На практике Node и так отдаёт только `127.0.0.1`, но `127.0.0.2` — тоже эта
//! машина, и отказывать ей в праве быть «своей» незачем.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use axum::http::{header, HeaderMap};
use serde_json::Value;
use uuid::Uuid;

/// Заголовки, которыми приносят код доступа: свой и прежний (`x-ose-code`).
const TOKEN_HEADERS: [&str; 2] = ["x-ose-token", "x-ose-code"];

/// Окно ограничителя частоты по умолчанию — как в Electron-версии.
pub const DEFAULT_WINDOW_MS: u64 = 1000;

/// Сколько команд в окне пропускаем; нормальный темп панели — единицы в секунду,
/// а запас нужен, чтобы веерная правка виджетов не упиралась в лимит.
pub const DEFAULT_MAX_COMMANDS: u64 = 60;

/// Часы — подменяются в тестах, чтобы окно проверялось без ожидания.
pub type ClockFn = dyn Fn() -> i64 + Send + Sync + 'static;

/// Всё, что читают правила у входящего подключения к шине.
pub struct Incoming<'a> {
    /// Адрес, с которого пришло подключение.
    pub remote: IpAddr,
    /// Заголовки запроса: из них берутся `Origin` и код доступа.
    pub headers: &'a HeaderMap,
    /// Query-строка без `?`: из неё берутся код и роль.
    pub query: Option<&'a str>,
}

impl<'a> Incoming<'a> {
    pub fn new(remote: IpAddr, headers: &'a HeaderMap, query: Option<&'a str>) -> Self {
        Self {
            remote,
            headers,
            query,
        }
    }

    /// Пришёл ли запрос с этой же машины.
    pub fn is_loopback(&self) -> bool {
        is_loopback_addr(&self.remote)
    }

    /// Источник страницы (`Origin`), если браузер его прислал.
    ///
    /// Пустой заголовок — всё равно что его нет: так же читает JS (`!origin`).
    pub fn origin(&self) -> Option<String> {
        let value = header_text(self.headers, header::ORIGIN.as_str())?;
        (!value.is_empty()).then_some(value)
    }

    /// Код доступа, предъявленный клиентом: заголовком (удобно скриптам и
    /// мониторингу) или в query — так его несёт адрес пульта.
    pub fn presented_token(&self) -> String {
        for name in TOKEN_HEADERS {
            if let Some(value) = header_text(self.headers, name) {
                if !value.is_empty() {
                    return value;
                }
            }
        }
        query_param(self.query.unwrap_or_default(), "token").unwrap_or_default()
    }

    /// Решение по подключению к шине.
    ///
    /// `matches_token` — сравнение предъявленного кода с сохранённым (в
    /// приложении — [`tokens_match`], сравнение без раннего выхода по байтам).
    pub fn check_upgrade(
        &self,
        port: u16,
        matches_token: &dyn Fn(&str) -> bool,
    ) -> UpgradeDecision {
        let external = !self.is_loopback();
        if !is_allowed_ws_origin(self.origin().as_deref(), port) {
            return UpgradeDecision {
                ok: false,
                reason: Some(Rejection::Origin),
                external,
            };
        }
        if external && !matches_token(&self.presented_token()) {
            return UpgradeDecision {
                ok: false,
                reason: Some(Rejection::Token),
                external,
            };
        }
        UpgradeDecision {
            ok: true,
            reason: None,
            external,
        }
    }
}

/// Решение по подключению к шине.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpgradeDecision {
    pub ok: bool,
    /// Причина отказа — для внятной строки в журнале.
    pub reason: Option<Rejection>,
    /// Клиент пришёл из сети, а не с этой машины: такому нужен код доступа.
    pub external: bool,
}

/// Почему подключение отклонено.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    /// Чужая страница в браузере.
    Origin,
    /// Чужое устройство в сети без верного кода.
    Token,
}

impl Rejection {
    /// Как причина называется в журнале — те же слова, что в JS.
    pub fn as_str(self) -> &'static str {
        match self {
            Rejection::Origin => "origin",
            Rejection::Token => "token",
        }
    }
}

/// Роль клиента из query строки подключения.
///
/// Порт `roleFromUrl`: пустая роль и её отсутствие — одно и то же, поэтому
/// подстановка `?role=` не превращает клиента в «неизвестного» с пустым именем.
pub fn role_from_query(query: Option<&str>, fallback: &str) -> String {
    match query_param(query.unwrap_or_default(), "role") {
        Some(role) if !role.is_empty() => role,
        _ => fallback.to_string(),
    }
}

/// «Свой» ли адрес: loopback в любом виде, включая IPv4-в-IPv6 (двойной стек).
pub fn is_loopback_addr(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| mapped.is_loopback())
        }
    }
}

/// Разрешён ли источник страницы, открывшей WebSocket.
///
/// Браузеры не применяют к WebSocket политику одного источника, поэтому без этой
/// проверки любая открытая у стримера страница могла бы управлять шиной. Пускаем
/// только источники с этой же машины и из локальной сети; запросы без `Origin`
/// приходят не из браузера (Stream Deck, тесты) и остаются разрешёнными.
pub fn is_allowed_ws_origin(origin: Option<&str>, port: u16) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    if origin.is_empty() {
        // Пустой заголовок — то же, что отсутствие: так читает JS.
        return true;
    }
    // Окна Electron загружены из `file://` — у них источник непрозрачный.
    if origin == "file://" || origin == "null" {
        return true;
    }

    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    // Источник — это только схема, хост и порт: путь, query, якорь и учётные
    // данные браузер в него не кладёт, и видеть их здесь мы не должны.
    if rest.is_empty() || rest.contains(['/', '?', '#', '@']) {
        return false;
    }

    let (host, port_text) = split_host_port(rest);
    let Some(host) = host else {
        return false;
    };
    // Порт сравнивается именно с явно указанным: `new URL(...).port` в JS пуст,
    // если порт не написан или совпадает с портом схемы, — значит, `http://host`
    // без порта доступа не даёт.
    match port_text.and_then(|text| text.parse::<u16>().ok()) {
        Some(explicit) if explicit == port => {}
        _ => return false,
    }
    is_loopback_or_private_host(host)
}

/// Хост с этой же машины или из локальной сети.
pub fn is_loopback_or_private_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    // `new URL(...)` в JS приводит хост к нижнему регистру, поэтому сравнение
    // здесь без учёта регистра — иначе `LOCALHOST` повёл бы себя иначе, чем там.
    if host.eq_ignore_ascii_case("localhost") || host == "::1" {
        return true;
    }
    if host.starts_with("127.") {
        return true;
    }
    if host.to_ascii_lowercase().ends_with(".local") {
        return true;
    }
    // Односоставное имя (NetBIOS-имя компьютера): `DESKTOP-ABC`, `mypc`.
    if !host.contains('.') && !host.contains(':') {
        return true;
    }
    is_private_v4(host)
}

/// Частные диапазоны IPv4: `10/8`, `172.16/12`, `192.168/16`.
///
/// В отличие от JS проверяются все четыре октета: там хватало первых двух, и
/// `192.168.abc.def` (не адрес, а случайное имя) проходил за частный адрес.
pub fn is_private_v4(host: &str) -> bool {
    let mut octets = [0u8; 4];
    let mut count = 0;
    for (index, part) in host.split('.').enumerate() {
        if index >= octets.len() {
            return false;
        }
        let Ok(value) = part.parse::<u8>() else {
            return false;
        };
        octets[index] = value;
        count += 1;
    }
    if count != octets.len() {
        return false;
    }
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
}

/// Совпадает ли предъявленный код с сохранённым.
///
/// Пустой сохранённый код не совпадает ни с чем: иначе подстановка `?token=` в
/// адрес пульта открыла бы шину всей сети. Сравнение идёт без раннего выхода по
/// байтам (`crypto.timingSafeEqual` в JS), чтобы по времени ответа нельзя было
/// подбирать код посимвольно; разная длина видна сразу — так же, как в JS.
pub fn tokens_match(expected: &str, given: &str) -> bool {
    let expected = expected.as_bytes();
    let given = given.as_bytes();
    if expected.is_empty() || expected.len() != given.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in expected.iter().zip(given) {
        difference |= left ^ right;
    }
    difference == 0
}

/// Новый код доступа: 32 hex-символа — как `crypto.randomBytes(16)` в JS.
pub fn generate_remote_token() -> String {
    Uuid::new_v4().simple().to_string()
}

/// Принимаем только свой формат (16–64 символа `[A-Za-z0-9_-]`): чужой код из
/// правленого руками конфига считаем отсутствующим — как `normalizeRemoteToken`.
pub fn normalize_remote_token(value: Option<&Value>) -> String {
    let text = match value {
        Some(Value::String(text)) => text.trim(),
        _ => "",
    };
    let valid = (16..=64).contains(&text.len())
        && text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
    if valid {
        text.to_string()
    } else {
        String::new()
    }
}

/// Счётчики ограничителя частоты.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RateCounters {
    pub allowed: u64,
    pub limited: u64,
    /// Сколько раз начиналось новое окно: по этому числу видно, как долго
    /// клиент вообще работал.
    pub windows: u64,
}

/// Ограничитель частоты команд на клиента.
///
/// Зачем: команды приходят от панели по одной на действие, а самодельный скрипт
/// или зациклившийся пульт могут засыпать шину тысячами сообщений в секунду — это
/// и лаг, и мусор в журнале. Лимит с запасом к человеческому темпу, но не
/// бесконечный.
///
/// Отличие от JS: там окно клиента живёт на самом сокете и умирает вместе с ним,
/// здесь — в таблице по идентификатору клиента, поэтому отключившегося клиента
/// надо забыть явно ([`CommandLimiter::forget`]).
pub struct CommandLimiter {
    window_ms: u64,
    max: u64,
    clock: Arc<ClockFn>,
    state: Mutex<RateState>,
}

#[derive(Default)]
struct RateState {
    buckets: HashMap<u64, Bucket>,
    counters: RateCounters,
}

#[derive(Clone, Copy)]
struct Bucket {
    since: i64,
    count: u64,
}

impl CommandLimiter {
    /// `None` в любом поле — умолчание; мусорные значения тоже дают умолчание.
    pub fn new(window_ms: Option<u64>, max: Option<u64>, clock: Option<Arc<ClockFn>>) -> Self {
        Self {
            window_ms: window_ms
                .filter(|value| *value > 0)
                .unwrap_or(DEFAULT_WINDOW_MS),
            max: max
                .filter(|value| *value > 0)
                .unwrap_or(DEFAULT_MAX_COMMANDS),
            clock: clock.unwrap_or_else(|| Arc::new(|| chrono::Utc::now().timestamp_millis())),
            state: Mutex::new(RateState::default()),
        }
    }

    pub fn window_ms(&self) -> u64 {
        self.window_ms
    }

    pub fn max(&self) -> u64 {
        self.max
    }

    /// Принять команду клиента или отказать по частоте.
    pub fn allow(&self, client: u64) -> bool {
        let now = (self.clock)();
        let window = self.window_ms as i64;
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        // Разводим заимствования: счётчики и окна клиентов — разные поля.
        let RateState { buckets, counters } = &mut *state;

        // Новое окно начинается и у нового клиента, и когда прежнее истекло.
        let started = match buckets.get(&client) {
            Some(bucket) => now - bucket.since >= window,
            None => true,
        };
        if started {
            counters.windows += 1;
        }
        let bucket = buckets.entry(client).or_insert(Bucket {
            since: now,
            count: 0,
        });
        if started {
            bucket.since = now;
            bucket.count = 0;
        }

        bucket.count += 1;
        let allowed = bucket.count <= self.max;
        if allowed {
            counters.allowed += 1;
        } else {
            counters.limited += 1;
        }
        allowed
    }

    /// Забыть клиента: его окно больше не нужно.
    pub fn forget(&self, client: u64) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.buckets.remove(&client);
    }

    pub fn counters(&self) -> RateCounters {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .counters
    }
}

/// Значение заголовка как текст: нечитаемые заголовки — всё равно что их нет.
fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    let value = headers.get(name)?.to_str().ok()?;
    Some(value.to_string())
}

/// Значение параметра query — `URLSearchParams.get(name)`.
///
/// Разбираем руками, как и остальные короткие правила в проекте: нужен один
/// параметр, а не разбор URL целиком. Процентное кодирование понимаем — код
/// доступа едет в адресе пульта через `encodeURIComponent`, — иначе `%2D` в коде
/// не совпал бы с сохранённым.
fn query_param(query: &str, name: &str) -> Option<String> {
    for pair in query.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => (pair, ""),
        };
        if key == name {
            return Some(percent_decode(value));
        }
    }
    None
}

/// `%XX` → байт, `+` → пробел: как `URLSearchParams`. Непонятная
/// последовательность остаётся как есть — так же, как в JS.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Some(byte) = hex_pair(bytes[index + 1], bytes[index + 2]) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_pair(high: u8, low: u8) -> Option<u8> {
    let high = (high as char).to_digit(16)?;
    let low = (low as char).to_digit(16)?;
    Some((high * 16 + low) as u8)
}

/// Хост и порт из «хост[:порт]»: `None` в хосте — запись разобрать не удалось.
fn split_host_port(rest: &str) -> (Option<&str>, Option<&str>) {
    if let Some(inside) = rest.strip_prefix('[') {
        // IPv6 в скобках: `[::1]:8710`.
        let Some(close) = inside.find(']') else {
            return (None, None);
        };
        let host = &inside[..close];
        let tail = &inside[close + 1..];
        return match tail.strip_prefix(':') {
            Some(port) => (Some(host), Some(port)),
            None if tail.is_empty() => (Some(host), None),
            None => (None, None),
        };
    }
    match rest.split_once(':') {
        Some((host, port)) => (Some(host), Some(port)),
        None => (Some(rest), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};
    use std::sync::atomic::{AtomicI64, Ordering};

    fn remote(address: &str) -> IpAddr {
        address.parse().expect("адрес должен разбираться")
    }

    /// Query из адреса — так же, как `String(url).split("?")[1]` в JS.
    fn query_of(url: &str) -> Option<&str> {
        url.split_once('?').map(|(_, query)| query)
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                HeaderName::from_bytes(name.as_bytes()).expect("имя заголовка"),
                HeaderValue::from_str(value).expect("значение заголовка"),
            );
        }
        map
    }

    /// Запрос-заготовка: адрес, источник и URL — то, что читают правила.
    fn request(
        address: &str,
        url: &str,
        origin: Option<&str>,
    ) -> (IpAddr, HeaderMap, Option<String>) {
        let mut map = HeaderMap::new();
        if let Some(origin) = origin {
            map.insert(
                header::ORIGIN,
                HeaderValue::from_str(origin).expect("источник"),
            );
        }
        (remote(address), map, query_of(url).map(str::to_string))
    }

    /// Решение по подключению: `code` — код, сохранённый на сервере.
    fn decide(
        address: &str,
        url: &str,
        origin: Option<&str>,
        port: u16,
        code: &str,
    ) -> UpgradeDecision {
        let (remote, headers, query) = request(address, url, origin);
        Incoming::new(remote, &headers, query.as_deref())
            .check_upgrade(port, &|given: &str| tokens_match(code, given))
    }

    // ---- локальный или сетевой клиент ----

    #[test]
    fn loopback_is_recognized_in_every_shape() {
        for address in ["127.0.0.1", "::1", "::ffff:127.0.0.1"] {
            let (remote, headers, query) = request(address, "/ws?role=test", None);
            let incoming = Incoming::new(remote, &headers, query.as_deref());
            assert!(is_loopback_addr(&incoming.remote), "{address}");
            assert!(incoming.is_loopback(), "{address}");
            assert!(
                !incoming.check_upgrade(8710, &|_| false).external,
                "{address}"
            );
        }
    }

    #[test]
    fn local_network_addresses_are_not_loopback() {
        for address in [
            "192.168.1.42",
            "10.0.0.7",
            "172.16.0.1",
            "::ffff:192.168.1.42",
        ] {
            let (remote, headers, query) = request(address, "/ws?role=test", None);
            let incoming = Incoming::new(remote, &headers, query.as_deref());
            assert!(!incoming.is_loopback(), "{address}");
            assert!(
                incoming.check_upgrade(8710, &|_| false).external,
                "{address}"
            );
        }
    }

    // ---- код доступа ----

    #[test]
    fn the_token_comes_from_a_query_or_a_header() {
        let empty = headers(&[]);
        let from_query = Incoming::new(
            remote("192.168.1.5"),
            &empty,
            query_of("/ws?role=remote&token=abc"),
        );
        assert_eq!(from_query.presented_token(), "abc");

        let token_header = headers(&[("x-ose-token", "hdr")]);
        let from_header = Incoming::new(remote("192.168.1.5"), &token_header, query_of("/ws"));
        assert_eq!(from_header.presented_token(), "hdr");

        let code_header = headers(&[("x-ose-code", "legacy")]);
        let legacy = Incoming::new(remote("192.168.1.5"), &code_header, query_of("/ws"));
        assert_eq!(legacy.presented_token(), "legacy");
    }

    #[test]
    fn a_missing_token_and_a_weird_url_give_an_empty_string() {
        for url in ["/ws", "/ws?role=remote", "%", ""] {
            let empty = headers(&[]);
            let incoming = Incoming::new(remote("192.168.1.5"), &empty, query_of(url));
            assert_eq!(incoming.presented_token(), "", "{url}");
        }
    }

    #[test]
    fn a_percent_encoded_token_is_decoded() {
        let empty = headers(&[]);
        let incoming = Incoming::new(
            remote("192.168.1.5"),
            &empty,
            query_of("/ws?role=remote&token=ab%2Dcd"),
        );
        assert_eq!(incoming.presented_token(), "ab-cd");
    }

    // ---- решение по подключению к шине ----

    #[test]
    fn a_local_client_passes_without_a_code() {
        let decision = decide("127.0.0.1", "/ws?role=test", None, 8710, "secret");

        assert_eq!(
            decision,
            UpgradeDecision {
                ok: true,
                reason: None,
                external: false
            }
        );
    }

    #[test]
    fn a_network_client_without_a_code_does_not_pass() {
        let decision = decide(
            "192.168.1.5",
            "/ws?role=test",
            Some("http://192.168.1.5:8710"),
            8710,
            "secret",
        );

        assert!(!decision.ok);
        assert_eq!(decision.reason, Some(Rejection::Token));
        assert_eq!(decision.reason.map(Rejection::as_str), Some("token"));
        assert!(decision.external);
    }

    #[test]
    fn a_network_client_with_the_right_code_passes() {
        let decision = decide(
            "192.168.1.5",
            "/ws?role=remote&token=secret",
            None,
            8710,
            "secret",
        );

        assert!(decision.ok, "{decision:?}");
        assert!(decision.external);
    }

    #[test]
    fn a_network_client_with_a_wrong_code_does_not_pass() {
        let decision = decide(
            "192.168.1.5",
            "/ws?role=remote&token=guess",
            None,
            8710,
            "secret",
        );

        assert!(!decision.ok);
        assert_eq!(decision.reason, Some(Rejection::Token));
    }

    #[test]
    fn a_foreign_origin_is_cut_off_before_the_code() {
        let decision = decide(
            "192.168.1.5",
            "/ws?role=remote&token=secret",
            Some("https://evil.com"),
            8710,
            "secret",
        );

        assert!(!decision.ok);
        assert_eq!(decision.reason, Some(Rejection::Origin));
    }

    #[test]
    fn an_empty_server_code_does_not_open_the_bus() {
        // Семантика как у `state.checkRemoteToken`: пустое ожидание не совпадает
        // ни с чем, поэтому подстановка `token=` в адрес доступа не даёт.
        let decision = decide("192.168.1.5", "/ws?role=remote&token=", None, 8710, "");

        assert!(!decision.ok);
        assert_eq!(decision.reason, Some(Rejection::Token));
    }

    #[test]
    fn codes_are_compared_without_early_exit_and_never_match_when_empty() {
        assert!(tokens_match("secret", "secret"));
        assert!(!tokens_match("secret", "secreT"));
        assert!(!tokens_match("secret", "secret2"));
        assert!(!tokens_match("", ""));
        assert!(!tokens_match("", "given"));
    }

    // ---- роль клиента ----

    #[test]
    fn the_role_comes_from_the_query_and_falls_back() {
        assert_eq!(
            role_from_query(query_of("/ws?role=overlay"), "other"),
            "overlay"
        );
        assert_eq!(
            role_from_query(query_of("/ws?foo=1&role=chat"), "other"),
            "chat"
        );
        assert_eq!(role_from_query(query_of("/ws?role="), "other"), "other");
        assert_eq!(role_from_query(query_of("/ws"), "other"), "other");
        assert_eq!(role_from_query(query_of(""), "other"), "other");
        assert_eq!(role_from_query(None, "other"), "other");
        assert_eq!(role_from_query(query_of("/ws"), "scene"), "scene");
    }

    // ---- источник WebSocket ----

    #[test]
    fn a_client_without_an_origin_is_allowed() {
        assert!(is_allowed_ws_origin(None, 8710));
        assert!(is_allowed_ws_origin(Some(""), 8710));
    }

    #[test]
    fn electron_windows_from_file_are_allowed() {
        assert!(is_allowed_ws_origin(Some("file://"), 8710));
        assert!(is_allowed_ws_origin(Some("null"), 8710));
    }

    #[test]
    fn local_and_lan_origins_are_allowed() {
        for origin in [
            "http://localhost:8710",
            "http://127.0.0.1:8710",
            "http://[::1]:8710",
            "http://192.168.1.50:8710",
            "http://10.0.0.7:8710",
            "http://mypc.local:8710",
            "http://DESKTOP-ABC:8710",
            "https://localhost:8710",
        ] {
            assert!(is_allowed_ws_origin(Some(origin), 8710), "{origin}");
        }
    }

    #[test]
    fn foreign_sites_and_a_substituted_port_or_scheme_are_rejected() {
        for origin in [
            "https://evil.com",
            "http://evil.com:8710",
            "http://localhost:8711",
            "ftp://localhost:8710",
            "not a url",
            "http://192.168.abc.def:8710",
            "http://localhost:8710/path",
            "http://user@localhost:8710",
        ] {
            assert!(!is_allowed_ws_origin(Some(origin), 8710), "{origin}");
        }
    }

    // ---- ограничитель частоты ----

    fn fixed_clock() -> Arc<ClockFn> {
        Arc::new(|| 1000)
    }

    #[test]
    fn it_passes_up_to_the_limit_and_cuts_the_rest_in_the_window() {
        let limiter = CommandLimiter::new(Some(1000), Some(3), Some(fixed_clock()));

        assert_eq!(
            [1, 2, 3].map(|_| limiter.allow(7)),
            [true, true, true],
            "первые три должны пройти"
        );
        assert!(!limiter.allow(7));
        assert!(!limiter.allow(7));
        assert_eq!(
            limiter.counters(),
            RateCounters {
                allowed: 3,
                limited: 2,
                windows: 1
            }
        );
    }

    #[test]
    fn a_new_window_passes_again() {
        let now = Arc::new(AtomicI64::new(1000));
        let clock: Arc<ClockFn> = {
            let now = now.clone();
            Arc::new(move || now.load(Ordering::SeqCst))
        };
        let limiter = CommandLimiter::new(Some(1000), Some(2), Some(clock));

        assert!(limiter.allow(1));
        assert!(limiter.allow(1));
        assert!(!limiter.allow(1));

        now.store(2000, Ordering::SeqCst);
        assert!(limiter.allow(1));
        assert_eq!(limiter.counters().windows, 2);
    }

    #[test]
    fn the_limit_is_per_client_not_shared() {
        let limiter = CommandLimiter::new(Some(1000), Some(1), Some(fixed_clock()));

        assert!(limiter.allow(1));
        assert!(!limiter.allow(1));
        assert!(limiter.allow(2));
    }

    #[test]
    fn a_forgotten_client_starts_from_a_clean_window() {
        let limiter = CommandLimiter::new(Some(1000), Some(1), Some(fixed_clock()));

        assert!(limiter.allow(1));
        assert!(!limiter.allow(1));
        limiter.forget(1);
        assert!(limiter.allow(1));
    }

    #[test]
    fn defaults_are_a_reasonable_margin_over_the_human_pace() {
        let limiter = CommandLimiter::new(None, None, None);

        assert_eq!(limiter.window_ms(), DEFAULT_WINDOW_MS);
        assert_eq!(limiter.max(), DEFAULT_MAX_COMMANDS);
        // Мусорные значения тоже дают умолчание.
        let broken = CommandLimiter::new(Some(0), Some(0), None);
        assert_eq!(broken.window_ms(), DEFAULT_WINDOW_MS);
        assert_eq!(broken.max(), DEFAULT_MAX_COMMANDS);
    }

    #[test]
    fn the_access_code_format_is_enforced() {
        let valid = "a".repeat(32);
        assert_eq!(
            normalize_remote_token(Some(&serde_json::json!(valid))),
            valid
        );
        assert_eq!(
            normalize_remote_token(Some(&serde_json::json!("короткий"))),
            ""
        );
        assert_eq!(
            normalize_remote_token(Some(&serde_json::json!("bad token!"))),
            ""
        );
        assert_eq!(normalize_remote_token(None), "");

        let generated = generate_remote_token();
        assert_eq!(generated.len(), 32);
        assert!(generated.chars().all(|ch| ch.is_ascii_hexdigit()));
    }
}
