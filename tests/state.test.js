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

const fs = require("fs");
const os = require("os");
const path = require("path");

const { configureStorage } = require("../server/storage-paths");
const { AppState } = require("../server/state");
const { BUILTIN_THEMES } = require("../shared/themes");

function makeConfig() {
  return {
    twitch: {
      channel: "",
      clientId: "",
      clientSecret: "",
      userAccessToken: "",
      refreshToken: "",
      broadcasterId: "",
    },
    donationAlerts: { clientId: "", clientSecret: "", accessToken: "", refreshToken: "", userId: "" },
    youtube: { clientId: "", clientSecret: "", accessToken: "", refreshToken: "", videoId: "" },
    obs: { enabled: false, host: "127.0.0.1", port: 4455, password: "", sceneMap: {}, customCommands: [], cameraAngles: [] },
    soundboard: { enabled: true, volume: 0.8, queueMode: false, sounds: [] },
    streamdeck: { icons: { scene: "", soundboard: "", counter: "", wheel: "" } },
    goal: { title: "", current: 0, target: 1, currency: "RUB" },
    appearance: { activeThemeId2d: "nebula", activeThemeId3d: "", customThemes: [] },
    editor: { gridSize: 5, snapEnabled: true },
    scenes: {},
    topDonation: {},
    layout: [],
  };
}

