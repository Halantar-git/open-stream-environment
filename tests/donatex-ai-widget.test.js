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
const DonatexAiWidget = require("../overlay/widgets/donatex-ai-widget");

// ---- minimal DOM mock (subset used by BaseWidget + DonatexAiWidget) ----

function makeEl(tag) {
  const attrs = {};
  const classSet = new Set();
  const classList = {
    add: (...c) => c.forEach((x) => classSet.add(x)),
    remove: (...c) => c.forEach((x) => classSet.delete(x)),
    toggle: (c, force) => {
      const on = force === undefined ? !classSet.has(c) : force;
      if (on) classSet.add(c);
      else classSet.delete(c);
      return on;
    },
    contains: (c) => classSet.has(c),
  };
  const el = {
    tagName: (tag || "div").toUpperCase(),
    innerHTML: "",
    className: "",
    classList,
    dataset: {},
    style: { setProperty(k, v) { this[k] = v; } },
    children: [],
    parentNode: null,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    setAttribute(k, v) {
      attrs[k] = v;
    },
    getAttribute(k) {
      return attrs[k];
    },
    addEventListener() {},
    removeEventListener() {},
    _attrs: attrs,
  };
  Object.defineProperty(el, "firstChild", {
    get() {
      return this.children[0] || null;
    },
    configurable: true,
  });
  return el;
}

function makeContext() {
  return {
    bus: new EventBus(),
    EVENT_TYPES,
    t: (k) => k,
    resolveMediaUrl: (p) => p || "",
  };
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
  global.document = { createElement: (tag) => makeEl(tag) };
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

function mountWidget(config = {}) {
  const parent = makeEl("div");
  const w = new DonatexAiWidget(
    { id: "w1", type: "donatex-ai", x: 0, y: 0, w: 10, h: 10, z: 0, visible: true, config },
    makeContext()
  );
  w.mount(parent);
  return { w, parent };
}

describe("donatex-ai widget", () => {
  test("режим iframe при заданной ссылке", () => {
    const { w } = mountWidget({ url: "https://example.com/ai-character" });
    expect(w.iframeHost.firstChild.tagName).toBe("IFRAME");
    expect(w.iframeHost.firstChild.src).toBe("https://example.com/ai-character");
    expect(w.iframeHost.style.display).toBe("");
    expect(w.eventHost.style.display).toBe("none");
    w.unmount();
  });

  test("показывает аватар и реплику по ИИ-событию", () => {
    const { w } = mountWidget({});
    expect(w.eventHost.style.display).toBe("none");

    w.context.bus.emit(EVENT_TYPES.DONATEX_AI_EVENT, {
      characterName: "Katy",
      aiText: "Спасибо за донат!",
    });

    expect(w.eventHost.style.display).toBe("flex");
    expect(w.nameEl.textContent).toBe("Katy");
    expect(w.textEl.textContent).toBe("Спасибо за донат!");
    w.unmount();
  });

  test("hide() скрывает виджет", () => {
    const { w } = mountWidget({});
    w.context.bus.emit(EVENT_TYPES.DONATEX_AI_EVENT, { characterName: "Katy", aiText: "hi" });
    expect(w.eventHost.style.display).toBe("flex");

    w.hide();
    expect(w.eventHost.style.display).toBe("none");
    w.unmount();
  });

  test("showName: false скрывает имя персонажа", () => {
    const { w } = mountWidget({ showName: false });
    w.context.bus.emit(EVENT_TYPES.DONATEX_AI_EVENT, { characterName: "Katy", aiText: "hi" });
    expect(w.nameEl.style.display).toBe("none");
    w.unmount();
  });
});
