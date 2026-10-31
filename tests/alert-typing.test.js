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
  Посимвольная печать текста алерта.

  Проверяем сам приём, а не разметку тем: текст появляется порциями, каретка
  переезжает к следующей строке, `stop()` дорисовывает всё, а без движения
  (prefers-reduced-motion) текст виден сразу.
*/

const { typeAlertText } = require("../overlay/widgets/alert-typing");

// ---- минимальный DOM: узлы, текстовые узлы и соседи ----

function siblingGetter() {
  return {
    get() {
      if (!this.parentNode) return null;
      const list = this.parentNode.childNodes;
      const index = list.indexOf(this);
      return index >= 0 ? list[index + 1] || null : null;
    },
    configurable: true,
  };
}

function makeEl(tag) {
  const el = {
    nodeType: 1,
    nodeName: tag === "svg" ? "svg" : String(tag || "div").toUpperCase(),
    childNodes: [],
    parentNode: null,
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      const index = this.childNodes.indexOf(ref);
      if (index < 0) return this.appendChild(child);
      child.parentNode = this;
      this.childNodes.splice(index, 0, child);
      return child;
    },
    append(...children) {
      children.forEach((child) => this.appendChild(child));
      return this;
    },
  };
  Object.defineProperty(el, "nextSibling", siblingGetter());
  return el;
}

function makeText(value) {
  const node = { nodeType: 3, nodeValue: value, parentNode: null };
  Object.defineProperty(node, "nextSibling", siblingGetter());
  return node;
}

function card() {
  const root = makeEl("div");
  const kicker = makeEl("span");
  const name = makeEl("div");
  const message = makeEl("div");
  kicker.appendChild(makeText("FOLLOW"));
  name.appendChild(makeText("bob"));
  message.appendChild(makeText("привет"));
  root.append(kicker, name, message);
  return { root, kicker, name, message };
}

let originalDocument;
let originalMatchMedia;

beforeEach(() => {
  jest.useFakeTimers();
  originalDocument = global.document;
  originalMatchMedia = global.matchMedia;
  global.document = { createElement: (tag) => makeEl(tag) };
  delete global.matchMedia;
});

afterEach(() => {
  global.document = originalDocument;
  global.matchMedia = originalMatchMedia;
  jest.useRealTimers();
});

describe("typeAlertText", () => {
  test("печатает текстовые узлы по порядку и оставляет каретку в конце", () => {
    const { root, kicker, name, message } = card();

    typeAlertText(root);
    // Пока не прошёл такт, все строки пустые, а каретка стоит в начале.
    expect(kicker.childNodes[0].nodeValue).toBe("");
    expect(name.childNodes[0].nodeValue).toBe("");
    expect(kicker.childNodes[1].className).toBe("alert-type-caret");

    jest.advanceTimersByTime(16);
    expect(kicker.childNodes[0].nodeValue).toBe("FO");

    // Первая строка допечатана — каретка переехала к имени.
    jest.advanceTimersByTime(32);
    expect(kicker.childNodes[0].nodeValue).toBe("FOLLOW");
    expect(name.childNodes.some((child) => child.className === "alert-type-caret")).toBe(true);

    jest.advanceTimersByTime(200);
    expect(name.childNodes[0].nodeValue).toBe("bob");
    expect(message.childNodes[0].nodeValue).toBe("привет");
    expect(message.childNodes.some((child) => child.className === "alert-type-caret")).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("stop() дорисовывает текст и убирает каретку", () => {
    const { root, kicker, name, message } = card();
    const typing = typeAlertText(root);

    jest.advanceTimersByTime(16);
    typing.stop();

    expect(kicker.childNodes[0].nodeValue).toBe("FOLLOW");
    expect(name.childNodes[0].nodeValue).toBe("bob");
    expect(message.childNodes[0].nodeValue).toBe("привет");
    expect(kicker.childNodes.some((child) => child.className === "alert-type-caret")).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("без движения показывает текст сразу", () => {
    global.matchMedia = () => ({ matches: true });
    const { root, kicker, name, message } = card();

    typeAlertText(root);

    expect(kicker.childNodes[0].nodeValue).toBe("FOLLOW");
    expect(name.childNodes[0].nodeValue).toBe("bob");
    expect(message.childNodes[0].nodeValue).toBe("привет");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("не трогает содержимое иконок", () => {
    const root = makeEl("div");
    const icon = makeEl("svg");
    const label = makeEl("span");
    icon.appendChild(makeText("✱"));
    label.appendChild(makeText("ok"));
    root.append(icon, label);

    typeAlertText(root);
    jest.advanceTimersByTime(1000);

    expect(icon.childNodes[0].nodeValue).toBe("✱");
    expect(label.childNodes[0].nodeValue).toBe("ok");
  });

  test("молчит на разметке без узлов (заглушки тестов)", () => {
    const root = { innerHTML: "<div>hi</div>" };
    expect(() => typeAlertText(root)).not.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });
});
