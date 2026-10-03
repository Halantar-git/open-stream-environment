//! Обновление OAuth-токенов через `refresh_token` — общее для интеграций.
//!
//! Порт `server/token-refresh.js`. Twitch EventSub, YouTube и DonationAlerts
//! используют один и тот же приём: склеить конкурентные обновления в один
//! запрос, обменять `refresh_token` на `access_token`, сохранить новый токен и
//! срок (`expiresAt`), а `ensureAccessToken` возвращает ещё годный токен из
//! конфига или обновляет его.
//!
//! Сеть инжектируется (`post_form`), часы тоже — поэтому и обмен, и отказ до
//! запроса проверяются без сети.
//!
//! Два важных правила из JS повторены дословно:
//!
//! * **пустые ключи приложения — ошибка до запроса**, с узнаваемым словом
//!   `invalid_client` в тексте: сервис ответил бы тем же невнятным
//!   `invalid_client`, а повтор такой запрос не лечит;
//! * **зашифрованное значение (`enc:…`) считается отсутствующим**: так выглядит
//!   секрет, который не удалось прочитать, — отправлять его бессмысленно.
//!
//! Склейка конкурентных обновлений сделана без общего «обещания» (в Rust его
//! нет): вызов, начавшийся до завершения чужого обновления, берёт его результат.
//! Для этого каждый вызов запоминает номер поколения при старте, а завершённое
//! обновление сохраняет результат и увеличивает поколение.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::storage::history::{js_number_or_zero, js_truthy};
use crate::storage::secrets::is_sealed;

/// Часы — подменяются в тестах.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Итог обмена токена.
pub struct FormOutcome {
    pub status: u16,
    pub body: Value,
}

/// Будущее запроса.
pub type FormFuture = Pin<Box<dyn Future<Output = FormOutcome> + Send>>;
/// POST формы: URL и поля → ответ.
pub type FormFn = Arc<dyn Fn(&str, &[(String, String)]) -> FormFuture + Send + Sync>;
/// Отдать текущие настройки сервиса.
pub type ConfigFn = Arc<dyn Fn() -> Value + Send + Sync>;
/// Собрать поля обмена из настроек.
pub type ParamsFn = Arc<dyn Fn(&Value) -> Vec<(String, String)> + Send + Sync>;
/// Сохранить новый токен и срок.
pub type SaveTokensFn = Arc<dyn Fn(&Value, i64) + Send + Sync>;
/// Строка в журнал: успех/провал и текст.
pub type LogFn = Arc<dyn Fn(bool, &str) + Send + Sync>;

/// Всё, чем различаются интеграции.
pub struct TokenRefresherConfig {
    pub token_url: String,
    /// Имя сервиса для сообщений об ошибке.
    pub label: String,
    /// Ключ access-токена в конфиге (`userAccessToken`, `accessToken`, …).
    pub access_token_key: String,
    pub get_config: ConfigFn,
    pub build_params: ParamsFn,
    pub save_tokens: SaveTokensFn,
    pub post_form: FormFn,
    pub now: Option<Clock>,
    /// Строка в журнал; вызывающий решает, куда её писать.
    pub log: Option<LogFn>,
}

/// Обновлятель токенов одного сервиса.
pub struct TokenRefresher {
    config: TokenRefresherConfig,
    now: Clock,
    /// Сериализация обновлений: второй вызов ждёт первый, а не шлёт свой запрос.
    gate: tokio::sync::Mutex<()>,
    expires_at: AtomicI64,
    generation: AtomicU64,
    last: Mutex<Option<(u64, Result<String, String>)>>,
}

impl TokenRefresher {
    pub fn new(config: TokenRefresherConfig) -> Self {
        let now = config
            .now
            .clone()
            .unwrap_or_else(|| Arc::new(|| chrono::Utc::now().timestamp_millis()));
        Self {
            config,
            now,
            gate: tokio::sync::Mutex::new(()),
            expires_at: AtomicI64::new(0),
            generation: AtomicU64::new(0),
            last: Mutex::new(None),
        }
    }

