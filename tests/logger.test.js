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

const { createLogger } = require("../server/logger");

describe("server/logger", () => {
  let bus;

  beforeEach(() => {
    bus = { emit: jest.fn() };
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("эмитит terminal_log с корректной структурой", () => {
    const log = createLogger(bus, "obs");
    log.info("connected", { host: "127.0.0.1" });

    expect(bus.emit).toHaveBeenCalledWith("terminal_log", expect.objectContaining({
      service: "obs",
      level: "info",
      message: "connected",
      data: { host: "127.0.0.1" },
      timestamp: expect.any(Number),
    }));
  });

  test("ставит data: null, когда данные не переданы", () => {
    const log = createLogger(bus, "server");
    log.error("boom");
    expect(bus.emit).toHaveBeenCalledWith("terminal_log", expect.objectContaining({
      level: "error",
      message: "boom",
      data: null,
    }));
  });

  test("работает без bus", () => {
    const log = createLogger(null, "test");
    expect(() => log.warn("hi")).not.toThrow();
  });
});
