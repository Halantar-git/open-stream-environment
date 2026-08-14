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

// Шифрование секретов через Electron safeStorage (DPAPI/Keychain/libsecret).
// В режиме `npm run server:only` Electron API недоступен — фолбэк на plaintext.
let safeStorage = null;
try {
  ({ safeStorage } = require("electron"));
} catch {
  // Electron API недоступен
}

function available() {
  return !!(safeStorage && safeStorage.isEncryptionAvailable());
}

function seal(value) {
  if (value === undefined || value === null || value === "") return value;
  if (!available()) return value;
  return "enc:" + safeStorage.encryptString(String(value)).toString("base64");
}

function open(value) {
  if (typeof value !== "string" || !value.startsWith("enc:")) return value;
  if (!available()) return value;
  return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
}

module.exports = { available, seal, open };
