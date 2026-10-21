//! Курсы валют для цели сбора.
//!
//! DonationAlerts и DonateX присылают сумму в валюте доната, а цель ведётся в
//! одной валюте. Курсов в приложении нет, поэтому без внешней таблицы $100
//! пришлось бы либо считать ста рублями, либо не двигать цель вовсе.
//!
//! Таблица грузится один раз при старте и обновляется раз в двенадцать часов:
//! курсы за день меняются незначительно, а лишние запросы к бесплатному
//! сервису ни к чему. Если сети нет, работаем без курсов — чужая валюта цель
//! не двигает, но и не портит сумму.
//!
//! База таблицы — доллар: значения говорят, сколько единиц валюты дают за
//! один доллар. Пересчёт между любыми двумя валютами считается через него,
//! поэтому одного запроса хватает на любую пару.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use serde_json::Value;

use crate::integrations::http;

/// Общий держатель таблицы: фоновый загрузчик пишет, разбор донатов читает.
pub type Shared = Arc<Mutex<Option<Rates>>>;

/// Сколько ждём до следующего обновления.
pub const REFRESH_EVERY_SECS: u64 = 12 * 60 * 60;

/// После неудачи пробуем раньше: приложение могло стартовать без сети.
pub const RETRY_IN_SECS: u64 = 30 * 60;

/// Те же данные на двух зеркалах: jsDelivr и Cloudflare Pages. Если одно
/// недоступно в сети стримера, второе обычно открывается.
const SOURCES: [&str; 2] = [
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
    "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
];

/// Меньше этого числа валют — считаем ответ битым: обрезанная таблица
/// выглядит как рабочая, но нужной пары в ней может не быть.
const MIN_CURRENCIES: usize = 10;

#[derive(Clone)]
pub struct Rates {
    /// Код валюты → сколько единиц за 1 USD.
    values: HashMap<String, f64>,
    fetched_at: i64,
}

impl Rates {
    /// Пересчитать сумму из одной валюты в другую. `None` — пары нет в
    /// таблице (или валюту не знаем), и тогда вызывающий оставляет сумму как есть.
    pub fn convert(&self, amount: f64, from: &str, to: &str) -> Option<f64> {
        if !amount.is_finite() {
            return None;
        }
        let from = from.trim().to_ascii_uppercase();
        let to = to.trim().to_ascii_uppercase();
        if from == to {
            return Some(amount);
        }
        let from_rate = self.rate(&from)?;
        let to_rate = self.rate(&to)?;
        Some(amount / from_rate * to_rate)
    }

    fn rate(&self, code: &str) -> Option<f64> {
        self.values.get(code).copied().filter(|rate| *rate > 0.0)
    }

    pub fn fetched_at(&self) -> i64 {
        self.fetched_at
    }

    pub fn currency_count(&self) -> usize {
        self.values.len()
    }
}

pub fn shared() -> Shared {
    Arc::new(Mutex::new(None))
}

/// Заменить таблицу целиком: частично обновлённые курсы хуже старых.
pub fn store(shared: &Shared, values: HashMap<String, f64>) {
    let rates = Rates {
        values,
        fetched_at: Utc::now().timestamp_millis(),
    };
    *shared.lock().unwrap_or_else(|error| error.into_inner()) = Some(rates);
}

/// Пересчёт через общую таблицу; без загруженных курсов — `None`.
pub fn convert(shared: &Shared, amount: f64, from: &str, to: &str) -> Option<f64> {
    shared
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .and_then(|rates| rates.convert(amount, from, to))
}

/// Разобрать ответ зеркала: `{ "date": "…", "usd": { "rub": 92.5, … } }`.
pub fn parse(body: &Value) -> Option<HashMap<String, f64>> {
    let table = body.get("usd")?.as_object()?;
    let mut values = HashMap::new();
    values.insert("USD".to_string(), 1.0);
    for (code, value) in table {
        let Some(rate) = value.as_f64() else {
            continue;
        };
        if !rate.is_finite() || rate <= 0.0 {
            continue;
        }
        values.insert(code.to_ascii_uppercase(), rate);
    }
    if values.len() < MIN_CURRENCIES {
        return None;
    }
    Some(values)
}

/// Сходить за таблицей курсов. Зеркала перебираются по очереди: сбой сети или
/// разбора одного ответа не должен отменять второй.
pub async fn fetch() -> Option<HashMap<String, f64>> {
    for url in SOURCES {
        if let Ok(body) = http::fetch_json(url).await {
            if let Some(values) = parse(&body) {
                return Some(values);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Rates {
        let body = json!({
            "date": "2026-10-21",
            "usd": {
                "usd": 1,
                "rub": 92.5,
                "eur": 0.92,
                "kzt": 480.0,
                "uah": 41.0,
                "gbp": 0.79,
                "try": 34.0,
                "pln": 4.0,
                "byn": 3.3,
                "amd": 390.0,
                "gel": 2.7,
            },
        });
        Rates {
            values: parse(&body).expect("таблица"),
            fetched_at: 0,
        }
    }

    #[test]
    fn a_foreign_amount_is_converted_through_the_dollar() {
        let rates = sample();
        // $100 по 92.5 — это 9250 ₽.
        assert_eq!(rates.convert(100.0, "USD", "RUB"), Some(9250.0));
        // Обратно: 9250 ₽ — это $100.
        assert_eq!(rates.convert(9250.0, "RUB", "USD"), Some(100.0));
        // Кросс-курс без рубля: 100 EUR в USD.
        let usd = rates.convert(100.0, "EUR", "USD").expect("курс");
        assert!((usd - 108.695_65).abs() < 0.001, "получилось {usd}");
    }

    #[test]
    fn the_same_currency_and_unknown_codes_behave_predictably() {
        let rates = sample();
        assert_eq!(rates.convert(500.0, "rub", "RUB"), Some(500.0));
        assert_eq!(rates.convert(500.0, "XXX", "RUB"), None);
        assert_eq!(rates.convert(500.0, "RUB", "XXX"), None);
        assert_eq!(rates.convert(f64::NAN, "USD", "RUB"), None);
    }

    #[test]
    fn a_broken_or_short_table_is_rejected() {
        assert!(parse(&json!({})).is_none());
        assert!(parse(&json!({ "usd": {} })).is_none());
        assert!(parse(&json!({ "rates": { "RUB": 92.5 } })).is_none());
        // Отрицательный или нечисловой курс не попадает в таблицу.
        let body = json!({
            "usd": {
                "usd": 1, "rub": "abc", "eur": -1, "kzt": 480,
                "uah": 41, "gbp": 0.79, "try": 34, "pln": 4, "byn": 3.3,
                "amd": 390, "czk": 23, "sek": 10.5,
            },
        });
        let values = parse(&body).expect("таблица");
        assert!(!values.contains_key("RUB"));
        assert!(!values.contains_key("EUR"));
        assert_eq!(values["KZT"], 480.0);
    }
}
