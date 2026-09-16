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
  Unit tests for server/atomic-write.js: the synchronous atomic write and the
  AsyncAtomicStore (coalescing, unique hidden temp files, rename retry,
  recovery after a failed write, synchronous flush).
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const { atomicWriteFileSync, AsyncAtomicStore, sweepStaleTempFiles } = require("../server/atomic-write");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ose-atomic-"));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("atomic-write", () => {
  test("atomicWriteFileSync заменяет файл и не оставляет temp", () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    fs.writeFileSync(file, "old");
    atomicWriteFileSync(file, "new");
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(fs.readdirSync(dir)).toEqual(["store.json"]);
  });

  test("AsyncAtomicStore пишет последний снапшот и убирает temp", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const store = new AsyncAtomicStore(file);

    store.write({ a: 1 });
    store.write({ a: 2 });
    store.write({ a: 3 });
    await store.flush();

    expect(readJson(file)).toEqual({ a: 3 });
    // Рядом живут только сам файл и, возможно, бэкап (см. atomic-backup.test.js):
    // важно, что temp-мусора не осталось.
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(store.lastError).toBeNull();
  });

  test("коалесинг: частые write не пишут файл столько же раз", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    let renames = 0;
    const store = new AsyncAtomicStore(file, {
      rename: async (from, to) => {
        renames += 1;
        return fs.promises.rename(from, to);
      },
    });

    for (let i = 0; i < 10; i++) store.write({ a: i });
    await store.flush();

    expect(readJson(file)).toEqual({ a: 9 });
    expect(renames).toBeLessThan(10);
  });

  test("ошибка одной записи не ломает следующие (очередь восстанавливается)", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    let failOnce = true;
    const store = new AsyncAtomicStore(file, {
      logger: () => {},
      rename: async (from, to) => {
        if (failOnce) {
          failOnce = false;
          const err = new Error("boom");
          err.code = "EIO";
          throw err;
        }
        return fs.promises.rename(from, to);
      },
    });

    store.write({ a: 1 });
    await store.flush();
    expect(store.lastError).toBeTruthy();

    store.write({ a: 2 });
    await store.flush();
    expect(store.lastError).toBeNull();
    expect(readJson(file)).toEqual({ a: 2 });
    expect(fs.readdirSync(dir)).toEqual(["store.json"]);
  });

  test("rename ретраится на EPERM (Windows lock)", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    let attempts = 0;
    const store = new AsyncAtomicStore(file, {
      renameRetries: 4,
      renameRetryDelayMs: 1,
      rename: async (from, to) => {
        attempts += 1;
        if (attempts <= 2) {
          const err = new Error("locked");
          err.code = "EPERM";
          throw err;
        }
        return fs.promises.rename(from, to);
      },
    });

    store.write({ a: 1 });
    await store.flush();
    expect(attempts).toBe(3);
    expect(readJson(file)).toEqual({ a: 1 });
  });

  test("temp-файлы уникальны и скрыты", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const froms = [];
    const store = new AsyncAtomicStore(file, {
      rename: async (from, to) => {
        froms.push(path.basename(from));
        return fs.promises.rename(from, to);
      },
    });

    store.write({ a: 1 });
    await store.flush();
    store.write({ a: 2 });
    await store.flush();

    expect(froms).toHaveLength(2);
    expect(froms[0]).not.toBe(froms[1]);
    froms.forEach((name) => expect(name.startsWith(".")).toBe(true));
  });

  test("flushSync пишет последний снапшот синхронно", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const store = new AsyncAtomicStore(file);
    store.write({ a: 1 });
    const wrote = store.flushSync();
    expect(wrote).toBe(true);
    expect(readJson(file)).toEqual({ a: 1 });
    await store.flush();
  });

  test("создаёт отсутствующие каталоги и поддерживает fsync", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "nested", "deep", "store.json");
    const store = new AsyncAtomicStore(file, { fsync: true });
    store.write({ ok: true });
    await store.flush();
    expect(readJson(file)).toEqual({ ok: true });
    expect(fs.readFileSync(file, "utf8")).toContain("\n"); // pretty-print по умолчанию
  });

  test("статистика: записи, байты и схлопнутые снапшоты", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const store = new AsyncAtomicStore(file);

    for (let i = 0; i < 5; i++) store.write({ a: i, pad: "x".repeat(50) });
    await store.flush();

    const { total } = store.getStats();
    expect(total.writes).toBeGreaterThanOrEqual(1);
    expect(total.writes).toBeLessThan(5);
    expect(total.coalesced).toBeGreaterThan(0);
    // Каждый снапшот либо записан, либо схлопнут.
    expect(total.writes + total.coalesced).toBe(5);
    expect(total.bytes).toBeGreaterThan(0);
    expect(total.failed).toBe(0);

    store.stop();
  });

  test("убирает осиротевшие temp-файлы, но не свежие", () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const stale = path.join(dir, ".store.json.12345.7.tmp");
    const fresh = path.join(dir, ".store.json.999.1.tmp");
    fs.writeFileSync(stale, "x");
    fs.writeFileSync(fresh, "x");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    // Конструктор стора подчищает мусор от убитых процессов.
    const store = new AsyncAtomicStore(file);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    store.stop();
  });

  test("sweepStaleTempFiles возвращает число удалённых", () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const a = path.join(dir, ".store.json.1.1.tmp");
    const b = path.join(dir, ".store.json.2.2.tmp");
    fs.writeFileSync(a, "x");
    fs.writeFileSync(b, "x");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(a, old, old);
    fs.utimesSync(b, old, old);
    expect(sweepStaleTempFiles(file)).toBe(2);
  });

  test("отчёт по интервалу: строка только когда были записи", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const lines = [];
    const store = new AsyncAtomicStore(file, {
      label: "store.json",
      report: (line) => lines.push(line),
      reportEveryMs: 10,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lines).toHaveLength(0); // в простое не шумит

    store.write({ a: 1 });
    await store.flush();
    await new Promise((resolve) => setTimeout(resolve, 40));
    store.stop();

    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("store.json");
    expect(lines[0]).toContain("записей 1");
  });
});
