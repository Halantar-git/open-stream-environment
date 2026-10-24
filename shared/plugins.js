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
    * классы виджетов: код пакета зовёт `OSE.defineWidget(id, cls)`.

  Оверлей и сцены включают `load()`, панель — `load({ widgets: false })`:
  панели нужны только карточки и темы, чужой код в ней не исполняется.

  Пакет исполняется в той же странице, что и оверлей, поэтому ставить можно
  только доверенный код; песочница — отдельный этап, как записано в
  `docs/plugin-api.md`.
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

  function addStyle(href, pluginId) {
    addLink(href, `ose-plugin-style-${pluginId}-${href}`);
  }

  function loadScript(plugin) {
    const doc = root.document;
    const url = `${plugin.baseUrl}${plugin.entry}`;
    if (!doc) return Promise.resolve();
    // Плагины грузим по очереди: `defineWidget` понимает короткий id только
    // для того пакета, который сейчас исполняется.
    state.loading = plugin.id;
    return new Promise((resolve) => {
      const script = doc.createElement("script");
      script.src = url;
      script.async = false;
      script.dataset.plugin = plugin.id;
      script.onload = () => resolve();
      script.onerror = () => {
        state.errors.push({ dir: plugin.id, error: `не загрузился ${url}` });
        resolve();
      };
      (doc.head || doc.documentElement).appendChild(script);
    }).then(() => {
      state.loading = "";
    });
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

  /*
    Прочитать пакеты и подключить их.

    Повторный вызов возвращает тот же промис: страница может спросить список
    из нескольких мест, а порядок подключения важен (стили раньше кода).
  */
  function load(options) {
    if (state.ready) return state.ready;
    const opts = options || {};
    state.ready = fetchPlugins()
      .then(async (payload) => {
        state.plugins = Array.isArray(payload.plugins) ? payload.plugins : [];
        state.errors = state.errors.concat(Array.isArray(payload.errors) ? payload.errors : []);

        // Темы первыми: их CSS должен быть на месте к первому кадру.
        state.plugins.filter((item) => item.kind === "theme").forEach(addTheme);

        const widgets = state.plugins.filter((item) => item.kind === "widget");
        widgets.forEach((item) => {
          addWidget(item);
          (item.styles || []).forEach((style) => addStyle(`${item.baseUrl}${style}`, item.id));
        });

        if (opts.widgets !== false) {
          for (const item of widgets) {
            await loadScript(item);
          }
        }
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
  };

  return api;
});
