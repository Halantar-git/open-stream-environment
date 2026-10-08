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
const WidgetWardogsChat = require("../overlay/widgets/wardogs-chat-widget");
const WidgetWardogsHoloAlert = require("../overlay/widgets/wardogs-holo-alert-widget");
const WidgetManager = require("../overlay/widgets/widget-manager");

// ---- minimal mock ----

function makeEl(tag) {
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
    clientWidth: 320,
    clientHeight: 160,
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
    getContext() { return null; },
    addEventListener(t, fn, o) { listeners.push({ t, fn, o }); },
    removeEventListener(t, fn) { for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].fn === fn) listeners.splice(i, 1); },
  };
  Object.defineProperty(el, "firstChild", { get() { return this.children[0] || null; }, configurable: true });
  return el;
}

function makeContext(theme) {
  return {
    bus: new EventBus(),
    EVENT_TYPES,
    theme,
    readCssVar: () => "",
    t: (k) => k,
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    renderEmotes: (m) => m,
    formatMoney: (n) => String(n || 0),
    currencySymbol: (c) => c || "",
    ICONS: { follow: "<svg></svg>", donation: "<svg></svg>" },
  };
}

function chatItem(overrides = {}) {
  return { id: "wc", type: "wardogs-chat", x: 0, y: 0, w: 20, h: 30, z: 0, visible: true, config: {}, renderType: "2d", ...overrides };
}

function holoItem(overrides = {}) {
  return { id: "wh", type: "wardogs-holo-alert", x: 0, y: 0, w: 26, h: 14, z: 0, visible: true, config: {}, renderType: "2d", ...overrides };
}

let originalGlobals;

beforeEach(() => {
  originalGlobals = {
    document: global.document,
    window: global.window,
    performance: global.performance,
  };
  global.document = { createElement: (tag) => makeEl(tag) };
  global.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  global.performance = { now: () => 0 };
});

afterEach(() => {
  global.document = originalGlobals.document;
  global.window = originalGlobals.window;
  global.performance = originalGlobals.performance;
});

describe("WidgetWardogsChat", () => {
  test("монтируется и рисует сообщения (wardogs)", () => {
    const ctx = makeContext("wardogs");
    const parent = makeEl("div");
    const w = new WidgetWardogsChat(chatItem(), ctx);

    w.mount(parent);
    expect(w.frameEl).toBeTruthy();
    expect(w.messagesInner).toBeTruthy();
    expect(w.element.classList.contains("wardogs-chat-surface")).toBe(true);

    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "bob", message: "hi", badges: [] });
    expect(w.messagesInner.children).toHaveLength(1);
    expect(w.messagesInner.children[0].innerHTML).toContain("bob");

    w.unmount();
  });

  test("держит лимит строк maxMessages", () => {
    const ctx = makeContext("wardogs");
    const parent = makeEl("div");
    const w = new WidgetWardogsChat(chatItem({ config: { maxMessages: 2 } }), ctx);
    w.mount(parent);

    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "a", message: "1" });
    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "b", message: "2" });
    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "c", message: "3" });

    expect(w.messagesInner.children).toHaveLength(2);
    w.unmount();
  });

  test("не инициализируется на чужой теме", () => {
    const parent = makeEl("div");
    const w = new WidgetWardogsChat(chatItem(), makeContext("cobra-mk2"));

    w.mount(parent);
    expect(w.frameEl).toBeNull();
    expect(w.messagesInner).toBeNull();
    w.unmount();
  });
});

describe("WidgetWardogsHoloAlert", () => {
  test("скрыт до алерта, затем показывает карточку (wardogs)", () => {
    const ctx = makeContext("wardogs");
    const parent = makeEl("div");
    const w = new WidgetWardogsHoloAlert(holoItem(), ctx);

    w.mount(parent);
    expect(w.host).toBeTruthy();
    expect(w.element.style.opacity).toBe("0");

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "follow", user: "bob", durationMs: 5000 });
    expect(w.element.style.opacity).toBe("1");
    expect(w.host.children).toHaveLength(1);
    expect(w.host.children[0].innerHTML).toContain("bob");

    w.unmount();
    expect(w.host).toBeNull();
  });

  test("не инициализируется на чужой теме", () => {
    const parent = makeEl("div");
    const w = new WidgetWardogsHoloAlert(holoItem(), makeContext("nebula"));

    w.mount(parent);
    expect(w.host).toBeNull();
    w.unmount();
  });
});

describe("WidgetManager — изоляция Wardogs-виджетов", () => {
  test("не создаёт wardogs-chat/holo, пока тема не wardogs", () => {
    const root = makeEl("div");
    const context = makeContext("cobra-mk2");
    const mgr = new WidgetManager(root, {
      shouldMount: (it) => (!it.type.startsWith("wardogs-") ? true : context.theme === "wardogs"),
      resolveRenderType: () => "2d",
      context,
    });
    mgr.register("wardogs-chat", WidgetWardogsChat);
    mgr.register("wardogs-holo-alert", WidgetWardogsHoloAlert);

    mgr.syncLayout([chatItem(), holoItem()]);
    expect(mgr.size).toBe(0);

    context.theme = "wardogs";
    mgr.syncLayout([chatItem(), holoItem()]);
    expect(mgr.size).toBe(2);

    context.theme = "teso-seal";
    mgr.syncLayout([chatItem(), holoItem()]);
    expect(mgr.size).toBe(0);
  });
});
