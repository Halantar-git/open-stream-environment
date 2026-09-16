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
  Журнал команд: он уходит в отчёт для поддержки, поэтому проверяем и полноту
  (видно, что и от кого пришло), и гигиену — в журнал не должен попадать сам
  payload: там бывают сообщения чата и данные настроек.
*/

const { createAuditLog, summarizePayload, SAFE_FIELDS } = require("../server/audit-log");

describe("audit-log: кольцевой буфер", () => {
  test("хранит последние записи и не растёт бесконечно", () => {
    const log = createAuditLog({ limit: 3 });

    for (let i = 0; i < 5; i++) log.record({ type: `cmd_${i}`, role: "control" });

    // recent() отдаёт новые сверху — так их читает и человек, и отчёт.
    expect(log.recent(10).map((entry) => entry.type)).toEqual(["cmd_4", "cmd_3", "cmd_2"]);
    expect(log.counters()).toEqual({ total: 5, external: 0, limited: 0, kept: 3 });
  });

  test("счётчики различают сетевые команды и отброшенные по лимиту", () => {
    const log = createAuditLog({ limit: 10 });

    log.record({ type: "a", role: "control" });
    log.record({ type: "b", role: "remote", external: true });
    log.record({ type: "c", role: "remote", external: true, limited: true });

    expect(log.counters()).toEqual({ total: 3, external: 2, limited: 1, kept: 3 });
  });

  test("записи нормализуются, даже если пришли частично заполненными", () => {
    const log = createAuditLog({ clock: () => 123 });

    const entry = log.record({});

    expect(entry).toEqual({ at: 123, type: "unknown", role: "other", external: false, limited: false, details: null });
  });

  test("onEntry вызывается для каждой записи и не ломает журнал, если падает", () => {
    const seen = [];
    const log = createAuditLog({
      onEntry: (entry) => {
        seen.push(entry.type);
        if (entry.type === "boom") throw new Error("ошибка внешнего обработчика");
      },
    });

    expect(() => log.record({ type: "boom" })).not.toThrow();
    log.record({ type: "next" });

    expect(seen).toEqual(["boom", "next"]);
    expect(log.recent(2).map((entry) => entry.type)).toEqual(["next", "boom"]);
  });

  test("recent(0) и отрицательное значение не отдают лишнего", () => {
    const log = createAuditLog();
    log.record({ type: "a" });

    expect(log.recent(0)).toEqual([]);
    expect(log.recent(-5)).toEqual([]);
  });

  test("по умолчанию журнал держит 200 записей", () => {
    expect(createAuditLog().limit).toBe(200);
  });
});

describe("audit-log: что попадает в детали", () => {
  test("берутся только безопасные поля", () => {
    const details = summarizePayload({
      widgetId: "w1",
      sceneId: "main",
      direction: "forward",
      // Всё, что ниже, — не для журнала: тексты, настройки, что угодно.
      message: "привет, это сообщение чата",
      config: { password: "секрет", token: "секрет" },
      layout: [{ id: "w2" }],
    });

    expect(details).toEqual({ widgetId: "w1", sceneId: "main", direction: "forward" });
    expect(JSON.stringify(details)).not.toContain("секрет");
    expect(JSON.stringify(details)).not.toContain("сообщение чата");
  });

  test("пустой или неподходящий payload не превращается в пустой объект", () => {
    expect(summarizePayload(null)).toBeNull();
    expect(summarizePayload(undefined)).toBeNull();
    expect(summarizePayload([])).toBeNull();
    expect(summarizePayload("строка")).toBeNull();
    expect(summarizePayload({})).toBeNull();
    expect(summarizePayload({ message: "только текст" })).toBeNull();
  });

  test("длинные строки обрезаются", () => {
    const details = summarizePayload({ scene: "x".repeat(500) });

    expect(details.scene.length).toBeLessThanOrEqual(61);
    expect(details.scene.endsWith("…")).toBe(true);
  });

  test("числа и булевы значения сохраняются как есть", () => {
    const details = summarizePayload({ port: 8710, enabled: false, visible: true });

    expect(details).toEqual({ port: 8710, enabled: false, visible: true });
  });

  test("список безопасных полей не содержит слов, за которые зацепится маскировка отчёта", () => {
    // В отчёте для поддержки ключи вида *token*/*secret*/*password* заменяются
    // на «<скрыто>» — в списке таких быть не должно, иначе детали пропадут.
    const forbidden = /(secret|token|password|passwd|apikey|credential|cookie)/i;
    expect(SAFE_FIELDS.filter((field) => forbidden.test(field))).toEqual([]);
  });
});
