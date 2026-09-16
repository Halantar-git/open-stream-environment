/*
  Copyright (C) 2026  Halantar

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://gnu.org>.
*/

/*
  Глобальные обработчики фатальных ошибок процесса.

  До этого `uncaughtException`/`unhandledRejection` не слушал никто: падение в
  главном процессе убивало приложение без записи в лог и без финального сброса
  состояния на диск — последние настройки и события стрима терялись, а
  пользователь видел только исчезнувшее окно. Теперь порядок такой:

    * ошибка попадает в консоль, в файл `logs/crash-<метка>.log` (с версиями
      Node/Electron и платформой — это то, что просят в баг-репорте) и в диалог
      в главном процессе;
    * перед выходом вызывается flush — несохранённое успевает лечь на диск;
    * выход только контролируемый: `onFatal` (в Electron — диалог) и затем
      `exit(1)`. Продолжать работу после непойманной ошибки нельзя — состояние
      процесса может быть каким угодно.

  Непойманные обещания — отдельный случай: их источник в этом приложении почти
  всегда сеть (обрыв чата Twitch, таймаут DonationAlerts), и ронять прямой эфир
  из-за отвалившегося запроса нельзя. Поэтому реджект логируется громко, но не
  завершает процесс; для поиска настоящих багов есть строгий режим
  (OSE_STRICT_REJECTIONS=1), а для отладки непойманных ошибок —
  OSE_KEEP_RUNNING_ON_UNCAUGHT=1 (логируем и живём дальше).
*/

const fs = require("fs");
const path = require("path");

// Сколько файлов-отчётов держим: они нужны для свежего разбора, а не как архив.
const MAX_CRASH_REPORTS = 20;

// Шторм непойманных обещаний (отвалившийся сервис, который сам же и
// переподключается) не должен превращаться в шторм записи на диск, поэтому
// отчёт о реджекте пишется не на каждый: первым подряд — да, потом не чаще раза
// в минуту. Счётчик при этом растёт всегда — по нему видно масштаб.
const MAX_REJECTION_REPORTS = 5;
const REJECTION_REPORT_MIN_INTERVAL_MS = 60000;

// Два падения в одну миллисекунду должны дать два отчёта, а не один.
let crashReportSeq = 0;

function errorText(error) {
  if (!error) return "неизвестная ошибка без описания";
  if (typeof error === "string") return error;
  return error.stack || error.message || String(error);
}

function pruneCrashReports(dir) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => /^crash-.*\.log$/.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    files.slice(MAX_CRASH_REPORTS).forEach((entry) => {
      try {
        fs.unlinkSync(path.join(dir, entry.name));
      } catch (_) {
        /* уже удалён */
      }
    });
  } catch (_) {
    /* каталог мог исчезнуть — не повод падать ещё раз */
  }
}

/*
  Пишет отчёт о падении. Своя запись, а не через createLogger: обработчик
  должен работать и до того, как поднят сервер и включено файловое логирование.
*/
function writeCrashReport(dir, kind, error, extra = {}) {
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tag = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `crash-${tag}-${++crashReportSeq}-${kind}.log`);
    const lines = [
      `Время:      ${new Date().toISOString()}`,
      `Тип:        ${kind}`,
      `Приложение: ${extra.appName || "Open Stream Environment"} ${extra.version || ""}`.trim(),
      `Платформа:  ${process.platform} ${process.arch}`,
      `Node:       ${process.version}`,
      `Electron:   ${process.versions.electron || "—"}`,
      `Память:     rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`,
      "",
      "--- ошибка ---",
      errorText(error),
      "",
    ];
    fs.writeFileSync(file, lines.join("\n"), "utf8");
    pruneCrashReports(dir);
    return file;
  } catch (_) {
    return null; // отчёт — вспомогательный инструмент, не повод падать в падении
  }
}

