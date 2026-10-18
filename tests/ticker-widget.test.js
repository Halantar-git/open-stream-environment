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
const WidgetTicker = require("../overlay/widgets/ticker-widget");

function makeEl(tag) {
  const classSet = new Set();
  const styleProps = {};
  const el = {
    tagName: (tag || "div").toUpperCase(),
    className: "",
    dataset: {},
    style: {
      setProperty(key, value) {
        styleProps[key] = value;
      },
      getPropertyValue(key) {
        return styleProps[key] || "";
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
    innerHTML: "",
    textContent: "",
    parentNode: null,
    children: [],
    offsetWidth: 400,
    offsetHeight: 60,
    clientHeight: 60,
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
    cloneNode() {
      const copy = makeEl(this.tagName);
      copy.className = this.className;
      copy.dataset = { ...this.dataset };
      copy.textContent = this.textContent;
      this.children.forEach((child) => copy.appendChild(child.cloneNode(true)));
      return copy;
    },
    getBoundingClientRect() {
      return { width: this.className.includes("ticker__group") ? 300 : 400, height: 60, top: 0, left: 0 };
    },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(el, "firstChild", {
    get() {
      return this.children[0] || null;
    },
    configurable: true,
  });
  return el;
}

const TRANSLATIONS = {
  "ticker.label": "В ЭФИРЕ",
  "ticker.tagDonation": "ДОНАТ",
  "ticker.tagFollow": "ФОЛЛОУ",
  "ticker.tagSub": "ПОДПИСКА",
  "ticker.tagChat": "ЧАТ",
  "ticker.tagReward": "НАГРАДА",
  "ticker.tagMessage": "СООБЩЕНИЕ",
  "ticker.breakingLabel": "СРОЧНО",
  "ticker.donation": "{{user}} — {{amount}}",
  "ticker.follow": "Новый фолловер: {{user}}",
  "ticker.sub": "{{user}} оформил подписку (уровень {{tier}})",
  "ticker.reward": "{{user}} забрал награду",
  "ticker.rewardTitle": "{{user}} — {{reward}}",
  "ticker.chat": "{{user}}: {{message}}",
  "ticker.empty": "Пока тихо",
  "ticker.anonymous": "Аноним",
};

function makeContext(overrides = {}) {
  return {
    bus: new EventBus(),
    EVENT_TYPES,
    theme: "retrowave",
    state: { recentEvents: [], goal: null, topDonation: null },
    t: (key, params) => {
      const raw = TRANSLATIONS[key] || key;
      return String(raw).replace(/\{\{(\w+)\}\}/g, (_, name) => (params && params[name] != null ? params[name] : ""));
    },
    formatMoney: (n) => String(n),
    currencySymbol: () => "₽",
    ...overrides,
  };
}

function item(type = "ticker", config = {}) {
  return {
    id: "t",
    type,
    x: 3,
    y: 92,
    w: 94,
    h: 6,
    z: 0,
    visible: true,
    config,
    renderType: "2d",
  };
}

let originalDocument;
let originalWindow;
let originalRaf;
let originalCancelRaf;
let rafId;
let rafCallback;

beforeEach(() => {
  originalDocument = global.document;
  originalWindow = global.window;
  originalRaf = global.requestAnimationFrame;
  originalCancelRaf = global.cancelAnimationFrame;
  rafId = 0;
  rafCallback = null;

  global.document = {
    createElement: (tag) => makeEl(tag),
    addEventListener() {},
    removeEventListener() {},
    hidden: false,
    fonts: { ready: Promise.resolve() },
  };
  global.window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  };
  global.requestAnimationFrame = (fn) => {
    rafCallback = fn;
    return ++rafId;
  };
  global.cancelAnimationFrame = () => {};
});

afterEach(() => {
  global.document = originalDocument;
  global.window = originalWindow;
  global.requestAnimationFrame = originalRaf;
  global.cancelAnimationFrame = originalCancelRaf;
});

describe("WidgetTicker", () => {
  test("монтирует полосу с меткой и дублирует трек для бесшовного хода", () => {
    const w = new WidgetTicker(item(), makeContext());
    w.mount(makeEl("div"));

    expect(w.element.classList.contains("ticker")).toBe(true);
    expect(w.labelEl.textContent).toBe("В ЭФИРЕ");
    expect(w.trackEl.children.length).toBeGreaterThanOrEqual(2);

    w.unmount();
  });

  test("донат попадает в ленту один раз", () => {
    const ctx = makeContext();
    const w = new WidgetTicker(item(), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "donation", user: "bob", amount: 150, currency: "RUB", message: "на корабль" });
    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "donation", user: "bob", amount: 150, currency: "RUB", message: "на корабль" });

    const items = w._items();
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain("bob");
    expect(items[0].text).toContain("+150 ₽");
    expect(items[0].text).toContain("на корабль");

    w.unmount();
  });

  test("выключенный источник не попадает в ленту", () => {
    const ctx = makeContext();
    const w = new WidgetTicker(item("ticker", { sources: { follows: false } }), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "follow", user: "alice" });
    expect(w._items()).toHaveLength(0);

    w.unmount();
  });

  test("чат выключен по умолчанию, включается настройкой и не берёт команды", () => {
    const off = makeContext();
    const wOff = new WidgetTicker(item(), off);
    wOff.mount(makeEl("div"));
    off.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "alice", message: "привет" });
    expect(wOff._items()).toHaveLength(0);
    wOff.unmount();

    const on = makeContext();
    const wOn = new WidgetTicker(item("ticker", { sources: { chat: true } }), on);
    wOn.mount(makeEl("div"));
    on.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "alice", message: "привет" });
    wOn._lastChatTs = 0;
    on.bus.emit(EVENT_TYPES.CHAT_MESSAGE, { user: "alice", message: "!poll 1" });
    const items = wOn._items();
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("alice: привет");

    wOn.unmount();
  });

  test("3D-тип получает класс ticker--3d", () => {
    const w = new WidgetTicker(item("retrowave-ticker"), makeContext());
    w.mount(makeEl("div"));
    expect(w.element.classList.contains("ticker--3d")).toBe(true);
    w.unmount();
  });

  test("направление справа налево и слева направо", () => {
    const left = new WidgetTicker(item(), makeContext());
    left.mount(makeEl("div"));
    left._cycle = 300;
    left._offset = 50;
    left._applyTransform();
    expect(left.trackEl.style.transform).toBe("translate3d(-50.00px, 0, 0)");
    left.unmount();

    const right = new WidgetTicker(item("ticker", { direction: "right" }), makeContext());
    right.mount(makeEl("div"));
    right._cycle = 300;
    right._offset = 50;
    right._applyTransform();
    expect(right.trackEl.style.transform).toBe("translate3d(-250.00px, 0, 0)");
    right.unmount();
  });

  test("скорость зажимается в разумные рамки", () => {
    const slow = new WidgetTicker(item("ticker", { speed: 1 }), makeContext());
    slow._applyConfig();
    expect(slow._speed).toBe(20);

    const fast = new WidgetTicker(item("ticker", { speed: 9999 }), makeContext());
    fast._applyConfig();
    expect(fast._speed).toBe(200);
  });

  test("сдвиг считается от времени, а не от количества кадров", () => {
    const w = new WidgetTicker(item("ticker", { speed: 100 }), makeContext());
    w.mount(makeEl("div"));
    w._stop();
    w._offset = 0;
    w._start();

    const tick = rafCallback;
    expect(typeof tick).toBe("function");
    // Кадры по 16 мс: движок ограничивает шаг 64 мс, чтобы после сворачивания
    // окна лента не прыгала, поэтому «секунду» набираем несколькими кадрами.
    for (let i = 1; i <= 64; i++) tick(i * 16);
    // 100 px/s и 1008 мс после первого кадра — сдвиг ~100.8 px.
    expect(w._offset).toBeCloseTo(100.8, 0);

    w.unmount();
  });

  test("произвольное сообщение встаёт в ленту с меткой", () => {
    const ctx = makeContext();
    const w = new WidgetTicker(item(), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.TICKER_MESSAGE, { text: "Скоро розыгрыш" });

    const items = w._items();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("message");
    expect(items[0].tag).toBe("СООБЩЕНИЕ");
    expect(items[0].text).toBe("Скоро розыгрыш");

    w.unmount();
  });

  test("одинаковые сообщения не схлопываются", () => {
    const ctx = makeContext();
    const w = new WidgetTicker(item(), ctx);
    w.mount(makeEl("div"));

    // Дедупликация нужна повторным событиям из снимка состояния, а ручное
    // сообщение стример может отправить дважды осознанно.
    ctx.bus.emit(EVENT_TYPES.TICKER_MESSAGE, { text: "Повтор" });
    ctx.bus.emit(EVENT_TYPES.TICKER_MESSAGE, { text: "Повтор" });

    expect(w._items().map((i) => i.text)).toEqual(["Повтор", "Повтор"]);

    w.unmount();
  });

  test("срочное сообщение показывается полосой и уступает место следующему", () => {
    jest.useFakeTimers();
    const ctx = makeContext();
    const w = new WidgetTicker(item(), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.TICKER_MESSAGE, { text: "Первое", priority: "breaking", durationMs: 3000 });
    expect(w.breakingEl.classList.contains("is-visible")).toBe(true);
    expect(w.breakingTextEl.textContent).toBe("Первое");
    // Срочная полоса не засоряет обычную ленту.
    expect(w._items()).toHaveLength(0);

    ctx.bus.emit(EVENT_TYPES.TICKER_MESSAGE, { text: "Второе", priority: "breaking", durationMs: 3000 });
    // Второе ждёт в очереди, пока на экране первое.
    expect(w.breakingTextEl.textContent).toBe("Первое");

    jest.advanceTimersByTime(3000);
    expect(w.breakingTextEl.textContent).toBe("Второе");
    expect(w.breakingEl.classList.contains("is-visible")).toBe(true);

    jest.advanceTimersByTime(3000);
    expect(w.breakingEl.classList.contains("is-visible")).toBe(false);

    w.unmount();
    jest.useRealTimers();
  });

  test("награда за баллы канала показывает название и ввод", () => {
    const ctx = makeContext();
    const w = new WidgetTicker(item(), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.REWARD_REDEEM, {
      kind: "reward",
      user: "bob",
      rewardTitle: "Сменить сцену",
      message: "brb",
      userInput: "brb",
    });

    const items = w._items();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("reward");
    expect(items[0].tag).toBe("НАГРАДА");
    expect(items[0].text).toBe("bob — Сменить сцену — brb");

    w.unmount();
  });

  test("награда из алерта берёт ввод зрителя, а не шаблон сообщения", () => {
    const ctx = makeContext();
    const w = new WidgetTicker(item(), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.ALERT, {
      kind: "reward",
      user: "bob",
      rewardTitle: "Песня",
      userInput: "включи",
      message: "bob: включи",
    });

    expect(w._items()[0].text).toBe("bob — Песня — включи");

    w.unmount();
  });

  test("снимок состояния наполняет ленту прошлыми событиями", () => {
    const ctx = makeContext({
      state: {
        recentEvents: [
          { kind: "follow", user: "newest" },
          { kind: "donation", user: "older", amount: 50, currency: "RUB" },
        ],
        goal: null,
        topDonation: null,
      },
    });
    const w = new WidgetTicker(item(), ctx);
    w.mount(makeEl("div"));

    const items = w._items();
    expect(items).toHaveLength(2);
    // Хронологический порядок: старые слева, новые справа.
    expect(items[0].text).toContain("older");
    expect(items[1].text).toContain("newest");

    w.unmount();
  });
});
