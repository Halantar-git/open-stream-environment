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
const WidgetGrimHexChat = require("../overlay/widgets/grimhex-chat-widget");
const WidgetManager = require("../overlay/widgets/widget-manager");

function makeCtx2D() {
  const ctx = {};
  ["setTransform", "clearRect", "save", "restore", "translate", "rotate", "transform", "scale", "beginPath", "moveTo", "lineTo", "closePath", "stroke", "fill", "fillRect", "drawImage"].forEach(
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
    width: 0,
    height: 0,
    clientWidth: 320,
    clientHeight: 160,
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
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    renderEmotes: (m) => String(m),
    readCssVar: () => "",
  };
}

function item(overrides = {}) {
  return { id: "c", type: "grimhex-chat", x: 0, y: 0, w: 20, h: 20, z: 0, visible: true, config: {}, renderType: "2d", ...overrides };
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

describe("WidgetGrimHexChat", () => {
  test("монтируется и создаёт контейнер сообщений для grimhex", () => {
    const parent = makeEl("div");
    const w = new WidgetGrimHexChat(item(), makeContext("grimhex"));

    w.mount(parent);
    expect(raf.pending()).toBe(0); // no render loop
    expect(w.canvas).toBeNull();
    expect(w.messagesEl).toBeTruthy();
    expect(w.messagesScroller).toBeTruthy();
    expect(w.messagesInner).toBeTruthy();

    w.unmount();
    expect(raf.pending()).toBe(0);
  });

  test("не инициализируется на чужой теме (уровень виджета)", () => {
    const parent = makeEl("div");
    const w = new WidgetGrimHexChat(item(), makeContext("nebula"));

    w.mount(parent);
    expect(raf.pending()).toBe(0);
    expect(w.canvas).toBeNull();
    expect(w.messagesEl).toBeNull();
    w.unmount();
  });

  test("pushMessage добавляет строку", () => {
    const ctx = makeContext("grimhex");
    const parent = makeEl("div");
    const w = new WidgetGrimHexChat(item(), ctx);
    w.mount(parent);

    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "bob", message: "hi", badges: [] });

    expect(w.messagesInner.children.length).toBe(1);
    w.unmount();
  });

  test("ограничивает число сообщений до 50", () => {
    const ctx = makeContext("grimhex");
    const parent = makeEl("div");
    const w = new WidgetGrimHexChat(item(), ctx);
    w.mount(parent);

    for (let i = 0; i < 55; i++) {
      ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "u" + i, message: "m", badges: [] });
    }

    expect(w.messagesInner.children.length).toBe(50);
    w.unmount();
  });
});

describe("WidgetManager — изоляция grimhex-chat", () => {
  test("не создаёт grimhex-chat, пока тема не grimhex", () => {
    const root = makeEl("div");
    const context = { bus: new EventBus(), EVENT_TYPES, theme: "nebula" };
    const mgr = new WidgetManager(root, {
      shouldMount: (it) => (it.type !== "grimhex-chat" ? true : context.theme === "grimhex"),
      resolveRenderType: (it) => (it.type === "grimhex-chat" && context.theme === "grimhex" ? "2d" : "2d"),
      context,
    });
    mgr.register("grimhex-chat", WidgetGrimHexChat);

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
