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

const BaseWidget = require("../overlay/widgets/base-widget");
const WidgetManager = require("../overlay/widgets/widget-manager");

// ---- minimal DOM/canvas mock (no jsdom dependency) ----

function makeElement(tag) {
  const listeners = [];
  const el = {
    tagName: (tag || "div").toUpperCase(),
    nodeType: 1,
    className: "",
    dataset: {},
    style: {},
    width: 0,
    height: 0,
    clientWidth: 100,
    clientHeight: 60,
    parentNode: null,
    children: [],
    _listeners: listeners,
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
    addEventListener(type, fn, options) {
      listeners.push({ type, fn, options });
    },
    removeEventListener(type, fn, options) {
      for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i].fn === fn && listeners[i].type === type) listeners.splice(i, 1);
      }
    },
  };
  return el;
}

function createDocument() {
  const state = { gl: null };
  return {
    get gl() {
      return state.gl;
    },
    set gl(v) {
      state.gl = v;
    },
    createElement(tag) {
      const el = makeElement(tag);
      if (tag === "canvas") el.getContext = () => state.gl;
      return el;
    },
  };
}

function createRaf() {
  let id = 0;
  const queue = [];
  return {
    request: (fn) => {
      const handle = ++id;
      queue.push({ handle, fn });
      return handle;
    },
    cancel: (handle) => {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].handle === handle) queue.splice(i, 1);
      }
    },
    pending: () => queue.length,
    flush: (now) => queue.splice(0).forEach((p) => p.fn(now)),
  };
}

function createFakeGl() {
  return {
    viewport: jest.fn(),
    getExtension: jest.fn(() => ({ loseContext: jest.fn() })),
  };
}

function createBus() {
  const handlers = new Map();
  return {
    on(channel, fn) {
      if (!handlers.has(channel)) handlers.set(channel, []);
      handlers.get(channel).push(fn);
      return () => {
        const arr = handlers.get(channel) || [];
        handlers.set(channel, arr.filter((x) => x !== fn));
      };
    },
    off(channel, fn) {
      const arr = handlers.get(channel) || [];
      handlers.set(channel, arr.filter((x) => x !== fn));
    },
    _handlers: handlers,
  };
}

class SpyWidget extends BaseWidget {
  constructor(config, context) {
    super(config, context);
    this.renders = 0;
    this.mountCalls = 0;
    this.updateCalls = [];
    this.unmountCalls = 0;
  }
  onMount() {
    this.mountCalls++;
  }
  onUpdate(prev, next) {
    this.updateCalls.push([prev, next]);
  }
  onUnmount() {
    this.unmountCalls++;
  }
  render() {
    this.renders++;
  }
}

function item(overrides = {}) {
  return {
    id: "w1",
    type: "alerts",
    x: 30,
    y: 4,
    w: 40,
    h: 20,
    z: 1,
    visible: true,
    config: {},
    ...overrides,
  };
}

// ---- globals wiring ----

let document;
let windowObj;
let raf;
let originalGlobals;

