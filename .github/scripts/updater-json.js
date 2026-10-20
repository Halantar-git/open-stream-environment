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
  Сборка `latest.json` — фида, по которому `tauri-plugin-updater` узнаёт о новой
  версии (`plugins.updater.endpoints` в `tauri.conf.json`).

  Раньше файл писал `tauri-action` в каждой джобе матрицы. Три процесса читали,
  удаляли и заново загружали один и тот же ассет; в 4.2.1 Linux и Windows
  закончили в одну секунду, файл остался удалённым, и релиз уехал без фида —
  обновление у всех отдавало 404, хотя релиз опубликован. Поэтому фид собирается
  здесь, одной джобой после всех сборок, из уже загруженных подписей.

  Ключи — как у плагина: сначала `{os}-{arch}-{installer}`, затем `{os}-{arch}`
  (см. `get_urls` в tauri-plugin-updater). Первый ключ важен: приложение,
  собранное как NSIS, ищет именно `windows-x86_64-nsis`, а не общий.
*/

const fs = require("fs");
const path = require("path");

// Установщики, для которых есть подпись обновления. `installer` — имя бандла в
// терминах плагина: оно попадает в ключ платформы.
const INSTALLERS = [
  { os: "windows", installer: "nsis", test: /-setup\.exe$/ },
  { os: "windows", installer: "msi", test: /\.msi$/ },
  { os: "linux", installer: "appimage", test: /\.AppImage$/ },
  { os: "linux", installer: "deb", test: /\.deb$/ },
  { os: "linux", installer: "rpm", test: /\.rpm$/ },
  { os: "darwin", installer: "app", test: /\.app\.tar\.gz$/ },
];

// Чем заполняется общий ключ `{os}-{arch}`, если приложение не спросит
// конкретный установщик: те же приоритеты, что у `tauri-action` по умолчанию.
const PRIMARY = { windows: "msi", linux: "appimage", darwin: "app" };

// Архитектура из имени файла: у Tauri на каждой ОС своя запись одной и той же
// архитектуры (`x64`, `amd64`, `x86_64`).
function archOf(name, os) {
  const lower = name.toLowerCase();
  if (lower.includes("universal")) return "universal";
  if (lower.includes("aarch64") || lower.includes("arm64")) return "aarch64";
  if (os === "linux" && lower.includes("amd64")) return "x86_64";
  if (lower.includes("x86_64") || lower.includes("x64")) return "x86_64";
  return null;
}

function sortedPlatforms(platforms) {
  const out = {};
  for (const key of Object.keys(platforms).sort()) out[key] = platforms[key];
  return out;
}

function buildManifest({ version, notes = "", pubDate = new Date().toISOString(), assets, signatures, baseUrl }) {
  if (!version) throw new Error("не передана версия");
  // Адрес ассета собирается из тега, а не из `browser_download_url`: у
  // черновика GitHub отдаёт `.../download/untagged-…`, и после публикации
  // такой адрес отвечает 404 — автообновление ломалось именно на этом.
  if (!baseUrl) throw new Error("не передан адрес релиза");
  const base = String(baseUrl).replace(/\/+$/, "");
  const known = new Set(assets.map((asset) => asset.name));
  const platforms = {};
  // Общий ключ платформы собирается отдельно: конкретные установщики важнее, и
  // приоритет решает, какой из них станет запасным для `{os}-{arch}`.
  const plain = {};
  const seen = { windows: false, linux: false, darwin: false };

  for (const [signatureName, signature] of Object.entries(signatures)) {
    if (!signature || !signature.trim()) throw new Error(`пустая подпись: ${signatureName}`);

    const assetName = signatureName.replace(/\.sig$/, "");
    const rule = INSTALLERS.find((candidate) => candidate.test.test(assetName));
    // Подписи ставятся и у бандлов, которые обновление не раздаёт (например,
    // `.dmg`): такие файлы просто пропускаем.
    if (!rule) continue;

    if (!known.has(assetName)) throw new Error(`нет ассета для подписи: ${assetName}`);

    const arch = archOf(assetName, rule.os);
    if (!arch) throw new Error(`не определить архитектуру: ${assetName}`);

    const url = `${base}/${encodeURIComponent(assetName)}`;

    const entry = { signature, url };
    platforms[`${rule.os}-${arch}-${rule.installer}`] = entry;
    seen[rule.os] = true;

    const key = `${rule.os}-${arch}`;
    const priority = rule.installer === PRIMARY[rule.os] ? 1 : 0;
    if (!plain[key] || priority > plain[key].priority) {
      plain[key] = { priority, entry };
    }
  }

  // Платформа без фида молча превратилась бы в «нет обновлений» на этой ОС,
  // поэтому релиз лучше остановить здесь.
  const missing = Object.keys(seen).filter((os) => !seen[os]);
  if (missing.length) throw new Error(`в релизе нет подписей для: ${missing.join(", ")}`);

  for (const [key, value] of Object.entries(plain)) platforms[key] = value.entry;

  return { version, notes, pub_date: pubDate, platforms: sortedPlatforms(platforms) };
}

function readSignatures(dir) {
  const signatures = {};
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".sig")) continue;
    // Подпись переносится байт в байт, как её отдаёт `tauri signer`: плагин
    // разбирает именно этот текст.
    signatures[name] = fs.readFileSync(path.join(dir, name), "utf8");
  }
  if (Object.keys(signatures).length === 0) throw new Error(`нет подписей в ${dir}`);
  return signatures;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    args[arg.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["version", "assets", "signatures", "base-url", "out"]) {
    if (!args[required]) throw new Error(`не хватает --${required}`);
  }

  const release = JSON.parse(fs.readFileSync(args.assets, "utf8").replace(/^\uFEFF/, ""));
  const manifest = buildManifest({
    version: args.version,
    notes: args.notes || "",
    pubDate: args["pub-date"],
    assets: release.assets || [],
    signatures: readSignatures(args.signatures),
    baseUrl: args["base-url"],
  });

  fs.writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`latest.json: ${manifest.version}, платформ — ${Object.keys(manifest.platforms).length}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { buildManifest, archOf, INSTALLERS };
