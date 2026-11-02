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
  Прокси пакетного виджета: сторона оверлея.

  Проверяем мост, а не разметку: рамка создаётся закрытой, получает настройки,
  тему и только те события, на которые подписался код пакета, а размонтирование
  снимает подписки и слушателя сообщений.
*/

function cssStyle() {
  const props = new Map();
  const target = {
    setProperty(name, value) {
      props.set(name, value);
    },
    getPropertyValue(name) {
      return props.get(name) || "";
    },
    get length() {
      return props.size;
    },
  };
  return new Proxy(target, {
    get(object, key) {
      if (key in object) return object[key];
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0) return Array.from(props.keys())[index];
      return undefined;
    },
  });
}

function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    className: "",
    style: cssStyle(),
    dataset: {},
    children: [],
    classList: { list: [], add(name) { this.list.push(name); } },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this[name] = value;
    },
  };
}

function setup() {
  const posted = [];
  const listeners = [];
  const html = makeElement("html");
  const body = makeElement("body");

  const document = {
    documentElement: html,
    body,
    createElement(tag) {
      const element = makeElement(tag);
      if (element.tagName === "IFRAME") {
        element.contentWindow = { postMessage: (message) => posted.push(message) };
      }
      return element;
    },
    getElementById: () => null,
    querySelectorAll: () => [],
  };

  const window = {
    document,
    I18n: { getLang: () => "ru" },
    addEventListener: (type, handler) => listeners.push({ type, handler }),
    removeEventListener: (type, handler) => {
      const index = listeners.findIndex((item) => item.type === type && item.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };

  global.window = window;
  global.document = document;
  jest.resetModules();
  const { createPluginWidget } = require("../overlay/widgets/plugin-widget");
  return { createPluginWidget, posted, listeners, document, html, body };
}

function makeBus() {
  const handlers = new Map();
  return {
    handlers,
    on(channel, handler) {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel).add(handler);
      return () => handlers.get(channel).delete(handler);
    },
    emit(channel, payload) {
      (handlers.get(channel) || new Set()).forEach((handler) => handler(payload));
    },
  };
}

const plugin = {
  id: "hello",
  baseUrl: "/plugins/hello/",
  entry: "widget.js",
  styles: ["widget.css"],
};

function mountWidget(env, overrides = {}) {
  const Widget = env.createPluginWidget(plugin, null);
  const bus = makeBus();
  const instance = new Widget(
    {
      id: "w1",
      type: "plugin:hello",
      x: 10,
      y: 20,
      w: 30,
      h: 40,
      config: { text: "Привет", angle: 45 },
      ...overrides,
    },
    { bus }
  );
  const parent = makeElement("div");
  instance.mount(parent);
  const listener = env.listeners.find((item) => item.type === "message").handler;
  const ready = () => listener({ source: instance.frame.contentWindow, data: { ose: "ready" } });
  return { instance, bus, listener, ready };
}

afterEach(() => {
  delete global.window;
  delete global.document;
});

describe("overlay/plugin-widget: рамка-песочница", () => {
  test("рамка создаётся закрытой и с мостом внутри", () => {
    const env = setup();
    const { instance } = mountWidget(env);

    expect(instance.element.classList.list).toContain("widget-instance--plugin");
    expect(instance.element.style.left).toBe("10%");
    expect(instance.element.style.height).toBe("40%");

    const frame = instance.element.children[0];
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.sandbox).toBe("allow-scripts");
    expect(frame.srcdoc).toContain("/shared/plugin-sandbox.js");
    // Пока рамка не готова, в неё ничего не отправляется.
    expect(env.posted).toEqual([]);
  });

  test("после готовности уходят настройки, файлы и тема", () => {
    const env = setup();
    env.html.style.setProperty("--md-primary", "#00ff66");
    env.body.dataset.theme = "terminal";
    const { ready } = mountWidget(env);
    ready();

    const init = env.posted[0];
    expect(init.ose).toBe("init");
    expect(init.pluginId).toBe("hello");
    expect(init.baseUrl).toBe("/plugins/hello/");
    expect(init.entry).toBe("widget.js");
    expect(init.styles).toEqual(["/plugins/hello/widget.css"]);
    // Поворот уже применён к обёртке — внутрь `angle` не отдаём.
    expect(init.config).toEqual({ text: "Привет" });
    expect(init.theme.tokens["--md-primary"]).toBe("#00ff66");
    expect(init.theme.id).toBe("terminal");
    expect(init.lang).toBe("ru");
  });

  test("обновление настроек и темы доходит до рамки", () => {
    const env = setup();
    const { instance, ready } = mountWidget(env);
    ready();

    instance.update({ config: { text: "Новый" }, x: 10, y: 20, w: 30, h: 40 });
    const update = env.posted.find((message) => message.ose === "update");
    expect(update.config).toEqual({ text: "Новый" });

    env.html.style.setProperty("--md-secondary", "#123456");
    instance.update({ config: { text: "Новый" }, x: 10, y: 20, w: 30, h: 40 });
    const theme = env.posted.filter((message) => message.ose === "theme").pop();
    expect(theme.theme.tokens["--md-secondary"]).toBe("#123456");
  });

  test("события пересылаются только по подписке пакета", () => {
    const env = setup();
    const { bus, listener, instance } = mountWidget(env);
    listener({ source: instance.frame.contentWindow, data: { ose: "ready" } });

    bus.emit("alert", { kind: "donation" });
    expect(env.posted.some((message) => message.ose === "event")).toBe(false);

    listener({ source: instance.frame.contentWindow, data: { ose: "sub", channel: "alert" } });
    bus.emit("alert", { kind: "donation" });
    expect(env.posted).toContainEqual({
      ose: "event",
      channel: "alert",
      payload: { kind: "donation" },
    });

    listener({ source: instance.frame.contentWindow, data: { ose: "unsub", channel: "alert" } });
    const count = env.posted.filter((message) => message.ose === "event").length;
    bus.emit("alert", { kind: "follow" });
    expect(env.posted.filter((message) => message.ose === "event")).toHaveLength(count);
  });

  test("чужие сообщения не принимаются", () => {
    const env = setup();
    const { listener } = mountWidget(env);
    listener({ source: {}, data: { ose: "ready" } });
    expect(env.posted).toEqual([]);
  });

  test("размонтирование снимает подписки и слушателя", () => {
    const env = setup();
    const { bus, listener, instance, ready } = mountWidget(env);
    ready();
    listener({ source: instance.frame.contentWindow, data: { ose: "sub", channel: "alert" } });

    instance.unmount();

    expect(env.posted.some((message) => message.ose === "unmount")).toBe(true);
    expect(bus.handlers.get("alert").size).toBe(0);
    expect(env.listeners.filter((item) => item.type === "message")).toHaveLength(0);
  });

  test("3D-виджет остаётся в DOM-обёртке, а рамка получает свой renderType", () => {
    const env = setup();
    const Widget = env.createPluginWidget(plugin, { theme: "orbit_test" });
    const instance = new Widget(
      {
        id: "w2",
        type: "plugin:hello",
        renderType: "canvas",
        x: 0,
        y: 0,
        w: 50,
        h: 50,
        config: {},
      },
      { bus: makeBus() }
    );
    instance.mount(makeElement("div"));

    // Снаружи — обычный div с рамкой, а не canvas: холст живёт в песочнице.
    expect(instance.renderType).toBe("2d");
    expect(instance.element.tagName).toBe("DIV");
    expect(instance.element.children[0].tagName).toBe("IFRAME");

    const listener = env.listeners.find((item) => item.type === "message").handler;
    listener({ source: instance.frame.contentWindow, data: { ose: "ready" } });

    const init = env.posted[0];
    expect(init.renderType).toBe("canvas");
    expect(init.family).toBe("orbit_test");
  });
});
