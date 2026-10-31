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
  3D-набор Super Four: тахометр, цель, чат и алерт.

  Проверяем то, что легко сломать незаметно: жёсткую привязку к теме (на чужой
  теме не должно быть ни DOM, ни цикла), подписки на нужные события и
  поведение тахометра — он не гаснет между алертами, но раскручивается на
  событии и возвращается на холостые.
*/

const EventBus = require("../overlay/event-bus");
const { EVENT_TYPES } = require("../shared/events");
const WidgetSfTachometer = require("../overlay/widgets/sf-tachometer-widget");
const WidgetSfGoal = require("../overlay/widgets/sf-goal-widget");
const WidgetSfChat = require("../overlay/widgets/sf-chat-widget");
const WidgetSfHoloAlert = require("../overlay/widgets/sf-holo-alert-widget");
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
  const listeners = [];
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
    querySelector(selector) {
      // Чату нужна ссылка на полоску цилиндров: реальную разметку innerHTML
      // заглушка не парсит, поэтому отдаём заранее подготовленный узел.
      if (selector === ".sf-chat__cyl") {
        this._cyl = this._cyl || makeEl("span");
        return this._cyl;
      }
      return null;
    },
    getContext(type) {
      return isCanvas && type === "2d" ? ctx2d : null;
    },
    addEventListener(type, fn, options) {
      listeners.push({ type, fn, options });
    },
    removeEventListener(type, fn) {
      for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i].fn === fn) listeners.splice(i, 1);
      }
    },
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
    flush: (now) => queue.splice(0).forEach((item) => item.fn(now)),
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

describe("WidgetSfTachometer", () => {
  const tachItem = () => item("sf-tachometer", { renderType: "canvas", w: 24, h: 18 });

  test("в покое держит холостые и рисует прибор", () => {
    const widget = new WidgetSfTachometer(tachItem(), makeContext("sf"));
    widget.mount(makeEl("div"));

    expect(widget.element.tagName).toBe("CANVAS");
    expect(raf.pending()).toBe(1);

    raf.flush(1000);
    expect(widget.ctx.clearRect).toHaveBeenCalled();
    expect(widget.ctx.fillText).toHaveBeenCalled();
    expect(widget._gear).toBe("N");

    widget.unmount();
    expect(raf.pending()).toBe(0);
  });

  test("на алерте раскручивается и включает передачу, затем гаснет", () => {
    const context = makeContext("sf");
    const widget = new WidgetSfTachometer(tachItem(), context);
    widget.mount(makeEl("div"));

    context.bus.emit(EVENT_TYPES.ALERT, { kind: "follow", durationMs: 5000 });
    expect(widget._gear).toBe("2");
    expect(widget._fps).toBe(30);
    expect(widget._alertRpm).toBeGreaterThan(1.2);

    context.bus.emit(EVENT_TYPES.ALERT, { kind: "donation", durationMs: 5000 });
    expect(widget._gear).toBe("6");
    expect(widget._alertRpm).toBeGreaterThan(11.5);

    widget._endRev();
    expect(widget._gear).toBe("N");
    expect(widget._fps).toBeLessThan(30);

    widget.unmount();
  });

  test("не поднимает цикл на чужой теме", () => {
    const widget = new WidgetSfTachometer(tachItem(), makeContext("retrowave"));
    widget.mount(makeEl("div"));
    expect(raf.pending()).toBe(0);
    expect(widget.element.tagName).toBe("CANVAS"); // элемент создаёт BaseWidget, цикла нет
    widget.unmount();
  });
});

describe("WidgetSfGoal", () => {
  test("монтируется, рисует шкалу и обновляет прогресс", () => {
    const context = makeContext("sf");
    const widget = new WidgetSfGoal(item("sf-goal"), context);
    widget.mount(makeEl("div"));

    expect(widget.canvas).toBeTruthy();
    expect(widget.contentEl.innerHTML).toContain("Цель");
    expect(widget._pct).toBe(50);
    expect(raf.pending()).toBe(1);

    raf.flush(1000);
    expect(widget.ctx.fillRect).toHaveBeenCalled();

    context.state.goal = { title: "Новая", current: 75, target: 100, currency: "USD" };
    context.bus.emit(EVENT_TYPES.GOAL_UPDATE, context.state.goal);
    expect(widget._pct).toBe(75);
    expect(widget.contentEl.innerHTML).toContain("Новая");

    widget.unmount();
    expect(raf.pending()).toBe(0);
  });

  test("без фона снимает панель, но оставляет шкалу", () => {
    const widget = new WidgetSfGoal(item("sf-goal", { config: { showBackground: false } }), makeContext("sf"));
    widget.mount(makeEl("div"));
    expect(widget.element.classList.contains("sf-surface")).toBe(false);
    widget.update({ config: { showBackground: true } });
    expect(widget.element.classList.contains("sf-surface")).toBe(true);
    widget.unmount();
  });

  test("не инициализируется на чужой теме", () => {
    const widget = new WidgetSfGoal(item("sf-goal"), makeContext("pixel"));
    widget.mount(makeEl("div"));
    expect(widget.canvas).toBeNull();
    expect(raf.pending()).toBe(0);
    widget.unmount();
  });
});

