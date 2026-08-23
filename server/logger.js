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
const path = require("path");

/*
  Unified log emitter for the in-app terminal. Each service builds a logger
  with `createLogger(bus, service)`; every call writes to the console and, if
  a bus is provided, emits a `terminal_log` event consumed by the control panel.

  Optional persistent logging: call `enableFileLogging(dir)` once at startup to
  also append each entry to a daily-rotated `ose-YYYY-MM-DD.log` file in `dir`.
*/

const LOG_RETENTION_DAYS = 7;

let fileLogDir = null;
let fileStream = null;
let fileStreamDay = "";

function enableFileLogging(dir) {
  fileLogDir = dir || null;
  if (fileStream) {
    try {
      fileStream.end();
    } catch {}
    fileStream = null;
    fileStreamDay = "";
  }
  if (fileLogDir) pruneOldLogs(fileLogDir);
}

function closeFileLogging() {
  if (fileStream) {
    try {
      fileStream.end();
    } catch {}
    fileStream = null;
    fileStreamDay = "";
  }
  fileLogDir = null;
}

function pruneOldLogs(dir) {
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^ose-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {}
    }
  } catch {}
}

function ensureFileStream() {
  if (!fileLogDir) return null;

  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (fileStream && fileStreamDay === day) return fileStream;

  if (fileStream) {
    try {
      fileStream.end();
    } catch {}
    fileStream = null;
  }

  try {
    fs.mkdirSync(fileLogDir, { recursive: true });
    fileStream = fs.createWriteStream(path.join(fileLogDir, `ose-${day}.log`), { flags: "a" });
    fileStreamDay = day;
  } catch (err) {
    console.error("[logger] failed to open log file:", err.message);
    fileStream = null;
  }
  return fileStream;
}

function serializeData(data) {
  if (data === undefined) return "";
  if (typeof data === "string") return " " + data;
  try {
    return " " + JSON.stringify(data);
  } catch {
    return " [unserializable]";
  }
}

function createLogger(bus, service) {
  function emit(level, message, data) {
    const entry = {
      timestamp: Date.now(),
      service,
      level,
      message: String(message),
      data: data === undefined ? null : data,
    };

    const label = `[${service}] [${level}]`;
    if (level === "error") console.error(label, entry.message, data === undefined ? "" : data);
    else if (level === "warn") console.warn(label, entry.message, data === undefined ? "" : data);
    else console.log(label, entry.message, data === undefined ? "" : data);

    if (bus) bus.emit("terminal_log", entry);

    const stream = ensureFileStream();
    if (stream) {
      try {
        const iso = new Date(entry.timestamp).toISOString();
        stream.write(`[${iso}] [${service}] [${level}] ${entry.message}${serializeData(data)}\n`);
      } catch {
        // Файловое логирование не должно ронять приложение.
      }
    }
  }

  function emitDebug(message, data) {
    const entry = {
      timestamp: Date.now(),
      service,
      level: "debug",
      message: String(message),
      data: data === undefined ? null : data,
    };

    const label = `[${service}] [debug]`;
    console.log(label, entry.message, data === undefined ? "" : data);

    if (bus) bus.emit("debug_log", entry);

    const stream = ensureFileStream();
    if (stream) {
      try {
        const iso = new Date(entry.timestamp).toISOString();
        stream.write(`[${iso}] [${service}] [debug] ${entry.message}${serializeData(data)}\n`);
      } catch {
        // Файловое логирование не должно ронять приложение.
      }
    }
  }

  return {
    info(message, data) {
      emit("info", message, data);
    },
    success(message, data) {
      emit("success", message, data);
    },
    warn(message, data) {
      emit("warn", message, data);
    },
    error(message, data) {
      emit("error", message, data);
    },
    debug(message, data) {
      emitDebug(message, data);
    },
  };
}

module.exports = { createLogger, enableFileLogging, closeFileLogging };
