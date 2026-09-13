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
  Тесты синхронизации с конфигом Longshot (Executive Hangar): нормализация
  payload, канонический UTC-анкер, запасной статический URL, ошибки сети/HTTP.
  Сеть подменяется `fetchImpl`, реальные запросы не выполняются.
*/

const { createLongshotSync, mapConfig, API_URL, FALLBACK_URL } = require("../server/longshot-sync");

const SAMPLE = {
  executiveHangar: {
    operational: true,
    hangarAnchorAt: "2026-09-11T02:13:01Z",
    phases: { redMinutes: 120, greenMinutes: 60, blackMinutes: 5 },
    lightIntervals: { redTurnGreenMinutes: 24, greenTurnOffMinutes: 12 },
    updateMessage: "Timer updated for Alpha 4.10 LIVE",
    updatedAt: "2026-09-11 04:39:29",
  },
};

function okResponse(json) {
  return { ok: true, status: 200, json: async () => json };
}

describe("longshot sync", () => {
  test("mapConfig нормализует payload в секунды и UTC-анкер", () => {
    const mapped = mapConfig(SAMPLE);
    expect(mapped.ok).toBe(true);
    expect(mapped.operational).toBe(true);
    expect(mapped.anchorAt).toBe("2026-09-11T02:13:01.000Z");
    expect(mapped.phases).toEqual({ redSec: 7200, greenSec: 3600, blackSec: 300 });
    expect(mapped.lightIntervals).toEqual({ redStepSec: 1440, greenStepSec: 720 });
    expect(mapped.updateMessage).toContain("Alpha 4.10");
    expect(mapped.remoteUpdatedAt).toBe("2026-09-11 04:39:29");
  });

  test("анкер без таймзоны читается как UTC", () => {
    const mapped = mapConfig({ executiveHangar: { hangarAnchorAt: "2026-09-11 02:13:01" } });
    expect(mapped.anchorAt).toBe("2026-09-11T02:13:01.000Z");
  });

  test("mapConfig возвращает null на мусоре", () => {
    expect(mapConfig(null)).toBeNull();
    expect(mapConfig({})).toBeNull();
    expect(mapConfig({ executiveHangar: {} })).toBeNull();
    expect(mapConfig({ executiveHangar: { hangarAnchorAt: "not-a-date" } })).toBeNull();
  });

  test("refresh берёт API с кэш-бастером и зовёт onUpdate", async () => {
    const seen = [];
    const updates = [];
    const sync = createLongshotSync({
      fetchImpl: async (target) => {
        seen.push(target);
        return okResponse(SAMPLE);
      },
      onUpdate: (snapshot) => updates.push(snapshot),
    });

    const snapshot = await sync.refresh();
    expect(snapshot.ok).toBe(true);
    expect(seen[0].startsWith(API_URL)).toBe(true);
    expect(seen[0]).toContain("v=");
    expect(sync.get().phases.redSec).toBe(7200);
    expect(updates).toHaveLength(1);
  });

  test("при сбое API уходит на статический фолбэк", async () => {
    const seen = [];
    const sync = createLongshotSync({
      fetchImpl: async (target) => {
        seen.push(target);
        if (target.startsWith(API_URL)) throw new Error("api down");
        return okResponse({ executiveHangar: { hangarAnchorAt: "2026-05-23T17:23:24Z" } });
      },
    });

    const snapshot = await sync.refresh();
    expect(snapshot.ok).toBe(true);
    expect(seen[0].startsWith(API_URL)).toBe(true);
    expect(seen[1].startsWith(FALLBACK_URL)).toBe(true);
    expect(snapshot.phases).toEqual({ redSec: 7200, greenSec: 3600, blackSec: 300 });
  });

  test("полный сбой сохраняет прежний анкер и помечает ошибку", async () => {
    let mode = "ok";
    const sync = createLongshotSync({
      fetchImpl: async () => {
        if (mode === "fail") throw new Error("network down");
        return okResponse(SAMPLE);
      },
    });

    await sync.refresh();
    mode = "fail";
    const snapshot = await sync.refresh();

    expect(snapshot.ok).toBe(false);
    expect(snapshot.error).toContain("network down");
    expect(snapshot.anchorAt).toBe("2026-09-11T02:13:01.000Z"); // прежний анкер сохранён
  });

  test("HTTP-ошибка помечается как ошибка", async () => {
    const sync = createLongshotSync({
      fallbackUrl: "",
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const snapshot = await sync.refresh();
    expect(snapshot.ok).toBe(false);
    expect(snapshot.error).toContain("503");
  });

  test("опрос включается лениво и останавливается при выключении", async () => {
    jest.useFakeTimers();
    try {
      const seen = [];
      const sync = createLongshotSync({
        intervalMs: 60_000,
        fetchImpl: async (target) => {
          seen.push(target);
          return okResponse(SAMPLE);
        },
      });

      // Без активного потребителя в сеть не ходим вообще.
      expect(sync.isActive()).toBe(false);
      jest.advanceTimersByTime(180_000);
      expect(seen).toHaveLength(0);

      // Активация: сразу свежий анкер плюс интервал.
      sync.setActive(true);
      await sync.refresh(); // тот же inflight, что запустил setActive
      expect(sync.isActive()).toBe(true);
      expect(seen).toHaveLength(1);

      // Каждый интервал делает один запрос (await дожидается inflight).
      for (let i = 0; i < 2; i += 1) {
        jest.advanceTimersByTime(60_000);
        await sync.refresh();
      }
      expect(seen).toHaveLength(3);

      // Повторная активация не плодит параллельные интервалы.
      sync.setActive(true);
      jest.advanceTimersByTime(60_000);
      await sync.refresh();
      expect(seen).toHaveLength(4);

      // Деактивация останавливает опрос, но хранит последний снимок.
      sync.setActive(false);
      expect(sync.isActive()).toBe(false);
      const last = sync.get();
      jest.advanceTimersByTime(300_000);
      expect(seen).toHaveLength(4);
      expect(sync.get()).toBe(last);
    } finally {
      jest.useRealTimers();
    }
  });
});
