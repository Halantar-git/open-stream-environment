//! Каталог виджетов: что можно поставить на оверлей и с какими умолчаниями.
//!
//! Порт `shared/widget-catalog.js`. Каталог один на фронт и бэкенд: панель по нему
//! рисует библиотеку виджетов и ограничивает размеры мышью, а сервер — по нему же
//! создаёт виджет (`cmd_add_widget`), ограничивает размеры при сохранении и
//! сопоставляет 2D-виджеты с 3D-вариантами активной темы.
//!
//! Данные **не переписаны руками**: их снимает с JS-файла скрипт
//! `tools/build-widget-catalog.mjs` в `catalog_data.json` — ~45 видов по десятку
//! полей, и один неверный `minW` тихо разошёлся бы с фронтом. Вместе с данными
//! лежит отпечаток исходника (FNV-1a 64); тест сверяет его и говорит, что делать,
//! если каталог в JS поправили, а данные не пересобрали. Сами правила
//! (`widgets_for_theme`, `widget_role`, `resolve_type_for_theme`, …) повторяют
//! JS-версию построчно — их проверяет перенесённый набор `widget-catalog`.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use serde_json::{json, Map, Value};

use crate::storage::history::js_truthy;

/// Данные, снятые с `shared/widget-catalog.js`.
const CATALOG_JSON: &str = include_str!("../catalog_data.json");

/// Путь к исходнику каталога — по нему тест ищет отпечаток.
pub const SOURCE_FILE: &str = "shared/widget-catalog.js";

/// Как пересобрать данные после правки каталога.
pub const REBUILD_COMMAND: &str = "node src-tauri/tools/build-widget-catalog.mjs";

/// Чем задан активный 3D-набор: встроенный вариант темы или явный список
/// виджетов (своя тема — там набор произвольный).
#[derive(Debug, Clone, Copy)]
pub enum Variant<'a> {
    /// Идентификатор встроенной 3D-темы; пусто — 3D выключен.
    Builtin(&'a str),
    /// Явно включённые виды виджетов.
    Set(&'a [String]),
}

/// Разобранный каталог: данные плюс то, что удобнее держать готовым.
pub struct Catalog {
    data: Value,
    animated: BTreeSet<String>,
}

impl Catalog {
    /// Каталог на весь процесс: разбирается один раз, дальше только читается.
    pub fn get() -> &'static Catalog {
        static CATALOG: OnceLock<Catalog> = OnceLock::new();
        CATALOG.get_or_init(|| Catalog::parse(CATALOG_JSON).expect("данные каталога виджетов"))
    }

    fn parse(text: &str) -> Option<Catalog> {
        let data: Value = serde_json::from_str(text).ok()?;
        // Обязательные части: без них каталог бесполезен, и лучше упасть здесь.
        data.get("widgetTypes")?.as_object()?;
        data.get("canvas")?.as_object()?;
        let animated = data
            .get("animatedTypes")?
            .as_array()?
            .iter()
            .map(|value| value.as_str().map(str::to_string))
            .collect::<Option<BTreeSet<_>>>()?;
        Some(Catalog { data, animated })
    }

    /// Отпечаток JS-файла, с которого сняты данные.
    pub fn source_hash(&self) -> &str {
        self.data
            .get("sourceHash")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    fn widget_types(&self) -> &Map<String, Value> {
        self.data
            .get("widgetTypes")
            .and_then(Value::as_object)
            .expect("проверено при разборе")
    }

    fn canvas(&self) -> &Value {
        self.data.get("canvas").expect("проверено при разборе")
    }
}

/// Каталог на весь процесс.
pub fn catalog() -> &'static Catalog {
    Catalog::get()
}

/// Всё, что известно о виде виджета.
pub fn def(kind: &str) -> Option<&'static Value> {
    catalog().widget_types().get(kind)
}

/// Виды виджетов в порядке каталога — как `Object.keys(WIDGET_TYPES)`.
pub fn kinds() -> Vec<&'static str> {
    catalog()
        .widget_types()
        .keys()
        .map(String::as_str)
        .collect()
}

/// Размер холста, в процентах которого задана геометрия виджетов.
pub fn canvas() -> &'static Value {
    catalog().canvas()
}

/// Минимальные размеры виджета — по ним ограничивают растягивание.
pub fn min_size(kind: &str) -> Option<(f64, f64)> {
    let def = def(kind)?;
    Some((def.get("minW")?.as_f64()?, def.get("minH")?.as_f64()?))
}

