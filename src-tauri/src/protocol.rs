//! Словарь протокола: типы событий и служебные числа шины.
//!
//! Порт `shared/events.js`. Строки на проводе — это контракт между бэкендом и
//! страницами в webview (панель, оверлей, пульт, окна-редакторы), и менять их
//! нельзя: фронт остаётся JS и грузит тот же самый файл. Поэтому источник правды
//! — `shared/events.js`, а Rust обязан следовать за ним, а не наоборот.
//!
//! Расхождение ловит тест: он читает `shared/events.js` из репозитория и
//! сравнивает словарь в обе стороны — ни одно событие не должно потеряться или
//! переименоваться (`the_vocabulary_matches_shared_events_js`). Поэтому список
//! ниже можно и нужно править только вместе с JS-файлом.
//!
//! Имена констант совпадают с ключами в JS (`EVENT_TYPES.CMD_ADD_WIDGET` →
//! [`event_types::CMD_ADD_WIDGET`]) — по ним будет сопоставляться команда в
//! `match`, а таблица [`EVENT_TYPES`] остаётся для сверки и для тех мест, где
//! нужен перебор (журнал, отладка).

/// Объявление словаря: из одной записи рождаются и константа, и строка таблицы.
///
/// Так имена констант и значения не могут разъехаться между собой, а сверку с
/// JS-файлом делает тест.
macro_rules! event_types {
    ($($name:ident => $value:literal,)+) => {
        /// Типы событий протокола — те же строки, что в `shared/events.js`.
        pub mod event_types {
            $(
                #[doc = concat!("`", stringify!($name), "`.")]
                pub const $name: &str = $value;
            )+
        }

        /// Весь словарь: имя из `shared/events.js` и строка на проводе.
        pub const EVENT_TYPES: &[(&str, &str)] = &[
            $( (stringify!($name), $value), )+
        ];
    };
}

