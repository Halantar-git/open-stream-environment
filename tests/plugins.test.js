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
  Клиент API пакетов: список с сервера превращается в карточки библиотеки,
  темы и классы виджетов. Проверяем контракт, а не разметку оверлея: именно на
  эти поля смотрят панель, менеджер виджетов и список тем.
*/

function makeDocument({ runScript } = {}) {
  const head = {
    children: [],
    appendChild(element) {
      this.children.push(element);
      if (element.tagName === "SCRIPT") {
        // Скрипт пакета исполняется сразу после вставки, как в браузере;
        // `load` ждёт onload, поэтому вызываем его в микрозадаче.
        Promise.resolve().then(() => {
          try {
            if (runScript) runScript(element.src, element.dataset.plugin);
            if (element.onload) element.onload();
          } catch (_) {
            if (element.onerror) element.onerror();
          }
        });
      }
      return element;
    },
  };
  return {
    head,
    documentElement: head,
    getElementById: (id) => head.children.find((element) => element.id === id) || null,
    createElement: (tag) => ({
      tagName: String(tag).toUpperCase(),
      dataset: {},
      id: "",
      rel: "",
      href: "",
      src: "",
    }),
  };
}

function loadPlugins({ payload, runScript, fetchError } = {}) {
  jest.resetModules();
  global.WidgetCatalog = { WIDGET_TYPES: {} };
  global.BuiltinThemes = { BUILTIN_THEMES: {} };
  global.document = makeDocument({ runScript });
  global.fetch = jest.fn(() => {
    if (fetchError) return Promise.reject(new Error("сеть"));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(payload || { apiVersion: 1, plugins: [], errors: [] }),
    });
  });
  return require("../shared/plugins");
}

const widget = {
  kind: "widget",
  id: "hello",
  type: "plugin:hello",
  name: "Привет",
  description: "Карточка с текстом",
  version: "1.0.0",
  author: "Тест",
  baseUrl: "/plugins/hello/",
  entry: "widget.js",
  styles: ["widget.css"],
  icon: "widgetCustom",
  geometry: { x: 40, y: 40, w: 20, h: 10 },
  minW: 8,
  minH: 4,
  settings: {
    text: { type: "string", default: "Привет" },
    size: { type: "range", default: 24 },
  },
};

const theme = {
  kind: "theme",
  id: "plugin:plain",
  pluginId: "plain",
  name: "Plain",
  baseUrl: "/plugins/plain/",
  css: "theme.css",
  tokens: { "--md-primary": "#7aa2f7" },
};

afterEach(() => {
  delete global.WidgetCatalog;
  delete global.BuiltinThemes;
  delete global.document;
  delete global.fetch;
  delete global.OSE;
});

describe("shared/plugins: каталог и темы", () => {
  test("виджет из пакета появляется в каталоге с умолчаниями схемы", async () => {
    const plugins = loadPlugins({ payload: { apiVersion: 1, plugins: [widget] } });
    await plugins.load({ widgets: false });

    const def = global.WidgetCatalog.WIDGET_TYPES["plugin:hello"];
    expect(def).toBeTruthy();
    expect(def.label).toBe("Привет");
    expect(def.plugin).toBe(true);
    expect(def.defaultGeometry).toEqual({ x: 40, y: 40, w: 20, h: 10 });
    expect(def.defaultConfig).toEqual({ text: "Привет", size: 24 });
    expect(def.settings.text.type).toBe("string");
    expect(document.head.children.some((element) => element.tagName === "SCRIPT")).toBe(false);
  });

  test("панель не исполняет код пакетов, но ставит их стили", async () => {
    const plugins = loadPlugins({ payload: { apiVersion: 1, plugins: [widget] } });
    await plugins.load({ widgets: false });

    const links = document.head.children.filter((element) => element.tagName === "LINK");
    expect(links.map((link) => link.href)).toEqual(["/plugins/hello/widget.css"]);
  });

  test("тема из пакета дописывается во встроенные и получает CSS", async () => {
    const plugins = loadPlugins({ payload: { apiVersion: 1, plugins: [theme] } });
    await plugins.load({ widgets: false });

    expect(global.BuiltinThemes.BUILTIN_THEMES["plugin:plain"].tokens["--md-primary"]).toBe("#7aa2f7");
    expect(plugins.themes["plugin:plain"].builtin).toBe(true);
    const links = document.head.children.filter((element) => element.tagName === "LINK");
    expect(links.map((link) => link.href)).toEqual(["/plugins/plain/theme.css"]);
  });

  test("ошибки сервера доходят до страницы", async () => {
    const plugins = loadPlugins({
      payload: { apiVersion: 1, plugins: [], errors: [{ dir: "bad", error: "JSON" }] },
    });
    await plugins.load();
    expect(plugins.errors).toEqual([{ dir: "bad", error: "JSON" }]);
  });

  test("пустой или недоступный API не мешает странице", async () => {
    const plugins = loadPlugins({ fetchError: true });
    await plugins.load();
    expect(plugins.plugins).toEqual([]);
    expect(plugins.errors).toEqual([]);
  });
});

describe("shared/plugins: классы виджетов", () => {
  test("короткий id из манифеста становится типом plugin:<id>", async () => {
    class Hello {}
    const plugins = loadPlugins({
      payload: { apiVersion: 1, plugins: [widget] },
      runScript: (src, pluginId) => {
        expect(src).toBe("/plugins/hello/widget.js");
        expect(pluginId).toBe("hello");
        plugins.defineWidget("hello", Hello);
      },
    });
    // `loadPlugins` вернул модуль, а runScript ссылается на него же.
    await plugins.load();
    expect(plugins.widgets["plugin:hello"]).toBe(Hello);
  });

  test("onWidget отдаёт и уже определённые классы, и новые", async () => {
    const plugins = loadPlugins({ payload: { apiVersion: 1, plugins: [] } });
    await plugins.load();
    class Existing {}
    plugins.defineWidget("plugin:existing", Existing);

    const seen = [];
    plugins.onWidget((type, WidgetClass) => seen.push([type, WidgetClass]));
    expect(seen).toEqual([["plugin:existing", Existing]]);

    class Later {}
    plugins.defineWidget("plugin:later", Later);
    expect(seen).toEqual([
      ["plugin:existing", Existing],
      ["plugin:later", Later],
    ]);
  });

  test("не сломанный пакет не роняет загрузку остальных", async () => {
    const broken = { ...widget, id: "broken", type: "plugin:broken" };
    const plugins = loadPlugins({
      payload: { apiVersion: 1, plugins: [broken, widget] },
      runScript: (src) => {
        if (src.includes("broken")) throw new Error("нет кода");
      },
    });
    await expect(plugins.load()).resolves.toBeTruthy();
    expect(global.WidgetCatalog.WIDGET_TYPES["plugin:hello"]).toBeTruthy();
  });

  test("asset указывает на файл пакета", () => {
    const plugins = loadPlugins({ payload: { apiVersion: 1, plugins: [] } });
    expect(plugins.asset("hello", "cover.png")).toBe("/plugins/hello/cover.png");
    expect(plugins.asset("hello", "/cover.png")).toBe("/plugins/hello/cover.png");
  });
});
