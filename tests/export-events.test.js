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

const { csvCell, eventsToCsv, CSV_HEADER } = require("../server/export-events");

describe("export-events", () => {
  test("csvCell экранирует кавычки, запятые и переводы строк", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  test("eventsToCsv формирует заголовок и строку", () => {
    const csv = eventsToCsv([
      {
        id: "e1",
        timestamp: 1000,
        type: "donation",
        kind: "donation",
        username: "bob",
        amount: 100,
        currency: "RUB",
        message: "hi",
        is_test: false,
      },
    ]);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(CSV_HEADER.join(","));
    expect(lines[1]).toBe("e1,1000,1970-01-01T00:00:01.000Z,donation,donation,bob,100,RUB,hi,0");
  });

  test("eventsToCsv помечает тестовые события и пустые поля", () => {
    const csv = eventsToCsv([{ id: "e2", type: "follow", is_test: true, message: "a,b" }]);
    const line = csv.trimEnd().split("\n")[1];
    expect(line).toBe('e2,,,follow,,,,,"a,b",1');
  });

  test("eventsToCsv на пустом списке отдаёт только заголовок", () => {
    const expected = CSV_HEADER.join(",") + "\n";
    expect(eventsToCsv([])).toBe(expected);
    expect(eventsToCsv(null)).toBe(expected);
  });
});
