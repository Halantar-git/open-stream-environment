/*
 * Пересборка приложения «полный список идентификаторов» в docs/api.md.
 *
 * Идентификаторы кадров живут в shared/events.js, а в документации — таблица
 * для чтения. Копировать 180 строк руками нельзя: одна забытая команда — и
 * документация врёт. Скрипт снимает блок EVENT_TYPES и заменяет содержимое
 * между маркерами API_EVENTS_START / API_EVENTS_END.
 *
 * Режимы:
 *   node src-tauri/tools/build-api-events.mjs          — переписать docs/api.md
 *   node src-tauri/tools/build-api-events.mjs --check  — только проверить
 *
 * `--check` возвращает код 1, если документация отстала: так это ловит
 * tests/api-docs.test.js.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVENTS_FILE = path.join(ROOT, "shared", "events.js");
const DOC_FILE = path.join(ROOT, "docs", "api.md");
const START = "<!-- API_EVENTS_START -->";
const END = "<!-- API_EVENTS_END -->";

function rows(source) {
  const block = source.slice(
    source.indexOf("const EVENT_TYPES"),
    source.indexOf("const CONNECTION_SERVICES"),
  );
  // Только пробелы внутри строки: `\s*` захватывает перевод строки и склеивает
  // с комментарием следующей константы.
  const pattern = /^[ \t]{4}([A-Z0-9_]+):[ \t]*"([^"]+)",[ \t]*(?:\/\/[ \t]*(.*))?$/gm;
  const out = [];
  let match;
  while ((match = pattern.exec(block))) {
    out.push({ key: match[1], value: match[2], comment: (match[3] || "").trim() });
  }
  return out;
}

function escapeCell(text) {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function table(title, entries) {
  const lines = [`### ${title}`, "", "| Ключ | `type` | Payload |", "|---|---|---|"];
  entries.forEach((entry) => {
    lines.push(`| \`${entry.key}\` | \`${entry.value}\` | ${escapeCell(entry.comment)} |`);
  });
  return lines.join("\n");
}

export function render(source) {
  const all = rows(source);
  if (!all.length) throw new Error("в shared/events.js не найден EVENT_TYPES");
  const events = all.filter((entry) => !entry.key.startsWith("CMD_") && !entry.key.startsWith("EXEC_"));
  const commands = all.filter((entry) => entry.key.startsWith("CMD_") || entry.key.startsWith("EXEC_"));
  return [table("События (сервер ↔ клиент)", events), "", table("Команды и служебные сообщения", commands)].join("\n");
}

function replace(doc, block) {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error("в docs/api.md нет маркеров API_EVENTS_START / API_EVENTS_END");
  }
  return `${doc.slice(0, start + START.length)}\n${block}\n${doc.slice(end)}`;
}

const source = fs.readFileSync(EVENTS_FILE, "utf8");
const rawDoc = fs.readFileSync(DOC_FILE, "utf8");
// Файл могли открыть и сохранить с CRLF: сравниваем и собираем в LF, а при
// записи возвращаем тот же перевод строки, что был у файла.
const eol = rawDoc.includes("\r\n") ? "\r\n" : "\n";
const doc = rawDoc.replace(/\r\n/g, "\n");
const updated = replace(doc, render(source));

if (process.argv.includes("--check")) {
  if (updated !== doc) {
    console.error("docs/api.md: таблица кадров отстала от shared/events.js");
    console.error("Пересоберите: node src-tauri/tools/build-api-events.mjs");
    process.exit(1);
  }
  console.log("docs/api.md: таблица кадров актуальна");
} else {
  fs.writeFileSync(DOC_FILE, updated.replace(/\n/g, eol));
  console.log("docs/api.md: таблица кадров обновлена");
}
