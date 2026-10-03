//! OAuth-подключение сервисов: адреса авторизации, `state` и тексты результата.
//!
//! Порт `server/oauth.js` в части, что только *решает*: сборка адреса
//! авторизации, одноразовый `state` с сроком жизни, экранирование и сообщения
//! страницы-результата. Обмен `code` на токен и сами роуты `/oauth/*/callback`
//! подключаются следом — они уже сетевые.
//!
//! `state` — не формальность: возврат из браузера нельзя принимать на веру, иначе
//! чужой redirect поставит приложению чужие токены. Поэтому `state` одноразовый,
//! ограничен по времени и привязан к сервису.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::storage::history::js_truthy;
use crate::storage::secrets::is_sealed;

/// Сколько живёт `state` — столько есть времени на прохождение авторизации.
pub const STATE_TTL_MS: i64 = 10 * 60 * 1000;

/// Ожидающие возврата `state` — как модульная карта `pending` в JS.
#[derive(Default)]
pub struct PendingStates {
    map: Mutex<HashMap<String, Pending>>,
}

struct Pending {
    provider: String,
    expires_at: i64,
}

impl PendingStates {
    pub fn new() -> Self {
        Self::default()
    }

    /// Завести одноразовый `state` для сервиса.
    pub fn make(&self, provider: &str, now: i64) -> String {
        let token = crate::server::access::generate_remote_token();
        let mut map = self.lock();
        sweep(&mut map, now);
        map.insert(
            token.clone(),
            Pending {
                provider: provider.to_string(),
                expires_at: now + STATE_TTL_MS,
            },
        );
        token
    }

    /// Погасить `state`: он должен быть свой, не просроченный и ровно один раз.
    pub fn consume(&self, token: &str, provider: &str, now: i64) -> bool {
        let mut map = self.lock();
        sweep(&mut map, now);
        match map.remove(token) {
            Some(entry) => entry.expires_at >= now && entry.provider == provider,
            None => false,
        }
    }