event_types! {
    // Сервер -> оверлей и панель.
    STATE => "state",
    LAYOUT_UPDATE => "layout_update",
    LAYOUT_PRESETS_UPDATE => "layout_presets_update",
    ALERT => "alert",
    ALERT_QUEUE_UPDATE => "alert_queue_update",
    SESSION_STATS => "session_stats",
    CHAT_MESSAGE => "chat_message",
    CHAT_SENT => "chat_sent",
    RECENT_EVENT => "recent_event",
    GOAL_UPDATE => "goal_update",
    CONNECTION_STATUS => "connection_status",
    THEME_UPDATE => "theme_update",
    THEME_DRAFT_PREVIEW => "theme_draft_preview",
    EDITOR_PREFS_UPDATE => "editor_prefs_update",
    SCENES_UPDATE => "scenes_update",
    TOP_DONATION_UPDATE => "top_donation_update",
    STAT_UPDATE => "stat_update",
    GIVEAWAY_UPDATE => "giveaway_update",
    GIVEAWAY_WHEEL => "giveaway_wheel",
    GIVEAWAY_SPIN => "giveaway_spin",
    GIVEAWAY_PARTICIPANTS => "giveaway_participants",
    POLL_UPDATE => "poll_update",
    POLL_PRESETS_UPDATE => "poll_presets_update",
    OVERLAY_PARTICIPANTS_CONFIG => "overlay_participants_config",
    WHEEL_CONFIG => "wheel_config",
    WHEEL_SPEED_CONFIG => "wheel_speed_config",
    OVERLAY_MIC_CONFIG => "overlay_mic_config",
    LONGSHOT_UPDATE => "longshot_update",
    LOCALES => "locales",
    TERMINAL_LOG => "terminal_log",
    DEBUG_LOG => "debug_log",
    CLEAR_TERMINAL => "clear_terminal",
    REMOTE_ACTION => "remote_action",
    DEATH_COUNT_UPDATE => "death_count_update",
    CAMERA_ANGLE_UPDATE => "camera_angle_update",
    CAMERA_FILTER_UPDATE => "camera_filter_update",
    SOUNDBOARD_PLAY => "soundboard_play",
    VIDEO_SPLASH_PLAY => "video_splash_play",
    MIC_AUDIO_DATA => "mic_audio_data",
    HUD_EDIT_MODE => "hud_edit_mode",
    HUD_HOTKEY_UPDATE => "hud_hotkey_update",
    HUD_DISPLAY_UPDATE => "hud_display_update",
    CHAT_HUD_HOTKEY_UPDATE => "chat_hud_hotkey_update",
    CHAT_HUD_DISPLAY_UPDATE => "chat_hud_display_update",
    CHAT_HUD_CONFIG_UPDATE => "chat_hud_config_update",
    REWARD_TTS => "reward_tts",
    TWITCH_ACTION_RESULT => "twitch_action_result",

    // Панель -> сервер: команды.
    CMD_ADD_WIDGET => "cmd_add_widget",
    CMD_UPDATE_WIDGET => "cmd_update_widget",
    CMD_REMOVE_WIDGET => "cmd_remove_widget",
    CMD_REORDER_WIDGET => "cmd_reorder_widget",
    CMD_SAVE_LAYOUT => "cmd_save_layout",
    CMD_TOGGLE_HUD_EDIT_MODE => "cmd_toggle_hud_edit_mode",
    CMD_SET_HUD_HOTKEY => "cmd_set_hud_hotkey",
    CMD_SET_HUD_DISPLAY => "cmd_set_hud_display",
    CMD_TOGGLE_CHAT_HUD => "cmd_toggle_chat_hud",
    CMD_SET_CHAT_HUD_HOTKEY => "cmd_set_chat_hud_hotkey",
    CMD_SET_CHAT_HUD_DISPLAY => "cmd_set_chat_hud_display",
    CMD_SET_CHAT_HUD_CONFIG => "cmd_set_chat_hud_config",
    CMD_SET_TWITCH_REWARDS => "cmd_set_twitch_rewards",
    CMD_TEST_TWITCH_REWARD => "cmd_test_twitch_reward",
    CMD_CREATE_CLIP => "cmd_create_clip",
    CMD_CREATE_STREAM_MARKER => "cmd_create_stream_marker",
    CMD_SAVE_LAYOUT_PRESET => "cmd_save_layout_preset",
    CMD_APPLY_LAYOUT_PRESET => "cmd_apply_layout_preset",
    CMD_DELETE_LAYOUT_PRESET => "cmd_delete_layout_preset",
    CMD_SET_GOAL => "cmd_set_goal",
    CMD_TEST_ALERT => "cmd_test_alert",
    CMD_ALERT_QUEUE_PAUSE => "cmd_alert_queue_pause",
    CMD_ALERT_QUEUE_RESUME => "cmd_alert_queue_resume",
    CMD_ALERT_QUEUE_SKIP => "cmd_alert_queue_skip",
    CMD_ALERT_QUEUE_REMOVE => "cmd_alert_queue_remove",
    CMD_ALERT_QUEUE_UP => "cmd_alert_queue_up",
    CMD_ALERT_QUEUE_PLAY_NOW => "cmd_alert_queue_play_now",
    CMD_ALERT_QUEUE_CLEAR => "cmd_alert_queue_clear",
    CMD_ALERT_QUEUE_CONFIG => "cmd_alert_queue_config",
    CMD_RECOVER_DONATIONS => "cmd_recover_donations",
    CMD_RESET_SESSION_STATS => "cmd_reset_session_stats",
    CMD_TEST_CHAT => "cmd_test_chat",
    CMD_SEND_CHAT => "cmd_send_chat",
    CMD_TEST_POLL => "cmd_test_poll",
    CMD_SET_APP_CONFIG => "cmd_set_app_config",
    CMD_SET_ACTIVE_THEME => "cmd_set_active_theme",
    CMD_SET_ENABLED_3D => "cmd_set_enabled_3d",
    CMD_SAVE_CUSTOM_THEME => "cmd_save_custom_theme",
    CMD_DELETE_CUSTOM_THEME => "cmd_delete_custom_theme",
    CMD_DUPLICATE_CUSTOM_THEME => "cmd_duplicate_custom_theme",
    CMD_IMPORT_CUSTOM_THEME => "cmd_import_custom_theme",
    CMD_PREVIEW_THEME_DRAFT => "cmd_preview_theme_draft",
    CMD_SET_EDITOR_PREFS => "cmd_set_editor_prefs",
    CMD_SET_SCENE_CONFIG => "cmd_set_scene_config",
    CMD_SET_SPLASH_CONFIG => "cmd_set_splash_config",
    VIDEO_SPLASH_ENDED => "video_splash_ended",
    VIDEO_SPLASH_READY => "video_splash_ready",
    CMD_RESET_TOP_DONATION => "cmd_reset_top_donation",
    CMD_START_GIVEAWAY => "cmd_start_giveaway",
    CMD_STOP_GIVEAWAY => "cmd_stop_giveaway",
    CMD_SHUFFLE_GIVEAWAY => "cmd_shuffle_giveaway",
    CMD_SET_GIVEAWAY_ELIMINATION => "cmd_set_giveaway_elimination",
    CMD_GENERATE_WHEEL => "cmd_generate_wheel",
    CMD_SPIN_WHEEL => "cmd_spin_wheel",
    CMD_SET_GIVEAWAY_WINNER => "cmd_set_giveaway_winner",
    CMD_ADD_GIVEAWAY_PARTICIPANT => "cmd_add_giveaway_participant",
    CMD_REMOVE_GIVEAWAY_PARTICIPANT => "cmd_remove_giveaway_participant",
    CMD_CLEAR_GIVEAWAY_PARTICIPANTS => "cmd_clear_giveaway_participants",
    CMD_SET_PARTICIPANTS_CONFIG => "cmd_set_participants_config",
    CMD_SET_WHEEL_CONFIG => "cmd_set_wheel_config",
    CMD_SET_WHEEL_SPEED_CONFIG => "cmd_set_wheel_speed_config",
    CMD_START_POLL => "cmd_start_poll",
    CMD_STOP_POLL => "cmd_stop_poll",
    CMD_RESET_POLL => "cmd_reset_poll",
    CMD_SET_POLL_CONFIG => "cmd_set_poll_config",
    CMD_ADD_POLL_OPTION => "cmd_add_poll_option",
    CMD_REMOVE_POLL_OPTION => "cmd_remove_poll_option",
    CMD_CLEAR_POLL_OPTIONS => "cmd_clear_poll_options",
    CMD_SAVE_POLL_PRESET => "cmd_save_poll_preset",
    CMD_APPLY_POLL_PRESET => "cmd_apply_poll_preset",
    CMD_DELETE_POLL_PRESET => "cmd_delete_poll_preset",
    CMD_SET_MIC_CONFIG => "cmd_set_mic_config",
    CMD_REFRESH_LONGSHOT => "cmd_refresh_longshot",
    CMD_SET_LANGUAGE => "cmd_set_language",
    CMD_SET_YOUTUBE_VIDEO_ID => "cmd_set_youtube_video_id",
    CMD_SET_INTEGRATION_ENABLED => "cmd_set_integration_enabled",
    CMD_RESTART_INTEGRATION => "cmd_restart_integration",
    CMD_SET_NOTIFICATION_SOUND => "cmd_set_notification_sound",
    CMD_SET_NOTIFICATION_VOLUME => "cmd_set_notification_volume",
    CMD_SET_NOTIFICATION_REPEATS => "cmd_set_notification_repeats",
    CMD_SET_OBS_CONFIG => "cmd_set_obs_config",
    CMD_SET_SOUNDBOARD_CONFIG => "cmd_set_soundboard_config",
    CMD_SET_CHAT_BOT_CONFIG => "cmd_set_chat_bot_config",
    CMD_SET_TTS_CONFIG => "cmd_set_tts_config",
    CMD_SET_DONATION_VOICE => "cmd_set_donation_voice",
    CMD_TEST_SOUNDBOARD => "cmd_test_soundboard",
    CMD_SET_STREAMDECK_CONFIG => "cmd_set_streamdeck_config",
    CMD_RUN_OBS_COMMAND => "cmd_run_obs_command",
    CMD_SET_CAMERA_ANGLE => "cmd_set_camera_angle",
    CMD_TRIGGER_CAMERA_FILTER => "cmd_trigger_camera_filter",
    EXEC_CLI_COMMAND => "exec_cli_command",
    EXEC_CLI_COMPLETION => "exec_cli_completion",
    CLI_COMPLETIONS => "cli_completions",
    TERMINAL_FILTER => "terminal_filter",
}

