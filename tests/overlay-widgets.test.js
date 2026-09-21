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

const EventBus = require("../overlay/event-bus");
const { EVENT_TYPES } = require("../shared/events");
const GoalWidget = require("../overlay/widgets/goal-widget");
const ChatWidget = require("../overlay/widgets/chat-widget");
const StatWidget = require("../overlay/widgets/stat-widget");
const DeathWidget = require("../overlay/widgets/death-widget");
const RecentWidget = require("../overlay/widgets/recent-widget");
const TimerWidget = require("../overlay/widgets/timer-widget");
const GrimHexTimerWidget = require("../overlay/widgets/grimhex-timer-widget");
const AlertsWidget = require("../overlay/widgets/alerts-widget");
const SoundboardWidget = require("../overlay/widgets/soundboard-widget");

// ---- minimal DOM mock ----

function makeEl(tag) {
  const listeners = [];
  const classSet = new Set();
  const classList = {
    add: (...c) => c.forEach((x) => classSet.add(x)),
    remove: (...c) => c.forEach((x) => classSet.delete(x)),
    toggle: (c, force) => {
      const on = force === undefined ? !classSet.has(c) : force;
      if (on) classSet.add(c);
      else classSet.delete(c);
      return on;
    },
    contains: (c) => classSet.has(c),
  };
  const el = {
    tagName: (tag || "div").toUpperCase(),
    innerHTML: "",
    className: "",
    classList,
    dataset: {},
    style: { setProperty(k, v) { this[k] = v; } },
    children: [],
    parentNode: null,
    isConnected: true,
    clientWidth: 320,
    clientHeight: 96,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    querySelector() {
      return null;
    },
    getContext() {
      return null;
    },
    addEventListener(type, fn, options) {
      listeners.push({ type, fn, options });
    },
    removeEventListener(type, fn) {
      for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].fn === fn) listeners.splice(i, 1);
    },
    _listeners: listeners,
  };
  Object.defineProperty(el, "firstChild", {
    get() {
      return this.children[0] || null;
    },
    configurable: true,
  });
  return el;
}

function makeContext(overrides = {}) {
  return {
    bus: new EventBus(),
    EVENT_TYPES,
    state: {
      goal: { title: "Goal", current: 0, target: 100, currency: "RUB" },
      recentEvents: [],
      stats: { followerCount: 10, subscriberCount: 5 },
      topDonation: { user: "", amount: 0, currency: "RUB" },
      sessionDonations: null,
      deathCount: 0,
      soundboardConfig: { volume: 0.8, queueMode: false },
      micConfig: {},
      remoteMicData: null,
    },
    t: (k) => k,
    ICONS: { follow: "F", sub: "S", donation: "D" },
    renderEmotes: (m) => m,
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    formatMoney: (n) => String(n || 0),
    currencySymbol: (c) => c || "",
    resolveMediaUrl: (p) => p || "",
    readCssVar: () => "",
    audio: { playWinSound: jest.fn(), playEliminationAudio: jest.fn() },
    ...overrides,
  };
}

function mountWidget(WidgetClass, ctx, itemOverrides = {}) {
  const parent = makeEl("div");
  const w = new WidgetClass(
    { id: "w1", type: "goal", x: 0, y: 0, w: 10, h: 10, z: 0, visible: true, config: {}, ...itemOverrides },
    ctx
  );
  w.mount(parent);
  return { w, parent };
}

let originalGlobals;

beforeEach(() => {
  originalGlobals = {
    document: global.document,
    window: global.window,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
    performance: global.performance,
  };
  global.document = { createElement: (tag) => makeEl(tag) };
  global.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  global.requestAnimationFrame = () => 0;
  global.cancelAnimationFrame = () => {};
  global.performance = { now: () => 0 };
});

afterEach(() => {
  global.document = originalGlobals.document;
  global.window = originalGlobals.window;
  global.requestAnimationFrame = originalGlobals.requestAnimationFrame;
  global.cancelAnimationFrame = originalGlobals.cancelAnimationFrame;
  global.performance = originalGlobals.performance;
});

