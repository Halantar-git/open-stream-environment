//! OAuth2 GoodGame через общий Worker OSE.
//!
//! GoodGame принимает `redirect_uri` только на HTTPS с путём, поэтому
//! браузер возвращается не в приложение, а в `ose-signal`. Секрет приложения
//! (`client_secret`) лежит там же секретом Cloudflare и в приложение не
//! попадает: приложение заводит `state` и `verifier`, получает по ним адрес
//! авторизации, а после возврата забирает готовые токены у воркера.
//!
//! Здесь — части, которые только *решают*: одноразовый `state`, адрес воркера
//! из настройки signaling, разбор профиля и тексты отказов. Сеть и роуты — в
//! `desktop.rs` и `server/mod.rs`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{Map, Value};

/// Сколько ждём возврата из браузера — столько же, сколько живёт state в
/// воркере.
pub const STATE_TTL_MS: i64 = 10 * 60 * 1000;

/// Профиль владельца токена: из него берём числовой id для чата.
pub const PROFILE_URL: &str = "https://goodgame.ru/api/4/users/@me";

/// Ожидающие возврата `state` и их `verifier` — по одному на попытку входа.
#[derive(Default)]
pub struct PendingTokens {
    map: Mutex<HashMap<String, Pending>>,
}

struct Pending {
    verifier: String,
    expires_at: i64,
}

impl PendingTokens {
    pub fn new() -> Self {
        Self::default()
    }

    /// Завести состояние входа. `state` уходит в браузер и GoodGame, `verifier`
    /// остаётся в приложении и доказывает воркеру, что токены забирает тот же
    /// экземпляр.
    pub fn begin(&self, now: i64) -> (String, String) {
        let state = crate::server::access::generate_remote_token();
        // Два UUID — 64 символа: под длину verifier в воркере (32–128).
        let verifier = format!(
            "{}{}",
            crate::server::access::generate_remote_token(),
            crate::server::access::generate_remote_token()
        );
        let mut map = self.lock();
        sweep(&mut map, now);
        map.insert(
            state.clone(),
            Pending {
                verifier: verifier.clone(),
                expires_at: now + STATE_TTL_MS,
            },
        );
        (state, verifier)
    }

    /// Погасить `state`: вернуть `verifier`, если он свой и не просрочен.
    pub fn take(&self, state: &str, now: i64) -> Option<String> {
        let mut map = self.lock();
        sweep(&mut map, now);
        map.remove(state)
            .filter(|entry| entry.expires_at >= now)
            .map(|entry| entry.verifier)
    }

