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
  темы и прокси-классы виджетов. Проверяем контракт, а не разметку оверлея:
  именно на эти поля смотрят панель, менеджер виджетов и список тем.

  Код пакета здесь не исполняется вообще — за него отвечает рамка-песочница
  (`overlay/widgets/plugin-widget.js`), а этот модуль лишь просит у страницы
  фабрику прокси и регистрирует получившийся класс.
*/

function makeDocument() {
  const head = {
    children: [],
    appendChild(element) {
      this.children.push(element);
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

function loadPlugins({ payload, fetchError, sandbox } = {}) {
  jest.resetModules();
  global.WidgetCatalog = { WIDGET_TYPES: {} };
  global.BuiltinThemes = { BUILTIN_THEMES: {} };
  global.document = makeDocument();
  if (sandbox) global.OSEWidgets = { createPluginWidget: sandbox };
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
  delete global.OSEWidgets;
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

  test("стили пакета не попадают в страницу: их грузит только рамка", async () => {
    const plugins = loadPlugins({ payload: { apiVersion: 1, plugins: [widget] } });
    await plugins.load({ widgets: false });

    const links = document.head.children.filter((element) => element.tagName === "LINK");
    expect(links).toEqual([]);
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

  test("изменение списка пакетов видно без повторной загрузки", async () => {
    const plugins = loadPlugins({ payload: { apiVersion: 1, plugins: [widget] } });
    await plugins.load({ widgets: false });

    // Тот же список — панели незачем перезагружаться.
    expect(await plugins.reloadIfChanged()).toBe(false);

    global.fetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ apiVersion: 1, plugins: [] }) })
    );
    expect(await plugins.reloadIfChanged()).toBe(true);
    // Подпись обновилась: повторный опрос того же ответа — уже без изменений.
    expect(await plugins.reloadIfChanged()).toBe(false);
  });
});

describe("shared/plugins: виджеты из пакетов", () => {
  test("для каждого виджета регистрируется прокси из фабрики страницы", async () => {
    const seen = [];
    class ProxyWidget {}
    const plugins = loadPlugins({
      payload: { apiVersion: 1, plugins: [widget] },
      sandbox: (item, def) => {
        seen.push([item.id, def && def.label]);
        return ProxyWidget;
      },
    });
    await plugins.load();

    expect(seen).toEqual([["hello", "Привет"]]);
    expect(plugins.widgets["plugin:hello"]).toBe(ProxyWidget);
  });

  test("без фабрики код пакета не подключается вовсе", async () => {
    const plugins = loadPlugins({ payload: { apiVersion: 1, plugins: [widget] } });
    await plugins.load();

    expect(plugins.widgets["plugin:hello"]).toBeUndefined();
    expect(document.head.children.filter((element) => element.tagName === "SCRIPT")).toEqual([]);
  });

  test("фабрика упала на одном пакете — остальные остаются", async () => {
    const broken = { ...widget, id: "broken", type: "plugin:broken" };
    const plugins = loadPlugins({
      payload: { apiVersion: 1, plugins: [broken, widget] },
      sandbox: (item) => {
        if (item.id === "broken") throw new Error("нет кода");
        return class {};
      },
    });
    await expect(plugins.load()).resolves.toBeTruthy();

    expect(plugins.widgets["plugin:hello"]).toBeTruthy();
    expect(plugins.errors.some((error) => error.dir === "broken")).toBe(true);
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

  test("asset указывает на файл пакета", () => {
    const plugins = loadPlugins({ payload: { apiVersion: 1, plugins: [] } });
    expect(plugins.asset("hello", "cover.png")).toBe("/plugins/hello/cover.png");
    expect(plugins.asset("hello", "/cover.png")).toBe("/plugins/hello/cover.png");
  });
});
