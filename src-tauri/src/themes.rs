//! Встроенные темы и 3D-стили: цвета, шрифты и форма панелей оверлея.
//!
//! Порт данных `shared/themes.js` (та же тема оформления, что видят панель,
//! редактор тем и оверлей). Логики здесь нет: `themes.js` экспортирует только
//! данные, а сборка токенов из семян (для своих тем) живёт в `shared/theme-engine.js`
//! и переносится отдельно — `theme_engine.rs`.
//!
//! Данные, как и каталог виджетов, **сняты с JS-файла** скриптом
//! `tools/build-themes.mjs`: десять тем по три-четыре десятка токенов руками
//! копировать нельзя. Рядом лежит отпечаток исходника; тест сверяет его и
//! говорит, что пересобрать.

use std::sync::OnceLock;

use serde_json::{Map, Value};

/// Данные, снятые с `shared/themes.js`.
const THEMES_JSON: &str = include_str!("../themes_data.json");

/// Путь к исходнику тем — по нему тест ищет отпечаток.
pub const SOURCE_FILE: &str = "shared/themes.js";

/// Как пересобрать данные после правки тем.
pub const REBUILD_COMMAND: &str = "node src-tauri/tools/build-themes.mjs";

/// Разобранные темы.
pub struct Themes {
    data: Value,
}

impl Themes {
    /// Темы на весь процесс: разбираются один раз, дальше только читаются.
    pub fn get() -> &'static Themes {
        static THEMES: OnceLock<Themes> = OnceLock::new();
        THEMES.get_or_init(|| Themes::parse(THEMES_JSON).expect("данные тем"))
    }

    fn parse(text: &str) -> Option<Themes> {
        let data: Value = serde_json::from_str(text).ok()?;
        // Обязательные части: без них тема нечего показывать, и лучше упасть здесь.
        data.get("builtinThemes")?.as_object()?;
        data.get("threeDStyles")?.as_array()?;
        Some(Themes { data })
    }

    /// Отпечаток JS-файла, с которого сняты данные.
    pub fn source_hash(&self) -> &str {
        self.data
            .get("sourceHash")
            .and_then(Value::as_str)
            .unwrap_or_default()
    }

    fn builtin(&self) -> &Map<String, Value> {
        self.data
            .get("builtinThemes")
            .and_then(Value::as_object)
            .expect("проверено при разборе")
    }

    fn styles(&self) -> &Vec<Value> {
        self.data
            .get("threeDStyles")
            .and_then(Value::as_array)
            .expect("проверено при разборе")
    }
}

/// Темы на весь процесс.
pub fn themes() -> &'static Themes {
    Themes::get()
}

/// Встроенная тема по идентификатору.
///
/// Своих тем здесь нет: они лежат в настройках пользователя (`appearance.customThemes`).
pub fn builtin_theme(id: &str) -> Option<&'static Value> {
    themes().builtin().get(id)
}

/// Идентификаторы встроенных тем в порядке объявления.
pub fn builtin_ids() -> Vec<&'static str> {
    themes().builtin().keys().map(String::as_str).collect()
}

/// Токены встроенной темы: цвета, шрифты, форма панелей и анимация алертов.
pub fn tokens(id: &str) -> Option<&'static Value> {
    builtin_theme(id)?.get("tokens")
}

/// 3D-стили, доступные для выбора: `id` совпадает с `theme` 3D-виджетов каталога.
pub fn three_d_styles() -> Vec<&'static Value> {
    themes().styles().iter().collect()
}

/// Встроенная ли тема: по этому признаку панель отличает свои темы от встроенных
/// (см. `catalog::theme_allows_widget` — в своих темах доступен тег `custom`).
pub fn is_builtin(id: &str) -> bool {
    builtin_theme(id).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog;
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    /// FNV-1a 64 по UTF-8 — тот же счёт, что в `tools/fingerprint.mjs`.
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
            themes().source_hash(),
            fnv1a(&source),
            "{SOURCE_FILE} изменился — пересоберите данные тем: {REBUILD_COMMAND}"
        );
    }

    #[test]
    fn every_builtin_theme_has_what_the_panel_shows() {
        let ids = builtin_ids();
        assert!(ids.len() >= 8, "тем подозрительно мало: {ids:?}");

        for id in &ids {
            let theme = builtin_theme(id).expect("тема");
            assert_eq!(theme["id"], serde_json::json!(id));
            assert!(
                theme["name"].as_str().is_some_and(|name| !name.is_empty()),
                "{id}"
            );
            assert_eq!(theme["builtin"], serde_json::json!(true));
            assert!(theme["category"].as_str().is_some(), "{id}");
            assert!(
                matches!(theme["dimension"].as_str(), Some("2d") | Some("3d")),
                "{id}"
            );
        }

        assert!(!is_builtin("нет-такой"));
        assert!(builtin_theme("нет-такой").is_none());
        assert!(tokens("нет-такой").is_none());
    }

    #[test]
    fn builtin_tokens_are_filled_in() {
        let tokens = tokens("nebula").expect("токены nebula");

        // Цвета, шрифты и форма — всё, чем оверлей рисует панели.
        assert_eq!(tokens["--md-primary"], serde_json::json!("#94cbf9"));
        assert_eq!(tokens["--md-on-primary"], serde_json::json!("#0f283d"));
        assert_eq!(tokens["--md-surface"], serde_json::json!("#101114"));
        assert!(
            tokens["--font-display"]
                .as_str()
                .is_some_and(|font| !font.is_empty()),
            "нет шрифта заголовка"
        );
        assert!(
            tokens["--panel-radius"].as_str().is_some(),
            "нет радиуса панели"
        );
        assert!(
            tokens["--alert-enter-duration"].as_str().is_some(),
            "нет длительности входа алерта"
        );
    }

    #[test]
    fn three_d_styles_cover_exactly_the_catalog_three_d_themes() {
        // Перенесено из `tests/widget-catalog.test.js`: наборы 3D-виджетов и
        // список выбора должны совпадать — иначе в панели появится стиль без
        // виджетов или пропадёт стиль, виджеты которого уже есть в раскладке.
        let styles: BTreeSet<String> = three_d_styles()
            .iter()
            .filter_map(|style| style["id"].as_str())
            .map(str::to_string)
            .collect();
        assert!(!styles.is_empty(), "3D-стилей нет");

        let catalog_themes: BTreeSet<String> = catalog::kinds()
            .iter()
            .filter_map(|kind| catalog::def(kind))
            .filter(|def| def["dimension"] == serde_json::json!("3d"))
            .filter_map(|def| def["theme"].as_str())
            .map(str::to_string)
            .collect();

        assert_eq!(
            styles, catalog_themes,
            "3D-стили разошлись с каталогом виджетов"
        );
        for id in &styles {
            assert!(
                !catalog::widgets_for_theme(id).is_empty(),
                "у стиля {id} нет ни одного 3D-виджета"
            );
        }
    }
}
