//! Терминал панели — порт `server/cli.js`.
//!
//! Одна строка команды приходит по шине (`exec_cli_command`) и управляет уже
//! перенесёнными подсистемами: сцены и камеры OBS, саундборд, счёт смертей,
//! колесо/розыгрыш, темы, цель, симуляции событий и медиа. Каждый ответ уходит
//! строкой журнала сервиса `CLI` — панель рисует её в терминале.
//!
//! Переводы берутся из тех же `shared/locales/*.json` (ключи `cli.*`), что и у
//! фронта: сервер шлёт строки уже готовыми. Автодополнение (`exec_cli_completion`)
//! уходит ответным кадром только запросившему клиенту.
//!
//! Отличие от JS: у `Math.random()` (выбор имени в `alert`) здесь нет источника
//! случайности — имя берётся по кругу от часов, само поведение то же.

use serde_json::{json, Value};

use crate::diagnostics::Diagnostics;
use crate::integrations::chat_moderation::ModerationEngine;
use crate::integrations::twitch_eventsub::{match_camera_angle, match_camera_filter};
use crate::protocol::event_types;
use crate::server::locales::Locales;
use crate::server::remote;
use crate::state::{appearance, config};
use crate::storage::history::{js_number, js_truthy};
use crate::storage::logger::Logger;
use crate::storage::media;

/// Метка места подстановки в шаблоне ошибки: сама ошибка известна только после
/// сетевого вызова, а перевести строку нужно до запуска задачи.
const ERR: char = '\u{1}';

/// Команды верхнего уровня — для подсказок и автодополнения.
const COMMANDS: &[&str] = &[
    "scene", "cam", "filter", "sound", "death", "wheel", "giveaway", "sim", "alert", "chat",
    "theme", "themes", "goal", "obs", "sounds", "cameras", "filters", "logs", "media", "modtest",
    "lang", "status", "clear", "help",
];

/// Подкоманды составных команд.
const SUBCOMMANDS: &[(&str, &[&str])] = &[
    ("sim", &["sub", "points", "raid"]),
    ("wheel", &["spin", "generate", "reset", "clear"]),
    (
        "giveaway",
        &[
            "start",
            "stop",
            "add",
            "remove",
            "shuffle",
            "elimination",
            "list",
        ],
    ),
    ("death", &["+1", "-1", "set", "reset"]),
    ("goal", &["add"]),
    ("lang", &["ru", "en"]),
    ("alert", &["follow", "sub", "gift_sub", "cheer", "donation"]),
    ("logs", &["info", "success", "warn", "error", "hint", "all"]),
    ("media", &["list", "cleanup"]),
];

/// Строки справки `help` — ключи локалей `cli.help.*`.
const HELP_KEYS: &[&str] = &[
    "scene",
    "cam",
    "filter",
    "sound",
    "death",
    "wheel",
    "giveaway",
    "simSub",
    "simPoints",
    "simRaid",
    "alert",
    "chat",
    "theme",
    "goal",
    "obs",
    "lists",
    "logs",
    "media",
    "modtest",
    "lang",
    "status",
    "clear",
    "help",
];

/// Выполнить строку команды.
pub fn execute(diagnostics: &Diagnostics, locales: Option<&Locales>, raw: &str) {
    let line = raw.trim();
    if line.is_empty() {
        return;
    }
    let parts: Vec<&str> = line.split_whitespace().collect();
    let cmd = parts[0].to_lowercase();
    let args = &parts[1..];

    let cli = Cli {
        diagnostics,
        locales,
        lang: diagnostics.language(),
        logger: diagnostics.logger("CLI"),
    };

    match cmd.as_str() {
        "help" => cli.help(),
        "status" => cli.status(),
        "scene" => cli.scene(args.first().copied()),
        "cam" => cli.cam(args.first().copied()),
        "filter" => cli.filter(args.first().copied(), args.get(1).copied()),
        "sound" => cli.sound(args.first().copied()),
        "death" => cli.death(args.first().copied(), args.get(1).copied()),
        "wheel" => cli.wheel(&args.first().copied().unwrap_or("").to_lowercase()),
        "giveaway" => cli.giveaway(args),
        "sim" => cli.sim(args),
        "alert" => cli.alert(args.first().copied()),
        "chat" => cli.chat(&args.join(" ")),
        "modtest" => cli.modtest(&args.join(" ")),
        "theme" => cli.theme(args.first().copied()),
        "themes" => cli.themes(),
        "goal" => cli.goal(args),
        "obs" => cli.obs(args.first().copied()),
        "sounds" => cli.list_sounds(),
        "cameras" => cli.list_cameras(),
        "filters" => cli.list_filters(),
        "lang" => cli.lang(args.first().copied()),
        "logs" => cli.logs(args.first().copied()),
        "media" => cli.media(args.first().copied()),
        "clear" => {
            cli.broadcast(event_types::CLEAR_TERMINAL, json!({}));
            cli.log("success", &cli.t("cli.clear.done", &[]));
        }
        _ => cli.log("error", &cli.t("cli.unknownCommand", &[])),
    }
}

