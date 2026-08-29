/*
 * Copyright (C) 2026  Halantar
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://gnu.org>.
 */

/*
  Shared vocabulary between server/index.js (Node), control/control.js and
  overlay/overlay.js (browser). Loaded as a plain <script> in the browser
  pages and via require() on the server.
*/
(function (root) {
  const EVENT_TYPES = {
    // Broadcast from server -> overlay + control
    STATE: "state", // full state snapshot, sent on connect
    LAYOUT_UPDATE: "layout_update", // full layout array, sent after any add/update/remove/reorder
    LAYOUT_PRESETS_UPDATE: "layout_presets_update", // { presets: [{ id, name, widgetCount, createdAt, updatedAt }] }
    ALERT: "alert", // { kind: 'follow'|'sub'|'gift_sub'|'cheer'|'donation', ... }
    CHAT_MESSAGE: "chat_message",
    RECENT_EVENT: "recent_event",
    GOAL_UPDATE: "goal_update", // { current, target, title, currency }
    CONNECTION_STATUS: "connection_status", // { service, status }
    THEME_UPDATE: "theme_update", // { activeThemeId, activeThemeId2d, activeThemeId3d, tokens, themes }
    EDITOR_PREFS_UPDATE: "editor_prefs_update", // { gridSize, snapEnabled }
    SCENES_UPDATE: "scenes_update", // { start, brb, end }
    TOP_DONATION_UPDATE: "top_donation_update", // { user, amount, currency }
    STAT_UPDATE: "stat_update", // { followerCount, subscriberCount }
    GIVEAWAY_UPDATE: "giveaway_update", // { giveaway }
    GIVEAWAY_WHEEL: "giveaway_wheel", // { sectors }
    GIVEAWAY_SPIN: "giveaway_spin", // {}
    GIVEAWAY_PARTICIPANTS: "giveaway_participants", // { count, participants }
    OVERLAY_PARTICIPANTS_CONFIG: "overlay_participants_config", // { config }
    WHEEL_CONFIG: "wheel_config", // { config }
    WHEEL_SPEED_CONFIG: "wheel_speed_config", // { config }
    OVERLAY_MIC_CONFIG: "overlay_mic_config", // { config }
    LOCALES: "locales", // { lang, locales: { ru, en } }
    TERMINAL_LOG: "terminal_log", // { timestamp, service, level, message, data }
    DEBUG_LOG: "debug_log", // { timestamp, service, level: "debug", message, data }
    CLEAR_TERMINAL: "clear_terminal", // server -> client: clear the log panel
    REMOTE_ACTION: "remote_action", // { action, payload } — remote quick action (command + broadcast)
    DEATH_COUNT_UPDATE: "death_count_update", // { count }
    CAMERA_ANGLE_UPDATE: "camera_angle_update", // { activeCameraAngle }
    CAMERA_FILTER_UPDATE: "camera_filter_update", // { filterId, active }
    SOUNDBOARD_PLAY: "soundboard_play", // { soundId, title, user, audioFile, imageFile }
    MIC_AUDIO_DATA: "mic_audio_data", // { level, wave, freq } — mic bridge (control -> server -> overlay)
    HUD_EDIT_MODE: "hud_edit_mode", // { enabled } — game HUD overlay entered/left direct-edit mode
    HUD_HOTKEY_UPDATE: "hud_hotkey_update", // { hotkey } — current HUD toggle hotkey (after save)
    HUD_DISPLAY_UPDATE: "hud_display_update", // { displayId } — selected monitor for the HUD overlay

    // control -> server commands
    CMD_ADD_WIDGET: "cmd_add_widget", // { type }
    CMD_UPDATE_WIDGET: "cmd_update_widget", // { id, patch: { x?,y?,w?,h?,visible?,z?,config? } }
    CMD_REMOVE_WIDGET: "cmd_remove_widget", // { id }
    CMD_REORDER_WIDGET: "cmd_reorder_widget", // { id, direction: 'forward'|'backward' }
    CMD_SAVE_LAYOUT: "cmd_save_layout", // { layout } — persist overlay layout from HUD edit mode
    CMD_TOGGLE_HUD_EDIT_MODE: "cmd_toggle_hud_edit_mode", // {} — control panel requests HUD edit-mode toggle
    CMD_SET_HUD_HOTKEY: "cmd_set_hud_hotkey", // { hotkey } — change the global HUD toggle hotkey
    CMD_SET_HUD_DISPLAY: "cmd_set_hud_display", // { displayId } — change the monitor for the HUD overlay
    CMD_SAVE_LAYOUT_PRESET: "cmd_save_layout_preset", // { id?, name }
    CMD_APPLY_LAYOUT_PRESET: "cmd_apply_layout_preset", // { id }
    CMD_DELETE_LAYOUT_PRESET: "cmd_delete_layout_preset", // { id }
    CMD_SET_GOAL: "cmd_set_goal", // { title?, current?, target?, currency? }
    CMD_TEST_ALERT: "cmd_test_alert", // { kind }
    CMD_TEST_CHAT: "cmd_test_chat", // { message? }
    CMD_SET_APP_CONFIG: "cmd_set_app_config", // { twitchChannel? }
    CMD_SET_ACTIVE_THEME: "cmd_set_active_theme", // { id }
    CMD_SAVE_CUSTOM_THEME: "cmd_save_custom_theme", // { id?, name, seeds }
    CMD_DELETE_CUSTOM_THEME: "cmd_delete_custom_theme", // { id }
    CMD_SET_EDITOR_PREFS: "cmd_set_editor_prefs", // { gridSize?, snapEnabled? }
    CMD_SET_SCENE_CONFIG: "cmd_set_scene_config", // { sceneId, patch }
    CMD_RESET_TOP_DONATION: "cmd_reset_top_donation",
    CMD_START_GIVEAWAY: "cmd_start_giveaway", // { command }
    CMD_STOP_GIVEAWAY: "cmd_stop_giveaway",
    CMD_SHUFFLE_GIVEAWAY: "cmd_shuffle_giveaway",
    CMD_SET_GIVEAWAY_ELIMINATION: "cmd_set_giveaway_elimination", // { enabled }
    CMD_GENERATE_WHEEL: "cmd_generate_wheel",
    CMD_SPIN_WHEEL: "cmd_spin_wheel",
    CMD_SET_GIVEAWAY_WINNER: "cmd_set_giveaway_winner", // { username }
    CMD_ADD_GIVEAWAY_PARTICIPANT: "cmd_add_giveaway_participant", // { username }
    CMD_REMOVE_GIVEAWAY_PARTICIPANT: "cmd_remove_giveaway_participant", // { username }
    CMD_CLEAR_GIVEAWAY_PARTICIPANTS: "cmd_clear_giveaway_participants",
    CMD_SET_PARTICIPANTS_CONFIG: "cmd_set_participants_config", // { config }
    CMD_SET_WHEEL_CONFIG: "cmd_set_wheel_config", // { config }
    CMD_SET_WHEEL_SPEED_CONFIG: "cmd_set_wheel_speed_config", // { config }
    CMD_SET_MIC_CONFIG: "cmd_set_mic_config", // { config }
    CMD_SET_LANGUAGE: "cmd_set_language", // { lang }
    CMD_SET_YOUTUBE_VIDEO_ID: "cmd_set_youtube_video_id", // { videoId }
    CMD_SET_INTEGRATION_ENABLED: "cmd_set_integration_enabled", // { service, enabled }
    CMD_SET_OBS_CONFIG: "cmd_set_obs_config", // { host?, port?, password?, sceneMap? }
    CMD_SET_SOUNDBOARD_CONFIG: "cmd_set_soundboard_config", // { config }
    CMD_SET_TTS_CONFIG: "cmd_set_tts_config", // { config: { enabled?, volume?, rate?, lang? } }
    CMD_SET_DONATION_VOICE: "cmd_set_donation_voice", // { config: { donationAlerts?, volume? } }
    CMD_TEST_SOUNDBOARD: "cmd_test_soundboard", // { soundId }
    CMD_SET_STREAMDECK_CONFIG: "cmd_set_streamdeck_config", // { config }
    CMD_RUN_OBS_COMMAND: "cmd_run_obs_command", // { id }
    CMD_SET_CAMERA_ANGLE: "cmd_set_camera_angle", // { angleId }
    CMD_TRIGGER_CAMERA_FILTER: "cmd_trigger_camera_filter", // { filterId }
    EXEC_CLI_COMMAND: "exec_cli_command", // { command } — control panel CLI console
    EXEC_CLI_COMPLETION: "exec_cli_completion", // { input } — request CLI Tab completions
    CLI_COMPLETIONS: "cli_completions", // { input, completions } — server -> requesting client
    TERMINAL_FILTER: "terminal_filter", // { level } — server -> client: filter log levels
  };

  const CONNECTION_SERVICES = ["twitchChat", "twitchEvents", "donationAlerts", "youtube", "obs"];

  const ALERT_DURATIONS_MS = {
    follow: 5000,
    sub: 6000,
    gift_sub: 6000,
    cheer: 6000,
    donation: 7000,
    boosty_sub: 6000,
    boosty_resub: 6000,
    wheel_start: 6000,
    wheel_winner: 8000,
  };

  const api = { EVENT_TYPES, CONNECTION_SERVICES, ALERT_DURATIONS_MS };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.SharedEvents = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
