/*
  Copyright (C) 2026  Halantar

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://gnu.org>.
*/

/*
  Наблюдатель за лагом event loop.

  Нужен, чтобы отвечать на вопрос «почему отстал чат/оверлей» данными, а не
  догадками: если в момент перетаскивания слайдера в панели loop стоит десятки
  миллисекунд, это видно строкой в логе рядом со отчётом `[atomic-write]`.

  Молчит, пока пик лага ниже порога: строка пишется только когда за интервал
  был заметный затык, поэтому в простое лог не шумит. Гистограмма сбрасывается
  каждый интервал.
*/

const { monitorEventLoopDelay } = require("perf_hooks");

const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_THRESHOLD_MS = 20;

function createEventLoopMonitor(options = {}) {
  const everyMs = Number(options.everyMs) > 0 ? Number(options.everyMs) : DEFAULT_INTERVAL_MS;
  const thresholdMs = Number.isFinite(Number(options.thresholdMs)) ? Number(options.thresholdMs) : DEFAULT_THRESHOLD_MS;
  const label = String(options.label || "event loop");
  const log = typeof options.log === "function" ? options.log : (line) => console.log(line);

  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();

  // Пустая гистограмма отдаёт NaN/-1 — приводим к нулю, чтобы порог работал.
  const ms = (value) => (Number.isFinite(value) && value > 0 ? value / 1e6 : 0);

  function snapshot() {
    return {
      p50: ms(histogram.percentile(50)),
      p99: ms(histogram.percentile(99)),
      max: ms(histogram.max),
      mean: ms(histogram.mean),
    };
  }

  const timer = setInterval(() => {
    const stats = snapshot();
    histogram.reset();
    if (stats.max < thresholdMs) return;
    log(
      `[perf] ${label}: p50 ${stats.p50.toFixed(1)} ms, p99 ${stats.p99.toFixed(1)} ms, ` +
        `max ${stats.max.toFixed(1)} ms (порог ${thresholdMs} ms)`
    );
  }, everyMs);
  // Не держим процесс живым из-за телеметрии.
  if (timer && typeof timer.unref === "function") timer.unref();

  function stop() {
    clearInterval(timer);
    histogram.disable();
  }

  return { snapshot, stop };
}

module.exports = { createEventLoopMonitor };