describe("WidgetSfChat", () => {
  test("монтируется и рисует сообщения", () => {
    const context = makeContext("sf");
    const widget = new WidgetSfChat(item("sf-chat"), context);
    widget.mount(makeEl("div"));

    expect(widget.frameEl).toBeTruthy();
    expect(widget.element.classList.contains("sf-surface")).toBe(true);

    context.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "bob", message: "hi", badges: [] });
    expect(widget.messagesInner.children).toHaveLength(1);
    expect(widget.messagesInner.children[0].innerHTML).toContain("bob");
    expect(widget.cylEl.classList.contains("is-firing")).toBe(true);

    widget.unmount();
  });

  test("держит лимит строк maxMessages", () => {
    const context = makeContext("sf");
    const widget = new WidgetSfChat(item("sf-chat", { config: { maxMessages: 2 } }), context);
    widget.mount(makeEl("div"));

    context.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "a", message: "1" });
    context.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "b", message: "2" });
    context.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "c", message: "3" });

    expect(widget.messagesInner.children).toHaveLength(2);
    widget.unmount();
  });

  test("не инициализируется на чужой теме", () => {
    const widget = new WidgetSfChat(item("sf-chat"), makeContext("wardogs"));
    widget.mount(makeEl("div"));
    expect(widget.frameEl).toBeNull();
    widget.unmount();
  });
});

describe("WidgetSfHoloAlert", () => {
  test("скрыт до алерта, затем показывает карточку", () => {
    const context = makeContext("sf");
    const widget = new WidgetSfHoloAlert(item("sf-holo-alert"), context);
    widget.mount(makeEl("div"));

    expect(widget.host).toBeTruthy();
    expect(widget.element.style.opacity).toBe("0");

    context.bus.emit(EVENT_TYPES.ALERT, { kind: "follow", user: "bob", durationMs: 5000 });
    expect(widget.element.style.opacity).toBe("1");
    expect(widget.host.children).toHaveLength(1);
    expect(widget.host.children[0].innerHTML).toContain("bob");
    expect(widget.host.children[0].innerHTML).toContain("DASH");

    widget.unmount();
    expect(widget.host).toBeNull();
  });

  test("не инициализируется на чужой теме", () => {
    const widget = new WidgetSfHoloAlert(item("sf-holo-alert"), makeContext("nebula"));
    widget.mount(makeEl("div"));
    expect(widget.host).toBeNull();
    widget.unmount();
  });
});

describe("WidgetManager — изоляция виджетов Super Four", () => {
  test("не создаёт sf-виджеты, пока тема не sf", () => {
    const root = makeEl("div");
    const context = makeContext("pixel");
    const manager = new WidgetManager(root, {
      shouldMount: (inst) => (!inst.type.startsWith("sf-") ? true : context.theme === "sf"),
      resolveRenderType: (inst) => (inst.type === "sf-tachometer" ? "canvas" : "2d"),
      context,
    });
    manager.register("sf-tachometer", WidgetSfTachometer);
    manager.register("sf-goal", WidgetSfGoal);
    manager.register("sf-chat", WidgetSfChat);
    manager.register("sf-holo-alert", WidgetSfHoloAlert);

    const layout = [
      item("sf-tachometer", { renderType: "canvas" }),
      item("sf-goal"),
      item("sf-chat"),
      item("sf-holo-alert"),
    ];

    manager.syncLayout(layout);
    expect(manager.size).toBe(0);

    context.theme = "sf";
    manager.syncLayout(layout);
    expect(manager.size).toBe(4);

    context.theme = "retrowave";
    manager.syncLayout(layout);
    expect(manager.size).toBe(0);
  });
});
