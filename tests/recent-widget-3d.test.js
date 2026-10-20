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
 3D-вариант «Последних событий». Проверяем то, что важно в эфире: лимит
 карточек, въезд новой карточки слева (класс is-entering), скорость анимации
 и пересборку при смене лимита.
*/

const RecentWidget3d = require("../overlay/widgets/recent-widget-3d");
const RecentWidget = require("../overlay/widgets/recent-widget");
const { EVENT_TYPES } = require("../shared/events");

function makeNode() {
  const classes = new Set();
  const node = {
    isConnected: false,
    hidden: false,
    dataset: {},
    className: "",
    children: [],
    style: {
      props: {},
      transition: "",
      transform: "",
      setProperty(key, value) {
        this.props[key] = value;
      },
    },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      this.children.push(child);
      child.parentNode = this;
      child.isConnected = true;
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      child.isConnected = false;
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
      else this.isConnected = false;
    },
    getBoundingClientRect() {
      return { top: 0 };
    },
    _html: "",
    get innerHTML() {
      return this._html;
    },
    set innerHTML(value) {
      this._html = String(value);
    },
    _text: "",
    get textContent() {
      return this._text;
    },
    set textContent(value) {
      this._text = String(value);
    },
  };
  return node;
}

function event(user, at) {
  return { kind: "follow", user, at };
}

function setup(config = {}, recentEvents = []) {
  const handlers = new Map();
  const bus = {
    on(channel, handler) {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
  };
  const state = { recentEvents };
  global.document = { createElement: () => makeNode() };

  const widget = new RecentWidget3d(
    { type: "grimhex-recent", config },
    {
      state,
      bus,
      EVENT_TYPES,
      escapeHtml: (value) => String(value),
      escapeAttr: (value) => String(value),
      formatMoney: (value) => String(value),
      t: (key, params) => {
        if (key === "preview.recentTitle") return "Последние события";
        if (key === "recent.follow") return `${params.user} — фоллоу`;
        if (key === "recent.sub") return `${params.user} — подписка`;
        if (key === "recent.subResub") return `${params.user} — продление ${params.months} мес.`;
        return key;
      },
    }
  );
  widget.element = makeNode();
  widget.onMount();

  return {
    widget,
    state,
    emit: (channel, payload) => handlers.get(channel)(payload),
  };
}

describe("RecentWidget3d", () => {
  afterEach(() => {
    delete global.document;
  });

  test("показывает не больше maxItems событий", () => {
    const { widget } = setup(
      { maxItems: 2 },
      [event("a", 3), event("b", 2), event("c", 1)]
    );

    expect(widget.listEl.children).toHaveLength(2);
    expect(widget.listEl.children[0].innerHTML).toContain("a");
    expect(widget.listEl.children[1].innerHTML).toContain("b");
  });

  test("новое событие въезжает слева", () => {
    const { widget, state, emit } = setup({ maxItems: 3 }, [event("old", 1)]);
    expect(widget.listEl.children[0].classList.contains("is-entering")).toBe(false);

    state.recentEvents = [event("new", 2), event("old", 1)];
    emit(EVENT_TYPES.RECENT_EVENT, event("new", 2));

    expect(widget.listEl.children).toHaveLength(2);
    expect(widget.listEl.children[0].innerHTML).toContain("new");
    expect(widget.listEl.children[0].classList.contains("is-entering")).toBe(true);
  });

  test("скорость анимации попадает в CSS-переменную", () => {
    const { widget } = setup({ animationMs: 250 }, [event("a", 1)]);
    expect(widget.host.style.props["--recent-animation"]).toBe("250ms");
  });

  test("продление показывает стаж подписки, новая — нет", () => {
    const { widget } = setup({}, []);
    expect(widget._text({ kind: "sub", user: "loyal", months: 14, resub: true })).toBe("<b>loyal</b> — продление 14 мес.");
    expect(widget._text({ kind: "sub", user: "nova", months: 1, resub: false })).toBe("<b>nova</b> — подписка");
  });

  test("перспектива наклоняет виджет и учитывает направление", () => {
    const right = setup({ perspective: 50, perspectiveDirection: "right" }, []).widget;
    expect(right.element.style.transform).toBe("perspective(1200px) rotateY(7.5deg) rotateX(1.5deg)");
    expect(right.element.style.transformStyle).toBe("preserve-3d");

    const up = setup({ perspective: 50, perspectiveDirection: "up" }, []).widget;
    expect(up.element.style.transform).toBe("perspective(1200px) rotateY(0deg) rotateX(7.5deg)");

    const flat = setup({ perspective: 0 }, []).widget;
    expect(flat.element.style.transform).toBe("");
    expect(flat.element.style.transformStyle).toBe("");
  });

  test("смена перспективы не пересобирает список", () => {
    const { widget } = setup({}, [event("a", 1)]);
    const before = widget.listEl.children.length;

    widget.config = { ...widget.config, perspective: 30 };
    widget.onUpdate({}, widget.config);

    expect(widget.element.style.transform).toContain("perspective(1200px)");
    expect(widget.listEl.children).toHaveLength(before);
  });

  test("2D-вариант тоже получает наклон", () => {
    global.document = { createElement: () => makeNode() };
    const handlers = new Map();
    const widget = new RecentWidget(
      { type: "recent", config: { perspective: 100 } },
      {
        state: { recentEvents: [] },
        bus: { on: (channel, handler) => handlers.set(channel, handler) },
        EVENT_TYPES,
        escapeHtml: (value) => String(value),
        formatMoney: (value) => String(value),
        t: (key) => key,
      }
    );
    widget.element = makeNode();
    widget.onMount();

    expect(widget.element.style.transform).toBe("perspective(1200px) rotateY(-15deg) rotateX(3deg)");
  });

  test("смена лимита пересобирает список", () => {
    const { widget } = setup({ maxItems: 3 }, [event("a", 3), event("b", 2), event("c", 1)]);

    widget.config = { ...widget.config, maxItems: 1 };
    widget.onUpdate({ maxItems: 3 }, widget.config);

    expect(widget.listEl.children).toHaveLength(1);
    expect(widget.listEl.children[0].innerHTML).toContain("a");
  });
});
