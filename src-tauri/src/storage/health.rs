//! Отчёт о состоянии процесса: один объект, из которого видно, живое ли
//! приложение и что именно не так.
//!
//! Порт `server/health.js`. Зачем отчёт, если есть журнал: «работает, но оверлей
//! отстаёт» и «чат отвалился в середине стрима» — вопросы, на которые журнал
//! отвечает только после чтения сотен строк. Здесь собираются уже посчитанные
//! величины (состояние интеграций, клиенты WebSocket, размеры и число записей,
//! телеметрия записи, задержки, сводка долгого прогона), и из них выводится
//! короткий список проблем.
//!
//! Модуль намеренно чистый: **никакого ввода-вывода** и никакого доступа к
//! настройкам с секретами — только то, что ему передали. Поэтому его легко
//! покрыть тестами, а отчёт можно безопасно отдавать наружу (`GET /healthz`).
//! Пути к файлам в отчёт не попадают: он уходит в сеть, а путь выдаёт имя
//! пользователя в системе.
//!
//! Пороги «проблем»:
//!
//! * сервер не слушает порт — приложение неработоспособно;
//! * были ошибки записи в базу или историю — данные могут теряться;
//! * задержка выше [`PERF_PROBLEM_MS`] — чат и оверлей будут отставать;
//! * устойчивый рост памяти по нескольким образцам — похоже на утечку.
//!
//! Всё остальное — информация, а не проблема: например, ноль клиентов
//! WebSocket на старте это норма, а не авария.

use serde_json::{json, Map, Value};

use super::async_store::StatsSnapshot;
use super::history::{js_key, js_number_or_zero, js_truthy, number_value};
use super::longrun::{LongRunSnapshot, GROWTH_WARN_MB_PER_HOUR};
use super::perf::LagSnapshot;

/// Задержка выше этого значения уже бьёт по чату и оверлею: сообщение приходит
/// позже, чем нужно, анимация рвётся. Ниже — это шум, а не проблема.
pub const PERF_PROBLEM_MS: f64 = 100.0;

/// Что показать из замеров задержек. Поля необязательны: отсутствующее
/// считается нулём — так же, как в JS отсутствующее поле давало `0`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PerfStats {
    pub p50: Option<f64>,
    pub p99: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
}

impl From<LagSnapshot> for PerfStats {
    fn from(snapshot: LagSnapshot) -> Self {
        Self {
            p50: Some(snapshot.p50),
            p99: Some(snapshot.p99),
            max: Some(snapshot.max),
            mean: Some(snapshot.mean),
        }
    }
}

/// Всё, что нужно для отчёта: собирает вызывающий.
#[derive(Debug, Default)]
pub struct HealthContext {
    pub app_name: Option<String>,
    pub version: Option<String>,
    /// Чем запущено приложение; по умолчанию — «tauri».
    pub mode: Option<String>,
    pub uptime_sec: Option<f64>,
    pub port: Option<u16>,
    /// `Some(false)` означает «порт не слушается»; отсутствие — что слушается.
    pub listening: Option<bool>,
    pub ws_clients: Option<u64>,
    pub ws_by_role: Option<Map<String, Value>>,
    pub session: Option<Value>,
    pub integrations: Option<Map<String, Value>>,
    /// `Database::storage_stats()`.
    pub storage: Option<Value>,
    /// Счётчики записи снапшота.
    pub writes: Option<StatsSnapshot>,
    pub perf: Option<PerfStats>,
    pub longrun: Option<LongRunSnapshot>,
    /// Числа доступа из сети: отказы по токену, по HTTP, срабатывания
    /// ограничителя частоты и счётчики журнала команд.
    pub security: Option<Value>,
}

