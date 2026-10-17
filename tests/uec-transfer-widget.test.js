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
const WidgetUecTransfer = require("../overlay/widgets/uec-transfer-widget");

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
    innerHTML: "",
    textContent: "",
    parentNode: null,
    children: [],
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
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
  };
  return el;
}

function makeContext(overrides = {}) {
  return {
    bus: new EventBus(),
    EVENT_TYPES,
    theme: "grimhex",
    t: (key) => key,
    formatMoney: (n) => String(n),
    currencySymbol: () => "₽",
    ...overrides,
  };
}

function item(overrides = {}) {
  return {
    id: "u",
    type: "uec-transfer",
    x: 25,
    y: 3,
    w: 50,
    h: 20,
    z: 0,
    visible: true,
    config: {},
    renderType: "2d",
    ...overrides,
  };
}

function donation(overrides = {}) {
  return {
    kind: "donation",
    user: "bob_the_pilot",
    amount: 150,
    currency: "RUB",
    message: "на корабль",
    ...overrides,
  };
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

describe("WidgetUecTransfer", () => {
  test("до первого алерта ничего не показывает", () => {
    const parent = makeEl("div");
    const w = new WidgetUecTransfer(item(), makeContext());
    w.mount(parent);

    expect(w.element.style.opacity).toBe("0");
    expect(w.element.classList.contains("is-compact")).toBe(false);
    expect(w.element.classList.contains("is-expanded")).toBe(false);

    w.unmount();
  });

  test("донат начинается с компактной плашки «входящее сообщение»", () => {
    const ctx = makeContext();
    const w = new WidgetUecTransfer(item(), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.ALERT, donation());

    expect(w.element.classList.contains("is-compact")).toBe(true);
    expect(w.compactTextEl.textContent).toBe("uec.incoming");
    expect(w.channelEl.textContent).toBe("uec.channel");
    expect(w.titleEl.textContent).toBe("uec.transmission");
    expect(w.chipEl.textContent).toBe("uec.chipDonation");
    expect(w.creditLabelEl.textContent).toBe("uec.credited");
    expect(w.amountEl.textContent).toBe("+150 ₽");
    // Текст сообщения тоже стартует «шифром», как и ник.
    expect(w.messageEl.textContent).not.toBe("на корабль");
    // Ник ещё не раскрыт: это должен быть «шифр», а не готовое имя.
    expect(w.nameEl.textContent).not.toBe("bob_the_pilot");

    w.unmount();
  });

  test("после паузы панель раскрывается и ник расшифровывается", () => {
    const ctx = makeContext();
    const w = new WidgetUecTransfer(item(), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.ALERT, donation());
    jest.advanceTimersByTime(1400);

    expect(w.element.classList.contains("is-compact")).toBe(false);
    expect(w.element.classList.contains("is-expanded")).toBe(true);
    expect(w.nameEl.textContent).not.toBe("bob_the_pilot");
    // Текст сообщения тоже появляется «шифром», а не сразу читаемым.
    expect(w.messageEl.textContent).not.toBe("на корабль");

    // По одному символу за тик — тринадцати тиков хватает на этот ник, а
    // сообщение укладывается в то же время.
    jest.advanceTimersByTime(1100);
    expect(w.nameEl.textContent).toBe("bob_the_pilot");
    expect(w.messageEl.textContent).toBe("на корабль");
    expect(w.panelEl.classList.contains("is-decoded")).toBe(true);

    w.unmount();
  });

  test("по окончании прячет плашку и берёт следующий алерт из очереди", () => {
    const ctx = makeContext();
    const w = new WidgetUecTransfer(item({ config: { durationMs: 4000 } }), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.ALERT, donation({ user: "first" }));
    ctx.bus.emit(EVENT_TYPES.ALERT, donation({ user: "second", amount: 50 }));

    expect(w.current.user).toBe("first");
    expect(w.queue).toHaveLength(1);

    jest.advanceTimersByTime(4000);
    expect(w.current.user).toBe("second");
    expect(w.element.classList.contains("is-compact")).toBe(true);
    expect(w.queue).toHaveLength(0);

    jest.advanceTimersByTime(4000);
    expect(w.current).toBeNull();
    expect(w.element.style.opacity).toBe("0");

    w.unmount();
  });

  test("showAmount=false и showMessage=false убирают сумму и лог связи", () => {
    const ctx = makeContext();
    const w = new WidgetUecTransfer(
      item({ config: { showAmount: false, showMessage: false } }),
      ctx
    );
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.ALERT, donation());

    expect(w.amountEl.style.display).toBe("none");
    expect(w.creditLabelEl.style.display).toBe("none");
    expect(w.panelEl.classList.contains("is-no-message")).toBe(true);

    w.unmount();
  });

  test("не-денежные события получают свои подписи", () => {
    const ctx = makeContext();
    const w = new WidgetUecTransfer(item(), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.ALERT, { kind: "follow", user: "alice" });
    expect(w.chipEl.textContent).toBe("uec.chipFollow");
    expect(w.creditLabelEl.textContent).toBe("uec.registered");
    expect(w.amountEl.style.display).toBe("none");
    expect(w.messageLabelEl.textContent).toBe("uec.details");
    expect(w._messageText).toBe("uec.detailFollow");

    w.unmount();
  });

  test("sub и gift_sub показывают уровень и количество", () => {
    const w = new WidgetUecTransfer(item(), makeContext());

    expect(w.tierLabel("1000")).toBe("1");
    expect(w.tierLabel("3000")).toBe("3");
    expect(w.tierLabel("Prime")).toBe("Prime");
    expect(w.tierLabel("")).toBe("1");

    expect(w.detailText({ kind: "sub", tier: "2000" })).toBe("uec.detailSub");
    expect(w.detailText({ kind: "gift_sub", count: 5, tier: "1000" })).toBe("uec.detailGift");
    expect(w.detailText({ kind: "follow" })).toBe("uec.detailFollow");

    w.unmount();
  });

  test("сумма доната красится по tier'ам, как в TESO-алерте", () => {
    const cases = [
      [150, "#ffffff"],
      [250, "#2dc50e"],
      [450, "#3a92ff"],
      [650, "#a02dc5"],
      [850, "#e5a823"],
      [1000, "#ee6a00"],
    ];

    cases.forEach(([amount, color]) => {
      const ctx = makeContext();
      const w = new WidgetUecTransfer(item(), ctx);
      w.mount(makeEl("div"));

      ctx.bus.emit(EVENT_TYPES.ALERT, donation({ amount }));
      expect(w.asideEl.style.getPropertyValue("--uec-amount-color")).toBe(color);

      w.unmount();
    });
  });

  test("decodeTickMs задаёт шаг дешифровки", () => {
    const ctx = makeContext();
    const w = new WidgetUecTransfer(item({ config: { decodeTickMs: 200 } }), ctx);
    w.mount(makeEl("div"));

    expect(w.decodeTickMs()).toBe(200);

    ctx.bus.emit(EVENT_TYPES.ALERT, donation());
    jest.advanceTimersByTime(1400 + 600);
    expect(w.nameEl.textContent).not.toBe("bob_the_pilot");

    jest.advanceTimersByTime(2200);
    expect(w.nameEl.textContent).toBe("bob_the_pilot");
    expect(w.messageEl.textContent).toBe("на корабль");

    w.unmount();
  });

  test("decodeTickMs зажимается в разумные рамки", () => {
    const fast = new WidgetUecTransfer(item({ config: { decodeTickMs: 1 } }), makeContext());
    expect(fast.decodeTickMs()).toBe(10);

    const slow = new WidgetUecTransfer(item({ config: { decodeTickMs: 9999 } }), makeContext());
    expect(slow.decodeTickMs()).toBe(500);

    const fallback = new WidgetUecTransfer(item(), makeContext());
    expect(fallback.decodeTickMs()).toBe(76);
  });

  test("длинный текст доната не обрезается виджетом", () => {
    const long =
      "Спасибо за поддержку канала и за уютную атмосферу на каждом стриме! Твой вклад очень важен, он помогает каналу расти и развиваться дальше. Желаю тебе удачи, вдохновения, здоровья и как можно больше позитивных эмоций! Пусть каждый новый день приносит хорошие новости, интересные идеи и верных друзей. Спасибо, что ты с нами, что делишься теплом и делаешь этот канал немного лучше! Пусть впереди будет ещё много ярких стримов и приятных встреч!";
    const ctx = makeContext();
    const w = new WidgetUecTransfer(item(), ctx);
    w.mount(makeEl("div"));

    ctx.bus.emit(EVENT_TYPES.ALERT, donation({ message: long }));
    expect(w._messageText).toBe(long);

    w.unmount();
  });

  test("длинное сообщение растит панель до низа экрана", () => {
    const hadWindow = "window" in global;
    const prevWindow = global.window;
    global.window = { innerHeight: 1080 };

    const w = new WidgetUecTransfer(item({ y: 10 }), makeContext());
    w.mount(makeEl("div"));
    w.element.clientHeight = 216;

    w.panelEl.offsetHeight = 800;
    w._fitHeight();
    expect(w.element.style.height).toBe("802px");

    // Даже очень длинный текст не выводит панель за нижнюю границу окна.
    w.panelEl.offsetHeight = 2000;
    w._fitHeight();
    expect(w.element.style.height).toBe("964px");

    w.unmount();
    if (hadWindow) global.window = prevWindow;
    else delete global.window;
  });
});
