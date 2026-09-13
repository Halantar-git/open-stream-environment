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
  Интеграционные тесты асинхронной записи БД: persist() ставит снапшот в
  очередь, flush() дожидается записи, история событий дописывается в JSONL,
  temp-файлы не остаются.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const { configureStorage } = require("../server/storage-paths");
const { createDatabase } = require("../server/db");

function historyLines(dir) {
  const file = path.join(dir, "local-db.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("db async persist", () => {
  test("persist + flush сохраняет все события и не оставляет temp", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ose-db-"));
    configureStorage({ configDir: dir });
    const dbPath = path.join(dir, "local-db.json");
    const db = createDatabase(dbPath);

    for (let i = 0; i < 200; i++) {
      db.appendStreamEvent({ type: "donation", username: `u${i}`, amount: i });
    }
    await db.flush();

    expect(historyLines(dir)).toHaveLength(200);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("flushSync синхронно пишет последнее состояние", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ose-db-"));
    configureStorage({ configDir: dir });
    const dbPath = path.join(dir, "local-db.json");
    const db = createDatabase(dbPath);

    db.appendStreamEvent({ type: "follow", username: "sync_user" });
    expect(db.flushSync()).toBe(true);

    const rows = historyLines(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe("sync_user");
  });

  test("legacy stream_events из local-db.json переносятся в JSONL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ose-db-"));
    configureStorage({ configDir: dir });
    const dbPath = path.join(dir, "local-db.json");

    fs.writeFileSync(
      dbPath,
      JSON.stringify({
        overlay: { widgets: [] },
        sessions: [],
        stream_events: [
          { id: "leg1", timestamp: 1, type: "donation", username: "legacy" },
          { id: "leg2", timestamp: 2, type: "follow", username: "old" },
        ],
      })
    );

    const db = createDatabase(dbPath);
    expect(db.getStreamEvents({ limit: 10 }).total).toBe(2);
    expect(db.getStreamEventById("leg2").username).toBe("old");

    await db.flush();
    expect(historyLines(dir).map((r) => r.id)).toEqual(["leg1", "leg2"]);

    // stream_events больше не висят в local-db.json
    const data = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    expect(data.stream_events).toBeUndefined();
  });

  test("legacy chatMessages из local-db.json переносятся в JSONL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ose-db-"));
    configureStorage({ configDir: dir });
    const dbPath = path.join(dir, "local-db.json");

    fs.writeFileSync(
      dbPath,
      JSON.stringify({
        sessions: [],
        chatMessages: [
          { id: "c1", timestamp: 1, username: "old", message: "hi" },
          { id: "c2", timestamp: 2, username: "old2", message: "yo" },
        ],
      })
    );

    const db = createDatabase(dbPath);
    expect(db.getChat().length).toBe(2);

    await db.flush();
    const chatFile = path.join(dir, "local-db.chat.jsonl");
    const lines = fs.readFileSync(chatFile, "utf8").split("\n").filter((l) => l.trim());
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(["c1", "c2"]);

    const data = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    expect(data.chatMessages).toEqual([]);
  });
});
