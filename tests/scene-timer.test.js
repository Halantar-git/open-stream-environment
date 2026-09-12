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
  Unit tests for the scene countdown timer (overlay/scene-timer.js).

  The clock and interval are injected so the anchoring rules can be tested
  without real time / real timers: the countdown must be tied to the scene's
  activation timestamp, survive re-renders (STATE / SCENES_UPDATE) and a
  browser-source reload, and never run while the scene is not active.
*/

const { createSceneTimer } = require("../overlay/scene-timer");

const BASE = 1_700_000_000_000; // произвольная фиксированная метка времени

function makeHarness() {
  let now = BASE;
  let seq = 0;
  const timers = new Map();
  const updates = [];

  const timer = createSceneTimer({
    now: () => now,
    setInterval: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
  });

  return {
    timer,
    updates,
    onUpdate: (state) => updates.push(state),
    advance: (ms) => {
      now += ms;
    },
    fire: () => {
      for (const { fn } of [...timers.values()]) fn();
    },
    runningCount: () => timers.size,
    onlyIntervalMs: () => [...timers.values()][0] && [...timers.values()][0].ms,
  };
}

describe("SceneTimer", () => {
  test("стартует с полной длительности в момент активации", () => {
    const h = makeHarness();
    const res = h.timer.apply(
      { showTimer: true, duration: 600, isActive: true, startedAt: BASE },
      h.onUpdate
    );

    expect(res).toMatchObject({ timeLeft: 600, running: true, finished: false });
    expect(h.runningCount()).toBe(1);
    expect(h.onlyIntervalMs()).toBe(1000);
  });

  test("не сбрасывается при повторном apply с той же меткой", () => {
    const h = makeHarness();
    const ctx = { showTimer: true, duration: 600, isActive: true, startedAt: BASE };
    h.timer.apply(ctx, h.onUpdate);

    h.advance(5000);
    h.fire();
    expect(h.timer.getTimeLeft()).toBe(595);

    // Обычное обновление состояния (STATE / SCENES_UPDATE) не перезапускает отсчёт.
    h.timer.apply(ctx, h.onUpdate);
    expect(h.timer.getTimeLeft()).toBe(595);
    expect(h.runningCount()).toBe(1);
  });

  test("восстанавливает остаток после перезагрузки OBS-источника", () => {
    const h = makeHarness();
    // Источник загрузился позже активации — на 45 секунд.
    h.advance(45000);
    const res = h.timer.apply(
      { showTimer: true, duration: 600, isActive: true, startedAt: BASE },
      h.onUpdate
    );

    expect(res.timeLeft).toBe(555);
  });

  test("не идёт, пока сцена не активна, и показывает полную длительность", () => {
    const h = makeHarness();
    const res = h.timer.apply(
      { showTimer: true, duration: 600, isActive: false, startedAt: BASE },
      h.onUpdate
    );

    expect(res).toMatchObject({ timeLeft: 600, running: false, finished: false });
    expect(h.timer.getTimeLeft()).toBe(600);
    expect(h.runningCount()).toBe(0);
  });

  test("по окончании останавливается и помечается finished", () => {
    const h = makeHarness();
    h.timer.apply({ showTimer: true, duration: 3, isActive: true, startedAt: BASE }, h.onUpdate);

    h.advance(3000);
    h.fire();

    expect(h.timer.getTimeLeft()).toBe(0);
    expect(h.timer.isRunning()).toBe(false);
    expect(h.runningCount()).toBe(0);
    expect(h.updates[h.updates.length - 1].finished).toBe(true);
  });

  test("повторная активация с новой меткой перезапускает отсчёт", () => {
    const h = makeHarness();
    h.timer.apply({ showTimer: true, duration: 600, isActive: true, startedAt: BASE }, h.onUpdate);

    h.advance(10000);
    h.fire();
    expect(h.timer.getTimeLeft()).toBe(590);

    h.timer.apply(
      { showTimer: true, duration: 600, isActive: true, startedAt: BASE + 10000 },
      h.onUpdate
    );
    expect(h.timer.getTimeLeft()).toBe(600);
  });

  test("showTimer=false или duration=0 не запускает отсчёт", () => {
    const h = makeHarness();

    const hidden = h.timer.apply(
      { showTimer: false, duration: 600, isActive: true, startedAt: BASE },
      h.onUpdate
    );
    expect(hidden.running).toBe(false);

    const zero = h.timer.apply(
      { showTimer: true, duration: 0, isActive: true, startedAt: BASE },
      h.onUpdate
    );
    expect(zero.running).toBe(false);
    expect(h.runningCount()).toBe(0);
  });

  test("stop() снимает интервал", () => {
    const h = makeHarness();
    h.timer.apply({ showTimer: true, duration: 600, isActive: true, startedAt: BASE }, h.onUpdate);
    expect(h.runningCount()).toBe(1);

    h.timer.stop();
    expect(h.runningCount()).toBe(0);
    expect(h.timer.isRunning()).toBe(false);
  });
});
