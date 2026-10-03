//! Twitch Helix: действия по User Access Token — клип и маркер стрима.
//!
//! Порт `server/integrations/twitch-helix.js`:
//!
//! * `createTwitchClip` — `POST /helix/clips` (scope `clips:edit`);
//! * `createStreamMarker` — `POST /helix/streams/markers`
//!   (scope `channel:manage:broadcast`).
//!
//! Оба действия переиспользуют тот же приём, что чат: протухший токен
//! обновляется, а `401` повторяется один раз.
//!
//! Сеть и токены здесь инжектируются: HTTP-запрос — это `PostFn`, а «добыть
//! токен» и «обновить токен» — два замыкания [`Tokens`]. Так проверяются и
//! сетевой сбой, и повтор после `401`, без настоящей сети. Модуль обновления
//! токенов (`server/token-refresh.js`) подключается отдельно — здесь он только
//! вызывается через замыкания.
//!
//! Важное правило, ради которого это отдельный слой: сетевой сбой не должен
//! «уронить» обещание — панель ждёт результат действия, а не исключение.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::storage::history::js_truthy;

/// Обмен refresh-токена на access-токен.
pub const TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";
/// Создание клипа.
pub const CLIPS_URL: &str = "https://api.twitch.tv/helix/clips";
/// Маркер стрима.
pub const MARKERS_URL: &str = "https://api.twitch.tv/helix/streams/markers";

/// Сколько символов описания маркера принимает Twitch.
const MARKER_DESCRIPTION_LIMIT: usize = 140;

/// Итог одного HTTP-запроса.
pub struct HttpOutcome {
    pub status: u16,
    /// Тело ответа; `{}`, если разобрать не вышло.
    pub body: Value,
    /// Сетевой сбой: запрос не дошёл вовсе.
    pub network_error: Option<String>,
}

/// Будущее запроса.
pub type PostFuture = Pin<Box<dyn Future<Output = HttpOutcome> + Send>>;
/// POST: URL, токен, тело → ответ.
pub type PostFn = Arc<dyn Fn(&str, &str, &Value) -> PostFuture + Send + Sync>;

/// Будущее получения токена.
pub type TokenFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;

/// Откуда берётся access-токен: сначала обычным путём, затем — после `401`.
#[derive(Clone)]
pub struct Tokens {
    pub ensure: Arc<dyn Fn() -> TokenFuture + Send + Sync>,
    pub refresh: Arc<dyn Fn() -> TokenFuture + Send + Sync>,
}

/// Готов ли канал к действию: нужны ключ, токен и идентификатор вещателя.
pub fn is_authorized(twitch: &Value) -> bool {
    ["clientId", "userAccessToken", "broadcasterId"]
        .iter()
        .all(|key| js_truthy(twitch.get(key)))
}

/// Создать клип; результат — объект `{ ok, id, editUrl }` или `{ ok: false, error }`.
pub async fn create_clip(http: &PostFn, tokens: &Tokens, twitch: &Value) -> Value {
    if !is_authorized(twitch) {
        return not_configured();
    }
    let broadcaster_id = text(twitch, "broadcasterId");

    let Some(mut token) = ensure_token(tokens).await else {
        return auth_error();
    };
    let body = json!({ "broadcaster_id": broadcaster_id, "has_delay": false });
    let mut outcome = post(http, CLIPS_URL, &token, &body).await;

    if outcome.network_error.is_none() && outcome.status == 401 {
        let Some(refreshed) = refresh_token(tokens).await else {
            return auth_error();
        };
        token = refreshed;
        outcome = post(http, CLIPS_URL, &token, &body).await;
    }

    finish(&outcome, |body| {
        let clip = body
            .get("data")
            .and_then(Value::as_array)
            .and_then(|data| data.first());
        json!({
            "id": clip.and_then(|clip| clip.get("id")).cloned().unwrap_or(Value::Null),
            "editUrl": clip.and_then(|clip| clip.get("edit_url")).cloned().unwrap_or(Value::Null),
        })
    })
}

/// Поставить маркер стрима; результат — `{ ok, id }` или `{ ok: false, error }`.
pub async fn create_marker(
    http: &PostFn,
    tokens: &Tokens,
    twitch: &Value,
    description: &str,
) -> Value {
    if !is_authorized(twitch) {
        return not_configured();
    }
    let broadcaster_id = text(twitch, "broadcasterId");

    let Some(mut token) = ensure_token(tokens).await else {
        return auth_error();
    };
    let body = json!({
        "user_id": broadcaster_id,
        "description": description.chars().take(MARKER_DESCRIPTION_LIMIT).collect::<String>(),
    });
    let mut outcome = post(http, MARKERS_URL, &token, &body).await;

    if outcome.network_error.is_none() && outcome.status == 401 {
        let Some(refreshed) = refresh_token(tokens).await else {
            return auth_error();
        };
        token = refreshed;
        outcome = post(http, MARKERS_URL, &token, &body).await;
    }

    finish(&outcome, |body| {
        let marker = body
            .get("data")
            .and_then(Value::as_array)
            .and_then(|data| data.first());
        json!({
            "id": marker.and_then(|marker| marker.get("id")).cloned().unwrap_or(Value::Null),
        })
    })
}

