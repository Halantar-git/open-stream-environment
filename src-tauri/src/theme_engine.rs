//! Движок тем: сборка токенов своей темы из семян.
//!
//! Порт `shared/theme-engine.js`. Это не Material Color Utilities (HCT), а
//! небольшой HSL-движок: трёх-четырёх семян цвета хватает, чтобы получить полный
//! набор токенов с читаемыми «на» цветами — в тёмной схеме или в светлой.
//!
//! Работает это так:
//!
//! * из семян выводятся «роли» (основной, второй, третий акцент — [`derive_role`])
//!   и поверхности ([`derive_surfaces`]);
//! * акценты и автоматический текст прогоняются через [`readable_on`]: если
//!   контраст к фону ниже 4.5, светлота едет вверх или вниз, пока текст не станет
//!   читаемым. Иначе светлая тема на светлом фоне дала бы невидимые надписи;
//! * форма панелей ([`shape_tokens`]) и точечные переопределения (шрифты, рамка,
//!   свечение, прозрачность) накладываются поверх пресета.
//!
//! Проверяется не на глаз: эталон — токены, посчитанные настоящим JS-кодом
//! (`tools/build-theme-engine.mjs` → `theme_engine_samples.json`), и тест требует
//! совпадения символ в символ по 26 наборам семян. Рядом лежит отпечаток
//! исходника движка: поправили JS, не пересобрали — тест скажет.

use serde_json::{Map, Value};

use crate::storage::history::js_truthy;

/// Путь к исходнику движка — по нему тест ищет отпечаток.
pub const SOURCE_FILE: &str = "shared/theme-engine.js";

/// Как пересобрать эталон после правки движка.
pub const REBUILD_COMMAND: &str = "node src-tauri/tools/build-theme-engine.mjs";

/// Схемы оформления; тёмная — своя для приложения и умолчание для тем, сохранённых
/// до появления схем.
pub const SCHEMES: [&str; 2] = ["dark", "light"];

/// Формы панелей.
pub const SHAPE_MODES: [&str; 7] = [
    "rounded",
    "angular",
    "sharp",
    "soft",
    "pill",
    "brackets4",
    "hazard",
];

/// Пресеты шрифтов: имя пресета — тройка токенов.
pub const FONT_PRESETS: [&str; 2] = ["nebula", "orbital"];

/// Пресеты кривой появления алертов: ключ — то, что хранит тема, значение — готовая
/// `cubic-bezier`-строка, чтобы UI не мог вылить произвольный CSS в тему.
pub const ALERT_EASINGS: [(&str, &str); 5] = [
    ("smooth", "cubic-bezier(0.05, 0.7, 0.1, 1)"),
    ("decelerate", "cubic-bezier(0, 0, 0.2, 1)"),
    ("spring", "cubic-bezier(0.34, 1.56, 0.64, 1)"),
    ("sharp", "cubic-bezier(0.4, 0, 0.2, 1)"),
    ("linear", "linear"),
];

/// Цвет в HSL: `h` — градусы (0…360), `s` и `l` — проценты.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hsl {
    pub h: f64,
    pub s: f64,
    pub l: f64,
}

/// Акцентная роль: цвет для использования на поверхностях, цвет текста поверх неё,
/// цвет контейнера и текст поверх контейнера.
#[derive(Debug, Clone, PartialEq)]
pub struct Role {
    pub role: String,
    pub on_role: String,
    pub container: String,
    pub on_container: String,
}

/// Поверхности темы и текст на них.
#[derive(Debug, Clone, PartialEq)]
pub struct Surfaces {
    pub dim: String,
    pub base: String,
    pub bright: String,
    pub container_lowest: String,
    pub container_low: String,
    pub container: String,
    pub container_high: String,
    pub container_highest: String,
    pub on_surface: String,
    pub on_surface_variant: String,
    pub outline: String,
    pub outline_variant: String,
}

/// Токены шрифтов пресета. Неизвестное имя даёт `nebula` — как `|| FONT_PRESETS.nebula`.
pub fn font_preset(name: &str) -> [(&'static str, &'static str); 3] {
    match name {
        "orbital" => [
            ("--font-display", "\"Orbitron\", \"Segoe UI\", sans-serif"),
            ("--font-body", "\"Rajdhani\", \"Segoe UI\", sans-serif"),
            ("--font-mono", "\"Orbitron\", \"Consolas\", monospace"),
        ],
        _ => [
            ("--font-display", "\"Manrope\", \"Segoe UI\", sans-serif"),
            ("--font-body", "\"Manrope\", \"Segoe UI\", sans-serif"),
            ("--font-mono", "\"JetBrains Mono\", \"Consolas\", monospace"),
        ],
    }
}

/// Кривая появления алертов по ключу.
pub fn alert_easing(key: &str) -> Option<&'static str> {
    ALERT_EASINGS
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| *value)
}

