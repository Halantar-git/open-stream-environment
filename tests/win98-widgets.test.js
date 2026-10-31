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
  3D-набор Windows 98: куб, цель, чат и алерт.

  Проверяем то, что легко сломать незаметно: жёсткую привязку к теме (на чужой
  теме не должно быть ни DOM, ни цикла), подписки на нужные события и то, что
  окна собираются из вдавленных полей и цветов заголовка.
*/

const EventBus = require("../overlay/event-bus");
const { EVENT_TYPES } = require("../shared/events");
const WidgetWin98Cube = require("../overlay/widgets/win98-cube-widget");
const WidgetWin98Goal = require("../overlay/widgets/win98-goal-widget");
const WidgetWin98Chat = require("../overlay/widgets/win98-chat-widget");
const WidgetWin98HoloAlert = require("../overlay/widgets/win98-holo-alert-widget");
const WidgetManager = require("../overlay/widgets/widget-manager");

// ---- минимальные заглушки DOM и canvas ----

function makeCtx2D() {
  const gradient = { addColorStop: jest.fn() };
  const ctx = {
    createLinearGradient: jest.fn(() => gradient),
    createRadialGradient: jest.fn(() => gradient),
    fillText: jest.fn(),
    strokeText: jest.fn(),
    setLineDash: jest.fn(),
    quadraticCurveTo: jest.fn(),
    roundRect: jest.fn(),
  };
  [
    "setTransform",
    "transform",
    "clearRect",
    "save",
    "restore",
    "beginPath",
    "moveTo",
    "lineTo",
    "closePath",
    "fill",
    "fillRect",
    "strokeRect",
    "stroke",
    "clip",
    "arc",
  ].forEach((method) => (ctx[method] = jest.fn()));
  return ctx;
}

function makeEl(tag) {
  const isCanvas = tag === "canvas";
  const ctx2d = isCanvas ? makeCtx2D() : null;
  const classSet = new Set();
  const el = {
    tagName: (tag || "div").toUpperCase(),
    className: "",
    dataset: {},
    style: {
      setProperty(key, value) {
        this[key] = value;
      },
    },
    classList: {
      add: (...classes) => classes.forEach((name) => classSet.add(name)),
      remove: (...classes) => classes.forEach((name) => classSet.delete(name)),
      toggle: (name, force) => {
        const on = force === undefined ? !classSet.has(name) : force;
        if (on) classSet.add(name);
        else classSet.delete(name);
        return on;
      },
      contains: (name) => classSet.has(name),
    },
    innerHTML: "",
    textContent: "",
    width: 0,
    height: 0,
    clientWidth: 320,
    clientHeight: 80,
    offsetHeight: 0,
    offsetWidth: 0,
    scrollTop: 0,
    scrollHeight: 0,
    parentNode: null,
    children: [],
    isConnected: true,
    animate: jest.fn(),
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    querySelector() {
      return null;
    },
    getContext(type) {
      return isCanvas && type === "2d" ? ctx2d : null;
    },
    addEventListener() {},
    removeEventListener() {},
    _ctx: ctx2d,
  };
  Object.defineProperty(el, "firstChild", {
    get() {
      return this.children[0] || null;
    },
    configurable: true,
  });
  return el;
}

function createRaf() {
  let id = 0;
  const queue = [];
  return {
    request: (fn) => {
      const handle = ++id;
      queue.push({ handle, fn });
      return handle;
    },
    cancel: (handle) => {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].handle === handle) queue.splice(i, 1);
      }
    },
    pending: () => queue.length,
    flush: (now) => queue.splice(0).forEach((entry) => entry.fn(now)),
  };
}