/// Подсказки автодополнения: полные строки с хвостовым пробелом — как в JS.
pub fn completions(diagnostics: &Diagnostics, current_input: &str) -> Vec<String> {
    let input = current_input.to_string();
    let trimmed = input.trim_start();
    let ends_with_space = trimmed.ends_with(char::is_whitespace);
    let parts: Vec<&str> = trimmed.split_whitespace().collect();

    // Пустой ввод или набор имени команды.
    if parts.is_empty() || (parts.len() == 1 && !ends_with_space) {
        let prefix = parts.first().copied().unwrap_or("").to_lowercase();
        return COMMANDS
            .iter()
            .filter(|cmd| cmd.starts_with(&prefix))
            .map(|cmd| format!("{cmd} "))
            .collect();
    }

    let cmd = parts[0].to_lowercase();

    // Составные команды.
    if let Some(subcommands) = SUBCOMMANDS
        .iter()
        .find(|(name, _)| *name == cmd)
        .map(|(_, list)| *list)
    {
        if parts.len() == 1 && ends_with_space {
            return subcommands
                .iter()
                .map(|sub| format!("{cmd} {sub} "))
                .collect();
        }
        if parts.len() == 2 && !ends_with_space {
            let prefix = parts[1].to_lowercase();
            return subcommands
                .iter()
                .filter(|sub| sub.to_lowercase().starts_with(&prefix))
                .map(|sub| format!("{cmd} {sub} "))
                .collect();
        }
        return Vec::new();
    }

    // Динамические аргументы (scene/sound/cam/filter/theme/obs).
    let Some(list) = arg_list(diagnostics, &cmd) else {
        return Vec::new();
    };
    if parts.len() == 1 && ends_with_space {
        return list
            .into_iter()
            .map(|arg| format!("{cmd} {arg} "))
            .collect();
    }
    if parts.len() == 2 && !ends_with_space {
        let prefix = parts[1].to_lowercase();
        return list
            .into_iter()
            .filter(|arg| arg.to_lowercase().starts_with(&prefix))
            .map(|arg| format!("{cmd} {arg} "))
            .collect();
    }
    Vec::new()
}

