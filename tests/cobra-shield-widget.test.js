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
const WidgetCobraShield = require("../overlay/widgets/cobra-shield-widget");

// ---- minimal mock ----

function makeCtx2D() {
  const ctx = {};
  ["setTransform", "clearRect", "save", "restore", "translate", "scale", "beginPath", "moveTo", "lineTo", "closePath", "stroke", "fill", "fillRect", "arc", "fillText"].forEach(
    (m) => (ctx[m] = jest.fn())
  );
  ctx.measureText = jest.fn(() => ({ width: 0 }));
  return ctx;
}

function makeEl(tag) {
  const isCanvas = tag === "canvas";
  const ctx2d = isCanvas ? makeCtx2D() : null;
  const listeners = [];
  const el = {
    tagName: (tag || "div").toUpperCase(),
    className: "",
    dataset: {},
    style: { setProperty(k, v) { this[k] = v; } },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    width: 0,
    height: 0,
    clientWidth: 320,
    clientHeight: 180,
    parentNode: null,
    children: [],
    isConnected: true,
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    querySelector() { return null; },
    getContext(t) { return isCanvas ? (t === "2d" ? ctx2d : null) : null; },
    addEventListener() {},
    removeEventListener() {},
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
    state: { goal: { current: 500, target: 1000, currency: "RUB" } },
    formatMoney: (n) => String(n),
    currencySymbol: (c) => (c === "RUB" ? "₽" : c),
  };
}

function shieldItem(id = "s") {
  return { id, type: "cobra-shield", x: 0, y: 0, w: 20, h: 28, z: 0, visible: true, config: {} };
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

describe("WidgetCobraShield", () => {
  test("запускает цикл и рисует только для темы cobra-mk2", () => {
    const parent = makeEl("div");
    const w = new WidgetCobraShield({ ...shieldItem(), renderType: "canvas" }, makeContext("cobra-mk2"));

    w.mount(parent);
    expect(w.renderType).toBe("canvas");
    expect(w.element.tagName).toBe("CANVAS");
    expect(raf.pending()).toBe(1); // 30 FPS loop started

    raf.flush(1000); // one frame
    expect(w.element._ctx.stroke).toHaveBeenCalled(); // ship outline drawn

    w.unmount();
    expect(raf.pending()).toBe(0); // loop stopped, 0% GPU
  });

  test("не запускает цикл на чужой теме (уровень виджета)", () => {
    const parent = makeEl("div");
    const w = new WidgetCobraShield({ ...shieldItem(), renderType: "canvas" }, makeContext("nebula"));

    w.mount(parent);
    expect(raf.pending()).toBe(0); // onMount вернулся раньше — цикла нет
    w.unmount();
  });

  test("читает цель из состояния и пульсирует при донате", () => {
    const ctx = makeContext("cobra-mk2");
    const parent = makeEl("div");
    const w = new WidgetCobraShield({ ...shieldItem(), renderType: "canvas" }, ctx);
    w.mount(parent);

    expect(w._pct).toBeCloseTo(0.5, 5);
    expect(w._goalText).toContain("500");
    expect(w._goalText).toContain("1000");

    expect(w._pulsing).toBe(false);
    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "donation" });
    expect(w._pulsing).toBe(true);

    w.unmount();
  });

  test("применяет настройку прозрачности", () => {
    const parent = makeEl("div");
    const w = new WidgetCobraShield({ ...shieldItem(), config: { opacity: 50 }, renderType: "canvas" }, makeContext("cobra-mk2"));

    w.mount(parent);
    expect(w.element.style.opacity).toBe("0.5");
    w.unmount();
  });
});