function makeContext(theme) {
  return {
    bus: new EventBus(),
    EVENT_TYPES,
    theme,
    state: { goal: { title: "Цель", current: 50, target: 100, currency: "RUB" } },
    escapeHtml: (value) => String(value),
    escapeAttr: (value) => String(value),
    formatMoney: (value) => String(value),
    currencySymbol: (value) => String(value),
    renderEmotes: (message) => message,
    t: (key) => key,
    readCssVar: () => "",
    ICONS: { follow: "<svg></svg>", donation: "<svg></svg>" },
  };
}

function item(type, overrides = {}) {
  return { id: type, type, x: 0, y: 0, w: 24, h: 12, z: 0, visible: true, config: {}, renderType: "2d", ...overrides };
}

let raf;
let clock;
let originalGlobals;

beforeEach(() => {
  raf = createRaf();
  clock = 0;
  originalGlobals = {
    document: global.document,
    window: global.window,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
    performance: global.performance,
  };
  global.document = { createElement: (tag) => makeEl(tag) };
  global.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  global.requestAnimationFrame = raf.request;
  global.cancelAnimationFrame = raf.cancel;
  global.performance = { now: () => clock };
});

afterEach(() => {
  global.document = originalGlobals.document;
  global.window = originalGlobals.window;
  global.requestAnimationFrame = originalGlobals.requestAnimationFrame;
  global.cancelAnimationFrame = originalGlobals.cancelAnimationFrame;
  global.performance = originalGlobals.performance;
});

describe("WidgetWin98Cube", () => {
  const cubeItem = () => item("win98-cube", { renderType: "canvas", w: 22, h: 18 });

  test("скрыт до алерта, затем показывает куб и запускает цикл", () => {
    const context = makeContext("win98");
    const widget = new WidgetWin98Cube(cubeItem(), context);
    widget.mount(makeEl("div"));

    expect(widget.element.tagName).toBe("CANVAS");
    expect(widget.element.style.opacity).toBe("0");
    expect(raf.pending()).toBe(0);

    context.bus.emit(EVENT_TYPES.ALERT, { kind: "follow", durationMs: 5000 });
    expect(widget.element.style.opacity).toBe("1");
    expect(raf.pending()).toBe(1);

    raf.flush(1000);
    expect(widget.ctx.clearRect).toHaveBeenCalled();
    expect(widget.ctx.fill).toHaveBeenCalled();

    widget.unmount();
    expect(raf.pending()).toBe(0);
  });

  test("не запускает цикл на чужой теме", () => {
    const widget = new WidgetWin98Cube(cubeItem(), makeContext("sf"));
    widget.mount(makeEl("div"));
    expect(raf.pending()).toBe(0);
    widget.unmount();
  });
});

describe("WidgetWin98Goal", () => {
  test("монтируется в окне и обновляет прогресс", () => {
    const context = makeContext("win98");
    const widget = new WidgetWin98Goal(item("win98-goal"), context);
    widget.mount(makeEl("div"));

    expect(widget.windowEl).toBeTruthy();
    expect(widget.element.classList.contains("win98-surface")).toBe(true);
    expect(widget.titleEl.textContent).toBe("Цель");
    expect(widget.fillEl.style.width).toBe("50%");
    expect(widget.amountEl.innerHTML).toContain("50");

    context.state.goal = { title: "Новая", current: 75, target: 100, currency: "USD" };
    context.bus.emit(EVENT_TYPES.GOAL_UPDATE, context.state.goal);
    expect(widget.titleEl.textContent).toBe("Новая");
    expect(widget.fillEl.style.width).toBe("75%");

    widget.unmount();
  });

  test("без фона снимает корпус окна, но оставляет шкалу", () => {
    const widget = new WidgetWin98Goal(item("win98-goal", { config: { showBackground: false } }), makeContext("win98"));
    widget.mount(makeEl("div"));
    expect(widget.element.classList.contains("win98-surface")).toBe(false);
    expect(widget.fillEl).toBeTruthy();

    widget.update({ config: { showBackground: true } });
    expect(widget.element.classList.contains("win98-surface")).toBe(true);
    widget.unmount();
  });

  test("не инициализируется на чужой теме", () => {
    const widget = new WidgetWin98Goal(item("win98-goal"), makeContext("sf"));
    widget.mount(makeEl("div"));
    expect(widget.windowEl).toBeNull();
    widget.unmount();
  });
});

