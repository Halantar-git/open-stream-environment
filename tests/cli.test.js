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

const { EventEmitter } = require("events");
const { createCliHandler, HELP_LINES } = require("../server/cli");

function makeState() {
  const state = {
    config: {
      obs: {
        sceneMap: { main: "Main", start: "Start", brb: "BRB", talk: "Talk", end: "End", wheel: "Wheel" },
        cameraAngles: [{ id: "cam_main", label: "Main", sceneName: "Main", cameraSource: "Cam" }],
        cameraFilters: [{ id: "filter_bw", label: "BW", sourceName: "Cam", filterName: "BW" }],
        customCommands: [{ id: "cmd_1", label: "Mute", requestType: "ToggleInputMute" }],
      },
      soundboard: { sounds: [{ id: "airhorn", title: "Airhorn" }] },
      twitch: { channel: "test_channel" },
      goal: { title: "Цель", current: 0, target: 100, currency: "RUB" },
    },
    runtime: {
      connectionStatus: { obs: "disconnected" },
      activeScene: "main",
      activeCameraAngle: null,
      deathCount: 0,
      giveaway: { active: false, command: "!go", eliminationMode: false, winner: null, participants: new Set() },
    },
    setActiveScene(scene) {
      this.runtime.activeScene = scene;
    },
    adjustDeathCount(delta) {
      this.runtime.deathCount = Math.max(0, this.runtime.deathCount + (Number(delta) || 0));
      return { count: this.runtime.deathCount };
    },
    resetDeathCount() {
      this.runtime.deathCount = 0;
      return { count: 0 };
    },
    setActiveTheme() {
      return true;
    },
    listThemes() {
      return [{ id: "nebula", name: "Material You", builtin: true, category: "system" }];
    },
    snapshot() {
      return {
        appearance: { activeThemeId: "nebula" },
        deathCount: this.runtime.deathCount,
        goal: { ...this.config.goal },
      };
    },
    addToGoal(amount) {
      this.config.goal.current += Number(amount) || 0;
      return { ...this.config.goal };
    },
    setGoal(patch) {
      this.config.goal = { ...this.config.goal, ...patch };
      return { ...this.config.goal };
    },
    addGiveawayParticipant(name) {
      this.runtime.giveaway.participants.add(name);
      return this.giveawaySnapshot();
    },
    removeGiveawayParticipant(name) {
      this.runtime.giveaway.participants.delete(name);
      return this.giveawaySnapshot();
    },
    shuffleGiveaway() {
      return this.giveawaySnapshot();
    },
    setGiveawayEliminationMode(on) {
      this.runtime.giveaway.eliminationMode = !!on;
      return this.giveawaySnapshot();
    },
    giveawaySnapshot() {
      return {
        active: this.runtime.giveaway.active,
        command: this.runtime.giveaway.command,
        eliminationMode: this.runtime.giveaway.eliminationMode,
        winner: this.runtime.giveaway.winner,
        isFinalWinner: false,
        count: this.runtime.giveaway.participants.size,
        participants: [...this.runtime.giveaway.participants],
      };
    },
  };
  return state;
}

