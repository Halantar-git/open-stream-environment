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

  test("смена лимита пересобирает список", () => {
    const { widget } = setup({ maxItems: 3 }, [event("a", 3), event("b", 2), event("c", 1)]);

    widget.config = { ...widget.config, maxItems: 1 };
    widget.onUpdate({ maxItems: 3 }, widget.config);

    expect(widget.listEl.children).toHaveLength(1);
    expect(widget.listEl.children[0].innerHTML).toContain("a");
  });
});
