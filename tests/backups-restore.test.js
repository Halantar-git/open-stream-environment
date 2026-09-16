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
  Ручной откат к резервной копии: список слотов, восстановление БД и настроек.

  Сценарий, ради которого это делалось: «я сломал раскладку вчера вечером,
  верните как было». Автоматическое восстановление тут не спасает — файл цел,
  порчи нет, портил его сам пользователь.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const { configureStorage, getConfigPath, getDbPath } = require("../server/storage-paths");
const { atomicWriteFileSync, backupPath } = require("../server/atomic-write");
const { createDatabase } = require("../server/db");
const { AppState } = require("../server/state");
const { createServer } = require("../server");
const { describeBackups } = require("../server/data-integrity");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ose-restore-"));
}

describe("резервные копии: описание слотов", () => {
  test("пустой каталог — пустой список", () => {
    const dir = tmpDir();
    expect(describeBackups(path.join(dir, "config.json"), 3)).toEqual([]);
  });

  test("слоты описываются по порядку, битый помечается", () => {
    const dir = tmpDir();
    const file = path.join(dir, "config.json");
    atomicWriteFileSync(backupPath(file, 0), JSON.stringify({ port: 8710 }));
    atomicWriteFileSync(backupPath(file, 1), "{ это не json");
    atomicWriteFileSync(backupPath(file, 2), JSON.stringify({ port: 8711 }));

    const slots = describeBackups(file, 3);

    expect(slots.map((slot) => slot.slot)).toEqual([0, 1, 2]);
    expect(slots.map((slot) => slot.valid)).toEqual([true, false, true]);
    expect(slots.map((slot) => slot.name)).toEqual(["config.json.bak.0", "config.json.bak.1", "config.json.bak.2"]);
    expect(slots[0].bytes).toBeGreaterThan(0);
    expect(slots[0].mtime).toBeGreaterThan(0);
    expect(slots[1].error).toBeTruthy();
  });

  test("пропущенный слот не сдвигает нумерацию остальных", () => {
    const dir = tmpDir();
    const file = path.join(dir, "local-db.json");
    atomicWriteFileSync(backupPath(file, 2), JSON.stringify({ overlay: { widgets: [] } }));

    const slots = describeBackups(file, 3);

    expect(slots).toHaveLength(1);
    expect(slots[0].slot).toBe(2);
    expect(slots[0].valid).toBe(true);
  });
});

