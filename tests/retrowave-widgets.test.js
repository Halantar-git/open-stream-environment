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
const WidgetRetrowaveGoal = require("../overlay/widgets/retrowave-goal-widget");
const WidgetRetrowaveChat = require("../overlay/widgets/retrowave-chat-widget");
const WidgetRetrowaveHoloAlert = require("../overlay/widgets/retrowave-holo-alert-widget");
const WidgetRetrowaveSymbol = require("../overlay/widgets/retrowave-symbol-widget");
const WidgetManager = require("../overlay/widgets/widget-manager");

// ---- minimal mocks ----

function makeCtx2D() {
  const gradient = { addColorStop: jest.fn() };
  const ctx = {
    createLinearGradient: jest.fn(() => gradient),
    createRadialGradient: jest.fn(() => gradient),
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
  ].forEach((m) => (ctx[m] = jest.fn()));
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
    style: { setProperty(k, v) { this[k] = v; } },
    classList: {
      add: (...c) => c.forEach((x) => classSet.add(x)),
      remove: (...c) => c.forEach((x) => classSet.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !classSet.has(c) : f; if (on) classSet.add(c); else classSet.delete(c); return on; },
      contains: (c) => classSet.has(c),
    },
    innerHTML: "",
    textContent: "",
    width: 0,
    height: 0,
    clientWidth: 320,
    clientHeight: 80,
    offsetHeight: 0,
    scrollTop: 0,
    scrollHeight: 0,
    parentNode: null,
    children: [],
    isConnected: true,
    animate: jest.fn(),
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    querySelector() { return null; },
    getContext(t) { return isCanvas ? (t === "2d" ? ctx2d : null) : null; },
    addEventListener(t, fn, o) { listeners.push({ t, fn, o }); },
    removeEventListener(t, fn) { for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].fn === fn) listeners.splice(i, 1); },
    _ctx: ctx2d,
  };
  Object.defineProperty(el, "firstChild", { get() { return this.children[0] || null; }, configurable: true });
  return el;
}

function createRaf() {
  let id = 0;
  const queue = [];
  return {
    request: (fn) => { const h = ++id; queue.push({ h, fn }); return h; },
    cancel: (h) => { for (let i = queue.length - 1; i >= 0; i--) if (queue[i].h === h) queue.splice(i, 1); },
    pending: () => queue.length,
    flush: (now) => queue.splice(0).forEach((p) => p.fn(now)),
  };
}

function makeContext(theme) {
  return {
    bus: new EventBus(),
    EVENT_TYPES,
    theme,
    state: { goal: { title: "Цель", current: 50, target: 100, currency: "RUB" } },
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    formatMoney: (n) => String(n),
    currencySymbol: (c) => String(c),
    renderEmotes: (m) => m,
    t: (k) => k,
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

describe("WidgetRetrowaveGoal", () => {
  test("монтируется, рисует шкалу и обновляет прогресс", () => {
    const ctx = makeContext("retrowave");
    const w = new WidgetRetrowaveGoal(item("retrowave-goal"), ctx);
    w.mount(makeEl("div"));

    expect(w.canvas).toBeTruthy();
    expect(w.layoutEl).toBeTruthy();
    expect(w.contentEl.innerHTML).toContain("Цель");
    expect(w._pct).toBe(50);
    expect(raf.pending()).toBe(1);

    raf.flush(1000);
    expect(w.ctx.fillRect).toHaveBeenCalled();

    ctx.state.goal = { title: "Новая", current: 75, target: 100, currency: "USD" };
    ctx.bus.emit(EVENT_TYPES.GOAL_UPDATE, ctx.state.goal);
    expect(w._pct).toBe(75);
    expect(w.contentEl.innerHTML).toContain("Новая");

    w.unmount();
    expect(raf.pending()).toBe(0);
  });

  test("не инициализируется на чужой теме", () => {
    const w = new WidgetRetrowaveGoal(item("retrowave-goal"), makeContext("pixel"));
    w.mount(makeEl("div"));
    expect(w.canvas).toBeNull();
    expect(raf.pending()).toBe(0);
    w.unmount();
  });

  test("подписан на цель и локали, но не на чат", () => {
    const w = new WidgetRetrowaveGoal(item("retrowave-goal"), makeContext("retrowave"));
    w.mount(makeEl("div"));
    const channels = w._subs.map((s) => s.channel);
    expect(channels).toContain(EVENT_TYPES.GOAL_UPDATE);
    expect(channels).toContain(EVENT_TYPES.LOCALES);
    expect(channels).not.toContain(EVENT_TYPES.CHAT_MESSAGE);
    w.unmount();
  });
});

describe("WidgetRetrowaveChat", () => {
  test("монтируется и рисует сообщения", () => {
    const ctx = makeContext("retrowave");
    const w = new WidgetRetrowaveChat(item("retrowave-chat"), ctx);
    w.mount(makeEl("div"));

    expect(w.frameEl).toBeTruthy();
    expect(w.element.classList.contains("retrowave-surface")).toBe(true);

    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "bob", message: "hi", badges: [] });
    expect(w.messagesInner.children).toHaveLength(1);
    expect(w.messagesInner.children[0].innerHTML).toContain("bob");

    w.unmount();
  });

  test("держит лимит строк maxMessages", () => {
    const ctx = makeContext("retrowave");
    const w = new WidgetRetrowaveChat(item("retrowave-chat", { config: { maxMessages: 2 } }), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "a", message: "1" });
    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "b", message: "2" });
    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "c", message: "3" });

    expect(w.messagesInner.children).toHaveLength(2);
    w.unmount();
  });

  test("не инициализируется на чужой теме", () => {
    const w = new WidgetRetrowaveChat(item("retrowave-chat"), makeContext("wardogs"));
    w.mount(makeEl("div"));
    expect(w.frameEl).toBeNull();
    w.unmount();
  });
});

