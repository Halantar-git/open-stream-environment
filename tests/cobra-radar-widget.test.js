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
const WidgetCobraRadar = require("../overlay/widgets/cobra-radar-widget");

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

function radarItem(id = "r") {
  return { id, type: "cobra-radar", x: 0, y: 0, w: 16, h: 24, z: 0, visible: true, config: {} };
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

describe("WidgetCobraRadar", () => {
  test("запускает цикл и рисует только для темы cobra-mk2", () => {
    const parent = makeEl("div");
    const w = new WidgetCobraRadar({ ...radarItem(), renderType: "canvas" }, makeContext("cobra-mk2"));

    w.mount(parent);
    expect(w.renderType).toBe("canvas");
    expect(w.element.tagName).toBe("CANVAS");
    expect(raf.pending()).toBe(1); // 30 FPS loop started

    raf.flush(1000); // one frame
    expect(w.element._ctx.stroke).toHaveBeenCalled(); // radar disc drawn

    w.unmount();
    expect(raf.pending()).toBe(0); // loop stopped, 0% GPU
  });

  test("не запускает цикл на чужой теме (уровень виджета)", () => {
    const parent = makeEl("div");
    const w = new WidgetCobraRadar({ ...radarItem(), renderType: "canvas" }, makeContext("nebula"));

    w.mount(parent);
    expect(raf.pending()).toBe(0); // onMount вернулся раньше — цикла нет
    w.unmount();
  });

  test("донат порождает контакт-корабль, остальные алерты — нет", () => {
    const ctx = makeContext("cobra-mk2");
    const parent = makeEl("div");
    const w = new WidgetCobraRadar({ ...radarItem(), renderType: "canvas" }, ctx);
    w.mount(parent);

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "follow" });
    expect(w._contacts).toHaveLength(0);

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "donation", amount: 250, durationMs: 7000 });
    expect(w._contacts).toHaveLength(1);
    expect(w._contacts[0].hostile).toBe(false); // regular ship -> triangle

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "donation", amount: 1500, durationMs: 7000 });
    expect(w._contacts).toHaveLength(2);
    expect(w._contacts[1].hostile).toBe(true); // large target -> square

    w.unmount();
  });

  test("ограничивает число одновременных контактов (защита от перегрузки)", () => {
    const ctx = makeContext("cobra-mk2");
    const parent = makeEl("div");
    const w = new WidgetCobraRadar({ ...radarItem(), renderType: "canvas" }, ctx);
    w.mount(parent);

    for (let i = 0; i < 40; i++) {
      ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "donation", amount: 100, durationMs: 7000 });
    }
    // Старые корабли вытесняются новыми — массив не растёт бесконечно.
    expect(w._contacts.length).toBeLessThanOrEqual(24);
    expect(w._contacts.length).toBe(24);

    w.unmount();
  });

  test("применяет настройку прозрачности", () => {
    const parent = makeEl("div");
    const w = new WidgetCobraRadar({ ...radarItem(), config: { opacity: 25 }, renderType: "canvas" }, makeContext("cobra-mk2"));

    w.mount(parent);
    expect(w.element.style.opacity).toBe("0.25");
    w.unmount();
  });
});