    /// Сколько `state` ждёт возврата — за этим следит тест, чтобы неудачные
    /// попытки не копились в памяти.
    pub fn count(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Pending>> {
        self.map.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Общий список ожидаемых `state` приложения.
pub fn pending() -> &'static PendingStates {
    static PENDING: OnceLock<PendingStates> = OnceLock::new();
    PENDING.get_or_init(PendingStates::new)
}

/// Просроченные записи убираются при каждом обращении: закрытая вкладка
/// авторизации `state` не возвращает, а `consume` приходит только при успехе.
fn sweep(map: &mut HashMap<String, Pending>, now: i64) {
    map.retain(|_, entry| entry.expires_at >= now);
}

/// Адрес возврата — тот же, что зарегистрирован в кабинете сервиса.
pub fn redirect_uri(port: u16, provider: &str) -> String {
    format!("http://localhost:{port}/oauth/{provider}/callback")
}

/// Адрес авторизации Twitch.
pub fn build_twitch_authorize_url(config: &Value, port: u16, states: &PendingStates) -> String {
    let state = states.make("twitch", now_ms());
    let params = [
        ("client_id", text(config, "twitch", "clientId")),
        ("redirect_uri", redirect_uri(port, "twitch")),
        ("response_type", "code".to_string()),
        (
            "scope",
            "moderator:read:followers channel:read:subscriptions bits:read channel:read:redemptions user:write:chat moderator:manage:banned_users clips:edit channel:manage:broadcast channel:manage:redemptions".to_string(),
        ),
        ("state", state),
        ("force_verify", "true".to_string()),
    ];
    format!("https://id.twitch.tv/oauth2/authorize?{}", query(&params))
}

/// Адрес авторизации DonationAlerts.
pub fn build_donation_alerts_authorize_url(
    config: &Value,
    port: u16,
    states: &PendingStates,
) -> String {
    let state = states.make("donationalerts", now_ms());
    let params = [
        ("client_id", text(config, "donationAlerts", "clientId")),
        ("redirect_uri", redirect_uri(port, "donationalerts")),
        ("response_type", "code".to_string()),
        // `oauth-donation-index` нужен, чтобы подтянуть донаты, пришедшие пока
        // приложение было выключено (см. `donationalerts`).
        (
            "scope",
            "oauth-user-show oauth-donation-subscribe oauth-donation-index oauth-goal-subscribe"
                .to_string(),
        ),
        ("state", state),
    ];
    format!(
        "https://www.donationalerts.com/oauth/authorize?{}",
        query(&params)
    )
}

/// Адрес авторизации YouTube.
pub fn build_youtube_authorize_url(config: &Value, port: u16, states: &PendingStates) -> String {
    let state = states.make("youtube", now_ms());
    let params = [
        ("client_id", text(config, "youtube", "clientId")),
        ("redirect_uri", redirect_uri(port, "youtube")),
        ("response_type", "code".to_string()),
        (
            "scope",
            "https://www.googleapis.com/auth/youtube.readonly".to_string(),
        ),
        ("access_type", "offline".to_string()),
        ("prompt", "consent".to_string()),
        ("state", state),
    ];
    format!(
        "https://accounts.google.com/o/oauth2/v2/auth?{}",
        query(&params)
    )
}

/// Экранирование для страницы-результата.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// Страница-результат авторизации: короткий ответ в стиле панели.
pub fn result_page(title: &str, message: &str, ok: bool) -> String {
    let color = if ok { "#7ee0d6" } else { "#ffb4ab" };
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title>\n  \
         <style>\n    \
         body{{background:#131019;color:#e8e1f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}}\n    \
         .card{{background:#1f1b27;border:1px solid #4a4553;border-radius:16px;padding:32px 40px;text-align:center;max-width:520px}}\n    \
         h1{{font-size:18px;margin:0 0 12px;color:{color}}}\n    \
         pre{{font-size:12.5px;color:#c9c1d6;line-height:1.5;text-align:left;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;margin:0}}\n  \
         </style></head>\n  \
         <body><div class=\"card\"><h1>{}</h1><pre>{}</pre></div></body></html>",
        escape_html(title),
        escape_html(title),
        escape_html(message),
    )
}

/// Что именно отправили — для страницы-результата: секрет показывается только
/// длиной, сам он не должен попасть ни на страницу, ни на скриншот.
pub fn describe_sent_credentials(params: &Value) -> String {
    let id = text_of(params.get("clientId"));
    let secret = text_of(params.get("clientSecret"));
    let mut parts = vec![format!(
        "client_id = {}",
        if id.is_empty() { "(пусто)" } else { &id }
    )];
    parts.push(if secret.is_empty() {
        "секрет — не заполнен".to_string()
    } else {
        format!("секрет — {} симв.", secret.chars().count())
    });
    if let Some(redirect) = params.get("redirectUri").and_then(Value::as_str) {
        if !redirect.is_empty() {
            parts.push(format!("redirect_uri = {redirect}"));
        }
    }
    format!("Отправлено: {}", parts.join(", "))
}

/// Пригоден ли ключ приложения: пустота и «зашифрованный» (`enc:…`) — нет.
pub fn usable_credential(value: Option<&Value>) -> bool {
    let text = value
        .map(crate::state::js_string)
        .unwrap_or_default()
        .trim()
        .to_string();
    !text.is_empty() && !is_sealed(&text)
}

/// Ключи приложения, без которых обмен кода на токен заведомо провалится.
pub fn missing_credentials(config: &Value) -> Vec<String> {
    let mut missing = Vec::new();
    if config
        .get("clientId")
        .map(crate::state::js_string)
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        missing.push("Client ID".to_string());
    }
    if !usable_credential(config.get("clientSecret")) {
        missing.push("Client Secret".to_string());
    }
    missing
}

/// Что пользователю делать с незаполненными ключами.
pub fn credentials_problem_message(service: &str, missing: &[String]) -> String {
    let where_ = if service == "DonationAlerts" {
        "Настройках DonationAlerts".to_string()
    } else {
        format!("Настройках {service}")
    };
    let mut parts = vec![format!(
        "Не заполнено: {}. Впишите ключи приложения в {where_} и нажмите «Подключить» ещё раз.",
        missing.join(" и ")
    )];
    if missing.iter().any(|item| item == "Client Secret") {
        parts.push(
            "Если секрет вы уже вписывали, значит сохранённое значение не удалось прочитать (например, конфиг перенесён с другой машины или сменился пользователь ОС) — тогда скопируйте Client Secret из кабинета и вставьте заново.".to_string(),
        );
    }
    parts.join("\n\n")
}

/// Объяснение провала обмена кода на токен для страницы-результата.
pub fn describe_token_exchange_failure(service: &str, payload: &Value) -> String {
    let code = payload
        .get("error")
        .or_else(|| payload.get("message"))
        .map(crate::state::js_string)
        .unwrap_or_default();
    let lowered = code.to_lowercase();
    let normalized: String = lowered
        .chars()
        .filter(|ch| *ch != ' ' && *ch != '_' && *ch != '-')
        .collect();

    let mut hints: Vec<String> = Vec::new();
    if normalized.contains("invalidclient") {
        hints.push(format!(
            "Сервис не принял Client ID / Client Secret (ответ «Client authentication failed»). Обычно это значит, что приложение в кабинете {service} пересоздавали: у нового приложения новые ключи, и вставить нужно оба. Секрет не показывается в интерфейсе повторно, поэтому скопируйте его из кабинета заново."
        ));
    } else if normalized.contains("invalidgrant") {
        hints.push(
            "Код авторизации больше не действует или уже использован: нажмите «Подключить» заново."
                .to_string(),
        );
    } else if lowered.contains("redirect_uri") {
        hints.push(format!(
            "Redirect URI не совпадает с указанным в кабинете {service}: он должен быть ровно таким, как показано в Настройках."
        ));
    }

    let raw = if js_truthy(Some(payload)) {
        format!("Ответ сервиса: {payload}")
    } else {
        String::new()
    };
    if hints.is_empty() {
        raw
    } else {
        format!("{}\n\n{raw}", hints.join("\n\n"))
    }
}

/// Тело обмена `code` на токен — как форма в JS.
pub fn authorization_code_params(
    section: &Value,
    provider: &str,
    port: u16,
    code: &str,
) -> Vec<(String, String)> {
    vec![
        ("client_id".to_string(), section_text(section, "clientId")),
        (
            "client_secret".to_string(),
            section_text(section, "clientSecret"),
        ),
        ("code".to_string(), code.to_string()),
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("redirect_uri".to_string(), redirect_uri(port, provider)),
    ]
}

/// Срок токена из `expires_in`: за минуту до конца, иначе ноль — как в JS.
pub fn token_expiry(body: &Value, now_ms: i64) -> i64 {
    match body.get("expires_in").and_then(Value::as_f64) {
        Some(seconds) if seconds != 0.0 => now_ms + ((seconds - 60.0) * 1000.0) as i64,
        _ => 0,
    }
}

/// `encodeURIComponent` — для логина канала в адресе Helix.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Значение ключа раздела настроек строкой — как его видит форма.
pub fn section_text(section: &Value, key: &str) -> String {
    section
        .get(key)
        .map(crate::state::js_string)
        .unwrap_or_default()
}

/// Значение из раздела настроек сервиса.
fn text(config: &Value, section: &str, key: &str) -> String {
    config
        .get(section)
        .and_then(|section| section.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn text_of(value: Option<&Value>) -> String {
    value
        .map(crate::state::js_string)
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Собрать query как `URLSearchParams`: пробел — `+`, остальное — `%XX`.
fn query(params: &[(&str, String)]) -> String {
    params
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_twitch_url_carries_the_scope_and_a_fresh_state() {
        let states = PendingStates::new();
        let config = json!({ "twitch": { "clientId": "cid" } });
        let url = build_twitch_authorize_url(&config, 8710, &states);

        assert!(
            url.starts_with("https://id.twitch.tv/oauth2/authorize?"),
            "{url}"
        );
        assert!(url.contains("client_id=cid"), "{url}");
        assert!(
            url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A8710%2Foauth%2Ftwitch%2Fcallback"),
            "{url}"
        );
        assert!(url.contains("force_verify=true"), "{url}");
        assert_eq!(states.count(), 1);
    }

    #[test]
    fn a_state_is_single_use_and_bound_to_its_service() {
        let states = PendingStates::new();
        let token = states.make("twitch", 1_000);
        assert!(states.consume(&token, "twitch", 1_000));
        // Второй раз тот же `state` не проходит.
        assert!(!states.consume(&token, "twitch", 1_000));

        // Чужой сервис тоже гасит запись — как `consumeState` в JS.
        let other = states.make("twitch", 1_000);
        assert!(!states.consume(&other, "youtube", 1_000));
        assert_eq!(states.count(), 0);
    }

    #[test]
    fn an_expired_state_is_rejected() {
        let states = PendingStates::new();
        let token = states.make("twitch", 1_000);
        assert!(!states.consume(&token, "twitch", 1_000 + STATE_TTL_MS + 1));
    }

    #[test]
    fn application_keys_are_checked_before_the_request() {
        assert!(
            missing_credentials(&json!({ "clientId": "id", "clientSecret": "sec" })).is_empty()
        );
        assert_eq!(
            missing_credentials(&json!({ "clientId": "", "clientSecret": "enc:abc" })),
            vec!["Client ID".to_string(), "Client Secret".to_string()]
        );
        let message = credentials_problem_message("Twitch", &["Client Secret".to_string()]);
        assert!(message.contains("Настройках Twitch"), "{message}");
        assert!(message.contains("не удалось прочитать"), "{message}");
    }

    #[test]
    fn a_token_failure_is_explained_in_words() {
        let hint = describe_token_exchange_failure("Twitch", &json!({ "error": "invalid client" }));
        assert!(hint.contains("Client ID / Client Secret"), "{hint}");
        assert!(hint.contains("Ответ сервиса:"), "{hint}");

        let hint =
            describe_token_exchange_failure("DonationAlerts", &json!({ "error": "invalid_grant" }));
        assert!(
            hint.contains("Код авторизации больше не действует"),
            "{hint}"
        );

        let hint = describe_token_exchange_failure(
            "Google",
            &json!({ "message": "redirect_uri_mismatch" }),
        );
        assert!(hint.contains("Redirect URI"), "{hint}");
    }

    #[test]
    fn the_result_page_escapes_and_colors() {
        assert_eq!(escape_html("<b>&\"'"), "&lt;b&gt;&amp;&quot;&#39;");
        let ok = result_page("Успех", "готово", true);
        assert!(ok.starts_with("<!doctype html>"), "{ok}");
        assert!(ok.contains("#7ee0d6"), "{ok}");
        assert!(result_page("Беда", "нет", false).contains("#ffb4ab"));
    }

    #[test]
    fn the_token_exchange_body_and_expiry_follow_the_service() {
        let section = json!({ "clientId": "cid", "clientSecret": "sec" });
        let params = authorization_code_params(&section, "twitch", 8710, "code123");
        assert!(params.contains(&("client_id".to_string(), "cid".to_string())));
        assert!(params.contains(&("code".to_string(), "code123".to_string())));
        assert!(params.contains(&("grant_type".to_string(), "authorization_code".to_string())));
        assert!(params.contains(&(
            "redirect_uri".to_string(),
            "http://localhost:8710/oauth/twitch/callback".to_string()
        )));

        assert_eq!(
            token_expiry(&json!({ "expires_in": 3600 }), 1_000),
            1_000 + 3_540_000
        );
        assert_eq!(token_expiry(&json!({}), 1_000), 0);
        assert_eq!(token_expiry(&json!({ "expires_in": 0 }), 1_000), 0);

        assert_eq!(encode_uri_component("a b&c"), "a%20b%26c");
    }
}
