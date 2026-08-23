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
const WidgetCobra = require("../overlay/widgets/cobra-widget");
const WidgetManager = require("../overlay/widgets/widget-manager");

// ---- minimal mock ----

function makeCtx2D() {
  const ctx = {};
  ["setTransform", "clearRect", "save", "restore", "translate", "rotate", "scale", "beginPath", "moveTo", "lineTo", "closePath", "stroke", "fill", "drawImage"].forEach(
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
    width: 0,
    height: 0,
    clientWidth: 320,
    clientHeight: 160,
    parentNode: null,
    children: [],
    isConnected: true,
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
  return { bus: new EventBus(), EVENT_TYPES, theme };
}

function cobraItem(id = "c") {
  return { id, type: "cobra", x: 0, y: 0, w: 20, h: 10, z: 0, visible: true, config: {} };
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
    Path2D: global.Path2D,
  };
  global.document = { createElement: (tag) => makeEl(tag) };
  global.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  global.requestAnimationFrame = raf.request;
  global.cancelAnimationFrame = raf.cancel;
  global.performance = { now: () => 0 };
  global.Path2D = function (d) { this.d = d; };
});

afterEach(() => {
  global.document = originalGlobals.document;
  global.window = originalGlobals.window;
  global.requestAnimationFrame = originalGlobals.requestAnimationFrame;
  global.cancelAnimationFrame = originalGlobals.cancelAnimationFrame;
  global.performance = originalGlobals.performance;
  global.Path2D = originalGlobals.Path2D;
});

describe("WidgetCobra", () => {
  test("запускает цикл и рисует только для темы cobra-mk2", () => {
    const parent = makeEl("div");
    const w = new WidgetCobra({ ...cobraItem(), renderType: "canvas" }, makeContext("cobra-mk2"));

    w.mount(parent);
    expect(w.renderType).toBe("canvas");
    expect(w.element.tagName).toBe("CANVAS");
    expect(raf.pending()).toBe(1); // 30 FPS loop started

    raf.flush(1000); // one frame
    expect(w.element._ctx.fill).toHaveBeenCalled();

    w.unmount();
    expect(raf.pending()).toBe(0); // loop stopped, 0% GPU
  });

  test("не запускает цикл на чужой теме (уровень виджета)", () => {
    const parent = makeEl("div");
    const w = new WidgetCobra({ ...cobraItem(), renderType: "canvas" }, makeContext("nebula"));

    w.mount(parent);
    expect(raf.pending()).toBe(0); // onMount вернулся раньше — цикла нет
    w.unmount();
  });

  test("glitch активируется по событию чата/доната", () => {
    const ctx = makeContext("cobra-mk2");
    const parent = makeEl("div");
    const w = new WidgetCobra({ ...cobraItem(), renderType: "canvas" }, ctx);
    w.mount(parent);

    expect(w._glitchUntil).toBe(0);
    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "x", message: "hi" });
    expect(w._glitchUntil).toBeGreaterThan(0);

    w.unmount();
  });
});

describe("WidgetManager — изоляция Cobra", () => {
  test("не создаёт cobra виджет, пока тема не cobra-mk2", () => {
    const root = makeEl("div");
    const context = { bus: new EventBus(), EVENT_TYPES, theme: "nebula" };
    const mgr = new WidgetManager(root, {
      shouldMount: (item) => item.type !== "cobra" || context.theme === "cobra-mk2",
      resolveRenderType: (item) => (item.type === "cobra" && context.theme === "cobra-mk2" ? "canvas" : "2d"),
      context,
    });
    mgr.register("cobra", WidgetCobra);

    mgr.syncLayout([cobraItem()]);
    expect(mgr.size).toBe(0); // пропущен

    context.theme = "cobra-mk2";
    mgr.syncLayout([cobraItem()]);
    expect(mgr.size).toBe(1);
    expect(mgr.get("c").theme).toBe("cobra-mk2");
    expect(mgr.get("c").renderType).toBe("canvas");

    // обратно на лёгкую тему — виджет демонтируется
    context.theme = "pixel";
    mgr.syncLayout([cobraItem()]);
    expect(mgr.size).toBe(0);
    expect(root.children).toHaveLength(0);
  });
});
