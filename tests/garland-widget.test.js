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
  Проверка гирлянды.

  Виджет строит SVG по реальным размерам плашки: ширина — длина провода,
  высота — сколько места есть на провис. Ошибка здесь не видна по коду —
  провод просто не появится или повиснет не туда, — поэтому проверяется
  структура получившегося SVG и разбор настроек.
*/

const EventBus = require("../overlay/event-bus");
const { EVENT_TYPES } = require("../shared/events");
const WidgetGarland = require("../overlay/widgets/garland-widget");

function makeEl(tag) {
  const classSet = new Set();
  const styleProps = {};
  const attributes = {};
  const children = [];
  let content = "";
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    dataset: {},
    children,
    style: {
      setProperty(key, value) {
        styleProps[key] = value;
      },
      getPropertyValue(key) {
        return styleProps[key] || "";
      },
    },
    classList: {
      add: (...names) => names.forEach((name) => classSet.add(name)),
      remove: (...names) => names.forEach((name) => classSet.delete(name)),
      toggle: (name, force) => {
        const on = force === undefined ? !classSet.has(name) : force;
        if (on) classSet.add(name);
        else classSet.delete(name);
        return on;
      },
      contains: (name) => classSet.has(name),
    },
    get textContent() {
      return content;
    },
    set textContent(value) {
      content = String(value);
      children.length = 0;
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    appendChild(child) {
      child.parentNode = el;
      children.push(child);
      return child;
    },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      return child;
    },
    clientWidth: 0,
    clientHeight: 0,
  };
  return el;
}

let originalDocument;

beforeEach(() => {
  jest.useFakeTimers();
  originalDocument = global.document;
  global.document = {
    createElement: (tag) => makeEl(tag),
    createElementNS: (_namespace, tag) => makeEl(tag),
  };
});

afterEach(() => {
  global.document = originalDocument;
  jest.useRealTimers();
});

// Виджет строит строки только когда у него есть размер: в тесте он задаётся
// вручную, как это сделал бы браузер после раскладки.
function mount(config = {}, geometry = {}) {
  const bus = new EventBus();
  const widget = new WidgetGarland(
    { type: "garland", x: 0, y: 0, w: 96, h: 10, ...geometry, config },
    { bus, EVENT_TYPES, t: (key) => key },
  );
  widget.mount(makeEl("div"));
  widget.element.clientWidth = 960;
  widget.element.clientHeight = 90;
  widget.rebuild();
  return { widget, bus };
}

function byClass(widget, className) {
  return widget.svgEl.children.filter((child) => child.getAttribute("class") === className);
}

describe("WidgetGarland: построение", () => {
  test("провод один и висит с верхней кромки", () => {
    const { widget } = mount();
    expect(widget.svgEl.getAttribute("viewBox")).toBe("0 0 960 90");
    expect(byClass(widget, "garland__wire")).toHaveLength(1);
    // Лампочки — отдельными группами, по одной на каждую.
    expect(byClass(widget, "garland__bulb").length).toBeGreaterThan(0);
    widget.unmount();
  });

  test("сторона больше не настраивается: edge ни на что не влияет", () => {
    const left = mount({ edge: "left" });
    const top = mount({ edge: "top" });

    expect(byClass(left.widget, "garland__wire")).toHaveLength(1);
    expect(left.widget.svgEl.getAttribute("viewBox")).toBe(top.widget.svgEl.getAttribute("viewBox"));

    left.widget.unmount();
    top.widget.unmount();
  });

  test("повторная сборка с теми же размерами ничего не перестраивает", () => {
    const { widget } = mount();
    const before = widget.svgEl.children[0];
    widget.rebuild();
    // Первый ребёнок — defs: если кэш сработал, узел тот же.
    expect(widget.svgEl.children[0]).toBe(before);
    widget.unmount();
  });

  test("ноль в размерах не ломает построение", () => {
    const { widget } = mount();
    widget.element.clientWidth = 0;
    widget.element.clientHeight = 0;
    expect(() => widget.rebuild()).not.toThrow();
    widget.unmount();
  });
});

describe("WidgetGarland: настройки", () => {
  test("палитра по имени и по списку цветов", () => {
    const named = mount({ palette: "warm" });
    expect(named.widget.settings().palette).toHaveLength(3);
    named.widget.unmount();

    const custom = mount({ palette: "#abc, #123456" });
    expect(custom.widget.settings().palette).toEqual(["#abc", "#123456"]);
    custom.widget.unmount();

    // Мусор не должен оставлять гирлянду чёрной: откат на classic.
    const fallback = mount({ palette: "нет-такого" });
    expect(fallback.widget.settings().palette).toHaveLength(5);
    fallback.widget.unmount();
  });

  test("размеры и скорость зажимаются в разумные рамки", () => {
    const { widget } = mount({ bulbs: 9999, swags: 0, sag: 5, speed: 99 });
    const settings = widget.settings();
    expect(settings.bulbs).toBe(240);
    expect(settings.swags).toBe(1);
    expect(settings.sag).toBe(1);
    expect(settings.speed).toBe(4);
    widget.unmount();
  });

  test("режим превращается в класс на корне", () => {
    const { widget } = mount({ mode: "chase" });
    expect(widget.element.classList.contains("garland--chase")).toBe(true);
    expect(widget.element.classList.contains("garland--twinkle")).toBe(false);
    widget.unmount();
  });
});

describe("WidgetGarland: реакция на алерты", () => {
  test("алерт включает вспышку и отпускает её по таймеру", () => {
    const { widget, bus } = mount({ reactToAlerts: true });
    bus.emit(EVENT_TYPES.ALERT, { kind: "donation", amount: 500 });
    expect(widget.element.classList.contains("is-burst")).toBe(true);

    jest.advanceTimersByTime(3600);
    expect(widget.element.classList.contains("is-burst")).toBe(false);
    widget.unmount();
  });

  test("с выключенной реакцией вспышки нет", () => {
    const { widget, bus } = mount({ reactToAlerts: false });
    bus.emit(EVENT_TYPES.ALERT, { kind: "donation", amount: 500 });
    expect(widget.element.classList.contains("is-burst")).toBe(false);
    widget.unmount();
  });
});