    /// Сколько входов ждёт возврата — за этим следит тест, чтобы отменённые
    /// попытки не копились.
    pub fn count(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Pending>> {
        self.map.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Общий список ожидаемых `state` приложения.
pub fn pending() -> &'static PendingTokens {
    static PENDING: OnceLock<PendingTokens> = OnceLock::new();
    PENDING.get_or_init(PendingTokens::new)
}

fn sweep(map: &mut HashMap<String, Pending>, now: i64) {
    map.retain(|_, entry| entry.expires_at >= now);
}

/// База HTTP-адресов воркера из настройки signaling.
///
/// Signaling ходит по `ws(s)://`; OAuth-маршруты живут на том же сервисе, но по
/// обычному HTTP. Схема меняется на `http(s)`, хвостовой слэш убирается.
pub fn worker_base(signal_url: &str) -> Option<String> {
    let trimmed = signal_url.trim().trim_end_matches('/');
    let (scheme, rest) = trimmed.split_once("://")?;
    if rest.is_empty() {
        return None;
    }
    let scheme = match scheme.to_ascii_lowercase().as_str() {
        "wss" | "https" => "https",
        "ws" | "http" => "http",
        _ => return None,
    };
    Some(format!("{scheme}://{rest}"))
}

/// Маршрут воркера от базы.
pub fn worker_route(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

/// База воркера для OAuth2.
///
/// Настройка signaling может указывать на локальный `wrangler dev`, но
/// GoodGame принимает `redirect_uri` только на HTTPS-домене, и браузер на
/// `127.0.0.1` не вернётся. Поэтому локальный адрес заменяется рабочим
/// воркером по умолчанию: вход продолжает работать, даже если signaling
/// временно перевели на свою машину.
pub fn oauth_worker_base(signal_url: &str) -> Option<String> {
    let base = worker_base(signal_url)?;
    if is_local_base(&base) {
        worker_base(crate::state::config::DEFAULT_GUEST_SIGNAL_URL)
    } else {
        Some(base)
    }
}

fn is_local_base(base: &str) -> bool {
    let host = base
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("");
    ["localhost", "127.0.0.1", "[::1]", "::1"]
        .iter()
        .any(|local| host == *local || host.starts_with(&format!("{local}:")))
}

/// Поля токенов для `save_goodgame_tokens`: `access_token` в настройках зовётся
/// `token`, потому что тем же полем живёт токен, введённый вручную.
pub fn tokens_patch(body: &Value, now_ms: i64) -> Map<String, Value> {
    let mut patch = Map::new();
    if let Some(token) = body.get("access_token").and_then(Value::as_str) {
        patch.insert("token".to_string(), Value::from(token));
    }
    if let Some(refresh) = body.get("refresh_token").and_then(Value::as_str) {
        patch.insert("refreshToken".to_string(), Value::from(refresh));
    }
    patch.insert(
        "expiresAt".to_string(),
        Value::from(token_expiry(body, now_ms)),
    );
    patch
}

/// Срок токена: за минуту до конца, иначе ноль — как у остальных служб.
///
/// GoodGame отдаёт `expires_in` числом, но старые ответы встречались строкой;
/// строку разбираем, чтобы токен не считался вечным по ошибке.
pub fn token_expiry(body: &Value, now_ms: i64) -> i64 {
    let seconds = match body.get("expires_in") {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    match seconds {
        Some(seconds) if seconds != 0.0 => now_ms + ((seconds - 60.0) * 1000.0) as i64,
        _ => 0,
    }
}

/// `(id, имя)` из ответа `api/4/users/@me`.
///
/// API может обернуть пользователя в `data`/`user` или вернуть массив; id
/// приходит числом или строкой. Имя нужно, чтобы подставить канал, когда поле
/// ещё пустое.
pub fn profile_identity(body: &Value) -> (Option<String>, Option<String>) {
    let user = body
        .get("data")
        .filter(|value| value.is_object())
        .or_else(|| body.get("result").filter(|value| value.is_object()))
        .or_else(|| body.get("user").filter(|value| value.is_object()))
        .unwrap_or(body);
    let user = match user {
        Value::Array(items) => items.first().unwrap_or(&Value::Null),
        other => other,
    };
    let id = first_text(user, &["id", "user_id", "userId", "channel_id"]);
    let name = first_text(user, &["username", "name", "login"]);
    (id, name)
}

fn first_text(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        let Some(field) = value.get(*key) else {
            continue;
        };
        let text = match field {
            Value::String(text) => text.trim().to_string(),
            Value::Number(number) => number.to_string(),
            _ => continue,
        };
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

/// Объяснение провала на странице-результате. Текст ошибки воркера короткий и
/// без секретов, поэтому его можно показать как есть.
pub fn exchange_failure_message(status: u16, body: &Value) -> String {
    if status == 0 {
        return "Не удалось связаться с сервисом авторизации OSE. Проверьте интернет и повторите попытку."
            .to_string();
    }
    let error = body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let hint = match error {
        "expired_state" | "unknown_state" => {
            "Сессия входа истекла: нажмите «Подключить GoodGame» заново."
        }
        "expired_ticket" => "Одноразовый пропуск истёк: нажмите «Подключить GoodGame» заново.",
        "forbidden" => {
            "Сервис авторизации не принял подтверждение входа: начните подключение заново."
        }
        "not_configured" => {
            "Сервис авторизации не настроен: в Cloudflare не заданы ключи приложения GoodGame."
        }
        _ => "",
    };
    if !hint.is_empty() {
        return hint.to_string();
    }
    if error.is_empty() {
        format!("Сервис авторизации ответил {status}. Попробуйте подключиться ещё раз.")
    } else {
        format!("Сервис авторизации ответил {status}: {error}.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_state_is_single_use_and_expires() {
        let states = PendingTokens::new();
        let (state, verifier) = states.begin(1_000);
        assert_eq!(state.len(), 32);
        assert_eq!(verifier.len(), 64);
        assert_eq!(states.take(&state, 1_500), Some(verifier));
        assert_eq!(states.take(&state, 1_500), None);
        assert_eq!(states.count(), 0);

        let (expired, _) = states.begin(1_000);
        assert_eq!(states.take(&expired, 1_000 + STATE_TTL_MS + 1), None);
        assert_eq!(states.count(), 0);
    }

    #[test]
    fn the_worker_base_follows_the_signaling_scheme() {
        assert_eq!(
            worker_base("wss://ose-signal.halantar.workers.dev/").as_deref(),
            Some("https://ose-signal.halantar.workers.dev")
        );
        assert_eq!(
            worker_base("ws://127.0.0.1:8787").as_deref(),
            Some("http://127.0.0.1:8787")
        );
        assert_eq!(
            worker_base("https://example.test").as_deref(),
            Some("https://example.test")
        );
        assert_eq!(worker_base("ose-overlay.ru"), None);
        assert_eq!(worker_base("wss://"), None);
    }

    #[test]
    fn a_local_signaling_falls_back_to_the_deployed_worker_for_oauth() {
        // GoodGame не вернёт браузер на localhost, поэтому вход не должен
        // зависеть от локального адреса signaling.
        let fallback = worker_base(crate::state::config::DEFAULT_GUEST_SIGNAL_URL);
        assert_eq!(oauth_worker_base("ws://127.0.0.1:8787"), fallback);
        assert_eq!(oauth_worker_base("ws://localhost:8787"), fallback);
        assert_eq!(
            oauth_worker_base("wss://example.test/").as_deref(),
            Some("https://example.test")
        );
    }

    #[test]
    fn worker_routes_do_not_double_the_slash() {
        assert_eq!(
            worker_route("https://example.test/", "/oauth/goodgame/prepare"),
            "https://example.test/oauth/goodgame/prepare"
        );
    }

    #[test]
    fn tokens_keep_the_name_the_rest_of_the_app_expects() {
        let patch = tokens_patch(
            &json!({
                "token_type": "Bearer",
                "expires_in": 3600,
                "access_token": "access",
                "refresh_token": "refresh",
            }),
            10_000,
        );
        assert_eq!(patch["token"], json!("access"));
        assert_eq!(patch["refreshToken"], json!("refresh"));
        assert_eq!(patch["expiresAt"], json!(10_000 + 3_540_000));
    }

    #[test]
    fn expiry_accepts_a_number_or_a_string_and_rejects_the_unknown() {
        assert_eq!(token_expiry(&json!({ "expires_in": 120 }), 0), 60_000);
        assert_eq!(token_expiry(&json!({ "expires_in": "120" }), 0), 60_000);
        assert_eq!(token_expiry(&json!({}), 0), 0);
        assert_eq!(token_expiry(&json!({ "expires_in": 0 }), 0), 0);
    }

    #[test]
    fn the_profile_id_is_read_from_the_usual_shapes() {
        assert_eq!(
            profile_identity(&json!({ "id": 123, "username": "Miker" })),
            (Some("123".to_string()), Some("Miker".to_string()))
        );
        assert_eq!(
            profile_identity(&json!({ "data": { "user_id": "42", "name": "Вася" } })),
            (Some("42".to_string()), Some("Вася".to_string()))
        );
        assert_eq!(
            profile_identity(&json!({ "result": { "id": 9, "login": "gg" } })),
            (Some("9".to_string()), Some("gg".to_string()))
        );
        assert_eq!(
            profile_identity(&json!([{ "id": "7", "login": "login" }])),
            (Some("7".to_string()), Some("login".to_string()))
        );
        assert_eq!(profile_identity(&json!({})), (None, None));
    }

    #[test]
    fn a_failure_is_explained_in_words() {
        assert!(exchange_failure_message(0, &json!({})).contains("интернет"));
        assert!(
            exchange_failure_message(410, &json!({ "error": "expired_state" })).contains("заново")
        );
        assert!(
            exchange_failure_message(403, &json!({ "error": "forbidden" }))
                .contains("подтверждение")
        );
        assert_eq!(
            exchange_failure_message(500, &json!({ "error": "server_error" })),
            "Сервис авторизации ответил 500: server_error."
        );
    }
}
