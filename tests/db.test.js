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

  afterEach(() => {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  });

  test("создаёт коллекции по умолчанию", () => {
    const defaults = defaultData();
    expect(db.getWidgets()).toEqual(defaults.overlay.widgets);
    expect(db.getSessions()).toEqual([]);
    expect(db.getChat()).toEqual([]);
    expect(db.getStreamEvents({ limit: 50 })).toEqual({ items: [], total: 0 });
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
});