describe("WidgetWin98Chat", () => {
  test("монтируется и рисует сообщения", () => {
    const context = makeContext("win98");
    const widget = new WidgetWin98Chat(item("win98-chat"), context);
    widget.mount(makeEl("div"));

    expect(widget.windowEl).toBeTruthy();
    expect(widget.element.classList.contains("win98-surface")).toBe(true);

    context.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "bob", message: "hi", badges: [] });
    expect(widget.messagesInner.children).toHaveLength(1);
    expect(widget.messagesInner.children[0].innerHTML).toContain("bob");

    widget.unmount();
  });

  test("держит лимит строк maxMessages", () => {
    const context = makeContext("win98");
    const widget = new WidgetWin98Chat(item("win98-chat", { config: { maxMessages: 2 } }), context);
    widget.mount(makeEl("div"));

    context.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "a", message: "1" });
    context.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "b", message: "2" });
    context.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "c", message: "3" });

    expect(widget.messagesInner.children).toHaveLength(2);
    widget.unmount();
  });

  test("не инициализируется на чужой теме", () => {
    const widget = new WidgetWin98Chat(item("win98-chat"), makeContext("pixel"));
    widget.mount(makeEl("div"));
    expect(widget.windowEl).toBeNull();
    widget.unmount();
  });
});

describe("WidgetWin98HoloAlert", () => {
  test("скрыт до алерта, затем показывает окно", () => {
    const context = makeContext("win98");
    const widget = new WidgetWin98HoloAlert(item("win98-holo-alert"), context);
    widget.mount(makeEl("div"));

    expect(widget.host).toBeTruthy();
    expect(widget.element.style.opacity).toBe("0");

    context.bus.emit(EVENT_TYPES.ALERT, { kind: "follow", user: "bob", durationMs: 5000 });
    expect(widget.element.style.opacity).toBe("1");
    expect(widget.host.children).toHaveLength(1);
    expect(widget.host.children[0].innerHTML).toContain("bob");
    expect(widget.host.children[0].innerHTML).toContain("alert.follow");

    widget.unmount();
    expect(widget.host).toBeNull();
  });

  test("не инициализируется на чужой теме", () => {
    const widget = new WidgetWin98HoloAlert(item("win98-holo-alert"), makeContext("sf"));
    widget.mount(makeEl("div"));
    expect(widget.host).toBeNull();
    widget.unmount();
  });
});

describe("WidgetManager — изоляция виджетов Windows 98", () => {
  test("не создаёт win98-виджеты, пока тема не win98", () => {
    const root = makeEl("div");
    const context = makeContext("pixel");
    const manager = new WidgetManager(root, {
      shouldMount: (inst) => (!inst.type.startsWith("win98-") ? true : context.theme === "win98"),
      resolveRenderType: (inst) => (inst.type === "win98-cube" ? "canvas" : "2d"),
      context,
    });
    manager.register("win98-cube", WidgetWin98Cube);
    manager.register("win98-goal", WidgetWin98Goal);
    manager.register("win98-chat", WidgetWin98Chat);
    manager.register("win98-holo-alert", WidgetWin98HoloAlert);

    const layout = [
      item("win98-cube", { renderType: "canvas" }),
      item("win98-goal"),
      item("win98-chat"),
      item("win98-holo-alert"),
    ];

    manager.syncLayout(layout);
    expect(manager.size).toBe(0);

    context.theme = "win98";
    manager.syncLayout(layout);
    expect(manager.size).toBe(4);

    context.theme = "sf";
    manager.syncLayout(layout);
    expect(manager.size).toBe(0);
  });
});
