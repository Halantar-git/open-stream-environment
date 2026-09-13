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
  Тесты цикла Executive Hangar: математика фаз/огней (shared/hangar-cycle.js)
  и разбор снимка Longshot в параметры цикла (sourceFromSnapshot).
*/

const HangarCycle = require("../shared/hangar-cycle");

const MIN = 60;

describe("HangarCycle", () => {
  test("длительности фаз и полного цикла", () => {
    expect(HangarCycle.RED_SEC).toBe(120 * MIN);
    expect(HangarCycle.GREEN_SEC).toBe(60 * MIN);
    expect(HangarCycle.BLACK_SEC).toBe(5 * MIN);
    expect(HangarCycle.CYCLE_SEC).toBe(185 * MIN);
    expect(HangarCycle.LIGHT_COUNT).toBe(5);
  });

  test("elapsedSec зацикливается и не уходит в минус", () => {
    const start = 1_000_000;
    expect(HangarCycle.elapsedSec(start, start)).toBe(0);
    expect(HangarCycle.elapsedSec(start, start - 5000)).toBe(0);
    expect(HangarCycle.elapsedSec(start, start + 60_000)).toBe(60);
    const cyc = HangarCycle.CYCLE_SEC;
    expect(HangarCycle.elapsedSec(start, start + (cyc + 10) * 1000)).toBe(10);
    expect(HangarCycle.elapsedSec(0, start)).toBe(0); // нет анкера
  });

  test("Red: огни загораются каждые 24 минуты", () => {
    const at = (sec) => HangarCycle.stateAt(sec);
    expect(at(0).phase).toBe("red");
    expect(at(0).lights).toEqual(["red", "red", "red", "red", "red"]);
    expect(at(24 * MIN).lights).toEqual(["green", "red", "red", "red", "red"]);
    expect(at(48 * MIN).lights.filter((s) => s === "green")).toHaveLength(2);
    expect(at(96 * MIN).lights.filter((s) => s === "green")).toHaveLength(4);
    expect(at(0).next).toEqual({ kind: "green", light: 1, inSec: 24 * MIN });
    expect(at(30 * MIN).next).toEqual({ kind: "green", light: 2, inSec: 18 * MIN });
    // Остаток фазы и всего цикла.
    expect(at(120 * MIN - 1).phaseRemainingSec).toBe(1);
    expect(at(0).cycleRemainingSec).toBe(185 * MIN);
  });

  test("Green: огни гаснут каждые 12 минут", () => {
    const at = (sec) => HangarCycle.stateAt(sec);
    const greenStart = 120 * MIN;
    expect(at(greenStart).phase).toBe("green");
    expect(at(greenStart).lights).toEqual(["green", "green", "green", "green", "green"]);
    expect(at(greenStart + 12 * MIN).lights).toEqual(["off", "green", "green", "green", "green"]);
    expect(at(greenStart + 48 * MIN).lights.filter((s) => s === "green")).toHaveLength(1);
    expect(at(greenStart + 5 * MIN).next).toEqual({ kind: "off", light: 1, inSec: 7 * MIN });
    expect(at(greenStart + 60 * MIN - 1).phaseRemainingSec).toBe(1);
  });

  test("Black: 5 минут блэкаута, затем новый цикл с Red", () => {
    const at = (sec) => HangarCycle.stateAt(sec);
    const st = at(180 * MIN);
    expect(st.phase).toBe("black");
    expect(st.lights).toEqual(["off", "off", "off", "off", "off"]);
    expect(st.next).toEqual({ kind: "blackout", light: 0, inSec: 5 * MIN });
    expect(st.cycleRemainingSec).toBe(5 * MIN);

    const nextCycle = at(HangarCycle.CYCLE_SEC + 1);
    expect(nextCycle.phase).toBe("red");
    expect(nextCycle.cycleRemainingSec).toBe(HangarCycle.CYCLE_SEC - 1);
  });

  test("formatDuration: MM:SS до часа, HH:MM:SS после", () => {
    expect(HangarCycle.formatDuration(0)).toBe("00:00");
    expect(HangarCycle.formatDuration(59)).toBe("00:59");
    expect(HangarCycle.formatDuration(60)).toBe("01:00");
    expect(HangarCycle.formatDuration(3600)).toBe("01:00:00");
    expect(HangarCycle.formatDuration(185 * MIN)).toBe("03:05:00");
  });

  test("длительности можно переопределить (как из Longshot)", () => {
    const d = { redSec: 60, greenSec: 30, blackSec: 10, redStepSec: 12, greenStepSec: 6 };
    expect(HangarCycle.cycleSec(d)).toBe(100);
    expect(HangarCycle.elapsedSec(1_000, 1_000 + 110 * 1000, d)).toBe(10);

    const st = HangarCycle.stateAt(0, d);
    expect(st.phase).toBe("red");
    expect(st.cycleRemainingSec).toBe(100);
    expect(st.next).toEqual({ kind: "green", light: 1, inSec: 12 });

    // Нулевые/битые значения падают на дефолты.
    expect(HangarCycle.normalizeDurations({ redSec: 0 }).redSec).toBe(HangarCycle.RED_SEC);
  });
});

describe("HangarCycle.sourceFromSnapshot", () => {
  const snapshot = {
    ok: true,
    operational: true,
    anchorAt: "2026-09-11T02:13:01Z",
    phases: { redSec: 7200, greenSec: 3600, blackSec: 300 },
    lightIntervals: { redStepSec: 1440, greenStepSec: 720 },
  };

  test("без снимка — ждём синхронизацию", () => {
    expect(HangarCycle.sourceFromSnapshot(null)).toEqual({
      ready: false,
      syncing: true,
      anchorMs: 0,
      durations: null,
    });
  });

  test("снимок даёт анкер и длительности", () => {
    const src = HangarCycle.sourceFromSnapshot(snapshot);
    expect(src.ready).toBe(true);
    expect(src.syncing).toBe(false);
    expect(src.anchorMs).toBe(Date.parse("2026-09-11T02:13:01Z"));
    expect(src.durations).toEqual({
      redSec: 7200,
      greenSec: 3600,
      blackSec: 300,
      redStepSec: 1440,
      greenStepSec: 720,
    });
  });

  test("неоперационное состояние или битый анкер — не готово, но не «синхронизация»", () => {
    const off = HangarCycle.sourceFromSnapshot({ ...snapshot, operational: false });
    expect(off.ready).toBe(false);
    expect(off.syncing).toBe(false);

    const broken = HangarCycle.sourceFromSnapshot({ ...snapshot, anchorAt: "nonsense" });
    expect(broken.ready).toBe(false);
    expect(broken.syncing).toBe(false);
  });

  test("переопределённые длительности доходят до stateAt", () => {
    const src = HangarCycle.sourceFromSnapshot({ ...snapshot, phases: { redSec: 60, greenSec: 30, blackSec: 10 } });
    const st = HangarCycle.stateAt(HangarCycle.elapsedSec(src.anchorMs, src.anchorMs + 70_000, src.durations), src.durations);
    expect(st.phase).toBe("green");
  });
});
