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
  Целостность файлов состояния: битый файл уходит в карантин (а не удаляется и
  не затирается дефолтами), данные поднимаются из бэкапа, и о происшествии
  остаётся след.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  recoverJsonFile,
  quarantineFile,
  tryReadJson,
  timestampTag,
  getRecoveryEvents,
  clearRecoveryEvents,
} = require("../server/data-integrity");
const { backupPath, atomicWriteFileSync } = require("../server/atomic-write");
const { configureStorage } = require("../server/storage-paths");
const { createDatabase } = require("../server/db");
const { AppState } = require("../server/state");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ose-integrity-"));
}

function corruptFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
}

describe("data-integrity: чтение файлов состояния", () => {
  beforeEach(() => {
    clearRecoveryEvents();
    // Журнал восстановлений пишется в каталог данных — уводим его в temp,
    // чтобы тесты не трогали config/ рабочего дерева.
    configureStorage({ configDir: tmpDir() });
  });

  test("целый файл читается как есть", () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    fs.writeFileSync(file, JSON.stringify({ ok: true }));

    const result = recoverJsonFile(file);

    expect(result.source).toBe("file");
    expect(result.value).toEqual({ ok: true });
    expect(getRecoveryEvents()).toHaveLength(0);
  });

  test("отсутствующий файл отличается от битого", () => {
    const dir = tmpDir();
    const result = recoverJsonFile(path.join(dir, "store.json"));

    expect(result.source).toBe("missing");
    expect(result.value).toBeNull();
    expect(getRecoveryEvents()).toHaveLength(0);
  });

  test("битый JSON уходит в карантин, поднимаемся из .bak.0", () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    atomicWriteFileSync(backupPath(file, 0), JSON.stringify({ good: 1 }));
    fs.writeFileSync(file, "{ это не json");

    const result = recoverJsonFile(file);

    expect(result.source).toBe("backup");
    expect(result.value).toEqual({ good: 1 });
    expect(result.backupPath).toBe(backupPath(file, 0));
    expect(fs.existsSync(file)).toBe(false); // испорченный перенесён, а не оставлен
    expect(corruptFiles(dir)).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, corruptFiles(dir)[0]), "utf8")).toBe("{ это не json");

    const events = getRecoveryEvents();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("restored-from-backup");
  });

  test("битый .bak.0 не мешает подняться из .bak.1", () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    fs.writeFileSync(backupPath(file, 0), "наполовину записанный");
    fs.writeFileSync(backupPath(file, 1), JSON.stringify({ fromSlotOne: true }));
    fs.writeFileSync(file, "мусор");

    const result = recoverJsonFile(file);

    expect(result.source).toBe("backup");
    expect(result.value).toEqual({ fromSlotOne: true });
    expect(result.backupPath).toBe(backupPath(file, 1));
  });

  test("пустой файл — тоже порча", () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    fs.writeFileSync(file, "   ");

    const result = recoverJsonFile(file, { backupSlots: 0 });

    expect(result.source).toBe("unrecoverable");
    expect(result.value).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    expect(corruptFiles(dir)).toHaveLength(1);
  });

  test("без бэкапов сообщаем, что поднимать нечего", () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    fs.writeFileSync(file, "[1,2,3]"); // валидный JSON, но не объект

    const result = recoverJsonFile(file, { backupSlots: 2 });

    expect(result.source).toBe("unrecoverable");
    const events = getRecoveryEvents();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("unrecoverable");
    expect(events[0].quarantinePath).toBeTruthy();
  });

  test("карантинные файлы не перетирают друг друга", () => {
    const dir = tmpDir();
    const file = path.join(dir, "store.json");
    fs.writeFileSync(file, "битый");

    expect(quarantineFile(file, "20260915-101010")).toBe(`${file}.corrupt-20260915-101010`);
    fs.writeFileSync(file, "снова битый");
    expect(quarantineFile(file, "20260915-111111")).toBe(`${file}.corrupt-20260915-111111`);
    expect(corruptFiles(dir)).toHaveLength(2);
  });

  test("tryReadJson возвращает признак отсутствия файла", () => {
    const dir = tmpDir();
    expect(tryReadJson(path.join(dir, "нет.json")).missing).toBe(true);
    fs.writeFileSync(path.join(dir, "есть.json"), "не json");
    expect(tryReadJson(path.join(dir, "есть.json")).missing).toBe(false);
  });

  test("timestampTag даёт метку без разделителей пути", () => {
    expect(timestampTag(new Date(2026, 8, 15, 14, 30, 12))).toBe("20260915-143012");
  });
});

