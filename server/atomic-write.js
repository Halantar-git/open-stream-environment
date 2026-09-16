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

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

/*
  Атомарная запись файла: данные сначала пишутся во временный файл в том же
  каталоге, затем переименовываются поверх целевого. Если процесс упадёт во
  время записи, целевой файл останется прежним, а не превратится в обнулённый
  мусор.

  Два API:

    * atomicWriteFileSync(path, data) — синхронная запись. Держим для первого
      запуска, экспорта и финального flush при выходе (когда ждать нельзя).
    * new AsyncAtomicStore(path)       — асинхронный стор, не блокирующий event
      loop. Записи сериализуются и **коалесцируются** (побеждает последний
      снапшот), поэтому частые save() не копят очередь и не переписывают файл
      сотни раз.

  Надёжность:
    * уникальный скрытый temp-файл (`.name.pid.seq.tmp`) — нет столкновений
      между инстансами/процессами и temp не выглядит как данные;
    * уборка осиротевших temp-файлов при создании стора (они остаются, если
      процесс убили ровно между записью и rename);
    * ретрай rename на Windows (EPERM/EBUSY/EACCES) — антивирус/индексатор;
    * опциональный fsync (options.fsync) — защита от потери при сбое питания;
    * ошибка одной записи логируется и НЕ «отравляет» очередь: следующие
      записи продолжают выполняться.

  Ротация бэкапов (options.backupSlots, по умолчанию 3): последний УСПЕШНО
  записанный снапшот время от времени кладётся в `<файл>.bak.0`, предыдущие
  сдвигаются в `.bak.1`, `.bak.2`. Это страховка не от сбоя процесса (от него
  спасает сама атомарная запись), а от порчи уже лежащего файла — правки руками,
  сбой ФС, кривая синхронизация. Бэкап пишется не на каждую мутацию, а не чаще
  раза в options.backupEveryMs (0 — бэкапить каждую запись; по умолчанию 5
  минут): копия — это лишний ввод-
  вывод, а восстановиться с точностью до пяти минут назад обычно достаточно.

  Наблюдаемость (чтобы решать про батчинг/дебаунс по данным, а не на глаз):
  стор считает записи, байты, схлопнутые снапшоты, ошибки и время записи, а с
  options.reportEveryMs раз в интервал пишет одну строку — и только если за этот
  интервал что-то писалось.
*/

const EMPTY = Symbol("empty");

// Сколько живёт осиротевший temp-файл, прежде чем его можно удалить. Живая
// запись занимает миллисекунды, поэтому минута — безопасный запас, чтобы не
// снести temp параллельно пишущего инстанса.
const TEMP_MAX_AGE_MS = 60000;

// Бэкапов держим немного: цель — спасти настройки, а не вести архив.
const DEFAULT_BACKUP_SLOTS = 3;
const DEFAULT_BACKUP_EVERY_MS = 5 * 60 * 1000;
// Файлы состояния сейчас измеряются килобайтами; порог нужен только чтобы
// случайно разросшаяся БД не начала утраивать место на диске бэкапами.
const DEFAULT_BACKUP_MAX_BYTES = 16 * 1024 * 1024;

