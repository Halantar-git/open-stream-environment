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
  Отчёт для поддержки. Главное, что здесь проверяется, — секреты: файл уходит
  человеку на другом конце, и токен в нём — это утечка. Второе по важности:
  отчёт должен содержать то, по чему разбирают проблему (телеметрия записи,
  следы восстановления, карантин, хвост лога).
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildSupportBundle,
  renderSupportBundle,
  summarizeConfig,
  summarizeLayout,
  sanitize,
  maskText,
  tailFile,
} = require("../server/support-bundle");

const SECRETS = {
  twitchSecret: "twitch-secret-VALUE",
  twitchToken: "twitch-token-VALUE",
  obsPassword: "obs-password-VALUE",
  daToken: "da-token-VALUE",
  encoded: "enc:SGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldA==",
};

function configWithSecrets() {
  return {
    port: 8710,
    language: "ru",
    twitch: {
      channel: "halantar",
      clientId: "public-client-id",
      clientSecret: SECRETS.twitchSecret,
      userAccessToken: SECRETS.twitchToken,
      refreshToken: SECRETS.encoded,
      broadcasterId: "12345",
    },
    donationAlerts: { clientId: "da-client", clientSecret: SECRETS.twitchSecret, accessToken: SECRETS.daToken, userId: "u1" },
    youtube: { clientId: "yt-client", clientSecret: "", accessToken: "", videoId: "v1" },
    obs: { enabled: true, host: "127.0.0.1", port: 4455, password: SECRETS.obsPassword, sceneMap: { main: "Scene" }, cameraAngles: [{}, {}] },
    goal: { title: "Донат", target: 10000, currency: "RUB" },
    soundboard: { enabled: true, volume: 0.8, sounds: [{}, {}] },
    streamdeck: { icons: { scene: "a.png", soundboard: "" } },
    appearance: { activeThemeId: "nebula", enable3d: false, customThemes: [{ name: "Моя тема" }] },
    editor: { gridSize: 5, snapEnabled: true, aspectRatio: "16:9" },
    chatBot: { enabled: true, prefix: "!", commands: [{}, {}], timers: [{}], moderation: { enabled: true } },
    poll: { command: "!poll", chartType: "bars", options: [{}, {}] },
    scenes: { start: {}, brb: {} },
    hud_edit_hotkey: "Control+Shift+H",
    chatHud: { enabled: false, width: 360, height: 560 },
    twitchRewards: [{}, {}],
    splash: { file: "splash.png", duration: 3000 },
    topDonation: { user: "viewer", amount: 500, currency: "RUB" },
  };
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildInTempDir() {
  const dataDir = tmpDir("ose-bundle-data-");
  const logsDir = tmpDir("ose-bundle-logs-");
  const now = new Date(2026, 8, 15, 20, 30, 0);

  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ secret: SECRETS.twitchSecret }));
  fs.writeFileSync(path.join(dataDir, "config.json.bak.0"), JSON.stringify({ port: 8710 }));
  fs.writeFileSync(path.join(dataDir, "local-db.json.bak.1"), JSON.stringify({ overlay: { widgets: [] } }));
  fs.writeFileSync(path.join(dataDir, "config.json.corrupt-20260915-101010"), "битый json");
  fs.writeFileSync(path.join(logsDir, "ose-2026-09-15.log"), `[info] старт\n[debug] token=${SECRETS.encoded}\n[info] готово`);
  fs.writeFileSync(path.join(logsDir, "crash-2026-09-15T10-10-10-1-uncaught.log"), "TypeError: boom\n  at main.js:1");
  fs.writeFileSync(path.join(logsDir, "recovery-2026-09-15.log"), "local-db.json восстановлен");

  const bundle = buildSupportBundle({
    now,
    appName: "Open Stream Environment",
    version: "3.1.0",
    configDir: dataDir,
    logsDir,
    remoteUrl: "http://192.168.1.10:8710/remote",
    config: configWithSecrets(),
    layout: [{ id: "w1", type: "chat" }, { id: "w2", type: "goal", visible: false }],
    health: { ok: true, problems: [], uptimeSec: 10, port: 8710, server: { clients: 1, byRole: { overlay: 1 } }, integrations: {}, storage: {}, perf: { max: 1 } },
    writes: { database: { total: { writes: 5, bytes: 100, coalesced: 2, failed: 0, backups: 1 } } },
    longrun: {
      uptimeSec: 7200,
      everyMs: 600000,
      samples: 2,
      rssMb: 140,
      peakRssMb: 160,
      heapUsedMb: 70,
      wsClients: 2,
      reconnects: { twitchChat: 3 },
      reconnectsTotal: 3,
      growthMbPerHour: 12.5,
      lagMaxMs: 8,
      history: [
        { at: 1000, uptimeSec: 0, rssMb: 120, heapUsedMb: 60, wsClients: 1, reconnects: {}, lagMaxMs: 2 },
        { at: 3601000, uptimeSec: 3600, rssMb: 140, heapUsedMb: 70, wsClients: 2, reconnects: { twitchChat: 3 }, lagMaxMs: 8 },
      ],
    },
    recoveryEvents: [{ kind: "restored-from-backup", file: path.join(dataDir, "config.json"), reason: "Unexpected token", quarantinePath: path.join(dataDir, "config.json.corrupt-20260915-101010"), backupPath: path.join(dataDir, "config.json.bak.0") }],
  });

  return { bundle, text: renderSupportBundle(bundle), dataDir, logsDir };
}

