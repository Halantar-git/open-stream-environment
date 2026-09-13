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
    * ретрай rename на Windows (EPERM/EBUSY/EACCES) — антивирус/индексатор;
    * опциональный fsync (options.fsync) — защита от потери при сбое питания;
    * ошибка одной записи логируется и НЕ «отравляет» очередь: следующие
      записи продолжают выполняться.
*/

const EMPTY = Symbol("empty");

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

class AsyncAtomicStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.stringify = typeof options.stringify === "function" ? options.stringify : (d) => JSON.stringify(d, null, 2);
    this.fsync = !!options.fsync;
    this.rename = typeof options.rename === "function" ? options.rename : fsp.rename;
    this.renameRetries = Number.isFinite(options.renameRetries) ? options.renameRetries : 4;
    this.renameRetryDelayMs = Number.isFinite(options.renameRetryDelayMs) ? options.renameRetryDelayMs : 30;
    this.logger = typeof options.logger === "function" ? options.logger : null;

    this._seq = 0;
    this._pending = EMPTY; // последний снапшот, ожидающий записи
    this._lastData = undefined; // последний переданный снапшот (для flushSync)
    this._draining = null; // промис текущего цикла записи
    this.lastError = null;
  }

  // Ставит снапшот в очередь (побеждает последний) и запускает цикл записи,
  // если он ещё не идёт. Возвращает промис текущего цикла.
  write(data) {
    this._lastData = data;
    this._pending = data;
    if (!this._draining) this._draining = this._run();
    return this._draining;
  }

  async _run() {
    try {
      while (this._pending !== EMPTY) {
        const snapshot = this._pending;
        this._pending = EMPTY;
        try {
          await this._writeSnapshot(snapshot);
          this.lastError = null;
        } catch (err) {
          this.lastError = err;
          if (this.logger) this.logger(err);
        }
      }
    } finally {
      this._draining = null;
    }
  }

  async _writeSnapshot(data) {
    const json = this.stringify(data);
    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });
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
      atomicWriteFileSync(this.filePath, this.stringify(this._lastData));
      return true;
    } catch (err) {
      if (this.logger) this.logger(err);
      return false;
    }
  }
}

module.exports = { atomicWriteFileSync, AsyncAtomicStore };
