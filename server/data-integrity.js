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
  Целостность файлов состояния (config.json, local-db.json).

  Эти два файла — единственное место, где живут настройки пользователя, и до
  сих пор порча файла означала одно из двух: приложение не стартует вообще
  (config.json парсился без обработки ошибок) или молча пишет поверх
  повреждённого свои дефолты, теряя данные (local-db.json при ошибке чтения
  отдавал `{}`). Теперь такого нет:

    * битый файл не удаляется и не затирается, а переносится в карантин
      (`<файл>.corrupt-<метка времени>`) — его можно изучить и спасти руками;
    * значения поднимаются из последнего удачного бэкапа (`.bak.0`, затем
      `.bak.1`, …), которые ведёт AsyncAtomicStore при каждой записи;
    * если поднимать нечего, вызывающий код берёт шаблон из поставки;
    * каждый случай порчи пишется в консоль, в `logs/recovery-<дата>.log` и в
      список, по которому главный процесс показывает диалог. Иначе «настройки
      слетели» выглядит как загадка без следов.
*/

const fs = require("fs");
const path = require("path");

const { backupPath, DEFAULT_BACKUP_SLOTS } = require("./atomic-write");
const { getLogsDir } = require("./storage-paths");

// Список восстановлений за текущий запуск (для диалога в главном процессе).
const recoveryEvents = [];

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// «20260915-143012» — читаемая метка для имени карантинного файла.
function timestampTag(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function dayStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/*
  Переносит испорченный файл в карантин рядом с оригиналом. Возвращает путь
  карантина или null, если перенести не удалось (нет прав, файл занят) — в этом
  случае вызывающий код продолжает работать, ничего не удаляя.
*/
function quarantineFile(filePath, tag = timestampTag()) {
  const target = `${filePath}.corrupt-${tag}`;
  try {
    fs.renameSync(filePath, target);
    return target;
  } catch (_) {
    return null;
  }
}

// Чтение JSON-объекта с разделением «файла нет» и «файл есть, но нечитаем».
function tryReadJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return { ok: false, missing: !!(err && err.code === "ENOENT"), error: err };
  }
  if (!raw.trim()) return { ok: false, missing: false, error: new Error("файл пуст") };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, missing: false, error: err };
  }
  if (!isPlainObject(parsed)) return { ok: false, missing: false, error: new Error("ожидался JSON-объект") };
  return { ok: true, missing: false, value: parsed };
}

function appendToRecoveryLog(text) {
  try {
    const dir = getLogsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `recovery-${dayStamp()}.log`), `[${new Date().toISOString()}] ${text}\n`);
  } catch (_) {
    /* журнал восстановлений не должен мешать самому восстановлению */
  }
}

function describeRecoveryEvent(event) {
  const file = path.basename(event.file || "");
  if (event.kind === "restored-from-backup") {
    return (
      `${file}: файл повреждён (${event.reason}) и перенесён в карантин ` +
      `(${path.basename(event.quarantinePath || "—")}), данные восстановлены из бэкапа ` +
      `${path.basename(event.backupPath || "—")}`
    );
  }
  return (
    `${file}: файл повреждён (${event.reason}) и перенесён в карантин ` +
    `(${path.basename(event.quarantinePath || "—")}); пригодного бэкапа не нашлось — ` +
    `работа начата со значениями по умолчанию`
  );
}

function recordRecovery(event) {
  const entry = { at: Date.now(), ...event };
  recoveryEvents.push(entry);
  const text = describeRecoveryEvent(entry);
  console.warn("[data-integrity]", text);
  appendToRecoveryLog(text);
  return entry;
}

function getRecoveryEvents() {
  return recoveryEvents.slice();
}

function clearRecoveryEvents() {
  recoveryEvents.length = 0;
}

/*
  Описание бэкап-слотов файла: что лежит в каждом, когда и годится ли вообще.
  Нужно для списка «Резервные копии» в настройках: пользователь видит, к чему
  может откатиться, ещé до нажатия кнопки; битый или пустой слот помечается как
  непригодный и не предлагается к восстановлению.
*/
function describeBackups(filePath, slots = DEFAULT_BACKUP_SLOTS) {
  const out = [];
  for (let slot = 0; slot < slots; slot++) {
    const file = backupPath(filePath, slot);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      continue; // слота нет — он ещё не создан
    }
    const attempt = tryReadJson(file);
    const entry = {
      slot,
      file,
      name: path.basename(file),
      bytes: stat.size,
      mtime: stat.mtimeMs,
      valid: !!attempt.ok,
    };
    if (!attempt.ok) entry.error = (attempt.error && attempt.error.message) || String(attempt.error);
    out.push(entry);
  }
  return out;
}

/*
  Читает JSON-файл состояния, переживая порчу содержимого.

  Возвращает:
    { source: "file",   value }                            — всё хорошо;
    { source: "missing", value: null }                     — файла ещё нет;
    { source: "backup", value, quarantinePath, backupPath } — подняли из бэкапа;
    { source: "unrecoverable", value: null, quarantinePath } — поднимать нечего.

  Значение `value` — уже разобранный объект либо null; что делать дальше
  (взять шаблон из поставки, дополнить дефолтами) решает вызывающий код.
*/
function recoverJsonFile(filePath, options = {}) {
  const label = options.label || path.basename(filePath);
  const slots = Number.isFinite(options.backupSlots) ? Math.max(0, Math.floor(options.backupSlots)) : DEFAULT_BACKUP_SLOTS;

  const direct = tryReadJson(filePath);
  if (direct.ok) return { value: direct.value, source: "file", filePath, label };
  if (direct.missing) return { value: null, source: "missing", filePath, label };

  const reason = (direct.error && direct.error.message) || String(direct.error);
  const quarantinePath = quarantineFile(filePath);

  for (let i = 0; i < slots; i++) {
    const candidate = backupPath(filePath, i);
    const attempt = tryReadJson(candidate);
    if (!attempt.ok) continue;
    recordRecovery({ kind: "restored-from-backup", file: filePath, label, reason, quarantinePath, backupPath: candidate });
    return { value: attempt.value, source: "backup", filePath, label, quarantinePath, backupPath: candidate };
  }

  recordRecovery({ kind: "unrecoverable", file: filePath, label, reason, quarantinePath });
  return { value: null, source: "unrecoverable", filePath, label, quarantinePath };
}

module.exports = {
  recoverJsonFile,
  quarantineFile,
  tryReadJson,
  timestampTag,
  describeBackups,
  describeRecoveryEvent,
  recordRecovery,
  getRecoveryEvents,
  clearRecoveryEvents,
};