/// Геометрия по умолчанию: где виджет появляется, когда его только добавили.
pub fn default_geometry(kind: &str) -> Option<&'static Value> {
    def(kind)?.get("defaultGeometry")
}

/// Настройки по умолчанию; у незнакомого вида — пустой объект.
pub fn default_config(kind: &str) -> Value {
    def(kind)
        .and_then(|def| def.get("defaultConfig"))
        .cloned()
        .unwrap_or_else(|| json!({}))
}

/// 3D-виджеты темы: `Object.values(WIDGET_TYPES).filter(...)`.
pub fn widgets_for_theme(theme_id: &str) -> Vec<&'static Value> {
    if theme_id.is_empty() {
        return Vec::new();
    }
    catalog()
        .widget_types()
        .values()
        .filter(|def| {
            def.get("dimension").and_then(Value::as_str) == Some("3d")
                && def.get("theme").and_then(Value::as_str) == Some(theme_id)
        })
        .collect()
}

/// Доступен ли виджет в активной теме.
///
/// `appearance` — форма снимка состояния: `{ activeThemeId, themes: [{ id, builtin }] }`.
/// Виджет без привязки (`themes` нет или пуст) доступен везде; `custom` в списке
/// означает «и в своих темах тоже».
pub fn theme_allows_widget(def: &Value, appearance: &Value) -> bool {
    let Some(themes) = def
        .get("themes")
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
    else {
        return true;
    };

    let theme_id = appearance
        .get("activeThemeId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let active = appearance
        .get("themes")
        .and_then(Value::as_array)
        .and_then(|list| {
            list.iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(theme_id))
        });
    // Своя тема — та, которой нет среди встроенных.
    let is_custom = active.is_some_and(|item| !js_truthy(item.get("builtin")));
    let has = |id: &str| themes.iter().any(|theme| theme.as_str() == Some(id));
    if is_custom && has("custom") {
        return true;
    }
    !theme_id.is_empty() && has(theme_id)
}

/// Какой 2D-виджет заменяет 3D-вариант: `*-chat` → `chat` и так далее.
///
/// Вывески, радары и щиты ничего не заменяют — они аддитивные.
pub fn replaced_by_3d(kind: &str) -> Option<&'static str> {
    if kind.is_empty() {
        return None;
    }
    if kind.ends_with("-chat") {
        return Some("chat");
    }
    if kind.ends_with("-goal") {
        return Some("goal");
    }
    if kind.ends_with("-holo-alert") {
        return Some("alerts");
    }
    if kind.ends_with("-timer") {
        return Some("timer");
    }
    None
}

