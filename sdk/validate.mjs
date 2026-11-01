#!/usr/bin/env node

/*
  Проверка пакета виджета или темы до установки.

  Правила повторяют src-tauri/src/plugins.rs: приложение читает манифесты при
  старте и отвергает пакет, который их не проходит. Ошибку лучше увидеть здесь,
  чем после перезапуска — с сообщением в терминале и пустой карточкой.

  Использование:
    node sdk/validate.mjs <папка пакета | каталог пакетов> [--json]

  Каталог без манифеста считается каталогом пакетов (как config/plugins):
  проверяются все подпапки. Код возврата 1 — есть ошибки.
*/

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Версия API пакетов; должна совпадать с `API_VERSION` в plugins.rs. */
export const API_VERSION = 1;
/** Типы настроек, которые умеет рисовать инспектор. */
export const SETTING_TYPES = ["string", "text", "number", "range", "color", "boolean", "select"];

const WIDGET_FILE = "widget.json";
const THEME_FILE = "theme.json";
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function validId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 64 && ID_PATTERN.test(id) && !id.includes("..");
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/*
  Безопасный относительный путь внутри пакета — как `safe_relative` в Rust:
  без корней, диска, «.», «..» и пустых сегментов.
*/
function safeRelative(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  if (path.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return null;
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function existingFile(packageDir, raw) {
  const relative = safeRelative(raw);
  if (!relative) return null;
  try {
    return fs.statSync(path.join(packageDir, relative)).isFile() ? relative : null;
  } catch (_) {
    return null;
  }
}

function checkFile(packageDir, raw, extension, field, errors) {
  const relative = safeRelative(raw);
  if (!relative) {
    errors.push(`${field} «${raw}» указывает за пределы пакета`);
    return;
  }
  if (!existingFile(packageDir, raw)) {
    errors.push(`${field}: файл «${raw}» не найден`);
    return;
  }
  if (path.extname(relative).toLowerCase() !== extension) {
    errors.push(`${field} должен быть ${extension}-файлом`);
  }
}

function checkCommon(manifest, folder, kind, errors) {
  // В Rust это `as_i64`: дробное 1.0 приложение не примет, хотя в JS это тот же 1.
  if (!Number.isInteger(manifest.apiVersion) || manifest.apiVersion !== API_VERSION) {
    errors.push(`apiVersion ${JSON.stringify(manifest.apiVersion)} не поддерживается (нужен ${API_VERSION})`);
  }
  if (manifest.kind !== kind) {
    errors.push(`kind «${String(manifest.kind)}» не совпадает с ${kind}.json`);
  }
  if (manifest.id !== folder) {
    errors.push(`id «${String(manifest.id)}» должен совпадать с именем папки «${folder}»`);
  }
  if (!text(manifest.name)) errors.push("нет name");
}

function checkGeometry(manifest, errors, warnings) {
  if (manifest.defaultGeometry !== undefined) {
    if (!isObject(manifest.defaultGeometry)) {
      warnings.push("defaultGeometry не объект — приложение возьмёт геометрию по умолчанию");
    } else {
      ["x", "y", "w", "h"].forEach((key) => {
        const value = manifest.defaultGeometry[key];
        if (value !== undefined && !Number.isFinite(value)) {
          errors.push(`defaultGeometry.${key} должен быть числом`);
        }
      });
    }
  }
  ["minW", "minH"].forEach((key) => {
    if (manifest[key] !== undefined && !Number.isFinite(manifest[key])) {
      errors.push(`${key} должен быть числом`);
    }
  });
}

function optionValue(option) {
  if (typeof option === "string") return option;
  if (isObject(option) && typeof option.value === "string") return option.value;
  return null;
}

function checkSettings(manifest, errors, warnings) {
  if (manifest.settings === undefined) return;
  if (!isObject(manifest.settings)) {
    errors.push("settings должен быть объектом");
    return;
  }
  Object.entries(manifest.settings).forEach(([key, field]) => {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(key)) {
      errors.push(`имя настройки «${key}» должно быть латиницей, цифрами, «_» или «-» (до 40 символов)`);
    }
    if (!isObject(field)) {
      errors.push(`настройка ${key} должна быть объектом`);
      return;
    }
    if (typeof field.type !== "string") {
      errors.push(`у настройки ${key} нет type`);
      return;
    }
    if (!SETTING_TYPES.includes(field.type)) {
      errors.push(`у настройки ${key} неизвестный type «${field.type}»`);
      return;
    }
    if (field.options !== undefined) {
      if (!Array.isArray(field.options)) {
        errors.push(`options настройки ${key} должны быть массивом`);
      } else if (field.options.some((option) => optionValue(option) === null)) {
        errors.push(`options настройки ${key} содержат не строку и не { value }`);
      }
    }
    // Приложение молча ставит в select первый вариант, если default не из
    // списка. Это не ошибка установки, но автор обычно имел в виду другое.
    if (field.type === "select" && Array.isArray(field.options) && field.options.length > 0) {
      const values = field.options.map(optionValue).filter((value) => value !== null);
      if (!values.includes(field.default)) {
        warnings.push(
          `настройка ${key}: default ${JSON.stringify(field.default)} нет в options — приложение возьмёт «${values[0]}»`
        );
      }
    }
  });
}

function checkWidget(packageDir, manifest, errors, warnings) {
  const entry = text(manifest.entry);
  if (!entry) errors.push("поле entry пустое");
  else checkFile(packageDir, entry, ".js", "entry", errors);

  if (manifest.styles !== undefined) {
    if (!Array.isArray(manifest.styles)) {
      errors.push("styles должен быть массивом .css-файлов");
    } else {
      manifest.styles.forEach((style) => {
        if (typeof style !== "string") errors.push("styles содержит не строку");
        else checkFile(packageDir, style, ".css", "styles", errors);
      });
    }
  }

  checkGeometry(manifest, errors, warnings);
  checkSettings(manifest, errors, warnings);
}

function checkTheme(packageDir, manifest, errors, warnings) {
  if (!isObject(manifest.tokens)) {
    errors.push("tokens должен быть объектом");
  } else if (Object.keys(manifest.tokens).length === 0) {
    errors.push("tokens пуст: теме нечего применить");
  } else {
    Object.entries(manifest.tokens).forEach(([token, value]) => {
      if (!token.startsWith("--")) errors.push(`токен ${token} должен начинаться с «--»`);
      if (typeof value !== "string") errors.push(`значение токена ${token} должно быть строкой`);
    });
  }

  if (manifest.css !== undefined) {
    if (typeof manifest.css !== "string") {
      warnings.push("css должен быть строкой — приложение его проигнорирует");
    } else if (text(manifest.css)) {
      checkFile(packageDir, manifest.css, ".css", "css", errors);
    }
  }
}

/** Проверить один пакет: папку с widget.json или theme.json. */
export function validatePackage(packageDir) {
  const folder = path.basename(path.resolve(packageDir));
  const result = { dir: folder, kind: null, errors: [], warnings: [] };

  if (!validId(folder)) {
    result.errors.push("имя папки должно быть латиницей в нижнем регистре: a-z, 0-9, «.», «-», «_» (до 64 символов)");
  }

  const widgetFile = path.join(packageDir, WIDGET_FILE);
  const themeFile = path.join(packageDir, THEME_FILE);
  const hasWidget = fs.existsSync(widgetFile);
  const hasTheme = fs.existsSync(themeFile);

  if (hasWidget && hasTheme) {
    result.errors.push(`в пакете два манифеста: ${WIDGET_FILE} и ${THEME_FILE}`);
    return result;
  }
  if (!hasWidget && !hasTheme) {
    result.errors.push(`нет ни ${WIDGET_FILE}, ни ${THEME_FILE}`);
    return result;
  }

  const file = hasWidget ? widgetFile : themeFile;
  const kind = hasWidget ? "widget" : "theme";
  result.kind = kind;

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    result.errors.push(`${path.basename(file)}: ${error.message}`);
    return result;
  }
  if (!isObject(manifest)) {
    result.errors.push("манифест должен быть JSON-объектом");
    return result;
  }

  checkCommon(manifest, folder, kind, result.errors);
  if (kind === "widget") checkWidget(packageDir, manifest, result.errors, result.warnings);
  else checkTheme(packageDir, manifest, result.errors, result.warnings);
  return result;
}

