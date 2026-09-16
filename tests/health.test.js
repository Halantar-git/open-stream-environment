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
  Отчёт о состоянии (/healthz): он уходит в сеть, поэтому проверяем и то, что
  он показывает нужное, и то, чего в нём быть не должно — путей к файлам.
*/

const { buildHealthReport, PERF_PROBLEM_MS } = require("../server/health");

function fullContext(overrides = {}) {
  return {
    appName: "Open Stream Environment",
    version: "3.1.0",
    port: 8710,
    listening: true,
    uptimeSec: 3661.4,
    wsClients: 3,
    wsByRole: { overlay: 2, control: 1 },
    integrations: { twitchChat: "connected", obs: "disconnected" },
    session: { id: "s1", channel: "halantar", startedAt: 1 },
    storage: {
      dir: "C:\\Users\\streamer\\AppData\\Roaming\\OSE",
      database: { path: "C:\\Users\\streamer\\local-db.json", bytes: 7500, lastError: null },
      history: { path: "C:\\Users\\streamer\\local-db.jsonl", bytes: 10600, count: 42, limit: 20000, lastError: null },
      chat: { path: "C:\\Users\\streamer\\local-db.chat.jsonl", bytes: 124, count: 2, limit: 10000, lastError: null },
      sessions: 7,
    },
    writes: {
      database: {
        window: { writes: 2, bytes: 15000, coalesced: 38, failed: 0, backups: 1, totalMs: 4, maxMs: 2 },
        total: { writes: 40, bytes: 300000, coalesced: 900, failed: 0, backups: 3, totalMs: 80, maxMs: 12.34 },
      },
    },
    perf: { p50: 0.4, p99: 3.2, max: 8.8, mean: 0.9 },
    ...overrides,
  };
}

describe("health: отчёт о состоянии", () => {
  test("здоровое состояние: ok без проблем", () => {
    const report = buildHealthReport(fullContext());

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.version).toBe("3.1.0");
    expect(report.port).toBe(8710);
    expect(report.uptimeSec).toBe(3661);
    expect(report.server).toEqual({ clients: 3, byRole: { overlay: 2, control: 1 } });
    expect(report.integrations.twitchChat).toBe("connected");
    expect(report.storage.database.bytes).toBe(7500);
    expect(report.storage.history).toEqual({ bytes: 10600, count: 42, limit: 20000, lastError: null });
    expect(report.writes.database.writes).toBe(40);
    expect(report.writes.database.backups).toBe(3);
    expect(report.perf.max).toBe(8.8);
    expect(typeof report.at).toBe("number");
  });

  test("отчёт не содержит путей к файлам и каталогам", () => {
    const text = JSON.stringify(buildHealthReport(fullContext()));

    expect(text).not.toContain("streamer");
    expect(text).not.toContain("local-db.json");
    expect(text).not.toContain("AppData");
    expect(text).not.toContain("path");
  });

  test("сервер не слушает порт — это проблема", () => {
    const report = buildHealthReport(fullContext({ listening: false }));

    expect(report.ok).toBe(false);
    expect(report.problems).toContain("сервер не слушает порт");
  });

  test("ошибки записи БД и истории попадают в проблемы", () => {
    const ctx = fullContext();
    ctx.writes.database.total.failed = 4;
    ctx.storage.history.lastError = "ENOSPC: no space left on device";
    const report = buildHealthReport(ctx);

    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("ошибки записи БД: 4");
    expect(report.problems.join("\n")).toContain("ENOSPC");
  });

  test("высокий лаг event loop — проблема, низкий — нет", () => {
    const low = buildHealthReport(fullContext({ perf: { max: PERF_PROBLEM_MS - 1 } }));
    expect(low.problems).toEqual([]);

    const high = buildHealthReport(fullContext({ perf: { max: PERF_PROBLEM_MS + 25 } }));
    expect(high.ok).toBe(false);
    expect(high.problems.join("\n")).toContain("лаг event loop");
  });

  test("рост памяти становится проблемой только по нескольким образцам", () => {
    const two = buildHealthReport(
      fullContext({ longrun: { samples: 2, growthMbPerHour: 400, rssMb: 300, peakRssMb: 300, reconnects: {}, reconnectsTotal: 0 } })
    );
    expect(two.problems).toEqual([]);

    const many = buildHealthReport(
      fullContext({ longrun: { samples: 6, growthMbPerHour: 400, rssMb: 300, peakRssMb: 300, reconnects: { twitchChat: 2 }, reconnectsTotal: 2 } })
    );
    expect(many.ok).toBe(false);
    expect(many.problems.join("\n")).toContain("рост памяти 400 MB/ч");
    expect(many.longrun.reconnectsTotal).toBe(2);
  });

  test("отсутствующие данные не ломают отчёт", () => {
    const report = buildHealthReport({});

    expect(report.ok).toBe(true);
    expect(report.version).toBeNull();
    expect(report.port).toBeNull();
    expect(report.storage).toBeNull();
    expect(report.writes).toBeNull();
    expect(report.perf).toBeNull();
    expect(report.longrun).toBeNull();
    expect(report.server).toEqual({ clients: 0, byRole: {} });
    expect(report.session).toBeNull();
  });

  test("отрицательный аптайм приводится к нулю", () => {
    expect(buildHealthReport({ uptimeSec: -5 }).uptimeSec).toBe(0);
  });

  test("копии byRole и integrations не связаны с источником", () => {
    const ctx = fullContext();
    const report = buildHealthReport(ctx);
    report.server.byRole.overlay = 99;
    report.integrations.twitchChat = "changed";

    expect(ctx.wsByRole.overlay).toBe(2);
    expect(ctx.integrations.twitchChat).toBe("connected");
  });
});
