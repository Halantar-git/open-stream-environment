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
  Отправка сообщений из окна чата (chatwindow/chat-window.js).

  Модуль — обычный скрипт страницы, поэтому тест грузит его под минимальными
  заглушками DOM/WebSocket и говорит с ним так, как это делал бы сервер:
  отправляет CHAT_SENT (с clientId) и эхо CHAT_MESSAGE (без clientId, как его
  отдаёт Twitch). Проверяем адресацию статуса «✓» по строкам и то, что карта
  ожидающих ответа записей не растёт вечно.
*/

const { EVENT_TYPES } = require("../shared/events");

// ---- заглушки DOM / WebSocket ----

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    contains: (name) => set.has(name),
    toggle(name, force) {
      const on = force === undefined ? !set.has(name) : force;
      if (on) set.add(name);
      else set.delete(name);
      return on;
    },
  };
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    classList: makeClassList(),
    innerHTML: "",
    textContent: "",
    value: "",
    disabled: false,
    hidden: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    children: [],
    parentNode: null,
    listeners: new Map(),
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    },
    removeEventListener() {},
    dispatch(type, ev) {
      (this.listeners.get(type) || []).forEach((fn) => fn(ev || {}));
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    // Текст статуса строки лежит в отдельном узле, который в реальной разметке
    // создаётся из innerHTML — здесь отдаём его заглушкой, забрав начальный
    // символ («…» у отправляемой реплики) прямо из строки разметки.
    querySelector(selector) {
      if (selector !== ".chat-row__status") return null;
      if (!this._statusEl) {
        this._statusEl = makeEl("span");
        const match = /<span class="chat-row__status">([^<]*)<\/span>/.exec(this.innerHTML);
        this._statusEl.textContent = match ? match[1] : "";
      }
      return this._statusEl;
    },
  };
  Object.defineProperty(el, "firstChild", {
    get() {
      return this.children[0] || null;
    },
    configurable: true,
  });
  return el;
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    FakeWebSocket.last = this;
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  receive(message) {
    this.onmessage({ data: JSON.stringify(message) });
  }
}
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSED = 3;

let els;
let runtimeWindow;

function statusOf(row) {
  return row.querySelector(".chat-row__status").textContent;
}

function loadChatWindow() {
  jest.resetModules();
  els = {
    chatList: makeEl("div"),
    channelLabel: makeEl("span"),
    statusChip: makeEl("span"),
    statusLabel: makeEl("span"),
    jumpToLatest: makeEl("button"),
    chatComposer: makeEl("form"),
    chatInput: makeEl("input"),
    chatSendBtn: makeEl("button"),
  };
  global.window = runtimeWindow;
  global.document = {
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => els[id] || null,
    documentElement: makeEl("html"),
    body: makeEl("body"),
  };
  global.WebSocket = FakeWebSocket;
  global.location = { search: "" };
  require("../chatwindow/chat-window.js");
  return FakeWebSocket.last;
}

function typeAndSend(text) {
  els.chatInput.value = text;
  els.chatComposer.dispatch("submit", { preventDefault() {} });
  const sent = FakeWebSocket.last.sent.at(-1);
  return sent.payload.clientId;
}

const CHAT_SENT = EVENT_TYPES.CHAT_SENT;
const CHAT_MESSAGE = EVENT_TYPES.CHAT_MESSAGE;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  // У окна чата есть свой мост (window.chatDesktop) и словари (window.I18n);
  // в тесте они не нужны, но шина событий и объект window существовать обязаны.
  runtimeWindow = { SharedEvents: { EVENT_TYPES } };
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  delete global.window;
  delete global.document;
  delete global.WebSocket;
  delete global.location;
});

describe("chat-window: сопоставление эха и статусы отправки", () => {
  test("ответ сервера адресуется по clientId, а не по тексту", () => {
    const ws = loadChatWindow();

    const first = typeAndSend("hi");
    expect(first).toBeTruthy();
    const second = typeAndSend("hi");

    ws.receive({ type: CHAT_SENT, payload: { clientId: second, ok: true } });

    expect(els.chatList.children).toHaveLength(2);
    expect(statusOf(els.chatList.children[0])).toBe("…");
    expect(statusOf(els.chatList.children[1])).toBe("✓");
  });

  test("эхо встаёт на неподтверждённую строку, а не на старую с тем же текстом", () => {
    const ws = loadChatWindow();

    const first = typeAndSend("hi");
    ws.receive({ type: CHAT_SENT, payload: { clientId: first, ok: true } });
    const second = typeAndSend("hi");

    // Twitch отдаёт наше же сообщение обратно без clientId — только текстом.
    ws.receive({ type: CHAT_MESSAGE, payload: { user: "me", message: "hi", color: "#7ee0d6" } });

    expect(els.chatList.children).toHaveLength(2);
    expect(statusOf(els.chatList.children[0])).toBe("✓");
    // Подтверждённая запись больше не перехватывает эхо: «✓» достаётся второй строке.
    expect(statusOf(els.chatList.children[1])).toBe("✓");

    // Ответ сервера на второе сообщение уже не ждётся — запись снята.
    ws.receive({ type: CHAT_SENT, payload: { clientId: second, ok: true } });
    expect(els.chatList.children).toHaveLength(2);
  });

  test("устаревшая запись не перехватывает эхо нового сообщения", () => {
    const ws = loadChatWindow();

    const stale = typeAndSend("hi");
    expect(stale).toBeTruthy();

    // Ответа нет дольше, чем живёт запись (ECHO_MATCH_MS).
    jest.advanceTimersByTime(21000);

    typeAndSend("hi");
    ws.receive({ type: CHAT_MESSAGE, payload: { user: "me", message: "hi" } });

    expect(els.chatList.children).toHaveLength(2);
    expect(statusOf(els.chatList.children[0])).toBe("…"); // старая строка не тронута
    expect(statusOf(els.chatList.children[1])).toBe("✓");
  });

  test("подтверждённое сообщение не дублируется своим же эхом из чата", () => {
    const ws = loadChatWindow();

    const clientId = typeAndSend("hello");
    ws.receive({ type: CHAT_SENT, payload: { clientId, ok: true } });
    ws.receive({ type: CHAT_MESSAGE, payload: { user: "me", message: "hello" } });

    expect(els.chatList.children).toHaveLength(1);
    expect(statusOf(els.chatList.children[0])).toBe("✓");
  });

  test("чужие сообщения с другим текстом попадают в список", () => {
    const ws = loadChatWindow();

    typeAndSend("hi");
    ws.receive({ type: CHAT_MESSAGE, payload: { user: "viewer", message: "другое", color: "#fff" } });

    expect(els.chatList.children).toHaveLength(2);
    expect(statusOf(els.chatList.children[0])).toBe("…");
  });

  test("ошибка отправки помечает строку и снимает запись", () => {
    const ws = loadChatWindow();

    const clientId = typeAndSend("hi");
    ws.receive({ type: CHAT_SENT, payload: { clientId, ok: false, error: "not_authorized" } });
    expect(statusOf(els.chatList.children[0])).toBe("!");

    // Повторный CHAT_SENT с тем же clientId искать уже нечего.
    ws.receive({ type: CHAT_SENT, payload: { clientId, ok: true } });
    expect(statusOf(els.chatList.children[0])).toBe("!");
  });
});
