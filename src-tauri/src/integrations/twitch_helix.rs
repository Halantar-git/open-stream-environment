//! Twitch Helix: действия по User Access Token — клип, маркер стрима и
//! название/категория/теги канала.
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
/// Сколько тегов принимает канал.
const TAGS_LIMIT: usize = 10;
/// Длина одного тега по правилам Twitch.
const TAG_LENGTH_LIMIT: usize = 25;

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

// ---- название и категория канала ----

/// Чтение канала и поиск категорий: URL и токен → статус и JSON.
pub type JsonGetFn =
    Arc<dyn Fn(String, String) -> crate::integrations::http::JsonFuture + Send + Sync>;
/// PATCH в Helix: тот же контракт, что у POST.
pub type PatchFn = PostFn;

/// `PATCH /helix/channels` — название и игра канала.
pub const CHANNELS_URL: &str = "https://api.twitch.tv/helix/channels";
/// Родные смайлы канала (все тиры и фолловерские).
pub const CHANNEL_EMOTES_URL: &str = "https://api.twitch.tv/helix/chat/emotes";
/// Смайлы, доступные аккаунту: свой канал и каналы, на которые он подписан.
pub const USER_EMOTES_URL: &str = "https://api.twitch.tv/helix/chat/emotes/user";
/// Без параметров отдаёт владельца токена — из него берётся `user_id`.
pub const USERS_URL: &str = "https://api.twitch.tv/helix/users";
/// Поиск игры по названию — из него берётся `game_id`.
pub const CATEGORY_SEARCH_URL: &str = "https://api.twitch.tv/helix/search/categories";

/// Смайлы канала `{ name, url }`.
///
/// Анонимному IRC они не видны: подписки и фолловерские смайлы Twitch отдаёт
/// только тому, кто на них имеет право. Helix же отдаёт весь набор канала без
/// дополнительных scope — его и передаём оверлею.
pub async fn load_channel_emotes(
    get: &JsonGetFn,
    tokens: &Tokens,
    twitch: &Value,
) -> Result<Vec<Value>, String> {
    if !is_authorized(twitch) {
        return Err("auth".to_string());
    }
    let broadcaster_id = text(twitch, "broadcasterId");
    let Some(token) = ensure_token(tokens).await else {
        return Err("auth".to_string());
    };
    let url = format!(
        "{CHANNEL_EMOTES_URL}?broadcaster_id={}",
        crate::server::oauth::encode_uri_component(&broadcaster_id)
    );
    let (status, body) = get_with_retry(get, tokens, url, token).await?;
    if !(200..300).contains(&status) {
        return Err(http_error_text(status, &body));
    }
    Ok(parse_emote_list(&body))
}

/// Смайлы, доступные пользователю `{ name, url }`.
///
/// Это наборы всех каналов, на которые аккаунт подписан (и фолловерские):
/// без него в чате остаются текстом чужие родные смайлы. Нужен scope
/// `user:read:emotes` — у старого токена его нет, тогда приходит ошибка и
/// остаётся только набор своего канала. `user_id` здесь — владелец токена,
/// а не канал: чужой id Twitch отвергает.
pub async fn load_user_emotes(
    get: &JsonGetFn,
    tokens: &Tokens,
    twitch: &Value,
) -> Result<Vec<Value>, String> {
    if !is_authorized(twitch) {
        return Err("auth".to_string());
    }
    let Some(token) = ensure_token(tokens).await else {
        return Err("auth".to_string());
    };
    // `user_id` обязателен, и это должен быть владелец токена: чужой id Twitch
    // отвергает с 400. Канал, чей чат читается, бывает и чужим, поэтому id
    // спрашиваем у самого аккаунта (`/users` без параметров).
    let (status, body) = get_with_retry(get, tokens, USERS_URL.to_string(), token.clone()).await?;
    if !(200..300).contains(&status) {
        return Err(http_error_text(status, &body));
    }
    let user_id = body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|user| user.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if user_id.is_empty() {
        return Err("нет id пользователя".to_string());
    }
    // Без `broadcaster_id`: он сузил бы ответ до одного канала, а нужны все
    // наборы, которые аккаунт вообще может рисовать.
    let url = format!(
        "{USER_EMOTES_URL}?user_id={}",
        crate::server::oauth::encode_uri_component(&user_id)
    );
    let (status, body) = get_with_retry(get, tokens, url, token).await?;
    if !(200..300).contains(&status) {
        // 401 — токен выдан без `user:read:emotes`: набор канала при этом цел.
        return Err(http_error_text(status, &body));
    }
    Ok(parse_emote_list(&body))
}

