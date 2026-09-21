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
  «Макс. сообщений» у шести 3D-чатов.

  Раньше лимит был жёстко зашит в 50 и настройка инспектора ни на что не влияла.
  Здесь проверяем, что значение берётся из конфига, что мусор в конфиге не
  снимает лимит вовсе и что поведение одинаково у всех шести виджетов.
*/

const EventBus = require("../overlay/event-bus");
const { EVENT_TYPES } = require("../shared/events");

const WIDGETS = [
  { name: "grimhex-chat", theme: "grimhex", Widget: require("../overlay/widgets/grimhex-chat-widget") },
  { name: "nuclear-chat", theme: "nuclear", Widget: require("../overlay/widgets/nuclear-chat-widget") },
  { name: "cobra-chat", theme: "cobra-mk2", Widget: require("../overlay/widgets/cobra-chat-widget") },
  { name: "md3-chat", theme: "nebula", Widget: require("../overlay/widgets/md3-chat-widget") },
  { name: "pixel-chat", theme: "pixel", Widget: require("../overlay/widgets/pixel-chat-widget") },
  { name: "teso-chat", theme: "teso-seal", Widget: require("../overlay/widgets/teso-chat-widget") },
];

function makeEl(tag) {
  const listeners = [];
  const classSet = new Set();
  const el = {
    tagName: (tag || "div").toUpperCase(),
    className: "",
    dataset: {},
    style: { setProperty(k, v) { this[k] = v; } },
    innerHTML: "",
    textContent: "",
    id: "",
    offsetWidth: 0,
    clientWidth: 320,
    clientHeight: 160,
    scrollTop: 0,
    scrollHeight: 0,
    parentNode: null,
    children: [],
    isConnected: true,
    classList: {
      add: (...c) => c.forEach((x) => classSet.add(x)),
      remove: (...c) => c.forEach((x) => classSet.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !classSet.has(c) : f; if (on) classSet.add(c); else classSet.delete(c); return on; },
      contains: (c) => classSet.has(c),
    },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    querySelector() { return null; },
    getContext() { return null; },
    addEventListener(t, fn, o) { listeners.push({ t, fn, o }); },
    removeEventListener(t, fn) { for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].fn === fn) listeners.splice(i, 1); },
    _listeners: listeners,
  };
  Object.defineProperty(el, "firstChild", { get() { return this.children[0] || null; }, configurable: true });
  return el;
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
    t: (k) => k,
  };
}

function mountWidget({ Widget, theme }, config) {
  const parent = makeEl("div");
  const ctx = makeContext(theme);
  const w = new Widget(
    { id: "c", type: "chat", x: 0, y: 0, w: 20, h: 20, z: 0, visible: true, renderType: "2d", config },
    ctx
  );
  w.mount(parent);
  return { w, ctx };
}

function push(ctx, count) {
  for (let i = 0; i < count; i++) {
    ctx.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "u" + i, message: "m" + i, badges: [] });
  }
}

let originalGlobals;

beforeEach(() => {
  originalGlobals = {
    document: global.document,
    window: global.window,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
    performance: global.performance,
  };
  global.document = {
    createElement: (tag) => makeEl(tag),
    getElementById: () => null,
    head: makeEl("head"),
  };
  global.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  global.requestAnimationFrame = () => 0;
  global.cancelAnimationFrame = () => {};
  global.performance = { now: () => 0 };
});

afterEach(() => {
  global.document = originalGlobals.document;
  global.window = originalGlobals.window;
  global.requestAnimationFrame = originalGlobals.requestAnimationFrame;
  global.cancelAnimationFrame = originalGlobals.cancelAnimationFrame;
  global.performance = originalGlobals.performance;
});

describe("3D-чаты: лимит сообщений из конфига", () => {
  test.each(WIDGETS)("$name берёт maxMessages из конфига", ({ Widget, theme }) => {
    const { w, ctx } = mountWidget({ Widget, theme }, { maxMessages: 5 });
    push(ctx, 9);
    expect(w.messagesInner.children.length).toBe(5);
    w.unmount();
  });

  test.each(WIDGETS)("$name по умолчанию оставляет прежние 50", ({ Widget, theme }) => {
    const { w, ctx } = mountWidget({ Widget, theme }, {});
    push(ctx, 55);
    expect(w.messagesInner.children.length).toBe(50);
    w.unmount();
  });

  test.each(WIDGETS)("$name не снимает лимит на мусорном значении", ({ Widget, theme }) => {
    for (const bad of [0, -7, NaN, "abc", null, undefined]) {
      const { w, ctx } = mountWidget({ Widget, theme }, { maxMessages: bad });
      push(ctx, 3);
      expect(w.messagesInner.children.length).toBe(3);
      push(ctx, 49);
      expect(w.messagesInner.children.length).toBe(50);
      w.unmount();
    }
  });

  test.each(WIDGETS)("$name ограничивает слишком большое значение", ({ Widget, theme }) => {
    const { w, ctx } = mountWidget({ Widget, theme }, { maxMessages: 5000 });
    push(ctx, 210);
    expect(w.messagesInner.children.length).toBe(200);
    w.unmount();
  });
});
