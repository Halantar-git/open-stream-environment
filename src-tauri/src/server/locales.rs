//! Словари интерфейса: сервер шлёт их клиенту первым кадром.
//!
//! Порт `LOCALES` из `server/index.js`: панель и окна берут перевод из этих
//! данных, а не грузят `shared/locales/*.json` сами. Файлы читаются из
//! репозитория при старте — те же, что отдаёт статика, поэтому расхождения между
//! тем, что показывает сервер, и тем, что лежит в поставке, быть не может.
//!
//! Если файл не прочитался, кадр не отправляется: пустой словарь панель поняла
//! бы как «переводов нет» и показала бы ключи вместо текста — лучше честно
//! промолчать, а причину записать в журнал.

use std::path::Path;

use serde_json::{json, Value};

/// Загруженные словари.
pub struct Locales {
    ru: Value,
    en: Value,
}

impl Locales {
    /// Прочитать словари из `shared/locales/`. `None`, если хотя бы одного нет.
    pub fn load(root: &Path) -> Option<Self> {
        let read = |name: &str| -> Option<Value> {
            let path = root.join("shared").join("locales").join(name);
            let text = std::fs::read_to_string(&path).ok()?;
            serde_json::from_str(&text).ok()
        };
        Some(Self {
            ru: read("ru.json")?,
            en: read("en.json")?,
        })
    }

    /// Кадр `locales` целиком — как `broadcast(EVENT_TYPES.LOCALES, ...)`.
    pub fn payload(&self, lang: &str) -> Value {
        json!({
            "lang": normalize_lang(lang),
            "locales": { "ru": self.ru, "en": self.en },
        })
    }

    /// Значение по точечному пути (`cli.scene.usage`) из словаря языка.
    pub fn lookup(&self, lang: &str, key: &str) -> Option<&Value> {
        let dict = if normalize_lang(lang) == "ru" {
            &self.ru
        } else {
            &self.en
        };
        let mut current = dict;
        for part in key.split('.') {
            current = current.get(part)?;
        }
        Some(current)
    }

    /// Перевод с подстановками `{{key}}`; своего ключа нет — берётся английский,
    /// затем сам ключ (как `makeT` в `server/cli.js`).
    pub fn translate(&self, lang: &str, key: &str, params: &[(&str, String)]) -> String {
        let text = self
            .lookup(lang, key)
            .and_then(Value::as_str)
            .or_else(|| self.lookup("en", key).and_then(Value::as_str))
            .unwrap_or(key);
        let mut out = text.to_string();
        for (name, value) in params {
            out = out.replace(&format!("{{{{{name}}}}}"), value);
        }
        out
    }
}

/// Язык сводится к паре `ru`/`en`; всё прочее — английский, как в JS.
pub fn normalize_lang(lang: &str) -> &'static str {
    if lang == "ru" {
        "ru"
    } else {
        "en"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_root() -> std::path::PathBuf {
        crate::repository_root()
    }

    #[test]
    fn locales_load_from_the_real_repository() {
        let locales = Locales::load(&repo_root()).expect("словари должны читаться");
        let payload = locales.payload("ru");
        assert_eq!(payload["lang"], json!("ru"));
        // Словари непустые и различаются — иначе это один и тот же файл.
        assert!(payload["locales"]["ru"].is_object());
        assert!(payload["locales"]["en"].is_object());
        assert_ne!(payload["locales"]["ru"], payload["locales"]["en"]);
    }

    #[test]
    fn language_falls_back_to_english() {
        assert_eq!(normalize_lang("ru"), "ru");
        assert_eq!(normalize_lang("en"), "en");
        assert_eq!(normalize_lang("de"), "en");
        assert_eq!(normalize_lang(""), "en");
    }

    #[test]
    fn a_dotted_key_resolves_and_substitutes() {
        let locales = Locales::load(&repo_root()).expect("словари");
        let text = locales.translate("ru", "cli.scene.switched", &[("scene", "main".to_string())]);
        assert!(text.contains("main"), "{text}");
        // Неизвестный ключ возвращается как есть — панель покажет его, а не пустоту.
        assert_eq!(
            locales.translate("ru", "cli.нет.такого", &[]),
            "cli.нет.такого"
        );
    }
}
