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

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

const { atomicWriteFileSync, sweepStaleTempFiles } = require("./atomic-write");

/*
  Append-only история событий (JSON Lines) с ленивым индексом.

  На диске — одна JSON-строка на запись: каждое событие дописывается в конец
  (`appendFile`), без перезаписи всего файла.

  В памяти держим НЕ записи, а лёгкий индекс: смещение и длину строки,
  timestamp, признак теста, интернированные тип и sessionId и карту id→позиция.
  Содержимое читается из файла по требованию — при выдаче страницы (`query`),
  по `getById` или в `all()`. Поэтому 20 000 событий на диске стоят в памяти
  единицы мегабайт вместо десятков.

  Индекс строится ЛЕНИВО: при старте файл не читается, запоминается только его
  размер. Первое реальное чтение (открыли «Историю», настройки и т.п.) один раз
  сканирует файл и заполняет метаданные.

  Рост ограничен: видимыми считаются последние `maxRecords` записей. Файл
  уплотняется с гистерезисом (перезаписывается атомарно, temp+rename), так что
  одна полная перезапись приходится на `maxRecords` дописываний.

  Устойчивость к краху: повреждённые/частичные строки при индексации
  пропускаются — теряется максимум последняя запись.
*/

const TRUNCATE = "truncate";
const DEFAULT_MAX_RECORDS = 20000;
// Во сколько раз файл может превысить лимит, прежде чем уплотниться.
const COMPACT_FACTOR = 2;

let tmpSeq = 0;

// Явный 0/false отключает лимит; всё остальное (включая undefined) — либо
// положительное число, либо дефолт.
function resolveMaxRecords(value) {
  if (value === 0 || value === false || value === null) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_RECORDS;
}

async function renameWithRetry(from, to, retries = 4, delayMs = 30) {
  let attempt = 0;
  for (;;) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      const code = err && err.code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt >= retries) throw err;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

