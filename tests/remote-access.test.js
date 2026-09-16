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
  Код доступа из сети: где он живёт, как проверяется и что происходит при
  ротации. Ошибка здесь — это либо «пульт не подключается», либо «в сеть пустили
  кого угодно», поэтому проверяем и сохранение между запусками, и строгость
  сравнения.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const { configureStorage, getConfigPath } = require("../server/storage-paths");
const { AppState } = require("../server/state");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ose-access-"));
}

function freshState() {
  const dir = tmpDir();
  configureStorage({ configDir: dir });
  return { dir, state: new AppState(null) };
}

describe("код доступа из сети", () => {
  test("создаётся при первом запуске и сохраняется в конфиге", () => {
    const { dir, state } = freshState();

    const token = state.remoteToken();
    expect(token).toMatch(/^[a-f0-9]{32}$/);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(onDisk.remote_token).toBe(token);
  });

  test("между запусками не меняется (иначе адрес на телефоне ломался бы)", () => {
    const { state: first } = freshState();
    // Второй AppState на том же каталоге — как перезапуск приложения.
    const second = new AppState(null);

    expect(second.remoteToken()).toBe(first.remoteToken());
  });

  test("чужой код из правленого конфига заменяется своим", () => {
    const dir = tmpDir();
    configureStorage({ configDir: dir });
    fs.writeFileSync(getConfigPath(), JSON.stringify({ port: 8710, remote_token: "короткий" }));

    const token = new AppState(null).remoteToken();

    expect(token).not.toBe("короткий");
    expect(token).toMatch(/^[a-f0-9]{32}$/);
  });

  test("сравнение принимает только точное совпадение", () => {
    const { state } = freshState();
    const token = state.remoteToken();

    expect(state.checkRemoteToken(token)).toBe(true);
    expect(state.checkRemoteToken(token.toUpperCase())).toBe(false);
    expect(state.checkRemoteToken(`${token}0`)).toBe(false);
    expect(state.checkRemoteToken("")).toBe(false);
    expect(state.checkRemoteToken(undefined)).toBe(false);
    expect(state.checkRemoteToken(null)).toBe(false);
  });

  test("ротация выдаёт новый код и сохраняет его", () => {
    const { dir, state } = freshState();
    const before = state.remoteToken();

    const rotated = state.rotateRemoteToken();

    expect(rotated).not.toBe(before);
    expect(state.remoteToken()).toBe(rotated);
    expect(state.checkRemoteToken(before)).toBe(false);
    expect(state.checkRemoteToken(rotated)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).remote_token).toBe(rotated);
  });

  test("два новых кода подряд различаются", () => {
    const { state } = freshState();
    const first = state.rotateRemoteToken();
    const second = state.rotateRemoteToken();

    expect(first).not.toBe(second);
  });

  test("импорт чужого конфига не подменяет код", () => {
    const { state } = freshState();
    const token = state.remoteToken();

    state.replaceConfig({ port: 8710, twitch: { channel: "other" }, remote_token: "чужой-код-чужой-код" });

    expect(state.remoteToken()).toBe(token);
  });

  test("код не попадает в снапшот для панели и оверлея", () => {
    const { state } = freshState();
    const snapshot = JSON.stringify(state.snapshot());

    expect(snapshot).not.toContain(state.remoteToken());
  });
});