function atomicWriteFileSync(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp`);

  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      // сбой очистки игнорируем — важнее сохранить исходную ошибку
    }
    throw err;
  }
}

/*
  Убирает temp-файлы вида `.name.<pid>.<seq>.tmp`, оставшиеся от процессов,
  которые убили посреди записи. Файлы с недавним mtime не трогаем: их может
  писать живой инстанс прямо сейчас. Best-effort — ошибки игнорируются.
*/
function sweepStaleTempFiles(filePath, maxAgeMs = TEMP_MAX_AGE_MS) {
  let removed = 0;
  try {
    const dir = path.dirname(filePath);
    const prefix = `.${path.basename(filePath)}.`;
    const now = Date.now();
    fs.readdirSync(dir).forEach((name) => {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) return;
      const full = path.join(dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs < maxAgeMs) return;
        fs.unlinkSync(full);
        removed += 1;
      } catch (_) {
        /* файл уже исчез или занят — не наша забота */
      }
    });
  } catch (_) {
    /* каталога может ещё не быть */
  }
  return removed;
}

// Имя бэкап-слота: 0 — самый свежий.
function backupPath(filePath, index) {
  return `${filePath}.bak.${index}`;
}

/*
  Сдвигает бэкап-слоты на одну позицию и заполняет слот 0: либо переданным
  содержимым (это норма — в бэкап идёт последний заведомо целый снапшот), либо
  копией файла на диске. Всё best-effort: бэкап не должен мешать основной
  записи, поэтому ошибки глушатся, а наружу уходит только признак успеха.
*/
function rotateBackups(filePath, slots = DEFAULT_BACKUP_SLOTS, options = {}) {
  const count = Math.floor(Number(slots));
  if (!Number.isFinite(count) || count <= 0) return false;

  const content = typeof options.content === "string" ? options.content : null;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_BACKUP_MAX_BYTES;

  if (content !== null) {
    // Пустой/гигантский снапшот бэкапить бессмысленно.
    if (!content.trim()) return false;
    if (maxBytes > 0 && Buffer.byteLength(content, "utf8") > maxBytes) return false;
  } else if (maxBytes > 0) {
    try {
      if (fs.statSync(filePath).size > maxBytes) return false;
    } catch (_) {
      return false; // копировать нечего
    }
  }

  // Самый старый слот больше не нужен, дальше «переливаем» бэкапы назад.
  try {
    fs.unlinkSync(backupPath(filePath, count - 1));
  } catch (_) {
    /* самого старого слота могло и не быть */
  }
  for (let i = count - 2; i >= 0; i--) {
    try {
      fs.renameSync(backupPath(filePath, i), backupPath(filePath, i + 1));
    } catch (_) {
      /* слот пуст */
    }
  }

  try {
    if (content !== null) atomicWriteFileSync(backupPath(filePath, 0), content);
    else fs.copyFileSync(filePath, backupPath(filePath, 0));
    return true;
  } catch (_) {
    return false;
  }
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

// Интервал отчёта телеметрии по умолчанию — минута; OSE_WRITE_STATS_MS=0
// выключает её совсем (если строки в логе не нужны).
function writeStatsIntervalMs() {
  const raw = process.env.OSE_WRITE_STATS_MS;
  if (raw === undefined || raw === "") return 60000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

class AsyncAtomicStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.stringify = typeof options.stringify === "function" ? options.stringify : (d) => JSON.stringify(d, null, 2);
    this.fsync = !!options.fsync;
    this.rename = typeof options.rename === "function" ? options.rename : fsp.rename;
    this.renameRetries = Number.isFinite(options.renameRetries) ? options.renameRetries : 4;
    this.renameRetryDelayMs = Number.isFinite(options.renameRetryDelayMs) ? options.renameRetryDelayMs : 30;
    this.logger = typeof options.logger === "function" ? options.logger : null;
    // Метка для отчёта (по умолчанию — имя файла).
    this.label = String(options.label || path.basename(filePath));
    this.report = typeof options.report === "function" ? options.report : (line) => console.log(line);

    this.backupSlots = Number.isFinite(options.backupSlots) ? Math.max(0, Math.floor(options.backupSlots)) : DEFAULT_BACKUP_SLOTS;
    this.backupEveryMs = Number.isFinite(options.backupEveryMs) ? Math.max(0, options.backupEveryMs) : DEFAULT_BACKUP_EVERY_MS;
    this.backupMaxBytes = Number.isFinite(options.backupMaxBytes) ? options.backupMaxBytes : DEFAULT_BACKUP_MAX_BYTES;

    this._seq = 0;
    this._pending = EMPTY; // последний снапшот, ожидающий записи
    this._lastData = undefined; // последний переданный снапшот (для flushSync)
    this._lastGoodJson = undefined; // последний УСПЕШНО записанный снапшот
    this._lastBackupAt = 0; // 0 = бэкап ещё ни разу не делали
    this._draining = null; // промис текущего цикла записи
    this.lastError = null;

    // Статистика: window — за текущий интервал отчёта, total — за всё время.
    this.statsWindow = { writes: 0, bytes: 0, coalesced: 0, failed: 0, backups: 0, totalMs: 0, maxMs: 0 };
    this.statsTotal = { writes: 0, bytes: 0, coalesced: 0, failed: 0, backups: 0, totalMs: 0, maxMs: 0 };

    // Осиротевшие temp-файлы от прошлых запусков убираем сразу.
    sweepStaleTempFiles(filePath);

    const everyMs = Number(options.reportEveryMs);
    this._reportEveryMs = Number.isFinite(everyMs) && everyMs > 0 ? everyMs : 0;
    this._reportTimer = null;
    if (this._reportEveryMs) {
      this._reportTimer = setInterval(() => this.flushReport(), this._reportEveryMs);
      // Отчёт не должен держать процесс живым.
      if (this._reportTimer && typeof this._reportTimer.unref === "function") this._reportTimer.unref();
    }
  }

  // Ставит снапшот в очередь (побеждает последний) и запускает цикл записи,
  // если он ещё не идёт. Возвращает промис текущего цикла.
  write(data) {
    this._lastData = data;
    // Предыдущий снапшот ещё не ушёл на диск — он будет схлопнут этим.
    if (this._pending !== EMPTY) {
      this.statsWindow.coalesced += 1;
      this.statsTotal.coalesced += 1;
    }
    this._pending = data;
    if (!this._draining) this._draining = this._run();
    return this._draining;
  }

  async _run() {
    try {
      while (this._pending !== EMPTY) {
        const snapshot = this._pending;
        this._pending = EMPTY;
        const started = nowMs();
        try {
          await this._writeSnapshot(snapshot);
          this.lastError = null;
          this._countWrite(nowMs() - started);
        } catch (err) {
          this.lastError = err;
          this.statsWindow.failed += 1;
          this.statsTotal.failed += 1;
          if (this.logger) this.logger(err);
        }
      }
    } finally {
      this._draining = null;
    }
  }

  _countWrite(ms) {
    const bytes = this._lastSnapshotBytes || 0;
    this.statsWindow.writes += 1;
    this.statsWindow.bytes += bytes;
    this.statsWindow.totalMs += ms;
    if (ms > this.statsWindow.maxMs) this.statsWindow.maxMs = ms;
    this.statsTotal.writes += 1;
    this.statsTotal.bytes += bytes;
    this.statsTotal.totalMs += ms;
    if (ms > this.statsTotal.maxMs) this.statsTotal.maxMs = ms;
  }

  async _writeSnapshot(data) {
    const json = this.stringify(data);
    this._lastSnapshotBytes = Buffer.byteLength(json, "utf8");
    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });
    // Источник бэкапа читаем ДО подмены файла: в слот должен попасть прежний,
    // заведомо целый JSON, а не следствие текущей записи.
    const backupSource = this._backupDue() ? await this._backupSource() : undefined;
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${++this._seq}.tmp`);
    try {
      const handle = await fsp.open(tmp, "w");
      try {
        await handle.writeFile(json, "utf8");
        if (this.fsync) await handle.sync();
      } finally {
        await handle.close();
      }
      await this._renameWithRetry(tmp, this.filePath);
    } catch (err) {
      try {
        await fsp.unlink(tmp);
      } catch (_) {
        /* временный файл уже мог исчезнуть */
      }
      throw err;
    }
    this._lastGoodJson = json;
    if (backupSource !== undefined) this._writeBackup(backupSource);
  }

  _backupDue() {
    if (this.backupSlots <= 0) return false;
    return Date.now() - this._lastBackupAt >= this.backupEveryMs;
  }

  // Что положить в бэкап: последний удачный снапшот из памяти, а если его ещё
  // нет (первое сохранение в этом процессе) — то, что сейчас лежит на диске.
  async _backupSource() {
    if (typeof this._lastGoodJson === "string") return this._lastGoodJson;
    try {
      return await fsp.readFile(this.filePath, "utf8");
    } catch (_) {
      return undefined; // файла ещё нет — бэкапить нечего
    }
  }

  _writeBackup(content) {
    if (rotateBackups(this.filePath, this.backupSlots, { content, maxBytes: this.backupMaxBytes })) {
      this._lastBackupAt = Date.now();
      this.statsWindow.backups += 1;
      this.statsTotal.backups += 1;
    }
  }

  async _renameWithRetry(from, to) {
    let attempt = 0;
    for (;;) {
      try {
        await this.rename(from, to);
        return;
      } catch (err) {
        const code = err && err.code;
        const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
        if (!retryable || attempt >= this.renameRetries) throw err;
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, this.renameRetryDelayMs * attempt));
      }
    }
  }

  // Ждёт, пока все записанные (и уже поставленные) снапшоты окажутся на диске.
  async flush() {
    while (this._draining) {
      await this._draining.catch(() => {});
    }
  }

  // Синхронный финальный сброс последнего снапшота — для выхода из приложения,
  // когда ждать асинхронную запись нельзя. Best-effort: ошибку логируем и не
  // роняем выход (каталог мог быть уже убран).
  flushSync() {
    if (this._lastData === undefined) return false;
    try {
      const json = this.stringify(this._lastData);
      const started = nowMs();
      atomicWriteFileSync(this.filePath, json);
      this._lastSnapshotBytes = Buffer.byteLength(json, "utf8");
      this._countWrite(nowMs() - started);
      return true;
    } catch (err) {
      this.statsWindow.failed += 1;
      this.statsTotal.failed += 1;
      if (this.logger) this.logger(err);
      return false;
    }
  }

  // Снимок статистики (для тестов и внешних отчётов).
  getStats() {
    return { label: this.label, window: { ...this.statsWindow }, total: { ...this.statsTotal } };
  }

  // Одна строка отчёта за интервал — «сколько и чего писали». Если за интервал
  // не было ни записи, ни ошибки, молчим: логи не должны шуметь в простое.
  flushReport() {
    const w = this.statsWindow;
    if (!w.writes && !w.coalesced && !w.failed) return null;
    const kb = (n) => `${Math.round(n / 1024)} KB`;
    const avg = w.writes ? (w.totalMs / w.writes).toFixed(2) : "0";
    const line =
      `[atomic-write] ${this.label}: записей ${w.writes} (${kb(w.bytes)}), схлопнуто ${w.coalesced}, ` +
      `ошибок ${w.failed}, avg ${avg} ms, max ${w.maxMs.toFixed(1)} ms`;
    const t = this.statsTotal;
    const totalLine = ` | всего: ${t.writes} записей, ${kb(t.bytes)}, avg ${(t.totalMs / Math.max(1, t.writes)).toFixed(2)} ms`;
    const backupLine = w.backups ? `, бэкапов ${w.backups}` : "";
    this.report(line + backupLine + totalLine);
    this.statsWindow = { writes: 0, bytes: 0, coalesced: 0, failed: 0, backups: 0, totalMs: 0, maxMs: 0 };
    return line + backupLine + totalLine;
  }

  // Останавливает периодический отчёт (тесты и выключение телеметрии).
  stop() {
    if (this._reportTimer) clearInterval(this._reportTimer);
    this._reportTimer = null;
  }
}

module.exports = {
  atomicWriteFileSync,
  AsyncAtomicStore,
  sweepStaleTempFiles,
  writeStatsIntervalMs,
  backupPath,
  rotateBackups,
  DEFAULT_BACKUP_SLOTS,
  DEFAULT_BACKUP_EVERY_MS,
};
