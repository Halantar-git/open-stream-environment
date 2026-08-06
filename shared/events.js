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
  };

  const CONNECTION_SERVICES = ["twitchChat", "twitchEvents", "donationAlerts"];

  const ALERT_DURATIONS_MS = {
    follow: 5000,
    sub: 6000,
    gift_sub: 6000,
    cheer: 6000,
    donation: 7000,
  };

  const api = { EVENT_TYPES, CONNECTION_SERVICES, ALERT_DURATIONS_MS };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.SharedEvents = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
