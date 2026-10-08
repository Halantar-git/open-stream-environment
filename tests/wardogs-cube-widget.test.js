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
const WidgetWardogsCube = require("../overlay/widgets/wardogs-cube-widget");
const WidgetManager = require("../overlay/widgets/widget-manager");

function makeCtx2D() {
  const ctx = {};
  ["setTransform", "transform", "rotate", "clearRect", "save", "restore", "beginPath", "moveTo", "lineTo", "stroke", "drawImage", "fillRect"].forEach(
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
  return { bus: new EventBus(), EVENT_TYPES, theme, readCssVar: () => "" };
}

function cubeItem(overrides = {}) {
  return { id: "cube", type: "wardogs-cube", x: 0, y: 0, w: 24, h: 16, z: 0, visible: true, config: {}, renderType: "canvas", ...overrides };
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

describe("WidgetWardogsCube", () => {
  test("скрыт до первого алерта и появляется на нём", () => {
    const ctx = makeContext("wardogs");
    const parent = makeEl("div");
    const w = new WidgetWardogsCube(cubeItem(), ctx);

    w.mount(parent);
    expect(w.element.tagName).toBe("CANVAS");
    // Пока ничего не происходит — куба нет и цикл спит, как у Pixel.
    expect(w.element.style.opacity).toBe("0");
    expect(raf.pending()).toBe(0);

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "follow" });
    expect(w.element.style.opacity).toBe("1");
    expect(raf.pending()).toBe(1); // 20/30 FPS loop resumes

    raf.flush(1000); // one frame
    expect(w.element._ctx.clearRect).toHaveBeenCalled();

    w.unmount();
    expect(raf.pending()).toBe(0);
  });

  test("накладывает логотип на все шесть граней", () => {
    const originalImage = global.Image;
    global.Image = function () {
      return { src: "", complete: true, naturalWidth: 256 };
    };
    try {
      const ctx = makeContext("wardogs");
      const w = new WidgetWardogsCube(cubeItem(), ctx);
      w.mount(makeEl("div"));

      // Кадр при монтировании не считаем: интересует кадр алерта.
      w.element._ctx.drawImage.mockClear();
      w.element._ctx.fillRect.mockClear();
      w.element._ctx.rotate.mockClear();
      ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "follow" });
      raf.flush(1000);
      // Каркаса нет: куб плотный — у каждой из шести граней подложка и логотип.
      expect(w.element._ctx.stroke).not.toHaveBeenCalled();
      expect(w.element._ctx.fillRect).toHaveBeenCalledTimes(6);
      expect(w.element._ctx.drawImage).toHaveBeenCalledTimes(6);
      // У верхней и нижней грани логотип доворачивается против спина.
      expect(w.element._ctx.rotate).toHaveBeenCalledTimes(2);

      w.unmount();
    } finally {
      global.Image = originalImage;
    }
  });

  test("куб вращается, а не плавает по холсту", () => {
    const ctx = makeContext("wardogs");
    const w = new WidgetWardogsCube(cubeItem(), ctx);
    w.mount(makeEl("div"));
    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "follow" });

    // Матрицы граней — это и есть поворот куба.
    const faceTransforms = () => w.element._ctx.transform.mock.calls.map((call) => call[0]);

    clock = 0;
    raf.flush(0);
    const before = faceTransforms();

    w.element._ctx.transform.mockClear();
    clock = 500;
    raf.flush(500);
    expect(faceTransforms()).not.toEqual(before);

    w.unmount();
  });

  test("не запускает цикл на чужой теме", () => {
    const parent = makeEl("div");
    const w = new WidgetWardogsCube(cubeItem(), makeContext("pixel"));

    w.mount(parent);
    expect(raf.pending()).toBe(0);
    w.unmount();
  });

  test("реагирует на алерты «попом» (сильнее на донат)", () => {
    const ctx = makeContext("wardogs");
    const parent = makeEl("div");
    const w = new WidgetWardogsCube(cubeItem(), ctx);
    w.mount(parent);

    expect(w._popUntil).toBe(0);
    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "follow" });
    expect(w._popUntil).toBeGreaterThan(0);
    expect(w._popAmp).toBeCloseTo(0.08);

    // Алерты идут по очереди: донатный всплывает, когда прошёл предыдущий.
    clock = w._visibleUntil + 1;
    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "donation" });
    expect(w._popAmp).toBeCloseTo(0.16);

    w.unmount();
  });
});

describe("WidgetManager — изоляция wardogs-cube", () => {
  test("не создаёт wardogs-cube, пока тема не wardogs", () => {
    const root = makeEl("div");
    const context = makeContext("pixel");
    const mgr = new WidgetManager(root, {
      shouldMount: (item) => item.type !== "wardogs-cube" || context.theme === "wardogs",
      resolveRenderType: (item) => (item.type === "wardogs-cube" && context.theme === "wardogs" ? "canvas" : "2d"),
      context,
    });
    mgr.register("wardogs-cube", WidgetWardogsCube);

    mgr.syncLayout([cubeItem()]);
    expect(mgr.size).toBe(0);

    context.theme = "wardogs";
    mgr.syncLayout([cubeItem()]);
    expect(mgr.size).toBe(1);

    context.theme = "nebula";
    mgr.syncLayout([cubeItem()]);
    expect(mgr.size).toBe(0);
  });
});
