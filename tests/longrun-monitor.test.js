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
  Наблюдатель за долгим прогоном: он должен считать рост памяти, замечать
  переподключения и молчать, когда всё в порядке — иначе телеметрия сама станет
  источником шума.
*/

const { createLongRunMonitor, memoryGrowthMbPerHour } = require("../server/longrun-monitor");

// Образцы с заданным шагом по времени: минутами легче рассуждать о скорости роста.
function sampleAt(minutes, rssMb) {
  return { at: minutes * 60000, rssMb };
}

describe("longrun-monitor: рост памяти", () => {
  test("нет данных — нет вывода", () => {
    expect(memoryGrowthMbPerHour([])).toBe(0);
    expect(memoryGrowthMbPerHour(null)).toBe(0);
    expect(memoryGrowthMbPerHour([sampleAt(0, 100)])).toBe(0);
  });

  test("рост считается в мегабайтах в час", () => {
    // 60 МБ за полчаса = 120 МБ/ч.
    expect(memoryGrowthMbPerHour([sampleAt(0, 100), sampleAt(30, 160)])).toBe(120);
  });

  test("стабильная память и её снижение — не рост", () => {
    expect(memoryGrowthMbPerHour([sampleAt(0, 120), sampleAt(60, 120)])).toBe(0);
    expect(memoryGrowthMbPerHour([sampleAt(0, 200), sampleAt(60, 150)])).toBe(-50);
  });

  test("нулевой интервал не даёт деления на ноль", () => {
    expect(memoryGrowthMbPerHour([sampleAt(10, 100), sampleAt(10, 300)])).toBe(0);
  });
});

describe("longrun-monitor: наблюдение", () => {
  function makeMonitor(overrides = {}) {
    const lines = [];
    const monitor = createLongRunMonitor({
      everyMs: 60 * 60 * 1000, // таймер в тесте не сработает — отчёты вызываем вручную
      log: (line) => lines.push(line),
      sample: () => ({ wsClients: 2, reconnects: { twitchChat: 1 }, lagMaxMs: 12 }),
      ...overrides,
    });
    return { monitor, lines };
  }

  test("первый образец берётся сразу при создании", () => {
    const { monitor } = makeMonitor();
    const snapshot = monitor.snapshot();

    expect(snapshot.samples).toBe(1);
    expect(snapshot.rssMb).toBeGreaterThan(0);
    expect(snapshot.wsClients).toBe(2);
    expect(snapshot.reconnects).toEqual({ twitchChat: 1 });
    expect(snapshot.reconnectsTotal).toBe(1);
    expect(snapshot.lagMaxMs).toBe(12);
    monitor.stop();
  });

  test("в простое ничего не пишет, а по force — пишет", () => {
    const { monitor, lines } = makeMonitor();

    monitor.report();
    expect(lines).toHaveLength(0);

    monitor.report(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[longrun]");
    expect(lines[0]).toContain("rss");
    monitor.stop();
  });

  test("переподключения попадают и в строку, и в сводку", () => {
    let attempts = 3;
    const { monitor, lines } = makeMonitor({ sample: () => ({ wsClients: 1, reconnects: { twitchChat: attempts }, lagMaxMs: 5 }) });

    monitor.report();
    attempts = 9;
    monitor.report();

    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[lines.length - 1]).toContain("переподключений всего 9");
    expect(monitor.snapshot().reconnectsTotal).toBe(9);
    monitor.stop();
  });

  test("история образцов ограничена размером буфера", () => {
    const { monitor } = makeMonitor({ history: 3 });
    for (let i = 0; i < 6; i++) monitor.report();

    const snapshot = monitor.snapshot();
    expect(snapshot.samples).toBe(3);
    expect(snapshot.history).toHaveLength(3);
    monitor.stop();
  });

  test("пик памяти запоминается, даже когда память пошла вниз", () => {
    let rss = 100 * 1048576;
    const { monitor } = makeMonitor({
      // Подменяем измерение памяти: process.memoryUsage() в тесте не подкрутить.
      sample: () => ({ wsClients: 0, reconnects: {}, lagMaxMs: 0 }),
      memoryUsage: () => ({ rss, heapUsed: rss / 2 }),
    });
    monitor.report();
    rss = 120 * 1048576;
    monitor.report();
    rss = 90 * 1048576;
    monitor.report();

    const snapshot = monitor.snapshot();
    expect(snapshot.rssMb).toBe(90);
    expect(snapshot.peakRssMb).toBe(120);
    monitor.stop();
  });

  test("stop останавливает таймер и повторный вызов не падает", () => {
    const { monitor } = makeMonitor();
    monitor.stop();
    expect(() => monitor.stop()).not.toThrow();
  });
});
