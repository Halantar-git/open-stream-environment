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

// Префикс значения, зашифрованного через safeStorage.
const SEALED_PREFIX = "enc:";

/*
  Почему сохранённый секрет оказался непригоден.

  Раньше оба случая выглядели одинаково — как пустая строка, — и разница была
  видна только в консоли. Для пользователя она существенная: «ключ не вписан»
  лечится вставкой ключа, а «ключ не читается» — тем, что ключ вставляют заново
  (сменился пользователь ОС, ключ DPAPI/Keychain, конфиг перенесён с другой
  машины).

  - unreadable — расшифровка не удалась: значение зашифровано другим ключом;
  - locked     — шифрование сейчас недоступно, поэтому прочитать зашифрованное
                 значение нечем (в том числе в `npm run server:only`).
*/
const SECRET_ISSUE = {
  UNREADABLE: "unreadable",
  LOCKED: "locked",
};

// Причины, по которым секреты оказались непригодны. Хранится здесь, чтобы
// главный процесс мог показать диалог, а панель — рассказать о состоянии
// сохранённого секрета, не выдавая самого секрета.
const issues = [];

function noteIssue(label, reason) {
  const name = String(label || "secret");
  if (issues.some((issue) => issue.label === name && issue.reason === reason)) return;
  issues.push({ label: name, reason });
}

/*
  Отметка о том, что секрет для этой метки снова записывается как обычное
  значение: значит, прошлая неудача чтения больше не актуальна (пользователь
  ввёл ключ заново, и он сохранился читаемым).
*/
function clearIssue(label) {
  const name = String(label || "secret");
  for (let i = issues.length - 1; i >= 0; i--) {
    if (issues[i].label === name) issues.splice(i, 1);
  }
}

function getSecretIssues() {
  return issues.map((issue) => ({ ...issue }));
}

function clearSecretIssues() {
  issues.length = 0;
}

// Нечитаем ли сохранённый секрет прямо сейчас. Панель по этому флагу говорит
// «вставьте ключ заново» вместо «не заполнен» — это разные действия.
function isSecretUnreadable(label) {
  const name = String(label || "secret");
  return issues.some((issue) => issue.label === name);
}

function available() {
  return !!(safeStorage && safeStorage.isEncryptionAvailable());
}

/*
  Значение лежит зашифрованным?

  Это не секрет, а его зашифрованный вид: отправлять такое в сервис нельзя — он
  ответит невнятным invalid_client («Client authentication failed»), из которого
  никак не следует, что дело в недоступном хранилище секретов.
*/
function isSealed(value) {
  return typeof value === "string" && value.startsWith(SEALED_PREFIX);
}

// Секреты сохраняются без шифрования. Не роняем приложение и не мешаем работе,
// но и не делаем вид, что всё в порядке: факт виден в журнале.
let warnedUnprotected = false;
function warnUnprotected() {
  if (warnedUnprotected) return;
  warnedUnprotected = true;
  console.warn(
    "[secret-store] системное хранилище секретов недоступно — ключи приложения сохраняются без шифрования."
  );
}

function seal(value, label) {
  if (value === undefined || value === null || value === "") return value;
  if (!available()) {
    // safeStorage недоступен в `npm run server:only` (Electron API нет) — это
    // нормальный режим, о нём не предупреждаем. Если же Electron есть, а ключ
    // системы недоступен, предупреждаем: секреты молча уходят на диск открытым
    // текстом.
    if (safeStorage) warnUnprotected();
    return value;
  }
  const sealed = SEALED_PREFIX + safeStorage.encryptString(String(value)).toString("base64");
  // Значение сохраняется читаемым — прошлая неудача чтения больше не про него.
  if (label) clearIssue(label);
  return sealed;
}

function open(value, label) {
  if (!isSealed(value)) return value;
  if (!available()) {
    // Шифрование сейчас недоступно, а значение зашифровано. Вернуть его как
    // есть (как было раньше) нельзя: это не секрет, а зашифрованный вид, и он
    // уйдёт в сервис вместо секрета. Возвращаем пустоту и фиксируем причину.
    noteIssue(label, SECRET_ISSUE.LOCKED);
    console.error(
      "[secret-store] хранилище секретов недоступно — сохранённое значение прочитать нельзя, оно сброшено. Введите ключ заново."
    );
    return "";
  }
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(SEALED_PREFIX.length), "base64"));
  } catch (err) {
    // Расшифровка может упасть, если секрет был зашифрован под другим
    // пользователем/машиной (или сменился ключ DPAPI/Keychain). Не роняем
    // приложение: сбрасываем значение и фиксируем факт сбоя для диалога.
    noteIssue(label, SECRET_ISSUE.UNREADABLE);
    console.error(
      "[secret-store] не удалось расшифровать сохранённый секрет — значение сброшено. Введите ключ заново.",
      err && err.message ? err.message : String(err)
    );
    return "";
  }
}

module.exports = {
  SEALED_PREFIX,
  SECRET_ISSUE,
  available,
  isSealed,
  seal,
  open,
  getSecretIssues,
  clearSecretIssues,
  isSecretUnreadable,
};
