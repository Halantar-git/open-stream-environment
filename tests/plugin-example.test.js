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
  Пример last-donation: код пакета запускается как обычный скрипт страницы.
  Проверяем, что он регистрирует виджет, читает настройки и обновляется по
  событию шины — без браузера, на маленькой подделке DOM.
*/

const fs = require("fs");
const path = require("path");

const PACKAGE = path.join(__dirname, "..", "docs", "examples", "plugins", "last-donation");

function makeDocument() {
  return {
    documentElement: { lang: "ru" },
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        className: "",
        style: {},
        children: [],
        textContent: "",
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      };
    },
  };
}

function loadWidget() {
  const BaseWidget = class {
    constructor(config = {}, context = {}) {
      this.config = config.config || {};
      this.context = context;
      this.element = null;
      this.subscriptions = [];
    }

    subscribe(channel, handler) {
      this.subscriptions.push({ channel, handler });
      return { channel, handler, off: () => {} };
    }
  };

  let WidgetClass = null;
  const OSE = {
    BaseWidget,
    EVENT_TYPES: { ALERT: "alert" },
    defineWidget(id, klass) {
      if (id === "last-donation") WidgetClass = klass;
    },
  };

  const document = makeDocument();
  const window = { OSE };
  const code = fs.readFileSync(path.join(PACKAGE, "widget.js"), "utf8");
  new Function("window", "document", code)(window, document);
  return { WidgetClass, document };
}

function collect(node, out = []) {
  if (node.textContent) out.push(node.textContent);
  node.children.forEach((child) => collect(child, out));
  return out;
}

function context(overrides = {}) {
  return {
    formatMoney: (value) => String(value),
    currencySymbol: (code) => (code === "RUB" ? "₽" : String(code || "")),
    readCssVar: () => "#123456",
    ...overrides,
  };
}

describe("пример last-donation", () => {
  test("регистрируется и показывает подсказку до первого доната", () => {
    const { WidgetClass, document } = loadWidget();
    expect(typeof WidgetClass).toBe("function");

    const widget = new WidgetClass({ config: { title: "Донат" } }, context());
    widget.element = document.createElement("div");
    widget.render();

    expect(collect(widget.element)).toEqual(["Донат", "Ждём донат"]);
  });

  test("обновляется на донате и читает настройки", () => {
    const { WidgetClass, document } = loadWidget();
    const widget = new WidgetClass(
      { config: { title: "Донат", amountSize: 48, accent: "#ffffff", showMessage: true } },
      context()
    );
    widget.element = document.createElement("div");
    widget.onMount();

    expect(widget.subscriptions[0].channel).toBe("alert");

    // Фолловер — не донат: карточка не меняется и даже не рисуется.
    widget.subscriptions[0].handler({ kind: "follow", user: "fan" });
    expect(widget.element.children).toHaveLength(0);

    widget.subscriptions[0].handler({
      kind: "donation",
      user: "Вася",
      amount: 1000,
      currency: "RUB",
      message: "на корабль",
    });

    expect(collect(widget.element)).toEqual(["Донат", "1000 ₽", "Вася", "на корабль"]);
    expect(widget.element.children[1].style.fontSize).toBe("48px");
    expect(widget.element.children[1].style.color).toBe("#ffffff");
  });

  test("без сообщения не выводит его и берёт цвет из темы", () => {
    const { WidgetClass, document } = loadWidget();
    const widget = new WidgetClass(
      { config: { title: "Донат", accent: "", showMessage: false } },
      context({ readCssVar: () => "#abcdef" })
    );
    widget.element = document.createElement("div");
    widget.onMount();

    widget.subscriptions[0].handler({
      kind: "donation",
      user: "Вася",
      amount: 500,
      currency: "RUB",
      message: "секрет",
    });

    expect(collect(widget.element)).toEqual(["Донат", "500 ₽", "Вася"]);
    expect(widget.element.children[1].style.color).toBe("#abcdef");
  });
});
