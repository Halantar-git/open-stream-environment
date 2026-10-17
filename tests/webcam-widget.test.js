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
const WebcamWidget = require("../overlay/widgets/webcam-widget");

// ---- minimal DOM mock ----

function makeEl(tag) {
  const classSet = new Set();
  const el = {
    tagName: (tag || "div").toUpperCase(),
    className: "",
    dataset: {},
    innerHTML: "",
    style: {
      values: {},
      setProperty(k, v) {
        this.values[k] = v;
      },
    },
    classList: {
      add: (...c) => c.forEach((x) => classSet.add(x)),
      remove: (...c) => c.forEach((x) => classSet.delete(x)),
      toggle: (c, f) => {
        const on = f === undefined ? !classSet.has(c) : f;
        if (on) classSet.add(c);
        else classSet.delete(c);
        return on;
      },
      contains: (c) => classSet.has(c),
    },
    children: [],
    parentNode: null,
    isConnected: true,
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
    querySelector() {
      return null;
    },
    getContext() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return el;
}

function makeContext() {
  return {
    bus: new EventBus(),
    EVENT_TYPES,
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
  };
}

function makeItem(config = {}) {
  return { id: "webcam-1", type: "webcam", x: 20, y: 30, w: 24, h: 24, z: 0, visible: true, config };
}

function mount(config = {}) {
  const parent = makeEl("div");
  const w = new WebcamWidget(makeItem(config), makeContext());
  w.mount(parent);
  return w;
}

let originalGlobals;

beforeEach(() => {
  originalGlobals = { document: global.document, window: global.window };
  global.document = { createElement: (tag) => makeEl(tag) };
  global.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
});

afterEach(() => {
  global.document = originalGlobals.document;
  global.window = originalGlobals.window;
});

describe("WebcamWidget", () => {
  test("по умолчанию рисует рамку, четыре уголка и бейдж LIVE", () => {
    const w = mount();

    expect(w.host.className).toBe("widget-webcam");
    expect(w.element.dataset.type).toBe("webcam");
    expect(w.host.innerHTML).toContain("widget-webcam__frame");
    expect(w.host.innerHTML.match(/widget-webcam__corner/g)).toHaveLength(4);
    expect(w.host.innerHTML).toContain('data-pos="top-left"');
    expect(w.host.innerHTML).toContain("LIVE");
    expect(w.host.innerHTML).toContain("widget-webcam__dot");
    expect(w.host.innerHTML).not.toContain("widget-webcam__backdrop");
    expect(w.host.innerHTML).not.toContain("widget-webcam__vignette");
  });

  test("толщина, скругление и цвет уходят в CSS-переменные", () => {
    const w = mount({ color: "#ff5500", thickness: 8, radius: 24 });

    expect(w.host.style.values["--webcam-accent"]).toBe("#ff5500");
    expect(w.host.style.values["--webcam-thickness"]).toBe("8px");
    expect(w.host.style.values["--webcam-radius"]).toBe("24px");
  });

  test("без цвета рамка берёт акцент темы", () => {
    const w = mount({ color: "" });
    expect(w.host.style.values["--webcam-accent"]).toBe("var(--md-primary)");
  });

  test("небезопасное значение цвета не попадает в CSS", () => {
    const w = mount({ color: 'red; background:url("x")' });
    expect(w.host.style.values["--webcam-accent"]).toBe("var(--md-primary)");
  });

  test("бейдж можно скрыть или очистить", () => {
    expect(mount({ showLabel: false }).host.innerHTML).not.toContain("widget-webcam__label");
    expect(mount({ label: "   " }).host.innerHTML).not.toContain("widget-webcam__label");
  });

  test("положение бейджа и произвольная подпись", () => {
    const w = mount({ label: "REC", labelPosition: "bottom-right" });
    expect(w.host.innerHTML).toContain('data-pos="bottom-right"');
    expect(w.host.innerHTML).toContain("REC");
  });

  test("неизвестное положение бейджа сбрасывается в левый верхний угол", () => {
    const w = mount({ labelPosition: "somewhere" });
    expect(w.host.innerHTML).toContain('data-pos="top-left"');
  });

  test("рамку, уголки, фон и затемнение можно отключить по отдельности", () => {
    const w = mount({ showBorder: false, showCorners: false, showBackground: false, showVignette: false });
    expect(w.host.innerHTML).not.toContain("widget-webcam__frame");
    expect(w.host.innerHTML).not.toContain("widget-webcam__corner");
    expect(w.host.innerHTML).not.toContain("widget-webcam__backdrop");
    expect(w.host.innerHTML).not.toContain("widget-webcam__vignette");
  });

  test("фон и затемнение добавляются, когда включены", () => {
    const w = mount({ showBackground: true, showVignette: true });
    expect(w.host.innerHTML).toContain("widget-webcam__backdrop");
    expect(w.host.innerHTML).toContain("widget-webcam__vignette");
  });

  test("update перерисовывает рамку под новый конфиг", () => {
    const w = mount({ label: "LIVE" });
    w.update({ config: { label: "STREAM", labelPosition: "bottom-left", thickness: 2 } });

    expect(w.host.innerHTML).toContain("STREAM");
    expect(w.host.innerHTML).not.toContain(">LIVE<");
    expect(w.host.innerHTML).toContain('data-pos="bottom-left"');
    expect(w.host.style.values["--webcam-thickness"]).toBe("2px");
  });

  test("числовые настройки зажимаются в допустимый диапазон", () => {
    const w = mount({ thickness: 999, radius: -10 });
    expect(w.host.style.values["--webcam-thickness"]).toBe("16px");
    expect(w.host.style.values["--webcam-radius"]).toBe("0px");
  });

  test("перспектива наклоняет виджет и учитывает направление", () => {
    const w = mount({ perspective: 50, perspectiveDirection: "left" });
    expect(w.element.style.transform).toContain("perspective(1200px)");
    expect(w.element.style.transform).toContain("rotateY(-7.5deg)");
    expect(w.element.style.transform).toContain("rotateX(1.5deg)");
    expect(w.element.style.transformStyle).toBe("preserve-3d");

    w.update({ config: { perspectiveDirection: "right" } });
    expect(w.element.style.transform).toContain("rotateY(7.5deg)");

    w.update({ config: { perspectiveDirection: "up" } });
    expect(w.element.style.transform).toContain("rotateY(0deg)");
    expect(w.element.style.transform).toContain("rotateX(7.5deg)");

    w.update({ config: { perspectiveDirection: "down" } });
    expect(w.element.style.transform).toContain("rotateX(-7.5deg)");

    w.update({ config: { perspective: 0 } });
    expect(w.element.style.transform).toBe("");
    expect(w.element.style.transformStyle).toBe("");
  });

  test("unmount снимает виджет с канваса", () => {
    const w = mount();
    const parent = w.element.parentNode;
    w.unmount();
    expect(parent.children).toHaveLength(0);
  });
});