// Атомарная перезапись (temp + rename): краш во время уплотнения не оставит
// полупустой файл — прежняя история останется целой.
async function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${++tmpSeq}.tmp`);
  try {
    await fsp.writeFile(tmp, content, "utf8");
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    try {
      await fsp.unlink(tmp);
    } catch (_) {
      /* временный файл уже мог исчезнуть */
    }
    throw err;
  }
}

function currentFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function createHistoryStore(filePath, options = {}) {
  const logger = typeof options.logger === "function" ? options.logger : null;
  let maxRecords = resolveMaxRecords(options.maxRecords);

  // Temp-файлы от убитых процессов (уплотнение пишет temp+rename).
  sweepStaleTempFiles(filePath);

  // --- лёгкий индекс (только метаданные) ---
  let built = false;
  let index = []; // { off, len, ts, test, type, sess }
  let idMap = new Map(); // id -> позиция в index
  const typeDict = new Map();
  const typeList = [];
  const sessDict = new Map();
  const sessList = [];

  // Записи, поставленные в очередь, но ещё не подтверждённые на диске: их
  // содержимое доступно сразу (в памяти), пока не уйдёт в файл.
  let pending = []; // { record, entry }
  // Очередь полной перезаписи (миграция/уплотнение/очистка). Пока не записана,
  // видимым считается её содержимое (+ то, что успело дописаться после).
  let rewrite = null; // { records: [] }

  let ops = []; // { kind: "append", items } | { kind: TRUNCATE, records }
  let draining = null;
  let lastError = null;
  let fileBytes = currentFileSize(filePath);

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (_) {
    /* каталог создастся при первой записи */
  }

  // ---- интернирование строк (типы и sessionId повторяются тысячами) ----
  function intern(dict, list, value) {
    if (value == null) return -1;
    const key = String(value);
    if (!key) return -1;
    let id = dict.get(key);
    if (id === undefined) {
      id = list.length;
      dict.set(key, id);
      list.push(key);
    }
    return id;
  }

  function metaOf(record) {
    return {
      off: -1,
      len: 0,
      ts: Number(record && record.timestamp) || 0,
      test: record && record.is_test ? 1 : 0,
      type: intern(typeDict, typeList, record && record.type),
      sess: intern(sessDict, sessList, record && record.sessionId),
    };
  }

  // ---- ленивая индексация файла ----
  function ensureBuilt() {
    if (built) return;
    built = true;
    index = [];
    idMap = new Map();
    if (rewrite) return; // перезапись сама задаёт видимое содержимое
    let raw;
    try {
      raw = fs.readFileSync(filePath);
    } catch (_) {
      return;
    }
    let start = 0;
    let pos = 0;
    for (let i = 0; i <= raw.length; i++) {
      if (i !== raw.length && raw[i] !== 0x0a) continue;
      const len = i - start;
      if (len > 0) {
        const text = raw.toString("utf8", start, i);
        if (text.trim()) {
          try {
            const record = JSON.parse(text);
            const entry = metaOf(record);
            entry.off = start;
            entry.len = len;
            if (record && record.id != null) idMap.set(String(record.id), pos);
            index.push(entry);
            pos += 1;
          } catch (_) {
            // повреждённая или частичная строка — пропускаем
          }
        }
      }
      start = i + 1;
    }
    fileBytes = raw.length;
  }

  // ---- чтение содержимого ----
  function readEntry(fd, entry) {
    const buf = Buffer.allocUnsafe(entry.len);
    const read = fs.readSync(fd, buf, 0, entry.len, entry.off);
    return JSON.parse(buf.toString("utf8", 0, read));
  }

  // Видимые записи в порядке добавления: [{ record|null, entry }]. При лимите
  // оставляем только последние maxRecords.
  function visible() {
    let items;
    if (rewrite) {
      items = rewrite.records.map((record) => ({ record, entry: metaOf(record) }));
      // Записи, дописанные уже после постановки перезаписи.
      if (pending.length) items = items.concat(pending);
    } else {
      items = new Array(index.length + pending.length);
      for (let i = 0; i < index.length; i++) items[i] = { record: null, entry: index[i] };
      for (let p = 0; p < pending.length; p++) items[index.length + p] = pending[p];
    }
    if (maxRecords && items.length > maxRecords) items = items.slice(items.length - maxRecords);
    return items;
  }

  function readItems(items) {
    if (!items.length) return [];
    if (!items.some((it) => !it.record)) return items.map((it) => it.record);
    const fd = fs.openSync(filePath, "r");
    try {
      return items.map((it) => (it.record ? it.record : readEntry(fd, it.entry)));
    } finally {
      fs.closeSync(fd);
    }
  }

  function matchEntry(entry, record, filters) {
    if (filters.sess !== undefined && entry.sess !== filters.sess) return false;
    if (filters.type !== undefined && entry.type !== filters.type) return false;
    if (filters.includeTest === false && entry.test) return false;
    if (filters.since !== undefined && entry.ts < filters.since) return false;
    if (filters.search) {
      const u = String((record && record.username) || "").toLowerCase();
      const m = String((record && record.message) || "").toLowerCase();
      if (!u.includes(filters.search) && !m.includes(filters.search)) return false;
    }
    return true;
  }

  // JSON-экранированная форма подстроки (ровно так её пишет JSON.stringify):
  // кавычки → \", слэши → \\, переводы строк → \n. Нужна, чтобы предфильтр
  // не пропустил совпадение из-за экранирования.
  function jsonEscapedLower(needle) {
    try {
      return JSON.stringify(needle).slice(1, -1).toLowerCase();
    } catch (_) {
      return "";
    }
  }

  // Дешёвый предфильтр поиска: если ни искомой подстроки, ни её JSON-формы нет
  // в сырой строке, то и JSON.parse не нужен. Ложные срабатывания не страшны —
  // их отсеет matchEntry, а ложные пропуски исключены: совпадение по username/
  // message всегда присутствует в сырой строке хотя бы в экранированном виде.
  function rawMayMatch(lowerLine, needle, escaped) {
    if (lowerLine.includes(needle)) return true;
    return escaped !== needle && escaped !== "" && lowerLine.includes(escaped);
  }

  // Поиск разбирает JSON только тех записей, где искомая подстрока есть в сыром
  // виде — для 10 000 строк это убирает основную долю JSON.parse. Файл читается
  // один раз целиком: по-строчный readSync на 10 000 строк дороже самого парса.
  function searchItems(items, filters) {
    const needle = filters.search;
    const escaped = jsonEscapedLower(needle);
    const matched = [];
    let raw = null;
    for (const it of items) {
      let record = it.record;
      if (!record) {
        if (raw === null) {
          try {
            raw = fs.readFileSync(filePath);
          } catch (_) {
            break; // файл мог исчезнуть — возвращаем то, что успели
          }
        }
        const line = raw.toString("utf8", it.entry.off, it.entry.off + it.entry.len);
        if (!rawMayMatch(line.toLowerCase(), needle, escaped)) continue;
        try {
          record = JSON.parse(line);
        } catch (_) {
          continue; // повреждённая строка — как и при индексации, пропускаем
        }
      }
      if (matchEntry(it.entry, record, filters)) matched.push({ entry: it.entry, item: it, record });
    }
    return matched;
  }

  function filterOptions(opts) {
    return {
      sess: opts.sessionId ? intern(sessDict, sessList, opts.sessionId) : undefined,
      type: opts.type ? intern(typeDict, typeList, opts.type) : undefined,
      includeTest: opts.includeTest,
      search: opts.search ? String(opts.search).trim().toLowerCase() : "",
      /*
        Нижняя граница по времени. У стрим-событий нет sessionId — сессия
        считается по времени (так же, как в агрегатах сессий, см.
        db.getSessionsWithStats), поэтому «только этот стрим» задаётся началом
        сессии, а не идентификатором.
      */
      since: Number(opts.since) > 0 ? Number(opts.since) : undefined,
    };
  }

  function query(opts = {}) {
    ensureBuilt();
    const limit = Math.max(1, Number(opts.limit) || 50);
    const offset = Math.max(0, Number(opts.offset) || 0);
    const filters = filterOptions(opts);
    const needParse = !!filters.search;
    const items = visible();

    const matched = [];
    if (needParse) {
      // Поиск требует содержимого, но разбираем только строки, где искомая
      // подстрока есть в сыром виде (см. searchItems).
      matched.push(...searchItems(items, filters));
    } else {
      for (const it of items) if (matchEntry(it.entry, null, filters)) matched.push({ entry: it.entry, item: it });
    }

    matched.sort((a, b) => b.entry.ts - a.entry.ts);
    const page = matched.slice(offset, offset + limit);
    const records = needParse ? page.map((m) => m.record) : readItems(page.map((p) => p.item));
    return { items: records, total: matched.length };
  }

  function getById(id) {
    ensureBuilt();
    const key = id == null ? "" : String(id);
    if (!key) return null;
    if (rewrite) {
      const found = rewrite.records.find((r) => r && String(r.id) === key);
      return found || null;
    }
    for (const item of pending) {
      if (item.record && String(item.record.id) === key) return item.record;
    }
    const pos = idMap.get(key);
    if (pos === undefined) return null;
    return readItems([{ record: null, entry: index[pos] }])[0];
  }

  // Все видимые записи (используется агрегатами по сессиям).
  function all() {
    ensureBuilt();
    return readItems(visible());
  }

  function count() {
    ensureBuilt();
    const total = (rewrite ? rewrite.records.length : index.length) + pending.length;
    return maxRecords && total > maxRecords ? maxRecords : total;
  }

  // ---- запись ----

  function ensureDrain() {
    if (!draining) draining = Promise.resolve().then(drain);
    return draining;
  }

  function enqueueRewrite(records) {
    const list = Array.isArray(records) ? records : [];
    ops = [{ kind: TRUNCATE, records: list }];
    rewrite = { records: list };
    pending = [];
    // Индекс пересоберётся после успешной записи; пока читаем из rewrite.
    built = true;
    index = [];
    idMap = new Map();
    return ensureDrain();
  }

  function append(record) {
    const item = { record, entry: metaOf(record) };
    pending.push(item);
    ops.push({ kind: "append", items: [{ record, text: JSON.stringify(record) }] });
    if (maxRecords && !rewrite && index.length + pending.length > maxRecords * COMPACT_FACTOR) {
      // Уплотняем видимое содержимое (включая pending) в новый файл.
      ensureBuilt();
      enqueueRewrite(readItems(visible()));
    } else {
      ensureDrain();
    }
    return record;
  }

  function replaceAll(next) {
    let records = Array.isArray(next) ? next.slice() : [];
    if (maxRecords && records.length > maxRecords) records = records.slice(records.length - maxRecords);
    enqueueRewrite(records);
  }

  function clear() {
    enqueueRewrite([]);
  }

  // Удаляет записи, подходящие под фильтр (type/sessionId/search/is_test).
  function removeBy(filter = {}) {
    ensureBuilt();
    const filters = filterOptions(filter);
    const items = visible();
    const records = readItems(items);
    const kept = [];
    let removed = 0;
    items.forEach((it, i) => {
      const record = it.record || records[i];
      if (matchEntry(it.entry, record, filters)) removed += 1;
      else kept.push(record);
    });
    if (removed) enqueueRewrite(kept);
    return removed;
  }

  function setMaxRecords(value) {
    maxRecords = resolveMaxRecords(value);
    ensureBuilt();
    enqueueRewrite(all());
    return maxRecords;
  }

  async function drain() {
    try {
      while (ops.length) {
        const batch = ops.splice(0, ops.length);
        const truncateOp = [...batch].reverse().find((op) => op.kind === TRUNCATE);
        if (truncateOp) {
          const lastIdx = batch.lastIndexOf(truncateOp);
          const consumed = collectRecords(batch, lastIdx + 1);
          const records = capRecords([...(truncateOp.records || []), ...consumed]);
          const content = records.length ? records.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
          try {
            await writeAtomic(filePath, content);
            applyRewrite(records, content, consumed);
            lastError = null;
          } catch (err) {
            lastError = err;
            if (logger) logger(err);
          }
        } else {
          const items = batch.flatMap((op) => op.items || []);
          if (!items.length) continue;
          const content = items.map((it) => it.text).join("\n") + "\n";
          const base = fileBytes;
          try {
            await fsp.appendFile(filePath, content);
            fileBytes = base + Buffer.byteLength(content);
            applyAppend(items, base);
            lastError = null;
          } catch (err) {
            lastError = err;
            if (logger) logger(err);
            // Сбой не теряет видимость: записи остаются в pending.
            break;
          }
        }
      }
    } finally {
      draining = null;
    }
  }

  // Записи из всех append-операций после последнего truncate в батче: они
  // дописываются в тот же атомарный файл, чтобы ничего не потерять.
  function collectRecords(batch, fromIdx) {
    const out = [];
    for (let i = fromIdx; i < batch.length; i++) {
      for (const it of batch[i].items || []) out.push(it.record);
    }
    return out;
  }

  function capRecords(records) {
    if (maxRecords && records.length > maxRecords) return records.slice(records.length - maxRecords);
    return records;
  }

  // Пересобирает индекс по только что записанному файлу: содержимое известно,
  // поэтому смещения считаем без чтения с диска. Записи, дописанные уже после
  // постановки перезаписи, остаются в pending.
  function applyRewrite(records, content, consumed) {
    index = [];
    idMap = new Map();
    let off = 0;
    records.forEach((record, pos) => {
      const text = JSON.stringify(record);
      const entry = metaOf(record);
      entry.off = off;
      entry.len = Buffer.byteLength(text);
      if (record && record.id != null) idMap.set(String(record.id), pos);
      index.push(entry);
      off += entry.len + 1; // + "\n"
    });
    fileBytes = Buffer.byteLength(content);
    rewrite = null;
    if (consumed && consumed.length) {
      const written = new Set(consumed);
      pending = pending.filter((p) => !written.has(p.record));
    }
  }

  // Дописывает метаданные записанных строк в индекс (если он построен).
  function applyAppend(items, base) {
    if (items.length) {
      const written = new Set(items.map((it) => it.record));
      pending = pending.filter((p) => !written.has(p.record));
    }
    if (!built || rewrite) return; // индекс пересоберётся из файла / из rewrite
    let off = base;
    for (const it of items) {
      const entry = metaOf(it.record);
      entry.off = off;
      entry.len = Buffer.byteLength(it.text);
      if (it.record && it.record.id != null) idMap.set(String(it.record.id), index.length);
      index.push(entry);
      off += entry.len + 1;
    }
  }

  async function flush() {
    while (draining) await draining.catch(() => {});
  }

  // Синхронный сброс недописанных строк — для выхода из приложения.
  function flushSync() {
    if (!ops.length) return false;
    const batch = ops.splice(0, ops.length);
    const truncateOp = [...batch].reverse().find((op) => op.kind === TRUNCATE);
    try {
      if (truncateOp) {
        const lastIdx = batch.lastIndexOf(truncateOp);
        const consumed = collectRecords(batch, lastIdx + 1);
        const records = capRecords([...(truncateOp.records || []), ...consumed]);
        const content = records.length ? records.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
        atomicWriteFileSync(filePath, content);
        applyRewrite(records, content, consumed);
      } else {
        const items = batch.flatMap((op) => op.items || []);
        if (!items.length) return false;
        const content = items.map((it) => it.text).join("\n") + "\n";
        const base = fileBytes;
        fs.appendFileSync(filePath, content);
        fileBytes = base + Buffer.byteLength(content);
        applyAppend(items, base);
      }
      return true;
    } catch (err) {
      if (logger) logger(err);
      return false;
    }
  }

  return {
    filePath,
    append,
    replaceAll,
    clear,
    query,
    getById,
    removeBy,
    setMaxRecords,
    all,
    count,
    flush,
    flushSync,
    get maxRecords() {
      return maxRecords;
    },
    get lastError() {
      return lastError;
    },
  };
}

module.exports = { createHistoryStore, DEFAULT_MAX_RECORDS };
