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
  Тесты append-only хранилища истории (JSONL): дописывание без перезаписи,
  фильтры/пагинация, миграционный replaceAll, очистка, терпимость к
  повреждённым строкам и синхронный сброс при выходе.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const { createHistoryStore } = require("../server/history-store");

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ose-hist-"));
  return path.join(dir, "local-db.jsonl");
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
}

describe("history store", () => {
  test("append дописывает строки и сохраняет порядок записей в памяти", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file);

    history.append({ id: "a", timestamp: 1, username: "one" });
    history.append({ id: "b", timestamp: 2, username: "two" });
    await history.flush();

    expect(history.count()).toBe(2);
    expect(readLines(file).map((l) => JSON.parse(l).id)).toEqual(["a", "b"]);
  });

  test("query сортирует по времени, фильтрует и пагинирует", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file);

    for (let i = 1; i <= 5; i++) {
      history.append({ id: `e${i}`, timestamp: i, type: i % 2 ? "donation" : "follow", username: `u${i}` });
    }
    await history.flush();

    const page = history.query({ limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(page.items.map((e) => e.id)).toEqual(["e4", "e3"]);

    const onlyFollow = history.query({ type: "follow" });
    expect(onlyFollow.items.map((e) => e.id)).toEqual(["e4", "e2"]);

    const search = history.query({ search: "u1" });
    expect(search.items.map((e) => e.id)).toEqual(["e1"]);
  });

  test("query ищет по username и message, учитывая JSON-экранирование", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file);
    history.append({ id: "a", timestamp: 1, username: "Alice", message: "hello" });
    history.append({ id: "b", timestamp: 2, username: "Bob", message: 'say "hi"' });
    history.append({ id: "c", timestamp: 3, username: "carol", message: "back\\slash" });
    history.append({ id: "d", timestamp: 4, type: "specialkind", username: "dave" });
    await history.flush();

    // Регистронезависимо и по нику, и по тексту.
    expect(history.query({ search: "ALICE" }).items.map((e) => e.id)).toEqual(["a"]);
    expect(history.query({ search: "hi" }).items.map((e) => e.id)).toEqual(["b"]);

    // Кавычки и обратный слэш в запросе находятся через JSON-экранирование.
    expect(history.query({ search: 'say "hi"' }).items.map((e) => e.id)).toEqual(["b"]);
    expect(history.query({ search: "back\\slash" }).items.map((e) => e.id)).toEqual(["c"]);

    // Совпадение в неиндексируемом поле (type) не считается: сырой предфильтр
    // пропустил строку, но matchEntry её отсеял.
    expect(history.query({ search: "specialkind" }).items).toEqual([]);
    expect(history.query({ search: "nope" }).items).toEqual([]);
  });

  test("query по умолчанию включает тестовые события, includeTest:false — скрывает", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file);

    history.append({ id: "real", timestamp: 1, is_test: false });
    history.append({ id: "test", timestamp: 2, is_test: true });
    await history.flush();

    expect(history.query({}).items.map((e) => e.id)).toEqual(["test", "real"]);
    expect(history.query({ includeTest: false }).items.map((e) => e.id)).toEqual(["real"]);
  });

  test("getById находит запись, clear очищает файл", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file);

    history.append({ id: "x", timestamp: 1 });
    await history.flush();
    expect(history.getById("x").id).toBe("x");
    expect(history.getById("nope")).toBeNull();

    history.clear();
    await history.flush();
    expect(history.count()).toBe(0);
    expect(readLines(file)).toEqual([]);
  });

  test("replaceAll перезаписывает файл целиком (миграция)", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file);

    history.append({ id: "old", timestamp: 1 });
    await history.flush();

    history.replaceAll([
      { id: "m1", timestamp: 2 },
      { id: "m2", timestamp: 3 },
    ]);
    await history.flush();

    const reopened = createHistoryStore(file);
    expect(reopened.count()).toBe(2);
    expect(readLines(file).map((l) => JSON.parse(l).id)).toEqual(["m1", "m2"]);
  });

  test("повреждённые и частичные строки пропускаются при загрузке", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      '{"id":"ok1","timestamp":1}\n' +
        "{broken json\n" +
        '{"id":"ok2","timestamp":2}\n' +
        '{"id":"partial"'
    );

    const history = createHistoryStore(file);
    expect(history.count()).toBe(2);
    expect(history.query({}).items.map((e) => e.id)).toEqual(["ok2", "ok1"]);
  });

  test("flushSync синхронно сбрасывает недописанные операции", () => {
    const file = tmpFile();
    const history = createHistoryStore(file);

    history.append({ id: "sync", timestamp: 1 });
    expect(history.flushSync()).toBe(true);

    expect(readLines(file).map((l) => JSON.parse(l).id)).toEqual(["sync"]);
    expect(history.flushSync()).toBe(false); // очередь уже пуста
  });

  test("maxRecords ограничивает историю в памяти", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file, { maxRecords: 3 });

    for (let i = 1; i <= 5; i++) history.append({ id: `e${i}`, timestamp: i });
    await history.flush();

    expect(history.count()).toBe(3);
    expect(history.query({}).items.map((e) => e.id)).toEqual(["e5", "e4", "e3"]);
  });

  test("уплотняет файл при превышении лимита", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file, { maxRecords: 3 });

    for (let i = 1; i <= 20; i++) history.append({ id: `e${i}`, timestamp: i });
    await history.flush();

    // Файл не растёт линейно: держится в пределах maxRecords * 2.
    expect(readLines(file).length).toBeLessThanOrEqual(6);
    expect(history.count()).toBe(3);
    expect(history.query({}).items.map((e) => e.id)).toEqual(["e20", "e19", "e18"]);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("после уплотнения перезагрузка даёт те же последние записи", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file, { maxRecords: 3 });
    for (let i = 1; i <= 20; i++) history.append({ id: `e${i}`, timestamp: i });
    await history.flush();

    const reopened = createHistoryStore(file, { maxRecords: 3 });
    expect(reopened.count()).toBe(3);
    expect(reopened.query({}).items.map((e) => e.id)).toEqual(["e20", "e19", "e18"]);

    await reopened.flush();
    expect(readLines(file).length).toBe(3);
  });

  test("flushSync уплотняет по порогу синхронно", () => {
    const file = tmpFile();
    const history = createHistoryStore(file, { maxRecords: 2 });

    for (let i = 1; i <= 5; i++) history.append({ id: `e${i}`, timestamp: i });
    expect(history.flushSync()).toBe(true);

    expect(readLines(file).length).toBeLessThanOrEqual(4);
    expect(history.count()).toBe(2);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("maxRecords: 0 отключает лимит и уплотнение", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file, { maxRecords: 0 });

    for (let i = 1; i <= 50; i++) history.append({ id: `e${i}`, timestamp: i });
    await history.flush();

    expect(history.count()).toBe(50);
    expect(readLines(file).length).toBe(50);
  });

  test("removeBy удаляет по фильтру и переписывает файл", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file);
    history.append({ id: "a", timestamp: 1, type: "donation" });
    history.append({ id: "b", timestamp: 2, type: "follow" });
    history.append({ id: "c", timestamp: 3, type: "donation" });
    await history.flush();

    expect(history.removeBy({ type: "donation" })).toBe(2);
    await history.flush();
    expect(history.count()).toBe(1);
    expect(readLines(file).map((l) => JSON.parse(l).id)).toEqual(["b"]);

    expect(history.removeBy({ type: "nope" })).toBe(0);
  });

  test("setMaxRecords применяется на лету и уплотняет файл", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file, { maxRecords: 0 });
    for (let i = 1; i <= 10; i++) history.append({ id: `e${i}`, timestamp: i });
    await history.flush();
    expect(history.count()).toBe(10);

    expect(history.setMaxRecords(4)).toBe(4);
    expect(history.count()).toBe(4);
    expect(history.query({}).items.map((e) => e.id)).toEqual(["e10", "e9", "e8", "e7"]);
    await history.flush();
    expect(readLines(file).length).toBe(4);
    expect(history.maxRecords).toBe(4);
  });

  /*
    Сбой записи (нет прав, диск кончился, файл занят) не должен терять события:
    раньше батч просто выпадал из очереди и после перезапуска записи исчезали.
  */
  test("сбой записи не теряет записи: они видны и уходят в файл после восстановления", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file, { retryDelayMs: 5 });

    const spy = jest.spyOn(fs.promises, "appendFile").mockRejectedValue(new Error("диск недоступен"));
    history.append({ id: "a", timestamp: 1 });
    history.append({ id: "b", timestamp: 2 });
    await history.flush();

    // Записи не потеряны: файл пуст, но из памяти они видны полностью.
    expect(readLines(file)).toEqual([]);
    expect(history.count()).toBe(2);
    expect(history.query({}).items.map((e) => e.id)).toEqual(["b", "a"]);

    // Файл снова доступен — очередь доходит до диска.
    spy.mockRestore();
    await history.flush();
    expect(readLines(file).map((l) => JSON.parse(l).id)).toEqual(["a", "b"]);
  });

  test("query фильтрует по sessionId (для истории чата)", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file);
    history.append({ id: "m1", timestamp: 1, sessionId: "s1" });
    history.append({ id: "m2", timestamp: 2, sessionId: "s2" });
    history.append({ id: "m3", timestamp: 3, sessionId: "s1" });
    await history.flush();

    expect(history.query({ sessionId: "s1" }).items.map((e) => e.id)).toEqual(["m3", "m1"]);
    expect(history.all().length).toBe(3);
  });

  test("query фильтрует по нижней границе времени (донаты текущего стрима)", async () => {
    const file = tmpFile();
    const history = createHistoryStore(file);
    history.append({ id: "old-1", timestamp: 1000, type: "donation" });
    history.append({ id: "old-2", timestamp: 2000, type: "donation" });
    history.append({ id: "new-1", timestamp: 3000, type: "donation" });
    history.append({ id: "new-2", timestamp: 4000, type: "donation" });
    await history.flush();

    const page = history.query({ type: "donation", since: 2500 });
    expect(page.items.map((e) => e.id)).toEqual(["new-2", "new-1"]);
    // total — это уже число записей под фильтром, а не всей истории.
    expect(page.total).toBe(2);

    // Граница включительна, а ноль/мусор означают «ограничения нет».
    expect(history.query({ since: 3000 }).items.map((e) => e.id)).toEqual(["new-2", "new-1"]);
    expect(history.query({ since: 0 }).total).toBe(4);
    expect(history.query({ since: "abc" }).total).toBe(4);
  });
});
