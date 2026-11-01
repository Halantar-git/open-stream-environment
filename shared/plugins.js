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
  Пакеты виджетов и тем: клиентская половина API.

  Сервер читает манифесты из данных пользователя и отдаёт их по
  `/api/plugins`, а файлы — по `/plugins/<id>/`. Здесь список превращается в:

    * карточки библиотеки (определения дописываются в `WidgetCatalog`);
    * темы (токены — в `BuiltinThemes`, CSS — отдельным `<link>`);
    * классы виджетов: для каждого пакета — прокси, который держит код пакета
      в песочнице (`overlay/widgets/plugin-widget.js`).

  Код пакета в страницу не подключается: `widget.js` грузится внутри iframe,
  а наружу уходят только настройки, тема и события, на которые виджет
  подписался. Поэтому страница панели (`load({ widgets: false })`) не исполняет
  чужой код вообще, а оверлей не даёт пакету доступа к своему DOM и сокету.
*/
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.OSE = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  const state = {
    ready: null,
    plugins: [],
    errors: [],
    themes: {},
    widgets: {},
    listeners: [],
    loading: "",
    // Подпись загруженного списка: панель сравнивает её при возврате фокуса и
    // перезагружает страницу, если пакеты добавили или убрали.
    signature: "",
  };

  function catalog() {
    return root.WidgetCatalog || null;
  }

  function builtinThemes() {
    return root.BuiltinThemes || null;
  }

  function pluginType(id) {
    return String(id || "").startsWith("plugin:") ? String(id) : `plugin:${id}`;
  }

  // Настройки по умолчанию из схемы — тот же набор, что сервер кладёт в
  // `defaultConfig` при добавлении виджета.
  function defaults(settings) {
    const out = {};
    Object.keys(settings || {}).forEach((key) => {
      const field = settings[key] || {};
      if (Object.prototype.hasOwnProperty.call(field, "default")) out[key] = field.default;
    });
    return out;
  }

  function addWidget(item) {
    const widgets = catalog();
    if (!widgets || !widgets.WIDGET_TYPES || !item || !item.type) return;
    widgets.WIDGET_TYPES[item.type] = {
      type: item.type,
      label: item.name,
      description: item.description || "",
      icon: item.icon || "widgetCustom",
      plugin: true,
      pluginId: item.id,
      defaultGeometry: item.geometry || {},
      minW: item.minW,
      minH: item.minH,
      defaultConfig: defaults(item.settings),
      settings: item.settings || {},
    };
  }

  function addTheme(item) {
    if (!item || !item.id) return;
    const theme = {
      id: item.id,
      name: item.name,
      builtin: true,
      plugin: true,
      category: "plugin",
      dimension: "2d",
      tokens: item.tokens || {},
    };
    state.themes[item.id] = theme;
    const themes = builtinThemes();
    // Оверлею `themes.js` не нужен: токены приходят в снимке состояния.
    // Панель же берёт образцы цветов из `BuiltinThemes`, поэтому дописываем.
    if (themes && themes.BUILTIN_THEMES) themes.BUILTIN_THEMES[item.id] = theme;
    if (item.css) addLink(`${item.baseUrl}${item.css}`, `ose-plugin-theme-${item.id}`);
  }

  function addLink(href, id) {
    const doc = root.document;
    if (!doc || doc.getElementById(id)) return;
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.id = id;
    (doc.head || doc.documentElement).appendChild(link);
  }

  async function fetchPlugins() {
    const doFetch = typeof root.fetch === "function" ? root.fetch : null;
    if (!doFetch) return { plugins: [], errors: [] };
    try {
      const response = await doFetch("/api/plugins", { cache: "no-store" });
      if (!response || !response.ok) return { plugins: [], errors: [] };
      const payload = await response.json();
      return payload && typeof payload === "object" ? payload : { plugins: [], errors: [] };
    } catch (_) {
      return { plugins: [], errors: [] };
    }
  }

  /* Подпись списка: порядок и содержимое важны, поэтому сравниваем JSON целиком.
     Это дешёвый способ заметить новую папку, не перестраивая каталог на лету. */
  function signatureOf(payload) {
    return JSON.stringify({ plugins: payload.plugins || [], errors: payload.errors || [] });
  }

  /* Перечитать список и сказать, отличается ли он от загруженного.
     Панель по `true` перезагружает страницу — так новый пакет появляется без
     перезапуска приложения. Оверлей в OBS обновляют вручную. */
  async function reloadIfChanged() {
    const payload = await fetchPlugins();
    const signature = signatureOf(payload);
    if (signature === state.signature) return false;
    state.signature = signature;
    return true;
  }

  /*
    Прочитать пакеты и подключить их.

    Повторный вызов возвращает тот же промис: страница может спросить список
    из нескольких мест. Код пакетов здесь не исполняется: для каждого виджета
    регистрируется прокси-класс, внутри которого будет своя рамка-песочница.
    Фабрику даёт страница (`OSEWidgets.createPluginWidget`), панель её не
    передаёт и остаётся без чужих классов.
  */
  function load(options) {
    if (state.ready) return state.ready;
    const opts = options || {};
    state.ready = fetchPlugins()
      .then(async (payload) => {
        state.signature = signatureOf(payload);
        state.plugins = Array.isArray(payload.plugins) ? payload.plugins : [];
        state.errors = state.errors.concat(Array.isArray(payload.errors) ? payload.errors : []);

        // Темы первыми: их CSS должен быть на месте к первому кадру.
        state.plugins.filter((item) => item.kind === "theme").forEach(addTheme);

        const factory =
          opts.widgets === false
            ? null
            : opts.sandbox || (root.OSEWidgets && root.OSEWidgets.createPluginWidget) || null;
        state.plugins
          .filter((item) => item.kind === "widget")
          .forEach((item) => {
            addWidget(item);
            if (!factory) return;
            const definitions = catalog() && catalog().WIDGET_TYPES;
            try {
              defineWidget(item.type, factory(item, (definitions && definitions[item.type]) || null));
            } catch (error) {
              state.errors.push({ dir: item.id, error: `не удалось подключить: ${error.message}` });
            }
          });
        return api;
      })
      // Сломанный пакет или нестандартный ответ не должны оставить страницу
      // без сокета: оверлей подключается и без пакетов.
      .catch(() => api);
    return state.ready;
  }

  /*
    Регистрация класса виджета.

    `id` — короткое имя из манифеста (`"hello"`) или полный тип
    (`"plugin:hello"`). Класс наследуется от `OSE.BaseWidget` и получает всё,
    что обычно получает встроенный виджет: `this.config`, `this.element`,
    `this.subscribe()`, `this.later()` и так далее.
  */
  function defineWidget(id, WidgetClass) {
    if (typeof WidgetClass !== "function" || !id) return;
    const type = pluginType(String(id).startsWith("plugin:") ? id : state.loading || id);
    state.widgets[type] = WidgetClass;
    state.listeners.forEach((listener) => {
      try {
        listener(type, WidgetClass);
      } catch (_) {
        /* один подписчик не должен ломать остальные */
      }
    });
  }

  /* Подписка на уже и будущие определения: менеджер виджетов регистрирует
     класс сразу, не дожидаясь конца загрузки всех пакетов. */
  function onWidget(listener) {
    if (typeof listener !== "function") return () => {};
    state.listeners.push(listener);
    Object.keys(state.widgets).forEach((type) => listener(type, state.widgets[type]));
    return () => {
      state.listeners = state.listeners.filter((item) => item !== listener);
    };
  }

  /* Адрес файла пакета: `OSE.asset("hello", "cover.png")`. */
  function asset(pluginId, path) {
    const clean = String(path == null ? "" : path).replace(/^\/+/, "");
    return `/plugins/${encodeURIComponent(String(pluginId || ""))}/${clean}`;
  }

  /* Значение токена темы — для виджетов, которые рисуют на canvas. */
  function cssVar(name) {
    const doc = root.document;
    if (!doc || !root.getComputedStyle) return "";
    return root.getComputedStyle(doc.documentElement).getPropertyValue(name).trim();
  }

  function t(key, params) {
    return root.I18n && typeof root.I18n.t === "function" ? root.I18n.t(key, params) : key;
  }

  const api = {
    version: 1,
    get ready() {
      return state.ready;
    },
    get plugins() {
      return state.plugins;
    },
    get errors() {
      return state.errors;
    },
    get themes() {
      return state.themes;
    },
    get widgets() {
      return state.widgets;
    },
    BaseWidget: root.OSEWidgets ? root.OSEWidgets.BaseWidget : null,
    EVENT_TYPES: root.SharedEvents ? root.SharedEvents.EVENT_TYPES : {},
    defineWidget,
    onWidget,
    asset,
    cssVar,
    t,
    load,
    reloadIfChanged,
  };

  return api;
});
