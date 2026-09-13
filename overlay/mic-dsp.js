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
  Microphone visualizer DSP helpers.

  Maps the raw FFT spectrum to display bands and shapes the signal for smooth
  rendering. Kept DOM-free and side-effect-free so it can be unit-tested:

    * buildBands()          — split the usable spectrum into band ranges
                              (log/mel-like or linear);
    * bandsFromSpectrum()   — average/max each range to a 0..1 value;
    * applyGate()           — noise gate with rescale above the threshold;
    * applyGain()           — clamped gain multiplier;
    * smoothValue/Bands()   — exponential attack/release smoothing;
    * smoothingTimes()      — map a 0..1 "smoothing" knob to seconds;
    * createFrameGate()     — hard FPS limiter for the render loop.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.MicDSP = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  // Split the usable spectrum (first 80% of the bins) into `bandCount` ranges.
  // "log" gives narrower low bands (mel-like, much better for voice/music),
  // "linear" gives equal-width bands. Every range is non-empty and in bounds.
  function buildBands(binCount, bandCount, scale) {
    const bands = Math.max(1, Math.round(bandCount));
    const usable = Math.max(1, Math.floor((Number(binCount) || 0) * 0.8));
    const ranges = [];
    if (scale === "log") {
      const maxLog = Math.log(usable + 1);
      for (let i = 0; i < bands; i++) {
        const a = (i / bands) * maxLog;
        const b = ((i + 1) / bands) * maxLog;
        ranges.push({ start: Math.floor(Math.exp(a)) - 1, end: Math.floor(Math.exp(b)) - 1 });
      }
    } else {
      for (let i = 0; i < bands; i++) {
        ranges.push({ start: Math.floor((i / bands) * usable), end: Math.floor(((i + 1) / bands) * usable) });
      }
    }
    return ranges.map((r) => {
      const start = Math.max(0, Math.min(r.start, usable - 1));
      const end = Math.max(start + 1, Math.min(r.end, usable));
      return { start, end };
    });
  }

  // Reduce each band range to a 0..1 value. `reduce` is "mean" (default, smooth)
  // or "max" (punchier). Values are bytes (0..255).
  function bandsFromSpectrum(freq, bands, opts = {}) {
    const out = [];
    const reduce = opts.reduce || "mean";
    const len = freq ? freq.length : 0;
    for (const r of bands) {
      let acc = 0;
      let max = 0;
      let count = 0;
      for (let i = r.start; i < r.end && i < len; i++) {
        const v = freq[i] / 255;
        acc += v;
        if (v > max) max = v;
        count++;
      }
      out.push(count ? (reduce === "max" ? max : acc / count) : 0);
    }
    return out;
  }

  // Noise gate: values at/below the threshold fall to 0; above it they are
  // rescaled back to 0..1 so quiet-but-real signal stays visible.
  function applyGate(v, gate) {
    const g = clamp01(gate || 0);
    if (g <= 0) return clamp01(v);
    if (v <= g) return 0;
    return clamp01((v - g) / (1 - g));
  }

  function applyGain(v, gain) {
    const g = Number.isFinite(gain) ? gain : 1;
    return clamp01(v * g);
  }

  // Exponential approach with separate attack (rising) and release (falling)
  // time constants, both in seconds. `dt` is the frame delta in seconds.
  function smoothValue(prev, next, dt, opts = {}) {
    const attack = opts.attack != null ? opts.attack : 0.02;
    const release = opts.release != null ? opts.release : 0.25;
    const rate = next > prev ? attack : release;
    if (!(rate > 0)) return next;
    const k = Math.min(1, Math.max(0, dt) / rate);
    return prev + (next - prev) * k;
  }

  function smoothBands(prev, next, dt, opts) {
    const out = new Array(next.length);
    for (let i = 0; i < next.length; i++) {
      const p = prev && i < prev.length ? prev[i] : next[i];
      out[i] = smoothValue(p, next[i], dt, opts);
    }
    return out;
  }

  // Maps a 0..1 "smoothing" control (0 = snappy, 1 = very smooth) to attack and
  // release times in seconds.
  function smoothingTimes(smoothing) {
    const s = clamp01(smoothing);
    return { attack: 0.01 + s * 0.06, release: 0.05 + s * 0.55 };
  }

  // Hard FPS gate for a render loop. Returns `allow(now)` that is true only
  // when enough time elapsed since the last allowed frame. The cadence stays
  // stable without drift (`last` is snapped to the frame grid). Pure, so the
  // timing can be unit-tested with synthetic timestamps.
  function createFrameGate(fps) {
    const frameMs = 1000 / Math.max(1, Number(fps) || 30);
    let last = null;
    return function allow(now) {
      const t = Number(now) || 0;
      if (last === null) {
        last = t;
        return true;
      }
      const delta = t - last;
      if (delta < frameMs) return false;
      last = t - (delta % frameMs);
      return true;
    };
  }

  return { buildBands, bandsFromSpectrum, applyGate, applyGain, smoothValue, smoothBands, smoothingTimes, createFrameGate };
});
