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
const LayerComposition = require("../shared/layer-composition");
const LayerAlertWidget = require("../overlay/widgets/layer-alert-widget");

// ---- minimal DOM mock ----

function makeElement(tag) {
  const children = [];
  const classes = new Set();
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    style: {
      setProperty(key, value) {
        this[key] = value;
      },
    },
    dataset: {},
    children,
    hidden: false,
    parentNode: null,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    appendChild(child) {
      child.parentNode = el;
      children.push(child);
      return child;
    },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    set innerHTML(value) {
      children.forEach((child) => {
        child.parentNode = null;
      });
      children.length = 0;
      el._html = String(value);
    },
    get innerHTML() {
      return el._html || "";
    },
  };
  return el;
}

function makeDocument() {
  const doc = {
    createElement: (tag) => {
      const el = makeElement(tag);
      el.ownerDocument = doc;
      return el;
    },
  };
  return doc;
}

// ---- model ----

describe("layer-composition: модель", () => {
  test("normalizeConfig заполняет умолчания и разводит одинаковые id", () => {
    const config = LayerComposition.normalizeConfig({
      eventKinds: ["donation", "donation", ""],
      layers: [
        { id: "same", text: "a", start: -100, duration: 0 },
        { id: "same", type: "image", opacity: 5 },
        { type: "видео" },
      ],
    });

    expect(config.eventKinds).toEqual(["donation"]);
    expect(config.layers).toHaveLength(3);
    expect(config.layers[0].id).toBe("same");
    expect(config.layers[1].id).toBe("same-2");
    expect(config.layers[0].start).toBe(0);
    expect(config.layers[0].duration).toBe(LayerComposition.MIN_LAYER_MS);
    expect(config.layers[1].opacity).toBe(1);
    // Неизвестный тип не роняет слой: он становится текстовым.
    expect(config.layers[2].type).toBe("text");
  });

  test("compositionDuration учитывает самый поздний слой", () => {
    expect(
      LayerComposition.compositionDuration({
        durationMs: 3000,
        layers: [{ start: 1000, duration: 5000 }],
      })
    ).toBe(6000);
    expect(LayerComposition.compositionDuration({ durationMs: 8000, layers: [] })).toBe(8000);
  });

  test("matchesEvent: пустой список — все события", () => {
    expect(LayerComposition.matchesEvent({}, { kind: "follow" })).toBe(true);
    expect(LayerComposition.matchesEvent({ eventKinds: [] }, { kind: "follow" })).toBe(true);
    expect(
      LayerComposition.matchesEvent({ eventKinds: ["donation"] }, { kind: "follow" })
    ).toBe(false);
    expect(
      LayerComposition.matchesEvent({ eventKinds: ["donation"] }, { kind: "donation" })
    ).toBe(true);
  });

  test("fillText подставляет событие и не оставляет неизвестных ключей", () => {
    const text = LayerComposition.fillText(
      "{{user}} — {{amount}} {{currency}}: {{message}} {{nope}}",
      { user: "Stargazer", amount: 1500, currency: "RUB", message: "Привет" },
      { formatMoney: (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " "), currencySymbol: () => "₽" }
    );
    expect(text).toBe("Stargazer — 1 500 ₽: Привет ");
  });

  test("normalizeConfig хранит реакции категорий и отбрасывает мусор", () => {
    const reactions = JSON.parse(
      '{"donation":{"durationMs":5000,"layers":[{"text":"donation"}]},"__proto__":{"layers":[]},"broken":42}'
    );
    const config = LayerComposition.normalizeConfig({
      layers: [{ text: "default" }],
      reactions,
    });

    expect(Object.keys(config.reactions)).toEqual(["donation"]);
    expect(config.reactions.donation.durationMs).toBe(5000);
    expect(config.reactions.donation.layers[0].text).toBe("donation");
  });

  test("compositionForEvent берёт реакцию категории, иначе общую", () => {
    const config = {
      durationMs: 6000,
      layers: [{ id: "d", text: "default" }],
      reactions: {
        donation: { durationMs: 4000, layers: [{ id: "x", text: "donation" }] },
        follow: { durationMs: 3000, layers: [] },
      },
    };

    expect(LayerComposition.compositionForEvent(config, "donation").layers[0].text).toBe(
      "donation"
    );
    // Категория без своей реакции наследует общую.
    expect(LayerComposition.compositionForEvent(config, "sub").layers[0].text).toBe("default");
    // Пустая своя реакция — осмысленное «молчать», а не откат к общей.
    expect(LayerComposition.compositionForEvent(config, "follow").layers).toEqual([]);
  });

  test("applyLayerDrag переносит и растягивает слой как в OBS", () => {
    const rect = { x: 10, y: 20, w: 30, h: 40 };

    expect(LayerComposition.applyLayerDrag(rect, "move", 5, -5)).toEqual({
      x: 15,
      y: 15,
      w: 30,
      h: 40,
    });
    // Восточная сторона тянет только ширину.
    expect(LayerComposition.applyLayerDrag(rect, "e", 10, 0)).toEqual({
      x: 10,
      y: 20,
      w: 40,
      h: 40,
    });
    // Западная — двигает левый край, сохраняя правый на месте.
    expect(LayerComposition.applyLayerDrag(rect, "w", 10, 0)).toEqual({
      x: 20,
      y: 20,
      w: 20,
      h: 40,
    });
    // Юго-восточный угол тянет оба размера.
    expect(LayerComposition.applyLayerDrag(rect, "se", 10, 10)).toEqual({
      x: 10,
      y: 20,
      w: 40,
      h: 50,
    });
    // Северо-западный — оба края и оба размера.
    expect(LayerComposition.applyLayerDrag(rect, "nw", 10, 10)).toEqual({
      x: 20,
      y: 30,
      w: 20,
      h: 30,
    });
    // За минимальный размер рамка не переворачивается.
    expect(LayerComposition.applyLayerDrag(rect, "w", 100, 0)).toEqual({
      x: 39,
      y: 20,
      w: 1,
      h: 40,
    });
  });

  test("normalizeComposition знает режим списка", () => {
    const plain = LayerComposition.normalizeComposition({});
    expect(plain.stack).toBe(false);
    expect(plain.stackMax).toBe(3);

    expect(LayerComposition.normalizeComposition({ stack: true, stackMax: 9 }).stackMax).toBe(6);
    expect(LayerComposition.normalizeComposition({ stack: true, stackMax: 0 }).stackMax).toBe(2);
  });

  test("compositionForEvent переносит настройки списка", () => {
    const config = {
      stack: true,
      stackMax: 4,
      layers: [{ text: "default" }],
      reactions: {
        follow: { stack: false, stackMax: 2, layers: [{ text: "follow" }] },
      },
    };

    const inherited = LayerComposition.compositionForEvent(config, "donation");
    expect(inherited.stack).toBe(true);
    expect(inherited.stackMax).toBe(4);
    expect(LayerComposition.compositionForEvent(config, "follow").stack).toBe(false);
  });
});

