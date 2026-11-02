/*
 * Copyright (C) 2026  Halantar
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://gnu.org>.
 */

//! Название, описание и категория активной трансляции YouTube.
//!
//! `liveBroadcasts.update` — это **PUT** с `part=snippet`, и он перезаписывает
//! все изменяемые поля сниппета. Поэтому перед запросом читаем текущую
//! трансляцию и переносим в тело `scheduledStartTime`, `scheduledEndTime`,
//! языки и остальные поля: иначе они были бы стёрты.
//!
//! Для записи нужен scope `youtube.force-ssl`; старые токены только на чтение
//! получат `403 insufficientPermissions` — это переводится в `missing_scope`,
//! чтобы панель попросила переподключить YouTube.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::integrations::http::JsonFuture;
use crate::integrations::twitch_helix::Tokens;

pub const LIVE_BROADCASTS_URL: &str = "https://www.googleapis.com/youtube/v3/liveBroadcasts";
pub const VIDEO_CATEGORIES_URL: &str = "https://www.googleapis.com/youtube/v3/videoCategories";

/// GET JSON: URL и токен → статус и тело.
pub type JsonGetFn = Arc<dyn Fn(String, String) -> JsonFuture + Send + Sync>;
/// PUT JSON: URL, токен и тело → статус и тело.
pub type JsonPutFn = Arc<dyn Fn(String, String, Value) -> JsonFuture + Send + Sync>;