describe("AppState config + runtime", () => {
  let tmp;
  let state;

  beforeEach(() => {
    // saveConfig пишет в configDir — изолируем от реального config.json.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ose-state-"));
    configureStorage({ configDir: tmp });
    state = new AppState(null, makeConfig());
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("setObsConfig нормализует customCommands", () => {
    state.setObsConfig({
      customCommands: [
        { id: "  a  ", label: "  Mute  ", requestType: " ToggleInputMute ", requestData: "bad" },
        { id: "b", label: "", requestType: "", requestData: { inputName: "Mic/Aux" } },
      ],
    });

    expect(state.config.obs.customCommands).toEqual([
      { id: "a", label: "Mute", requestType: "ToggleInputMute", requestData: {} },
      { id: "b", label: "", requestType: "", requestData: { inputName: "Mic/Aux" } },
    ]);
  });

  test("setObsConfig нормализует cameraAngles", () => {
    state.setObsConfig({
      cameraAngles: [
        { id: " cam_main ", label: " Основная ", twitchRewardTitle: " Камера: Главная ", sceneName: " Main ", cameraSource: " Cam_Main " },
      ],
    });

    expect(state.config.obs.cameraAngles).toEqual([
      { id: "cam_main", label: "Основная", twitchRewardTitle: "Камера: Главная", sceneName: "Main", cameraSource: "Cam_Main" },
    ]);
  });

  test("setSoundboardConfig ограничивает громкость и тримит поля", () => {
    state.setSoundboardConfig({
      volume: 5,
      queueMode: true,
      sounds: [{ id: " s1 ", rewardTitle: " Reward ", audioFile: " media/a.mp3 " }],
    });

    expect(state.config.soundboard.volume).toBe(1);
    expect(state.config.soundboard.queueMode).toBe(true);
    expect(state.config.soundboard.sounds[0]).toEqual({
      id: "s1",
      rewardTitle: "Reward",
      rewardId: "",
      audioFile: "media/a.mp3",
      imageFile: "",
      title: "Reward",
    });
  });

  test("setStreamDeckConfig тримит пути иконок", () => {
    state.setStreamDeckConfig({ icons: { scene: " media/scene.png ", wheel: "" } });

    expect(state.config.streamdeck.icons.scene).toBe("media/scene.png");
    expect(state.config.streamdeck.icons.wheel).toBe("");
  });

  test("setAppConfig ограничивает порт диапазоном 1024-65535", () => {
    state.setAppConfig({ port: 80 });
    expect(state.config.port).toBe(1024);

    state.setAppConfig({ port: 99999 });
    expect(state.config.port).toBe(65535);

    state.setAppConfig({ port: 9000 });
    expect(state.config.port).toBe(9000);
  });

  test("setActiveScene и setActiveCameraAngle обновляют runtime", () => {
    expect(state.setActiveScene("brb")).toBe("brb");
    expect(state.runtime.activeScene).toBe("brb");

    expect(state.setActiveCameraAngle("cam_top")).toBe("cam_top");
    expect(state.runtime.activeCameraAngle).toBe("cam_top");
  });

  test("счётчик смертей не уходит в минус и сбрасывается", () => {
    expect(state.adjustDeathCount(3)).toEqual({ count: 3 });
    expect(state.adjustDeathCount(-5)).toEqual({ count: 0 });
    expect(state.resetDeathCount()).toEqual({ count: 0 });
  });

  test("финальный победитель в режиме выбывания определяется до удаления", () => {
    state.startGiveaway("!go");
    state.addGiveawayParticipant("a");
    state.setGiveawayEliminationMode(true);

    const snap = state.setGiveawayWinner("a");

    expect(snap.winner).toBe("a");
    expect(snap.isFinalWinner).toBe(true);
    expect(snap.count).toBe(0);
    expect(snap.participants).toEqual([]);
  });

  test("выбывание не считает финалом при нескольких участниках", () => {
    state.startGiveaway("!go");
    ["a", "b"].forEach((u) => state.addGiveawayParticipant(u));
    state.setGiveawayEliminationMode(true);

    const snap = state.setGiveawayWinner("b");

    expect(snap.winner).toBe("b");
    expect(snap.isFinalWinner).toBe(false);
    expect(snap.count).toBe(1);
    expect(snap.participants).toEqual(["a"]);
  });

  test("replaceConfig не теряет soundboard/streamdeck и игнорирует невалидный порт", () => {
    state.setAppConfig({ port: 9000 });

    state.replaceConfig({
      port: 70000, // вне диапазона 1024-65535
      soundboard: { enabled: false, volume: 0.5, queueMode: true, sounds: [{ id: "s1", rewardTitle: "R" }] },
      streamdeck: { icons: { wheel: "media/w.png" } },
      obs: { customCommands: "not-an-array" },
    });

    expect(state.config.port).toBe(9000);
    expect(state.config.soundboard.enabled).toBe(false);
    expect(state.config.soundboard.sounds).toEqual([{ id: "s1", rewardTitle: "R" }]);
    expect(state.config.streamdeck.icons.wheel).toBe("media/w.png");
    expect(state.config.streamdeck.icons).toHaveProperty("start"); // существующие иконки сохранены
    expect(state.config.obs.customCommands).toEqual([]); // невалидный массив -> []
  });

  test("2D и 3D темы хранятся в отдельных ячейках", () => {
    state.setActiveTheme("orbital");
    expect(state.config.appearance.activeThemeId2d).toBe("orbital");
    expect(state.config.appearance.activeThemeId3d).toBe("");

    // Пока 3D выключена, глобальные токены берутся из 2D темы.
    let snap = state.snapshot();
    expect(snap.appearance.activeThemeId).toBe("orbital");
    expect(snap.appearance.tokens).toEqual(BUILTIN_THEMES.orbital.tokens);

    state.setActiveTheme("grimhex");
    expect(state.config.appearance.activeThemeId3d).toBe("grimhex");
    expect(state.config.appearance.activeThemeId2d).toBe("orbital");

    // При включённой 3D теме она перекрывает 2D для всего оверлея.
    snap = state.snapshot();
    expect(snap.appearance.activeThemeId2d).toBe("orbital");
    expect(snap.appearance.activeThemeId3d).toBe("grimhex");
    expect(snap.appearance.activeThemeId).toBe("grimhex");
    expect(snap.appearance.tokens).toEqual(BUILTIN_THEMES.grimhex.tokens);
  });

  test("setActiveTheme('') выключает 3D-тему", () => {
    state.setActiveTheme("grimhex");
    expect(state.config.appearance.activeThemeId3d).toBe("grimhex");

    expect(state.setActiveTheme("")).toBe(true);
    expect(state.config.appearance.activeThemeId3d).toBe("");
    expect(state.config.appearance.activeThemeId2d).toBe("nebula");
  });

  test("legacy activeThemeId мигрирует в соответствующий слот", () => {
    const legacy = makeConfig();
    legacy.appearance = { activeThemeId: "grimhex", customThemes: [] };
    const migrated = new AppState(null, legacy);
    expect(migrated.config.appearance.activeThemeId3d).toBe("grimhex");
    expect(migrated.config.appearance.activeThemeId2d).toBe("nebula");
    expect(migrated.config.appearance.activeThemeId).toBeUndefined();
  });

  test("сохранение/загрузка/удаление пресетов раскладки", () => {
    state.addWidget("recent");
    state.addWidget("chat");
    state.setActiveTheme("orbital");
    state.setActiveTheme("grimhex");
    expect(state.layout).toHaveLength(2);

    const saved = state.saveLayoutPreset({ name: "  Мой пресет  " });
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("Мой пресет");
    expect(saved[0].widgetCount).toBe(2);
    expect(saved[0].theme2d).toBe("orbital");
    expect(saved[0].theme3d).toBe("grimhex");

    // Меняем раскладку и тему, затем возвращаем их из пресета.
    state.removeWidget(state.layout[0].id);
    state.setActiveTheme("pixel");
    state.setActiveTheme(""); // выключаем 3D
    expect(state.layout).toHaveLength(1);

    const applied = state.applyLayoutPreset(saved[0].id);
    expect(applied).toHaveLength(2);
    expect(state.config.appearance.activeThemeId2d).toBe("orbital");
    expect(state.config.appearance.activeThemeId3d).toBe("grimhex");

    const snap = state.snapshot();
    expect(snap.layoutPresets).toHaveLength(1);
    expect(snap.layoutPresets[0].name).toBe("Мой пресет");

    const deleted = state.deleteLayoutPreset(saved[0].id);
    expect(deleted).toHaveLength(0);
    expect(state.applyLayoutPreset(saved[0].id)).toBeNull();
  });

  test("перезапись пресета по id не создаёт дубль", () => {
    state.addWidget("recent");
    const created = state.saveLayoutPreset({ name: "Пресет" });
    const id = created[0].id;

    state.addWidget("chat");
    const updated = state.saveLayoutPreset({ id, name: "Пресет v2" });

    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe(id);
    expect(updated[0].name).toBe("Пресет v2");
    expect(updated[0].widgetCount).toBe(2);
  });

  test("snapshot включает новые поля состояния", () => {
    state.setObsConfig({ cameraAngles: [{ id: "cam1", label: "", twitchRewardTitle: "", sceneName: "", cameraSource: "" }] });
    state.setStreamDeckConfig({ icons: { scene: "media/x.png" } });
    state.setActiveCameraAngle("cam1");

    const snap = state.snapshot();

    expect(snap.activeCameraAngle).toBe("cam1");
    expect(snap.activeScene).toBe("main");
    expect(snap.obs.cameraAngles).toHaveLength(1);
    expect(snap.streamdeck.icons.scene).toBe("media/x.png");
  });
});