// ---- static render ----

describe("layer-composition: статичная раскладка", () => {
  test("рисует текстовый слой с координатами и подставленным текстом", () => {
    const doc = makeDocument();
    const host = doc.createElement("div");
    LayerComposition.renderStatic(
      host,
      {
        layers: [
          {
            id: "t",
            type: "text",
            text: "{{user}}",
            x: 12,
            y: 34,
            w: 50,
            h: 20,
            opacity: 0.5,
            size: 7,
            color: "#00ff66",
            align: "right",
            weight: 700,
            fit: null,
            in: "none",
            out: "none",
          },
        ],
      },
      { user: "Pilot" },
      {}
    );

    expect(host.children).toHaveLength(1);
    const root = host.children[0];
    expect(root.className).toBe("la-composition");
    const layer = root.children[0];
    expect(layer.style.left).toBe("12%");
    expect(layer.style.top).toBe("34%");
    expect(layer.style.width).toBe("50%");
    expect(layer.style.opacity).toBe("0.5");
    const text = layer.children[0];
    expect(text.textContent).toBe("Pilot");
    expect(text.style.fontSize).toBe("calc(7cqw * var(--la-text-scale, 1))");
    expect(text.style.color).toBe("#00ff66");
    expect(text.style.textAlign).toBe("right");
  });
});