describe("overlay widgets", () => {
  test("GoalWidget рендерит цель и обновляется по goal_update", () => {
    const ctx = makeContext();
    const { w } = mountWidget(GoalWidget, ctx, { config: { showPercentage: true } });

    expect(w.host.innerHTML).toContain("Goal");
    expect(w.host.innerHTML).toContain("0%");

    ctx.state.goal = { title: "New Goal", current: 50, target: 100, currency: "RUB" };
    ctx.bus.emit(EVENT_TYPES.GOAL_UPDATE, ctx.state.goal);

    expect(w.host.innerHTML).toContain("New Goal");
    expect(w.host.innerHTML).toContain("50%");
  });

  test("ChatWidget добавляет и тримит сообщения", () => {
    const ctx = makeContext();
    const { w } = mountWidget(ChatWidget, ctx, { type: "chat", config: { maxMessages: 2 } });

    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "a", message: "hi", color: "#fff", badges: [] });
    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "b", message: "yo", color: "#fff", badges: [] });
    expect(w.host.children.length).toBe(2);

    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "c", message: "yo", color: "#fff", badges: [] });
    expect(w.host.children.length).toBe(2); // trimmed to maxMessages
  });

  test("StatWidget рендерит метрику и обновляется по stat_update", () => {
    const ctx = makeContext();
    const { w } = mountWidget(StatWidget, ctx, { type: "stat", config: { metric: "followers" } });

    expect(w.host.innerHTML).toContain("10");

    ctx.state.stats = { followerCount: 42, subscriberCount: 5 };
    ctx.bus.emit(EVENT_TYPES.STAT_UPDATE, ctx.state.stats);

    expect(w.host.innerHTML).toContain("42");
  });

  test("StatWidget показывает счёт донатов стрима и обновляется по session_stats", () => {
    const ctx = makeContext();
    const { w } = mountWidget(StatWidget, ctx, { type: "stat", config: { metric: "sessionDonations" } });

    // Пока счёт не пришёл (ни снимком, ни событием) — прочерк, а не выдуманный ноль.
    expect(w.host.innerHTML).toContain("—");

    ctx.state.sessionDonations = { count: 7, amount: 1500, currency: "RUB" };
    ctx.bus.emit(EVENT_TYPES.SESSION_STATS, ctx.state.sessionDonations);
    expect(w.host.innerHTML).toContain("7");

    // Ноль — осмысленное значение для счётчика, который только начался.
    ctx.state.sessionDonations = { count: 0, amount: 0, currency: "RUB" };
    ctx.bus.emit(EVENT_TYPES.SESSION_STATS, ctx.state.sessionDonations);
    expect(w.host.innerHTML).toContain(">0<");
  });

  test("StatWidget показывает сумму донатов стрима с валютой", () => {
    const ctx = makeContext();
    ctx.state.sessionDonations = { count: 3, amount: 1500, currency: "RUB" };
    const { w } = mountWidget(StatWidget, ctx, { type: "stat", config: { metric: "sessionAmount" } });

    expect(w.host.innerHTML).toContain("1500");
    expect(w.host.innerHTML).toContain("RUB");
  });

  test("DeathWidget рендерит счётчик и обновляется по death_count_update", () => {
    const ctx = makeContext();
    const { w } = mountWidget(DeathWidget, ctx, { type: "death", config: { label: "Deaths", color: "#f00" } });

    expect(w.host.innerHTML).toContain("0");

    ctx.state.deathCount = 3;
    ctx.bus.emit(EVENT_TYPES.DEATH_COUNT_UPDATE, { count: 3 });

    expect(w.host.innerHTML).toContain("3");
  });

  test("RecentWidget рендерит список событий", () => {
    const ctx = makeContext();
    ctx.state.recentEvents = [{ kind: "follow", user: "alice" }];
    const { w } = mountWidget(RecentWidget, ctx, { type: "recent", config: { maxItems: 5 } });

    expect(w.host.innerHTML).toContain('data-kind="follow"');
  });

  test("AlertsWidget показывает карточку победителя и не дублирует звук колеса", () => {
    const ctx = makeContext();
    const { w } = mountWidget(AlertsWidget, ctx, { type: "alerts" });

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "wheel_winner", user: "bob", isFinalWinner: true });

    // Звуком владеет страница колеса (overlay/wheel-scene.js): иначе в обычной
    // раскладке OBS победный звук слышен дважды — из оверлея и из сцены колеса.
    expect(ctx.audio.playWinSound).not.toHaveBeenCalled();
    expect(ctx.audio.playEliminationAudio).not.toHaveBeenCalled();
    expect(w.host.children.length).toBe(1);
    w.unmount();
  });

  // Общий снимок Longshot для тестов таймера (updateMessage включён нарочно:
  // виджет обязан его игнорировать).
  const longshotAt = (anchorMs, extra = {}) => ({
    ok: true,
    operational: true,
    anchorAt: new Date(anchorMs).toISOString(),
    updateMessage: "Timer updated for Alpha 4.10 LIVE",
    phases: { redSec: 7200, greenSec: 3600, blackSec: 300 },
    lightIntervals: { redStepSec: 1440, greenStepSec: 720 },
    ...extra,
  });

  test("GrimHexTimerWidget рендерит цикл Executive Hangar", () => {
    // Без снимка Longshot — «Синхронизация…».
    const idle = makeContext({ theme: "grimhex" });
    const { w: wIdle } = mountWidget(GrimHexTimerWidget, idle, { type: "grimhex-timer" });
    expect(wIdle.host.dataset.phase).toBe("off");
    expect(wIdle.host.innerHTML).toContain("timer.syncing");
    wIdle.unmount();

    // Есть анкер: фаза Red, пять индикаторов, фиксированный заголовок.
    const ctx = makeContext({ theme: "grimhex", state: { longshot: longshotAt(Date.now() - 60_000) } });
    const { w } = mountWidget(GrimHexTimerWidget, ctx, { type: "grimhex-timer" });
    expect(w.host.dataset.phase).toBe("red");
    expect(w.host.innerHTML).toContain("timer.defaultTitle");
    expect((w.host.innerHTML.match(/class="exec-timer__light"/g) || []).length).toBe(5);
    w.unmount();
  });

  test("TimerWidget (2D) рендерит тот же цикл", () => {
    // У 2D-варианта нет жёсткого гейта — доступность решает каталог (themes).
    const ctx = makeContext({ state: { longshot: longshotAt(Date.now() - 60_000) } });
    const { w } = mountWidget(TimerWidget, ctx, { type: "timer" });
    expect(w.host.dataset.phase).toBe("red");
    expect(w.host.innerHTML).toContain("timer.defaultTitle");
    expect((w.host.innerHTML.match(/class="exec-timer__light"/g) || []).length).toBe(5);
    w.unmount();
  });

  test("TimerWidget берёт анкер из снимка Longshot без служебного сообщения", () => {
    const ctx = makeContext({ state: { longshot: longshotAt(Date.now() - 60_000) } });
    const { w } = mountWidget(TimerWidget, ctx, { type: "timer" });

    expect(w.host.dataset.phase).toBe("red");
    expect(w.host.innerHTML).not.toContain("Timer updated for Alpha 4.10 LIVE");
    w.unmount();
  });

  test("TimerWidget игнорирует старые title/note из раскладки", () => {
    const ctx = makeContext({ state: { longshot: longshotAt(Date.now() - 60_000) } });
    const { w } = mountWidget(TimerWidget, ctx, {
      type: "timer",
      config: { title: "Старый заголовок", note: "Моя заметка" },
    });

    expect(w.host.innerHTML).not.toContain("Старый заголовок");
    expect(w.host.innerHTML).not.toContain("Моя заметка");
    w.unmount();
  });

  test("TimerWidget в блэкауте меняет подпись строки цикла", () => {
    // 10800–11100 с — Black: сайт показывает «Red phase starts in …».
    const ctx = makeContext({ state: { longshot: longshotAt(Date.now() - 10_900_000) } });
    const { w } = mountWidget(TimerWidget, ctx, { type: "timer" });

    expect(w.host.dataset.phase).toBe("black");
    expect(w.host.innerHTML).toContain("timer.redPhaseStartsIn");
    expect(w.host.innerHTML).not.toContain("timer.cycleResetsIn");
    w.unmount();
  });

  test("unmount отписывает виджет от шины", () => {
    const ctx = makeContext();
    const { w } = mountWidget(GoalWidget, ctx);

    const before = w.host.innerHTML;
    w.unmount();

    ctx.state.goal = { title: "After unmount", current: 99, target: 100, currency: "RUB" };
    ctx.bus.emit(EVENT_TYPES.GOAL_UPDATE, ctx.state.goal);

    expect(w.host.innerHTML).toBe(before); // подписка снята — рендер не произошёл
  });
});

