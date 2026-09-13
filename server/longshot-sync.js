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
  Longshot timers sync.

  The live Executive Hangar anchor lives in the Longshot API
  (`api-longshot.longshotrelay.com/api/hangar-config`, cache-busted with `?v=`,
  same request the site itself makes); the static `timers.longshotrelay.com/
  timer-config.json` is only a fallback and can lag behind by weeks.

  Normalized shape the overlay understands:

      { ok, operational, anchorAt, updateMessage, phases, lightIntervals,
        remoteUpdatedAt, fetchedAt, error }

  The overlay only needs the anchor + durations; the cycle math stays local
  (shared/hangar-cycle.js), so a failed fetch degrades gracefully. `fetch` is
  injectable so the mapping and error/fallback paths are unit-tested without
  real network.

  Polling is lazy: the server enables the sync (`setActive`) only while a
  visible Executive Hangar timer widget is in the layout, so a widget that is
  not on screen never turns into a background request every 5 minutes.
*/

const API_URL = "https://api-longshot.longshotrelay.com/api/hangar-config";
const FALLBACK_URL = "https://timers.longshotrelay.com/timer-config.json";
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 30 * 1000;

function emptySnapshot() {
  return {
    ok: false,
    operational: false,
    anchorAt: "",
    updateMessage: "",
    phases: null,
    lightIntervals: null,
    remoteUpdatedAt: "",
    fetchedAt: 0,
    error: "",
  };
}

// The site parses the anchor with `Date.parse(str)` but appends "Z" when the
// string carries no timezone, so a naive parse must not read it as local time.
function toUtcIso(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const ms = Date.parse(hasTimezone ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

// Map the Longshot payload to our normalized shape (null when unusable).
function mapConfig(json) {
  const hangar = (json && json.executiveHangar) || null;
  if (!hangar || !hangar.hangarAnchorAt) return null;

  const anchorAt = toUtcIso(hangar.hangarAnchorAt);
  if (!anchorAt) return null;

  const minutes = 60;
  const num = (value, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const redSec = num(hangar.phases && hangar.phases.redMinutes, 120) * minutes;
  const greenSec = num(hangar.phases && hangar.phases.greenMinutes, 60) * minutes;
  const blackSec = num(hangar.phases && hangar.phases.blackMinutes, 5) * minutes;

  return {
    ok: true,
    operational: hangar.operational !== false,
    anchorAt,
    updateMessage: String(hangar.updateMessage || ""),
    phases: { redSec, greenSec, blackSec },
    lightIntervals: {
      // Same fallbacks the site uses: a fifth of the phase when unspecified.
      redStepSec: num(hangar.lightIntervals && hangar.lightIntervals.redTurnGreenMinutes, redSec / minutes / 5) * minutes,
      greenStepSec: num(hangar.lightIntervals && hangar.lightIntervals.greenTurnOffMinutes, greenSec / minutes / 5) * minutes,
    },
    remoteUpdatedAt: String(hangar.updatedAt || ""),
    fetchedAt: Date.now(),
    error: "",
  };
}

function withCacheBuster(url) {
  return `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
}

function createLongshotSync(options = {}) {
  const url = options.url || API_URL;
  const fallbackUrl = options.fallbackUrl === undefined ? FALLBACK_URL : options.fallbackUrl;
  const intervalMs = Math.max(MIN_INTERVAL_MS, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const logger = typeof options.logger === "function" ? options.logger : null;
  const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : null;

  let snapshot = emptySnapshot();
  let timer = null;
  let inflight = null;
  let active = false;

  async function loadOne(target) {
    const res = await fetchImpl(withCacheBuster(target), {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res || !res.ok) throw new Error(`HTTP ${(res && res.status) || "?"}`);
    const json = await res.json();
    const mapped = mapConfig(json);
    if (!mapped) throw new Error("unexpected payload");
    return mapped;
  }

  async function refresh() {
    if (!fetchImpl) {
      snapshot = { ...snapshot, ok: false, error: "fetch unavailable" };
      if (onUpdate) onUpdate(snapshot);
      return snapshot;
    }
    if (inflight) return inflight;

    inflight = (async () => {
      let mapped = null;
      let error = null;
      try {
        mapped = await loadOne(url);
      } catch (err) {
        error = err;
      }
      if (!mapped && fallbackUrl && fallbackUrl !== url) {
        try {
          mapped = await loadOne(fallbackUrl);
          error = null;
        } catch (err) {
          if (!error) error = err;
        }
      }

      if (mapped) {
        snapshot = mapped;
      } else {
        // Keep the previous anchor so a transient failure doesn't blank the
        // overlay; only the error flag/description changes.
        snapshot = { ...snapshot, ok: false, fetchedAt: Date.now(), error: (error && error.message) || String(error) };
        if (logger) logger(`longshot sync failed: ${snapshot.error}`);
      }
      inflight = null;
      if (onUpdate) onUpdate(snapshot);
      return snapshot;
    })();

    return inflight;
  }

  // Ленивый опрос: пока активных потребителей нет, таймер не заводится. При
  // включении сразу тянем свежий анкер, чтобы виджет не ждал первый интервал.
  function setActive(next) {
    const want = !!next;
    if (want === active) return active;
    active = want;
    if (active) {
      refresh();
      timer = setInterval(refresh, intervalMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    } else {
      if (timer) clearInterval(timer);
      timer = null;
    }
    return active;
  }

  function start() {
    return setActive(true);
  }

  function stop() {
    return setActive(false);
  }

  return { setActive, isActive: () => active, start, stop, refresh, get: () => snapshot };
}

module.exports = {
  createLongshotSync,
  mapConfig,
  toUtcIso,
  emptySnapshot,
  API_URL,
  FALLBACK_URL,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
};
