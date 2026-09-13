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

const fs = require("fs");
const os = require("os");
const path = require("path");

const { createDatabase, defaultData } = require("../server/db");

describe("server/db", () => {
  let dbPath;
  let db;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `ose-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    db = createDatabase(dbPath);
  });

  afterEach(async () => {
    await db.flush();
    for (const file of [dbPath, dbPath.replace(/\.json$/i, ".jsonl"), dbPath.replace(/\.json$/i, ".chat.jsonl")]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  });

  test("создаёт коллекции по умолчанию", () => {
    const defaults = defaultData();
    expect(db.getWidgets()).toEqual(defaults.overlay.widgets);
    expect(db.getSessions()).toEqual([]);
    expect(db.getChat()).toEqual([]);
    expect(db.getStreamEvents({ limit: 50 })).toEqual({ items: [], total: 0 });
  });

  test("сохраняет и читает пресеты раскладки", () => {
    expect(db.getLayoutPresets()).toEqual([]);

    const saved = db.saveLayoutPresets([{ id: "p1", name: "Основной", widgets: [{ id: "w1" }] }]);
    expect(saved).toHaveLength(1);
    expect(db.getLayoutPresets()[0].name).toBe("Основной");
  });

  test("сохраняет и читает пресеты голосования", () => {
    expect(db.getPollPresets()).toEqual([]);

    const saved = db.savePollPresets([{ id: "pp1", name: "Опрос", command: "!poll", chartType: "bars", options: [{ id: "o1", label: "Да" }] }]);
    expect(saved).toHaveLength(1);
    expect(db.getPollPresets()[0].name).toBe("Опрос");
  });

  test("записывает и читает донат из истории", () => {
    const row = db.appendStreamEvent({
      type: "donation",
      kind: "donation",
      username: "viewer",
      amount: 100,
      currency: "RUB",
      message: "hello",
      is_test: false,
    });
    expect(row.id).toBeTruthy();

    const history = db.getStreamEvents({ limit: 10 });
    expect(history.total).toBe(1);
    expect(history.items[0].username).toBe("viewer");
    expect(history.items[0].amount).toBe(100);
  });

  test("clearHistory очищает историю, но сохраняет настройки", () => {
    db.appendStreamEvent({ type: "donation", kind: "donation", username: "a", amount: 1 });
    db.appendChat({ user: "a", message: "hi" });
    db.startSession("test");
    db.saveWheelConfig({ musicVolume: 70 });

    db.clearHistory();

    expect(db.getStreamEvents({ limit: 10 }).total).toBe(0);
    expect(db.getChat()).toEqual([]);
    expect(db.getSessions()).toEqual([]);
    expect(db.getWheelConfig().musicVolume).toBe(70);
  });

  test("clearAll сбрасывает всё к значениям по умолчанию", () => {
    db.saveWidgets([{ id: "x" }]);
    db.saveWheelConfig({ musicVolume: 70 });
    db.appendStreamEvent({ type: "donation", kind: "donation", username: "a", amount: 1 });

    db.clearAll();

    expect(db.getWidgets()).toEqual([]);
    expect(db.getWheelConfig().musicVolume).toBe(50);
    expect(db.getStreamEvents({ limit: 10 }).total).toBe(0);
  });

  test("пишет и читает историю чата с пагинацией", () => {
    db.appendChat({ user: "alice", message: "hi", sessionId: "s1", timestamp: 1 });
    db.appendChat({ user: "bob", message: "yo", sessionId: "s1", timestamp: 2 });
    db.appendChat({ user: "carol", message: "hey", timestamp: 3 });

    expect(db.getChat().length).toBe(3);
    expect(db.getChat({ sessionId: "s1" }).length).toBe(2);

    const page = db.getChatPage({ limit: 2, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.items.length).toBe(2);
    expect(page.items[0].username).toBe("carol");
  });

  test("история чата отключается настройкой", () => {
    expect(db.getChatHistoryEnabled()).toBe(true);
    db.setChatHistoryEnabled(false);
    expect(db.getChatHistoryEnabled()).toBe(false);
    expect(db.appendChat({ user: "a", message: "hi" })).toBeNull();
    expect(db.getChat().length).toBe(0);

    db.setChatHistoryEnabled(true);
    expect(db.appendChat({ user: "a", message: "hi" })).not.toBeNull();
  });

  test("clearChat и clearSessions чистят только свою область", () => {
    db.appendStreamEvent({ type: "donation", username: "a", amount: 1 });
    db.appendChat({ user: "a", message: "hi" });
    db.startSession("test");

    db.clearChat();
    expect(db.getChat().length).toBe(0);
    expect(db.getStreamEvents({ limit: 10 }).total).toBe(1);
    expect(db.getSessions().length).toBe(1);

    db.clearSessions();
    expect(db.getSessions().length).toBe(0);
    expect(db.getStreamEvents({ limit: 10 }).total).toBe(1);
  });

  test("getSessionsWithStats агрегирует события и чат по времени", () => {
    const session = db.startSession("chan");
    db.appendStreamEvent({ type: "donation", username: "a", amount: 5 });
    db.appendStreamEvent({ type: "follow", username: "b" });
    db.appendChat({ user: "a", message: "hi", sessionId: session.id });

    const stats = db.getSessionsWithStats();
    expect(stats).toHaveLength(1);
    expect(stats[0].id).toBe(session.id);
    expect(stats[0].channel).toBe("chan");
    expect(stats[0].events).toBe(2);
    expect(stats[0].donations).toBe(1);
    expect(stats[0].chat).toBe(1);
    expect(stats[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test("removeStreamEvents удаляет по фильтру", () => {
    db.appendStreamEvent({ type: "donation", username: "a", amount: 1 });
    db.appendStreamEvent({ type: "follow", username: "b" });
    expect(db.removeStreamEvents({ type: "donation" })).toBe(1);
    expect(db.getStreamEvents({ limit: 10 }).total).toBe(1);
  });

  test("лимит истории применяется и сохраняется", () => {
    expect(db.setHistoryLimit(5)).toBe(5);
    expect(db.getHistoryLimit()).toBe(5);
    for (let i = 0; i < 10; i++) db.appendStreamEvent({ type: "follow", username: `u${i}` });
    expect(db.getStreamEvents({ limit: 100 }).total).toBe(5);
    expect(db.setHistoryLimit(0)).toBe(0);
  });

  test("getStorageStats возвращает пути, размеры и счётчики", () => {
    db.startSession("x");
    db.appendStreamEvent({ type: "follow", username: "a" });
    db.appendChat({ user: "a", message: "hi" });

    const stats = db.getStorageStats();
    expect(stats.dir).toBe(path.dirname(dbPath));
    expect(stats.database.path).toBe(dbPath);
    expect(stats.history.path).toContain(".jsonl");
    expect(stats.chat.path).toContain(".chat.jsonl");
    expect(stats.sessions).toBe(1);
    expect(stats.history.count).toBe(1);
    expect(stats.chat.count).toBe(1);
    expect(typeof stats.history.bytes).toBe("number");
  });
});
