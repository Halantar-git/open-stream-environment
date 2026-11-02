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
  Песочница пакетного виджета: половина моста внутри iframe.

  Код пакета больше не исполняется в странице оверлея. Он живёт в рамке с
  `sandbox="allow-scripts"`: у неё нет доступа к DOM панели и оверлея, к их
  состоянию, сокету и хранилищу. Здесь — то, что видит код пакета (`window.OSE`),
  загрузка его стилей и входного файла, монтирование виджета и обмен сообщениями
  с родителем. Родительская половина — `overlay/widgets/plugin-widget.js`.

  Что важно помнить при правках:

  * сообщения принимаются только от `parent`, и `event.source` сверяется —
    иначе чужое окно могло бы подсунуть виджету свои настройки;
  * токены темы ставятся на `:root` рамки, поэтому `var(--md-*)` и правила
    `[data-theme="…"]` работают так же, как в оверлее;
  * `subscribe()` не держит подписку на родителе: первый обработчик канала
    просит родителя присылать события, последний — снимает (см. BridgeBus);
  * в рамке есть только `OSE`, `I18n`, `SharedEvents`, `SharedIcons` и
    `BaseWidget`: `context.state` и `context.send` оверлея наружу не отдаются.
*/
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    api.install();
  }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", UAH: "₴", KZT: "₸", GBP: "£" };

  const state = {
    installed: false,
    started: false,
    pluginId: "",
    baseUrl: "",
    family: "",
    renderType: "2d",
    instance: null,
    widgets: {},
    listeners: [],
    themeLinks: [],
  };

  // ---- мелкие помощники ----

  function doc() {
    return root.document || null;
  }

  /* Родитель — единственный адресат. Если рамку уже вынули из страницы,
     postMessage бросает исключение; это не повод падать внутри песочницы. */
  function post(message) {
    const parent = root.parent;
    if (!parent || typeof parent.postMessage !== "function" || parent === root) return;
    try {
      parent.postMessage(message, "*");
    } catch (_) {
      /* окно закрыто */
    }
  }

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])
    );
  }

  function escapeAttr(value) {
    return String(value).replace(/"/g, "&quot;");
  }

  function formatMoney(value) {
    const locale = root.I18n && root.I18n.getLang() === "ru" ? "ru-RU" : "en-US";
    return Number(value || 0).toLocaleString(locale);
  }

  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || code || "";
  }

  function resolveMediaUrl(path) {
    if (!path) return "";
    if (/^(https?:)?\/\//i.test(path)) return path;
    return "/" + String(path).replace(/^\/+/, "");
  }

  function readCssVar(name) {
    if (!root.getComputedStyle || !doc() || !doc().documentElement) return "";
    return root.getComputedStyle(doc().documentElement).getPropertyValue(name).trim();
  }

  function t(key, params) {
    return root.I18n && typeof root.I18n.t === "function" ? root.I18n.t(key, params) : String(key);
  }

  function pluginType(id) {
    const value = String(id || "");
    return value.startsWith("plugin:") ? value : `plugin:${value}`;
  }

  // ---- шина событий ----

  /*
    События приходят от родителя, но подписку платит он: пока канала никто не
    слушает, оверлей не тратит postMessage на каждый донат или сообщение чата.
  */
  class BridgeBus {
    constructor() {
      this.handlers = new Map();
      this.requested = new Set();
    }

    on(channel, handler) {
      if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
      this.handlers.get(channel).add(handler);
      if (!this.requested.has(channel)) {
        this.requested.add(channel);
        post({ ose: "sub", channel });
      }
      return () => this.off(channel, handler);
    }

    off(channel, handler) {
      const set = this.handlers.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size > 0) return;
      this.handlers.delete(channel);
      if (this.requested.delete(channel)) post({ ose: "unsub", channel });
    }

    emit(channel, payload) {
      const set = this.handlers.get(channel);
      if (!set) return;
      set.forEach((handler) => {
        try {
          handler(payload);
        } catch (error) {
          fail(error);
        }
      });
    }
  }

  const bus = new BridgeBus();

  // ---- регистрация виджетов ----

  /*
    `id` — короткое имя из манифеста или полный тип. Короткое имя привязывается к
    пакету, внутри которого исполняется код: пакеты не видят друг друга и не
    могут перехватить чужой тип.
  */
  function defineWidget(id, WidgetClass) {
    if (!id || typeof WidgetClass !== "function") return;
    const raw = String(id);
    const type = raw.startsWith("plugin:") ? raw : pluginType(state.pluginId || raw);
    state.widgets[type] = WidgetClass;
    state.listeners.forEach((listener) => {
      try {
        listener(type, WidgetClass);
      } catch (_) {
        /* один подписчик не должен ломать остальные */
      }
    });
  }

  function onWidget(listener) {
    if (typeof listener !== "function") return () => {};
    state.listeners.push(listener);
    Object.keys(state.widgets).forEach((type) => listener(type, state.widgets[type]));
    return () => {
      state.listeners = state.listeners.filter((item) => item !== listener);
    };
  }

  function asset(pluginId, path) {
    const clean = String(path == null ? "" : path).replace(/^\/+/, "");
    return `/plugins/${encodeURIComponent(String(pluginId || ""))}/${clean}`;
  }

  function makeOSE() {
    return {
      version: 1,
      get BaseWidget() {
        return root.OSEWidgets ? root.OSEWidgets.BaseWidget : null;
      },
      get EVENT_TYPES() {
        return (root.SharedEvents && root.SharedEvents.EVENT_TYPES) || {};
      },
      get widgets() {
        return state.widgets;
      },
      get plugins() {
        return state.pluginId
          ? [
              {
                kind: "widget",
                id: state.pluginId,
                type: pluginType(state.pluginId),
                baseUrl: state.baseUrl,
              },
            ]
          : [];
      },
      defineWidget,
      onWidget,
      asset,
      cssVar: readCssVar,
      t,
    };
  }

  // ---- тема ----

  function applyCustomCss(css) {
    const head = doc() && doc().head;
    if (!head) return;
    let style = doc().getElementById("ose-custom-theme-css");
    if (!css) {
      if (style && style.parentNode) style.parentNode.removeChild(style);
      return;
    }
    if (!style) {
      style = doc().createElement("style");
      style.id = "ose-custom-theme-css";
      head.appendChild(style);
    }
    style.textContent = css;
  }

  /* CSS тем-пакетов родитель не пересказывает целиком: он присылает ссылки, а
     рамка грузит их сама — те же файлы, что и в оверлее. */
  function applyLinks(links) {
    const head = doc() && doc().head;
    if (!head) return;
    const wanted = Array.isArray(links) ? links.filter(Boolean) : [];
    state.themeLinks.forEach((link) => {
      if (!wanted.includes(link.href) && link.parentNode) link.parentNode.removeChild(link);
    });
    state.themeLinks = wanted.map((href) => {
      const existing = state.themeLinks.find((link) => link.href === href);
      if (existing) return existing;
      const link = doc().createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.oseTheme = "1";
      head.appendChild(link);
      return link;
    });
  }

  function applyTheme(theme) {
    if (!theme || typeof theme !== "object") return;
    const html = doc() && doc().documentElement;
    const body = doc() && doc().body;
    const tokens = theme.tokens || {};
    if (html && html.style) {
      Object.keys(tokens).forEach((name) => html.style.setProperty(name, tokens[name]));
    }
    if (html && html.dataset) html.dataset.theme = theme.id || "";
    if (body && body.dataset) {
      body.dataset.theme = theme.id || "";
      body.dataset.decoration = tokens["--panel-decoration"] || "none";
    }
    applyCustomCss(theme.customCss || "");
    applyLinks(theme.links || []);
  }

  /* Словари большие и живут статикой рядом: рамка грузит их сама, чтобы не
     гонять словарь через postMessage на каждый виджет. */
  function loadLocales(lang) {
    if (!root.I18n || typeof root.fetch !== "function") return;
    const code = lang === "ru" ? "ru" : "en";
    root.I18n.setLang(code);
    root
      .fetch(`/shared/locales/${code}.json`, { cache: "no-store" })
      .then((response) => (response && response.ok ? response.json() : null))
      .then((dictionary) => {
        if (dictionary) root.I18n.setLocales({ [code]: dictionary });
      })
      .catch(() => {
        /* без словаря t() вернёт ключ — виджет всё равно должен показаться */
      });
  }

  // ---- запуск виджета ----

  function rootElement() {
    return doc() ? doc().getElementById("ose-root") : null;
  }

  /* Геометрия внутри рамки не нужна: саму рамку родитель уже поставил по
     раскладке. Виджет растягивается на всю её площадь, поэтому тут проценты
     фиксированные. */
  function frameConfig(message) {
    const renderType =
      message.renderType === "canvas" || message.renderType === "3d-webgl"
        ? message.renderType
        : "2d";
    return {
      id: message.id,
      type: message.type,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      z: 0,
      visible: true,
      renderType,
      config: message.config && typeof message.config === "object" ? message.config : {},
    };
  }

  function widgetContext() {
    return {
      bus,
      EVENT_TYPES: (root.SharedEvents && root.SharedEvents.EVENT_TYPES) || {},
      t,
      ICONS: (root.SharedIcons && root.SharedIcons.ICONS) || {},
      escapeHtml,
      escapeAttr,
      formatMoney,
      currencySymbol,
      resolveMediaUrl,
      readCssVar,
      theme: state.family || "",
    };
  }

  function fail(error, stack) {
    const message = error && error.message ? error.message : String(error || "ошибка пакета");
    post({ ose: "error", message, stack: stack || (error && error.stack) || "" });
    const host = rootElement();
    if (host && !state.instance) {
      host.textContent = "";
      const note = doc().createElement("div");
      note.textContent = `Пакет «${state.pluginId}»: ${message}`;
      note.style.cssText =
        "font: 14px/1.4 monospace; color: #ff3333; padding: 8px; background: rgba(0,0,0,.6);";
      host.appendChild(note);
    }
  }

  function mountInstance(message) {
    const type = pluginType(state.pluginId || message.type);
    const WidgetClass = state.widgets[type];
    if (!WidgetClass) {
      fail(new Error(`пакет не зарегистрировал виджет ${type}`));
      return;
    }
    const host = rootElement();
    if (!host) {
      fail(new Error("в рамке нет контейнера #ose-root"));
      return;
    }
    try {
      state.instance = new WidgetClass(frameConfig(message), widgetContext());
      state.instance.mount(host);
    } catch (error) {
      fail(error);
    }
  }

  function loadEntry(message) {
    const head = doc() && (doc().head || doc().documentElement);
    if (!head) return;
    (Array.isArray(message.styles) ? message.styles : []).forEach((href) => {
      const link = doc().createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      head.appendChild(link);
    });
    const script = doc().createElement("script");
    script.src = `${message.baseUrl || ""}${message.entry || ""}`;
    script.async = false;
    script.onload = () => mountInstance(message);
    script.onerror = () => fail(new Error(`не загрузился ${script.src}`));
    head.appendChild(script);
  }

  function start(message) {
    if (state.started) return;
    state.started = true;
    state.pluginId = String(message.pluginId || "");
    state.baseUrl = String(message.baseUrl || "");
    state.family = String(message.family || "");
    state.renderType = message.renderType === "canvas" || message.renderType === "3d-webgl"
      ? message.renderType
      : "2d";
    loadLocales(message.lang);
    applyTheme(message.theme);
    loadEntry(message);
  }

  function update(message) {
    if (!state.instance) return;
    try {
      state.instance.update({
        config: message.config && typeof message.config === "object" ? message.config : {},
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        z: 0,
        visible: true,
      });
    } catch (error) {
      fail(error);
    }
  }

  function teardown() {
    const instance = state.instance;
    state.instance = null;
    if (!instance) return;
    try {
      instance.unmount();
    } catch (error) {
      fail(error);
    }
  }

  function receive(event) {
    if (!event || event.source !== root.parent) return;
    const data = event.data;
    if (!data || typeof data !== "object" || typeof data.ose !== "string") return;
    switch (data.ose) {
      case "init":
        start(data);
        break;
      case "update":
        update(data);
        break;
      case "theme":
        applyTheme(data.theme);
        break;
      case "event":
        bus.emit(data.channel, data.payload);
        break;
      case "unmount":
        teardown();
        break;
      default:
        break;
    }
  }

  function install() {
    if (state.installed) return api;
    state.installed = true;
    root.OSE = makeOSE();
    if (typeof root.addEventListener === "function") root.addEventListener("message", receive);
    // Первым делом — готовность: родитель пришлёт настройки и тему только после
    // того, как поймёт, что рамка уже слушает сообщения.
    post({ ose: "ready" });
    return api;
  }

  const api = {
    install,
    defineWidget,
    onWidget,
    applyTheme,
    state,
    bus,
  };

  return api;
});
