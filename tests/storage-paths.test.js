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

const path = require("path");
const {
  configureStorage,
  getConfigDir,
  getConfigPath,
  getDbPath,
  getExamplePath,
  getUserMediaDir,
  BUNDLED_CONFIG_DIR,
} = require("../server/storage-paths");

describe("server/storage-paths", () => {
  const original = getConfigDir();

  afterEach(() => {
    configureStorage({ configDir: original });
  });

  test("configureStorage задаёт каталог данных и производные пути", () => {
    configureStorage({ configDir: "C:\\data" });

    expect(getConfigDir()).toBe("C:\\data");
    expect(getConfigPath()).toBe(path.join("C:\\data", "config.json"));
    expect(getDbPath()).toBe(path.join("C:\\data", "local-db.json"));
    expect(getUserMediaDir()).toBe(path.join("C:\\data", "media"));
  });

  test("getExamplePath указывает на bundled config.example.json", () => {
    expect(getExamplePath()).toBe(path.join(BUNDLED_CONFIG_DIR, "config.example.json"));
  });
});