function createCrashGuard(options = {}) {
  const appName = options.appName || "Open Stream Environment";
  const version = options.version || "";
  const getLogsDir = typeof options.getLogsDir === "function" ? options.getLogsDir : () => null;
  const flush = typeof options.flush === "function" ? options.flush : null;
  const onFatal = typeof options.onFatal === "function" ? options.onFatal : null;
  const exit = typeof options.exit === "function" ? options.exit : (code) => process.exit(code);
  const env = options.env || process.env;
  const log = options.console || console;

  const state = { fatal: 0, rejections: 0, stopped: false, lastReportPath: null, lastRejectionReportAt: 0 };

  const handlers = {
    uncaught: (error) => handleUncaught(error),
    rejection: (reason) => handleRejection(reason),
  };

  function report(kind, error) {
    const reportPath = writeCrashReport(getLogsDir(), kind, error, { appName, version });
    state.lastReportPath = reportPath;
    const where = reportPath ? `, отчёт: ${reportPath}` : "";
    log.error(`[crash-guard] ${kind}: ${errorText(error)}${where}`);
    return reportPath;
  }

  function safeFlush() {
    if (!flush) return;
    try {
      flush();
    } catch (err) {
      log.error("[crash-guard] не удалось сбросить состояние на диск:", errorText(err));
    }
  }

  function handleUncaught(error) {
    // Падение во время обработки падения: дальше только аварийный выход, иначе
    // получим рекурсию из обработчиков.
    if (state.stopped) {
      log.error("[crash-guard] повторная ошибка во время обработки — аварийный выход");
      exit(1);
      return { stopped: true };
    }
    state.stopped = true;
    state.fatal += 1;

    const reportPath = report("uncaught", error);
    safeFlush();

    const keepRunning = String(env.OSE_KEEP_RUNNING_ON_UNCAUGHT || "") === "1";
    if (keepRunning) {
      log.error("[crash-guard] OSE_KEEP_RUNNING_ON_UNCAUGHT=1 — процесс продолжает работу");
      state.stopped = false;
      return { stopped: false, reportPath };
    }

    if (onFatal) {
      try {
        onFatal({ appName, kind: "uncaught", error, reportPath });
      } catch (err) {
        log.error("[crash-guard] диалог об ошибке не показан:", errorText(err));
      }
    }
    exit(1);
    return { stopped: true, reportPath };
  }

  function handleRejection(reason) {
    state.rejections += 1;
    const dueByTime = Date.now() - state.lastRejectionReportAt >= REJECTION_REPORT_MIN_INTERVAL_MS;
    const detailed = state.rejections <= MAX_REJECTION_REPORTS || dueByTime;
    if (detailed) state.lastRejectionReportAt = Date.now();
    const reportPath = detailed ? report("unhandledRejection", reason) : null;

    // Строгий режим — для тестов и отладки: непойманное обещание = баг.
    if (String(env.OSE_STRICT_REJECTIONS || "") === "1") {
      log.error("[crash-guard] OSE_STRICT_REJECTIONS=1 — завершаем процесс");
      safeFlush();
      if (onFatal) {
        try {
          onFatal({ appName, kind: "unhandledRejection", error: reason, reportPath });
        } catch (err) {
          log.error("[crash-guard] диалог об ошибке не показан:", errorText(err));
        }
      }
      exit(1);
      return { fatal: true, reportPath };
    }

    if (detailed) {
      log.warn(
        "[crash-guard] непойманное обещание проигнорировано (процесс продолжает работу; " +
          "подробности в отчёте и в логе)"
      );
    } else {
      log.warn(
        `[crash-guard] непойманных обещаний уже ${state.rejections} — отчёт для каждого не пишем, ` +
          "чтобы не залить диск; последний: " +
          errorText(reason).split("\n")[0]
      );
    }
    return { fatal: false, reportPath };
  }

  return {
    appName,
    handleUncaught,
    handleRejection,
    get counts() {
      return { fatal: state.fatal, rejections: state.rejections };
    },
    get lastReportPath() {
      return state.lastReportPath;
    },
    install() {
      process.on("uncaughtException", handlers.uncaught);
      process.on("unhandledRejection", handlers.rejection);
      return this;
    },
    uninstall() {
      process.removeListener("uncaughtException", handlers.uncaught);
      process.removeListener("unhandledRejection", handlers.rejection);
      return this;
    },
  };
}

// Ставит обработчики у процесса и возвращает сам guard (пригодится для тестов
// и для снятия обработчиков при выключении).
function installCrashHandlers(options = {}) {
  return createCrashGuard(options).install();
}

module.exports = { createCrashGuard, installCrashHandlers, writeCrashReport, errorText };