describe("резервные копии: откат БД", () => {
  let dir;
  let dbPath;
  let db;

  beforeEach(() => {
    dir = tmpDir();
    configureStorage({ configDir: dir });
    dbPath = path.join(dir, "local-db.json");
    db = createDatabase(dbPath);
  });

  test("listBackups возвращает слоты рабочей БД", () => {
    expect(Array.isArray(db.listBackups())).toBe(true);
  });

  test("откат возвращает раскладку из копии", async () => {
    atomicWriteFileSync(
      backupPath(dbPath, 0),
      JSON.stringify({ overlay: { widgets: [{ id: "w-old", type: "chat" }] }, sessions: [{ id: "s-old" }] })
    );

    const result = db.restoreFromBackup(0);

    expect(result.ok).toBe(true);
    expect(db.getWidgets().map((widget) => widget.id)).toEqual(["w-old"]);
    expect(db.getSessions().map((session) => session.id)).toEqual(["s-old"]);
    await db.flush();
  });

  test("откат несуществующего слота — честная ошибка", () => {
    const result = db.restoreFromBackup(5);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("откат пишет восстановленное состояние на диск", async () => {
    atomicWriteFileSync(backupPath(dbPath, 0), JSON.stringify({ overlay: { widgets: [{ id: "w-restored" }] } }));

    db.restoreFromBackup(0);
    await db.flush();

    const onDisk = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    expect(onDisk.overlay.widgets.map((widget) => widget.id)).toEqual(["w-restored"]);
  });
});

describe("резервные копии: откат настроек", () => {
  test("listConfigBackups и restoreConfigFromBackup отдают конфиг из копии", () => {
    const dir = tmpDir();
    configureStorage({ configDir: dir });
    const configPath = getConfigPath();
    atomicWriteFileSync(backupPath(configPath, 0), JSON.stringify({ port: 9001, twitch: { channel: "from_backup" } }));

    const state = new AppState(null);

    expect(state.listConfigBackups().map((slot) => slot.slot)).toEqual([0]);

    const result = state.restoreConfigFromBackup(0);
    expect(result.ok).toBe(true);
    expect(result.config.twitch.channel).toBe("from_backup");
    expect(result.config.port).toBe(9001);
  });

  test("битый слот не восстанавливается", () => {
    const dir = tmpDir();
    configureStorage({ configDir: dir });
    atomicWriteFileSync(backupPath(getConfigPath(), 1), "мусор");

    const state = new AppState(null);
    const result = state.restoreConfigFromBackup(1);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("резервные копии: сквозной путь через сервер", () => {
  let dir;
  let db;
  let handle;

  beforeAll(async () => {
    dir = tmpDir();
    configureStorage({ configDir: dir });
    db = createDatabase(getDbPath());
    await db.flush();
    handle = createServer({ db, appName: "OSE Test", version: "9.9.9" });
    await new Promise((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise((resolve) => handle.server.close(resolve));
    handle.perfMonitor.stop();
    handle.longRun.stop();
    await db.flush();
  });

  test("listBackups собирает копии конфига и базы", () => {
    atomicWriteFileSync(backupPath(getConfigPath(), 0), JSON.stringify({ port: 8710 }));
    atomicWriteFileSync(backupPath(getDbPath(), 0), JSON.stringify({ overlay: { widgets: [] } }));

    const list = handle.listBackups();

    expect(list.config.map((slot) => slot.slot)).toEqual([0]);
    expect(list.database.map((slot) => slot.slot)).toEqual([0]);
  });

  test("restoreBackup('database') перечитывает раскладку в состояние", () => {
    atomicWriteFileSync(backupPath(getDbPath(), 1), JSON.stringify({ overlay: { widgets: [{ id: "w1", type: "chat" }] } }));

    const result = handle.restoreBackup("database", 1);

    expect(result).toEqual({ ok: true, slot: 1, target: "database" });
    expect(handle.state.layout.map((widget) => widget.id)).toEqual(["w1"]);
  });

  test("restoreBackup('config') применяет настройки из копии", () => {
    // В копии нет канала и Twitch выключен: восстановление не должно поднимать
    // реальные подключения (иначе тест лезет в сеть).
    atomicWriteFileSync(
      backupPath(getConfigPath(), 1),
      JSON.stringify({
        port: 8710,
        notificationVolume: 0.42,
        twitch: { channel: "", enabled: false },
        appearance: { customThemes: [] },
      })
    );

    const result = handle.restoreBackup("config", 1);

    expect(result.ok).toBe(true);
    expect(handle.state.config.notificationVolume).toBe(0.42);
    expect(handle.state.config.twitch.enabled).toBe(false);
    expect(handle.state.config.twitch.channel).toBe("");
  });

  test("неизвестная цель и плохой номер — отказ, а не исключение", () => {
    expect(handle.restoreBackup("nope", 0).ok).toBe(false);
    expect(handle.restoreBackup("database", -1).ok).toBe(false);
    expect(handle.restoreBackup("config", 99).ok).toBe(false);
  });

  test("health отдаёт данные долгого прогона", () => {
    const health = handle.healthReport();

    expect(health.longrun).toBeTruthy();
    expect(health.longrun.samples).toBeGreaterThanOrEqual(1);
    expect(health.longrun.reconnects).toEqual(expect.any(Object));
    expect(Array.isArray(health.longrun.history)).toBe(false); // в /healthz истории нет
  });
});