/// Сколько знаков после запятой печатать в `rgba(…)`: числа тут короткие, но
/// сравнивать токены нужно символ в символ, поэтому формат фиксирован.
fn rgba(hex: &str, alpha: f64) -> String {
    let (r, g, b) = hex_to_rgb(hex);
    format!(
        "rgba({}, {}, {}, {})",
        r.round() as i64,
        g.round() as i64,
        b.round() as i64,
        number_text(alpha)
    )
}

/// Число так, как его печатает JS: `0.6`, а не `0.60`.
fn number_text(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        return (value as i64).to_string();
    }
    format!("{value}")
}

/// `hexToHsl`: цвет в HSL. Непонятный цвет читается как серый `#888888` — как в JS.
pub fn hex_to_hsl(hex: &str) -> Hsl {
    let (r, g, b) = hex_to_rgb(hex);
    rgb_to_hsl(r, g, b)
}

/// `hslToHex`.
pub fn hsl_to_hex(h: f64, s: f64, l: f64) -> String {
    let (r, g, b) = hsl_to_rgb(h, s, l);
    rgb_to_hex(r, g, b)
}

/// `hexToRgba`.
pub fn hex_to_rgba(hex: &str, alpha: f64) -> String {
    rgba(hex, alpha)
}

/// Относительная светимость по WCAG.
pub fn srgb_luminance(hex: &str) -> f64 {
    let (r, g, b) = hex_to_rgb(hex);
    let channel = |value: f64| {
        let s = value / 255.0;
        if s <= 0.03928 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/// Отношение контраста двух цветов.
pub fn contrast_ratio(first: &str, second: &str) -> f64 {
    let a = srgb_luminance(first);
    let b = srgb_luminance(second);
    let hi = a.max(b);
    let lo = a.min(b);
    (hi + 0.05) / (lo + 0.05)
}

/// Довести цвет до нужного контраста к фону.
///
/// HSL-светлота — не воспринимаемая яркость: жёлтый при L40 куда светлее синего
/// при L40, поэтому роль с фиксированной светлотой запросто выходит нечитаемой на
/// поверхности. Идём светлотой в обе стороны, сохраняя тон и насыщенность, и
/// возвращаем цвет как есть, если он уже проходит.
pub fn readable_on(hex: &str, background: &str, target: f64) -> String {
    if contrast_ratio(hex, background) >= target {
        return hex.to_string();
    }

    let Hsl { h, s, l } = hex_to_hsl(hex);
    let dark_background = srgb_luminance(background) < 0.35;
    let mut best = hex.to_string();
    let mut best_ratio = contrast_ratio(hex, background);

    for step in 1..=100 {
        let lightness = step as f64;
        let candidates = if dark_background {
            [l + lightness, l - lightness]
        } else {
            [l - lightness, l + lightness]
        };
        for next in candidates {
            if !(0.0..=100.0).contains(&next) {
                continue;
            }
            let candidate = hsl_to_hex(h, s, next);
            let ratio = contrast_ratio(&candidate, background);
            if ratio > best_ratio {
                best_ratio = ratio;
                best = candidate.clone();
            }
            if ratio >= target {
                return candidate;
            }
        }
    }

    best
}

/// Вывести акцентную роль из семени: рабочая тонкость — контейнер и текст поверх.
pub fn derive_role(seed: &str, scheme: &str) -> Role {
    let Hsl { h, s, .. } = hex_to_hsl(seed);
    if scheme == "light" {
        // HSL-насыщенность врёт про пастель (бледная лаванда читается как 100%), и
        // при L40 это дало бы кричащий акцент — режем её заметно ниже тёмной
        // формулы, как ведут себя светлые тона M3.
        let role_sat = 60.0_f64.min(s * 0.35 + 12.0);
        return Role {
            role: hsl_to_hex(h, role_sat, 40.0),
            on_role: hsl_to_hex(h, 60.0_f64.min(s * 0.6), 99.0),
            container: hsl_to_hex(h, 70.0_f64.min(s * 0.7 + 10.0), 88.0),
            on_container: hsl_to_hex(h, 40.0_f64.min(s * 0.3), 18.0),
        };
    }
    Role {
        role: hsl_to_hex(h, 90.0_f64.min(s * 0.9 + 10.0), 78.0),
        on_role: hsl_to_hex(h, 60.0_f64.min(s * 0.6), 15.0),
        container: hsl_to_hex(h, 70.0_f64.min(s * 0.7 + 10.0), 32.0),
        on_container: hsl_to_hex(h, 40.0_f64.min(s * 0.3), 92.0),
    }
}

/// Вывести поверхности из семени: они держатся почти нейтральными, чтобы текст
/// виджетов оставался разборчивым.
pub fn derive_surfaces(seed: &str, scheme: &str) -> Surfaces {
    let Hsl { h, .. } = hex_to_hsl(seed);
    let sat = if scheme == "light" { 10.0 } else { 12.0 };
    if scheme == "light" {
        return Surfaces {
            dim: hsl_to_hex(h, sat, 87.0),
            base: hsl_to_hex(h, sat, 98.0),
            bright: hsl_to_hex(h, sat, 100.0),
            container_lowest: hsl_to_hex(h, sat, 100.0),
            container_low: hsl_to_hex(h, sat, 96.0),
            container: hsl_to_hex(h, sat, 93.0),
            container_high: hsl_to_hex(h, sat, 90.0),
            container_highest: hsl_to_hex(h, sat, 87.0),
            on_surface: hsl_to_hex(h, 8.0, 12.0),
            on_surface_variant: hsl_to_hex(h, 8.0, 32.0),
            outline: hsl_to_hex(h, 10.0, 46.0),
            outline_variant: hsl_to_hex(h, 10.0, 70.0),
        };
    }
    Surfaces {
        dim: hsl_to_hex(h, sat, 5.0),
        base: hsl_to_hex(h, sat, 7.0),
        bright: hsl_to_hex(h, sat, 20.0),
        container_lowest: hsl_to_hex(h, sat, 3.0),
        container_low: hsl_to_hex(h, sat, 10.0),
        container: hsl_to_hex(h, sat, 12.0),
        container_high: hsl_to_hex(h, sat, 16.0),
        container_highest: hsl_to_hex(h, sat, 20.0),
        on_surface: hsl_to_hex(h, 8.0, 92.0),
        on_surface_variant: hsl_to_hex(h, 8.0, 78.0),
        outline: hsl_to_hex(h, 10.0, 52.0),
        outline_variant: hsl_to_hex(h, 10.0, 26.0),
    }
}

/// Токены формы панелей: радиус, декор, свечение, фон, размытие и рамка.
pub fn shape_tokens(
    mode: &str,
    primary: &str,
    surface_container: &str,
    outline_variant: &str,
    scheme: &str,
) -> Map<String, Value> {
    let light = scheme == "light";
    let glass = hex_to_rgba(surface_container, 0.82);

    let mut tokens: Map<String, Value> = Map::new();
    let mut put = |key: &str, value: String| {
        tokens.insert(key.to_string(), Value::from(value));
    };
    put("--panel-radius", "24px".to_string());
    put("--panel-clip", "none".to_string());
    put("--panel-decoration", "none".to_string());
    put(
        "--panel-glow",
        if light {
            "0 12px 32px rgba(0,0,0,0.18)"
        } else {
            "0 24px 48px rgba(0,0,0,0.45)"
        }
        .to_string(),
    );
    put("--panel-bg", glass);
    put("--panel-blur", "20px".to_string());
    put(
        "--panel-border",
        if light {
            "1px solid rgba(0, 0, 0, 0.10)"
        } else {
            "1px solid rgba(255, 255, 255, 0.12)"
        }
        .to_string(),
    );
    put(
        "--alert-enter-easing",
        "cubic-bezier(0.05, 0.7, 0.1, 1)".to_string(),
    );
    put("--alert-enter-duration", "480ms".to_string());

    // Форма панели: чем дальше от «скруглённого», тем больше токенов переопределено.
    match mode {
        "angular" => {
            put("--panel-radius", "2px".to_string());
            put(
                "--panel-clip",
                "polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 0 100%)".to_string(),
            );
            put("--panel-decoration", "brackets2".to_string());
            put(
                "--panel-glow",
                format!(
                    "0 0 16px {}, inset 0 0 24px {}",
                    hex_to_rgba(primary, 0.22),
                    hex_to_rgba(primary, 0.05)
                ),
            );
            put("--panel-bg", surface_container.to_string());
            put("--panel-blur", "0px".to_string());
            put("--panel-border", format!("1px solid {outline_variant}"));
            put(
                "--alert-enter-easing",
                "cubic-bezier(0.175, 0.885, 0.32, 1.2)".to_string(),
            );
            put("--alert-enter-duration", "350ms".to_string());
        }
        "sharp" => {
            put("--panel-radius", "0px".to_string());
            put("--panel-glow", "0 1px 3px rgba(0,0,0,0.4)".to_string());
            put("--panel-bg", surface_container.to_string());
            put("--panel-blur", "0px".to_string());
            put("--panel-border", format!("1px solid {outline_variant}"));
        }
        "soft" => {
            put("--panel-radius", "12px".to_string());
            put("--panel-bg", hex_to_rgba(surface_container, 0.72));
            put("--panel-blur", "12px".to_string());
            put(
                "--panel-border",
                "1px solid rgba(255, 255, 255, 0.10)".to_string(),
            );
        }
        "pill" => {
            put("--panel-radius", "999px".to_string());
            put("--panel-blur", "16px".to_string());
        }
        "brackets4" => {
            put("--panel-radius", "8px".to_string());
            put("--panel-decoration", "brackets4".to_string());
            put(
                "--panel-glow",
                format!(
                    "0 0 14px {}, inset 0 0 20px {}",
                    hex_to_rgba(primary, 0.2),
                    hex_to_rgba(primary, 0.05)
                ),
            );
            put("--panel-bg", surface_container.to_string());
            put("--panel-blur", "0px".to_string());
            put("--panel-border", format!("1px solid {outline_variant}"));
            put(
                "--alert-enter-easing",
                "cubic-bezier(0.175, 0.885, 0.32, 1.2)".to_string(),
            );
            put("--alert-enter-duration", "350ms".to_string());
        }
        "hazard" => {
            put("--panel-radius", "4px".to_string());
            put("--panel-decoration", "hazard".to_string());
            put(
                "--panel-glow",
                format!(
                    "0 0 14px {}, inset 0 0 20px {}",
                    hex_to_rgba(primary, 0.22),
                    hex_to_rgba(primary, 0.04)
                ),
            );
            put("--panel-bg", surface_container.to_string());
            put("--panel-blur", "0px".to_string());
            put("--panel-border", format!("1px solid {outline_variant}"));
            put(
                "--alert-enter-easing",
                "cubic-bezier(0.175, 0.885, 0.32, 1.2)".to_string(),
            );
            put("--alert-enter-duration", "350ms".to_string());
        }
        _ => {}
    }

    tokens
}

/// Собрать `--panel-border` из точечных переопределений ширины, стиля и цвета,
/// сохраняя выведенное значение для незаполненных частей.
pub fn override_panel_border(
    current: &str,
    width: Option<&Value>,
    style: Option<&Value>,
    color: Option<&Value>,
) -> String {
    let part = |value: Option<&Value>| -> Option<String> {
        let value = value?;
        if !js_truthy(Some(value)) {
            return None;
        }
        let text = js_string(value).trim().to_string();
        (!text.is_empty()).then_some(text)
    };

    let parts: Vec<&str> = current.split(' ').collect();
    let width = part(width)
        .or_else(|| parts.first().map(|part| (*part).to_string()))
        .unwrap_or_else(|| "1px".to_string());
    let style = part(style)
        .or_else(|| parts.get(1).map(|part| (*part).to_string()))
        .unwrap_or_else(|| "solid".to_string());
    let color = part(color)
        .or_else(|| (parts.len() > 2).then(|| parts[2..].join(" ")))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "rgba(255,255,255,0.12)".to_string());

    format!("{width} {style} {color}")
}

/// Собрать `--panel-glow` из цвета и интенсивности (0–100): интенсивность задаёт и
/// прозрачность, и размытие — UI не выливает произвольный CSS в тему.
pub fn panel_glow(color: &str, strength: f64) -> String {
    let mut hex: String = color.replacen('#', "", 1).chars().take(6).collect();
    while hex.chars().count() < 6 {
        hex.push('0');
    }
    let strength = if strength.is_finite() {
        strength.clamp(0.0, 100.0)
    } else {
        0.0
    };
    let alpha = ((0.05 + (strength / 100.0) * 0.55) * 255.0).round() as i64;
    let blur = (4.0 + (strength / 100.0) * 40.0).round() as i64;
    let spread = ((strength / 100.0) * 8.0).round() as i64;
    format!("0 0 {blur}px {spread}px #{hex}{alpha:02x}")
}

/// Собрать токены темы из семян.
///
/// `seeds` — то, что лежит в настройках пользователя: `primary`, `secondary`,
/// `tertiary`, `surfaceSeed`, `mode`, `shapeMode`, `fontPreset` и необязательные
/// точечные переопределения. Пустое или неизвестное значение оставляет пресет.
pub fn build_theme_tokens(seeds: &Value) -> Value {
    let scheme = match seeds.get("mode").and_then(Value::as_str) {
        Some("light") => "light",
        _ => "dark",
    };
    let light = scheme == "light";

    let mut primary = derive_role(&seed_text(seeds, "primary"), scheme);
    let mut secondary = derive_role(&seed_text(seeds, "secondary"), scheme);
    let mut tertiary = derive_role(&seed_text(seeds, "tertiary"), scheme);
    let mut error = set_field(seeds, "error").map(|value| derive_role(&js_string(value), scheme));
    let surface_seed = match set_field(seeds, "surfaceSeed") {
        // `seeds.surfaceSeed || seeds.primary`.
        Some(value) => js_string(value),
        None => seed_text(seeds, "primary"),
    };
    let surfaces = derive_surfaces(&surface_seed, scheme);
    let fonts = font_preset(
        seeds
            .get("fontPreset")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    let shape = shape_tokens(
        seeds
            .get("shapeMode")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        &seed_text(seeds, "primary"),
        &surfaces.container,
        &surfaces.outline_variant,
        scheme,
    );

    // Читаемость: акценты и автоматический текст меряются по фактическому фону
    // (семя `background`, если оно задано), чтобы тема не показывала невидимый
    // текст — например, светлый фон, оставшийся под тёмной схемой. Явные
    // переопределения `background`/`text` уважаются как есть: их проверяет сам
    // редактор своей шкалой контраста.
    let background =
        set_field(seeds, "background").map(|value| js_string(value).trim().to_string());
    let surface_hex = background.clone().unwrap_or_else(|| surfaces.base.clone());
    let on_surface = match set_field(seeds, "text") {
        Some(value) => js_string(value).trim().to_string(),
        None => readable_on(&surfaces.on_surface, &surface_hex, 4.5),
    };
    let on_surface_variant = readable_on(&surfaces.on_surface_variant, &surface_hex, 4.5);

    primary.role = readable_on(&primary.role, &surface_hex, 4.5);
    primary.on_role = readable_on(&primary.on_role, &primary.role, 4.5);
    secondary.role = readable_on(&secondary.role, &surface_hex, 4.5);
    secondary.on_role = readable_on(&secondary.on_role, &secondary.role, 4.5);
    tertiary.role = readable_on(&tertiary.role, &surface_hex, 4.5);
    tertiary.on_role = readable_on(&tertiary.on_role, &tertiary.role, 4.5);
    if let Some(error) = &mut error {
        error.role = readable_on(&error.role, &surface_hex, 4.5);
        error.on_role = readable_on(&error.on_role, &error.role, 4.5);
    }

    let mut tokens: Map<String, Value> = Map::new();
    let mut put = |key: &str, value: String| {
        tokens.insert(key.to_string(), Value::from(value));
    };
    put("--md-primary", primary.role.clone());
    put("--md-on-primary", primary.on_role.clone());
    put("--md-primary-container", primary.container.clone());
    put("--md-on-primary-container", primary.on_container.clone());
    put("--md-secondary", secondary.role.clone());
    put("--md-on-secondary", secondary.on_role.clone());
    put("--md-secondary-container", secondary.container.clone());
    put(
        "--md-on-secondary-container",
        secondary.on_container.clone(),
    );
    put("--md-tertiary", tertiary.role.clone());
    put("--md-on-tertiary", tertiary.on_role.clone());
    put("--md-tertiary-container", tertiary.container.clone());
    put("--md-on-tertiary-container", tertiary.on_container.clone());
    match &error {
        Some(error) => {
            put("--md-error", error.role.clone());
            put("--md-on-error", error.on_role.clone());
            put("--md-error-container", error.container.clone());
            put("--md-on-error-container", error.on_container.clone());
        }
        None => {
            put(
                "--md-error",
                if light { "#ba1a1a" } else { "#ffb4ab" }.to_string(),
            );
            put(
                "--md-on-error",
                if light { "#ffffff" } else { "#690005" }.to_string(),
            );
            put(
                "--md-error-container",
                if light { "#ffdad6" } else { "#93000a" }.to_string(),
            );
            put(
                "--md-on-error-container",
                if light { "#410002" } else { "#ffdad6" }.to_string(),
            );
        }
    }
    put("--md-surface-dim", surfaces.dim.clone());
    put("--md-surface", surfaces.base.clone());
    put("--md-surface-bright", surfaces.bright.clone());
    put(
        "--md-surface-container-lowest",
        surfaces.container_lowest.clone(),
    );
    put("--md-surface-container-low", surfaces.container_low.clone());
    put("--md-surface-container", surfaces.container.clone());
    put(
        "--md-surface-container-high",
        surfaces.container_high.clone(),
    );
    put(
        "--md-surface-container-highest",
        surfaces.container_highest.clone(),
    );
    put("--md-on-surface", on_surface);
    put("--md-on-surface-variant", on_surface_variant);
    put("--md-outline", surfaces.outline.clone());
    put("--md-outline-variant", surfaces.outline_variant.clone());
    for (key, value) in fonts {
        put(key, value.to_string());
    }
    for (key, value) in shape {
        tokens.insert(key, value);
    }

    // Точечные переопределения: пустое значение оставляет пресет или выведенное.
    for (key, field) in [
        ("--font-display", "fontDisplay"),
        ("--font-body", "fontBody"),
        ("--font-mono", "fontMono"),
        ("--panel-radius", "panelRadius"),
        ("--panel-blur", "panelBlur"),
    ] {
        if let Some(value) = set_field(seeds, field) {
            tokens.insert(
                key.to_string(),
                Value::from(js_string(value).trim().to_string()),
            );
        }
    }
    if let Some(value) = set_field(seeds, "panelGlowColor") {
        let strength = seeds
            .get("panelGlowStrength")
            .map(|value| finite_number(Some(value)).unwrap_or(0.0))
            .unwrap_or(0.0);
        tokens.insert(
            "--panel-glow".to_string(),
            Value::from(panel_glow(js_string(value).trim(), strength)),
        );
    }
    if let Some(background) = &background {
        tokens.insert("--md-surface".to_string(), Value::from(background.clone()));
    }
    if let Some(value) = set_field(seeds, "text") {
        tokens.insert(
            "--md-on-surface".to_string(),
            Value::from(js_string(value).trim().to_string()),
        );
    }
    if let Some(value) = seeds
        .get("alertEnterDuration")
        .filter(|value| !is_blank(value))
    {
        if let Some(duration) = finite_number(Some(value)) {
            let clamped = 0.0_f64.max(2000.0_f64.min(duration.round()));
            tokens.insert(
                "--alert-enter-duration".to_string(),
                Value::from(format!("{}ms", clamped as i64)),
            );
        }
    }
    if let Some(easing) = seeds
        .get("alertEnterEasing")
        .and_then(Value::as_str)
        .and_then(alert_easing)
    {
        tokens.insert("--alert-enter-easing".to_string(), Value::from(easing));
    }
    if let Some(value) = seeds.get("panelOpacity").filter(|value| !is_blank(value)) {
        if let Some(opacity) = finite_number(Some(value)) {
            let alpha = 0.0_f64.max(100.0_f64.min(opacity)) / 100.0;
            tokens.insert(
                "--panel-bg".to_string(),
                Value::from(hex_to_rgba(&surfaces.container, alpha)),
            );
        }
    }
    let border_parts = [
        set_field(seeds, "panelBorderWidth"),
        set_field(seeds, "panelBorderStyle"),
        set_field(seeds, "panelBorderColor"),
    ];
    if border_parts.iter().any(Option::is_some) {
        let current = tokens
            .get("--panel-border")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let border =
            override_panel_border(&current, border_parts[0], border_parts[1], border_parts[2]);
        tokens.insert("--panel-border".to_string(), Value::from(border));
    }

    Value::Object(tokens)
}

/// Цвет в нижнем регистре — как `parseInt` по паре цифр.
fn hex_to_rgb(hex: &str) -> (f64, f64, f64) {
    let stripped = hex.replacen('#', "", 1);
    let bytes = stripped.as_bytes();
    let valid = bytes.len() == 6 && bytes.iter().all(u8::is_ascii_hexdigit);
    let digits = if valid {
        stripped
    } else {
        "888888".to_string()
    };
    let channel = |from: usize| -> f64 {
        u8::from_str_radix(&digits[from..from + 2], 16).unwrap_or(0) as f64
    };
    (channel(0), channel(2), channel(4))
}

/// `rgbToHsl`: `r`/`g`/`b` — от 0 до 255.
fn rgb_to_hsl(r: f64, g: f64, b: f64) -> Hsl {
    let r = r / 255.0;
    let g = g / 255.0;
    let b = b / 255.0;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let (mut h, mut s) = (0.0, 0.0);
    if max != min {
        let d = max - min;
        s = if l > 0.5 {
            d / (2.0 - max - min)
        } else {
            d / (max + min)
        };
        h = if max == r {
            (g - b) / d + if g < b { 6.0 } else { 0.0 }
        } else if max == g {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        };
        h /= 6.0;
    }
    Hsl {
        h: h * 360.0,
        s: s * 100.0,
        l: l * 100.0,
    }
}

/// `hslToRgb`: каналы от 0 до 255, без округления (округление — в [`rgb_to_hex`]).
fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (f64, f64, f64) {
    let h = ((h % 360.0) + 360.0) % 360.0 / 360.0;
    let s = s.clamp(0.0, 100.0) / 100.0;
    let l = l.clamp(0.0, 100.0) / 100.0;
    if s == 0.0 {
        let value = l * 255.0;
        return (value, value, value);
    }
    let hue2rgb = |mut t: f64, p: f64, q: f64| -> f64 {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            return p + (q - p) * 6.0 * t;
        }
        if t < 1.0 / 2.0 {
            return q;
        }
        if t < 2.0 / 3.0 {
            return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
        }
        p
    };
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    (
        hue2rgb(h + 1.0 / 3.0, p, q) * 255.0,
        hue2rgb(h, p, q) * 255.0,
        hue2rgb(h - 1.0 / 3.0, p, q) * 255.0,
    )
}

fn rgb_to_hex(r: f64, g: f64, b: f64) -> String {
    let channel = |value: f64| -> String {
        let clamped = value.clamp(0.0, 255.0).round() as i64;
        format!("{clamped:02x}")
    };
    format!("#{}{}{}", channel(r), channel(g), channel(b))
}

/// `String(value)` для тех полей, где в JS в строку попадает всё подряд.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `Number(value)`, если из значения выходит конечное число.
fn finite_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|value| value.is_finite()),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::String(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite()),
        _ => None,
    }
}