describe("support-bundle: секреты", () => {
  test("сводка настроек не содержит значений секретов", () => {
    const summary = JSON.stringify(summarizeConfig(configWithSecrets()));

    expect(summary).not.toContain(SECRETS.twitchSecret);
    expect(summary).not.toContain(SECRETS.twitchToken);
    expect(summary).not.toContain(SECRETS.obsPassword);
    expect(summary).not.toContain(SECRETS.daToken);
    expect(summary).not.toContain("enc:");
  });

  test("сводка настроек показывает, какие поля заполнены", () => {
    const summary = summarizeConfig(configWithSecrets());

    expect(summary.filledFields).toContain("twitch.clientSecret");
    expect(summary.filledFields).toContain("obs.password");
    expect(summary.twitch.hasClientId).toBe(true);
    expect(summary.obs.password).toBeUndefined();
    expect(JSON.stringify(summary.filledFields)).not.toContain(SECRETS.twitchSecret);
  });

  test("sanitize вырезает значения по имени ключа и маскирует enc:", () => {
    const cleaned = sanitize({
      twitch: { clientSecret: SECRETS.twitchSecret, channel: "halantar" },
      nested: [{ accessToken: SECRETS.daToken }],
      value: SECRETS.encoded,
      note: `Bearer abcdef1234567890`,
    });

    expect(cleaned.twitch.clientSecret).toBe("<скрыто>");
    expect(cleaned.twitch.channel).toBe("halantar");
    expect(cleaned.nested[0].accessToken).toBe("<скрыто>");
    expect(cleaned.value).toBe("enc:<скрыто>");
    expect(cleaned.note).toContain("<скрыто>");
  });

  test("maskText прячет домашний каталог", () => {
    const masked = maskText(path.join(os.homedir(), "AppData", "ose", "config.json"));

    expect(masked).not.toContain(os.homedir());
    expect(masked).toContain("~");
  });

  test("готовый отчёт не содержит ни одного секрета (включая лог)", () => {
    const { text } = buildInTempDir();

    Object.values(SECRETS).forEach((secret) => {
      expect(text).not.toContain(secret);
    });
    expect(text).not.toContain(os.homedir());
    // Значение в логе маскируется, а имя параметра остаётся читаемым.
    expect(text).toContain("token=enc:<скрыто>");
    expect(text).not.toContain("SGVsbG8");
    // Ключи секретов в отчёте всё же видны — по ним понятно, что поле заполнено.
    expect(text).toContain("twitch.clientSecret");
  });
});

