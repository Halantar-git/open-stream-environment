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
  Проверка снегопада.

  Снежинки — обычные элементы с CSS-переменными, поэтому ошибка в подсчёте
  количества или разбросе видна только глазами. Здесь проверяется то, что
  ломается тише всего: число снежинок от площади и плотности, детерминизм
  пересборки, разбор цвета и порыв на алерт.
*/

const EventBus = require("../overlay/event-bus");
const { EVENT_TYPES } = require("../shared/events");
const WidgetSnow = require("../overlay/widgets/snow-widget");

function makeEl(tag) {
  const classSet = new Set();
  const styleProps = {};
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
  global.document = { createElement: (tag) => makeEl(tag) };
});

afterEach(() => {
  global.document = originalDocument;
  jest.useRealTimers();
});

function mount(config = {}, size = { w: 960, h: 540 }) {
  const bus = new EventBus();
  const widget = new WidgetSnow(
    { type: "snow", x: 0, y: 0, w: 100, h: 100, config },
    { bus, EVENT_TYPES, t: (key) => key },
  );
  widget.mount(makeEl("div"));
  widget.element.clientWidth = size.w;
  widget.element.clientHeight = size.h;
  widget.rebuild();
  return { widget, bus };
}

const flakes = (widget) => widget.fieldEl.children;

describe("WidgetSnow: поле снежинок", () => {
  test("число снежинок считается от площади и плотности", () => {
    // 960×540 при плотности 40 — примерно одна снежинка на 16 000 px².
    const { widget } = mount({ density: 40 });
    expect(flakes(widget)).toHaveLength(32);
    widget.unmount();
  });

  test("плотность и площадь увеличивают число снежинок", () => {
    const dense = mount({ density: 80 });
    expect(flakes(dense.widget).length).toBeGreaterThan(60);
    dense.widget.unmount();

    const big = mount({ density: 40 }, { w: 1920, h: 1080 });
    expect(flakes(big.widget).length).toBeGreaterThan(120);
    big.widget.unmount();
  });

  test("на маленькой плашке снежинок всё равно есть", () => {
    const { widget } = mount({ density: 5 }, { w: 120, h: 90 });
    expect(flakes(widget).length).toBeGreaterThanOrEqual(4);
    widget.unmount();
  });

  test("пересборка с теми же настройками не перетасовывает снег", () => {
    const a = mount({ density: 30 });
    const b = mount({ density: 30 });
    expect(flakes(a.widget)[0].style.getPropertyValue("--x")).toBe(
      flakes(b.widget)[0].style.getPropertyValue("--x"),
    );
    expect(flakes(a.widget)[0].style.getPropertyValue("--dur")).toBe(
      flakes(b.widget)[0].style.getPropertyValue("--dur"),
    );
    a.widget.unmount();
    b.widget.unmount();
  });

  test("скорость сокращает время падения, снос задаёт направление", () => {
    const slow = mount({ speed: 1, wind: 0.5 });
    const fast = mount({ speed: 3, wind: 0.5 });
    const slowDur = parseFloat(flakes(slow.widget)[0].style.getPropertyValue("--dur"));
    const fastDur = parseFloat(flakes(fast.widget)[0].style.getPropertyValue("--dur"));
    expect(fastDur).toBeLessThan(slowDur);

    expect(parseFloat(flakes(slow.widget)[0].style.getPropertyValue("--wind"))).toBeGreaterThan(0);
    const left = mount({ wind: -0.5 });
    expect(parseFloat(flakes(left.widget)[0].style.getPropertyValue("--wind"))).toBeLessThan(0);

    slow.widget.unmount();
    fast.widget.unmount();
    left.widget.unmount();
  });

  test("цвет берётся только корректный, иначе белый", () => {
    const custom = mount({ color: "#9fd8ff" });
    expect(custom.widget.element.style.getPropertyValue("--snow-color")).toBe("#9fd8ff");
    custom.widget.unmount();

    const fallback = mount({ color: "нет" });
    expect(fallback.widget.element.style.getPropertyValue("--snow-color")).toBe("#ffffff");
    fallback.widget.unmount();
  });

  test("нулевой размер не ломает построение", () => {
    const { widget } = mount({}, { w: 0, h: 0 });
    expect(() => widget.rebuild()).not.toThrow();
    widget.unmount();
  });
});

describe("WidgetSnow: порыв на алерты", () => {
  test("алерт ускоряет снег и отпускает порыв по таймеру", () => {
    const { widget, bus } = mount();
    bus.emit(EVENT_TYPES.ALERT, { kind: "donation", amount: 200 });
    expect(widget.element.classList.contains("is-burst")).toBe(true);

    jest.advanceTimersByTime(3600);
    expect(widget.element.classList.contains("is-burst")).toBe(false);
    widget.unmount();
  });

  test("с выключенным порывом класс не появляется", () => {
    const { widget, bus } = mount({ reactToAlerts: false });
    bus.emit(EVENT_TYPES.ALERT, { kind: "donation", amount: 200 });
    expect(widget.element.classList.contains("is-burst")).toBe(false);
    widget.unmount();
  });
});
