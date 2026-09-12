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
  Scene countdown timer.

  The countdown is anchored to the moment its scene became active
  (`startedAt`), not to page load. That means a STATE / SCENES_UPDATE does not
  restart it and an OBS browser-source reload resumes the correct remaining
  time. It only runs while `isActive` is true; otherwise the full duration is
  shown statically.

  Kept DOM-free (clock and interval are injectable) so it can be unit-tested.
  `scene.js` wires the callbacks to the DOM.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.SceneTimer = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function createSceneTimer(options = {}) {
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const setIntervalFn = options.setInterval || ((fn, ms) => setInterval(fn, ms));
    const clearIntervalFn = options.clearInterval || ((id) => clearInterval(id));

    let interval = null;
    let anchor = null;
    let totalDuration = 0;
    let timeLeft = 0;
    let listener = null;

    function stop() {
      if (interval) clearIntervalFn(interval);
      interval = null;
    }

    function snapshot(finished) {
      return { timeLeft, totalDuration, running: !!interval, finished: !!finished };
    }

    function emit(finished) {
      if (listener) listener(snapshot(finished));
    }

    function compute() {
      const elapsed = Math.max(0, Math.floor((now() - anchor) / 1000));
      return Math.max(0, totalDuration - elapsed);
    }

    function tick() {
      timeLeft = compute();
      if (timeLeft <= 0) stop();
      emit(timeLeft <= 0);
    }

    // `ctx`: { showTimer, duration, isActive, startedAt }.
    // `onUpdate` is called on every change of the displayed value.
    function apply(ctx = {}, onUpdate) {
      if (typeof onUpdate === "function") listener = onUpdate;
      totalDuration = Math.max(0, Math.round(Number(ctx.duration) || 0));

      const usable = ctx.showTimer && totalDuration > 0 && ctx.isActive && ctx.startedAt ? ctx.startedAt : null;
      if (!usable) {
        stop();
        anchor = null;
        timeLeft = totalDuration;
        emit(false);
        return snapshot(false);
      }

      anchor = usable;
      tick();
      if (timeLeft > 0 && !interval) interval = setIntervalFn(tick, 1000);
      return snapshot(timeLeft <= 0);
    }

    return {
      apply,
      stop,
      getTimeLeft: () => timeLeft,
      getTotalDuration: () => totalDuration,
      isRunning: () => !!interval,
    };
  }

  return { createSceneTimer };
});