/// Собрать отчёт о состоянии.
pub fn build_health_report(ctx: &HealthContext) -> Value {
    let writes = normalize_writes(ctx.writes.as_ref());
    let storage = ctx.storage.as_ref().and_then(normalize_storage);
    let longrun = ctx.longrun.as_ref().map(normalize_longrun);
    let security = ctx.security.as_ref().and_then(normalize_security);
    let perf = ctx.perf.as_ref().map(normalize_perf);
    let problems = collect_problems(
        ctx,
        writes.as_ref(),
        storage.as_ref(),
        perf.as_ref(),
        longrun.as_ref(),
    );

    json!({
        "at": chrono::Utc::now().timestamp_millis(),
        "ok": problems.is_empty(),
        "app": ctx.app_name.clone().unwrap_or_else(|| "Open Stream Environment".to_string()),
        "version": ctx.version.clone().map(Value::from).unwrap_or(Value::Null),
        "mode": ctx.mode.clone().unwrap_or_else(|| "tauri".to_string()),
        "pid": std::process::id(),
        "uptimeSec": math_max0_round(ctx.uptime_sec.unwrap_or(0.0)),
        "port": match ctx.port.filter(|port| *port > 0) {
            Some(port) => json!(port),
            None => Value::Null,
        },
        "listening": ctx.listening != Some(false),
        "server": {
            "clients": ctx.ws_clients.unwrap_or(0),
            // Копия: отчёт не должен быть окном в живые структуры.
            "byRole": Value::Object(ctx.ws_by_role.clone().unwrap_or_default()),
        },
        "session": ctx.session.clone().unwrap_or(Value::Null),
        "integrations": Value::Object(ctx.integrations.clone().unwrap_or_default()),
        "storage": storage.unwrap_or(Value::Null),
        "writes": writes.unwrap_or(Value::Null),
        "perf": perf.unwrap_or(Value::Null),
        "longrun": longrun.unwrap_or(Value::Null),
        "security": security.unwrap_or(Value::Null),
        "problems": problems,
    })
}

