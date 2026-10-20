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
  Проверка геометрии гирлянды.

  Виджет строит строку в локальных координатах и поворачивает её матрицей под
  выбранную кромку. Ошибка в матрице не видна по коду: провод просто уедет за
  пределы виджета или повиснет не в ту сторону. Здесь проверяется, какую
  трансформацию получает каждая сторона и как `auto` выбирает сторону по
  геометрии виджета.
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

// `defs` идёт первым, дальше — по группе на каждую сторону.
function stringGroups(widget) {
  return widget.svgEl.children.filter((child) => child.tagName === "G");
}

const edgesOf = (widget) => widget.settings().edges;

describe("WidgetGarland: стороны", () => {
  test("верх: строка без поворота", () => {
    const { widget } = mount({ edge: "top" });
    expect(edgesOf(widget)).toEqual(["top"]);
    expect(stringGroups(widget)).toHaveLength(1);
    expect(stringGroups(widget)[0].getAttribute("transform")).toBe("");
    widget.unmount();
  });

  test("левая сторона: провод вертикальный, лампочки внутрь виджета", () => {
    const { widget } = mount({ edge: "left" });
    // matrix(0 1 1 0 0 0) меняет оси местами: вдоль — по вертикали, провис —
    // вправо, то есть внутрь сцены от левой кромки.
    expect(stringGroups(widget)[0].getAttribute("transform")).toBe("matrix(0 1 1 0 0 0)");
    widget.unmount();
  });

  test("правая сторона: провод вертикальный и провисает влево", () => {
    const { widget } = mount({ edge: "right" });
    expect(stringGroups(widget)[0].getAttribute("transform")).toBe("matrix(0 1 -1 0 960 0)");
    widget.unmount();
  });

  test("низ: строка перевёрнута и висит вверх", () => {
    const { widget } = mount({ edge: "bottom" });
    expect(stringGroups(widget)[0].getAttribute("transform")).toBe("translate(0 90) scale(1 -1)");
    widget.unmount();
  });

  test("frame — строка на каждой из четырёх сторон", () => {
    const { widget } = mount({ edge: "frame" });
    expect(edgesOf(widget)).toEqual(["left", "top", "right", "bottom"]);
    expect(stringGroups(widget)).toHaveLength(4);
    widget.unmount();
  });

  test("arc — дуга слева, сверху и справа", () => {
    const { widget } = mount({ edge: "arc" });
    expect(edgesOf(widget)).toEqual(["left", "top", "right"]);
    expect(stringGroups(widget)).toHaveLength(3);
    widget.unmount();
  });
});

describe("WidgetGarland: auto по геометрии", () => {
  // auto выбирает сторону по форме и месту плашки: широкую вешает на верхнюю
  // или нижнюю кромку, узкую — на боковую.
  const cases = [
    { geometry: { x: 2, y: 0, w: 96, h: 10 }, edge: "top" },
    { geometry: { x: 2, y: 88, w: 96, h: 10 }, edge: "bottom" },
    { geometry: { x: 0, y: 4, w: 10, h: 90 }, edge: "left" },
    { geometry: { x: 90, y: 4, w: 10, h: 90 }, edge: "right" },
  ];

  for (const item of cases) {
    test(`${JSON.stringify(item.geometry)} → ${item.edge}`, () => {
      const { widget } = mount({ edge: "auto" }, item.geometry);
      expect(edgesOf(widget)).toEqual([item.edge]);
      widget.unmount();
    });
  }

  test("по умолчанию тоже auto", () => {
    const { widget } = mount({}, { x: 90, y: 4, w: 10, h: 90 });
    expect(edgesOf(widget)).toEqual(["right"]);
    widget.unmount();
  });

  test("неизвестная сторона откатывается на auto", () => {
    const { widget } = mount({ edge: "diagonal" }, { x: 0, y: 0, w: 96, h: 10 });
    expect(edgesOf(widget)).toEqual(["top"]);
    widget.unmount();
  });
});

describe("WidgetGarland: настройки и реакция", () => {
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

  test("режим превращается в класс на корне", () => {
    const { widget } = mount({ mode: "chase" });
    expect(widget.element.classList.contains("garland--chase")).toBe(true);
    expect(widget.element.classList.contains("garland--twinkle")).toBe(false);
    widget.unmount();
  });

  test("ноль в размерах не ломает построение", () => {
    const { widget } = mount({ edge: "top" });
    widget.element.clientWidth = 0;
    widget.element.clientHeight = 0;
    expect(() => widget.rebuild()).not.toThrow();
    widget.unmount();
  });
});