describe("support-bundle: содержимое", () => {
  test("отчёт собран из всех нужных разделов", () => {
    const { text } = buildInTempDir();

    expect(text.startsWith("\uFEFF")).toBe(true); // BOM: Windows-блокнот иначе покажет кракозябры
    [
      "== Приложение ==",
      "== Состояние ==",
      "== Хранилище ==",
      "== Долгий прогон ==",
      "== Целостность ==",
      "== Отчёты о падениях ==",
      "== Файлы данных ==",
      "== Настройки (без секретов) ==",
      "== Раскладка ==",
      "== Лог",
    ].forEach((header) => {
      expect(text).toContain(header);
    });
  });

  test("видны бэкапы, карантин и следы восстановления", () => {
    const { bundle, text } = buildInTempDir();

    expect(bundle.integrity.backups.map((f) => f.name)).toEqual(["config.json.bak.0", "local-db.json.bak.1"]);
    expect(bundle.integrity.quarantined.map((f) => f.name)).toEqual(["config.json.corrupt-20260915-101010"]);
    expect(bundle.integrity.recoveryEvents).toHaveLength(1);
    expect(text).toContain("config.json.bak.0");
    expect(text).toContain("config.json.corrupt-20260915-101010");
    expect(text).toContain("restored-from-backup");
  });

  test("в отчёт попал хвост сегодняшнего лога и свежий отчёт о падении", () => {
    const { bundle, text } = buildInTempDir();

    expect(bundle.log.totalLines).toBe(3);
    expect(bundle.log.text).toContain("готово");
    expect(bundle.newestCrashReport.text).toContain("TypeError: boom");
    expect(text).toContain("TypeError: boom");
    expect(bundle.crashReports.map((f) => f.name)).toEqual(["crash-2026-09-15T10-10-10-1-uncaught.log"]);
  });

  test("долгий прогон попадает в отчёт вместе с историей образцов", () => {
    const { bundle, text } = buildInTempDir();

    expect(bundle.longrun.samples).toBe(2);
    expect(bundle.longrun.history).toHaveLength(2);
    expect(text).toContain("Рост памяти");
    expect(text).toContain("12.5 MB/ч");
    expect(text).toContain("Переподключения");
    // Таблица образцов: время, наработка, память, клиенты, переподключения, лаг.
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z, [\d.]+, 120, 60, 1, 0, 2/);
  });

  test("раскладка сворачивается в счётчики по типам", () => {
    const { bundle } = buildInTempDir();

    expect(bundle.layout).toEqual({ widgets: 2, byType: { chat: 1, goal: 1 }, hidden: 1 });
    expect(summarizeLayout(null)).toEqual({ widgets: 0, byType: {}, hidden: 0 });
  });

  test("пустые каталоги не ломают сборку", () => {
    const dataDir = tmpDir("ose-bundle-empty-");
    const bundle = buildSupportBundle({ configDir: dataDir, logsDir: path.join(dataDir, "нет-такого"), config: {} });
    const text = renderSupportBundle(bundle);

    expect(bundle.dataFiles).toEqual([]);
    expect(bundle.crashReports).toEqual([]);
    expect(bundle.newestCrashReport).toBeNull();
    expect(text).toContain("Бэкапы:      нет");
    expect(text).toContain("нет файла");
  });
});

describe("support-bundle: вспомогательное", () => {
  test("tailFile отдаёт хвост и признак обрезки", () => {
    const dir = tmpDir("ose-bundle-tail-");
    const file = path.join(dir, "log.txt");
    fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => `строка ${i}`).join("\n"));

    const tail = tailFile(file, 100);
    expect(tail.totalLines).toBe(500);
    expect(tail.truncated).toBe(true);
    expect(tail.text.split("\n")).toHaveLength(100);
    expect(tail.text).toContain("строка 499");
    expect(tail.text).not.toContain("строка 0\n");
  });

  test("tailFile без файла возвращает ошибку, а не падает", () => {
    const result = tailFile(path.join(tmpDir("ose-bundle-none-"), "нет.log"));
    expect(result.error).toBe("нет файла");
    expect(result.text).toBeUndefined();
    expect(tailFile(null).error).toBe("нет файла");
  });

  test("sanitize не уходит в бесконечность на глубокой вложенности", () => {
    let deep = "конец";
    for (let i = 0; i < 40; i++) deep = { next: deep };
    const cleaned = sanitize(deep, 0);
    expect(JSON.stringify(cleaned)).toContain("слишком глубоко");
  });
});
