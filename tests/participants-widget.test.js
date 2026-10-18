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
  Виджет участников розыгрыша. Проверяем то, что видно в эфире: пока
  участников нет — плашки нет, длинный список обрезается по `maxNames`
  с остатком «+N», а бегущая строка выводит всех.
*/

const ParticipantsWidget = require("../overlay/widgets/participants-widget");
const { EVENT_TYPES } = require("../shared/events");

function makeHost() {
  const props = {};
  return {
    hidden: false,
    innerHTML: "",
    className: "",
    style: {
      setProperty: (key, value) => {
        props[key] = value;
      },
    },
    props,
  };
}

function setup(config = {}, giveaway = { count: 0, participants: [] }) {
  const handlers = new Map();
  const bus = {
    on(channel, handler) {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
  };
  global.document = { createElement: () => makeHost() };

  const widget = new ParticipantsWidget(
    { type: "participants", config },
    {
      state: { giveaway },
      bus,
      EVENT_TYPES,
      escapeHtml: (value) => String(value),
      t: (key, params) =>
        key === "wheelScene.participantsTitle" ? `Участники: ${params.count}` : key,
    }
  );
  widget.element = { appendChild() {} };
  widget.onMount();
  widget.render();
  return { widget, emit: (channel, payload) => handlers.get(channel)(payload) };
}

describe("ParticipantsWidget", () => {
  afterEach(() => {
    delete global.document;
  });

  test("скрыт, пока участников нет", () => {
    const { widget } = setup();
    expect(widget.host.hidden).toBe(true);
    expect(widget.host.innerHTML).toBe("");
  });

  test("показывает не больше maxNames и остаток «+N»", () => {
    const participants = ["a", "b", "c", "d", "e", "f", "g"];
    const { widget } = setup({ maxNames: 3 }, { count: participants.length, participants });

    expect(widget.host.hidden).toBe(false);
    expect(widget.host.innerHTML).toContain("Участники: 7");
    expect(widget.host.innerHTML).toContain(">a<");
    expect(widget.host.innerHTML).toContain(">c<");
    expect(widget.host.innerHTML).not.toContain(">d<");
    expect(widget.host.innerHTML).toContain("+4");
  });

  test("бегущая строка выводит всех участников", () => {
    const participants = ["a", "b", "c"];
    const { widget } = setup({ marquee: true, maxNames: 1 }, { count: 3, participants });

    expect(widget.host.innerHTML).toContain("widget-participants__marquee");
    expect(widget.host.innerHTML).toContain("a • b • c");
  });

  test("переносит настройки оформления в CSS-переменные", () => {
    const { widget } = setup(
      { fontSize: 21, textColor: "#ff0000", backgroundOpacity: 40 },
      { count: 1, participants: ["a"] }
    );

    expect(widget.host.props["--pw-font-size"]).toBe("21px");
    expect(widget.host.props["--pw-text"]).toBe("#ff0000");
    expect(widget.host.props["--pw-bg-opacity"]).toBe("40%");
  });

  test("обновляется событием giveaway_participants", () => {
    const { widget, emit } = setup();
    expect(widget.host.hidden).toBe(true);

    emit(EVENT_TYPES.GIVEAWAY_PARTICIPANTS, { count: 2, participants: ["nova", "orbit"] });

    expect(widget.host.hidden).toBe(false);
    expect(widget.host.innerHTML).toContain("Участники: 2");
    expect(widget.host.innerHTML).toContain("nova");
    expect(widget.host.innerHTML).toContain("orbit");
  });
});