/// Код ответа плюс пояснение Twitch — без него 400 не разобрать.
fn http_error_text(status: u16, body: &Value) -> String {
    match body.get("message").and_then(Value::as_str) {
        Some(message) if !message.is_empty() => format!("http_{status}: {message}"),
        _ => format!("http_{status}"),
    }
}

/// `data` ответа Helix в плоский список `{ name, url }`.
fn parse_emote_list(body: &Value) -> Vec<Value> {
    body.get("data")
        .and_then(Value::as_array)
        .map(|data| {
            data.iter()
                .filter_map(|item| {
                    let name = item.get("name").and_then(Value::as_str)?;
                    let image = item
                        .get("images")
                        .and_then(|images| images.get("url_2x"))
                        .and_then(Value::as_str)
                        .filter(|url| !url.is_empty())
                        .map(str::to_string);
                    // Картинку можно собрать и из id — она та же самая.
                    let url = match image {
                        Some(url) => url,
                        None => {
                            let id = item.get("id").and_then(Value::as_str)?;
                            format!(
                                "https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/2.0"
                            )
                        }
                    };
                    Some(json!({ "name": name, "url": url }))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Прочитать текущее название и категорию канала.
pub async fn load_channel(get: &JsonGetFn, tokens: &Tokens, twitch: &Value) -> Value {
    if !is_authorized(twitch) {
        return not_configured();
    }
    let broadcaster_id = text(twitch, "broadcasterId");
    let Some(token) = ensure_token(tokens).await else {
        return auth_error();
    };
    let url = format!(
        "{CHANNELS_URL}?broadcaster_id={}",
        crate::server::oauth::encode_uri_component(&broadcaster_id)
    );
    let (status, body) = match get_with_retry(get, tokens, url, token).await {
        Ok(outcome) => outcome,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    if !(200..300).contains(&status) {
        return json!({ "ok": false, "error": format!("http_{status}") });
    }
    let channel = body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|data| data.first());
    json!({
        "ok": true,
        "title": channel.and_then(|item| item.get("title")).cloned().unwrap_or(Value::Null),
        "category": channel.and_then(|item| item.get("game_name")).cloned().unwrap_or(Value::Null),
        "categoryId": channel.and_then(|item| item.get("game_id")).cloned().unwrap_or(Value::Null),
        "tags": channel
            .and_then(|item| item.get("tags"))
            .cloned()
            .unwrap_or_else(|| json!([])),
    })
}

/// Обновить название, категорию и теги канала. Пустые поля не трогаем.
pub async fn update_channel(
    patch: &PatchFn,
    get: &JsonGetFn,
    tokens: &Tokens,
    twitch: &Value,
    title: &str,
    category: &str,
    tags: &[String],
) -> Value {
    if !is_authorized(twitch) {
        return not_configured();
    }
    let broadcaster_id = text(twitch, "broadcasterId");
    let Some(mut token) = ensure_token(tokens).await else {
        return auth_error();
    };

    let title = title.trim();
    let category = category.trim();
    let mut game_id: Option<String> = None;
    if !category.is_empty() {
        match resolve_game_id(get, tokens, &token, category).await {
            Ok(Some(id)) => game_id = Some(id),
            Ok(None) => return json!({ "ok": false, "error": "category_not_found" }),
            Err(error) => return json!({ "ok": false, "error": error }),
        }
    }

    let mut body = serde_json::Map::new();
    if !title.is_empty() {
        body.insert(
            "title".to_string(),
            Value::from(title.chars().take(140).collect::<String>()),
        );
    }
    if let Some(id) = game_id.clone() {
        body.insert("game_id".to_string(), Value::from(id));
    }
    // Пустой список — «не трогать»: иначе первое же «Применить» стирало бы
    // теги, которые никто не вводил.
    if !tags.is_empty() {
        body.insert("tags".to_string(), json!(tags));
    }
    if body.is_empty() {
        return json!({ "ok": false, "error": "nothing_to_update" });
    }

    let url = format!(
        "{CHANNELS_URL}?broadcaster_id={}",
        crate::server::oauth::encode_uri_component(&broadcaster_id)
    );
    let payload = Value::Object(body);
    let mut outcome = patch(&url, &token, &payload).await;
    if outcome.network_error.is_none() && outcome.status == 401 {
        let Some(refreshed) = refresh_token(tokens).await else {
            return auth_error();
        };
        token = refreshed;
        outcome = patch(&url, &token, &payload).await;
    }

    finish(&outcome, |_| {
        json!({
            "title": if title.is_empty() { Value::Null } else { Value::from(title) },
            "category": if category.is_empty() { Value::Null } else { Value::from(category) },
            "tags": tags,
        })
    })
}

/// Теги из поля ввода: через запятую, без пустых и повторов.
///
/// Twitch принимает не больше десяти тегов по 25 символов — лишнее молча
/// отбрасываем, чтобы сеть не отвечала ошибкой на длинную строку.
pub fn parse_tags(input: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for part in input.split(',') {
        let tag = part.trim().trim_start_matches('#').trim();
        if tag.is_empty() {
            continue;
        }
        let tag: String = tag.chars().take(TAG_LENGTH_LIMIT).collect();
        let tag = tag.trim().to_string();
        if tag.is_empty() || tags.iter().any(|known| known.eq_ignore_ascii_case(&tag)) {
            continue;
        }
        tags.push(tag);
        if tags.len() == TAGS_LIMIT {
            break;
        }
    }
    tags
}

/// Найти `game_id` по названию игры. `None` — совпадений нет.
async fn resolve_game_id(
    get: &JsonGetFn,
    tokens: &Tokens,
    token: &str,
    query: &str,
) -> Result<Option<String>, String> {
    let url = format!(
        "{CATEGORY_SEARCH_URL}?query={}&first=1",
        crate::server::oauth::encode_uri_component(query)
    );
    let (status, body) = get_with_retry(get, tokens, url, token.to_string()).await?;
    if !(200..300).contains(&status) {
        return Err(format!("category_search_{status}"));
    }
    Ok(body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|data| data.first())
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string))
}

/// Подсказки категорий по началу названия — до десяти штук.
///
/// Для поиска нужны только ключ и токен: `broadcaster_id` тут не при чём,
/// поэтому проверка мягче, чем у действий над каналом — иначе подсказки
/// пропадали бы у тех, кто ещё не подключил вещателя.
pub async fn search_categories(
    get: &JsonGetFn,
    tokens: &Tokens,
    twitch: &Value,
    query: &str,
) -> Value {
    if !["clientId", "userAccessToken"]
        .iter()
        .all(|key| js_truthy(twitch.get(key)))
    {
        return not_configured();
    }
    let query = query.trim();
    if query.is_empty() {
        return json!({ "ok": true, "items": [] });
    }
    let Some(token) = ensure_token(tokens).await else {
        return auth_error();
    };
    let url = format!(
        "{CATEGORY_SEARCH_URL}?query={}&first=10",
        crate::server::oauth::encode_uri_component(query)
    );
    let (status, body) = match get_with_retry(get, tokens, url, token).await {
        Ok(outcome) => outcome,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    if !(200..300).contains(&status) {
        return json!({ "ok": false, "error": format!("http_{status}") });
    }
    let items = body
        .get("data")
        .and_then(Value::as_array)
        .map(|data| {
            data.iter()
                .map(|item| {
                    json!({
                        "id": item.get("id").cloned().unwrap_or(Value::Null),
                        "name": item.get("name").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({ "ok": true, "items": items })
}

/// GET с повтором после `401`: обновляем токен и пробуем тот же адрес снова.
async fn get_with_retry(
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

    fn category_search(id: &str, name: &str) -> JsonGetFn {
        let id = id.to_string();
        let name = name.to_string();
        Arc::new(move |url: String, _token: String| {
            let id = id.clone();
            let name = name.clone();
            Box::pin(async move {
                assert!(url.contains("/search/categories?query="));
                (200, json!({ "data": [{ "id": id, "name": name }] }))
            })
        })
    }

    #[tokio::test]
    async fn updating_a_channel_sends_the_resolved_game_id() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let patch: PatchFn = {
            let calls = calls.clone();
            Arc::new(move |url: &str, token: &str, body: &Value| {
                let calls = calls.clone();
                let url = url.to_string();
                let token = token.to_string();
                let body = body.clone();
                Box::pin(async move {
                    calls.lock().unwrap().push((url, token, body));
                    HttpOutcome {
                        status: 204,
                        body: json!({}),
                        network_error: None,
                    }
                })
            })
        };
        let result = update_channel(
            &patch,
            &category_search("509263", "Just Chatting"),
            &tokens(),
            &authorized(),
            "Новый стрим",
            "Just Chatting",
            &[],
        )
        .await;

        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["title"], json!("Новый стрим"));
        assert_eq!(result["category"], json!("Just Chatting"));
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].0.contains("broadcaster_id=bid"));
        assert_eq!(calls[0].1, "tok");
        assert_eq!(
            calls[0].2,
            json!({ "title": "Новый стрим", "game_id": "509263" })
        );
    }

    #[tokio::test]
    async fn a_title_only_update_does_not_search_categories() {
        let get: JsonGetFn = Arc::new(|_url: String, _token: String| {
            Box::pin(async {
                panic!("категории не должны запрашиваться")
            })
        });
        let calls = Arc::new(Mutex::new(0));
        let patch: PatchFn = {
            let calls = calls.clone();
            Arc::new(move |_url: &str, _token: &str, _body: &Value| {
                let calls = calls.clone();
                Box::pin(async move {
                    *calls.lock().unwrap() += 1;
                    HttpOutcome {
                        status: 204,
                        body: json!({}),
                        network_error: None,
                    }
                })
            })
        };
        let result = update_channel(
            &patch,
            &get,
            &tokens(),
            &authorized(),
            "Только имя",
            "",
            &[],
        )
        .await;
        assert_eq!(result["ok"], json!(true));
        assert_eq!(*calls.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn an_unknown_category_does_not_touch_the_channel() {
        let get: JsonGetFn = Arc::new(|_url: String, _token: String| {
            Box::pin(async { (200, json!({ "data": [] })) })
        });
        let calls = Arc::new(Mutex::new(0));
        let patch: PatchFn = {
            let calls = calls.clone();
            Arc::new(move |_url: &str, _token: &str, _body: &Value| {
                let calls = calls.clone();
                Box::pin(async move {
                    *calls.lock().unwrap() += 1;
                    HttpOutcome {
                        status: 204,
                        body: json!({}),
                        network_error: None,
                    }
                })
            })
        };
        let result = update_channel(
            &patch,
            &get,
            &tokens(),
            &authorized(),
            "Новый стрим",
            "Нет такой игры",
            &[],
        )
        .await;
        assert_eq!(
            result,
            json!({ "ok": false, "error": "category_not_found" })
        );
        assert_eq!(*calls.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn category_suggestions_come_back_as_id_and_name() {
        let get: JsonGetFn = Arc::new(|url: String, _token: String| {
            Box::pin(async move {
                assert!(url.contains("/search/categories?query=Just&first=10"));
                (
                    200,
                    json!({ "data": [
                        { "id": "509263", "name": "Just Chatting" },
                        { "id": "1", "name": "Just Dance" },
                    ] }),
                )
            })
        });
        let result = search_categories(&get, &tokens(), &authorized(), " Just ").await;
        assert_eq!(result["ok"], json!(true));
        assert_eq!(
            result["items"][0],
            json!({ "id": "509263", "name": "Just Chatting" })
        );
        assert_eq!(result["items"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn an_empty_category_query_does_not_hit_the_network() {
        let get: JsonGetFn = Arc::new(|_url: String, _token: String| {
            Box::pin(async {
                panic!("пустой запрос не должен уходить в сеть")
            })
        });
        let result = search_categories(&get, &tokens(), &authorized(), "   ").await;
        assert_eq!(result, json!({ "ok": true, "items": [] }));
    }

    #[tokio::test]
    async fn a_401_on_patch_refreshes_the_token_and_retries_once() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let patch: PatchFn = {
            let seen = seen.clone();
            Arc::new(move |_url: &str, token: &str, _body: &Value| {
                let seen = seen.clone();
                let token = token.to_string();
                Box::pin(async move {
                    seen.lock().unwrap().push(token.clone());
                    HttpOutcome {
                        status: if token == "tok" { 401 } else { 204 },
                        body: json!({}),
                        network_error: None,
                    }
                })
            })
        };
        let result = update_channel(
            &patch,
            &category_search("1", "Game"),
            &tokens(),
            &authorized(),
            "Стрим",
            "Game",
            &[],
        )
        .await;
        assert_eq!(result["ok"], json!(true));
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["tok".to_string(), "newtok".to_string()]
        );
    }

    #[tokio::test]
    async fn category_suggestions_survive_an_expired_token() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let get: JsonGetFn = {
            let seen = seen.clone();
            Arc::new(move |_url: String, token: String| {
                let seen = seen.clone();
                Box::pin(async move {
                    seen.lock().unwrap().push(token.clone());
                    if token == "tok" {
                        (401, json!({}))
                    } else {
                        (200, json!({ "data": [{ "id": "1", "name": "Game" }] }))
                    }
                })
            })
        };
        let result = search_categories(&get, &tokens(), &authorized(), "Game").await;
        assert_eq!(result["ok"], json!(true));
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["tok".to_string(), "newtok".to_string()]
        );
    }

    #[tokio::test]
    async fn loading_a_channel_returns_title_and_category() {
        let get: JsonGetFn = Arc::new(|_url: String, _token: String| {
            Box::pin(async {
                (
                    200,
                    json!({ "data": [{ "title": "Стрим", "game_name": "Just Chatting", "game_id": "509263" }] }),
                )
            })
        });
        let result = load_channel(&get, &tokens(), &authorized()).await;
        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["title"], json!("Стрим"));
        assert_eq!(result["category"], json!("Just Chatting"));
    }

    #[tokio::test]
    async fn channel_emotes_come_back_as_name_and_url() {
        let get: JsonGetFn = Arc::new(|url: String, _token: String| {
            Box::pin(async move {
                assert!(url.contains("/chat/emotes?broadcaster_id=bid"));
                (
                    200,
                    json!({ "data": [
                        { "id": "emote-1", "name": "ldogmanOk", "images": { "url_2x": "https://cdn/2x" } },
                        { "name": "без-id", "images": {} },
                    ] }),
                )
            })
        });
        let emotes = load_channel_emotes(&get, &tokens(), &authorized())
            .await
            .unwrap();
        assert_eq!(
            emotes[0],
            json!({ "name": "ldogmanOk", "url": "https://cdn/2x" })
        );
        // Смайл без id и картинки пропускается — рисовать нечего.
        assert_eq!(emotes.len(), 1);
    }

    #[tokio::test]
    async fn channel_emotes_need_authorization() {
        let get: JsonGetFn = Arc::new(|_url: String, _token: String| {
            Box::pin(async { panic!("без авторизации в сеть не ходим") })
        });
        assert!(load_channel_emotes(&get, &tokens(), &Value::Null)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn user_emotes_are_read_from_the_personal_endpoint() {
        let get: JsonGetFn = Arc::new(|url: String, _token: String| {
            Box::pin(async move {
                if url.ends_with("/users") {
                    return (200, json!({ "data": [{ "id": "own" }] }));
                }
                // `user_id` — владелец токена, а не канал из конфига («bid»).
                assert_eq!(
                    url,
                    "https://api.twitch.tv/helix/chat/emotes/user?user_id=own"
                );
                (
                    200,
                    json!({ "data": [
                        { "id": "u1", "name": "ForeignEmote", "images": { "url_2x": "https://cdn/u1" } },
                    ] }),
                )
            })
        });
        let emotes = load_user_emotes(&get, &tokens(), &authorized()).await;
        assert_eq!(
            emotes.unwrap(),
            vec![json!({ "name": "ForeignEmote", "url": "https://cdn/u1" })]
        );
    }

    #[tokio::test]
    async fn user_emotes_stay_empty_without_the_account_id() {
        // `/users` ответил пустым списком — из чего брать `user_id`, неизвестно.
        let get: JsonGetFn = Arc::new(|url: String, _token: String| {
            Box::pin(async move {
                if url.ends_with("/users") {
                    return (200, json!({ "data": [] }));
                }
                panic!("без id пользователя смайлы не запрашиваются");
            })
        });
        assert_eq!(
            load_user_emotes(&get, &tokens(), &authorized()).await,
            Err("нет id пользователя".to_string())
        );
    }

    #[tokio::test]
    async fn user_emotes_stay_empty_without_the_scope() {
        // Токен, выданный до появления scope, отвечает ошибкой — чат без
        // этого списка продолжает работать на наборе канала.
        let get: JsonGetFn = Arc::new(|_url: String, _token: String| {
            Box::pin(async { (403, json!({ "message": "missing scope: user:read:emotes" })) })
        });
        assert_eq!(
            load_user_emotes(&get, &tokens(), &authorized()).await,
            Err("http_403: missing scope: user:read:emotes".to_string())
        );
    }

    #[tokio::test]
    async fn a_rejected_user_emote_request_keeps_the_twitch_message() {
        // 400 без `user_id` не разобрать без текста ответа, а именно с него
        // начинался разбор «набор аккаунта не пришёл».
        let get: JsonGetFn = Arc::new(|_url: String, _token: String| {
            Box::pin(async { (400, json!({ "message": "Missing required parameter \"user_id\"" })) })
        });
        assert_eq!(
            load_user_emotes(&get, &tokens(), &authorized()).await,
            Err("http_400: Missing required parameter \"user_id\"".to_string())
        );
    }

    #[tokio::test]
    async fn loading_a_channel_returns_tags() {
        let get: JsonGetFn = Arc::new(|_url: String, _token: String| {
            Box::pin(async {
                (
                    200,
                    json!({ "data": [{ "title": "Стрим", "tags": ["ru", "chill"] }] }),
                )
            })
        });
        let result = load_channel(&get, &tokens(), &authorized()).await;
        assert_eq!(result["tags"], json!(["ru", "chill"]));
    }

    #[tokio::test]
    async fn tags_are_sent_with_the_channel_update() {
        let sent = Arc::new(Mutex::new(Value::Null));
        let patch: PatchFn = {
            let sent = sent.clone();
            Arc::new(move |_url: &str, _token: &str, body: &Value| {
                let sent = sent.clone();
                let body = body.clone();
                Box::pin(async move {
                    *sent.lock().unwrap() = body;
                    HttpOutcome {
                        status: 204,
                        body: json!({}),
                        network_error: None,
                    }
                })
            })
        };
        let get: JsonGetFn = Arc::new(|_url: String, _token: String| {
            Box::pin(async {
                panic!("категория не менялась — поиск не нужен")
            })
        });
        let tags = parse_tags("ru, chill");
        let result = update_channel(&patch, &get, &tokens(), &authorized(), "", "", &tags).await;
        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["tags"], json!(["ru", "chill"]));
        assert_eq!(
            sent.lock().unwrap().clone(),
            json!({ "tags": ["ru", "chill"] })
        );
    }

    #[tokio::test]
    async fn empty_tags_do_not_touch_the_channel() {
        let calls = Arc::new(Mutex::new(0));
        let patch: PatchFn = {
            let calls = calls.clone();
            Arc::new(move |_url: &str, _token: &str, _body: &Value| {
                let calls = calls.clone();
                Box::pin(async move {
                    *calls.lock().unwrap() += 1;
                    HttpOutcome {
                        status: 204,
                        body: json!({}),
                        network_error: None,
                    }
                })
            })
        };
        let get: JsonGetFn = Arc::new(|_url: String, _token: String| {
            Box::pin(async {
                panic!("категория не менялась — поиск не нужен")
            })
        });
        let result = update_channel(&patch, &get, &tokens(), &authorized(), "", "", &[]).await;
        assert_eq!(result, json!({ "ok": false, "error": "nothing_to_update" }));
        assert_eq!(*calls.lock().unwrap(), 0);
    }

    #[test]
    fn tags_parsing_cleans_the_input() {
        // Через запятую, с решёткой, с лишними пробелами и повтором в другом
        // регистре: Twitch такое не примет, а панель должна отправлять чистое.
        assert_eq!(
            parse_tags("  #ru , chill,, RU , "),
            vec!["ru".to_string(), "chill".to_string()]
        );
        assert!(parse_tags("   ").is_empty());
    }

    #[test]
    fn tags_parsing_respects_twitch_limits() {
        let long = "я".repeat(40);
        assert_eq!(parse_tags(&long)[0].chars().count(), 25);
        let many = (1..=15)
            .map(|index| format!("tag{index}"))
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(parse_tags(&many).len(), 10);
    }
}