async fn post(http: &PostFn, url: &str, token: &str, body: &Value) -> HttpOutcome {
    // Клиент-ид и заголовки задаёт `http`: сюда он получает URL, токен и тело.
    http(url, token, body).await
}

async fn ensure_token(tokens: &Tokens) -> Option<String> {
    (tokens.ensure)().await.ok()
}

async fn refresh_token(tokens: &Tokens) -> Option<String> {
    (tokens.refresh)().await.ok()
}

/// Общий хвост: сетевой сбой, HTTP-ошибка или разбор успеха.
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

fn not_configured() -> Value {
    json!({ "ok": false, "error": "not_configured" })
}

fn auth_error() -> Value {
    json!({ "ok": false, "error": "auth" })
}

fn text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(value) if js_truthy(Some(value)) => crate::state::js_string(value),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

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

    /// Запрос всегда падает по сети — как `fetch`, отвергнутый офлайном.
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

    #[tokio::test]
    async fn a_clip_returns_a_network_error_instead_of_failing() {
        let result = create_clip(&offline(), &tokens(), &authorized()).await;
        assert_eq!(result, json!({ "ok": false, "error": "network" }));
    }

    #[tokio::test]
    async fn a_marker_returns_a_network_error_instead_of_failing() {
        let result = create_marker(&offline(), &tokens(), &authorized(), "момент").await;
        assert_eq!(result, json!({ "ok": false, "error": "network" }));
    }

    #[tokio::test]
    async fn an_unauthorized_channel_is_not_configured() {
        let twitch = json!({ "clientId": "cid" });
        assert_eq!(
            create_clip(&offline(), &tokens(), &twitch).await,
            json!({ "ok": false, "error": "not_configured" })
        );
    }

    #[tokio::test]
    async fn a_successful_clip_returns_its_id_and_edit_url() {
        let http: PostFn = Arc::new(|url: &str, token: &str, _body: &Value| {
            let url = url.to_string();
            let token = token.to_string();
            Box::pin(async move {
                assert_eq!(url, CLIPS_URL);
                assert_eq!(token, "tok");
                HttpOutcome {
                    status: 200,
                    body: json!({ "data": [{ "id": "clip1", "edit_url": "https://clips/edit" }] }),
                    network_error: None,
                }
            })
        });
        let result = create_clip(&http, &tokens(), &authorized()).await;
        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["id"], json!("clip1"));
        assert_eq!(result["editUrl"], json!("https://clips/edit"));
    }

    #[tokio::test]
    async fn a_401_refreshes_the_token_and_retries_once() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let http: PostFn = {
            let calls = calls.clone();
            Arc::new(move |_url: &str, token: &str, _body: &Value| {
                let calls = calls.clone();
                let token = token.to_string();
                Box::pin(async move {
                    calls.lock().unwrap().push(token.clone());
                    if token == "tok" {
                        HttpOutcome {
                            status: 401,
                            body: json!({}),
                            network_error: None,
                        }
                    } else {
                        HttpOutcome {
                            status: 200,
                            body: json!({ "data": [{ "id": "m1" }] }),
                            network_error: None,
                        }
                    }
                })
            })
        };
        let result = create_marker(&http, &tokens(), &authorized(), "момент").await;
        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["id"], json!("m1"));
        assert_eq!(
            *calls.lock().unwrap(),
            vec!["tok".to_string(), "newtok".to_string()]
        );
    }

    #[tokio::test]
    async fn a_failed_refresh_is_an_auth_error() {
        let http: PostFn = Arc::new(|_url: &str, _token: &str, _body: &Value| {
            Box::pin(async {
                HttpOutcome {
                    status: 401,
                    body: json!({}),
                    network_error: None,
                }
            })
        });
        let tokens = Tokens {
            ensure: Arc::new(|| Box::pin(async { Ok("tok".to_string()) })),
            refresh: Arc::new(|| Box::pin(async { Err("refresh refused".to_string()) })),
        };
        assert_eq!(
            create_clip(&http, &tokens, &authorized()).await,
            json!({ "ok": false, "error": "auth" })
        );
    }

    #[tokio::test]
    async fn an_api_message_becomes_the_error() {
        let http: PostFn = Arc::new(|_url: &str, _token: &str, _body: &Value| {
            Box::pin(async {
                HttpOutcome {
                    status: 403,
                    body: json!({ "message": "missing scope" }),
                    network_error: None,
                }
            })
        });
        assert_eq!(
            create_clip(&http, &tokens(), &authorized()).await,
            json!({ "ok": false, "error": "missing scope" })
        );
    }

    #[tokio::test]
    async fn an_http_status_without_a_message_is_reported_as_http_n() {
        let http: PostFn = Arc::new(|_url: &str, _token: &str, _body: &Value| {
            Box::pin(async {
                HttpOutcome {
                    status: 503,
                    body: json!({}),
                    network_error: None,
                }
            })
        });
        assert_eq!(
            create_clip(&http, &tokens(), &authorized()).await,
            json!({ "ok": false, "error": "http_503" })
        );
    }
}