// ---- player ----

describe("layer-composition: проигрыватель", () => {
  let realDocument;
  let realRaf;
  let realCancel;

  beforeEach(() => {
    jest.useFakeTimers();
    realDocument = global.document;
    realRaf = global.requestAnimationFrame;
    realCancel = global.cancelAnimationFrame;
    global.document = makeDocument();
    global.requestAnimationFrame = (fn) => setTimeout(fn, 16);
    global.cancelAnimationFrame = (id) => clearTimeout(id);
  });

  afterEach(() => {
    jest.useRealTimers();
    global.document = realDocument;
    global.requestAnimationFrame = realRaf;
    global.cancelAnimationFrame = realCancel;
  });

  test("зовёт onDone по времени композиции и пережидает паузу между слоями", () => {
    const host = global.document.createElement("div");
    const player = LayerComposition.createPlayer(host, {});
    const done = jest.fn();

    const total = player.play(
      {
        durationMs: 2000,
        layers: [{ type: "text", text: "a", start: 0, duration: 800, in: "none", out: "none" }],
      },
      {},
      done
    );

    expect(total).toBe(2000);
    jest.advanceTimersByTime(1999);
    expect(done).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("stop отменяет проигрывание и не зовёт onDone", () => {
    const host = global.document.createElement("div");
    const player = LayerComposition.createPlayer(host, {});
    const done = jest.fn();

    player.play(
      {
        durationMs: 1000,
        layers: [{ type: "text", text: "a", start: 0, duration: 500, in: "none", out: "none" }],
      },
      {},
      done
    );
    player.stop();
    jest.advanceTimersByTime(5000);
    expect(done).not.toHaveBeenCalled();
    expect(host.children).toHaveLength(0);
  });
});

// ---- widget ----

describe("layer-composition: список", () => {
  let realDocument;
  let realRaf;

  beforeEach(() => {
    jest.useFakeTimers();
    realDocument = global.document;
    realRaf = global.requestAnimationFrame;
    global.document = makeDocument();
    global.requestAnimationFrame = (fn) => setTimeout(fn, 16);
  });

  afterEach(() => {
    jest.useRealTimers();
    global.document = realDocument;
    global.requestAnimationFrame = realRaf;
  });

  function textOf(item) {
    return item.children[0].children[0].children[0].textContent;
  }

  // Строки позиционируются абсолютно, поэтому порядок в DOM не совпадает с
  // визуальным: ищем по `top`, как его видит зритель.
  function atTop(host) {
    return Array.from(host.children).find((child) => child.style.top === "0%");
  }

  function atSecond(host) {
    return Array.from(host.children).find((child) => child.style.top === "50%");
  }

  function pushText(stack, text, duration, max) {
    stack.push(
      {
        durationMs: duration || 1000,
        stack: true,
        stackMax: max || 2,
        layers: [
          {
            id: text,
            type: "text",
            text,
            start: 0,
            duration: (duration || 1000) - 100,
            in: "none",
            out: "none",
          },
        ],
      },
      {}
    );
  }

  test("новое событие сверху, старое сдвигается вниз", () => {
    const host = global.document.createElement("div");
    const stack = LayerComposition.createStack(host, {});

    pushText(stack, "Vasya");
    expect(stack.size()).toBe(1);
    expect(textOf(atTop(host))).toBe("Vasya");

    pushText(stack, "Petya");
    expect(stack.size()).toBe(2);
    expect(textOf(atTop(host))).toBe("Petya");
    expect(textOf(atSecond(host))).toBe("Vasya");
  });

  test("при переполнении уходит самая старая строка", () => {
    const host = global.document.createElement("div");
    const stack = LayerComposition.createStack(host, {});

    pushText(stack, "Vasya");
    pushText(stack, "Petya");
    pushText(stack, "Ivan");
    expect(stack.size()).toBe(2);

    jest.advanceTimersByTime(300);
    expect(host.children).toHaveLength(2);
    expect(textOf(atTop(host))).toBe("Ivan");
    expect(textOf(atSecond(host))).toBe("Petya");
  });

  test("после последней строки зовёт onEmpty", () => {
    const host = global.document.createElement("div");
    const stack = LayerComposition.createStack(host, {});
    const empty = jest.fn();
    stack.onEmpty(empty);

    pushText(stack, "Vasya", 500);
    expect(empty).not.toHaveBeenCalled();
    jest.advanceTimersByTime(800);

    expect(stack.size()).toBe(0);
    expect(empty).toHaveBeenCalledTimes(1);
  });
});

describe("layer-alert: виджет", () => {
  let realDocument;
  let realRaf;
  let realCancel;

  beforeEach(() => {
    jest.useFakeTimers();
    realDocument = global.document;
    realRaf = global.requestAnimationFrame;
    realCancel = global.cancelAnimationFrame;
    global.document = makeDocument();
    global.requestAnimationFrame = (fn) => setTimeout(fn, 16);
    global.cancelAnimationFrame = (id) => clearTimeout(id);
  });

  afterEach(() => {
    jest.useRealTimers();
    global.document = realDocument;
    global.requestAnimationFrame = realRaf;
    global.cancelAnimationFrame = realCancel;
  });

  function mountWidget(config) {
    const bus = new EventBus();
    const context = {
      bus,
      EVENT_TYPES,
      formatMoney: (value) => String(value),
      currencySymbol: (value) => value,
      resolveMediaUrl: (value) => value,
    };
    const widget = new LayerAlertWidget(
      {
        id: "w1",
        type: "layer-alert",
        x: 0,
        y: 0,
        w: 40,
        h: 20,
        z: 0,
        visible: true,
        config: config || {
          eventKinds: ["donation"],
          durationMs: 1000,
          layers: [
            {
              id: "t",
              type: "text",
              text: "{{user}}",
              start: 0,
              duration: 900,
              in: "none",
              out: "none",
            },
          ],
        },
      },
      context
    );
    const parent = global.document.createElement("div");
    widget.mount(parent);
    return { bus, widget };
  }

  test("игнорирует события не из своего списка и играет подходящие по очереди", () => {
    const { bus, widget } = mountWidget();

    bus.emit(EVENT_TYPES.ALERT, { kind: "follow", user: "A" });
    expect(widget.queueHost.children).toHaveLength(0);

    bus.emit(EVENT_TYPES.ALERT, { kind: "donation", user: "First" });
    expect(widget.queueHost.children).toHaveLength(1);
    const first = widget.queueHost.children[0];
    expect(first.children[0].children[0].textContent).toBe("First");

    // Второй донат ждёт, пока не доиграет первый: одновременно их не бывает.
    bus.emit(EVENT_TYPES.ALERT, { kind: "donation", user: "Second" });
    expect(widget.queueHost.children).toHaveLength(1);

    jest.advanceTimersByTime(1000);
    expect(widget.queueHost.children).toHaveLength(1);
    const second = widget.queueHost.children[0];
    expect(second.children[0].children[0].textContent).toBe("Second");

    jest.advanceTimersByTime(1000);
    expect(widget.queueHost.children).toHaveLength(0);
  });

  test("играет свою реакцию категории вместо общей", () => {
    const { bus, widget } = mountWidget({
      eventKinds: [],
      durationMs: 1000,
      layers: [{ id: "base", type: "text", text: "common", start: 0, duration: 900, in: "none", out: "none" }],
      reactions: {
        donation: {
          durationMs: 1000,
          layers: [{ id: "own", type: "text", text: "donation!", start: 0, duration: 900, in: "none", out: "none" }],
        },
      },
    });

    bus.emit(EVENT_TYPES.ALERT, { kind: "donation" });
    expect(widget.queueHost.children[0].children[0].children[0].textContent).toBe("donation!");
  });

  test("пустая реакция категории молчит, не занимая эфир", () => {
    const { bus, widget } = mountWidget({
      eventKinds: [],
      durationMs: 1000,
      layers: [{ id: "base", type: "text", text: "common", start: 0, duration: 900, in: "none", out: "none" }],
      reactions: { donation: { durationMs: 1000, layers: [] } },
    });

    bus.emit(EVENT_TYPES.ALERT, { kind: "donation" });
    expect(widget.queueHost.children).toHaveLength(0);

    // Остальные категории по-прежнему идут по общей композиции.
    bus.emit(EVENT_TYPES.ALERT, { kind: "follow" });
    expect(widget.queueHost.children[0].children[0].children[0].textContent).toBe("common");
  });

  test("в режиме списка показывает несколько событий и сдвигает старые", () => {
    const { bus, widget } = mountWidget({
      eventKinds: [],
      durationMs: 1000,
      stack: true,
      stackMax: 2,
      layers: [
        { id: "row", type: "text", text: "{{user}}", start: 0, duration: 900, in: "none", out: "none" },
      ],
    });

    bus.emit(EVENT_TYPES.ALERT, { kind: "follow", user: "Vasya" });
    expect(widget.stack.size()).toBe(1);
    const rowAt = (top) =>
      Array.from(widget.stackHost.children).find((el) => el.style.top === top);
    const textOfRow = (el) => el.children[0].children[0].children[0].textContent;
    expect(textOfRow(rowAt("0%"))).toBe("Vasya");

    bus.emit(EVENT_TYPES.ALERT, { kind: "follow", user: "Petya" });
    expect(widget.stack.size()).toBe(2);
    expect(textOfRow(rowAt("0%"))).toBe("Petya");
    expect(textOfRow(rowAt("50%"))).toBe("Vasya");

    // Третья строка вытесняет самую старую.
    bus.emit(EVENT_TYPES.ALERT, { kind: "follow", user: "Ivan" });
    expect(widget.stack.size()).toBe(2);
    jest.advanceTimersByTime(300);
    expect(widget.stackHost.children).toHaveLength(2);
    expect(textOfRow(rowAt("0%"))).toBe("Ivan");
    expect(textOfRow(rowAt("50%"))).toBe("Petya");
  });

  test("одиночный алерт ждёт, пока список освободит рамку", () => {
    const { bus, widget } = mountWidget({
      eventKinds: [],
      durationMs: 1000,
      layers: [{ id: "base", type: "text", text: "common", start: 0, duration: 900, in: "none", out: "none" }],
      reactions: {
        follow: {
          durationMs: 1000,
          stack: true,
          stackMax: 2,
          layers: [
            { id: "row", type: "text", text: "{{user}}", start: 0, duration: 900, in: "none", out: "none" },
          ],
        },
      },
    });

    bus.emit(EVENT_TYPES.ALERT, { kind: "follow", user: "Vasya" });
    expect(widget.stack.size()).toBe(1);

    // Донат не накладывается на список: ждёт, пока строки уйдут.
    bus.emit(EVENT_TYPES.ALERT, { kind: "donation" });
    expect(widget.playing).toBe(false);
    expect(widget.queueHost.children).toHaveLength(0);

    jest.advanceTimersByTime(1300);
    expect(widget.stack.size()).toBe(0);
    expect(widget.queueHost.children[0].children[0].children[0].textContent).toBe("common");
  });
});