describe("config: восстановление при старте", () => {
  function configFiles(dir) {
    return fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
  }

  test("битый config.json поднимается из бэкапа, повреждённый — в карантине", () => {
    const dir = tmpDir();
    configureStorage({ configDir: dir });
    clearRecoveryEvents();
    const configPath = path.join(dir, "config.json");
    atomicWriteFileSync(
      backupPath(configPath, 0),
      JSON.stringify({ port: 9999, twitch: { channel: "from_backup" }, appearance: { customThemes: [] } })
    );
    fs.writeFileSync(configPath, "{ порванный json");

    // Раньше это исключение означало «приложение не запускается вообще».
    const state = new AppState(null);

    expect(state.config.twitch.channel).toBe("from_backup");
    expect(state.config.port).toBe(9999);
    expect(getRecoveryEvents()[0].kind).toBe("restored-from-backup");
    // Восстановленное состояние сразу становится рабочим файлом.
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).twitch.channel).toBe("from_backup");
    expect(configFiles(dir)).toHaveLength(1);
  });

  test("без бэкапа берётся шаблон поставки и приложение стартует", () => {
    const dir = tmpDir();
    configureStorage({ configDir: dir });
    clearRecoveryEvents();
    fs.writeFileSync(path.join(dir, "config.json"), "не json");

    const state = new AppState(null);

    expect(state.config.port).toBe(8710); // значение из config/config.example.json
    expect(getRecoveryEvents()[0].kind).toBe("unrecoverable");
    expect(configFiles(dir)).toHaveLength(1);
  });

  test("первый запуск: конфига нет — создаётся из шаблона без событий порчи", () => {
    const dir = tmpDir();
    configureStorage({ configDir: dir });
    clearRecoveryEvents();

    const state = new AppState(null);

    expect(state.config.port).toBe(8710);
    expect(getRecoveryEvents()).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(true);
    expect(configFiles(dir)).toHaveLength(0);
  });

  test("пустой config.json — тоже порча, а не «пустой конфиг»", () => {
    const dir = tmpDir();
    configureStorage({ configDir: dir });
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, " ");

    const result = recoverJsonFile(configPath, { backupSlots: 0 });

    expect(result.source).toBe("unrecoverable");
    expect(result.quarantinePath).toBeTruthy();
  });
});

describe("db: восстановление local-db.json", () => {
  test("битая БД не превращается в пустую: поднимаемся из бэкапа", async () => {
    const dir = tmpDir();
    configureStorage({ configDir: dir });
    const dbPath = path.join(dir, "local-db.json");

    atomicWriteFileSync(
      backupPath(dbPath, 0),
      JSON.stringify({ overlay: { widgets: [{ id: "w1", type: "goal" }] }, sessions: [] })
    );
    fs.writeFileSync(dbPath, JSON.stringify({ overlay: { widgets: [] } }).slice(0, 12));

    clearRecoveryEvents();
    const db = createDatabase(dbPath);

    // Виджет из бэкапа на месте — данные не потеряны.
    expect(db.getWidgets().map((w) => w.id)).toEqual(["w1"]);
    expect(getRecoveryEvents()[0].kind).toBe("restored-from-backup");

    await db.flush();
  });

  test("данные из бэкапа становятся рабочим файлом", async () => {
    const dir = tmpDir();
    configureStorage({ configDir: dir });
    const dbPath = path.join(dir, "local-db.json");

    atomicWriteFileSync(backupPath(dbPath, 0), JSON.stringify({ overlay: { widgets: [{ id: "keep" }] }, sessions: [] }));
    fs.writeFileSync(dbPath, "не json");

    const db = createDatabase(dbPath);
    await db.flush();

    const onDisk = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    expect(onDisk.overlay.widgets.map((w) => w.id)).toEqual(["keep"]);
  });
});
