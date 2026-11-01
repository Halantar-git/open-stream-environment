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
  Песочница пакетного виджета: сторона iframe.

  Проверяем протокол, а не устройство браузера: рамка получает настройки и
  тему, грузит файлы пакета, монтирует виджет и передаёт ему события только тех
  каналов, на которые он подписался. Ошибка пакета не роняет рамку — она уходит
  родителю сообщением.
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
    style: cssStyle(),
    dataset: {},
    children: [],
    textContent: "",
    id: "",
    parentNode: null,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
      child.parentNode = null;
      return child;
    },
  };
}

function makeFrame({ onScript } = {}) {
  const messages = [];
  const listeners = [];
  const html = makeElement("html");
  const body = makeElement("body");
  const head = makeElement("head");
  const rootEl = makeElement("div");
  rootEl.id = "ose-root";

  // Скрипт пакета исполняется сразу после вставки, как в браузере; `load`
  // вызывается микрозадачей, чтобы `install` успел вернуться.
  head.appendChild = function appendChild(element) {
    child_parent(element, this);
    if (element.tagName === "SCRIPT") {
      Promise.resolve().then(() => {
        try {
          if (onScript) onScript(element);
        } catch (error) {
          if (element.onerror) element.onerror(error);
          return;
        }
        if (element.onload) element.onload();
      });
    }
    return element;
  };

  function child_parent(element, parent) {
    element.parentNode = parent;
    parent.children.push(element);
  }

  const document = {
    head,
    body,
    documentElement: html,
    getElementById: (id) =>
      id === "ose-root" ? rootEl : head.children.find((element) => element.id === id) || null,
    createElement: (tag) => makeElement(tag),
  };

  const frame = {
    document,
    parent: { postMessage: (message) => messages.push(message) },
    addEventListener: (type, handler) => {
      if (type === "message") listeners.push(handler);
    },
    I18n: {
      setLocales: jest.fn(),
      setLang: jest.fn(),
      getLang: () => "ru",
      t: (key) => key,
    },
    SharedEvents: { EVENT_TYPES: { ALERT: "alert", CHAT_MESSAGE: "chat_message" } },
    SharedIcons: { ICONS: { heart: "<svg/>" } },
    OSEWidgets: {},
    fetch: () => Promise.resolve({ ok: false }),
    getComputedStyle: () => ({ getPropertyValue: () => "#00ff66" }),
  };

  return { frame, messages, listeners, document, html, body, rootEl };
}

class FakeWidget {
  constructor(config, context) {
    this.raw = config;
    this.config = config.config;
    this.context = context;
    this.host = null;
    this.updates = [];
    this.unmounted = false;
  }

  mount(host) {
    this.host = host;
  }

  update(next) {
    this.updates.push(next);
    this.config = Object.assign({}, this.config, next.config);
  }

  unmount() {
    this.unmounted = true;
  }
}

function boot({ onScript, widgetClass } = {}) {
  const env = makeFrame({
    onScript: (script) => {
      if (onScript) {
        onScript(script);
        return;
      }
      env.frame.OSE.defineWidget("demo", widgetClass || FakeWidget);
    },
  });
  global.window = env.frame;
  jest.resetModules();
  const sandbox = require("../shared/plugin-sandbox");
  sandbox.install();
  return { ...env, sandbox, listener: env.listeners[0] };
}

function initMessage(overrides = {}) {
  return {
    source: null,
    data: {
      ose: "init",
      id: "w1",
      type: "plugin:demo",
      pluginId: "demo",
      baseUrl: "/plugins/demo/",
      entry: "widget.js",
      styles: ["/plugins/demo/widget.css"],
      config: { text: "Привет" },
      theme: {
        id: "terminal",
        tokens: { "--md-primary": "#00ff66" },
        customCss: ".custom{}",
        links: ["/plugins/term/theme.css"],
      },
      lang: "ru",
      ...overrides,
    },
  };
}

function deliver(listener, frame, message) {
  listener({ source: frame.parent, data: message });
}

afterEach(() => {
  delete global.window;
});

