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
const WidgetGrimHexGoal = require("../overlay/widgets/grimhex-goal-widget");
const WidgetManager = require("../overlay/widgets/widget-manager");

function makeCtx2D() {
  const ctx = {};
  ["setTransform", "clearRect", "save", "restore", "translate", "beginPath", "moveTo", "lineTo", "rect", "roundRect", "fill", "fillRect", "stroke"].forEach(
    (m) => (ctx[m] = jest.fn())
  );
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
    parentNode: null,
    children: [],
    isConnected: true,
    scrollTop: 0,
    scrollHeight: 0,
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
    t: (k) => k,
  };
}

function item(overrides = {}) {
  return { id: "g", type: "grimhex-goal", x: 0, y: 0, w: 20, h: 6, z: 0, visible: true, config: {}, renderType: "2d", ...overrides };
}

let raf;
let originalGlobals;

beforeEach(() => {
  raf = createRaf();
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
  global.performance = { now: () => 0 };
});

afterEach(() => {
  global.document = originalGlobals.document;
  global.window = originalGlobals.window;
  global.requestAnimationFrame = originalGlobals.requestAnimationFrame;
  global.cancelAnimationFrame = originalGlobals.cancelAnimationFrame;
  global.performance = originalGlobals.performance;
});

describe("WidgetGrimHexGoal", () => {
  test("монтируется, создаёт canvas + контент и запускает цикл для grimhex", () => {
    const parent = makeEl("div");
    const w = new WidgetGrimHexGoal(item(), makeContext("grimhex"));

    w.mount(parent);
    expect(raf.pending()).toBe(1); // 30 FPS loop
    expect(w.canvas).toBeTruthy();
    expect(w.ctx).toBeTruthy();
    expect(w.layoutEl).toBeTruthy();
    expect(w.contentEl).toBeTruthy();
    expect(w.barWrap).toBeTruthy();

    raf.flush(1000); // one frame
    expect(w.ctx.roundRect).toHaveBeenCalled(); // tube drawn

    w.unmount();
    expect(raf.pending()).toBe(0);
  });

  test("не инициализируется на чужой теме (уровень виджета)", () => {
    const parent = makeEl("div");
    const w = new WidgetGrimHexGoal(item(), makeContext("nebula"));

    w.mount(parent);
    expect(raf.pending()).toBe(0);
    expect(w.canvas).toBeNull();
    expect(w.contentEl).toBeNull();
    w.unmount();
  });

  test("обновляет прогресс и контент по GOAL_UPDATE", () => {
    const ctx = makeContext("grimhex");
    const parent = makeEl("div");
    const w = new WidgetGrimHexGoal(item(), ctx);
    w.mount(parent);

    expect(w.contentEl.innerHTML).toContain("Цель");
    expect(w.contentEl.innerHTML).toContain("50");
    expect(w._pct).toBe(50); // 50 / 100

    ctx.state.goal = { title: "Новая цель", current: 75, target: 100, currency: "USD" };
    ctx.bus.emit(EVENT_TYPES.GOAL_UPDATE, ctx.state.goal);

    expect(w._pct).toBe(75);
    expect(w.contentEl.innerHTML).toContain("Новая цель");
    expect(w.contentEl.innerHTML).toContain("75");
    w.unmount();
  });

  test("не подписывается на чат (не реагирует на сообщения)", () => {
    const ctx = makeContext("grimhex");
    const parent = makeEl("div");
    const w = new WidgetGrimHexGoal(item(), ctx);
    w.mount(parent);

    const channels = w._subs.map((s) => s.channel);
    expect(channels).toContain(EVENT_TYPES.GOAL_UPDATE);
    expect(channels).toContain(EVENT_TYPES.LOCALES);
    expect(channels).not.toContain(EVENT_TYPES.CHAT_MESSAGE);
    expect(channels).not.toContain(EVENT_TYPES.ALERT);
    w.unmount();
  });
});

describe("WidgetManager — изоляция grimhex-goal", () => {
  test("не создаёт grimhex-goal, пока тема не grimhex", () => {
    const root = makeEl("div");
    const context = {
      bus: new EventBus(),
      EVENT_TYPES,
      theme: "nebula",
      state: { goal: { title: "Цель", current: 0, target: 1, currency: "RUB" } },
      escapeHtml: (s) => String(s),
      escapeAttr: (s) => String(s),
      formatMoney: (n) => String(n),
      currencySymbol: (c) => String(c),
      t: (k) => k,
    };
    const mgr = new WidgetManager(root, {
      shouldMount: (it) => (it.type !== "grimhex-goal" ? true : context.theme === "grimhex"),
      resolveRenderType: () => "2d",
      context,
    });
    mgr.register("grimhex-goal", WidgetGrimHexGoal);

    mgr.syncLayout([item()]);
    expect(mgr.size).toBe(0);

    context.theme = "grimhex";
    mgr.syncLayout([item()]);
    expect(mgr.size).toBe(1);

    context.theme = "pixel";
    mgr.syncLayout([item()]);
    expect(mgr.size).toBe(0);
  });
});
