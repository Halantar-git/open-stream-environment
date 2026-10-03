//! События Twitch EventSub: разбор уведомлений и действия за баллы канала.
//!
//! Порт `server/integrations/twitch-eventsub.js` в той части, что только
//! *решает*: подписки (`subscriptions`), подбор ракурса камеры и фильтра по
//! названию награды (`match_camera_angle`/`match_camera_filter`), правило товара
//! (`find_reward_rule`), подстановка `{user}`/`{reward}`/`{input}` и превращение
//! уведомления в события шины ([`notification_events`], [`reward_actions`]).
//! Это те же данные, что уходят в `bus.emit` в JS, — в форме `{ type, payload }`.
//!
//! Сам WebSocket EventSub (`startTwitchEvents`: welcome/reconnect/keepalive) здесь
//! не переносится: ему нужен сокет с TLS — тот же блокер, что у `twitch-chat`
//! (у `tokio-tungstenite` нет TLS-бэкенда по умолчанию). Когда он появится,
//! транспорт останется тонким: он будет звать отсюда `notification_events` и
//! рассылать результат.

use serde_json::{json, Value};

use crate::storage::history::js_truthy;

/// Куда уходит подписка EventSub.
pub const SUBSCRIBE_URL: &str = "https://api.twitch.tv/helix/eventsub/subscriptions";

/// Названия подписок берутся из документации Twitch; порядок — как в JS.
const SUBSCRIPTION_TYPES: [(&str, &str); 5] = [
    ("channel.follow", "2"),
    ("channel.subscribe", "1"),
    ("channel.subscription.gift", "1"),
    ("channel.cheer", "1"),
    ("channel.channel_points_custom_reward_redemption.add", "1"),
];

/// Подписки EventSub для вещателя: тип, версия и условие.
///
/// У `channel.follow` второй версии условие требует и модератора — им выступает
/// сам вещатель, поэтому идентификатор стоит в обоих полях.
pub fn subscriptions(broadcaster_id: &str) -> Vec<Value> {
    SUBSCRIPTION_TYPES
        .iter()
        .map(|(kind, version)| {
            let condition = if *kind == "channel.follow" {
                json!({ "broadcaster_user_id": broadcaster_id, "moderator_user_id": broadcaster_id })
            } else {
                json!({ "broadcaster_user_id": broadcaster_id })
            };
            json!({ "type": kind, "version": version, "condition": condition })
        })
        .collect()
}

/// Ракурс камеры по названию награды: без учёта регистра и внешних пробелов.
pub fn match_camera_angle(angles: &Value, reward_title: &Value) -> Option<Value> {
    match_by_reward_title(angles, reward_title)
}

/// Фильтр камеры по названию награды.
pub fn match_camera_filter(filters: &Value, reward_title: &Value) -> Option<Value> {
    match_by_reward_title(filters, reward_title)
}

/// Общий подбор для камер: название награды сравнивается по обрезанному
/// нижнему регистру, а у кандидата — тоже обрезанному (`twitchRewardTitle`).
fn match_by_reward_title(items: &Value, reward_title: &Value) -> Option<Value> {
    let title = text_trim(reward_title).to_lowercase();
    if title.is_empty() {
        return None;
    }
    items.as_array()?.iter().find_map(|item| {
        let candidate = item.get("twitchRewardTitle").and_then(Value::as_str)?;
        (!candidate.is_empty() && candidate.trim().to_lowercase() == title).then(|| item.clone())
    })
}

/// Правило товара Twitch по идентификатору или названию награды.
///
/// Идентификатор сравнивается строго, название — в нижнем регистре (у правила
/// оно не обрезается: так же, как в JS).
pub fn find_reward_rule(rewards: &Value, reward_id: &Value, reward_title: &Value) -> Option<Value> {
    let id = text_trim(reward_id);
    let title = text_trim(reward_title).to_lowercase();
    if id.is_empty() && title.is_empty() {
        return None;
    }
    rewards.as_array()?.iter().find_map(|rule| {
        let rid = rule.get("rewardId").and_then(Value::as_str).unwrap_or("");
        let rtitle = rule
            .get("rewardTitle")
            .and_then(Value::as_str)
            .unwrap_or("");
        let by_id = !rid.is_empty() && !id.is_empty() && rid == id;
        let by_title = !rtitle.is_empty() && !title.is_empty() && rtitle.to_lowercase() == title;
        (by_id || by_title).then(|| rule.clone())
    })
}

