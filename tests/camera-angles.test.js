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

jest.mock("ws", () => {
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
    }
    on() {
      return this;
    }
    send() {}
    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }
  return FakeWebSocket;
});

const { matchCameraAngle } = require("../server/integrations/twitch-eventsub");
const { buildCameraSwitchPlan, startObsWebSocket } = require("../server/integrations/obs-websocket");

const ANGLES = [
  { id: "cam_main", label: "Основная", twitchRewardTitle: "Камера: Главная", sceneName: "Main", cameraSource: "Cam_Main" },
  { id: "cam_side", label: "Боковой", twitchRewardTitle: "Камера: Сбоку", sceneName: "Main", cameraSource: "Cam_Side" },
  { id: "cam_top", label: "Сверху", twitchRewardTitle: "Камера: Сверху", sceneName: "", cameraSource: "Cam_Top" },
  { id: "cam_empty", label: "Пустой", twitchRewardTitle: "Пустой", sceneName: "Main", cameraSource: "" },
];

describe("matchCameraAngle (Twitch награды)", () => {
  test("находит ракурс по названию без учёта регистра и пробелов", () => {
    expect(matchCameraAngle(ANGLES, "камера: главная").id).toBe("cam_main");
    expect(matchCameraAngle(ANGLES, "  Камера: Сбоку ").id).toBe("cam_side");
  });

  test("возвращает null при отсутствии совпадения", () => {
    expect(matchCameraAngle(ANGLES, "Другая награда")).toBeNull();
  });

  test("возвращает null для пустого названия или пустого списка", () => {
    expect(matchCameraAngle(ANGLES, "")).toBeNull();
    expect(matchCameraAngle(ANGLES, "   ")).toBeNull();
    expect(matchCameraAngle([], "Камера: Главная")).toBeNull();
    expect(matchCameraAngle(null, "Камера: Главная")).toBeNull();
  });
});

describe("buildCameraSwitchPlan (план включения/выключения)", () => {
  test("включает только целевой ракурс, остальные выключает", () => {
    const plan = buildCameraSwitchPlan(ANGLES, "cam_side");
    expect(plan).toEqual([
      { sceneName: "Main", cameraSource: "Cam_Main", enabled: false },
      { sceneName: "Main", cameraSource: "Cam_Side", enabled: true },
    ]);
  });

  test("пропускает ракурсы без sceneName или cameraSource", () => {
    const plan = buildCameraSwitchPlan(ANGLES, "cam_main");
    expect(plan).toHaveLength(2);
    expect(plan.map((op) => op.cameraSource)).toEqual(["Cam_Main", "Cam_Side"]);
  });

  test("возвращает пустой план для пустого списка", () => {
    expect(buildCameraSwitchPlan([], "x")).toEqual([]);
    expect(buildCameraSwitchPlan(null, "x")).toEqual([]);
  });

  test("все выключены, если целевой id не найден", () => {
    const plan = buildCameraSwitchPlan(ANGLES, "unknown");
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((op) => op.enabled === false)).toBe(true);
  });

  test("исключает источник веб-камеры из плана переключения", () => {
    const plan = buildCameraSwitchPlan(ANGLES, "cam_side", ["Cam_Main"]);
    expect(plan).toEqual([
      { sceneName: "Main", cameraSource: "Cam_Side", enabled: true },
    ]);
  });
});

describe("setCameraAngle (валидация входных данных)", () => {
  function makeCtrl(cameraAngles) {
    const bus = { emit: jest.fn() };
    const ctrl = startObsWebSocket({
      bus,
      config: { obs: { host: "127.0.0.1", port: 4455, cameraAngles } },
    });
    return { bus, ctrl };
  }

  test("отклоняет при отсутствии настроенных ракурсов", async () => {
    const { ctrl } = makeCtrl([]);
    await expect(ctrl.setCameraAngle("x")).rejects.toThrow("No camera angles configured");
  });

  test("отклоняет неизвестный ракурс", async () => {
    const { ctrl } = makeCtrl([{ id: "cam_main", sceneName: "Main", cameraSource: "Cam_Main" }]);
    await expect(ctrl.setCameraAngle("zzz")).rejects.toThrow("Unknown camera angle: zzz");
  });

  test("отклоняет при отключённом OBS", async () => {
    const { ctrl } = makeCtrl([{ id: "cam_main", sceneName: "Main", cameraSource: "Cam_Main" }]);
    await expect(ctrl.setCameraAngle("cam_main")).rejects.toThrow("OBS не подключен");
  });
});
