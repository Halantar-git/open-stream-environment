//! Цвет ника для чатов, которые его не отдают (YouTube) и для пустого тега Twitch.
//!
//! Порт `server/nick-color.js`. Тон берётся из хеша идентификатора, а
//! насыщенность и светлота зафиксированы: при них любой оттенок читается на
//! тёмных панелях оверлея — минимальный контраст к `#131019` около 5.6:1, то есть
//! выше порога WCAG AA для обычного текста.
//!
//! Хеш — FNV-1a. В JS он считается по UTF-16 code unit (`charCodeAt`), здесь — по
//! `char`; для ников и идентификаторов канала (ASCII) это одно и то же, а
//! расходиться может только на редких суррогатных парах в семени.

use serde_json::Value;

use crate::theme_engine;

/// Прежний единый цвет — для сообщений совсем без автора.
pub const DEFAULT_NICK_COLOR: &str = "#e8e1f0";

/// Сколько оттенков в палитре.
const HUE_COUNT: u32 = 360;
const SATURATION: f64 = 62.0;
const LIGHTNESS: f64 = 70.0;

/// FNV-1a, 32 бита.
fn hash_string(value: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Цвет ника по семени; без идентификатора — прежний единый цвет.
pub fn nick_color(seed: &Value) -> String {
    let key = match seed {
        Value::Null => String::new(),
        Value::String(text) => text.trim().to_string(),
        other => crate::state::js_string(other).trim().to_string(),
    };
    if key.is_empty() {
        return DEFAULT_NICK_COLOR.to_string();
    }
    theme_engine::hsl_to_hex(
        f64::from(hash_string(&key) % HUE_COUNT),
        SATURATION,
        LIGHTNESS,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Фон тёмной панели оверлея — самый тёмный вариант из тем приложения.
    const DARK_SURFACE: &str = "#131019";
    /// Порог WCAG AA для обычного текста.
    const MIN_CONTRAST: f64 = 4.5;

    /// Правдоподобный идентификатор канала: буквы и цифры, без пробелов.
    fn channel_id(index: usize) -> String {
        format!("UC{index:012x}")
    }

    #[test]
    fn the_color_is_stable_and_ignores_surrounding_spaces() {
        assert_eq!(nick_color(&json!("UCabc")), nick_color(&json!("UCabc")));
        assert_eq!(nick_color(&json!("UCabc")), nick_color(&json!("  UCabc  ")));
    }

    #[test]
    fn the_color_is_a_six_digit_hex() {
        let color = nick_color(&json!("UCabc"));
        assert_eq!(color.len(), 7, "{color}");
        assert!(color.starts_with('#'));
        assert!(
            color[1..].chars().all(|ch| ch.is_ascii_hexdigit()),
            "{color}"
        );
    }

    #[test]
    fn without_an_identifier_the_old_solid_color_stays() {
        for seed in [Value::Null, json!(""), json!("   ")] {
            assert_eq!(nick_color(&seed), DEFAULT_NICK_COLOR);
        }
    }

    #[test]
    fn different_viewers_get_different_colors() {
        let colors: std::collections::BTreeSet<String> = (0..20)
            .map(|index| nick_color(&json!(channel_id(index))))
            .collect();
        assert_eq!(colors.len(), 20);
    }

    #[test]
    fn the_palette_does_not_collapse() {
        let colors: std::collections::BTreeSet<String> = (0..400)
            .map(|index| nick_color(&json!(channel_id(index))))
            .collect();
        assert!(colors.len() > 200, "{}", colors.len());
    }

    #[test]
    fn the_contrast_on_the_dark_panel_holds_for_the_whole_palette() {
        let palette: std::collections::BTreeSet<String> = (0..5000)
            .map(|index| nick_color(&json!(channel_id(index))))
            .collect();
        // Если хеш перестанет раздавать оттенок по всему кругу, проверка станет
        // частичной — об этом сообщаем отдельно, а не молча занижаем охват.
        assert_eq!(
            palette.len(),
            HUE_COUNT as usize,
            "палитра не покрывает круг"
        );
        let worst = palette
            .iter()
            .map(|color| theme_engine::contrast_ratio(color, DARK_SURFACE))
            .fold(f64::INFINITY, f64::min);
        assert!(worst >= MIN_CONTRAST, "худший контраст {worst}");
    }
}
