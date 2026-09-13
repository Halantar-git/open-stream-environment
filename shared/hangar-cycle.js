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
  Executive Hangar cycle model (Star Citizen contested zone).

  The cycle repeats forever:

    * Red   — 2 h; five lights start red and turn green one by one every 24 min;
    * Green — 1 h; all five are green and turn off one by one every 12 min;
    * Black — 5 min of blackout, then the cycle restarts at Red.

  Durations default to the values above but can be overridden (`durations`),
  which is how the optional Longshot timer sync (live API, static json as
  fallback) feeds its `phases` / `lightIntervals` in.

  Every value is derived from a single anchor (`startedAt`, ms) and the current
  time, so the display never accumulates drift and survives OBS reloads. Pure
  and dependency-free (see tests/hangar-cycle.test.js).
*/
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.HangarCycle = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const MIN = 60;
  const LIGHT_COUNT = 5;

  const RED_SEC = 120 * MIN;
  const GREEN_SEC = 60 * MIN;
  const BLACK_SEC = 5 * MIN;
  const CYCLE_SEC = RED_SEC + GREEN_SEC + BLACK_SEC; // 11100

  const RED_STEP_SEC = 24 * MIN; // one light turns green every 24 min
  const GREEN_STEP_SEC = 12 * MIN; // one light turns off every 12 min

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  // Merge caller-provided durations with the defaults (positive values win).
  function normalizeDurations(durations) {
    const src = durations || {};
    const pick = (value, fallback) => {
      const n = Math.round(Number(value));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    return {
      redSec: pick(src.redSec, RED_SEC),
      greenSec: pick(src.greenSec, GREEN_SEC),
      blackSec: pick(src.blackSec, BLACK_SEC),
      redStepSec: pick(src.redStepSec, RED_STEP_SEC),
      greenStepSec: pick(src.greenStepSec, GREEN_STEP_SEC),
    };
  }

  function cycleSec(durations) {
    const d = normalizeDurations(durations);
    return d.redSec + d.greenSec + d.blackSec;
  }

  // Seconds elapsed inside the current cycle (loops forever, never negative).
  function elapsedSec(startedAt, now, durations) {
    const start = Number(startedAt) || 0;
    if (!start) return 0;
    const delta = (Number(now) || 0) - start;
    if (delta <= 0) return 0;
    return (delta / 1000) % cycleSec(durations);
  }

  function nextEvent(kind, light, inSec) {
    return { kind, light: clamp(light, 1, LIGHT_COUNT), inSec: Math.max(0, inSec) };
  }

  // Full cycle state at a given elapsed second.
  function stateAt(elapsedInput, durations) {
    const d = normalizeDurations(durations);
    const total = d.redSec + d.greenSec + d.blackSec;
    const t = ((Number(elapsedInput) || 0) % total + total) % total;

    let phase;
    let phaseElapsed;
    if (t < d.redSec) {
      phase = "red";
      phaseElapsed = t;
    } else if (t < d.redSec + d.greenSec) {
      phase = "green";
      phaseElapsed = t - d.redSec;
    } else {
      phase = "black";
      phaseElapsed = t - d.redSec - d.greenSec;
    }

    const phaseDuration = phase === "red" ? d.redSec : phase === "green" ? d.greenSec : d.blackSec;
    const phaseRemainingSec = phaseDuration - phaseElapsed;

    let lights;
    let next;
    if (phase === "red") {
      const lit = Math.min(LIGHT_COUNT, Math.floor(phaseElapsed / d.redStepSec));
      lights = Array.from({ length: LIGHT_COUNT }, (_, i) => (i < lit ? "green" : "red"));
      next = nextEvent("green", lit + 1, d.redStepSec - (phaseElapsed % d.redStepSec));
    } else if (phase === "green") {
      const off = Math.min(LIGHT_COUNT, Math.floor(phaseElapsed / d.greenStepSec));
      lights = Array.from({ length: LIGHT_COUNT }, (_, i) => (i < off ? "off" : "green"));
      next = nextEvent("off", off + 1, d.greenStepSec - (phaseElapsed % d.greenStepSec));
    } else {
      lights = Array(LIGHT_COUNT).fill("off");
      next = { kind: "blackout", light: 0, inSec: phaseRemainingSec };
    }

    return {
      phase,
      elapsedSec: t,
      phaseElapsedSec: phaseElapsed,
      phaseRemainingSec,
      cycleRemainingSec: total - t,
      lights,
      next,
    };
  }

  // Параметры цикла из снимка Longshot (`state.longshot`). Единая точка для
  // оверлея и превью редактора: `syncing` — ответа ещё не было, `ready` —
  // есть рабочий анкер и виджет операционен.
  function sourceFromSnapshot(snapshot) {
    if (!snapshot) return { ready: false, syncing: true, anchorMs: 0, durations: null };
    const anchorMs = Date.parse(snapshot.anchorAt || "");
    const phases = snapshot.phases || {};
    const intervals = snapshot.lightIntervals || {};
    const durations = {
      redSec: phases.redSec,
      greenSec: phases.greenSec,
      blackSec: phases.blackSec,
      redStepSec: intervals.redStepSec,
      greenStepSec: intervals.greenStepSec,
    };
    const ready = snapshot.operational !== false && Number.isFinite(anchorMs) && anchorMs > 0;
    return { ready, syncing: false, anchorMs: ready ? anchorMs : 0, durations };
  }

  // "HH:MM:SS" when at least an hour is left, otherwise "MM:SS". Takes seconds.
  function formatDuration(seconds) {
    const total = Math.max(0, Math.ceil(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  return {
    LIGHT_COUNT,
    RED_SEC,
    GREEN_SEC,
    BLACK_SEC,
    CYCLE_SEC,
    RED_STEP_SEC,
    GREEN_STEP_SEC,
    normalizeDurations,
    cycleSec,
    elapsedSec,
    stateAt,
    sourceFromSnapshot,
    formatDuration,
  };
});
