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
  Отчёт о состоянии процесса: один объект, из которого видно, живёт приложение
  или нет, и что именно не так.

  Зачем, если есть логи: «работает, но оверлей отстаёт» и «чат отвалился в
  середине стрима» — это вопросы, на которые логи отвечают только после чтения
  сотен строк. Здесь собираются уже посчитанные величины (статусы интеграций,
  клиенты WebSocket, размеры и число записей, телеметрия записи, лаг event loop)
  и из них выводится короткий список проблем.

  Модуль намеренно чистый: никакого ввода-вывода и никакого доступа к конфигу с
  секретами — только то, что ему передали. Благодаря этому его легко покрыть
  тестами, а сам отчёт можно безопасно отдавать наружу (см. GET /healthz).

  Пороги «проблем»:
    * сервер не слушает порт — приложение неработоспособно;
    * были ошибки записи в БД/историю — данные могут теряться;
    * лаг event loop выше PERF_PROBLEM_MS — чат и оверлей будут отставать.
  Всё остальное — информация, а не проблема: например, ноль клиентов WS на
  старте это норма, а не авария.
*/

// Лаг выше этого значения уже бьёт по чату/оверлею: сообщение приходит позже,
// чем нужно, а анимация рвётся. Ниже — это шум, а не проблема.
const PERF_PROBLEM_MS = 100;

const { GROWTH_WARN_MB_PER_HOUR } = require("./longrun-monitor");

function round(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function normalizeWrites(writes) {
  if (!writes || typeof writes !== "object") return null;
  const pick = (stats) => {
    if (!stats || typeof stats !== "object") return null;
    const total = stats.total || {};
    const window = stats.window || {};
    return {
      writes: Number(total.writes) || 0,
      bytes: Number(total.bytes) || 0,
      coalesced: Number(total.coalesced) || 0,
      failed: Number(total.failed) || 0,
      backups: Number(total.backups) || 0,
      maxMs: round(total.maxMs),
      windowWrites: Number(window.writes) || 0,
    };
  };
  return { database: pick(writes.database) };
}

/*
  Хранилище — только метрики: размеры, число записей, лимиты и последняя
  ошибка. Пути к файлам сюда не попадают намеренно — отчёт уходит в сеть
  (GET /healthz), а путь выдаёт имя пользователя в системе.
*/
function normalizeStorage(storage) {
  if (!storage || typeof storage !== "object") return null;
  const part = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    const out = { bytes: Number(entry.bytes) || 0 };
    if (Number.isFinite(Number(entry.count))) out.count = Number(entry.count);
    if (Number.isFinite(Number(entry.limit))) out.limit = Number(entry.limit);
    out.lastError = entry.lastError ? String(entry.lastError) : null;
    return out;
  };
  return {
    database: part(storage.database),
    history: part(storage.history),
    chat: part(storage.chat),
    sessions: Number(storage.sessions) || 0,
  };
}

/*
  Долгий прогон — только сводка: история образцов приходит в отчёт для
  поддержки, а /healthz должен оставаться коротким.
*/
function normalizeLongrun(longrun) {
  if (!longrun || typeof longrun !== "object") return null;
  return {
    uptimeSec: Math.max(0, Math.round(Number(longrun.uptimeSec) || 0)),
    samples: Number(longrun.samples) || 0,
    rssMb: Number(longrun.rssMb) || 0,
    peakRssMb: Number(longrun.peakRssMb) || 0,
    heapUsedMb: Number(longrun.heapUsedMb) || 0,
    wsClients: Number(longrun.wsClients) || 0,
    reconnects: longrun.reconnects && typeof longrun.reconnects === "object" ? { ...longrun.reconnects } : {},
    reconnectsTotal: Number(longrun.reconnectsTotal) || 0,
    growthMbPerHour: round(longrun.growthMbPerHour),
    lagMaxMs: round(longrun.lagMaxMs),
  };
}

/*
  Доступ из сети — числа, а не флаги: по ним видно, стучится ли кто-то в порт
  без кода и не зациклил ли команды чужой скрипт.
*/
function normalizeSecurity(security) {
  if (!security || typeof security !== "object") return null;
  const audit = security.audit && typeof security.audit === "object" ? security.audit : {};
  return {
    tokenRequired: security.tokenRequired !== false,
    deniedUpgrade: Number(security.deniedUpgrade) || 0,
    deniedHttp: Number(security.deniedHttp) || 0,
    rateLimited: Number(security.rateLimited) || 0,
    audit: {
      total: Number(audit.total) || 0,
      external: Number(audit.external) || 0,
      limited: Number(audit.limited) || 0,
      kept: Number(audit.kept) || 0,
    },
  };
}

function buildHealthReport(ctx = {}) {
  const writes = normalizeWrites(ctx.writes);
  const storage = normalizeStorage(ctx.storage);
  const longrun = normalizeLongrun(ctx.longrun);
  const security = normalizeSecurity(ctx.security);
  const perf = ctx.perf
    ? { p50: round(ctx.perf.p50), p99: round(ctx.perf.p99), max: round(ctx.perf.max), mean: round(ctx.perf.mean) }
    : null;

  const problems = [];
  if (ctx.listening === false) problems.push("сервер не слушает порт");
  if (writes && writes.database && writes.database.failed > 0) {
    problems.push(`ошибки записи БД: ${writes.database.failed}`);
  }
  const storageErrors = [];
  ["database", "history", "chat"].forEach((key) => {
    const entry = storage && storage[key];
    if (entry && entry.lastError) storageErrors.push(`${key}: ${entry.lastError}`);
  });
  if (storageErrors.length) problems.push(`ошибки записи истории: ${storageErrors.join("; ")}`);
  if (perf && perf.max > PERF_PROBLEM_MS) problems.push(`лаг event loop: max ${perf.max} ms`);
  // Рост памяти считается тревожным только по нескольким образцам: по одному
  // сделать вывод нельзя, а два-три часа — уже тенденция.
  if (longrun && longrun.samples >= 3 && longrun.growthMbPerHour >= GROWTH_WARN_MB_PER_HOUR) {
    problems.push(`рост памяти ${longrun.growthMbPerHour} MB/ч (порог ${GROWTH_WARN_MB_PER_HOUR})`);
  }

  return {
    at: Date.now(),
    ok: problems.length === 0,
    app: ctx.appName || "Open Stream Environment",
    version: ctx.version || null,
    mode: ctx.mode || (process.versions.electron ? "electron" : "node (server:only)"),
    pid: process.pid,
    uptimeSec: Math.max(0, Math.round(Number(ctx.uptimeSec) || 0)),
    port: Number(ctx.port) || null,
    listening: ctx.listening !== false,
    server: {
      clients: Number(ctx.wsClients) || 0,
      byRole: ctx.wsByRole && typeof ctx.wsByRole === "object" ? { ...ctx.wsByRole } : {},
    },
    session: ctx.session || null,
    integrations: ctx.integrations && typeof ctx.integrations === "object" ? { ...ctx.integrations } : {},
    storage,
    writes,
    perf,
    longrun,
    security,
    problems,
  };
}

module.exports = { buildHealthReport, PERF_PROBLEM_MS };
