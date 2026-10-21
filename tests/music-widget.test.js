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
const MusicWidget = require("../overlay/widgets/music-widget");

// ---- minimal DOM mock (subset used by BaseWidget + MusicWidget) ----

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
    src: "",
    alt: "",
    textContent: "",
    clientWidth: 200,
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
    removeAttribute(k) {
      delete attrs[k];
      if (k === "src") this.src = "";
    },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ width: 100 }),
    _attrs: attrs,
  };
  return el;
}

function makeContext() {
  return {
    bus: new EventBus(),
    EVENT_TYPES,
    t: (key, params) => {
      let out = key;
      if (params) {
        Object.entries(params).forEach(([name, value]) => (out += `:${name}=${value}`));
      }
      return out;
    },
    formatMoney: (value) => String(value),
    currencySymbol: (code) => (String(code || "").toUpperCase() === "RUB" ? "₽" : String(code || "")),
    resolveMediaUrl: (p) => (String(p || "").startsWith("media/") ? `http://127.0.0.1/media/${p.slice(6)}` : p || ""),
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
    Audio: global.Audio,
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
  global.Audio = originalGlobals.Audio;
});

function mountWidget(config = {}) {
  const parent = makeEl("div");
  const w = new MusicWidget(
    { id: "w1", type: "music", x: 0, y: 0, w: 10, h: 10, z: 0, visible: true, config },
    makeContext()
  );
  w.mount(parent);
  return { w, parent };
}

function donation(patch = {}) {
  return {
    kind: "donation",
    musicLink: "https://cdn.example/Track.mp3",
    user: "fan",
    amount: 250,
    currency: "RUB",
    ...patch,
  };
}

describe("music widget", () => {
  test("показывает трек, заказчика и сумму", () => {
    const { w } = mountWidget({ autoplay: false });
    w.context.bus.emit(EVENT_TYPES.ALERT, donation({ musicLink: "https://cdn.example/Night%20Drive.mp3" }));

    expect(w.current.musicLink).toBe("https://cdn.example/Night%20Drive.mp3");
    expect(w.el.trackTexts[0].textContent).toBe("Night Drive.mp3");
    expect(w.el.requester.textContent).toBe("music.requester:user=fan · 250 ₽");
    w.unmount();
  });

  test("musicTitle важнее имени файла", () => {
    const { w } = mountWidget({ autoplay: false });
    w.context.bus.emit(EVENT_TYPES.ALERT, donation({ musicTitle: "Night Drive" }));
    expect(w.el.trackTexts[0].textContent).toBe("Night Drive");
    w.unmount();
  });

  test("showAmount: false оставляет только заказчика", () => {
    const { w } = mountWidget({ autoplay: false, showAmount: false });
    w.context.bus.emit(EVENT_TYPES.ALERT, donation());
    expect(w.el.requester.textContent).toBe("music.requester:user=fan");
    w.unmount();
  });

  test("следующий трек ждёт своей очереди", () => {
    const { w } = mountWidget({ autoplay: false });
    w.context.bus.emit(EVENT_TYPES.ALERT, donation({ musicLink: "https://cdn.example/first.mp3" }));
    w.context.bus.emit(EVENT_TYPES.ALERT, donation({ musicLink: "https://cdn.example/second.mp3", user: "fan2" }));

    expect(w.current.musicLink).toBe("https://cdn.example/first.mp3");
    expect(w.queue.length).toBe(1);
    expect(w.el.queue.textContent).toBe("music.queue:count=1");
    expect(w.el.queue.style.display).toBe("");

    w.idle();
    expect(w.current.musicLink).toBe("https://cdn.example/second.mp3");
    expect(w.queue.length).toBe(0);
    expect(w.el.queue.style.display).toBe("none");
    w.unmount();
  });

  test("очередь можно выключить — новый трек заменяет текущий", () => {
    const { w } = mountWidget({ autoplay: false, queue: false });
    w.context.bus.emit(EVENT_TYPES.ALERT, donation({ musicLink: "https://cdn.example/first.mp3" }));
    w.context.bus.emit(EVENT_TYPES.ALERT, donation({ musicLink: "https://cdn.example/second.mp3" }));

    expect(w.current.musicLink).toBe("https://cdn.example/second.mp3");
    expect(w.queue.length).toBe(0);
    expect(w.el.queue.style.display).toBe("none");
    w.unmount();
  });

  test("ссылка на YouTube даёт обложку и общее название", () => {
    const { w } = mountWidget({ autoplay: false });
    w.context.bus.emit(EVENT_TYPES.ALERT, donation({ musicLink: "https://www.youtube.com/watch?v=abc123" }));

    expect(w.el.art.src).toBe("https://img.youtube.com/vi/abc123/hqdefault.jpg");
    expect(w.el.trackTexts[0].textContent).toBe("music.track");
    w.unmount();
  });

  test("локальный файл проходит через resolveMediaUrl", () => {
    const played = [];
    global.Audio = class {
      constructor(src) {
        this.src = src;
        this.volume = 1;
        this.currentTime = 0;
        this.duration = 0;
        played.push(src);
      }
      addEventListener() {}
      play() {
        return { catch() {} };
      }
      pause() {}
    };

    const { w } = mountWidget({ autoplay: true });
    w.context.bus.emit(EVENT_TYPES.ALERT, donation({ musicLink: "media/track.mp3" }));

    expect(played).toEqual(["http://127.0.0.1/media/track.mp3"]);
    expect(w._audio.volume).toBe(1);
    w.unmount();
  });
});