/// Роль виджета для кросс-темной подмены: 2D-база, её 3D-варианты и декоративные
/// вывески/радары/щиты делят одну роль.
///
/// Виджеты без роли строго привязаны к своей теме.
pub fn widget_role(kind: &str) -> Option<String> {
    if kind.is_empty() {
        return None;
    }
    if matches!(kind, "chat" | "goal" | "alerts" | "timer") {
        return Some(kind.to_string());
    }
    if let Some(replaced) = replaced_by_3d(kind) {
        return Some(replaced.to_string());
    }
    def(kind)
        .and_then(|def| def.get("role"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Вид виджета, который представляет роль в явном наборе.
///
/// `None` — кандидатов нет или их несколько: тогда вызывающий оставляет виджет
/// как есть, а не гадает.
pub fn counterpart_type_for_role(role: &str, kinds: &[String]) -> Option<String> {
    if role.is_empty() {
        return None;
    }
    let matches: Vec<&String> = kinds
        .iter()
        .filter(|kind| widget_role(kind).as_deref() == Some(role))
        .collect();
    match matches.as_slice() {
        [only] => Some((*only).clone()),
        _ => None,
    }
}

/// Во что виджет превращается под активной темой.
///
/// Роль (чат, цель, алерты, таймер и декоративные вывески) следует за аналогом
/// активного 3D-набора; остальные виджеты остаются собой.
pub fn resolve_type_for_theme(
    kind: &str,
    variant: Variant<'_>,
    enabled3d: Option<&Map<String, Value>>,
) -> String {
    let Some(role) = widget_role(kind) else {
        return kind.to_string();
    };

    match variant {
        Variant::Set(types) => {
            counterpart_type_for_role(&role, types).unwrap_or_else(|| kind.to_string())
        }
        Variant::Builtin(variant_id) => {
            if variant_id.is_empty() {
                return kind.to_string(); // 3D выключен
            }
            let counterpart = widgets_for_theme(variant_id).into_iter().find(|def| {
                let counterpart_kind = def.get("type").and_then(Value::as_str).unwrap_or_default();
                widget_role(counterpart_kind).as_deref() == Some(role.as_str())
            });
            let Some(counterpart) = counterpart else {
                return kind.to_string(); // аналога в этой теме нет
            };
            let counterpart_kind = counterpart
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            // Аналог можно выключить отдельно — тогда остаётся исходный вид.
            if enabled3d
                .and_then(|map| map.get(&counterpart_kind))
                .is_some_and(|value| *value == Value::Bool(false))
            {
                return kind.to_string();
            }
            counterpart_kind
        }
    }
}

/// Держит ли виджет собственный canvas-цикл (тяжёлый для GPU).
pub fn is_animated(kind: &str) -> bool {
    catalog().animated.contains(kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn types_of(defs: &[&Value]) -> Vec<String> {
        defs.iter()
            .filter_map(|def| def.get("type").and_then(Value::as_str))
            .map(str::to_string)
            .collect()
    }

    fn builtin(id: &str) -> Variant<'_> {
        Variant::Builtin(id)
    }

    /// FNV-1a 64 по UTF-8 — тот же счёт, что в `build-widget-catalog.mjs`.
    fn fnv1a(bytes: &[u8]) -> String {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in bytes {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{hash:016x}")
    }

    #[test]
    fn the_data_was_taken_from_the_current_source_file() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri лежит в корне репозитория")
            .join(SOURCE_FILE);
        let source =
            std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));

        assert_eq!(
            catalog().source_hash(),
            fnv1a(&source),
            "{SOURCE_FILE} изменился — пересоберите данные каталога: {REBUILD_COMMAND}"
        );
    }

    #[test]
    fn the_catalog_has_what_the_editor_needs() {
        // Холст и виджеты на месте.
        assert_eq!(canvas()["w"], json!(1920));
        assert_eq!(canvas()["h"], json!(1080));
        assert!(
            kinds().len() > 30,
            "видов подозрительно мало: {}",
            kinds().len()
        );

        // Умолчания и ограничения читаются так же, как в JS-каталоге.
        assert_eq!(min_size("chat"), Some((16.0, 16.0)));
        assert_eq!(min_size("goal"), Some((16.0, 4.0)));
        assert_eq!(
            default_geometry("chat").expect("геометрия чата")["w"],
            json!(29)
        );
        assert_eq!(
            default_config("chat"),
            json!({ "maxMessages": 8, "showBadges": true })
        );
        // У незнакомого вида настроек нет — пустой объект, а не паника.
        assert_eq!(default_config("нет-такого"), json!({}));
        assert!(def("нет-такого").is_none());
    }

    #[test]
    fn only_widgets_with_a_canvas_loop_are_marked_animated() {
        // Тяжёлые: собственный rAF.
        for kind in [
            "mic",
            "grimhex-radar",
            "cobra-shield",
            "md3-orb",
            "pixel-cube",
            "teso-seal",
        ] {
            assert!(is_animated(kind), "{kind}");
        }
        // Лёгкие: DOM-only, без цикла.
        for kind in [
            "chat",
            "goal",
            "grimhex-chat",
            "teso-goal",
            "md3-holo-alert",
            "",
        ] {
            assert!(!is_animated(kind), "{kind}");
        }
    }

    #[test]
    fn three_d_variants_map_to_their_2d_counterparts() {
        assert_eq!(replaced_by_3d("md3-chat"), Some("chat"));
        assert_eq!(replaced_by_3d("grimhex-goal"), Some("goal"));
        assert_eq!(replaced_by_3d("nuclear-holo-alert"), Some("alerts"));
        assert_eq!(replaced_by_3d("cobra-chat"), Some("chat"));

        // Вывески, радары и щиты ничего не заменяют.
        assert_eq!(replaced_by_3d("md3-orb"), None);
        assert_eq!(replaced_by_3d("cobra-radar"), None);
        assert_eq!(replaced_by_3d("cobra-shield"), None);
        assert_eq!(replaced_by_3d("chat"), None);

        // Таймер: 3D-вариант заменяет 2D-таймер по роли.
        assert_eq!(replaced_by_3d("grimhex-timer"), Some("timer"));
    }

    #[test]
    fn widgets_for_theme_returns_the_theme_three_d_widgets() {
        let md3 = types_of(&widgets_for_theme("nebula"));
        assert_eq!(md3.len(), 4, "{md3:?}");
        for kind in ["md3-orb", "md3-chat", "md3-goal", "md3-holo-alert"] {
            assert!(md3.iter().any(|item| item == kind), "{kind} в {md3:?}");
        }

        let grimhex = types_of(&widgets_for_theme("grimhex"));
        for kind in [
            "grimhex",
            "musain",
            "grimhex-chat",
            "grimhex-goal",
            "grimhex-holo-alert",
            "grimhex-radar",
        ] {
            assert!(
                grimhex.iter().any(|item| item == kind),
                "{kind} в {grimhex:?}"
            );
        }

        assert!(widgets_for_theme("").is_empty());
    }

    #[test]
    fn widget_role_brings_2d_and_its_3d_variants_to_one_role() {
        // 2D-база и все 3D-варианты — одна роль.
        for kind in [
            "chat",
            "md3-chat",
            "grimhex-chat",
            "nuclear-chat",
            "cobra-chat",
            "pixel-chat",
        ] {
            assert_eq!(widget_role(kind).as_deref(), Some("chat"), "{kind}");
        }
        assert_eq!(widget_role("goal").as_deref(), Some("goal"));
        assert_eq!(widget_role("md3-goal").as_deref(), Some("goal"));
        assert_eq!(widget_role("grimhex-holo-alert").as_deref(), Some("alerts"));
        assert_eq!(widget_role("alerts").as_deref(), Some("alerts"));

        // Таймер: 2D-база и 3D-вариант — одна роль.
        assert_eq!(widget_role("timer").as_deref(), Some("timer"));
        assert_eq!(widget_role("grimhex-timer").as_deref(), Some("timer"));

        // Декоративные вывески роль имеют, вторичные — нет: они аддитивные и при
        // смене темы просто скрываются.
        for kind in ["grimhex", "nuclear", "cobra", "md3-orb", "pixel-cube"] {
            assert_eq!(widget_role(kind).as_deref(), Some("sign"), "{kind}");
        }
        assert_eq!(widget_role("musain"), None);
        assert_eq!(widget_role("elite-sign"), None);
        assert_eq!(widget_role("grimhex-radar").as_deref(), Some("radar"));
        assert_eq!(widget_role("cobra-radar").as_deref(), Some("radar"));
        assert_eq!(widget_role("cobra-shield").as_deref(), Some("shield"));

        // Без роли: остальные 2D-виджеты.
        assert_eq!(widget_role("recent"), None);
        assert_eq!(widget_role("custom"), None);
        assert_eq!(widget_role(""), None);
    }

    #[test]
    fn resolve_type_for_theme_swaps_a_role_for_the_active_three_d_variant() {
        // 3D включён: 2D-роль и чужой 3D-вариант сводятся к аналогу темы.
        assert_eq!(
            resolve_type_for_theme("chat", builtin("nebula"), None),
            "md3-chat"
        );
        assert_eq!(
            resolve_type_for_theme("md3-chat", builtin("grimhex"), None),
            "grimhex-chat"
        );
        assert_eq!(
            resolve_type_for_theme("alerts", builtin("pixel"), None),
            "pixel-holo-alert"
        );
        assert_eq!(
            resolve_type_for_theme("goal", builtin("cobra-mk2"), None),
            "cobra-goal"
        );

        // 3D выключен или аналог отключён — остаётся исходный вид.
        assert_eq!(resolve_type_for_theme("chat", builtin(""), None), "chat");
        assert_eq!(
            resolve_type_for_theme("md3-chat", builtin(""), None),
            "md3-chat"
        );
        let disabled = Map::from_iter([("md3-chat".to_string(), Value::Bool(false))]);
        assert_eq!(
            resolve_type_for_theme("chat", builtin("nebula"), Some(&disabled)),
            "chat"
        );

        // Без роли — не меняется.
        assert_eq!(
            resolve_type_for_theme("md3-orb", builtin("nebula"), None),
            "md3-orb"
        );
        assert_eq!(
            resolve_type_for_theme("recent", builtin("nebula"), None),
            "recent"
        );

        // Декоративные вывески тоже следуют за темой.
        assert_eq!(
            resolve_type_for_theme("grimhex", builtin("cobra-mk2"), None),
            "cobra"
        );
        assert_eq!(
            resolve_type_for_theme("md3-orb", builtin("pixel"), None),
            "pixel-cube"
        );
        assert_eq!(
            resolve_type_for_theme("grimhex-radar", builtin("cobra-mk2"), None),
            "cobra-radar"
        );
        // Нет аналога в активной теме — остаётся исходный вид (его скроют).
        assert_eq!(
            resolve_type_for_theme("cobra-shield", builtin("grimhex"), None),
            "cobra-shield"
        );

        // 2D-таймер подменяется Grim HEX-вариантом при активной 3D-теме.
        assert_eq!(
            resolve_type_for_theme("timer", builtin("grimhex"), None),
            "grimhex-timer"
        );
        assert_eq!(resolve_type_for_theme("timer", builtin(""), None), "timer");
    }

    #[test]
    fn resolve_type_for_theme_takes_an_explicit_widget_set() {
        let unique = ["teso-chat".to_string(), "cobra-radar".to_string()];
        let set = Variant::Set(&unique);
        assert_eq!(resolve_type_for_theme("chat", set, None), "teso-chat");
        let goal = ["teso-goal".to_string()];
        assert_eq!(
            resolve_type_for_theme("goal", Variant::Set(&goal), None),
            "teso-goal"
        );

        // Несколько кандидатов одной роли — неоднозначно, вид не меняется.
        let ambiguous = ["teso-chat".to_string(), "cobra-chat".to_string()];
        assert_eq!(
            resolve_type_for_theme("chat", Variant::Set(&ambiguous), None),
            "chat"
        );
        assert_eq!(
            resolve_type_for_theme("md3-chat", Variant::Set(&ambiguous), None),
            "md3-chat"
        );

        // Пустой набор — без изменений; виджеты без роли не трогаем.
        assert_eq!(
            resolve_type_for_theme("chat", Variant::Set(&[]), None),
            "chat"
        );
        let one = ["teso-chat".to_string()];
        assert_eq!(
            resolve_type_for_theme("recent", Variant::Set(&one), None),
            "recent"
        );
    }

    #[test]
    fn every_three_d_widget_names_its_theme() {
        for (name, def) in catalog().widget_types() {
            if def.get("dimension").and_then(Value::as_str) == Some("3d") {
                assert!(
                    def.get("theme")
                        .and_then(Value::as_str)
                        .is_some_and(|theme| !theme.is_empty()),
                    "у 3D-виджета {name} нет темы"
                );
                assert!(
                    !widgets_for_theme(
                        def.get("theme").and_then(Value::as_str).unwrap_or_default()
                    )
                    .is_empty(),
                    "тема виджета {name} не даёт ни одного 3D-виджета"
                );
            }
        }
    }

    #[test]
    fn theme_allows_widget_lets_the_timer_into_orbital_and_custom_themes() {
        let timer = def("timer").expect("таймер");
        let themes = json!([
            { "id": "nebula", "builtin": true },
            { "id": "orbital", "builtin": true },
            { "id": "pixel", "builtin": true },
            { "id": "custom-1", "builtin": false },
        ]);

        assert!(theme_allows_widget(
            timer,
            &json!({ "activeThemeId": "orbital", "themes": themes })
        ));
        assert!(theme_allows_widget(
            timer,
            &json!({ "activeThemeId": "custom-1", "themes": themes })
        ));
        assert!(!theme_allows_widget(
            timer,
            &json!({ "activeThemeId": "nebula", "themes": themes })
        ));
        assert!(!theme_allows_widget(
            timer,
            &json!({ "activeThemeId": "pixel", "themes": themes })
        ));
        // Своя тема не подтверждена списком — считаем встроенной.
        assert!(!theme_allows_widget(
            timer,
            &json!({ "activeThemeId": "custom-1" })
        ));

        // Виджеты без привязки доступны в любой теме.
        let chat = def("chat").expect("чат");
        assert!(theme_allows_widget(
            chat,
            &json!({ "activeThemeId": "nebula", "themes": themes })
        ));
        assert!(theme_allows_widget(chat, &Value::Null));
        assert!(theme_allows_widget(
            &Value::Null,
            &json!({ "activeThemeId": "orbital" })
        ));
    }
}