beforeEach(() => {
  document = createDocument();
  windowObj = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  raf = createRaf();
  originalGlobals = {
    document: global.document,
    window: global.window,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
    performance: global.performance,
  };
  global.document = document;
  global.window = windowObj;
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

describe("BaseWidget", () => {
  test("2D mount создаёт <div> и применяет геометрию", () => {
    const parent = document.createElement("div");
    const w = new SpyWidget(item());

    const el = w.mount(parent);

    expect(el).toBe(w.element);
    expect(el.tagName).toBe("DIV");
    expect(w.canvas).toBeNull();
    expect(w._mounted).toBe(true);
    expect(parent.children).toContain(el);

    expect(el.style.position).toBe("absolute");
    expect(el.style.left).toBe("30%");
    expect(el.style.top).toBe("4%");
    expect(el.style.width).toBe("40%");
    expect(el.style.height).toBe("20%");
    expect(el.style.zIndex).toBe("1");
    expect(el.style.display).toBe("");

    expect(w.mountCalls).toBe(1);
    expect(w.renders).toBe(1);
  });

  test("3D mount создаёт <canvas> с WebGL-контекстом и ресайзит его", () => {
    const gl = createFakeGl();
    document.gl = gl;

    const parent = document.createElement("div");
    const w = new SpyWidget(item({ renderType: "3d-webgl" }));

    const el = w.mount(parent);

    expect(el.tagName).toBe("CANVAS");
    expect(w.renderType).toBe("3d-webgl");
    expect(w.gl).toBe(gl);
    expect(el.width).toBe(100);
    expect(el.height).toBe(60);
    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 100, 60);
    expect(w._listeners).toHaveLength(1); // window resize listener
  });

  test("3D без WebGL корректно падает обратно в 2d", () => {
    document.gl = null;
    const parent = document.createElement("div");
    const w = new SpyWidget(item({ renderType: "3d-webgl" }));

    w.mount(parent);

    expect(w.gl).toBeNull();
    expect(w.renderType).toBe("2d");
  });

  test("update мержит config и геометрию, вызывает onUpdate и render", () => {
    const parent = document.createElement("div");
    const w = new SpyWidget(item({ config: { maxItems: 5 } }));
    w.mount(parent);
    const rendersAfterMount = w.renders;

    w.update(item({ config: { maxItems: 9 }, x: 55 }));

    expect(w.config.maxItems).toBe(9);
    expect(w.geometry.x).toBe(55);
    expect(w.element.style.left).toBe("55%");
    expect(w.updateCalls).toHaveLength(1);
    expect(w.updateCalls[0][1].maxItems).toBe(9);
    expect(w.renders).toBe(rendersAfterMount + 1);
  });

  test("unmount тотально чистит DOM, таймеры, слушатели и GL", () => {
    const gl = createFakeGl();
    document.gl = gl;
    const parent = document.createElement("div");
    const target = document.createElement("div");

    const w = new SpyWidget(item({ renderType: "3d-webgl" }));
    w.mount(parent);
    w.later(() => {}, 100000);
    w.every(() => {}, 100000);
    w.on(target, "click", () => {});

    expect(w._timers.size).toBe(2);
    expect(w._listeners.length).toBeGreaterThan(0);

    w.unmount();

    expect(w._mounted).toBe(false);
    expect(parent.children).toHaveLength(0);
    expect(w.element).toBeNull();
    expect(w.gl).toBeNull();
    expect(w._timers.size).toBe(0);
    expect(w._listeners).toHaveLength(0);
    expect(target._listeners).toHaveLength(0); // listener actually removed
    expect(gl.getExtension).toHaveBeenCalledWith("WEBGL_lose_context");
    expect(w.unmountCalls).toBe(1);
  });

  test("startRenderLoop жёстко ограничивает FPS, stopRenderLoop отменяет", () => {
    class Counter extends BaseWidget {
      constructor() {
        super({ id: "c", type: "counter", renderType: "3d-webgl" });
        this.renders = 0;
      }
      render() {
        this.renders++;
      }
    }

    const w = new Counter();
    w.startRenderLoop(2); // budget = 500ms
    expect(raf.pending()).toBe(1);

    raf.flush(0); // delta 0   -> skip
    raf.flush(499); // delta 499 -> skip
    expect(w.renders).toBe(0);

    raf.flush(1000); // delta 1000 -> render
    expect(w.renders).toBe(1);

    raf.flush(1200); // delta 200  -> skip
    expect(w.renders).toBe(1);

    raf.flush(1500); // delta 500  -> render
    expect(w.renders).toBe(2);

    w.stopRenderLoop();
    expect(raf.pending()).toBe(0);
  });

  test("setIdle(true) останавливает цикл, setIdle(false) возобновляет", () => {
    class Counter extends BaseWidget {
      constructor() {
        super({ id: "c", type: "counter", renderType: "3d-webgl" });
        this.renders = 0;
      }
      render() {
        this.renders++;
      }
    }
    document.gl = createFakeGl();
    const parent = document.createElement("div");
    const w = new Counter();
    w.mount(parent);
    w.startRenderLoop(30);
    expect(raf.pending()).toBe(1);

    w.setIdle(true);
    expect(raf.pending()).toBe(0);

    w.setIdle(false);
    expect(raf.pending()).toBe(1);

    w.unmount();
    expect(raf.pending()).toBe(0);
  });

  test("скрытие виджета через update останавливает цикл", () => {
    class Counter extends BaseWidget {
      constructor() {
        super({ id: "c", type: "counter", renderType: "3d-webgl" });
        this.renders = 0;
      }
      render() {
        this.renders++;
      }
    }
    document.gl = createFakeGl();
    const parent = document.createElement("div");
    const w = new Counter();
    w.mount(parent);
    w.startRenderLoop(30);

    w.update({ visible: false });
    expect(raf.pending()).toBe(0);
  });

  test("subscribe подписывается на шину и отписывается в unmount", () => {
    const bus = createBus();
    const parent = document.createElement("div");
    const w = new SpyWidget(item(), { bus });
    w.mount(parent);

    const handler = jest.fn();
    w.subscribe("chat_message", handler);
    expect(bus._handlers.get("chat_message")).toContain(handler);

    w.unmount();
    expect(bus._handlers.get("chat_message")).not.toContain(handler);
  });
});

describe("WidgetManager", () => {
  test("syncLayout добавляет, обновляет и удаляет виджеты", () => {
    const root = document.createElement("div");
    const mgr = new WidgetManager(root);

    mgr.syncLayout([item({ id: "a" })]);
    expect(mgr.size).toBe(1);
    const inst = mgr.get("a");
    expect(inst.type).toBe("alerts");
    expect(root.children).toHaveLength(1);

    // update: тот же инстанс, новые config/геометрия
    mgr.syncLayout([item({ id: "a", x: 50, config: { maxItems: 7 } })]);
    expect(mgr.size).toBe(1);
    expect(mgr.get("a")).toBe(inst);
    expect(inst.geometry.x).toBe(50);
    expect(inst.config.maxItems).toBe(7);

    // remove
    mgr.syncLayout([]);
    expect(mgr.size).toBe(0);
    expect(root.children).toHaveLength(0);
  });

  test("смена типа пересоздаёт виджет", () => {
    const root = document.createElement("div");
    const mgr = new WidgetManager(root);

    mgr.syncLayout([item({ id: "a", type: "alerts" })]);
    const first = mgr.get("a");

    mgr.syncLayout([item({ id: "a", type: "goal" })]);
    expect(mgr.size).toBe(1);
    expect(mgr.get("a")).not.toBe(first);
    expect(mgr.get("a").type).toBe("goal");
    expect(root.children).toHaveLength(1);
  });

  test("resolveRenderType управляет режимом рендера", () => {
    const gl = createFakeGl();
    document.gl = gl;
    const root = document.createElement("div");
    const mgr = new WidgetManager(root, { resolveRenderType: () => "3d-webgl" });

    mgr.syncLayout([item({ id: "a" })]);
    const inst = mgr.get("a");

    expect(inst.renderType).toBe("3d-webgl");
    expect(inst.element.tagName).toBe("CANVAS");
  });

  test("factory переопределяет класс виджета", () => {
    const root = document.createElement("div");
    class Custom extends SpyWidget {}
    const mgr = new WidgetManager(root, { factory: () => Custom });

    mgr.syncLayout([item({ id: "a" })]);
    expect(mgr.get("a")).toBeInstanceOf(Custom);
  });
});
