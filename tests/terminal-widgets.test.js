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
  3D-набор Terminal: куб, цель, чат и алерт.

  Проверяем то, что легко сломать незаметно: жёсткую привязку к теме (на чужой
  теме не должно быть ни DOM, ни цикла), подписки на нужные события и то, что
  окна собираются как терминальные панели — вкладка с приглашением, ASCII-шкала
  цели и вывод команды в алерте.
*/

const EventBus = require("../overlay/event-bus");
const { EVENT_TYPES } = require("../shared/events");
const WidgetTerminalCube = require("../overlay/widgets/terminal-cube-widget");
const WidgetTerminalGoal = require("../overlay/widgets/terminal-goal-widget");
const WidgetTerminalChat = require("../overlay/widgets/terminal-chat-widget");
const WidgetTerminalHoloAlert = require("../overlay/widgets/terminal-holo-alert-widget");
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

describe("WidgetTerminalCube", () => {
  const cubeItem = () => item("terminal-cube", { renderType: "canvas", w: 22, h: 18 });

  test("скрыт до алерта, затем показывает куб и запускает цикл", () => {
    const context = makeContext("terminal");
    const widget = new WidgetTerminalCube(cubeItem(), context);
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
    expect(widget.ctx.stroke).toHaveBeenCalled();

    widget.unmount();
    expect(raf.pending()).toBe(0);
  });

  test("не запускает цикл на чужой теме", () => {
    const widget = new WidgetTerminalCube(cubeItem(), makeContext("sf"));
    widget.mount(makeEl("div"));
    expect(raf.pending()).toBe(0);
    widget.unmount();
  });
});

describe("WidgetTerminalGoal", () => {
  test("монтируется в терминальной панели и рисует ASCII-шкалу", () => {
    const context = makeContext("terminal");
    const widget = new WidgetTerminalGoal(item("terminal-goal"), context);
    widget.mount(makeEl("div"));

    expect(widget.windowEl).toBeTruthy();
    expect(widget.element.classList.contains("terminal-surface")).toBe(true);
    expect(widget.titleEl.textContent).toBe("Цель");
    expect(widget.barEl.innerHTML).toContain("50%");
    expect(widget.barEl.innerHTML).toContain("█");
    expect(widget.amountEl.innerHTML).toContain("50");

    context.state.goal = { title: "Новая", current: 75, target: 100, currency: "USD" };
    context.bus.emit(EVENT_TYPES.GOAL_UPDATE, context.state.goal);
    expect(widget.titleEl.textContent).toBe("Новая");
    expect(widget.barEl.innerHTML).toContain("75%");

    widget.unmount();
  });

  test("без фона снимает корпус панели, но оставляет шкалу", () => {
    const widget = new WidgetTerminalGoal(
      item("terminal-goal", { config: { showBackground: false } }),
      makeContext("terminal"),
    );
    widget.mount(makeEl("div"));
    expect(widget.element.classList.contains("terminal-surface")).toBe(false);
    expect(widget.barEl).toBeTruthy();

    widget.update({ config: { showBackground: true } });
    expect(widget.element.classList.contains("terminal-surface")).toBe(true);
    widget.unmount();
  });

  test("не инициализируется на чужой теме", () => {
    const widget = new WidgetTerminalGoal(item("terminal-goal"), makeContext("sf"));
    widget.mount(makeEl("div"));
    expect(widget.windowEl).toBeNull();
    widget.unmount();
  });
});

describe("WidgetTerminalChat", () => {
  test("монтируется и рисует сообщения", () => {
    const context = makeContext("terminal");
    const widget = new WidgetTerminalChat(item("terminal-chat"), context);
    widget.mount(makeEl("div"));

    expect(widget.windowEl).toBeTruthy();
    expect(widget.element.classList.contains("terminal-surface")).toBe(true);

    context.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "bob", message: "hi", badges: [] });
    expect(widget.messagesInner.children).toHaveLength(1);
    expect(widget.messagesInner.children[0].innerHTML).toContain("bob");

    widget.unmount();
  });

  test("держит лимит строк maxMessages", () => {
    const context = makeContext("terminal");
    const widget = new WidgetTerminalChat(item("terminal-chat", { config: { maxMessages: 2 } }), context);
    widget.mount(makeEl("div"));

    context.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "a", message: "1" });
    context.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "b", message: "2" });
    context.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "c", message: "3" });

    expect(widget.messagesInner.children).toHaveLength(2);
    widget.unmount();
  });

  test("не инициализируется на чужой теме", () => {
    const widget = new WidgetTerminalChat(item("terminal-chat"), makeContext("pixel"));
    widget.mount(makeEl("div"));
    expect(widget.windowEl).toBeNull();
    widget.unmount();
  });
});

