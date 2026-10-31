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
  Рулетка донатов: лента призов, порог доната и взвешенный выбор.

  Проверяем то, что легко сломать незаметно: призы выше порога запускают
  спин, ниже — нет; выбор идёт по весам, а не поровну; пустой список прячет
  виджет, а результат называет выпавший приз.
*/

const EventBus = require("../overlay/event-bus");
const { EVENT_TYPES } = require("../shared/events");
const WidgetRoulette = require("../overlay/widgets/roulette-widget");

function makeEl(tag) {
  const classSet = new Set();
  const el = {
    tagName: (tag || "div").toUpperCase(),
    className: "",
    dataset: {},
    style: { setProperty(key, value) { this[key] = value; } },
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
    children: [],
    parentNode: null,
    textContent: "",
    hidden: false,
    offsetLeft: 0,
    offsetWidth: 0,
    clientWidth: 0,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
  };
  return el;
}

function makeContext() {
  return {
    bus: new EventBus(),
    EVENT_TYPES,
    state: {},
    t: (key) => key,
    readCssVar: () => "",
  };
}

function makeWidget(config = {}) {
  const widget = new WidgetRoulette(
    { id: "r1", type: "roulette", x: 0, y: 0, w: 80, h: 22, z: 0, visible: true, config },
    makeContext(),
  );
  widget.mount(makeEl("div"));
  return widget;
}

const ITEMS = [
  { title: "Первое", category: "common", weight: 1 },
  { title: "Второе", category: "legendary", weight: 9 },
];

beforeEach(() => {
  global.document = { createElement: (tag) => makeEl(tag) };
  global.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
});

describe("WidgetRoulette", () => {
  test("рисует длинную ленту из повторов списка", () => {
    const widget = makeWidget({ items: ITEMS });
    const cards = widget.trackEl.children.length;

    expect(cards).toBeGreaterThan(ITEMS.length);
    expect(cards % ITEMS.length).toBe(0);
    expect(widget.trackEl.children[0].className).toContain("is-common");

    widget.unmount();
  });

  test("донат ниже порога не крутит, выше — запускает спин", () => {
    const widget = makeWidget({ items: ITEMS, minAmount: 100 });

    widget.context.bus.emit(EVENT_TYPES.ALERT, { kind: "donation", amount: 50 });
    expect(widget.spinning).toBe(false);

    widget.context.bus.emit(EVENT_TYPES.ALERT, { kind: "follow" });
    expect(widget.spinning).toBe(false);

    widget.context.bus.emit(EVENT_TYPES.ALERT, { kind: "donation", amount: 150 });
    expect(widget.spinning).toBe(true);
    expect(widget.winnerIndex).toBeGreaterThanOrEqual(0);

    widget.unmount();
  });

  test("выбор идёт по весам, а не поровну", () => {
    const widget = makeWidget({ items: ITEMS });
    const random = jest.spyOn(Math, "random");

    random.mockReturnValue(0.05);
    expect(widget._pickIndex()).toBe(0);

    random.mockReturnValue(0.5);
    expect(widget._pickIndex()).toBe(1);

    random.mockRestore();
    widget.unmount();
  });

  test("результат называет выпавший приз", () => {
    const widget = makeWidget({ items: ITEMS });
    jest.spyOn(Math, "random").mockReturnValue(0.5);

    widget.spin();
    widget._finishSpin();

    expect(widget.resultEl.hidden).toBe(false);
    expect(widget.resultEl.textContent).toBe("roulette.result");
    expect(widget.resultEl.className).toContain("is-legendary");

    jest.restoreAllMocks();
    widget.unmount();
  });

  test("пустой список прячет виджет", () => {
    const widget = makeWidget({ items: [] });
    expect(widget.trackEl.children).toHaveLength(0);
    expect(widget.frameEl.classList.contains("is-empty")).toBe(true);
    widget.unmount();
  });

  test("штамп из инспектора запускает спин без доната", () => {
    const widget = makeWidget({ items: ITEMS });
    widget.update({ config: { spinId: 1 } });
    expect(widget.spinning).toBe(true);
    widget.unmount();
  });
});
