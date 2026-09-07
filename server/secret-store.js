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

// Список секретов, которые не удалось расшифровать при загрузке. Хранится
// здесь, чтобы главный процесс мог показать диалог и попросить ввести их заново.
const decryptFailures = [];

function available() {
  return !!(safeStorage && safeStorage.isEncryptionAvailable());
}

function seal(value) {
  if (value === undefined || value === null || value === "") return value;
  if (!available()) return value;
  return "enc:" + safeStorage.encryptString(String(value)).toString("base64");
}

function open(value, label) {
  if (typeof value !== "string" || !value.startsWith("enc:")) return value;
  if (!available()) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
  } catch (err) {
    // Расшифровка может упасть, если секрет был зашифрован под другим
    // пользователем/машиной (или сменился ключ DPAPI/Keychain). Не роняем
    // приложение: сбрасываем значение и фиксируем факт сбоя для диалога.
    decryptFailures.push(String(label || "secret"));
    console.error(
      "[secret-store] не удалось расшифровать сохранённый секрет — значение сброшено. Введите ключ заново.",
      err && err.message ? err.message : String(err)
    );
    return "";
  }
}

function getDecryptFailures() {
  return decryptFailures.slice();
}

function clearDecryptFailures() {
  decryptFailures.length = 0;
}

module.exports = { available, seal, open, getDecryptFailures, clearDecryptFailures };
