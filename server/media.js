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
const path = require("path");

const { getUserMediaDir } = require("./storage-paths");

const MEDIA_EXT_RE = /\.(mp3|wav|ogg|m4a|aac|png|jpe?g|gif|webp)$/i;
const MAX_EXPORT_FILE_BYTES = 50 * 1024 * 1024; // 50 MB на файл — крупнее не тянем в JSON.

function listMediaFiles() {
  const dir = getUserMediaDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => {
      try {
        return fs.statSync(path.join(dir, name)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  return names.map((name) => ({ name, path: path.join(dir, name) }));
}

// Рекурсивно собирает имена файлов, на которые ссылаются строки вида
// "media/foo.mp3" или одиночные имена с медиа-расширением.
function collectReferencedMedia(config, layout) {
  const refs = new Set();

  const scan = (value) => {
    if (typeof value === "string") {
      const withPrefix = value.match(/(?:^|\/)media\/([^"'\s]+)/);
      if (withPrefix) {
        refs.add(path.basename(withPrefix[1]));
      } else if (MEDIA_EXT_RE.test(value.trim())) {
        refs.add(path.basename(value.trim()));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(scan);
      return;
    }
    if (value && typeof value === "object") {
      Object.values(value).forEach(scan);
    }
  };

  scan(config && config.soundboard);
  scan(config && config.streamdeck);
  if (Array.isArray(layout)) scan(layout);
  return refs;
}

function cleanupOrphanedMedia(config, layout) {
  const refs = collectReferencedMedia(config, layout);
  const files = listMediaFiles();
  const removedNames = [];

  for (const file of files) {
    if (refs.has(file.name)) continue;
    try {
      fs.unlinkSync(file.path);
      removedNames.push(file.name);
    } catch {
      /* пропускаем файлы, которые не удалось удалить */
    }
  }

  return { removed: removedNames.length, removedNames, kept: files.length - removedNames.length };
}

// Упаковывает содержимое media/ в base64 для переносимого single-file экспорта.
function collectMediaForExport() {
  const out = {};
  for (const file of listMediaFiles()) {
    try {
      const data = fs.readFileSync(file.path);
      if (data.length > MAX_EXPORT_FILE_BYTES) continue;
      out[`media/${file.name}`] = data.toString("base64");
    } catch {
      /* пропускаем нечитаемые файлы */
    }
  }
  return out;
}

// Восстанавливает файлы из base64-манифеста (ключ "media/<name>") в media/.
function importMedia(mediaMap) {
  const dir = getUserMediaDir();
  fs.mkdirSync(dir, { recursive: true });
  let imported = 0;

  for (const [rel, b64] of Object.entries(mediaMap || {})) {
    // Базимя только на basename, чтобы исключить path traversal.
    const name = path.basename(String(rel).replace(/\\/g, "/"));
    if (!name || name === "." || name === "..") continue;
    try {
      const data = Buffer.from(String(b64), "base64");
      if (!data.length) continue;
      fs.writeFileSync(path.join(dir, name), data);
      imported++;
    } catch {
      /* пропускаем битые записи */
    }
  }

  return { imported };
}

module.exports = { listMediaFiles, collectReferencedMedia, cleanupOrphanedMedia, collectMediaForExport, importMedia };