/// Короткий список того, что не так.
fn collect_problems(
    ctx: &HealthContext,
    writes: Option<&Value>,
    storage: Option<&Value>,
    perf: Option<&Value>,
    longrun: Option<&Value>,
) -> Vec<String> {
    let mut problems = Vec::new();

    if ctx.listening == Some(false) {
        problems.push("сервер не слушает порт".to_string());
    }

    let failed = writes
        .and_then(|writes| writes.pointer("/database/failed"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if failed > 0 {
        problems.push(format!("ошибки записи БД: {failed}"));
    }

    // Ошибки записи истории: их тексты пользователю видны и важны.
    let mut storage_errors = Vec::new();
    if let Some(storage) = storage {
        for key in ["database", "history", "chat"] {
            let error = storage
                .get(key)
                .and_then(|entry| entry.get("lastError"))
                .and_then(Value::as_str);
            if let Some(error) = error {
                storage_errors.push(format!("{key}: {error}"));
            }
        }
    }
    if !storage_errors.is_empty() {
        problems.push(format!(
            "ошибки записи истории: {}",
            storage_errors.join("; ")
        ));
    }

    if let Some(perf) = perf {
        let max = perf["max"].as_f64().unwrap_or(0.0);
        if max > PERF_PROBLEM_MS {
            problems.push(format!("лаг event loop: max {} ms", perf["max"]));
        }
    }

    // Рост памяти считается тревожным только по нескольким образцам: по одному
    // сделать вывод нельзя, а два-три часа — уже тенденция.
    if let Some(longrun) = longrun {
        let samples = longrun["samples"].as_u64().unwrap_or(0);
        let growth = longrun["growthMbPerHour"].as_f64().unwrap_or(0.0);
        if samples >= 3 && growth >= GROWTH_WARN_MB_PER_HOUR {
            problems.push(format!(
                "рост памяти {} MB/ч (порог {GROWTH_WARN_MB_PER_HOUR})",
                longrun["growthMbPerHour"]
            ));
        }
    }

    problems
}

/// Счётчики записи снапшота — без служебных полей и с округлённым временем.
fn normalize_writes(snapshot: Option<&StatsSnapshot>) -> Option<Value> {
    let snapshot = snapshot?;
    Some(json!({
        "database": {
            "writes": snapshot.total.writes,
            "bytes": snapshot.total.bytes,
            "coalesced": snapshot.total.coalesced,
            "failed": snapshot.total.failed,
            "backups": snapshot.total.backups,
            "maxMs": number_value(round(snapshot.total.max_ms)),
            "windowWrites": snapshot.window.writes,
        },
    }))
}

/// Хранилище — только метрики: размеры, число записей, лимиты и последняя
/// ошибка. Пути сюда не попадают намеренно (см. заголовок модуля).
fn normalize_storage(storage: &Value) -> Option<Value> {
    if !storage.is_object() {
        return None;
    }
    let part = |entry: Option<&Value>| match entry.and_then(Value::as_object) {
        None => Value::Null,
        Some(entry) => {
            let mut out = Map::new();
            out.insert(
                "bytes".to_string(),
                number_value(js_number_or_zero(entry.get("bytes"))),
            );
            for key in ["count", "limit"] {
                // Поля может не быть вовсе — тогда в отчёте его тоже нет.
                match entry.get(key).and_then(Value::as_f64) {
                    Some(value) if value.is_finite() => {
                        out.insert(key.to_string(), number_value(value));
                    }
                    _ => {}
                }
            }
            out.insert(
                "lastError".to_string(),
                match entry.get("lastError") {
                    Some(value) if js_truthy(Some(value)) => Value::from(js_key(value)),
                    _ => Value::Null,
                },
            );
            Value::Object(out)
        }
    };
    Some(json!({
        "database": part(storage.get("database")),
        "history": part(storage.get("history")),
        "chat": part(storage.get("chat")),
        "sessions": number_value(js_number_or_zero(storage.get("sessions"))),
    }))
}

/// Долгий прогон — только сводка: история образцов идёт в отчёт для поддержки,
/// а `/healthz` должен оставаться коротким.
fn normalize_longrun(snapshot: &LongRunSnapshot) -> Value {
    json!({
        "uptimeSec": snapshot.uptime_sec.max(0),
        "samples": snapshot.samples,
        "rssMb": snapshot.rss_mb,
        "peakRssMb": snapshot.peak_rss_mb,
        "heapUsedMb": snapshot.heap_used_mb,
        "wsClients": snapshot.ws_clients,
        "reconnects": Value::Object(snapshot.reconnects.clone()),
        "reconnectsTotal": number_value(js_number_or_zero(Some(&json!(snapshot.reconnects_total)))),
        "growthMbPerHour": number_value(round(snapshot.growth_mb_per_hour)),
        "lagMaxMs": number_value(round(snapshot.lag_max_ms)),
    })
}

/// Доступ из сети — числа, а не флаги: по ним видно, стучится ли кто-то в порт
/// без кода и не зациклил ли команды чужой скрипт.
fn normalize_security(security: &Value) -> Option<Value> {
    if !security.is_object() {
        return None;
    }
    let audit = security
        .get("audit")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let counter = |key: &str| number_value(js_number_or_zero(security.get(key)));
    let audit_counter = |key: &str| number_value(js_number_or_zero(audit.get(key)));

    Some(json!({
        "tokenRequired": security.get("tokenRequired") != Some(&Value::Bool(false)),
        "deniedUpgrade": counter("deniedUpgrade"),
        "deniedHttp": counter("deniedHttp"),
        "rateLimited": counter("rateLimited"),
        "audit": {
            "total": audit_counter("total"),
            "external": audit_counter("external"),
            "limited": audit_counter("limited"),
            "kept": audit_counter("kept"),
        },
    }))
}

fn normalize_perf(perf: &PerfStats) -> Value {
    json!({
        "p50": number_value(round(perf.p50.unwrap_or(0.0))),
        "p99": number_value(round(perf.p99.unwrap_or(0.0))),
        "max": number_value(round(perf.max.unwrap_or(0.0))),
        "mean": number_value(round(perf.mean.unwrap_or(0.0))),
    })
}

/// `Math.max(0, Math.round(value))`.
fn math_max0_round(value: f64) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    let rounded = value.round();
    if rounded < 0.0 {
        0
    } else {
        rounded as i64
    }
}

/// Округление до десятых, как `Number(x.toFixed(1))`.
fn round(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::async_store::Stats;

    fn writes_stats(total_failed: u64, max_ms: f64) -> StatsSnapshot {
        StatsSnapshot {
            label: "local-db.json".to_string(),
            window: Stats {
                writes: 2,
                bytes: 15000,
                coalesced: 38,
                failed: 0,
                backups: 1,
                total_ms: 4.0,
                max_ms: 2.0,
            },
            total: Stats {
                writes: 40,
                bytes: 300000,
                coalesced: 900,
                failed: total_failed,
                backups: 3,
                total_ms: 80.0,
                max_ms,
            },
        }
    }

    /// Полный контекст — как `fullContext()` в тесте JS.
    fn full_context() -> HealthContext {
        HealthContext {
            app_name: Some("Open Stream Environment".to_string()),
            version: Some("3.1.0".to_string()),
            mode: None,
            uptime_sec: Some(3661.4),
            port: Some(8710),
            listening: Some(true),
            ws_clients: Some(3),
            ws_by_role: Some(Map::from_iter([
                ("overlay".to_string(), json!(2)),
                ("control".to_string(), json!(1)),
            ])),
            session: Some(json!({ "id": "s1", "channel": "halantar", "startedAt": 1 })),
            integrations: Some(Map::from_iter([
                ("twitchChat".to_string(), json!("connected")),
                ("obs".to_string(), json!("disconnected")),
            ])),
            storage: Some(json!({
                "dir": "C:\\Users\\streamer\\AppData\\Roaming\\OSE",
                "database": { "path": "C:\\Users\\streamer\\local-db.json", "bytes": 7500, "lastError": null },
                "history": { "path": "C:\\Users\\streamer\\local-db.jsonl", "bytes": 10600, "count": 42, "limit": 20000, "lastError": null },
                "chat": { "path": "C:\\Users\\streamer\\local-db.chat.jsonl", "bytes": 124, "count": 2, "limit": 10000, "lastError": null },
                "sessions": 7,
            })),
            writes: Some(writes_stats(0, 12.34)),
            perf: Some(PerfStats {
                p50: Some(0.4),
                p99: Some(3.2),
                max: Some(8.8),
                mean: Some(0.9),
            }),
            longrun: None,
            security: None,
        }
    }

    #[test]
    fn healthy_state_has_no_problems() {
        let report = build_health_report(&full_context());

        assert_eq!(report["ok"], json!(true));
        assert_eq!(report["problems"], json!([]));
        assert_eq!(report["version"], json!("3.1.0"));
        assert_eq!(report["port"], json!(8710));
        assert_eq!(report["uptimeSec"], json!(3661));
        assert_eq!(
            report["server"],
            json!({ "clients": 3, "byRole": { "overlay": 2, "control": 1 } })
        );
        assert_eq!(report["integrations"]["twitchChat"], json!("connected"));
        assert_eq!(report["storage"]["database"]["bytes"], json!(7500));
        assert_eq!(
            report["storage"]["history"],
            json!({ "bytes": 10600, "count": 42, "limit": 20000, "lastError": null })
        );
        assert_eq!(report["writes"]["database"]["writes"], json!(40));
        assert_eq!(report["writes"]["database"]["backups"], json!(3));
        assert_eq!(report["writes"]["database"]["maxMs"], json!(12.3));
        assert_eq!(report["perf"]["max"], json!(8.8));
        assert!(report["at"].is_number());
        assert!(report["pid"].is_number());
        assert_eq!(report["mode"], json!("tauri"));
    }

    #[test]
    fn report_does_not_leak_paths() {
        let text = serde_json::to_string(&build_health_report(&full_context())).unwrap();

        assert!(!text.contains("streamer"), "{text}");
        assert!(!text.contains("local-db.json"), "{text}");
        assert!(!text.contains("AppData"), "{text}");
        assert!(!text.contains("path"), "{text}");
    }

    #[test]
    fn a_port_that_is_not_listening_is_a_problem() {
        let mut ctx = full_context();
        ctx.listening = Some(false);

        let report = build_health_report(&ctx);

        assert_eq!(report["ok"], json!(false));
        assert!(report["problems"]
            .as_array()
            .unwrap()
            .contains(&json!("сервер не слушает порт")));
    }

    #[test]
    fn write_errors_of_the_database_and_history_become_problems() {
        let mut ctx = full_context();
        ctx.writes = Some(writes_stats(4, 12.34));
        if let Some(storage) = ctx.storage.as_mut() {
            storage["history"]["lastError"] = json!("ENOSPC: no space left on device");
        }

        let report = build_health_report(&ctx);

        assert_eq!(report["ok"], json!(false));
        let text = report["problems"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap_or_default().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("ошибки записи БД: 4"), "{text}");
        assert!(text.contains("ENOSPC"), "{text}");
    }

    #[test]
    fn high_lag_is_a_problem_and_low_lag_is_not() {
        let mut low = full_context();
        low.perf = Some(PerfStats {
            max: Some(PERF_PROBLEM_MS - 1.0),
            ..PerfStats::default()
        });
        assert_eq!(build_health_report(&low)["problems"], json!([]));

        let mut high = full_context();
        high.perf = Some(PerfStats {
            max: Some(PERF_PROBLEM_MS + 25.0),
            ..PerfStats::default()
        });
        let report = build_health_report(&high);
        assert_eq!(report["ok"], json!(false));
        assert!(report["problems"][0]
            .as_str()
            .unwrap_or_default()
            .contains("лаг event loop"));
    }

    #[test]
    fn memory_growth_needs_several_samples_to_become_a_problem() {
        let mut two = full_context();
        two.longrun = Some(LongRunSnapshot {
            samples: 2,
            growth_mb_per_hour: 400.0,
            rss_mb: 300,
            peak_rss_mb: 300,
            ..LongRunSnapshot::default()
        });
        assert_eq!(build_health_report(&two)["problems"], json!([]));

        let mut many = full_context();
        many.longrun = Some(LongRunSnapshot {
            samples: 6,
            growth_mb_per_hour: 400.0,
            rss_mb: 300,
            peak_rss_mb: 300,
            reconnects: Map::from_iter([("twitchChat".to_string(), json!(2))]),
            reconnects_total: 2.0,
            ..LongRunSnapshot::default()
        });
        let report = build_health_report(&many);
        assert_eq!(report["ok"], json!(false));
        let text = report["problems"][0].as_str().unwrap_or_default();
        assert!(text.contains("рост памяти 400 MB/ч"), "{text}");
        assert_eq!(report["longrun"]["reconnectsTotal"], json!(2));
        // История образцов в /healthz не уезжает.
        assert!(report["longrun"].get("history").is_none());
    }

    #[test]
    fn missing_data_does_not_break_the_report() {
        let report = build_health_report(&HealthContext::default());

        assert_eq!(report["ok"], json!(true));
        assert_eq!(report["version"], Value::Null);
        assert_eq!(report["port"], Value::Null);
        assert_eq!(report["storage"], Value::Null);
        assert_eq!(report["writes"], Value::Null);
        assert_eq!(report["perf"], Value::Null);
        assert_eq!(report["longrun"], Value::Null);
        assert_eq!(report["security"], Value::Null);
        assert_eq!(report["server"], json!({ "clients": 0, "byRole": {} }));
        assert_eq!(report["session"], Value::Null);
    }

    #[test]
    fn negative_uptime_is_clamped_to_zero() {
        let ctx = HealthContext {
            uptime_sec: Some(-5.0),
            ..HealthContext::default()
        };
        assert_eq!(build_health_report(&ctx)["uptimeSec"], json!(0));
    }

    #[test]
    fn copies_of_roles_and_integrations_are_not_linked_to_the_source() {
        let ctx = full_context();
        let report = build_health_report(&ctx);

        // Правим отчёт — источник не меняется.
        let mut report = report;
        report["server"]["byRole"]["overlay"] = json!(99);
        report["integrations"]["twitchChat"] = json!("changed");

        assert_eq!(ctx.ws_by_role.as_ref().unwrap()["overlay"], json!(2));
        assert_eq!(
            ctx.integrations.as_ref().unwrap()["twitchChat"],
            json!("connected")
        );
    }

    #[test]
    fn security_numbers_are_normalized() {
        let mut ctx = full_context();
        ctx.security = Some(json!({
            "tokenRequired": false,
            "deniedUpgrade": 2,
            "deniedHttp": "3",
            "rateLimited": 0,
            "audit": { "total": 12, "external": 4, "limited": 1, "kept": 200 },
        }));

        let report = build_health_report(&ctx);

        assert_eq!(report["security"]["tokenRequired"], json!(false));
        assert_eq!(report["security"]["deniedUpgrade"], json!(2));
        assert_eq!(report["security"]["deniedHttp"], json!(3));
        assert_eq!(report["security"]["audit"]["kept"], json!(200));

        // Флага нет вовсе — токен считается обязательным.
        ctx.security = Some(json!({}));
        assert_eq!(
            build_health_report(&ctx)["security"]["tokenRequired"],
            json!(true)
        );
    }

    #[test]
    fn storage_without_counters_keeps_bytes_and_error_only() {
        let mut ctx = full_context();
        ctx.storage = Some(json!({
            "database": { "path": "C:/x.json", "bytes": 10, "lastError": "диск полон" },
            "history": "не объект",
            "sessions": "7",
        }));

        let report = build_health_report(&ctx);

        assert_eq!(
            report["storage"]["database"],
            json!({ "bytes": 10, "lastError": "диск полон" })
        );
        assert_eq!(report["storage"]["history"], Value::Null);
        assert_eq!(report["storage"]["sessions"], json!(7));
    }
}