describe("shared/plugin-sandbox: запуск пакета", () => {
  test("рамка сообщает о готовности и публикует OSE", () => {
    const { messages, frame } = boot();
    expect(messages).toContainEqual({ ose: "ready" });
    expect(frame.OSE).toBeTruthy();
    expect(typeof frame.OSE.defineWidget).toBe("function");
    expect(frame.OSE.EVENT_TYPES).toEqual({ ALERT: "alert", CHAT_MESSAGE: "chat_message" });
  });

  test("init грузит стили, ставит тему и монтирует виджет", async () => {
    const { sandbox, listener, frame, rootEl, html, body, document } = boot();
    deliver(listener, frame, initMessage().data);
    await Promise.resolve();
    await Promise.resolve();

    const instance = sandbox.state.instance;
    expect(instance).toBeTruthy();
    expect(instance.host).toBe(rootEl);
    expect(instance.config).toEqual({ text: "Привет" });
    // Внутри рамки виджет растянут на всю её площадь.
    expect(instance.raw).toMatchObject({ w: 100, h: 100, x: 0, y: 0 });

    const links = document.head.children.filter((element) => element.tagName === "LINK");
    // Сначала тема, потом стили пакета — как в оверлее: пакет может переопределить
    // правила темы.
    expect(links.map((link) => link.href)).toEqual([
      "/plugins/term/theme.css",
      "/plugins/demo/widget.css",
    ]);
    expect(html.dataset.theme).toBe("terminal");
    expect(body.dataset.theme).toBe("terminal");
    expect(html.style.getPropertyValue("--md-primary")).toBe("#00ff66");
    expect(document.head.children.some((element) => element.id === "ose-custom-theme-css")).toBe(true);
  });

  test("update доносит настройки до виджета", async () => {
    const { sandbox, listener, frame } = boot();
    deliver(listener, frame, initMessage().data);
    await Promise.resolve();

    deliver(listener, frame, { ose: "update", config: { text: "Новый" } });
    expect(sandbox.state.instance.updates[0].config).toEqual({ text: "Новый" });
    expect(sandbox.state.instance.config.text).toBe("Новый");
  });

  test("подписка просит события у родителя и снимается последним обработчиком", async () => {
    class Subscribed extends FakeWidget {
      mount(host) {
        super.mount(host);
        this.handle = (payload) => {
          this.last = payload;
        };
        this.off = this.context.bus.on("alert", this.handle);
      }
    }
    const { sandbox, listener, frame, messages } = boot({ widgetClass: Subscribed });
    deliver(listener, frame, initMessage().data);
    await Promise.resolve();

    expect(messages).toContainEqual({ ose: "sub", channel: "alert" });

    deliver(listener, frame, { ose: "event", channel: "alert", payload: { kind: "donation" } });
    expect(sandbox.state.instance.last).toEqual({ kind: "donation" });

    sandbox.state.instance.off();
    expect(messages).toContainEqual({ ose: "unsub", channel: "alert" });
  });

  test("unmount снимает виджет", async () => {
    const { sandbox, listener, frame } = boot();
    deliver(listener, frame, initMessage().data);
    await Promise.resolve();
    const instance = sandbox.state.instance;

    deliver(listener, frame, { ose: "unmount" });
    expect(instance.unmounted).toBe(true);
    expect(sandbox.state.instance).toBeNull();
  });

  test("неудачная загрузка файла пакета уходит родителю и видна в рамке", async () => {
    const { sandbox, listener, frame, messages, rootEl } = boot({
      onScript: () => {
        throw new Error("нет кода");
      },
    });
    deliver(listener, frame, initMessage().data);
    await Promise.resolve();
    await Promise.resolve();

    expect(sandbox.state.instance).toBeNull();
    const error = messages.find((message) => message.ose === "error");
    expect(error).toBeTruthy();
    expect(error.message).toContain("не загрузился");
    expect(rootEl.children.length).toBeGreaterThan(0);
  });

  test("сообщения не от родителя игнорируются", async () => {
    const { sandbox, listener, frame } = boot();
    listener({ source: {}, data: initMessage().data });
    await Promise.resolve();
    expect(sandbox.state.instance).toBeNull();

    deliver(listener, frame, initMessage().data);
    await Promise.resolve();
    expect(sandbox.state.instance).toBeTruthy();
  });
});
