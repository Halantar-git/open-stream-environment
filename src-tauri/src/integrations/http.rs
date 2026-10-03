//! Настоящая сеть: `reqwest` поверх нативных TLS.
//!
//! Здесь живут адаптеры под уже введённые точки внедрения: `PostFn` для Helix
//! (`integrations/twitch_helix.rs`, `twitch_chat.rs`) и `FormFn` для обмена
//! токенов (`integrations/token_refresh.rs`). Модули остаются проверяемыми без
//! сети — сюда смотрит только приложение.
//!
//! `Client-Id` в Helix-запрос берётся из настроек в момент вызова: у `PostFn` его
//! нет в аргументах (там только URL, токен и тело), а ключ приложения может
//! смениться без перезапуска.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};

use crate::integrations::donationalerts::{GetFuture as DonationsGetFuture, GetOutcome};
use crate::integrations::longshot_sync::FetchFuture;
use crate::integrations::token_refresh::{FormFuture, FormOutcome};
use crate::integrations::twitch_helix::{HttpOutcome, PostFn};
use crate::integrations::youtube_live_control::GetFuture;
use crate::storage::config_file::ConfigFile;

/// Будущее запроса со статусом и телом.
pub type JsonFuture = Pin<Box<dyn Future<Output = (u16, Value)> + Send>>;

/// Общая HTTP-сессия на процесс: соединения переиспользуются, как в `fetch`-пуле.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// GET JSON без авторизации — конфиг Longshot (таймер Executive Hangar).
///
/// Сбой сети и разбора возвращается текстом: вызывающему важно лишь, что анкер
/// не обновился (он сохранит прежний и оставит признак ошибки).
pub fn fetch_json(url: &str) -> FetchFuture {
    let url = url.to_string();
    Box::pin(async move {
        match client().get(&url).send().await {
            Ok(response) => match response.json::<Value>().await {
                Ok(body) => Ok(body),
                Err(error) => Err(error.to_string()),
            },
            Err(error) => Err(error.to_string()),
        }
    })
}

/// POST формы — обмен токена. Сбой сети даёт `status: 0` и пустое тело, как и
/// полагается вызывающему: по нулю он отличает «не дошло» от ответа сервера.
pub fn form_post(url: &str, fields: &[(String, String)]) -> FormFuture {
    let url = url.to_string();
    let body = encode_form(fields);
    Box::pin(async move {
        match client()
            .post(&url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
                FormOutcome { status, body }
            }
            Err(_) => FormOutcome {
                status: 0,
                body: json!({}),
            },
        }
    })
}

/// POST JSON в Twitch Helix с заголовками `Client-Id` и `Authorization`.
///
/// Ключ приложения читается из настроек при каждом запросе — см. заголовок модуля.
pub fn helix_post(config: Arc<Mutex<ConfigFile>>) -> PostFn {
    Arc::new(move |url: &str, token: &str, body: &Value| {
        let config = Arc::clone(&config);
        let url = url.to_string();
        let token = token.to_string();
        let body = body.clone();
        Box::pin(async move {
            let client_id = {
                let config = config.lock().unwrap_or_else(|error| error.into_inner());
                config
                    .get("twitch")
                    .and_then(|twitch| twitch.get("clientId"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            match client()
                .post(&url)
                .header("Client-Id", client_id)
                .header("Authorization", format!("Bearer {token}"))
                .json(&body)
                .send()
                .await
            {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let body = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
                    HttpOutcome {
                        status,
                        body,
                        network_error: None,
                    }
                }
                Err(error) => HttpOutcome {
                    status: 0,
                    body: json!({}),
                    network_error: Some(error.to_string()),
                },
            }
        })
    })
}

/// GET с `Bearer`-токеном — DonationAlerts (OAuth-данные, строки списков).
pub fn bearer_get(url: String, token: String) -> JsonFuture {
    Box::pin(async move {
        match client().get(&url).bearer_auth(&token).send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
                (status, body)
            }
            Err(_) => (0, json!({})),
        }
    })
}

/// GET в Twitch Helix с `Client-Id` — поиск пользователя по логину канала.
pub fn helix_get(url: String, client_id: String, token: String) -> JsonFuture {
    Box::pin(async move {
        match client()
            .get(&url)
            .header("Client-Id", client_id)
            .bearer_auth(&token)
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
                (status, body)
            }
            Err(_) => (0, json!({})),
        }
    })
}

/// POST JSON с `Bearer`-токеном — подписка Centrifugo.
pub fn bearer_post(url: String, token: String, body: Value) -> JsonFuture {
    Box::pin(async move {
        match client()
            .post(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
        {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
                (status, body)
            }
            Err(_) => (0, json!({})),
        }
    })
}

/// GET с `Bearer`-токеном, тело — **сырым текстом** — YouTube Data API.
///
/// Отказ `liveChatMessages` приходит и не-JSON (прокси, HTML-заглушка), а по
/// нему решается, сбрасывать ли `liveChatId`, поэтому текст не теряем.
pub fn bearer_get_text(url: String, token: String) -> GetFuture {
    Box::pin(async move {
        match client().get(&url).bearer_auth(&token).send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response.text().await.unwrap_or_default();
                (status, body)
            }
            Err(_) => (0, String::new()),
        }
    })
}

/// GET с `Bearer` и полным итогом — REST-добор донатов DonationAlerts.
///
/// В отличие от [`bearer_get`], сетевой сбой не теряется: вызывающий отличает
/// «не дошло» от ответа сервиса и показывает понятное сообщение.
pub fn bearer_get_outcome(url: String, token: String) -> DonationsGetFuture {
    Box::pin(async move {
        match client().get(&url).bearer_auth(&token).send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
                GetOutcome {
                    status,
                    body,
                    network_error: None,
                }
            }
            Err(error) => GetOutcome {
                status: 0,
                body: json!({}),
                network_error: Some(error.to_string()),
            },
        }
    })
}

/// Собрать `application/x-www-form-urlencoded` — вручную, чтобы не зависеть от
/// того, как сериализатор обходится с последовательностью пар.
fn encode_form(fields: &[(String, String)]) -> String {
    fields
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Процентное кодирование незарезервированных символов (пробел — `+`).
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_form_is_encoded_for_the_wire() {
        let fields = [
            ("grant_type".to_string(), "refresh_token".to_string()),
            ("client_id".to_string(), "a b&c".to_string()),
        ];
        assert_eq!(
            encode_form(&fields),
            "grant_type=refresh_token&client_id=a+b%26c"
        );
    }
}
