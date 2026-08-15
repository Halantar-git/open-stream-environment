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
    ALERT: "alert", // { kind: 'follow'|'sub'|'gift_sub'|'cheer'|'donation', ... }
    CHAT_MESSAGE: "chat_message",
    RECENT_EVENT: "recent_event",
    GOAL_UPDATE: "goal_update", // { current, target, title, currency }
    CONNECTION_STATUS: "connection_status", // { service, status }
    THEME_UPDATE: "theme_update", // { activeThemeId, tokens, themes }
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

    // control -> server commands
    CMD_ADD_WIDGET: "cmd_add_widget", // { type }
    CMD_UPDATE_WIDGET: "cmd_update_widget", // { id, patch: { x?,y?,w?,h?,visible?,z?,config? } }
    CMD_REMOVE_WIDGET: "cmd_remove_widget", // { id }
    CMD_REORDER_WIDGET: "cmd_reorder_widget", // { id, direction: 'forward'|'backward' }
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
    CMD_SET_PARTICIPANTS_CONFIG: "cmd_set_participants_config", // { config }
    CMD_SET_WHEEL_CONFIG: "cmd_set_wheel_config", // { config }
    CMD_SET_WHEEL_SPEED_CONFIG: "cmd_set_wheel_speed_config", // { config }
    CMD_SET_MIC_CONFIG: "cmd_set_mic_config", // { config }
    CMD_SET_LANGUAGE: "cmd_set_language", // { lang }
    CMD_SET_YOUTUBE_VIDEO_ID: "cmd_set_youtube_video_id", // { videoId }
    CMD_SET_INTEGRATION_ENABLED: "cmd_set_integration_enabled", // { service, enabled }
  };

  const CONNECTION_SERVICES = ["twitchChat", "twitchEvents", "donationAlerts", "youtube"];

  const ALERT_DURATIONS_MS = {
    follow: 5000,
    sub: 6000,
    gift_sub: 6000,
    cheer: 6000,
    donation: 7000,
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