/// Подставить `{user}`/`{reward}`/`{input}`; пустой автор — «Зритель».
pub fn fill_reward_placeholders(
    text: &Value,
    user: &str,
    reward_title: &str,
    user_input: &str,
) -> String {
    let base = value_text(text);
    let user_text = if user.is_empty() {
        "Зритель"
    } else {
        user
    };
    base.replace("{user}", user_text)
        .replace("{reward}", reward_title)
        .replace("{input}", user_input)
}

/// Действия за баллы канала: алерт, озвучка и смена сцены. Пусто — правила нет.
pub fn reward_actions(
    config: &Value,
    reward_id: &Value,
    reward_title: &Value,
    user: &str,
    user_input: &str,
) -> Vec<Value> {
    let rewards = config.get("twitchRewards").cloned().unwrap_or(Value::Null);
    let Some(rule) = find_reward_rule(&rewards, reward_id, reward_title) else {
        return Vec::new();
    };

    let title = value_text(reward_title);
    let rule_title = value_text(rule.get("rewardTitle").unwrap_or(&Value::Null));
    let shown_title = if title.is_empty() {
        rule_title
    } else {
        title.clone()
    };
    let user_text = if user.is_empty() {
        "Зритель"
    } else {
        user
    };
    let mut events = Vec::new();

    if js_truthy(rule.get("alert")) {
        let message = fill_reward_placeholders(
            rule.get("alertMessage").unwrap_or(&Value::Null),
            user,
            &title,
            user_input,
        );
        events.push(bus_event(
            "alert",
            json!({
                "kind": "reward",
                "user": user_text,
                "rewardTitle": shown_title,
                "message": message,
            }),
        ));
    }

    if js_truthy(rule.get("tts")) {
        let source = match rule.get("ttsText") {
            Some(text) if js_truthy(Some(text)) => text,
            _ => rule.get("alertMessage").unwrap_or(&Value::Null),
        };
        let text = fill_reward_placeholders(source, user, &title, user_input);
        if !text.is_empty() {
            events.push(bus_event("reward_tts", json!({ "text": text })));
        }
    }

    if js_truthy(rule.get("scene")) {
        events.push(bus_event(
            "reward_scene_request",
            json!({ "scene": rule.get("scene").cloned().unwrap_or(Value::Null) }),
        ));
    }

    events
}

