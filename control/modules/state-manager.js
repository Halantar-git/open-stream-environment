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
  Overlay + config state for the control panel.

  Single responsibility: own the mutable state that mirrors the server's
  `state` snapshot, and map a snapshot payload into it. It is intentionally
  a plain object — the render functions read from `state.*` and the message
  router writes through `state.applySnapshot()` / direct assignments.
*/

export function createStateManager() {
  const state = {
    layout: [],
    layoutPresets: [],
    goal: { title: "Цель", current: 0, target: 1, currency: "RUB" },
    twitchChannel: "",
    twitchClientId: "",
    daClientId: "",
    youtubeClientId: "",
    youtubeVideoId: "",
    twitchEnabled: true,
    donationAlertsEnabled: true,
    youtubeEnabled: true,
    obs: { enabled: false, host: "127.0.0.1", port: 4455, password: "", sceneMap: { main: "", start: "", brb: "", end: "", wheel: "" } },
    soundboard: { enabled: true, volume: 0.8, queueMode: false, sounds: [] },
    streamdeck: { icons: { start: "", brb: "", wheel: "", talk: "", end: "" } },
    selectedId: null,
    pendingAdd: null,
    appearance: { activeThemeId: "nebula", activeThemeId2d: "nebula", activeThemeId3d: "", tokens: {}, themes: [] },
    editorPrefs: { gridSize: 5, snapEnabled: true },
    editingThemeId: null,
    scenes: {},
    topDonation: { user: "", amount: 0, currency: "RUB" },
    stats: { followerCount: null, subscriberCount: null },
    deathCount: 0,
    activeCameraAngle: null,
    activeFilters: [],
    activeSceneId: "start",
    giveaway: { active: false, command: "!go", eliminationMode: false, winner: null, count: 0, participants: [] },
    participantsConfig: { maxNames: 10, marquee: false, fontSize: 16, textColor: "#e8e1f0", backgroundOpacity: 82 },
    wheelConfig: { musicVolume: 50 },
    wheelSpeedConfig: { speed: 3 },
    micConfig: { sensitivity: 1.5, lineWidth: 2, color: "", opacity: 0.9, visualizer_mode: "sine", barCount: 32, barGap: 2, peakFall: 2.5 },
  };

  // Maps the server's `state` snapshot payload into this object.
  state.applySnapshot = (payload) => {
    state.layout = payload.layout || [];
    state.layoutPresets = payload.layoutPresets || [];
    state.goal = payload.goal;
    state.twitchChannel = payload.twitchChannel;
    state.twitchClientId = payload.twitchClientId;
    state.daClientId = payload.donationAlertsClientId;
    state.youtubeClientId = payload.youtubeClientId;
    state.youtubeVideoId = payload.youtubeVideoId;
    state.twitchEnabled = payload.twitchEnabled !== false;
    state.donationAlertsEnabled = payload.donationAlertsEnabled !== false;
    state.youtubeEnabled = payload.youtubeEnabled !== false;
    state.obs = payload.obs || state.obs;
    state.soundboard = payload.soundboard || state.soundboard;
    state.streamdeck = payload.streamdeck || state.streamdeck;
    state.appearance = payload.appearance || state.appearance;
    state.editorPrefs = payload.editor || state.editorPrefs;
    state.scenes = payload.scenes || state.scenes;
    state.topDonation = payload.topDonation || state.topDonation;
    state.stats = payload.stats || state.stats;
    state.deathCount = payload.deathCount ?? state.deathCount;
    state.activeCameraAngle = payload.activeCameraAngle ?? state.activeCameraAngle;
    state.activeFilters = payload.activeFilters || state.activeFilters;
    state.giveaway = payload.giveaway || state.giveaway;
  };

  return state;
}