/// Службы, состояние которых показывают чипы связи: `CONNECTION_SERVICES`.
pub const CONNECTION_SERVICES: [&str; 5] = [
    "twitchChat",
    "twitchEvents",
    "donationAlerts",
    "youtube",
    "obs",
];

/// Сколько миллисекунд показывать алерт каждого вида: `ALERT_DURATIONS_MS`.
///
/// Таблицей, а не структурой: виды приходят строками из чата и наград, и
/// значение ищется по имени.
pub const ALERT_DURATIONS_MS: [(&str, i64); 10] = [
    ("follow", 5000),
    ("sub", 6000),
    ("gift_sub", 6000),
    ("cheer", 6000),
    ("donation", 7000),
    ("boosty_sub", 6000),
    ("boosty_resub", 6000),
    ("wheel_start", 6000),
    ("wheel_winner", 8000),
    ("reward", 6000),
];

/// Сколько показывать алерт этого вида; `None` — вид неизвестен.
pub fn alert_duration_ms(kind: &str) -> Option<i64> {
    ALERT_DURATIONS_MS
        .iter()
        .find(|(name, _)| *name == kind)
        .map(|(_, ms)| *ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, HashMap};

    /// Словарь событий живёт в JS-файле: фронт остаётся JS, и Rust обязан
    /// следовать за ним. Тест читает файл из настоящего репозитория — так же,
    /// как тесты сервера читают настоящие страницы.
    fn shared_events_js() -> String {
        let path = crate::repository_root().join("shared").join("events.js");
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    }

    /// Записи блока JS-объекта: строки вида `ИМЯ: значение,`.
    ///
    /// Значение берётся до первой запятой — так отбрасывается хвостовой
    /// комментарий, а сами значения (слова-идентификаторы и числа) запятых не
    /// содержат.
    fn parse_block(source: &str, header: &str) -> BTreeMap<String, String> {
        let mut entries = BTreeMap::new();
        let mut inside = false;
        for line in source.lines() {
            let trimmed = line.trim();
            if !inside {
                inside = trimmed.starts_with(header);
                continue;
            }
            if trimmed == "};" {
                break;
            }
            if trimmed.is_empty() || trimmed.starts_with("//") {
                continue;
            }
            let Some((name, rest)) = trimmed.split_once(':') else {
                continue;
            };
            let value = rest.split(',').next().unwrap_or_default().trim();
            entries.insert(name.trim().to_string(), value.to_string());
        }
        entries
    }

    #[test]
    fn the_vocabulary_matches_shared_events_js() {
        let js = parse_block(&shared_events_js(), "const EVENT_TYPES = {");
        assert!(!js.is_empty(), "словарь в shared/events.js не разобрался");

        let mut ours: HashMap<&str, &str> = HashMap::new();
        for (name, value) in EVENT_TYPES {
            assert!(
                ours.insert(name, value).is_none(),
                "событие {name} объявлено дважды"
            );
        }

        let mut differences = Vec::new();
        for (name, value) in &js {
            match ours.get(name.as_str()) {
                // В JS значение — строка в кавычках; сверяем в том же виде.
                Some(our) if format!("{our:?}") == *value => {}
                Some(our) => differences.push(format!("{name}: в JS {value}, в Rust {our:?}")),
                None => differences.push(format!("{name}: есть в JS, нет в Rust")),
            }
        }
        for name in ours.keys() {
            if !js.contains_key(*name) {
                differences.push(format!("{name}: есть в Rust, нет в JS"));
            }
        }

        assert!(
            differences.is_empty(),
            "словарь событий разошёлся с shared/events.js:\n{}",
            differences.join("\n")
        );
    }

    #[test]
    fn alert_durations_match_shared_events_js() {
        let js = parse_block(&shared_events_js(), "const ALERT_DURATIONS_MS = {");
        assert!(!js.is_empty(), "длительности алертов не разобрались");

        let mut ours: HashMap<&str, i64> = HashMap::new();
        for (kind, ms) in ALERT_DURATIONS_MS {
            ours.insert(kind, ms);
        }

        let mut differences = Vec::new();
        for (kind, value) in &js {
            match ours.get(kind.as_str()) {
                Some(our) if our.to_string() == *value => {}
                Some(our) => differences.push(format!("{kind}: в JS {value}, в Rust {our}")),
                None => differences.push(format!("{kind}: есть в JS, нет в Rust")),
            }
        }
        assert!(
            differences.is_empty(),
            "длительности алертов разошлись с shared/events.js:\n{}",
            differences.join("\n")
        );

        assert_eq!(alert_duration_ms("donation"), Some(7000));
        assert_eq!(alert_duration_ms("wheel_winner"), Some(8000));
        assert_eq!(alert_duration_ms("unknown"), None);
    }

    #[test]
    fn connection_services_match_shared_events_js() {
        let source = shared_events_js();
        let line = source
            .lines()
            .find(|line| {
                line.trim_start()
                    .starts_with("const CONNECTION_SERVICES = ")
            })
            .expect("CONNECTION_SERVICES должен быть в shared/events.js");
        let js: Vec<&str> = line.split('"').skip(1).step_by(2).collect();

        assert_eq!(js, CONNECTION_SERVICES, "список служб разошёлся");
    }
}
