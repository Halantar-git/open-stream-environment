#!/usr/bin/env node

/*
  Одна команда для SDK: `npx ose-plugin create` и `npx ose-plugin check`.

  Разделение на подкоманды — чтобы установленный пакет не требовал помнить два
  имени: `create` собирает заготовку, `check` проверяет манифест и файлы.
*/

import process from "node:process";

import { main as create } from "../create.mjs";
import { main as check } from "../validate.mjs";

const USAGE = [
  "ose-plugin — пакеты виджетов и тем Open Stream Environment",
  "",
  "  ose-plugin create <id> [--theme] [--name «Имя»] [--dir <каталог>] [--force]",
  "  ose-plugin check [<папка | каталог>] [--json]   (по умолчанию — текущая папка)",
  "",
  "Документация: https://github.com/Halantar-git/open-stream-environment/tree/main/sdk",
].join("\n");

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "create":
    create(rest);
    break;
  case "check":
  case "validate":
    check(rest.length > 0 ? rest : ["."]);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(USAGE);
    break;
  default:
    console.error(`Неизвестная команда: ${command}`);
    console.log(USAGE);
    process.exitCode = 1;
}
