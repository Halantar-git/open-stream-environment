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
  Бэкапы в AsyncAtomicStore: бэкап должен содержать предыдущий УДАЧНО
  записанный снапшот (а не то, что осталось в файле), слоты должны
  проворачиваться, а сама ротация — не мешать основной записи.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const { AsyncAtomicStore, rotateBackups, backupPath } = require("../server/atomic-write");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ose-backup-"));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Одна мутация = одна запись на диск (ждём flush), иначе снапшоты схлопнутся
// и порядок в бэкапах окажется другим.
async function save(store, value) {
  store.write(value);
  await store.flush();
}

describe("atomic-write: бэкапы снапшотов", () => {
  test("первое сохранение в процессе не создаёт бэкап: бэкапить ещё нечего", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const store = new AsyncAtomicStore(file, { backupEveryMs: 0 });

    await save(store, { a: 1 });

    expect(readJson(file)).toEqual({ a: 1 });
    expect(fs.existsSync(backupPath(file, 0))).toBe(false);
    store.stop();
  });

  test("в .bak.0 лежит предыдущий удачный снапшот", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const store = new AsyncAtomicStore(file, { backupSlots: 2, backupEveryMs: 0 });

    await save(store, { a: 1 });
    await save(store, { a: 2 });

    expect(readJson(file)).toEqual({ a: 2 });
    expect(readJson(backupPath(file, 0))).toEqual({ a: 1 });
    expect(fs.existsSync(backupPath(file, 1))).toBe(false);
    store.stop();
  });

  test("слоты проворачиваются: .bak.0 свежее, .bak.1 старше", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const store = new AsyncAtomicStore(file, { backupSlots: 2, backupEveryMs: 0 });

    await save(store, { a: 1 });
    await save(store, { a: 2 });
    await save(store, { a: 3 });

    expect(readJson(backupPath(file, 0))).toEqual({ a: 2 });
    expect(readJson(backupPath(file, 1))).toEqual({ a: 1 });
    // Слотов ровно два — файл .bak.2 появиться не должен.
    expect(fs.existsSync(backupPath(file, 2))).toBe(false);

    await save(store, { a: 4 });
    expect(readJson(file)).toEqual({ a: 4 });
    expect(readJson(backupPath(file, 0))).toEqual({ a: 3 });
    expect(readJson(backupPath(file, 1))).toEqual({ a: 2 });
    store.stop();
  });

  test("интервал ограничивает частоту бэкапов", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const store = new AsyncAtomicStore(file, { backupSlots: 2, backupEveryMs: 60 * 60 * 1000 });

    await save(store, { a: 1 });
    await save(store, { a: 2 });
    const firstBackup = readJson(backupPath(file, 0));

    await save(store, { a: 3 });
    await save(store, { a: 4 });

    // Час ещё не прошёл: бэкап остался тем же, слотов больше не появилось.
    expect(readJson(backupPath(file, 0))).toEqual(firstBackup);
    expect(readJson(backupPath(file, 0))).toEqual({ a: 1 });
    expect(fs.existsSync(backupPath(file, 1))).toBe(false);
    expect(readJson(file)).toEqual({ a: 4 });
    store.stop();
  });

  test("backupSlots: 0 выключает бэкапы", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const store = new AsyncAtomicStore(file, { backupSlots: 0, backupEveryMs: 0 });

    await save(store, { a: 1 });
    await save(store, { a: 2 });

    expect(fs.existsSync(backupPath(file, 0))).toBe(false);
    store.stop();
  });

  test("слишком большой снапшот не бэкапится", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const store = new AsyncAtomicStore(file, { backupSlots: 2, backupEveryMs: 0, backupMaxBytes: 32 });

    await save(store, { pad: "x".repeat(500) });
    await save(store, { pad: "y".repeat(500) });

    expect(fs.existsSync(backupPath(file, 0))).toBe(false);
    store.stop();
  });

  test("бэкапы считаются в телеметрии записи", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    const store = new AsyncAtomicStore(file, { backupEveryMs: 0 });

    await save(store, { a: 1 });
    await save(store, { a: 2 });

    expect(store.getStats().total.backups).toBe(1);
    // .tmp-файлов и мусора рядом быть не должно.
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    store.stop();
  });

  test("rotateBackups: пустое содержимое и нулевые слоты — не бэкап", () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    fs.writeFileSync(file, "{}");

    expect(rotateBackups(file, 0, { content: "{}" })).toBe(false);
    expect(rotateBackups(file, 3, { content: "" })).toBe(false);
    expect(fs.existsSync(backupPath(file, 0))).toBe(false);
  });

  test("rotateBackups без содержимого копирует файл на диске", () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    fs.writeFileSync(file, JSON.stringify({ onDisk: true }));

    expect(rotateBackups(file, 2)).toBe(true);
    expect(readJson(backupPath(file, 0))).toEqual({ onDisk: true });
  });
});