    /// Обменять `refresh_token` на новый `access_token`.
    ///
    /// Конкурентные вызовы склеиваются: пока идёт один, остальные получат его
    /// результат, а не отправят второй запрос.
    pub async fn refresh_access_token(&self) -> Result<String, String> {
        let started_at_generation = self.generation.load(Ordering::SeqCst);
        let _gate = self.gate.lock().await;

        if let Some((generation, result)) = self.last_token() {
            if generation > started_at_generation {
                return result;
            }
        }

        let result = self.do_refresh().await;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *self.lock_last() = Some((generation, result.clone()));
        result
    }

    /// Вернуть ещё годный токен или обновить протухший.
    pub async fn ensure_access_token(&self) -> Result<String, String> {
        let config = (self.config.get_config)();
        let stored = self.expires_at.load(Ordering::SeqCst);
        let expires_at = if stored != 0 {
            stored
        } else {
            js_number_or_zero(config.get("expiresAt")) as i64
        };
        if expires_at != 0 && (self.now)() < expires_at {
            return Ok(access_token(&config, &self.config.access_token_key));
        }
        if js_truthy(config.get("refreshToken")) {
            return self.refresh_access_token().await;
        }
        Ok(access_token(&config, &self.config.access_token_key))
    }

    async fn do_refresh(&self) -> Result<String, String> {
        let config = (self.config.get_config)();
        if !js_truthy(config.get("refreshToken")) {
            return Err(format!("no {} refreshToken available", self.config.label));
        }

        let params = (self.config.build_params)(&config);
        let param = |key: &str| -> String {
            params
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
                .unwrap_or_default()
        };
        let usable = |value: &str| {
            let text = value.trim();
            !text.is_empty() && !is_sealed(text)
        };
        if !usable(&param("client_id")) || !usable(&param("client_secret")) {
            // Имя `invalid_client` в тексте не для красоты: по нему вызывающий
            // отличает «нужны действия пользователя» от сетевого сбоя.
            return Err(format!(
                "refresh_token: invalid_client_credentials: {} — впишите Client ID и Client Secret в настройках",
                self.config.label
            ));
        }

        self.log(true, "refreshing access token…");
        let outcome = (self.config.post_form)(&self.config.token_url, &params).await;
        let ok = (200..300).contains(&outcome.status);
        let token = outcome
            .body
            .get("access_token")
            .and_then(Value::as_str)
            .map(str::to_string);

        let Some(token) = token.filter(|_| ok) else {
            self.log(
                false,
                &format!(
                    "{}: token refresh failed: {} {}",
                    self.config.label, outcome.status, outcome.body
                ),
            );
            // Префикс «refresh_token:» не меняем: по нему отличают проблему с
            // авторизацией от сетевого сбоя.
            return Err(format!(
                "refresh_token: {} {}",
                outcome.status, outcome.body
            ));
        };

        let expires_at = match outcome.body.get("expires_in").and_then(Value::as_f64) {
            Some(seconds) if seconds != 0.0 => (self.now)() + ((seconds - 60.0) * 1000.0) as i64,
            _ => 0,
        };
        self.expires_at.store(expires_at, Ordering::SeqCst);
        (self.config.save_tokens)(&outcome.body, expires_at);
        self.log(true, "access token refreshed");
        Ok(token)
    }

    fn log(&self, success: bool, message: &str) {
        if let Some(log) = &self.config.log {
            log(success, message);
        }
    }

    fn last_token(&self) -> Option<(u64, Result<String, String>)> {
        self.lock_last().clone()
    }