/*
  Пропавший звук не должен оставаться в activeAudios: удаление раньше висело
  только на `ended`, а отказ play() и событие `error` его не дают — на длинном
  стриме объекты Audio копились до размонтирования виджета.
*/
describe("SoundboardWidget: уборка проигрываемых звуков", () => {
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.volume = 1;
      this.listeners = {};
      FakeAudio.instances.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this.listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }
    fire(type) {
      for (const fn of [...(this.listeners[type] || [])]) fn();
    }
    play() {
      return Promise.reject(new Error("blocked"));
    }
    pause() {}
  }

  beforeEach(() => {
    FakeAudio.instances = [];
    global.Audio = FakeAudio;
  });

  afterEach(() => {
    delete global.Audio;
  });

  test("отказ play() убирает звук из activeAudios", async () => {
    const ctx = makeContext();
    const { w } = mountWidget(SoundboardWidget, ctx, { type: "soundboard" });
    const onEnded = jest.fn();

    w.playAudio({ audioFile: "media/a.mp3" }, onEnded);
    expect(w.activeAudios).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(w.activeAudios).toHaveLength(0);
    expect(onEnded).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  test("событие error убирает звук и не дублирует onEnded", () => {
    const ctx = makeContext();
    const { w } = mountWidget(SoundboardWidget, ctx, { type: "soundboard" });
    const onEnded = jest.fn();

    w.playAudio({ audioFile: "media/a.mp3" }, onEnded);
    const audio = FakeAudio.instances[0];
    audio.fire("error");
    audio.fire("ended"); // повторное событие того же звука

    expect(w.activeAudios).toHaveLength(0);
    expect(onEnded).toHaveBeenCalledTimes(1);
    w.unmount();
  });
});
