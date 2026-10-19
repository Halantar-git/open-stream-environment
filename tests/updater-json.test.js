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
  Проверка сборки `latest.json`.

  Ошибка в этом файле не видна локально вообще: приложение просто перестаёт
  находить обновления, и узнаётся об этом через релиз, который уже опубликован.
  Поэтому ключи платформ сверяются с тем, что ищет `tauri-plugin-updater`
  (`{os}-{arch}-{installer}`, затем `{os}-{arch}`), а не с тем, что удобно
  положить в JSON.
*/

const { buildManifest, archOf } = require("../.github/scripts/updater-json.js");

const VERSION = "4.2.1";
const BASE = `https://github.com/Halantar-git/open-stream-environment/releases/download/v${VERSION}`;

// Имена — как их отдаёт `tauri build` в этом релизе.
const ASSETS = [
  "Open.Stream.Environment-4.2.1-1.x86_64.rpm",
  "Open.Stream.Environment_4.2.1_aarch64.dmg",
  "Open.Stream.Environment_4.2.1_amd64.AppImage",
  "Open.Stream.Environment_4.2.1_amd64.deb",
  "Open.Stream.Environment_4.2.1_x64-setup.exe",
  "Open.Stream.Environment_4.2.1_x64_en-US.msi",
  "Open.Stream.Environment_aarch64.app.tar.gz",
].map((name) => ({ name, browser_download_url: `${BASE}/${name}` }));

function signaturesFor(names) {
  const signatures = {};
  for (const name of names) signatures[`${name}.sig`] = `подпись ${name}\n`;
  return signatures;
}

const SIGNED = ASSETS.filter((asset) => !asset.name.endsWith(".dmg")).map((asset) => asset.name);

function manifest(overrides = {}) {
  return buildManifest({
    version: VERSION,
    notes: "заметки",
    pubDate: "2026-10-20T00:00:00.000Z",
    assets: ASSETS,
    signatures: signaturesFor(SIGNED),
    ...overrides,
  });
}

describe("latest.json: сборка фида", () => {
  test("ключи платформ — те, которые ищет плагин обновления", () => {
    expect(Object.keys(manifest().platforms)).toEqual([
      "darwin-aarch64",
      "darwin-aarch64-app",
      "linux-x86_64",
      "linux-x86_64-appimage",
      "linux-x86_64-deb",
      "linux-x86_64-rpm",
      "windows-x86_64",
      "windows-x86_64-msi",
      "windows-x86_64-nsis",
    ]);
  });

  test("конкретный установщик важнее общего ключа", () => {
    const { platforms } = manifest();

    // Приложение, собранное как NSIS, ищет `windows-x86_64-nsis` первым: если
    // там окажется msi, установщик перезапишет установку другим способом.
    expect(platforms["windows-x86_64-nsis"].url).toMatch(/-setup\.exe$/);
    expect(platforms["windows-x86_64-msi"].url).toMatch(/\.msi$/);
    // Общий ключ — запасной, с приоритетом msi, как у `tauri-action`.
    expect(platforms["windows-x86_64"].url).toBe(platforms["windows-x86_64-msi"].url);

    expect(platforms["linux-x86_64"].url).toMatch(/\.AppImage$/);
    expect(platforms["darwin-aarch64"].url).toMatch(/\.app\.tar\.gz$/);
  });

  test("подпись переносится байт в байт", () => {
    const { platforms } = manifest();
    expect(platforms["windows-x86_64-nsis"].signature).toBe("подпись Open.Stream.Environment_4.2.1_x64-setup.exe\n");
  });

  test("версия, заметки и дата попадают в файл", () => {
    const feed = manifest();
    expect(feed.version).toBe(VERSION);
    expect(feed.notes).toBe("заметки");
    expect(feed.pub_date).toBe("2026-10-20T00:00:00.000Z");
  });

  test("подписи не для обновления (dmg) пропускаются", () => {
    const { platforms } = manifest({
      signatures: signaturesFor([...SIGNED, "Open.Stream.Environment_4.2.1_aarch64.dmg"]),
    });
    expect(Object.keys(platforms).some((key) => key.startsWith("darwin-aarch64"))).toBe(true);
  });

  test("без платформы релиз не собирается", () => {
    // Молча уехавший фид без macOS означал бы «обновлений нет» у всех на этой ОС.
    const withoutDarwin = SIGNED.filter((name) => !name.includes("app.tar.gz"));
    expect(() => manifest({ signatures: signaturesFor(withoutDarwin) })).toThrow(/darwin/);
  });

  test("пустая подпись — ошибка, а не пустая строка в фиде", () => {
    const signatures = signaturesFor(SIGNED);
    signatures[`${SIGNED[0]}.sig`] = "  \n";
    expect(() => manifest({ signatures })).toThrow(/пустая подпись/);
  });

  test("подпись без установщика в релизе — ошибка", () => {
    const signatures = signaturesFor(SIGNED);
    signatures["Open.Stream.Environment_9.9.9_x64-setup.exe.sig"] = "подпись\n";
    expect(() => manifest({ signatures })).toThrow(/нет ассета/);
  });

  test("ссылки ведут на скачивание ассета, а не в API", () => {
    // Плагин обновления качает файл сам, без заголовков авторизации: ссылка на
    // `api.github.com/repos/.../assets/{id}` вернула бы анонимному клиенту 404,
    // поэтому в фид попадает только `browser_download_url`.
    const { platforms } = manifest();
    for (const [key, value] of Object.entries(platforms)) {
      expect({ key, download: value.url.startsWith(`${BASE}/`) }).toEqual({ key, download: true });
    }
  });

  test("архитектура читается из имени на каждой ОС", () => {
    expect(archOf("App_4.2.1_amd64.deb", "linux")).toBe("x86_64");
    expect(archOf("App-4.2.1-1.x86_64.rpm", "linux")).toBe("x86_64");
    expect(archOf("App_4.2.1_x64-setup.exe", "windows")).toBe("x86_64");
    expect(archOf("App_aarch64.app.tar.gz", "darwin")).toBe("aarch64");
    expect(archOf("App_4.2.1_universal.dmg", "darwin")).toBe("universal");
  });
});
