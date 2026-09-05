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
const os = require("os");
const path = require("path");

const { configureStorage, getUserMediaDir } = require("../server/storage-paths");
const { cleanupOrphanedMedia, collectMediaForExport, importMedia } = require("../server/media");

describe("server/media", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ose-media-"));
    configureStorage({ configDir: tmp });
    fs.mkdirSync(getUserMediaDir(), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("cleanupOrphanedMedia удаляет неиспользуемые файлы и сохраняет используемые", () => {
    fs.writeFileSync(path.join(getUserMediaDir(), "keep.mp3"), "x");
    fs.writeFileSync(path.join(getUserMediaDir(), "keep.png"), "z");
    fs.writeFileSync(path.join(getUserMediaDir(), "drop.mp3"), "y");

    const config = {
      soundboard: { sounds: [{ audioFile: "media/keep.mp3", imageFile: "media/keep.png" }] },
      streamdeck: { icons: {} },
    };

    const result = cleanupOrphanedMedia(config, []);

    expect(result.removed).toBe(1);
    expect(result.removedNames).toEqual(["drop.mp3"]);
    expect(fs.existsSync(path.join(getUserMediaDir(), "keep.mp3"))).toBe(true);
    expect(fs.existsSync(path.join(getUserMediaDir(), "drop.mp3"))).toBe(false);
  });

  test("cleanupOrphanedMedia сохраняет видео-заставки сцен", () => {
    fs.writeFileSync(path.join(getUserMediaDir(), "intro.mp4"), "i");
    fs.writeFileSync(path.join(getUserMediaDir(), "outro.mp4"), "o");
    fs.writeFileSync(path.join(getUserMediaDir(), "drop.mp3"), "d");

    const config = {
      soundboard: { sounds: [] },
      streamdeck: { icons: {} },
      scenes: {
        start: { splashFile: "media/intro.mp4" },
        end: { splashFile: "media/outro.mp4" },
      },
    };

    const result = cleanupOrphanedMedia(config, []);

    expect(result.removed).toBe(1);
    expect(result.removedNames).toEqual(["drop.mp3"]);
    expect(fs.existsSync(path.join(getUserMediaDir(), "intro.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(getUserMediaDir(), "outro.mp4"))).toBe(true);
  });

  test("collectMediaForExport/importMedia делает round-trip", () => {
    fs.writeFileSync(path.join(getUserMediaDir(), "a.mp3"), Buffer.from([1, 2, 3, 4]));

    const manifest = collectMediaForExport();
    expect(manifest["media/a.mp3"]).toBeDefined();

    fs.rmSync(getUserMediaDir(), { recursive: true, force: true });
    const res = importMedia(manifest);

    expect(res.imported).toBe(1);
    expect(fs.readFileSync(path.join(getUserMediaDir(), "a.mp3"))).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("importMedia не даёт выйти за пределы каталога media", () => {
    const res = importMedia({ "../../evil.txt": Buffer.from("x").toString("base64") });

    expect(res.imported).toBe(1);
    expect(fs.existsSync(path.join(getUserMediaDir(), "evil.txt"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "evil.txt"))).toBe(false);
  });
});
