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
  Наблюдатель за долгим прогоном: память, клиенты и переподключения.

  Зачем: стрим идёт часами, и вопросы «не течёт ли память», «сколько раз ночью
  падал чат», «стало ли хуже к концу эфира» юнит-тестами не ловятся — для них
  нужен след по времени. Здесь раз в интервал (по умолчанию 10 минут) снимается
  один образец: время работы, rss/heap, клиенты WebSocket, число переподключений
  и пик лага event loop. Образцы копятся в кольцевом буфере (последние 24 — это
  четыре часа), а из них считается скорость роста памяти.

  Строка `[longrun] …` пишется только когда что-то заслуживает внимания:
  заметный рост памяти на последних образцах или резкий скачок переподключений.
  В простое логи молчат, как и у остальной телеметрии.

  Модуль не знает, откуда берутся цифры: данные приносит `sample()`. Поэтому он
  тестируется без сервера, а в приложении получает клиентов и переподключения из
  event loop'а, куда ему и место.

  Ориентир для «роста»: держать долгие сессии в десятках мегабайт — норма, но
  устойчивые +150 МБ в час означают утечку или накопление подписок, и это уже
  повод разбираться.
*/

const DEFAULT_EVERY_MS = 10 * 60 * 1000;
const DEFAULT_HISTORY = 24;
// Порог, с которого рост памяти считается тревожным (МБ в час).
const GROWTH_WARN_MB_PER_HOUR = 150;

function mb(bytes) {
  return Math.round((Number(bytes) || 0) / 1048576);
}

function round(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

/*
  Скорость роста памяти по образцам: берём самое раннее и самое позднее
  измерение, разницу делим на прошедшее время. Считаем по rss (то, что видит
  система) — heapUsed умеет прыгать из-за сборки мусора.
*/
function memoryGrowthMbPerHour(samples) {
  const list = (samples || []).filter((sample) => sample && Number.isFinite(sample.rssMb) && Number.isFinite(sample.at));
  if (list.length < 2) return 0;
  const first = list[0];
  const last = list[list.length - 1];
  const hours = (last.at - first.at) / 3600000;
  if (hours <= 0) return 0;
  return round((last.rssMb - first.rssMb) / hours);
}

function createLongRunMonitor(options = {}) {
  const everyMs = Number(options.everyMs) > 0 ? Number(options.everyMs) : DEFAULT_EVERY_MS;
  const historySize = Number(options.history) > 0 ? Math.floor(Number(options.history)) : DEFAULT_HISTORY;
  const sample = typeof options.sample === "function" ? options.sample : () => ({});
  const log = typeof options.log === "function" ? options.log : (line) => console.log(line);
  // Точка подмены для тестов: измерение памяти в тесте иначе не подкрутить.
  const memoryUsage = typeof options.memoryUsage === "function" ? options.memoryUsage : () => process.memoryUsage();
  const growthWarn = Number.isFinite(Number(options.growthWarnMbPerHour))
    ? Number(options.growthWarnMbPerHour)
    : GROWTH_WARN_MB_PER_HOUR;

  const startedAt = Date.now();
  const samples = [];
  const peaks = { rssMb: 0, heapUsedMb: 0 };
  let lastReport = null;

  function takeSample() {
    const memory = memoryUsage();
    const extra = sample() || {};
    const entry = {
      at: Date.now(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rssMb: mb(memory.rss),
      heapUsedMb: mb(memory.heapUsed),
      wsClients: Number(extra.wsClients) || 0,
      reconnects: { ...(extra.reconnects || {}) },
      lagMaxMs: round(extra.lagMaxMs),
    };
    samples.push(entry);
    if (samples.length > historySize) samples.shift();
    if (entry.rssMb > peaks.rssMb) peaks.rssMb = entry.rssMb;
    if (entry.heapUsedMb > peaks.heapUsedMb) peaks.heapUsedMb = entry.heapUsedMb;
    return entry;
  }

  function reconnectsTotal(entry) {
    return Object.values((entry && entry.reconnects) || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  }

  // Что стоит записать в лог и почему: рост памяти и всплеск переподключений.
  function evaluate(entry, previous) {
    const reasons = [];
    const growth = memoryGrowthMbPerHour(samples);
    if (samples.length >= 3 && growth >= growthWarn) {
      reasons.push(`рост памяти ${growth} MB/ч (порог ${growthWarn})`);
    }
    const previousTotal = reconnectsTotal(previous);
    const total = reconnectsTotal(entry);
    if (previous && total - previousTotal > 0) {
      reasons.push(`переподключений всего ${total} (+${total - previousTotal})`);
    }
    return reasons;
  }

  function report(force = false) {
    const entry = takeSample();
    const previous = samples.length > 1 ? samples[samples.length - 2] : null;
    const reasons = evaluate(entry, previous);
    if (reasons.length || force) {
      const line =
        `[longrun] ${(entry.uptimeSec / 3600).toFixed(1)} ч, rss ${entry.rssMb} MB ` +
        `(пик ${peaks.rssMb}), heap ${entry.heapUsedMb} MB, WS ${entry.wsClients}, ` +
        `переподключений ${reconnectsTotal(entry)}`;
      log(reasons.length ? `${line} — ${reasons.join("; ")}` : line);
    }
    lastReport = entry;
    return entry;
  }

  const timer = setInterval(() => report(), everyMs);
  // Телеметрия не держит процесс живым.
  if (timer && typeof timer.unref === "function") timer.unref();
  // Первый образец берём сразу: иначе пики и рост памяти начнутся только через
  // интервал, а отчёт для поддержки, снятый через минуту после старта, окажется
  // пустым.
  takeSample();

  function snapshot() {
    const latest = samples.length ? samples[samples.length - 1] : null;
    const reconnects = latest ? { ...latest.reconnects } : {};
    return {
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      everyMs,
      samples: samples.length,
      rssMb: latest ? latest.rssMb : mb(memoryUsage().rss),
      heapUsedMb: latest ? latest.heapUsedMb : mb(memoryUsage().heapUsed),
      peakRssMb: peaks.rssMb,
      peakHeapUsedMb: peaks.heapUsedMb,
      wsClients: latest ? latest.wsClients : 0,
      reconnects,
      reconnectsTotal: reconnectsTotal(latest),
      growthMbPerHour: memoryGrowthMbPerHour(samples),
      lagMaxMs: latest ? latest.lagMaxMs : 0,
      history: samples.map((entry) => ({ ...entry })),
    };
  }

  function stop() {
    clearInterval(timer);
  }

  return {
    report,
    snapshot,
    stop,
    get lastReport() {
      return lastReport;
    },
  };
}

module.exports = { createLongRunMonitor, memoryGrowthMbPerHour, GROWTH_WARN_MB_PER_HOUR, DEFAULT_EVERY_MS };
