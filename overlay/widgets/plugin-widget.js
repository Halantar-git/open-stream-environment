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
  Прокси пакетного виджета: половина моста в странице оверлея.

  Код пакета не подключается в страницу оверлея — вместо него здесь обычный
  виджет для `WidgetManager`, внутри которого живёт iframe с
  `sandbox="allow-scripts"`. Рамке передаются только настройки, токены темы и
  события, на которые она подписалась; DOM оверлея, его состояние и сокет
  наружу не уходят. Вторая половина моста — `shared/plugin-sandbox.js`.

  Геометрию, видимость и поворот считает `BaseWidget` на обёртке, поэтому рамка
  встаёт по раскладке так же, как обычный виджет, а внутри виджет растянут на
  всю её площадь. `angle` в настройках пакета поэтому не передаётся: иначе
  поворот применился бы дважды.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const api = factory(BaseWidget, root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.PluginFrameWidget = api.PluginFrameWidget;
    root.OSEWidgets.createPluginWidget = api.createPluginWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget, root) {
  "use strict";

  /*
    Скелет рамки: базовые стили и шрифты темы, шина событий, словарь и движок
    виджетов. Пакет подключается позже — его файлы приходят в сообщении `init`.
  */
  const SHELL = [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<link rel=\"stylesheet\" href=\"/shared/theme.css\">",
    "<link rel=\"stylesheet\" href=\"/shared/widgets.css\">",
    "<style>",
    "html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;",
    "background:transparent;color:var(--md-on-surface,#fff);}",
    "#ose-root{position:absolute;inset:0;}",
    "</style></head><body><div id=\"ose-root\"></div>",
    "<script src=\"/shared/events.js\"></script>",
    "<script src=\"/shared/i18n.js\"></script>",
    "<script src=\"/shared/icons.js\"></script>",
    "<script src=\"/overlay/widgets/base-widget.js\"></script>",
    "<script src=\"/shared/plugin-sandbox.js\"></script>",
    "</body></html>",
  ].join("");

  function documentOf(node) {
    if (node && node.ownerDocument) return node.ownerDocument;
    return root.document || null;
  }

  function langOf() {
    if (root.I18n && typeof root.I18n.getLang === "function") return root.I18n.getLang();
    const doc = root.document;
    return (doc && doc.documentElement && doc.documentElement.lang) || "ru";
  }

  /*
    Снимок темы: ровно то, что оверлей поставил на `:root` и в `data-theme`.
    Сравнивается строкой, поэтому одинаковые снимки не гоняются в рамку на
    каждом обновлении раскладки.
  */
  function themeSnapshot() {
    const doc = root.document;
    if (!doc) return { id: "", tokens: {}, customCss: "", links: [] };
    const tokens = {};
    const style = doc.documentElement && doc.documentElement.style;
    if (style) {
      for (let index = 0; index < style.length; index += 1) {
        const name = style[index];
        if (name.startsWith("--")) tokens[name] = style.getPropertyValue(name).trim();
      }
    }
    const custom = doc.getElementById ? doc.getElementById("ose-custom-theme-css") : null;
    const links =
      doc.querySelectorAll && typeof doc.querySelectorAll === "function"
        ? Array.from(doc.querySelectorAll('link[id^="ose-plugin-theme-"]')).map((link) =>
            link.getAttribute("href")
          )
        : [];
    return {
      id: (doc.body && doc.body.dataset && doc.body.dataset.theme) || "",
      tokens,
      customCss: custom ? custom.textContent : "",
      links,
    };
  }

  class PluginFrameWidget extends BaseWidget {
    constructor(config = {}, context = {}, plugin = {}) {
      super(config, context);
      // Обёртка всегда остаётся DOM-элементом с iframe: даже если виджет сам
      // рисует на canvas или в WebGL, его холст живёт внутри рамки. Снаружи
      // нужны только геометрия и видимость — иначе BaseWidget попытался бы
      // создать WebGL-контекст на обёртке.
      this.widgetRenderType =
        this.renderType === "canvas" || this.renderType === "3d-webgl" ? this.renderType : "2d";
      this.renderType = "2d";
      this.plugin = plugin || {};
      this.frame = null;
      this.ready = false;
      this.queue = [];
      this.channels = new Map();
      this.themeKey = "";
      this.sentConfig = "";
      this._handleMessage = (event) => this.receive(event);
    }

    // ---- lifecycle ----

    _createElement() {
      const element = super._createElement();
      if (element && element.classList) element.classList.add("widget-instance--plugin");
      return element;
    }

    onMount() {
      const doc = documentOf(this.element);
      if (!doc || typeof doc.createElement !== "function") return;
      const frame = doc.createElement("iframe");
      frame.className = "plugin-frame";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("scrolling", "no");
      frame.setAttribute("title", `Пакет ${this.plugin.pluginId || ""}`);
      frame.srcdoc = SHELL;
      this.frame = frame;
      this.element.appendChild(frame);
      if (typeof root.addEventListener === "function") {
        root.addEventListener("message", this._handleMessage);
      }
    }

    onUpdate() {
      // `syncLayout` зовёт update и при смене одной темы — поэтому тему толкаем
      // здесь, а не только в render(): конфиг при этом может не измениться.
      this.pushTheme();
      this.sendUpdate();
    }

    onUnmount() {
      this.post({ ose: "unmount" });
      this.channels.forEach((off) => {
        try {
          off();
        } catch (_) {
          /* подписка уже снята вместе с шиной */
        }
      });
      this.channels.clear();
      if (typeof root.removeEventListener === "function") {
        root.removeEventListener("message", this._handleMessage);
      }
      this.frame = null;
      this.ready = false;
    }

    // ---- обмен сообщениями ----

    receive(event) {
      if (!this.frame || !this.frame.contentWindow) return;
      if (event.source !== this.frame.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object" || typeof data.ose !== "string") return;
      switch (data.ose) {
        case "ready":
          this.ready = true;
          this.sendInit();
          this.flush();
          break;
        case "sub":
          this.subscribeChannel(String(data.channel || ""));
          break;
        case "unsub":
          this.unsubscribeChannel(String(data.channel || ""));
          break;
        case "error":
          this.report(data.message, data.stack);
          break;
        default:
          break;
      }
    }

    post(message) {
      if (!this.ready) {
        this.queue.push(message);
        return;
      }
      const target = this.frame && this.frame.contentWindow;
      if (!target || typeof target.postMessage !== "function") return;
      try {
        target.postMessage(message, "*");
      } catch (_) {
        /* рамку вынули из страницы раньше, чем дошло сообщение */
      }
    }

    flush() {
      const queued = this.queue.splice(0);
      queued.forEach((message) => this.post(message));
    }

    // Настройки без `angle`: поворот уже применён к обёртке виджета.
    frameConfig() {
      const config = Object.assign({}, this.config);
      delete config.angle;
      return config;
    }

    sendInit() {
      const plugin = this.plugin || {};
      const theme = themeSnapshot();
      const config = this.frameConfig();
      this.themeKey = JSON.stringify(theme);
      this.sentConfig = JSON.stringify(config);
      this.post({
        ose: "init",
        id: this.id,
        type: this.type,
        pluginId: plugin.pluginId || String(this.type || "").replace(/^plugin:/, ""),
        baseUrl: plugin.baseUrl || "",
        entry: plugin.entry || "",
        styles: (plugin.styles || []).map((style) => `${plugin.baseUrl || ""}${style}`),
        renderType: this.widgetRenderType,
        family: plugin.family || "",
        config,
        theme,
        lang: langOf(),
      });
    }

    sendUpdate() {
      const config = this.frameConfig();
      const key = JSON.stringify(config);
      if (key === this.sentConfig) return;
      this.sentConfig = key;
      this.post({ ose: "update", config });
    }

    pushTheme() {
      const theme = themeSnapshot();
      const key = JSON.stringify(theme);
      if (key === this.themeKey) return;
      this.themeKey = key;
      this.post({ ose: "theme", theme });
    }

    // ---- события ----

    subscribeChannel(channel) {
      if (!channel || this.channels.has(channel)) return;
      const bus = this.context && this.context.bus;
      if (!bus || typeof bus.on !== "function") return;
      const off = bus.on(channel, (payload) => {
        this.post({ ose: "event", channel, payload });
      });
      this.channels.set(channel, typeof off === "function" ? off : () => {});
    }

    unsubscribeChannel(channel) {
      const off = this.channels.get(channel);
      if (!off) return;
      this.channels.delete(channel);
      try {
        off();
      } catch (_) {
        /* шина уже очищена */
      }
    }

    report(message, stack) {
      if (typeof console === "undefined" || !console.error) return;
      console.error(`[ose] пакет ${this.plugin.pluginId || this.type}: ${message || "ошибка"}`, stack || "");
    }
  }

  /* Класс на каждый пакет: менеджер виджетов регистрирует тип один раз, а
     параметры пакета зашиты в замыкание — раскладка их не присылает. */
  function createPluginWidget(plugin, def) {
    const source = plugin || {};
    const meta = {
      pluginId: source.id ? String(source.id) : "",
      baseUrl: source.baseUrl || (def && def.baseUrl) || "",
      entry: source.entry || (def && def.entry) || "",
      styles: Array.isArray(source.styles) ? source.styles.slice() : [],
      // Семейство темы нужно 3D-виджетам: по нему менеджер включает виджет
      // вместе с набором и передаёт его в контекст.
      family: (def && def.theme) || "",
    };
    const name = meta.pluginId || "plugin";
    const Remote = class extends PluginFrameWidget {
      constructor(config, context) {
        super(config, context, meta);
      }
    };
    try {
      Object.defineProperty(Remote, "name", { value: `PluginWidget(${name})` });
    } catch (_) {
      /* имя класса — только для отладки */
    }
    return Remote;
  }

  return { PluginFrameWidget, createPluginWidget };
});
