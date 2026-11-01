#!/usr/bin/env node

/*
  Собрать пакет в zip для установки из панели («Настройки → Пакеты»).

  Архив — обычный zip без внешних зависимостей: пакет собирается из папки, а
  в него не попадают служебные файлы Finder и Windows, `node_modules` и `.git`.
  Манифест кладётся в корень, поэтому архив принимается и плоским, и вместе с
  одноимённой папкой.

  Использование:
    npx ose-plugin pack <папка пакета> [--out <файл>]
    node sdk/pack.mjs <папка пакета> [--out <файл>]   — в репозитории OSE

  Код возврата 1 — пакет не прошёл проверку или архив не собрался.
*/

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { validatePackage } from "./validate.mjs";

// Мусор, который не должен уезжать в архив: зависимости, служебные каталоги
// системы контроля версий и файлы Finder/Windows.
const SKIP = new Set(["node_modules", ".git", ".svn", "__MACOSX"]);

const USAGE = [
  "Использование: ose-plugin pack <папка пакета> [--out <файл>]",
  "  --out <файл>  — куда положить архив (по умолчанию <id>.zip в текущем каталоге)",
].join("\n");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Файлы пакета: относительные пути с «/» — так их понимает приложение. */
function collect(dir, base = "", out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const name = entry.name;
    if (SKIP.has(name) || name === ".DS_Store" || name === "Thumbs.db" || name.startsWith("._")) continue;
    const full = path.join(dir, name);
    const relative = base ? `${base}/${name}` : name;
    if (entry.isDirectory()) collect(full, relative, out);
    else if (entry.isFile()) out.push({ relative, full });
  }
  return out;
}

/*
  Минимальный zip: локальные заголовки, центральный каталог и конец каталога.
  Deflate берётся только когда он правда уменьшает файл — иначе файл кладётся
  как есть, и архив читается любым распаковщиком.
*/
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const data = fs.readFileSync(file.full);
    const deflated = zlib.deflateRawSync(data);
    const packed = deflated.length < data.length;
    const body = packed ? deflated : data;
    const name = Buffer.from(file.relative, "utf8");
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(packed ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(packed ? 8 : 0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + body.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, ...central, end]);
}

function fail(message) {
  console.error(`[OSE] ${message}`);
  process.exitCode = 1;
}

export function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const options = { target: "", out: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail("у --out нет значения");
        return;
      }
      options.out = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      fail(`неизвестный параметр: ${arg}`);
      return;
    } else if (!options.target) {
      options.target = arg;
    } else {
      fail("нужна одна папка пакета");
      return;
    }
  }
  if (!options.target) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const folder = path.resolve(options.target);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    fail(`нет папки пакета: ${options.target}`);
    return;
  }
  // Архив с ошибкой в манифесте приложение всё равно отвергнет — лучше сказать
  // об этом сразу, а не после установки.
  const report = validatePackage(folder);
  if (report.errors.length > 0) {
    report.errors.forEach((error) => console.error(`[OSE] ошибка: ${error}`));
    process.exitCode = 1;
    return;
  }
  report.warnings.forEach((warning) => console.log(`[OSE] предупреждение: ${warning}`));

  const files = collect(folder);
  if (files.length === 0) {
    fail("в папке нет файлов");
    return;
  }
  const id = path.basename(folder);
  const out = options.out ? path.resolve(options.out) : path.join(process.cwd(), `${id}.zip`);
  const archive = zip(files);
  fs.writeFileSync(out, archive);
  console.log(`[OSE] Архив готов: ${out} (файлов: ${files.length}, ${archive.length} байт)`);
  console.log("Установка: «Настройки → Пакеты» → «Установить из ZIP».");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
