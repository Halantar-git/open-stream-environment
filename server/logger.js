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
  Unified log emitter for the in-app terminal. Each service builds a logger
  with `createLogger(bus, service)`; every call writes to the console and, if
  a bus is provided, emits a `terminal_log` event consumed by the control panel.
*/
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
  };
}

module.exports = { createLogger };