/// Что подставить после команды: сцены, звуки, камеры, фильтры, темы, команды OBS.
fn arg_list(diagnostics: &Diagnostics, cmd: &str) -> Option<Vec<String>> {
    let config = diagnostics.config();
    let obs = config.get("obs");
    let strings = |list: &Value, key: &str| -> Vec<String> {
        list.as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get(key).and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    match cmd {
        "scene" => Some(
            obs.and_then(|obs| obs.get("sceneMap"))
                .and_then(Value::as_object)
                .map(|map| map.keys().cloned().collect())
                .unwrap_or_default(),
        ),
        "sound" => Some(strings(
            obs.and_then(|_| config.get("soundboard"))
                .and_then(|sb| sb.get("sounds"))
                .unwrap_or(&Value::Null),
            "id",
        )),
        "cam" => Some(strings(
            obs.and_then(|obs| obs.get("cameraAngles"))
                .unwrap_or(&Value::Null),
            "id",
        )),
        "filter" => Some(strings(
            obs.and_then(|obs| obs.get("cameraFilters"))
                .unwrap_or(&Value::Null),
            "id",
        )),
        "theme" => Some(
            appearance::list_themes(&config)
                .iter()
                .filter_map(|theme| theme.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect(),
        ),
        "obs" => {
            let mut out = vec!["list".to_string()];
            out.extend(strings(
                obs.and_then(|obs| obs.get("customCommands"))
                    .unwrap_or(&Value::Null),
                "id",
            ));
            Some(out)
        }
        _ => None,
    }
}

/// Контекст одной команды: диагностика, словари, язык и журнал службы `CLI`.
struct Cli<'a> {
    diagnostics: &'a Diagnostics,
    locales: Option<&'a Locales>,
    lang: &'static str,
    logger: Logger,
}

impl Cli<'_> {
    fn t(&self, key: &str, params: &[(&str, String)]) -> String {
        match self.locales {
            Some(locales) => locales.translate(self.lang, key, params),
            None => key.to_string(),
        }
    }

    fn log(&self, level: &str, message: &str) {
        match level {
            "success" => self.logger.success(message, None),
            "warn" => self.logger.warn(message, None),
            "error" => self.logger.error(message, None),
            _ => self.logger.info(message, None),
        }
    }

    fn broadcast(&self, kind: &str, payload: Value) {
        let text = json!({ "type": kind, "payload": payload }).to_string();
        self.diagnostics.clients().broadcast_text(&text);
    }

    fn emit(&self, kind: &str, payload: Value) {
        self.diagnostics
            .emit_bus(json!({ "type": kind, "payload": payload }));
    }

    fn broadcast_giveaway(&self, giveaway: &Value) {
        self.broadcast(
            event_types::GIVEAWAY_UPDATE,
            json!({ "giveaway": giveaway }),
        );
        self.broadcast(
            event_types::GIVEAWAY_PARTICIPANTS,
            json!({
                "count": giveaway.get("count").cloned().unwrap_or(Value::Null),
                "participants": giveaway.get("participants").cloned().unwrap_or(Value::Null),
            }),
        );
    }

    fn help(&self) {
        self.log("info", &self.t("cli.availableCommands", &[]));
        for key in HELP_KEYS {
            let line = self.t(&format!("cli.help.{key}"), &[]);
            self.log("info", &format!("  {line}"));
        }
    }

    fn scene(&self, name: Option<&str>) {
        let scene = name.unwrap_or("").trim().to_lowercase();
        if scene.is_empty() {
            self.log("error", &self.t("cli.scene.usage", &[]));
            return;
        }
        let mapped = {
            let config = self.diagnostics.config();
            config
                .get("obs")
                .and_then(|obs| obs.get("sceneMap"))
                .and_then(|map| map.get(scene.as_str()))
                .map(crate::state::js_string)
                .unwrap_or_default()
        };
        let scene_name = if mapped.is_empty() {
            scene.clone()
        } else {
            mapped
        };
        let obs = self.diagnostics.obs();
        let obs_connected = obs.is_connected();
        if obs_connected {
            obs.switch_scene(&scene_name);
        }
        let started_at = {
            let mut runtime = self.diagnostics.runtime();
            runtime.set_active_scene(&Value::from(scene.clone()), now_ms());
            runtime.scene_started_at()
        };
        self.broadcast(
            event_types::REMOTE_ACTION,
            json!({
                "action": "SCENE_SET",
                "payload": { "scene": scene, "startedAt": started_at },
            }),
        );
        let mut message = self.t(
            "cli.scene.switched",
            &[("scene", scene), ("name", scene_name)],
        );
        if !obs_connected {
            message.push_str(&self.t("cli.obsOffline", &[]));
        }
        self.log("success", &message);
    }

    fn cam(&self, angle_id: Option<&str>) {
        let Some(angle_id) = angle_id.filter(|id| !id.is_empty()) else {
            self.log("error", &self.t("cli.cam.usage", &[]));
            return;
        };
        let obs = self.diagnostics.obs();
        if !obs.is_connected() {
            self.log("error", &self.t("cli.cam.obsOffline", &[]));
            return;
        }
        let angle_id = angle_id.to_string();
        let success = self.t("cli.cam.switched", &[("id", angle_id.clone())]);
        let failed = self.t("cli.cam.failed", &[("error", ERR.to_string())]);
        let logger = self.logger.clone();
        std::mem::drop(tauri::async_runtime::spawn(async move {
            match obs.set_camera_angle(&angle_id).await {
                Ok(_) => log(&logger, "success", &success),
                Err(error) => log(&logger, "error", &failed.replace(ERR, &error)),
            }
        }));
    }

    fn filter(&self, filter_id: Option<&str>, duration_arg: Option<&str>) {
        let Some(filter_id) = filter_id.filter(|id| !id.is_empty()) else {
            self.log("error", &self.t("cli.filter.usage", &[]));
            return;
        };
        let obs = self.diagnostics.obs();
        if !obs.is_connected() {
            self.log("error", &self.t("cli.filter.obsOffline", &[]));
            return;
        }
        let duration = duration_arg
            .filter(|arg| !arg.is_empty())
            .map(|arg| js_number(Some(&Value::from(arg))));
        let filter_id = filter_id.to_string();
        let success = self.t("cli.filter.activated", &[("id", filter_id.clone())]);
        let failed = self.t("cli.filter.failed", &[("error", ERR.to_string())]);
        let logger = self.logger.clone();
        std::mem::drop(tauri::async_runtime::spawn(async move {
            match obs.trigger_camera_filter(&filter_id, duration).await {
                Ok(_) => log(&logger, "success", &success),
                Err(error) => log(&logger, "error", &failed.replace(ERR, &error)),
            }
        }));
    }

    fn sound(&self, sound_id: Option<&str>) {
        let Some(sound_id) = sound_id.filter(|id| !id.is_empty()) else {
            self.log("error", &self.t("cli.sound.usage", &[]));
            return;
        };
        let sound = {
            let config = self.diagnostics.config();
            sound_in_config(config.value(), sound_id, true)
        };
        let Some(sound) = sound else {
            self.log(
                "error",
                &self.t("cli.sound.notFound", &[("id", sound_id.to_string())]),
            );
            return;
        };
        let name = sound_name(&sound);
        self.emit("soundboard_play", soundboard_payload(&sound, "CLI"));
        self.log("success", &self.t("cli.sound.played", &[("name", name)]));
    }

    fn death(&self, arg: Option<&str>, value: Option<&str>) {
        let arg = arg.unwrap_or("");
        let result = match arg {
            "+1" | "inc" | "increase" => {
                Some(self.diagnostics.runtime().adjust_death_count(&json!(1)))
            }
            "-1" | "dec" | "decrease" => {
                Some(self.diagnostics.runtime().adjust_death_count(&json!(-1)))
            }
            "reset" | "0" => Some(self.diagnostics.runtime().reset_death_count()),
            "set" => {
                let target = js_number(value.map(Value::from).as_ref()).max(0.0).round();
                let current = js_number(Some(&self.diagnostics.runtime().death_count()));
                let delta = target - current;
                Some(self.diagnostics.runtime().adjust_death_count(&json!(delta)))
            }
            _ => None,
        };
        let Some(result) = result else {
            self.log("error", &self.t("cli.death.usage", &[]));
            return;
        };
        self.broadcast(event_types::DEATH_COUNT_UPDATE, result.clone());
        self.log(
            "success",
            &self.t(
                "cli.death.result",
                &[(
                    "count",
                    crate::state::js_string(result.get("count").unwrap_or(&Value::Null)),
                )],
            ),
        );
    }

    fn wheel(&self, sub: &str) {
        let action = match sub {
            "spin" => "WHEEL_SPIN",
            "generate" => "WHEEL_GENERATE",
            "reset" => "WHEEL_RESET_PARTICIPANTS",
            "clear" => "WHEEL_CLEAR_RESULT",
            _ => {
                self.log("error", &self.t("cli.wheel.usage", &[]));
                return;
            }
        };
        remote::handle(
            self.diagnostics,
            &json!({ "action": action, "payload": {} }),
        );
        self.log(
            "success",
            &self.t("cli.wheel.done", &[("sub", sub.to_string())]),
        );
    }

    fn giveaway(&self, args: &[&str]) {
        let sub = args.first().copied().unwrap_or("").to_lowercase();
        match sub.as_str() {
            "start" | "stop" => {
                let action = if sub == "start" {
                    "WHEEL_START"
                } else {
                    "WHEEL_STOP"
                };
                let payload = if sub == "start" {
                    json!({ "command": args.get(1).copied() })
                } else {
                    json!({})
                };
                remote::handle(
                    self.diagnostics,
                    &json!({ "action": action, "payload": payload }),
                );
                let key = if sub == "start" {
                    "cli.giveaway.started"
                } else {
                    "cli.giveaway.stopped"
                };
                self.log("success", &self.t(key, &[]));
            }
            "add" => {
                let Some(name) = args.get(1).copied().filter(|name| !name.is_empty()) else {
                    self.log("error", &self.t("cli.giveaway.addUsage", &[]));
                    return;
                };
                let added = {
                    self.diagnostics
                        .runtime()
                        .add_giveaway_participant(&Value::from(name))
                };
                match added {
                    Some(giveaway) => {
                        self.broadcast_giveaway(&giveaway);
                        self.log(
                            "success",
                            &self.t("cli.giveaway.added", &[("name", name.to_string())]),
                        );
                    }
                    None => self.log(
                        "warn",
                        &self.t("cli.giveaway.duplicate", &[("name", name.to_string())]),
                    ),
                }
            }
            "remove" => {
                let Some(name) = args.get(1).copied().filter(|name| !name.is_empty()) else {
                    self.log("error", &self.t("cli.giveaway.removeUsage", &[]));
                    return;
                };
                let giveaway = {
                    self.diagnostics
                        .runtime()
                        .remove_giveaway_participant(&Value::from(name))
                };
                self.broadcast_giveaway(&giveaway);
                self.log(
                    "success",
                    &self.t("cli.giveaway.removed", &[("name", name.to_string())]),
                );
            }
            "shuffle" => {
                let giveaway = { self.diagnostics.runtime().shuffle_giveaway() };
                self.broadcast_giveaway(&giveaway);
                self.log("success", &self.t("cli.giveaway.shuffled", &[]));
            }
            "elimination" => {
                let on = matches!(args.get(1).copied(), Some("on" | "1" | "true"));
                let giveaway = {
                    self.diagnostics
                        .runtime()
                        .set_giveaway_elimination_mode(&Value::Bool(on))
                };
                self.broadcast_giveaway(&giveaway);
                let state_key = if on { "cli.on" } else { "cli.off" };
                self.log(
                    "success",
                    &self.t(
                        "cli.giveaway.elimination",
                        &[("state", self.t(state_key, &[]))],
                    ),
                );
            }
            "list" => {
                let giveaway = { self.diagnostics.runtime().giveaway_snapshot() };
                let count = crate::state::js_string(giveaway.get("count").unwrap_or(&Value::Null));
                let names = giveaway
                    .get("participants")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .map(crate::state::js_string)
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .filter(|joined| !joined.is_empty())
                    .unwrap_or_else(|| self.t("cli.none", &[]));
                self.log(
                    "info",
                    &self.t("cli.giveaway.list", &[("count", count), ("names", names)]),
                );
            }
            _ => self.log("error", &self.t("cli.giveaway.usage", &[])),
        }
    }

    fn sim(&self, args: &[&str]) {
        match args.first().copied().unwrap_or("").to_lowercase().as_str() {
            "sub" => self.sim_sub(args.get(1).copied(), args.get(2).copied()),
            "points" => {
                self.sim_points(&args.iter().skip(1).copied().collect::<Vec<_>>().join(" "))
            }
            "raid" => self.sim_raid(args.get(1).copied(), args.get(2).copied()),
            _ => self.log("error", &self.t("cli.sim.unknown", &[])),
        }
    }

    fn sim_sub(&self, username: Option<&str>, tier: Option<&str>) {
        let Some(username) = username.filter(|name| !name.is_empty()) else {
            self.log("error", &self.t("cli.sim.subUsage", &[]));
            return;
        };
        let tier = tier.filter(|t| !t.is_empty()).unwrap_or("1000");
        self.emit(
            "alert",
            json!({ "kind": "sub", "user": username, "tier": tier, "isTest": true }),
        );
        self.log(
            "success",
            &self.t(
                "cli.sim.subDone",
                &[("user", username.to_string()), ("tier", tier.to_string())],
            ),
        );
    }

    fn sim_points(&self, reward_title: &str) {
        let title = reward_title.trim();
        if title.is_empty() {
            self.log("error", &self.t("cli.sim.pointsUsage", &[]));
            return;
        }
        let mut matched = false;

        if self
            .diagnostics
            .run_reward_actions(&Value::Null, &Value::from(title), "CLI", "")
        {
            self.log(
                "success",
                &self.t("cli.sim.pointsActions", &[("title", title.to_string())]),
            );
            matched = true;
        }

        let (sound, angle, filter) = {
            let config = self.diagnostics.config();
            let value = config.value();
            let obs = value.get("obs");
            (
                sound_in_config(value, title, false),
                match_camera_angle(
                    obs.and_then(|obs| obs.get("cameraAngles"))
                        .unwrap_or(&Value::Null),
                    &Value::from(title),
                ),
                match_camera_filter(
                    obs.and_then(|obs| obs.get("cameraFilters"))
                        .unwrap_or(&Value::Null),
                    &Value::from(title),
                ),
            )
        };
        if let Some(sound) = sound {
            let name = sound_name(&sound);
            self.emit("soundboard_play", soundboard_payload(&sound, "CLI"));
            self.log(
                "success",
                &self.t(
                    "cli.sim.pointsSound",
                    &[("title", title.to_string()), ("name", name)],
                ),
            );
            matched = true;
        }
        if let Some(angle) = angle {
            let id = crate::state::js_string(angle.get("id").unwrap_or(&Value::Null));
            self.emit(
                "camera_angle_request",
                json!({ "angleId": id, "user": "CLI" }),
            );
            self.log(
                "success",
                &self.t(
                    "cli.sim.pointsCam",
                    &[("title", title.to_string()), ("id", id)],
                ),
            );
            matched = true;
        }
        if let Some(filter) = filter {
            let id = crate::state::js_string(filter.get("id").unwrap_or(&Value::Null));
            self.emit(
                "camera_filter_request",
                json!({ "filterId": id, "user": "CLI" }),
            );
            self.log(
                "success",
                &self.t(
                    "cli.sim.pointsFilter",
                    &[("title", title.to_string()), ("id", id)],
                ),
            );
            matched = true;
        }
        if !matched {
            self.log(
                "warn",
                &self.t("cli.sim.pointsNone", &[("title", title.to_string())]),
            );
        }
    }

    fn sim_raid(&self, username: Option<&str>, viewers: Option<&str>) {
        let Some(username) = username.filter(|name| !name.is_empty()) else {
            self.log("error", &self.t("cli.sim.raidUsage", &[]));
            return;
        };
        let count = js_number(viewers.map(Value::from).as_ref())
            .max(0.0)
            .round();
        let count_text = integer_text(count);
        let message = self.t(
            "cli.sim.raidMessage",
            &[
                ("user", username.to_string()),
                ("count", count_text.clone()),
            ],
        );
        self.emit(
            "chat_message",
            json!({
                "user": username,
                "color": "#e6e1e5",
                "badges": [],
                "message": message,
                "isTest": true,
            }),
        );
        self.log(
            "success",
            &self.t(
                "cli.sim.raidDone",
                &[("user", username.to_string()), ("count", count_text)],
            ),
        );
    }

    fn alert(&self, kind: Option<&str>) {
        let kind = kind.unwrap_or("");
        let valid = ["follow", "sub", "gift_sub", "cheer", "donation"];
        if !valid.contains(&kind) {
            self.log(
                "error",
                &self.t("cli.alert.unknown", &[("types", valid.join(", "))]),
            );
            return;
        }
        let names = ["nova_viewer", "star_gazer", "orbit_fan", "comet_watcher"];
        let user = names[(now_ms().unsigned_abs() as usize) % names.len()];
        let mut alert = json!({ "kind": kind, "user": user, "isTest": true });
        match kind {
            "sub" => alert["tier"] = json!("1000"),
            "gift_sub" => alert["count"] = json!(3),
            "cheer" => alert["amount"] = json!(250),
            "donation" => {
                alert["amount"] = json!(300);
                alert["currency"] = json!("RUB");
                alert["message"] = json!("Удачного стрима!");
            }
            _ => {}
        }
        self.emit("alert", alert);
        self.log(
            "success",
            &self.t("cli.alert.done", &[("kind", kind.to_string())]),
        );
    }

    fn chat(&self, message: &str) {
        if message.is_empty() {
            self.log("error", &self.t("cli.chat.usage", &[]));
            return;
        }
        self.emit(
            "chat_message",
            json!({ "user": "CLI", "color": "#e6e1e5", "badges": [], "message": message, "isTest": true }),
        );
        self.log(
            "success",
            &self.t("cli.chat.done", &[("message", message.to_string())]),
        );
    }

    fn modtest(&self, message: &str) {
        if message.is_empty() {
            self.log("error", &self.t("cli.modtest.usage", &[]));
            return;
        }
        let cfg = {
            let config = self.diagnostics.config();
            let mut cfg = config
                .get("chatBot")
                .and_then(|bot| bot.get("moderation"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            cfg.insert("enabled".to_string(), Value::Bool(true));
            Value::Object(cfg)
        };
        let engine = ModerationEngine::with_own_store(&cfg);
        let verdict = engine.check(&json!({
            "user": "test_user",
            "userId": "modtest",
            "message": message,
            "emotes": {},
            "level": "everyone",
        }));
        let Some(verdict) = verdict else {
            self.log("success", &self.t("cli.modtest.ok", &[]));
            return;
        };
        let action = if js_truthy(verdict.get("ban")) {
            "ban".to_string()
        } else {
            format!("timeout {}s", js_number(verdict.get("timeoutSec")))
        };
        self.log(
            "warn",
            &self.t(
                "cli.modtest.hit",
                &[
                    (
                        "type",
                        crate::state::js_string(verdict.get("type").unwrap_or(&Value::Null)),
                    ),
                    (
                        "warn",
                        crate::state::js_string(verdict.get("warn").unwrap_or(&Value::Null)),
                    ),
                    ("action", action),
                ],
            ),
        );
    }

    fn theme(&self, id: Option<&str>) {
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            self.log("error", &self.t("cli.theme.usage", &[]));
            return;
        };
        let changed = {
            let mut config = self.diagnostics.config();
            appearance::set_active_theme(&mut config, &Value::from(id), None)
        };
        if changed {
            let appearance = self.diagnostics.state_snapshot()["appearance"].clone();
            self.broadcast(event_types::THEME_UPDATE, appearance);
            self.log(
                "success",
                &self.t("cli.theme.switched", &[("id", id.to_string())]),
            );
        } else {
            self.log(
                "error",
                &self.t("cli.theme.notFound", &[("id", id.to_string())]),
            );
        }
    }

    fn themes(&self) {
        let themes = {
            let config = self.diagnostics.config();
            appearance::list_themes(&config)
        };
        if themes.is_empty() {
            self.log("info", &self.t("cli.themes.none", &[]));
            return;
        }
        self.log("info", &self.t("cli.themes.title", &[]));
        for theme in themes {
            let id = crate::state::js_string(theme.get("id").unwrap_or(&Value::Null));
            let name = crate::state::js_string(theme.get("name").unwrap_or(&Value::Null));
            let custom = if theme.get("builtin").and_then(Value::as_bool) == Some(true) {
                String::new()
            } else {
                self.t("cli.themes.custom", &[])
            };
            let category = theme
                .get("category")
                .and_then(Value::as_str)
                .filter(|category| !category.is_empty())
                .map(|category| format!(" [{category}]"))
                .unwrap_or_default();
            self.log("info", &format!("  {id} — {name}{custom}{category}"));
        }
    }

    fn goal(&self, args: &[&str]) {
        if args.first().copied() == Some("add") {
            let amount = js_number(args.get(1).copied().map(Value::from).as_ref());
            let goal = {
                let mut config = self.diagnostics.config();
                config::add_to_goal(&mut config, &json!(amount))
            };
            self.broadcast(event_types::GOAL_UPDATE, goal.clone());
            self.log(
                "success",
                &self.t(
                    "cli.goal.added",
                    &[
                        (
                            "current",
                            crate::state::js_string(goal.get("current").unwrap_or(&Value::Null)),
                        ),
                        (
                            "target",
                            crate::state::js_string(goal.get("target").unwrap_or(&Value::Null)),
                        ),
                        ("amount", integer_text(amount)),
                    ],
                ),
            );
            return;
        }
        let current = args
            .first()
            .map(|value| js_number(Some(&Value::from(*value))));
        let target = args
            .get(1)
            .map(|value| js_number(Some(&Value::from(*value))));
        let (Some(current), Some(target)) = (current, target) else {
            self.log("error", &self.t("cli.goal.usage", &[]));
            return;
        };
        if !current.is_finite() || !target.is_finite() {
            self.log("error", &self.t("cli.goal.usage", &[]));
            return;
        }
        let goal = {
            let mut config = self.diagnostics.config();
            config::set_goal(
                &mut config,
                &json!({ "current": current, "target": target }),
            )
        };
        self.broadcast(event_types::GOAL_UPDATE, goal.clone());
        self.log(
            "success",
            &self.t(
                "cli.goal.updated",
                &[
                    (
                        "current",
                        crate::state::js_string(goal.get("current").unwrap_or(&Value::Null)),
                    ),
                    (
                        "target",
                        crate::state::js_string(goal.get("target").unwrap_or(&Value::Null)),
                    ),
                ],
            ),
        );
    }

    fn obs(&self, arg: Option<&str>) {
        let commands = {
            let config = self.diagnostics.config();
            config
                .get("obs")
                .and_then(|obs| obs.get("customCommands"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        let Some(arg) = arg.filter(|arg| !arg.is_empty()) else {
            self.list_obs_commands(&commands);
            return;
        };
        if arg == "list" {
            self.list_obs_commands(&commands);
            return;
        }
        let Some(command) = commands
            .iter()
            .find(|command| command.get("id").and_then(Value::as_str) == Some(arg))
        else {
            self.log(
                "error",
                &self.t("cli.obs.notFound", &[("id", arg.to_string())]),
            );
            return;
        };
        let request_type = command
            .get("requestType")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if request_type.is_empty() {
            self.log(
                "error",
                &self.t("cli.obs.emptyRequestType", &[("id", arg.to_string())]),
            );
            return;
        }
        let obs = self.diagnostics.obs();
        if !obs.is_connected() {
            self.log("error", &self.t("cli.obs.offline", &[]));
            return;
        }
        let request_type = request_type.to_string();
        let request_data = command
            .get("requestData")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let success = self.t("cli.obs.done", &[("id", arg.to_string())]);
        let failed = self.t("cli.obs.failed", &[("error", ERR.to_string())]);
        let logger = self.logger.clone();
        std::mem::drop(tauri::async_runtime::spawn(async move {
            match obs.request(&request_type, &request_data).await {
                Ok(_) => log(&logger, "success", &success),
                Err(error) => log(&logger, "error", &failed.replace(ERR, &error)),
            }
        }));
    }

    fn list_obs_commands(&self, commands: &[Value]) {
        if commands.is_empty() {
            self.log("info", &self.t("cli.obs.none", &[]));
            return;
        }
        self.log("info", &self.t("cli.obs.title", &[]));
        for command in commands {
            let id = crate::state::js_string(command.get("id").unwrap_or(&Value::Null));
            let label = command
                .get("label")
                .and_then(Value::as_str)
                .filter(|label| !label.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    command
                        .get("requestType")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "?".to_string());
            self.log("info", &format!("  {id} — {label}"));
        }
    }

    fn list_sounds(&self) {
        let sounds = {
            let config = self.diagnostics.config();
            config
                .get("soundboard")
                .and_then(|sb| sb.get("sounds"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        if sounds.is_empty() {
            self.log("info", &self.t("cli.sounds.none", &[]));
            return;
        }
        self.log("info", &self.t("cli.sounds.title", &[]));
        for sound in sounds {
            let id = crate::state::js_string(sound.get("id").unwrap_or(&Value::Null));
            let title = sound
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.is_empty())
                .map(str::to_string)
                .or_else(|| {
                    sound
                        .get("rewardTitle")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "?".to_string());
            self.log("info", &format!("  {id} — {title}"));
        }
    }

    fn list_cameras(&self) {
        let angles = {
            let config = self.diagnostics.config();
            config
                .get("obs")
                .and_then(|obs| obs.get("cameraAngles"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        if angles.is_empty() {
            self.log("info", &self.t("cli.cameras.none", &[]));
            return;
        }
        self.log("info", &self.t("cli.cameras.title", &[]));
        for angle in angles {
            let id = crate::state::js_string(angle.get("id").unwrap_or(&Value::Null));
            let label = option_text(angle.get("label"));
            let scene = option_text(angle.get("sceneName"));
            let source = option_text(angle.get("cameraSource"));
            self.log("info", &format!("  {id} — {label} ({scene}/{source})"));
        }
    }

    fn list_filters(&self) {
        let filters = {
            let config = self.diagnostics.config();
            config
                .get("obs")
                .and_then(|obs| obs.get("cameraFilters"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        if filters.is_empty() {
            self.log("info", &self.t("cli.filters.none", &[]));
            return;
        }
        self.log("info", &self.t("cli.filters.title", &[]));
        for filter in filters {
            let id = crate::state::js_string(filter.get("id").unwrap_or(&Value::Null));
            let label = option_text(filter.get("label"));
            let source = option_text(filter.get("sourceName"));
            let name = option_text(filter.get("filterName"));
            let duration = integer_text(js_number(filter.get("durationSec")).max(0.0));
            self.log(
                "info",
                &format!("  {id} — {label} ({source}/{name}, {duration}с)"),
            );
        }
    }

    fn lang(&self, code: Option<&str>) {
        let lang = if code == Some("ru") { "ru" } else { "en" };
        let saved = self.diagnostics.save_language(lang);
        if let Some(locales) = self.locales {
            self.broadcast(event_types::LOCALES, locales.payload(saved));
        }
        self.log(
            "success",
            &self.t("cli.lang.done", &[("lang", saved.to_string())]),
        );
    }

    fn logs(&self, arg: Option<&str>) {
        let levels = ["info", "success", "warn", "error", "hint"];
        let Some(arg) = arg.filter(|arg| !arg.is_empty()) else {
            self.log("info", &self.t("cli.logs.usage", &[]));
            return;
        };
        let level = arg.to_lowercase();
        if level == "all" {
            self.broadcast(event_types::TERMINAL_FILTER, json!({ "level": "all" }));
            self.log("success", &self.t("cli.logs.all", &[]));
        } else if levels.contains(&level.as_str()) {
            self.broadcast(event_types::TERMINAL_FILTER, json!({ "level": level }));
            self.log("success", &self.t("cli.logs.set", &[("level", level)]));
        } else {
            self.log(
                "error",
                &self.t("cli.logs.unknown", &[("levels", levels.join(", "))]),
            );
        }
    }

    fn status(&self) {
        let snapshot = self.diagnostics.state_snapshot();
        let (scene, cam, obs_status) = {
            let runtime = self.diagnostics.runtime();
            let conn = runtime.connection_status();
            (
                runtime.active_scene(),
                crate::state::js_string(&runtime.active_camera_angle()),
                conn.get("obs")
                    .and_then(Value::as_str)
                    .unwrap_or("not_configured")
                    .to_string(),
            )
        };
        let theme = snapshot
            .get("appearance")
            .and_then(|appearance| appearance.get("activeThemeId"))
            .map(crate::state::js_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "—".to_string());
        let death = snapshot
            .get("deathCount")
            .map(crate::state::js_string)
            .unwrap_or_else(|| "0".to_string());
        let goal = match snapshot.get("goal") {
            Some(goal) if js_truthy(Some(goal)) => format!(
                "{} / {}",
                crate::state::js_string(goal.get("current").unwrap_or(&Value::Null)),
                crate::state::js_string(goal.get("target").unwrap_or(&Value::Null))
            ),
            _ => "—".to_string(),
        };
        let channel = {
            let config = self.diagnostics.config();
            config
                .get("twitch")
                .and_then(|twitch| twitch.get("channel"))
                .and_then(Value::as_str)
                .filter(|channel| !channel.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| "—".to_string())
        };
        let uptime = format_uptime((now_ms() - self.diagnostics.runtime().started_at()) as f64);

        self.log("info", &self.t("cli.status.obs", &[("status", obs_status)]));
        self.log("info", &self.t("cli.status.scene", &[("scene", scene)]));
        self.log("info", &self.t("cli.status.camera", &[("cam", cam)]));
        self.log("info", &self.t("cli.status.theme", &[("theme", theme)]));
        self.log(
            "info",
            &self.t("cli.status.channel", &[("channel", channel)]),
        );
        self.log("info", &self.t("cli.status.death", &[("death", death)]));
        self.log("info", &self.t("cli.status.goal", &[("goal", goal)]));
        self.log("info", &self.t("cli.status.uptime", &[("uptime", uptime)]));
    }

    fn media(&self, sub: Option<&str>) {
        let dir = self.diagnostics.storage().media_dir();
        if sub == Some("cleanup") {
            let (config_value, layout) = {
                let config = self.diagnostics.config();
                (
                    Value::Object(config.value().clone()),
                    self.diagnostics.database().widgets(),
                )
            };
            let result = media::cleanup_orphaned_media(&dir, &config_value, Some(&layout));
            let removed = js_number(result.get("removed"));
            if removed > 0.0 {
                self.log(
                    "success",
                    &self.t("cli.media.cleaned", &[("count", integer_text(removed))]),
                );
                if let Some(names) = result.get("removedNames").and_then(Value::as_array) {
                    for name in names {
                        self.log("info", &format!("  - {}", crate::state::js_string(name)));
                    }
                }
            } else {
                self.log("info", &self.t("cli.media.none", &[]));
            }
            return;
        }

        let files = media::list_media_files(&dir);
        if files.is_empty() {
            self.log("info", &self.t("cli.media.empty", &[]));
            return;
        }
        self.log("info", &self.t("cli.media.title", &[]));
        for file in files {
            self.log("info", &format!("  {}", file.name));
        }
    }
}

/// Запись в терминал — вынесено, чтобы звать её из фоновых задач по клону `Logger`.
fn log(logger: &Logger, level: &str, message: &str) {
    match level {
        "success" => logger.success(message, None),
        "warn" => logger.warn(message, None),
        "error" => logger.error(message, None),
        _ => logger.info(message, None),
    }
}

/// Найти звук саундборда по id (`exact`) или по совпадению заголовка/id награды.
fn sound_in_config(
    config: &serde_json::Map<String, Value>,
    needle: &str,
    exact: bool,
) -> Option<Value> {
    let sounds = config
        .get("soundboard")
        .and_then(|sb| sb.get("sounds"))
        .and_then(Value::as_array)?;
    sounds
        .iter()
        .find(|sound| {
            if exact {
                return sound.get("id").and_then(Value::as_str) == Some(needle);
            }
            let reward_title = sound
                .get("rewardTitle")
                .and_then(Value::as_str)
                .unwrap_or("");
            let reward_id = sound.get("rewardId").and_then(Value::as_str).unwrap_or("");
            (!reward_title.is_empty() && reward_title.to_lowercase() == needle.to_lowercase())
                || (!reward_id.is_empty() && reward_id == needle)
        })
        .cloned()
}

/// Заголовок звука: `title || rewardTitle || id`.
fn sound_name(sound: &Value) -> String {
    for key in ["title", "rewardTitle"] {
        if let Some(text) = sound.get(key).and_then(Value::as_str) {
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    crate::state::js_string(sound.get("id").unwrap_or(&Value::Null))
}

/// Кадр `soundboard_play` из найденного звука.
fn soundboard_payload(sound: &Value, user: &str) -> Value {
    json!({
        "soundId": sound.get("id").cloned().unwrap_or(Value::Null),
        "title": sound_name(sound),
        "user": user,
        "audioFile": sound.get("audioFile").cloned().unwrap_or(Value::Null),
        "imageFile": sound.get("imageFile").cloned().unwrap_or(Value::Null),
        "videoFile": sound.get("videoFile").cloned().unwrap_or(Value::Null),
    })
}

/// Необязательное поле строкой; пусто и отсутствие — `?` (как в списках CLI).
fn option_text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or("?")
        .to_string()
}

/// Число без дробной части, если оно целое — как `String(n)` для целых.
fn integer_text(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

/// Как `formatUptime` в JS: часы/минуты/секунды по-русски.
fn format_uptime(ms: f64) -> String {
    let seconds = (ms / 1000.0).floor().max(0.0) as i64;
    let h = seconds / 3600;
    let m = (seconds % 3600) / 60;
    let s = seconds % 60;
    if h > 0 {
        format!("{h}ч {m}м {s}с")
    } else if m > 0 {
        format!("{m}м {s}с")
    } else {
        format!("{s}с")
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
