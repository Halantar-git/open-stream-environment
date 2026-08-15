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

// Папка, где лежит шаблон config.example.json. Она читается из исходников
// или из asar-архива собранного приложения — писать туда нельзя, поэтому
// она используется только для чтения шаблона на первом запуске.
const BUNDLED_CONFIG_DIR = path.join(__dirname, "..", "config");

// Куда записывать config.json и local-db.json. По умолчанию — рядом с
// шаблоном (режим `npm run server:only` и dev). В собранном Electron
// приложении main.js переопределяет её на userData / portable-каталог,
// потому что внутрь asar писать невозможно.
let configDir = BUNDLED_CONFIG_DIR;

function configureStorage({ configDir: dir } = {}) {
  if (dir) configDir = dir;
  return configDir;
}

function getConfigDir() {
  return configDir;
}

function getConfigPath() {
  return path.join(configDir, "config.json");
}

function getDbPath() {
  return path.join(configDir, "local-db.json");
}

function getExamplePath() {
  return path.join(BUNDLED_CONFIG_DIR, "config.example.json");
}

// Каталог, куда пользователь добавляет свои аудио/картинки для Soundboard.
// Лежит рядом с config.json (userData / portable / dev config), поэтому в
// собранном приложении в него можно писать, в отличие от app.asar.
function getUserMediaDir() {
  return path.join(configDir, "media");
}

module.exports = {
  BUNDLED_CONFIG_DIR,
  configureStorage,
  getConfigDir,
  getConfigPath,
  getDbPath,
  getExamplePath,
  getUserMediaDir,
};
