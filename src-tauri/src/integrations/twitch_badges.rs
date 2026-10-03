//! Значки Twitch для чата: наборы из Helix `/chat/badges` и адреса картинок.
//!
//! IRC отдаёт значок только парой «имя набора/версия» (`subscriber/12`) — без
//! картинки: файл на CDN адресуется UUID версии, а не именем. Поэтому наборы
//! значков (глобальные и канальные) один раз забираются через Helix и
//! кэшируются, а в кадр `chat_message` кладутся готовые адреса (`badgeImages`)
//! в том же порядке, что и имена (`badges`). Фронт рисует картинку, если адрес
//! есть, иначе оставляет прежнюю букву — как умел до этого.

use std::collections::HashMap;

use serde_json::Value;

/// «имя набора значков → версия → адрес картинки».
pub type BadgeMap = HashMap<String, HashMap<String, String>>;

/// Разобрать ответ Helix `/chat/badges`:
/// `{ "data": [ { "set_id": "subscriber", "versions": [ { "id": "12", "image_url_2x": "…" } ] } ] }`.
///
/// Из адресов берём 2x (значок показывается мелким, 1x мылит), при его
/// отсутствии — любой доступный.
pub fn parse_badge_sets(body: &Value) -> BadgeMap {
    let mut map = BadgeMap::new();
    let Some(sets) = body.get("data").and_then(Value::as_array) else {
        return map;
    };

    for set in sets {
        let set_id = set.get("set_id").and_then(Value::as_str).unwrap_or("");
        let Some(versions) = set.get("versions").and_then(Value::as_array) else {
            continue;
        };
        if set_id.is_empty() {
            continue;
        }

        let mut parsed: HashMap<String, String> = HashMap::new();
        for version in versions {
            let id = version.get("id").and_then(Value::as_str).unwrap_or("");
            let url = ["image_url_2x", "image_url_1x", "image_url_4x"]
                .iter()
                .find_map(|key| version.get(*key).and_then(Value::as_str))
                .unwrap_or("");
            if id.is_empty() || url.is_empty() {
                continue;
            }
            parsed.insert(id.to_string(), url.to_string());
        }
        // Набор без единой версии — мусор в ответе, а не пустая запись в карте.
        if parsed.is_empty() {
            continue;
        }
        map.entry(set_id.to_string()).or_default().extend(parsed);
    }
    map
}

/// Дополнить карту наборами канала: одноимённые наборы перекрывают глобальные.
pub fn merge_badges(base: &mut BadgeMap, extra: BadgeMap) {
    for (set_id, versions) in extra {
        let entry = base.entry(set_id).or_default();
        for (version, url) in versions {
            entry.insert(version, url);
        }
    }
}

/// Адрес картинки значка: точная версия → «1» → младшая из имеющихся.
///
/// Запасные варианты нужны потому, что наборы Twitch меняются (например, у саба
/// с новым стажем может не оказаться версии из тега), а значок лучше показать
/// хоть какой-то, чем буквой.
pub fn badge_image(map: &BadgeMap, set_id: &str, version: &str) -> Option<String> {
    let versions = map.get(set_id)?;
    if let Some(url) = versions.get(version) {
        return Some(url.clone());
    }
    if let Some(url) = versions.get("1") {
        return Some(url.clone());
    }
    let mut candidates: Vec<(&String, &String)> = versions.iter().collect();
    candidates.sort_by(|a, b| a.0.len().cmp(&b.0.len()).then_with(|| a.0.cmp(b.0)));
    candidates.first().map(|(_, url)| (*url).clone())
}

/// Положить в кадр чата `badgeImages` — по адресу на каждое имя из `badges`
/// (порядок тот же, `null` — картинки нет). Версии берутся из `badgeVersions`,
/// которые кладёт `chat_message_from_tags`.
pub fn add_badge_images(map: &BadgeMap, message: &mut Value) {
    let Some(object) = message.as_object() else {
        return;
    };
    let names = object
        .get("badges")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if names.is_empty() {
        return;
    }
    let versions = object
        .get("badgeVersions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let images: Vec<Value> = names
        .iter()
        .map(|name| {
            let name = name.as_str().unwrap_or("");
            let version = versions.get(name).and_then(Value::as_str).unwrap_or("1");
            badge_image(map, name, version)
                .map(Value::from)
                .unwrap_or(Value::Null)
        })
        .collect();

    if let Some(object) = message.as_object_mut() {
        object.insert("badgeImages".to_string(), Value::Array(images));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "data": [
                {
                    "set_id": "subscriber",
                    "versions": [
                        { "id": "0", "image_url_1x": "sub0/1", "image_url_4x": "sub0/4" },
                        { "id": "12", "image_url_2x": "sub12/2" },
                    ],
                },
                { "set_id": "moderator", "versions": [{ "id": "1", "image_url_2x": "mod/2" }] },
            ],
        })
    }

    #[test]
    fn sets_parse_into_versions_with_urls() {
        let map = parse_badge_sets(&sample());
        assert_eq!(map["subscriber"]["12"], json!("sub12/2"));
        // Без 2x берётся 1x.
        assert_eq!(map["subscriber"]["0"], json!("sub0/1"));
        assert_eq!(map["moderator"]["1"], json!("mod/2"));
    }

    #[test]
    fn broken_sets_are_skipped() {
        let map = parse_badge_sets(&json!({
            "data": [
                { "versions": [{ "id": "1", "image_url_2x": "x" }] },
                { "set_id": "vip", "versions": [{ "id": "", "image_url_2x": "x" }] },
                { "set_id": "founder", "versions": [{ "id": "1" }] },
            ],
        }));
        assert!(map.is_empty(), "{map:?}");
    }

    #[test]
    fn channel_sets_override_global_ones() {
        let mut base = parse_badge_sets(&sample());
        merge_badges(
            &mut base,
            parse_badge_sets(&json!({
                "data": [{ "set_id": "subscriber", "versions": [{ "id": "12", "image_url_2x": "own" }] }],
            })),
        );
        assert_eq!(base["subscriber"]["12"], json!("own"));
        // Остальные версии набора сохраняются.
        assert_eq!(base["subscriber"]["0"], json!("sub0/1"));
    }

    #[test]
    fn missing_version_falls_back_to_one_then_to_any() {
        let map = parse_badge_sets(&sample());
        assert_eq!(
            badge_image(&map, "subscriber", "12").as_deref(),
            Some("sub12/2")
        );
        // Версии нет — берём «1»; в наборе её нет — младшую по длине.
        assert_eq!(
            badge_image(&map, "subscriber", "99").as_deref(),
            Some("sub0/1")
        );
        // Незнакомый набор — ничего.
        assert_eq!(badge_image(&map, "vip", "1"), None);
    }

    #[test]
    fn images_line_up_with_names() {
        let mut map = BadgeMap::new();
        let mut moderator = HashMap::new();
        moderator.insert("1".to_string(), "mod/2".to_string());
        map.insert("moderator".to_string(), moderator);

        let mut message = json!({
            "badges": ["moderator", "vip"],
            "badgeVersions": { "moderator": "1", "vip": "1" },
        });
        add_badge_images(&map, &mut message);

        assert_eq!(message["badgeImages"], json!(["mod/2", null]));
    }

    #[test]
    fn a_message_without_badges_is_untouched() {
        let map = BadgeMap::new();
        let mut message = json!({ "badges": [], "message": "hi" });
        add_badge_images(&map, &mut message);
        assert!(message.get("badgeImages").is_none());
    }
}