describe("WidgetTerminalHoloAlert", () => {
  test("скрыт до алерта, затем печатает вывод команды", () => {
    const context = makeContext("terminal");
    const widget = new WidgetTerminalHoloAlert(item("terminal-holo-alert"), context);
    widget.mount(makeEl("div"));

    expect(widget.host).toBeTruthy();
    expect(widget.element.style.opacity).toBe("0");

    context.bus.emit(EVENT_TYPES.ALERT, { kind: "follow", user: "bob", durationMs: 5000 });
    expect(widget.element.style.opacity).toBe("1");
    expect(widget.host.children).toHaveLength(1);

    const card = widget.host.children[0];
    const tab = card.children[0];
    expect(tab.innerHTML).toContain("root@ose-alert");

    const body = card.children[1];
    const lines = body.children.map((row) => row.dataset.plain).join("\n");
    expect(lines).toContain("bob");
    expect(lines).toContain("sudo apt install follow");

    widget.unmount();
    expect(widget.host).toBeNull();
  });

  test("панель растягивается под длинный текст", () => {
    const context = makeContext("terminal");
    const widget = new WidgetTerminalHoloAlert(item("terminal-holo-alert"), context);
    widget.mount(makeEl("div"));

    context.bus.emit(EVENT_TYPES.ALERT, {
      kind: "donation",
      user: "bob",
      amount: 500,
      message: "Очень длинное сообщение, которое не влезает в одну строку",
      durationMs: 5000,
    });

    const card = widget.host.children[0];
    // В моке нет раскладки: высоту содержимого задаём сами, как её отдал бы браузер.
    card.scrollHeight = 420;
    widget._autoSize(card);
    expect(parseInt(widget.element.style.height, 10)).toBeGreaterThanOrEqual(420);

    // Каждый снимок состояния заново ставит процентную высоту — панель
    // не должна из-за этого сжиматься обратно.
    widget.update({});
    expect(parseInt(widget.element.style.height, 10)).toBeGreaterThanOrEqual(420);

    widget.unmount();
  });

  test("не инициализируется на чужой теме", () => {
    const widget = new WidgetTerminalHoloAlert(item("terminal-holo-alert"), makeContext("sf"));
    widget.mount(makeEl("div"));
    expect(widget.host).toBeNull();
    widget.unmount();
  });
});

describe("WidgetManager — изоляция виджетов Terminal", () => {
  test("не создаёт terminal-виджеты, пока тема не terminal", () => {
    const root = makeEl("div");
    const context = makeContext("pixel");
    const manager = new WidgetManager(root, {
      shouldMount: (inst) => (!inst.type.startsWith("terminal-") ? true : context.theme === "terminal"),
      resolveRenderType: (inst) => (inst.type === "terminal-cube" ? "canvas" : "2d"),
      context,
    });
    manager.register("terminal-cube", WidgetTerminalCube);
    manager.register("terminal-goal", WidgetTerminalGoal);
    manager.register("terminal-chat", WidgetTerminalChat);
    manager.register("terminal-holo-alert", WidgetTerminalHoloAlert);

    const layout = [
      item("terminal-cube", { renderType: "canvas" }),
      item("terminal-goal"),
      item("terminal-chat"),
      item("terminal-holo-alert"),
    ];

    manager.syncLayout(layout);
    expect(manager.size).toBe(0);

    context.theme = "terminal";
    manager.syncLayout(layout);
    expect(manager.size).toBe(4);

    context.theme = "sf";
    manager.syncLayout(layout);
    expect(manager.size).toBe(0);
  });
});