/// События шины по уведомлению EventSub (`handleNotification` в JS).
///
/// Возвращает те же `bus.emit`, что и JS, в форме `{ type, payload }` — включая
/// внутренние имена шины (`stat_delta`, `soundboard_play`, `camera_*_request`),
/// которые `index.js` превращал в состояние и рассылку.
pub fn notification_events(config: &Value, payload: &Value) -> Vec<Value> {
    let kind = payload
        .get("subscription")
        .and_then(|subscription| subscription.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let event = payload.get("event").cloned().unwrap_or(Value::Null);
    let mut events = Vec::new();

    match kind {
        "channel.follow" => {
            events.push(bus_event(
                "alert",
                json!({ "kind": "follow", "user": text_of(event.get("user_name")) }),
            ));
            events.push(bus_event("stat_delta", json!({ "followerDelta": 1 })));
        }
        "channel.subscribe" => {
            // Подарочные подписки приходят ещё и сюда; дарителя отдаёт
            // `channel.subscription.gift`, поэтому здесь их пропускаем.
            if js_truthy(event.get("is_gift")) {
                return events;
            }
            events.push(bus_event(
                "alert",
                json!({
                    "kind": "sub",
                    "user": text_of(event.get("user_name")),
                    "tier": text_of(event.get("tier")),
                }),
            ));
            events.push(bus_event("stat_delta", json!({ "subscriberDelta": 1 })));
        }
        "channel.subscription.gift" => {
            let anonymous = js_truthy(event.get("is_anonymous"));
            let user = if anonymous {
                "Аноним".to_string()
            } else {
                text_of(event.get("user_name"))
            };
            events.push(bus_event(
                "alert",
                json!({
                    "kind": "gift_sub",
                    "user": user,
                    "count": event.get("total").cloned().unwrap_or(Value::Null),
                    "tier": text_of(event.get("tier")),
                }),
            ));
            let delta = match event.get("total") {
                Some(total) if js_truthy(Some(total)) => total.clone(),
                _ => json!(1),
            };
            events.push(bus_event("stat_delta", json!({ "subscriberDelta": delta })));
        }
        "channel.cheer" => {
            let anonymous = js_truthy(event.get("is_anonymous"));
            let user = if anonymous {
                "Аноним".to_string()
            } else {
                text_of(event.get("user_name"))
            };
            events.push(bus_event(
                "alert",
                json!({
                    "kind": "cheer",
                    "user": user,
                    "amount": event.get("bits").cloned().unwrap_or(Value::Null),
                }),
            ));
        }
        "channel.channel_points_custom_reward_redemption.add" => {
            let reward = event.get("reward");
            let reward_title = reward
                .and_then(|reward| reward.get("title"))
                .cloned()
                .unwrap_or(Value::Null);
            let reward_id = reward
                .and_then(|reward| reward.get("id"))
                .cloned()
                .unwrap_or(Value::Null);
            let title = value_text(&reward_title);
            let user = {
                let name = text_of(event.get("user_name"));
                if name.is_empty() {
                    "Зритель".to_string()
                } else {
                    name
                }
            };
            let user_input = text_of(event.get("user_input"));

            events.extend(reward_actions(
                config,
                &reward_id,
                &reward_title,
                &user,
                &user_input,
            ));

            let sounds = config
                .get("soundboard")
                .and_then(|soundboard| soundboard.get("sounds"))
                .and_then(Value::as_array);
            if let Some(sounds) = sounds {
                let reward_id_text = reward_id.as_str().unwrap_or("");
                let found = sounds.iter().find(|sound| {
                    let rid = sound.get("rewardId").and_then(Value::as_str).unwrap_or("");
                    let rtitle = sound
                        .get("rewardTitle")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    (!rid.is_empty() && rid == reward_id_text)
                        || (!rtitle.is_empty()
                            && !title.is_empty()
                            && rtitle.to_lowercase() == title.to_lowercase())
                });
                if let Some(sound) = found {
                    let id = text_of(sound.get("id"));
                    let title_of_sound = text_of(sound.get("title"));
                    let reward_of_sound = text_of(sound.get("rewardTitle"));
                    let shown = if !title_of_sound.is_empty() {
                        title_of_sound
                    } else if !reward_of_sound.is_empty() {
                        reward_of_sound
                    } else {
                        id.clone()
                    };
                    events.push(bus_event(
                        "soundboard_play",
                        json!({
                            "soundId": id,
                            "title": shown,
                            "user": user,
                            "audioFile": text_of(sound.get("audioFile")),
                            "imageFile": text_of(sound.get("imageFile")),
                            "videoFile": text_of(sound.get("videoFile")),
                        }),
                    ));
                }
            }

            let obs = config.get("obs");
            let angles = obs
                .and_then(|obs| obs.get("cameraAngles"))
                .cloned()
                .unwrap_or(Value::Null);
            if let Some(angle) = match_camera_angle(&angles, &reward_title) {
                events.push(bus_event(
                    "camera_angle_request",
                    json!({ "angleId": text_of(angle.get("id")), "user": user }),
                ));
            }

            let filters = obs
                .and_then(|obs| obs.get("cameraFilters"))
                .cloned()
                .unwrap_or(Value::Null);
            if let Some(filter) = match_camera_filter(&filters, &reward_title) {
                events.push(bus_event(
                    "camera_filter_request",
                    json!({ "filterId": text_of(filter.get("id")), "user": user }),
                ));
            }
        }
        _ => {}
    }

    events
}

/// Разобранное сообщение WebSocket EventSub.
#[derive(Debug, Clone, PartialEq)]
pub enum EventSubMessage {
    /// `session_welcome`: идентификатор сессии — нужен для подписки.
    Welcome(String),
    /// `session_reconnect`: URL нового соединения.
    Reconnect(String),
    /// `session_keepalive`.
    Keepalive,
    /// `notification`: полезная нагрузка целиком.
    Notification(Value),
    /// Всё прочее или не JSON.
    Other,
}

/// Разобрать сообщение EventSub: тип лежит в `metadata.message_type`.
pub fn parse_message(frame: &str) -> EventSubMessage {
    let Ok(value) = serde_json::from_str::<Value>(frame) else {
        return EventSubMessage::Other;
    };
    let kind = value
        .get("metadata")
        .and_then(|metadata| metadata.get("message_type"))
        .and_then(Value::as_str);
    match kind {
        Some("session_welcome") => EventSubMessage::Welcome(
            value
                .get("payload")
                .and_then(|payload| payload.get("session"))
                .and_then(|session| session.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ),
        Some("session_reconnect") => EventSubMessage::Reconnect(
            value
                .get("payload")
                .and_then(|payload| payload.get("session"))
                .and_then(|session| session.get("reconnect_url"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ),
        Some("session_keepalive") => EventSubMessage::Keepalive,
        Some("notification") => {
            EventSubMessage::Notification(value.get("payload").cloned().unwrap_or(Value::Null))
        }
        _ => EventSubMessage::Other,
    }
}

/// Событие шины в той же форме, что `bus.emit(name, payload)`.
fn bus_event(kind: &str, payload: Value) -> Value {
    json!({ "type": kind, "payload": payload })
}

/// `String(value || "")` — пустое значение даёт пустую строку.
fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(value) if js_truthy(Some(value)) => crate::state::js_string(value),
        _ => String::new(),
    }
}

/// То же для готовой ссылки: `text_of(Some(value))`.
fn value_text(value: &Value) -> String {
    text_of(Some(value))
}

/// `String(value || "").trim()`.
fn text_trim(value: &Value) -> String {
    value_text(value).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscriptions_cover_the_five_types() {
        let subs = subscriptions("bid");
        assert_eq!(subs.len(), 5);
        assert_eq!(subs[0]["type"], json!("channel.follow"));
        assert_eq!(subs[0]["version"], json!("2"));
        // Follow второй версии требует и модератора — это сам вещатель.
        assert_eq!(subs[0]["condition"]["broadcaster_user_id"], json!("bid"));
        assert_eq!(subs[0]["condition"]["moderator_user_id"], json!("bid"));
        assert_eq!(
            subs[4]["type"],
            json!("channel.channel_points_custom_reward_redemption.add")
        );
        assert_eq!(subs[4]["condition"]["broadcaster_user_id"], json!("bid"));
    }

    #[test]
    fn a_camera_angle_matches_by_title_ignoring_case_and_spaces() {
        let angles = json!([
            { "id": "cam_main", "twitchRewardTitle": "Камера: Главная" },
            { "id": "cam_side", "twitchRewardTitle": "  Камера: Боковая  " },
        ]);
        assert_eq!(
            match_camera_angle(&angles, &json!("камера: главная")).expect("ракурс")["id"],
            json!("cam_main")
        );
        assert_eq!(
            match_camera_angle(&angles, &json!("  КАМЕРА: БОКОВАЯ ")).expect("ракурс")["id"],
            json!("cam_side")
        );
        // Пустая награда и отсутствие названия — не совпадение.
        assert!(match_camera_angle(&angles, &json!("")).is_none());
        assert!(match_camera_angle(&angles, &Value::Null).is_none());
        assert!(match_camera_angle(&json!([{ "id": "x" }]), &json!("Камера")).is_none());
    }

    #[test]
    fn a_reward_rule_is_found_by_id_and_by_title() {
        let rewards = json!([
            { "id": "r1", "rewardId": "abc", "rewardTitle": "Песня" },
            { "id": "r2", "rewardId": "def", "rewardTitle": "Сцена" },
        ]);
        assert_eq!(
            find_reward_rule(&rewards, &json!("abc"), &Value::Null).expect("правило")["id"],
            json!("r1")
        );
        assert_eq!(
            find_reward_rule(&rewards, &json!(""), &json!("сцена")).expect("правило")["id"],
            json!("r2")
        );
        // Ни id, ни названия — искать нечего.
        assert!(find_reward_rule(&rewards, &json!(""), &json!("  ")).is_none());
        // Чужой id и чужие правила не совпадают.
        assert!(find_reward_rule(&rewards, &json!("нет"), &json!("нет")).is_none());
        assert!(find_reward_rule(&Value::Null, &json!("abc"), &Value::Null).is_none());
    }

    #[test]
    fn reward_placeholders_fill_defaults() {
        assert_eq!(
            fill_reward_placeholders(
                &json!("{user} просит {reward}: {input}"),
                "Вася",
                "Песня",
                "abc"
            ),
            "Вася просит Песня: abc"
        );
        assert_eq!(
            fill_reward_placeholders(&json!("{user}"), "", "", ""),
            "Зритель"
        );
        assert_eq!(fill_reward_placeholders(&Value::Null, "Вася", "П", "и"), "");
    }

    #[test]
    fn reward_actions_emit_alert_tts_and_scene() {
        let config = json!({
            "twitchRewards": [
                {
                    "rewardId": "abc",
                    "rewardTitle": "Песня",
                    "alert": true,
                    "alertMessage": "{user}: {input}",
                    "tts": true,
                    "scene": "Music",
                },
            ],
        });
        let events = reward_actions(&config, &json!("abc"), &json!("Песня"), "Вася", "включи");
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["type"], json!("alert"));
        assert_eq!(events[0]["payload"]["kind"], json!("reward"));
        assert_eq!(events[0]["payload"]["message"], json!("Вася: включи"));
        assert_eq!(events[0]["payload"]["rewardTitle"], json!("Песня"));
        assert_eq!(events[1]["type"], json!("reward_tts"));
        assert_eq!(events[1]["payload"]["text"], json!("Вася: включи"));
        assert_eq!(events[2]["type"], json!("reward_scene_request"));
        assert_eq!(events[2]["payload"]["scene"], json!("Music"));
    }

    #[test]
    fn reward_tts_falls_back_to_the_alert_message() {
        let config = json!({
            "twitchRewards": [
                { "rewardId": "abc", "tts": true, "alertMessage": "{user} молодец" },
            ],
        });
        let events = reward_actions(&config, &json!("abc"), &Value::Null, "Вася", "");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], json!("reward_tts"));
        assert_eq!(events[0]["payload"]["text"], json!("Вася молодец"));
    }

    #[test]
    fn an_unknown_reward_does_nothing() {
        let config = json!({ "twitchRewards": [] });
        assert!(reward_actions(&config, &json!("abc"), &Value::Null, "Вася", "").is_empty());
    }

    #[test]
    fn a_follow_becomes_an_alert_and_a_stat_delta() {
        let events = notification_events(
            &json!({}),
            &json!({
                "subscription": { "type": "channel.follow" },
                "event": { "user_name": "nova" },
            }),
        );
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], json!("alert"));
        assert_eq!(
            events[0]["payload"],
            json!({ "kind": "follow", "user": "nova" })
        );
        assert_eq!(
            events[1],
            json!({ "type": "stat_delta", "payload": { "followerDelta": 1 } })
        );
    }

    #[test]
    fn a_gifted_subscription_alone_does_not_produce_a_sub_alert() {
        let events = notification_events(
            &json!({}),
            &json!({
                "subscription": { "type": "channel.subscribe" },
                "event": { "user_name": "recipient", "is_gift": true },
            }),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn gift_and_cheer_use_the_anonymous_name() {
        let gift = notification_events(
            &json!({}),
            &json!({
                "subscription": { "type": "channel.subscription.gift" },
                "event": { "is_anonymous": true, "total": 5, "tier": "1000" },
            }),
        );
        assert_eq!(gift[0]["payload"]["user"], json!("Аноним"));
        assert_eq!(gift[0]["payload"]["count"], json!(5));
        assert_eq!(gift[1]["payload"]["subscriberDelta"], json!(5));

        let cheer = notification_events(
            &json!({}),
            &json!({
                "subscription": { "type": "channel.cheer" },
                "event": { "is_anonymous": false, "user_name": "fan", "bits": 250 },
            }),
        );
        assert_eq!(cheer.len(), 1);
        assert_eq!(cheer[0]["payload"]["kind"], json!("cheer"));
        assert_eq!(cheer[0]["payload"]["amount"], json!(250));
    }

    #[test]
    fn a_redemption_routes_to_soundboard_camera_and_reward() {
        let config = json!({
            "twitchRewards": [
                { "rewardId": "rw", "alert": true, "alertMessage": "{user}" },
            ],
            "soundboard": {
                "sounds": [
                    { "id": "s1", "rewardTitle": "Барабаны", "title": "Драм", "audioFile": "a.mp3", "imageFile": "a.png" },
                ],
            },
            "obs": {
                "cameraAngles": [ { "id": "cam_main", "twitchRewardTitle": "Камера" } ],
                "cameraFilters": [ { "id": "f1", "twitchRewardTitle": "Сепия" } ],
            },
        });
        let events = notification_events(
            &config,
            &json!({
                "subscription": { "type": "channel.channel_points_custom_reward_redemption.add" },
                "event": {
                    "user_name": "Вася",
                    "user_input": "сюда",
                    "reward": { "id": "rw", "title": "Камера" },
                },
            }),
        );
        let kinds: Vec<&str> = events
            .iter()
            .map(|event| event["type"].as_str().unwrap_or_default())
            .collect();
        // Алерт за награду + ракурс камеры; саундборд — по названию «Барабаны»
        // не совпал, фильтр «Сепия» тоже.
        assert_eq!(kinds, ["alert", "camera_angle_request"]);
        let angle = events
            .iter()
            .find(|event| event["type"] == json!("camera_angle_request"))
            .unwrap();
        assert_eq!(angle["payload"]["angleId"], json!("cam_main"));
        assert_eq!(angle["payload"]["user"], json!("Вася"));
    }

    #[test]
    fn a_soundboard_reward_by_title_plays() {
        let config = json!({
            "soundboard": {
                "sounds": [
                    { "id": "s1", "rewardTitle": "Барабаны", "audioFile": "a.mp3", "videoFile": "a.webm" },
                ],
            },
        });
        let events = notification_events(
            &config,
            &json!({
                "subscription": { "type": "channel.channel_points_custom_reward_redemption.add" },
                "event": {
                    "user_name": "Вася",
                    "reward": { "id": "rw", "title": "барабаны" },
                },
            }),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], json!("soundboard_play"));
        assert_eq!(events[0]["payload"]["soundId"], json!("s1"));
        assert_eq!(events[0]["payload"]["title"], json!("Барабаны"));
        assert_eq!(events[0]["payload"]["user"], json!("Вася"));
        // Видео звука оверлей берёт из `videoFile` — его нельзя терять по пути.
        assert_eq!(events[0]["payload"]["videoFile"], json!("a.webm"));
    }

    #[test]
    fn event_sub_messages_are_recognized() {
        assert_eq!(
            parse_message(
                r#"{ "metadata": { "message_type": "session_welcome" }, "payload": { "session": { "id": "s1" } } }"#
            ),
            EventSubMessage::Welcome("s1".to_string())
        );
        assert_eq!(
            parse_message(
                r#"{ "metadata": { "message_type": "session_reconnect" }, "payload": { "session": { "reconnect_url": "wss://new" } } }"#
            ),
            EventSubMessage::Reconnect("wss://new".to_string())
        );
        assert_eq!(
            parse_message(r#"{ "metadata": { "message_type": "session_keepalive" } }"#),
            EventSubMessage::Keepalive
        );
        // Уведомление отдаёт нагрузку целиком — её разбирает `notification_events`.
        match parse_message(
            r#"{ "metadata": { "message_type": "notification" }, "payload": { "subscription": { "type": "channel.follow" }, "event": {} } }"#,
        ) {
            EventSubMessage::Notification(payload) => {
                assert_eq!(payload["subscription"]["type"], json!("channel.follow"));
            }
            other => panic!("ожидалось уведомление, пришло {other:?}"),
        }
        assert_eq!(parse_message("не json"), EventSubMessage::Other);
        assert_eq!(
            parse_message(r#"{ "metadata": { "message_type": "revocation" } }"#),
            EventSubMessage::Other
        );
    }
}