describe("WidgetRetrowaveHoloAlert", () => {
  test("скрыт до алерта, затем показывает карточку", () => {
    const ctx = makeContext("retrowave");
    const w = new WidgetRetrowaveHoloAlert(item("retrowave-holo-alert"), ctx);
    w.mount(makeEl("div"));

    expect(w.host).toBeTruthy();
    expect(w.element.style.opacity).toBe("0");

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "follow", user: "bob", durationMs: 5000 });
    expect(w.element.style.opacity).toBe("1");
    expect(w.host.children).toHaveLength(1);
    expect(w.host.children[0].innerHTML).toContain("bob");
    expect(w.host.children[0].innerHTML).toContain("SIGNAL");

    w.unmount();
    expect(w.host).toBeNull();
  });

  test("не инициализируется на чужой теме", () => {
    const w = new WidgetRetrowaveHoloAlert(item("retrowave-holo-alert"), makeContext("nebula"));
    w.mount(makeEl("div"));
    expect(w.host).toBeNull();
    w.unmount();
  });
});

describe("WidgetRetrowaveSymbol", () => {
  const symbolItem = () => item("retrowave-symbol", { renderType: "canvas", w: 24, h: 16 });

  test("скрыт до алерта, затем появляется и запускает цикл", () => {
    const ctx = makeContext("retrowave");
    const w = new WidgetRetrowaveSymbol(symbolItem(), ctx);
    w.mount(makeEl("div"));

    expect(w.element.tagName).toBe("CANVAS");
    expect(w.element.style.opacity).toBe("0");
    expect(raf.pending()).toBe(0);

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "follow" });
    expect(w.element.style.opacity).toBe("1");
    expect(raf.pending()).toBe(1);

    raf.flush(1000);
    expect(w.ctx.clearRect).toHaveBeenCalled();
    expect(w.ctx.stroke).toHaveBeenCalled();

    w.unmount();
    expect(raf.pending()).toBe(0);
  });

  test("вращается: координаты сетки меняются от кадра к кадру", () => {
    const ctx = makeContext("retrowave");
    const w = new WidgetRetrowaveSymbol(symbolItem(), ctx);
    w.mount(makeEl("div"));
    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "follow" });

    const snapshot = () => w.ctx.lineTo.mock.calls.slice(0, 40).map((c) => `${c[0]},${c[1]}`).join(";");

    clock = 0;
    raf.flush(0);
    const before = snapshot();

    w.ctx.lineTo.mockClear();
    clock = 500;
    raf.flush(500);
    expect(snapshot()).not.toBe(before);

    w.unmount();
  });

  test("реагирует на донат сильнее, чем на фоллоу", () => {
    const ctx = makeContext("retrowave");
    const w = new WidgetRetrowaveSymbol(symbolItem(), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "follow" });
    expect(w._popAmp).toBeCloseTo(0.09);

    clock = w._visibleUntil + 1;
    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "donation" });
    expect(w._popAmp).toBeCloseTo(0.18);

    w.unmount();
  });

  test("держит иконку активного события для экватора", () => {
    const ctx = makeContext("retrowave");
    const w = new WidgetRetrowaveSymbol(symbolItem(), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "donation", durationMs: 5000 });
    expect(w._iconKind).toBe("donation");

    w.unmount();
    expect(w._iconKind).toBeNull();
  });

  test("не запускает цикл на чужой теме", () => {
    const w = new WidgetRetrowaveSymbol(symbolItem(), makeContext("pixel"));
    w.mount(makeEl("div"));
    expect(raf.pending()).toBe(0);
    w.unmount();
  });
});

describe("WidgetManager — изоляция Retrowave-виджетов", () => {
  test("не создаёт retrowave-виджеты, пока тема не retrowave", () => {
    const root = makeEl("div");
    const context = makeContext("pixel");
    const mgr = new WidgetManager(root, {
      shouldMount: (it) => (!it.type.startsWith("retrowave-") ? true : context.theme === "retrowave"),
      resolveRenderType: (it) => (it.type === "retrowave-symbol" ? "canvas" : "2d"),
      context,
    });
    mgr.register("retrowave-goal", WidgetRetrowaveGoal);
    mgr.register("retrowave-chat", WidgetRetrowaveChat);
    mgr.register("retrowave-holo-alert", WidgetRetrowaveHoloAlert);
    mgr.register("retrowave-symbol", WidgetRetrowaveSymbol);

    const layout = [
      item("retrowave-goal"),
      item("retrowave-chat"),
      item("retrowave-holo-alert"),
      item("retrowave-symbol", { renderType: "canvas" }),
    ];

    mgr.syncLayout(layout);
    expect(mgr.size).toBe(0);

    context.theme = "retrowave";
    mgr.syncLayout(layout);
    expect(mgr.size).toBe(4);

    context.theme = "nebula";
    mgr.syncLayout(layout);
    expect(mgr.size).toBe(0);
  });
});
