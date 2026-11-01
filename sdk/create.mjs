#!/usr/bin/env node

/*
  Создать заготовку пакета виджета или темы.

  Заготовка — рабочий пакет, а не пустой скелет: его можно сразу положить в
  config/plugins и увидеть карточку в библиотеке после обновления страницы.
  Дальше остаётся переписать код, стили и схему настроек.

  Использование:
    npx ose-plugin create <id> [параметры]
    node sdk/create.mjs <id> [параметры]   — в репозитории OSE

  Пакет создаётся в <каталог>/<id>, по умолчанию — в текущем каталоге.
*/

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validId, validatePackage } from "./validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const USAGE = [
  "Использование: ose-plugin create <id> [параметры]",
  "   или: node sdk/create.mjs <id> [параметры] (в репозитории OSE)",
  "",
  "  --theme                 создать пакет темы (по умолчанию — виджет)",
  "  --name <текст>          имя для библиотеки (по умолчанию — id)",
  "  --description <текст>   описание для карточки",
  "  --dir <каталог>         куда положить папку пакета (по умолчанию — текущий)",
  "  --force                 писать в непустую папку",
  "  --help                  эта справка",
  "",
  "Примеры:",
  "  npx ose-plugin create hello",
  "  npx ose-plugin create hello --dir config/plugins",
  "  npx ose-plugin create plain --theme",
].join("\n");

function fail(message) {
  console.error(`[OSE] ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = { theme: false, force: false, id: "", name: "", description: "", dir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--theme" || arg === "-t") options.theme = true;
    else if (arg === "--force" || arg === "-f") options.force = true;
    else if (arg === "--name" || arg === "--description" || arg === "--dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`у ${arg} нет значения`);
      }
      index += 1;
      if (arg === "--name") options.name = value;
      else if (arg === "--description") options.description = value;
      else options.dir = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`неизвестный параметр ${arg}`);
    } else if (!options.id) {
      options.id = arg;
    } else {
      throw new Error(`лишний аргумент ${arg}`);
    }
  }
  return options;
}

// Значения подставляются по-разному: в JSON строка должна быть корректно
// экранирована (кавычки в имени не сломают манифест), в коде и README — как есть.
function substitute(template, values, json) {
  let out = template;
  Object.entries(values).forEach(([key, value]) => {
    out = out.split(`{{${key}}}`).join(json ? JSON.stringify(value) : value);
  });
  return out;
}

function templateFiles(kind) {
  const dir = path.join(HERE, "templates", kind);
  return fs
    .readdirSync(dir)
    .sort()
    .map((file) => ({ file, content: fs.readFileSync(path.join(dir, file), "utf8") }));
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    fail(error.message);
    console.error(USAGE);
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (!options.id) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!validId(options.id)) {
    fail(`id «${options.id}» не годится: нужна латиница в нижнем регистре, цифры, «.», «-», «_» (до 64 символов)`);
    return;
  }

  const kind = options.theme ? "theme" : "widget";
  const name = options.name || options.id;
  const description =
    options.description || (kind === "theme" ? `Тема пакета «${options.id}»` : `Виджет пакета «${options.id}»`);
  const parent = path.resolve(options.dir || ".");
  const target = path.join(parent, options.id);

  if (fs.existsSync(target)) {
    const entries = fs.readdirSync(target);
    if (entries.length > 0 && !options.force) {
      fail(`папка ${target} уже не пуста — добавьте --force, чтобы перезаписать файлы`);
      return;
    }
    if (!fs.statSync(target).isDirectory()) {
      fail(`${target} — это файл, а нужна папка`);
      return;
    }
  }

  fs.mkdirSync(target, { recursive: true });
  const files = templateFiles(kind);
  files.forEach(({ file, content }) => {
    const json = file.endsWith(".json");
    fs.writeFileSync(path.join(target, file), substitute(content, { id: options.id, name, description }, json), "utf8");
  });

  const report = validatePackage(target);
  if (report.errors.length > 0) {
    fail(`заготовка не прошла проверку: ${report.errors.join("; ")}`);
    return;
  }

  console.log(`[OSE] Пакет «${options.id}» создан: ${target}`);
  console.log(`  ${kind === "theme" ? "тема" : "виджет"}: ${files.map((item) => item.file).join(", ")}`);
  if (report.warnings.length > 0) {
    report.warnings.forEach((warning) => console.log(`  предупреждение: ${warning}`));
  }
  console.log("Дальше:");
  console.log("  1. Скопируйте папку в config/plugins/ (разработка) или в каталог данных приложения.");
  console.log("  2. Обновите страницу панели — манифесты перечитываются при загрузке.");
  console.log("     Оверлей в OBS обновите вручную, чтобы не рвать эфир.");
  console.log(`  3. Проверка после правок: npx ose-plugin check «${target}»`);
  console.log(`  4. Архив для установки: npx ose-plugin pack «${target}»`);
}

export { main };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