    fn lock_last(&self) -> std::sync::MutexGuard<'_, Option<(u64, Result<String, String>)>> {
        self.last.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn access_token(config: &Value, key: &str) -> String {
    match config.get(key) {
        Some(value) if js_truthy(Some(value)) => crate::state::js_string(value),
        _ => String::new(),
    }
}

/// Пригодится вызывающему: собрать параметры обмена для Twitch-подобной схемы.
pub fn refresh_params(config: &Value, extra: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut params = vec![
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("client_id".to_string(), text(config, "clientId")),
        ("client_secret".to_string(), text(config, "clientSecret")),
        ("refresh_token".to_string(), text(config, "refreshToken")),
    ];
    for (key, source) in extra {
        params.push(((*key).to_string(), text(config, source)));
    }
    params
}

fn text(config: &Value, key: &str) -> String {
    match config.get(key) {
        Some(value) if js_truthy(Some(value)) => crate::state::js_string(value),
        _ => String::new(),
    }
}

/// Утилита для тестов и вызывающего: ответ обмена как JSON.
pub fn token_response(access_token: &str, expires_in: i64) -> Value {
    json!({ "access_token": access_token, "expires_in": expires_in })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// Обвязка: конфиг фиксирован, обмен считает вызовы и отвечает заданным.
    struct Harness {
        refresher: TokenRefresher,
        saves: Arc<Mutex<Vec<(Value, i64)>>>,
        calls: Arc<AtomicUsize>,
    }

    fn harness(
        config: Value,
        responder: impl Fn() -> FormOutcome + Send + Sync + 'static,
    ) -> Harness {
        let saves = Arc::new(Mutex::new(Vec::new()));
        let calls = Arc::new(AtomicUsize::new(0));
        let post_form: FormFn = {
            let calls = calls.clone();
            Arc::new(move |_url: &str, _params: &[(String, String)]| {
                calls.fetch_add(1, Ordering::SeqCst);
                let outcome = responder();
                Box::pin(async move { outcome })
            })
        };
        let refresher = TokenRefresher::new(TokenRefresherConfig {
            token_url: "https://example.test/token".to_string(),
            label: "test".to_string(),
            access_token_key: "accessToken".to_string(),
            get_config: Arc::new(move || config.clone()),
            build_params: Arc::new(|config| {
                vec![
                    ("grant_type".to_string(), "refresh_token".to_string()),
                    ("client_id".to_string(), text(config, "clientId")),
                    ("client_secret".to_string(), text(config, "clientSecret")),
                    ("refresh_token".to_string(), text(config, "refreshToken")),
                ]
            }),
            save_tokens: {
                let saves = saves.clone();
                Arc::new(move |json: &Value, expires_at: i64| {
                    saves.lock().unwrap().push((json.clone(), expires_at));
                })
            },
            post_form,
            now: None,
            log: None,
        });
        Harness {
            refresher,
            saves,
            calls,
        }
    }

    fn ok_outcome() -> FormOutcome {
        FormOutcome {
            status: 200,
            body: token_response("new", 3600),
        }
    }

    fn base_config() -> Value {
        json!({ "clientId": "id", "clientSecret": "secret", "refreshToken": "rt", "accessToken": "old", "expiresAt": 0 })
    }

    #[tokio::test]
    async fn a_valid_token_comes_from_the_config_without_a_request() {
        let now = chrono::Utc::now().timestamp_millis();
        let config = json!({ "clientId": "id", "clientSecret": "secret", "refreshToken": "rt", "accessToken": "old", "expiresAt": now + 100_000 });
        let harness = harness(config, ok_outcome);
        assert_eq!(
            harness.refresher.ensure_access_token().await,
            Ok("old".to_string())
        );
        assert_eq!(harness.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn empty_application_keys_fail_before_the_request() {
        let config = json!({ "clientId": "", "clientSecret": "", "refreshToken": "rt", "accessToken": "old", "expiresAt": 0 });
        let harness = harness(config, ok_outcome);
        let error = harness.refresher.refresh_access_token().await.unwrap_err();
        assert!(error.contains("invalid_client"), "{error}");
        assert_eq!(harness.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn an_empty_secret_alone_also_fails_before_the_request() {
        let config = json!({ "clientId": "id", "clientSecret": "   ", "refreshToken": "rt", "accessToken": "old", "expiresAt": 0 });
        let harness = harness(config, ok_outcome);
        let error = harness.refresher.refresh_access_token().await.unwrap_err();
        assert!(error.contains("invalid_client"), "{error}");
        assert_eq!(harness.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn refresh_exchanges_the_token_and_saves_the_expiry() {
        let harness = harness(base_config(), ok_outcome);
        assert_eq!(
            harness.refresher.refresh_access_token().await,
            Ok("new".to_string())
        );
        assert_eq!(harness.calls.load(Ordering::SeqCst), 1);

        let saves = harness.saves.lock().unwrap();
        assert_eq!(saves.len(), 1);
        assert_eq!(saves[0].0["access_token"], json!("new"));
        assert!(saves[0].1 > chrono::Utc::now().timestamp_millis());
    }

    #[tokio::test]
    async fn an_expired_token_is_refreshed() {
        let now = chrono::Utc::now().timestamp_millis();
        let config = json!({ "clientId": "id", "clientSecret": "secret", "refreshToken": "rt", "accessToken": "old", "expiresAt": now - 1000 });
        let harness = harness(config, ok_outcome);
        assert_eq!(
            harness.refresher.ensure_access_token().await,
            Ok("new".to_string())
        );
        assert_eq!(harness.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn concurrent_refreshes_collapse_into_one_request() {
        let release = Arc::new(tokio::sync::Notify::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let post_form: FormFn = {
            let release = release.clone();
            let calls = calls.clone();
            Arc::new(move |_url: &str, _params: &[(String, String)]| {
                calls.fetch_add(1, Ordering::SeqCst);
                let release = release.clone();
                Box::pin(async move {
                    release.notified().await;
                    ok_outcome()
                })
            })
        };
        let saves = Arc::new(Mutex::new(Vec::new()));
        let refresher = Arc::new(TokenRefresher::new(TokenRefresherConfig {
            token_url: "https://example.test/token".to_string(),
            label: "test".to_string(),
            access_token_key: "accessToken".to_string(),
            get_config: Arc::new(base_config),
            build_params: Arc::new(|config| {
                vec![
                    ("grant_type".to_string(), "refresh_token".to_string()),
                    ("client_id".to_string(), text(config, "clientId")),
                    ("client_secret".to_string(), text(config, "clientSecret")),
                    ("refresh_token".to_string(), text(config, "refreshToken")),
                ]
            }),
            save_tokens: Arc::new(move |_json: &Value, _expires_at: i64| {
                saves.lock().unwrap().push(());
            }),
            post_form,
            now: None,
            log: None,
        }));

        let first = {
            let refresher = refresher.clone();
            tokio::spawn(async move { refresher.refresh_access_token().await })
        };
        tokio::task::yield_now().await;
        let second = {
            let refresher = refresher.clone();
            tokio::spawn(async move { refresher.refresh_access_token().await })
        };
        tokio::task::yield_now().await;
        release.notify_waiters();

        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.unwrap(), Ok("new".to_string()));
        assert_eq!(second.unwrap(), Ok("new".to_string()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn without_a_refresh_token_refresh_fails() {
        let config = json!({ "clientId": "id", "clientSecret": "secret", "refreshToken": "", "accessToken": "old", "expiresAt": 0 });
        let harness = harness(config, ok_outcome);
        let error = harness.refresher.refresh_access_token().await.unwrap_err();
        assert!(error.contains("no test refreshToken available"), "{error}");
        assert_eq!(harness.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn without_a_refresh_token_ensure_returns_the_static_token() {
        let config = json!({ "clientId": "id", "clientSecret": "secret", "refreshToken": "", "accessToken": "static", "expiresAt": 0 });
        let harness = harness(config, ok_outcome);
        assert_eq!(
            harness.refresher.ensure_access_token().await,
            Ok("static".to_string())
        );
        assert_eq!(harness.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_failed_exchange_carries_the_refresh_prefix() {
        let harness = harness(base_config(), || FormOutcome {
            status: 400,
            body: json!({ "error": "invalid_grant" }),
        });
        let error = harness.refresher.refresh_access_token().await.unwrap_err();
        assert!(error.starts_with("refresh_token: 400"), "{error}");
    }
}