function looksLikePackage(dir) {
  return fs.existsSync(path.join(dir, WIDGET_FILE)) || fs.existsSync(path.join(dir, THEME_FILE));
}

/** Проверить пакет или каталог пакетов (как `config/plugins`). */
export function validateTarget(target) {
  const root = path.resolve(target);
  let stat;
  try {
    stat = fs.statSync(root);
  } catch (_) {
    return [{ dir: target, kind: null, errors: ["каталог не найден"], warnings: [] }];
  }
  if (!stat.isDirectory()) {
    return [{ dir: target, kind: null, errors: ["нужна папка пакета"], warnings: [] }];
  }
  const packages = looksLikePackage(root)
    ? [root]
    : fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  if (packages.length === 0) return [validatePackage(root)];
  return packages.map(validatePackage);
}

function printReport(packages) {
  let errors = 0;
  packages.forEach((pkg) => {
    const label = pkg.kind === "widget" ? "виджет" : pkg.kind === "theme" ? "тема" : "пакет";
    console.log(`${pkg.errors.length ? "✗" : "✓"} ${pkg.dir} — ${label}`);
    pkg.errors.forEach((error) => console.log(`  ошибка: ${error}`));
    pkg.warnings.forEach((warning) => console.log(`  предупреждение: ${warning}`));
    errors += pkg.errors.length;
  });
  const failed = packages.filter((pkg) => pkg.errors.length > 0).length;
  if (failed === 0) {
    const warnings = packages.reduce((sum, pkg) => sum + pkg.warnings.length, 0);
    console.log(`Пакетов: ${packages.length}, ошибок нет${warnings ? `, предупреждений: ${warnings}` : ""}.`);
  } else {
    console.log(`Пакетов: ${packages.length}, с ошибками: ${failed}.`);
  }
  return errors === 0;
}

function usage() {
  console.log("Использование: node sdk/validate.mjs <папка пакета | каталог пакетов> [--json]");
  console.log("  --json  — вывод в JSON для скриптов");
}

function main(argv) {
  const json = argv.includes("--json");
  const rest = argv.filter((arg) => arg !== "--json");
  if (rest.length !== 1) {
    usage();
    process.exitCode = 1;
    return;
  }
  const packages = validateTarget(rest[0]);
  const ok = packages.every((pkg) => pkg.errors.length === 0);
  if (json) {
    console.log(JSON.stringify({ ok, packages }, null, 2));
  } else {
    printReport(packages);
  }
  // Предупреждения не валят проверку: приложение такой пакет примет.
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