/// Прочитать название, описание и категорию активной трансляции.
pub async fn load_info(get: &JsonGetFn, tokens: &Tokens) -> Value {
    let Some(token) = ensure_token(tokens).await else {
        return json!({ "ok": false, "error": "auth" });
    };
    let (status, body) = match get_json(
        get,
        tokens,
        format!("{LIVE_BROADCASTS_URL}?part=snippet,status&mine=true"),
        token,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    if !(200..300).contains(&status) {
        return http_error(status, &body);
    }
    let Some(broadcast) = live_broadcast(&body) else {
        return json!({ "ok": false, "error": "no_live" });
    };
    let snippet = broadcast
        .get("snippet")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let category_id = text(&snippet, "categoryId");
    let category = if category_id.is_empty() {
        Value::Null
    } else {
        category_name(get, tokens, &category_id).await
    };
    json!({
        "ok": true,
        "title": snippet.get("title").cloned().unwrap_or(Value::Null),
        "description": snippet.get("description").cloned().unwrap_or(Value::Null),
        "category": category,
        "categoryId": if category_id.is_empty() { Value::Null } else { Value::from(category_id) },
    })
}

/// Обновить название, описание и категорию активной трансляции.
///
/// Пустое название и пустая категория означают «не менять», описание
/// применяется как есть (пустое — очистить).
pub async fn apply_info(
    get: &JsonGetFn,
    put: &JsonPutFn,
    tokens: &Tokens,
    title: &str,
    description: &str,
    category: &str,
) -> Value {
    let Some(mut token) = ensure_token(tokens).await else {
        return json!({ "ok": false, "error": "auth" });
    };

    let (status, body) = match get_json(
        get,
        tokens,
        format!("{LIVE_BROADCASTS_URL}?part=snippet,status&mine=true"),
        token.clone(),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    if !(200..300).contains(&status) {
        return http_error(status, &body);
    }
    let Some(broadcast) = live_broadcast(&body) else {
        return json!({ "ok": false, "error": "no_live" });
    };
    let Some(broadcast_id) = broadcast.get("id").and_then(Value::as_str) else {
        return json!({ "ok": false, "error": "no_live" });
    };
    let current = broadcast
        .get("snippet")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    // `part=snippet` перезаписывает все изменяемые поля сниппета, поэтому
    // переносим их из текущей трансляции, а не отправляем только новое.
    let mut snippet = serde_json::Map::new();
    for key in [
        "title",
        "description",
        "scheduledStartTime",
        "scheduledEndTime",
        "categoryId",
        "defaultLanguage",
        "defaultAudioLanguage",
    ] {
        if let Some(value) = current.get(key) {
            snippet.insert(key.to_string(), value.clone());
        }
    }

    let title = title.trim();
    if !title.is_empty() {
        snippet.insert(
            "title".to_string(),
            Value::from(title.chars().take(100).collect::<String>()),
        );
    }
    snippet.insert(
        "description".to_string(),
        Value::from(description.chars().take(5000).collect::<String>()),
    );

    let category = category.trim();
    if !category.is_empty() {
        match resolve_category_id(get, tokens, category).await {
            Ok(Some(id)) => {
                snippet.insert("categoryId".to_string(), Value::from(id));
            }
            Ok(None) => return json!({ "ok": false, "error": "category_not_found" }),
            Err(error) => return json!({ "ok": false, "error": error }),
        }
    }

    let url = format!("{LIVE_BROADCASTS_URL}?part=snippet");
    let payload = json!({ "id": broadcast_id, "snippet": Value::Object(snippet) });
    let mut outcome = put(url.clone(), token.clone(), payload.clone()).await;
    if outcome.0 == 401 {
        let Some(refreshed) = refresh_token(tokens).await else {
            return json!({ "ok": false, "error": "auth" });
        };
        token = refreshed;
        outcome = put(url, token, payload).await;
    }
    let (status, body) = outcome;
    if status == 0 {
        return json!({ "ok": false, "error": "network" });
    }
    if !(200..300).contains(&status) {
        return http_error(status, &body);
    }

    let applied = body.get("snippet").cloned().unwrap_or(Value::Null);
    json!({
        "ok": true,
        "title": applied.get("title").cloned().unwrap_or(Value::Null),
        "description": applied.get("description").cloned().unwrap_or(Value::Null),
        "category": if category.is_empty() {
            current.get("categoryId").cloned().unwrap_or(Value::Null)
        } else {
            Value::from(category)
        },
    })
}

/// Найти активную (или готовую) трансляцию в ответе `liveBroadcasts.list`.
///
/// Если сервис вернул несколько (идёт эфир и уже готов следующий), выбираем
/// более живую: `live`, затем `testing`, затем `ready`.
fn live_broadcast(body: &Value) -> Option<&Value> {
    let items = body.get("items").and_then(Value::as_array)?;
    let mut best: Option<(&Value, u8)> = None;
    for item in items {
        let status = item
            .get("status")
            .and_then(|status| status.get("lifeCycleStatus"))
            .and_then(Value::as_str);
        let rank = match status {
            Some("live") => 0,
            Some("testing") => 1,
            Some("ready") => 2,
            _ => continue,
        };
        if best.map_or(true, |(_, current)| rank < current) {
            best = Some((item, rank));
        }
    }
    best.map(|(item, _)| item)
}

/// Название категории по её id.
async fn category_name(get: &JsonGetFn, tokens: &Tokens, id: &str) -> Value {
    let Some(token) = ensure_token(tokens).await else {
        return Value::Null;
    };
    let url = format!(
        "{VIDEO_CATEGORIES_URL}?part=snippet&id={}",
        crate::server::oauth::encode_uri_component(id)
    );
    let Ok((status, body)) = get_json(get, tokens, url, token).await else {
        return Value::Null;
    };
    if !(200..300).contains(&status) {
        return Value::Null;
    }
    body.get("items")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("snippet"))
        .and_then(|snippet| snippet.get("title"))
        .cloned()
        .unwrap_or(Value::Null)
}

/// Найти id категории по названию. Число принимается как id напрямую.
async fn resolve_category_id(
    get: &JsonGetFn,
    tokens: &Tokens,
    category: &str,
) -> Result<Option<String>, String> {
    if category.chars().all(|ch| ch.is_ascii_digit()) {
        return Ok(Some(category.to_string()));
    }
    let Some(token) = ensure_token(tokens).await else {
        return Err("auth".to_string());
    };
    let wanted = category.to_lowercase();
    // Названия категорий локализованы: «Игры» и «Gaming» — одна и та же
    // категория. Пробуем русский список, затем английский.
    for language in ["ru", "en"] {
        let url = format!("{VIDEO_CATEGORIES_URL}?part=snippet&regionCode=RU&hl={language}");
        let (status, body) = get_json(get, tokens, url, token.clone()).await?;
        if !(200..300).contains(&status) {
            return Err(format!("categories_{status}"));
        }
        let found = body
            .get("items")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find(|item| {
                    item.get("snippet")
                        .and_then(|snippet| snippet.get("title"))
                        .and_then(Value::as_str)
                        .map(|title| title.to_lowercase() == wanted)
                        .unwrap_or(false)
                })
            })
            .and_then(|item| item.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

/// GET с повтором после `401`.
async fn get_json(
    get: &JsonGetFn,
    tokens: &Tokens,
    url: String,
    mut token: String,
) -> Result<(u16, Value), String> {
    let mut outcome = get(url.clone(), token.clone()).await;
    if outcome.0 == 0 {
        return Err("network".to_string());
    }
    if outcome.0 == 401 {
        token = (tokens.refresh)().await?;
        outcome = get(url, token).await;
        if outcome.0 == 0 {
            return Err("network".to_string());
        }
    }
    Ok(outcome)
}

async fn ensure_token(tokens: &Tokens) -> Option<String> {
    (tokens.ensure)().await.ok()
}

async fn refresh_token(tokens: &Tokens) -> Option<String> {
    (tokens.refresh)().await.ok()
}

/// 401/403 — это про доступ: для записи нужен `youtube.force-ssl`.
fn http_error(status: u16, body: &Value) -> Value {
    let reason = body
        .get("error")
        .and_then(|error| error.get("errors"))
        .and_then(Value::as_array)
        .and_then(|errors| errors.first())
        .and_then(|error| error.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if reason == "liveStreamingNotEnabled" {
        return json!({ "ok": false, "error": "live_disabled" });
    }
    if status == 401
        || (status == 403
            && matches!(
                reason,
                "insufficientPermissions" | "insufficientLivePermissions" | ""
            ))
    {
        return json!({ "ok": false, "error": "missing_scope" });
    }
    let message = body
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if message.is_empty() {
        json!({ "ok": false, "error": format!("http_{status}") })
    } else {
        json!({ "ok": false, "error": message })
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn tokens() -> Tokens {
        Tokens {
            ensure: Arc::new(|| Box::pin(async { Ok("tok".to_string()) })),
            refresh: Arc::new(|| Box::pin(async { Ok("newtok".to_string()) })),
        }
    }

    fn broadcast() -> Value {
        json!({
            "items": [{
                "id": "bcast1",
                "snippet": {
                    "title": "Старое название",
                    "description": "Старое описание",
                    "scheduledStartTime": "2026-11-02T18:00:00Z",
                    "scheduledEndTime": "2026-11-02T22:00:00Z",
                    "categoryId": "20",
                    "defaultLanguage": "ru"
                },
                "status": { "lifeCycleStatus": "live" }
            }]
        })
    }

    fn get_fixture() -> JsonGetFn {
        Arc::new(|url: String, _token: String| {
            Box::pin(async move {
                if url.contains("liveBroadcasts") {
                    (200, broadcast())
                } else if url.contains("videoCategories") && url.contains("id=20") {
                    (
                        200,
                        json!({ "items": [{ "id": "20", "snippet": { "title": "Игры" } }] }),
                    )
                } else if url.contains("videoCategories") {
                    (
                        200,
                        json!({
                            "items": [
                                { "id": "20", "snippet": { "title": "Игры" } },
                                { "id": "24", "snippet": { "title": "Развлечения" } }
                            ]
                        }),
                    )
                } else {
                    (200, json!({}))
                }
            })
        })
    }

    fn put_ok(calls: Arc<Mutex<Vec<Value>>>) -> JsonPutFn {
        Arc::new(move |url: String, _token: String, body: Value| {
            let calls = calls.clone();
            Box::pin(async move {
                assert!(url.contains("liveBroadcasts?part=snippet"));
                calls.lock().unwrap().push(body.clone());
                let snippet = body.get("snippet").cloned().unwrap_or_else(|| json!({}));
                (200, json!({ "id": body.get("id"), "snippet": snippet }))
            })
        })
    }

    #[tokio::test]
    async fn loading_reads_title_description_and_category() {
        let result = load_info(&get_fixture(), &tokens()).await;
        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["title"], json!("Старое название"));
        assert_eq!(result["description"], json!("Старое описание"));
        assert_eq!(result["category"], json!("Игры"));
    }

    #[tokio::test]
    async fn apply_preserves_the_schedule_and_other_snippet_fields() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let result = apply_info(
            &get_fixture(),
            &put_ok(calls.clone()),
            &tokens(),
            "Новое название",
            "Новое описание",
            "20",
        )
        .await;

        assert_eq!(result["ok"], json!(true));
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let snippet = &calls[0]["snippet"];
        assert_eq!(snippet["title"], json!("Новое название"));
        assert_eq!(snippet["description"], json!("Новое описание"));
        assert_eq!(snippet["categoryId"], json!("20"));
        // PUT с `part=snippet` перезаписывает всё, что не прислали.
        assert_eq!(snippet["scheduledStartTime"], json!("2026-11-02T18:00:00Z"));
        assert_eq!(snippet["scheduledEndTime"], json!("2026-11-02T22:00:00Z"));
        assert_eq!(snippet["defaultLanguage"], json!("ru"));
    }

    #[tokio::test]
    async fn apply_resolves_a_category_name() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let result = apply_info(
            &get_fixture(),
            &put_ok(calls.clone()),
            &tokens(),
            "",
            "",
            "Игры",
        )
        .await;
        assert_eq!(result["ok"], json!(true));
        assert_eq!(
            calls.lock().unwrap()[0]["snippet"]["categoryId"],
            json!("20")
        );
    }

    #[tokio::test]
    async fn apply_reports_a_missing_write_scope() {
        let put: JsonPutFn = Arc::new(|_url: String, _token: String, _body: Value| {
            Box::pin(async { (403, json!({ "error": { "message": "insufficient" } })) })
        });
        let result = apply_info(&get_fixture(), &put, &tokens(), "Имя", "", "").await;
        assert_eq!(result, json!({ "ok": false, "error": "missing_scope" }));
    }

    #[tokio::test]
    async fn apply_reports_no_active_broadcast() {
        let get: JsonGetFn = Arc::new(|_url: String, _token: String| {
            Box::pin(async { (200, json!({ "items": [] })) })
        });
        let put: JsonPutFn = Arc::new(|_url: String, _token: String, _body: Value| {
            Box::pin(async { (200, json!({})) })
        });
        let result = apply_info(&get, &put, &tokens(), "Имя", "", "").await;
        assert_eq!(result, json!({ "ok": false, "error": "no_live" }));
    }

    #[tokio::test]
    async fn an_unknown_category_stops_the_update() {
        let get: JsonGetFn = Arc::new(|url: String, _token: String| {
            Box::pin(async move {
                if url.contains("liveBroadcasts") {
                    (200, broadcast())
                } else {
                    (200, json!({ "items": [] }))
                }
            })
        });
        let calls = Arc::new(Mutex::new(0));
        let put: JsonPutFn = {
            let calls = calls.clone();
            Arc::new(move |_url: String, _token: String, _body: Value| {
                let calls = calls.clone();
                Box::pin(async move {
                    *calls.lock().unwrap() += 1;
                    (200, json!({}))
                })
            })
        };
        let result = apply_info(&get, &put, &tokens(), "Имя", "", "Несуществующий").await;
        assert_eq!(
            result,
            json!({ "ok": false, "error": "category_not_found" })
        );
        assert_eq!(*calls.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn a_401_on_put_refreshes_the_token_and_retries_once() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let put: JsonPutFn = {
            let seen = seen.clone();
            Arc::new(move |_url: String, token: String, _body: Value| {
                let seen = seen.clone();
                Box::pin(async move {
                    seen.lock().unwrap().push(token.clone());
                    if token == "tok" {
                        (401, json!({}))
                    } else {
                        (200, json!({ "snippet": { "title": "Имя" } }))
                    }
                })
            })
        };
        let result = apply_info(&get_fixture(), &put, &tokens(), "Имя", "", "").await;
        assert_eq!(result["ok"], json!(true));
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["tok".to_string(), "newtok".to_string()]
        );
    }
}