/// Пустое значение: `null` или пустая строка (в JS такие поля отбрасываются в
/// проверках вида `!== "" && != null`).
fn is_blank(value: &Value) -> bool {
    matches!(value, Value::Null) || matches!(value, Value::String(text) if text.is_empty())
}

/// Поле задано: значение истинно и не пусто после `trim` — как
/// `seeds.x && String(seeds.x).trim()`.
///
/// Возвращается **исходное** значение: JS и дальше работает с ним, а не с обрезком.
fn set_field<'a>(seeds: &'a Value, key: &str) -> Option<&'a Value> {
    let value = seeds.get(key)?;
    if !js_truthy(Some(value)) {
        return None;
    }
    if js_string(value).trim().is_empty() {
        return None;
    }
    Some(value)
}

/// Семя цвета как строка; отсутствующее поле — как в JS: строка не пройдёт проверку
/// и цвет выйдет серым.
fn seed_text(seeds: &Value, key: &str) -> String {
    js_string(seeds.get(key).unwrap_or(&Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    /// Эталон: семена и токены, посчитанные JS-движком.
    const SAMPLES_JSON: &str = include_str!("../theme_engine_samples.json");

    fn samples() -> Value {
        serde_json::from_str(SAMPLES_JSON).expect("эталон движка тем")
    }

    #[test]
    fn the_samples_were_taken_from_the_current_source_file() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri лежит в корне репозитория")
            .join(SOURCE_FILE);

        assert_eq!(
            samples()["sourceHash"].as_str().unwrap_or_default(),
            crate::fingerprint::fnv1a_file(&path),
            "{SOURCE_FILE} изменился — пересоберите эталон: {REBUILD_COMMAND}"
        );
    }

    #[test]
    fn the_ported_tables_match_the_engine() {
        let samples = samples();

        assert_eq!(samples["shapeModes"], json!(SHAPE_MODES));
        assert_eq!(samples["schemes"], json!(SCHEMES));
        for (name, easing) in ALERT_EASINGS {
            assert_eq!(
                samples["alertEasings"][name],
                json!(easing),
                "кривая {name}"
            );
            assert_eq!(alert_easing(name), Some(easing));
        }
        assert_eq!(alert_easing("nope"), None);

        let presets = samples["fonts"].as_object().expect("пресеты шрифтов");
        assert_eq!(presets.len(), FONT_PRESETS.len());
        for name in FONT_PRESETS {
            let expected = presets
                .get(name)
                .unwrap_or_else(|| panic!("в эталоне нет пресета {name}"));
            for (key, value) in font_preset(name) {
                assert_eq!(expected[key], json!(value), "{name}: {key}");
            }
        }
    }

    #[test]
    fn the_engine_produces_exactly_the_tokens_the_javascript_engine_does() {
        let samples = samples();
        let mut differences = Vec::new();

        for sample in samples["samples"].as_array().expect("наборы семян") {
            let name = sample["name"].as_str().unwrap_or_default();
            let ours = build_theme_tokens(&sample["seeds"]);
            differences.extend(token_differences(name, &ours, &sample["tokens"]));
        }

        assert!(
            differences.is_empty(),
            "токены разошлись с JS-движком:\n{}",
            differences.join("\n")
        );
    }

    /// Различия по токенам: сравниваем и в обе стороны, чтобы лишний токен тоже был
    /// виден.
    fn token_differences(name: &str, ours: &Value, expected: &Value) -> Vec<String> {
        let mut differences = Vec::new();
        let ours_map = ours.as_object();
        let empty = Map::new();
        let expected_map = expected.as_object().unwrap_or(&empty);
        for (key, want) in expected_map {
            match ours_map.and_then(|map| map.get(key)) {
                Some(got) if got == want => {}
                Some(got) => {
                    differences.push(format!("{name}: {key}: ждали {want}, получили {got}"))
                }
                None => differences.push(format!("{name}: {key}: токена нет")),
            }
        }
        if let Some(ours_map) = ours_map {
            for key in ours_map.keys() {
                if !expected_map.contains_key(key) {
                    differences.push(format!("{name}: {key}: лишний токен"));
                }
            }
        }
        differences
    }

    // ---- поведение, а не значения: то же, что проверяет Jest-набор ----

    fn seeds() -> Value {
        json!({
            "primary": "#c6b8ff",
            "secondary": "#7ee0d6",
            "tertiary": "#ffb0d8",
            "surfaceSeed": "#8878c8",
            "shapeMode": "rounded",
            "fontPreset": "nebula",
        })
    }

    #[test]
    fn the_light_scheme_is_readable_on_its_surface() {
        let mut light_seeds = seeds();
        light_seeds["mode"] = json!("light");
        let light = build_theme_tokens(&light_seeds);
        let surface = light["--md-surface"].as_str().expect("поверхность");

        assert!(hex_to_hsl(surface).l > 90.0);
        assert!(hex_to_hsl(light["--md-on-surface"].as_str().unwrap()).l < 30.0);
        assert!(contrast_ratio(light["--md-on-surface"].as_str().unwrap(), surface) > 7.0);
        assert!(contrast_ratio(light["--md-on-surface-variant"].as_str().unwrap(), surface) > 4.5);
        assert!(
            contrast_ratio(light["--md-primary"].as_str().unwrap(), surface) >= 4.5,
            "акцент не читается на светлой поверхности"
        );

        // В тёмной схеме — наоборот: поверхность почти чёрная, текст светлый.
        let dark = build_theme_tokens(&seeds());
        assert!(hex_to_hsl(dark["--md-surface"].as_str().unwrap()).l < 20.0);
        assert!(hex_to_hsl(dark["--md-on-surface"].as_str().unwrap()).l > 80.0);
    }

    #[test]
    fn a_light_background_left_in_the_dark_scheme_keeps_the_text_visible() {
        // Пользователь вручную поставил светлый фон, а текст и акцент оставил «Авто».
        let mut light_seeds = seeds();
        light_seeds["background"] = json!("#f4f4f4");
        let tokens = build_theme_tokens(&light_seeds);

        assert_eq!(tokens["--md-surface"], json!("#f4f4f4"));
        for key in ["--md-on-surface", "--md-on-surface-variant", "--md-primary"] {
            let value = tokens[key].as_str().expect("токен");
            assert!(
                contrast_ratio(value, "#f4f4f4") >= 4.5,
                "{key} ({value}) не читается на светлом фоне"
            );
        }
    }

    #[test]
    fn explicit_background_and_text_are_not_substituted() {
        let mut explicit = seeds();
        explicit["background"] = json!("#101010");
        explicit["text"] = json!("#fafafa");
        let tokens = build_theme_tokens(&explicit);

        assert_eq!(tokens["--md-surface"], json!("#101010"));
        assert_eq!(tokens["--md-on-surface"], json!("#fafafa"));
    }

    #[test]
    fn the_shape_and_the_scheme_decide_the_panel_tokens() {
        let dark = build_theme_tokens(&seeds());
        assert_eq!(dark["--panel-radius"], json!("24px"));
        assert_eq!(dark["--panel-glow"], json!("0 24px 48px rgba(0,0,0,0.45)"));
        assert_eq!(
            dark["--panel-border"],
            json!("1px solid rgba(255, 255, 255, 0.12)")
        );
        assert_eq!(dark["--alert-enter-duration"], json!("480ms"));
        assert_eq!(dark["--md-error"], json!("#ffb4ab"));

        let mut light_seeds = seeds();
        light_seeds["mode"] = json!("light");
        let light = build_theme_tokens(&light_seeds);
        assert_eq!(light["--panel-glow"], json!("0 12px 32px rgba(0,0,0,0.18)"));
        assert_eq!(
            light["--panel-border"],
            json!("1px solid rgba(0, 0, 0, 0.10)")
        );
        assert_eq!(light["--md-error"], json!("#ba1a1a"));

        let mut angular = seeds();
        angular["shapeMode"] = json!("angular");
        let angular = build_theme_tokens(&angular);
        assert_eq!(angular["--alert-enter-duration"], json!("350ms"));
        assert_eq!(
            angular["--alert-enter-easing"],
            json!("cubic-bezier(0.175, 0.885, 0.32, 1.2)")
        );

        let mut sharp = seeds();
        sharp["shapeMode"] = json!("sharp");
        let sharp = build_theme_tokens(&sharp);
        assert_eq!(sharp["--panel-radius"], json!("0px"));
        assert_eq!(sharp["--panel-decoration"], json!("none"));

        let mut brackets = seeds();
        brackets["shapeMode"] = json!("brackets4");
        assert_eq!(
            build_theme_tokens(&brackets)["--panel-decoration"],
            json!("brackets4")
        );
    }

    #[test]
    fn the_error_color_is_derived_only_when_it_is_set() {
        assert_eq!(build_theme_tokens(&seeds())["--md-error"], json!("#ffb4ab"));

        let mut with_error = seeds();
        with_error["error"] = json!("#ff0000");
        let tokens = build_theme_tokens(&with_error);
        let role = derive_role("#ff0000", "dark");
        assert_eq!(tokens["--md-error"], json!(role.role));
        assert_eq!(tokens["--md-on-error"], json!(role.on_role));
        assert_eq!(tokens["--md-error-container"], json!(role.container));
        assert_eq!(tokens["--md-on-error-container"], json!(role.on_container));

        // Пустая строка — дефолт сохраняется.
        let mut blank = seeds();
        blank["error"] = json!("   ");
        assert_eq!(build_theme_tokens(&blank)["--md-error"], json!("#ffb4ab"));
    }
}