describe("server/cli", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("не падает при сломанном/отсутствующем объекте логгера", () => {
    const state = makeState();
    const bus = new EventEmitter();
    const cli = createCliHandler({
      state,
      bus,
      obsCtrl: null,
      broadcast: () => {},
      startedAt: Date.now(),
      logger: {}, // объект без методов info/success/warn/error
    });

    expect(() => cli.execute("help")).not.toThrow();
    expect(() => cli.execute("status")).not.toThrow();
    expect(() => cli.execute("death +1")).not.toThrow();
    expect(() => cli.execute("неизвестная команда")).not.toThrow();
  });

  test("help эмитит список команд в terminal_log", () => {
    const state = makeState();
    const bus = new EventEmitter();
    const entries = [];
    bus.on("terminal_log", (entry) => entries.push(entry));

    const cli = createCliHandler({ state, bus, obsCtrl: null, broadcast: () => {}, startedAt: Date.now() });
    cli.execute("help");

    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].service).toBe("CLI");
    expect(entries[0].message).toContain("Доступные команды");
    expect(entries.some((e) => e.message.includes("scene <name>"))).toBe(true);
  });

  test("death +1 увеличивает счётчик и логирует результат", () => {
    const state = makeState();
    const bus = new EventEmitter();
    const entries = [];
    bus.on("terminal_log", (entry) => entries.push(entry));

    const cli = createCliHandler({ state, bus, obsCtrl: null, broadcast: () => {}, startedAt: Date.now() });
    cli.execute("death +1");

    expect(state.runtime.deathCount).toBe(1);
    expect(entries.some((e) => e.level === "success" && e.message.includes("Счётчик смертей: 1"))).toBe(true);
  });

  test("неизвестная команда логирует ошибку, а не бросает исключение", () => {
    const state = makeState();
    const bus = new EventEmitter();
    const entries = [];
    bus.on("terminal_log", (entry) => entries.push(entry));

    const cli = createCliHandler({ state, bus, obsCtrl: null, broadcast: () => {}, startedAt: Date.now() });
    expect(() => cli.execute("wat")).not.toThrow();
    expect(entries.some((e) => e.level === "error" && e.message.includes("Неизвестная команда"))).toBe(true);
  });

  test("goal add увеличивает цель и логирует результат", () => {
    const state = makeState();
    const bus = new EventEmitter();
    const entries = [];
    bus.on("terminal_log", (entry) => entries.push(entry));

    const cli = createCliHandler({ state, bus, obsCtrl: null, broadcast: () => {}, startedAt: Date.now() });
    cli.execute("goal add 25");

    expect(state.config.goal.current).toBe(25);
    expect(entries.some((e) => e.level === "success" && e.message.includes("Цель: 25 / 100"))).toBe(true);
  });

  test("themes логирует список тем", () => {
    const state = makeState();
    const bus = new EventEmitter();
    const entries = [];
    bus.on("terminal_log", (entry) => entries.push(entry));

    const cli = createCliHandler({ state, bus, obsCtrl: null, broadcast: () => {}, startedAt: Date.now() });
    cli.execute("themes");

    expect(entries.some((e) => e.message.includes("nebula") && e.message.includes("Material You"))).toBe(true);
  });

  test("chat эмитит chat_message в bus", () => {
    const state = makeState();
    const bus = new EventEmitter();
    const chatMessages = [];
    bus.on("chat_message", (m) => chatMessages.push(m));

    const cli = createCliHandler({ state, bus, obsCtrl: null, broadcast: () => {}, startedAt: Date.now() });
    cli.execute("chat Привет, чат!");

    expect(chatMessages.length).toBe(1);
    expect(chatMessages[0].message).toBe("Привет, чат!");
    expect(chatMessages[0].isTest).toBe(true);
  });

  test("HELP_LINES не пуст и содержит расширенные команды", () => {
    expect(HELP_LINES.length).toBeGreaterThan(0);
    const text = HELP_LINES.join(" ");
    expect(text).toContain("scene");
    expect(text).toContain("wheel");
    expect(text).toContain("giveaway");
    expect(text).toContain("theme");
    expect(text).toContain("goal");
    expect(text).toContain("alert");
  });

  test("getCompletions дополняет имя команды", () => {
    const state = makeState();
    const cli = createCliHandler({ state, bus: new EventEmitter(), obsCtrl: null, broadcast: () => {}, startedAt: Date.now() });
    expect(cli.getCompletions("givea")).toEqual(["giveaway "]);
    expect(cli.getCompletions("g")).toContain("giveaway ");
    expect(cli.getCompletions("g")).toContain("goal ");
  });

  test("getCompletions подставляет аргументы по команде", () => {
    const state = makeState();
    const cli = createCliHandler({ state, bus: new EventEmitter(), obsCtrl: null, broadcast: () => {}, startedAt: Date.now() });
    expect(cli.getCompletions("scene ")).toContain("scene main ");
    expect(cli.getCompletions("scene ")).toContain("scene brb ");
    expect(cli.getCompletions("scene b")).toEqual(["scene brb "]);
    expect(cli.getCompletions("sound ")).toEqual(["sound airhorn "]);
    expect(cli.getCompletions("cam ")).toEqual(["cam cam_main "]);
  });

  test("getCompletions дополняет подкоманды", () => {
    const state = makeState();
    const cli = createCliHandler({ state, bus: new EventEmitter(), obsCtrl: null, broadcast: () => {}, startedAt: Date.now() });
    expect(cli.getCompletions("sim ")).toEqual(["sim sub ", "sim points ", "sim raid "]);
    expect(cli.getCompletions("wheel ")).toContain("wheel spin ");
    expect(cli.getCompletions("wheel ")).toContain("wheel generate ");
  });

  test("локализует сообщения в английский при передаче t", () => {
    const en = require("../shared/locales/en.json");
    const t = (key, params) => {
      let v = String(key).split(".").reduce((a, k) => (a && typeof a === "object" ? a[k] : undefined), en);
      if (typeof v !== "string") v = String(key);
      if (params) Object.keys(params).forEach((p) => { v = v.split("{{" + p + "}}").join(String(params[p])); });
      return v;
    };

    const state = makeState();
    const bus = new EventEmitter();
    const entries = [];
    bus.on("terminal_log", (entry) => entries.push(entry));

    const cli = createCliHandler({ state, bus, obsCtrl: null, broadcast: () => {}, startedAt: Date.now(), t });
    cli.execute("death +1");
    cli.execute("wat");

    expect(entries.some((e) => e.level === "success" && e.message.includes("Death counter: 1"))).toBe(true);
    expect(entries.some((e) => e.level === "error" && e.message.includes("Unknown command"))).toBe(true);
  });
});
