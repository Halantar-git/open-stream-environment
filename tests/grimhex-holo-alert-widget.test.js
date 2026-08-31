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
const WidgetGrimHexHoloAlert = require("../overlay/widgets/grimhex-holo-alert-widget");
const WidgetManager = require("../overlay/widgets/widget-manager");

function makeCtx2D() {
  const ctx = {};
  ["setTransform", "clearRect", "save", "restore", "translate", "scale", "beginPath", "moveTo", "lineTo", "bezierCurveTo", "closePath", "rect", "arc", "fillRect", "fill", "stroke", "drawImage"].forEach(
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
    clientHeight: 140,
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
  return {
    bus: new EventBus(),
    EVENT_TYPES,
    theme,
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    formatMoney: (n) => String(n),
    currencySymbol: (c) => String(c),
    t: (k) => k,
    ICONS: { follow: "<svg/>", sub: "<svg/>", gift_sub: "<svg/>", cheer: "<svg/>", donation: "<svg/>" },
    readCssVar: () => "",
    audio: { playWinSound: jest.fn(), playEliminationAudio: jest.fn() },
  };
}

function item(overrides = {}) {
  return { id: "h", type: "grimhex-holo-alert", x: 0, y: 0, w: 26, h: 14, z: 0, visible: true, config: {}, renderType: "2d", ...overrides };
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

describe("WidgetGrimHexHoloAlert", () => {
  test("монтируется в режиме ожидания и запускает цикл только для grimhex", () => {
    const parent = makeEl("div");
    const w = new WidgetGrimHexHoloAlert(item(), makeContext("grimhex"));

    w.mount(parent);
    expect(w.canvas).toBeTruthy();
    expect(w.ctx).toBeTruthy();
    expect(w.contentEl).toBeTruthy();
    expect(raf.pending()).toBe(0); // idle: no alert yet
    expect(w.element.style.opacity).toBe("0");

    w.unmount();
    expect(raf.pending()).toBe(0);
  });

  test("не инициализируется на чужой теме (уровень виджета)", () => {
    const parent = makeEl("div");
    const w = new WidgetGrimHexHoloAlert(item(), makeContext("nebula"));

    w.mount(parent);
    expect(w.canvas).toBeNull();
    expect(w.contentEl).toBeNull();
    w.unmount();
  });

  test("показывает алерт, включает цикл и спавнит частицы", () => {
    const ctx = makeContext("grimhex");
    const parent = makeEl("div");
    const w = new WidgetGrimHexHoloAlert(item(), ctx);
    w.mount(parent);

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "follow", user: "bob" });

    expect(w.current).toBeTruthy();
    expect(w.contentEl.innerHTML).toContain("bob");
    expect(w.element.style.opacity).toBe("1");
    expect(w._particles.length).toBeGreaterThan(0);
    expect(raf.pending()).toBe(1); // loop resumed

    w.unmount();
    expect(raf.pending()).toBe(0);
  });
});

describe("WidgetManager — изоляция grimhex-holo-alert", () => {
  test("не создаёт grimhex-holo-alert, пока тема не grimhex", () => {
    const root = makeEl("div");
    const context = {
      bus: new EventBus(),
      EVENT_TYPES,
      theme: "nebula",
      escapeHtml: (s) => String(s),
      escapeAttr: (s) => String(s),
      formatMoney: (n) => String(n),
      currencySymbol: (c) => String(c),
      t: (k) => k,
      ICONS: {},
      readCssVar: () => "",
      audio: { playWinSound: jest.fn(), playEliminationAudio: jest.fn() },
    };
    const mgr = new WidgetManager(root, {
      shouldMount: (it) => (it.type !== "grimhex-holo-alert" ? true : context.theme === "grimhex"),
      resolveRenderType: () => "2d",
      context,
    });
    mgr.register("grimhex-holo-alert", WidgetGrimHexHoloAlert);

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
