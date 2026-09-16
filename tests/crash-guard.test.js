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

/*
  Глобальные обработчики фатальных ошибок: перед выходом обязательно должен
  остаться отчёт на диске и сброс состояния, непойманное обещание не должно
  ронять эфир, а повторное падение во время обработки — не зацикливаться.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const { createCrashGuard, writeCrashReport } = require("../server/crash-guard");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ose-crash-"));
}

function reportFiles(dir) {
  return fs.readdirSync(dir).filter((name) => /^crash-.*\.log$/.test(name));
}

// Заглушка консоли: обработчик пишет много, а тесту нужны только факты вызовов.
function fakeConsole() {
  const lines = [];
  return {
    lines,
    error: (...args) => lines.push(["error", ...args.map(String)].join(" ")),
    warn: (...args) => lines.push(["warn", ...args.map(String)].join(" ")),
  };
}

function makeGuard(overrides = {}) {
  const calls = { flush: 0, exit: [], fatal: [] };
  const consoleStub = fakeConsole();
  const guard = createCrashGuard({
    getLogsDir: () => tmpDir(),
    flush: () => {
      calls.flush += 1;
    },
    exit: (code) => calls.exit.push(code),
    onFatal: (info) => calls.fatal.push(info),
    console: consoleStub,
    env: {},
    ...overrides,
  });
  return { guard, calls, consoleStub };
}

describe("crash-guard", () => {
  test("непойманная ошибка: отчёт, сброс состояния, диалог, выход", () => {
    const dir = tmpDir();
    const { guard, calls } = makeGuard({ getLogsDir: () => dir });

    guard.handleUncaught(new Error("boom"));

    expect(calls.flush).toBe(1);
    expect(calls.fatal).toHaveLength(1);
    expect(calls.fatal[0].kind).toBe("uncaught");
    expect(calls.exit).toEqual([1]);
    expect(reportFiles(dir)).toHaveLength(1);
    expect(guard.counts.fatal).toBe(1);

    const report = fs.readFileSync(path.join(dir, reportFiles(dir)[0]), "utf8");
    expect(report).toContain("boom");
    expect(report).toContain(process.version);
    expect(report).toContain("--- ошибка ---");
  });

  test("отказ flush не мешает отчёту и выходу", () => {
    const dir = tmpDir();
    const { guard, calls, consoleStub } = makeGuard({
      getLogsDir: () => dir,
      flush: () => {
        throw new Error("диск отвалился");
      },
    });

    guard.handleUncaught(new Error("boom"));

    expect(calls.exit).toEqual([1]);
    expect(reportFiles(dir)).toHaveLength(1);
    expect(consoleStub.lines.join("\n")).toContain("диск отвалился");
  });

  test("второе падение во время обработки — аварийный выход без рекурсии", () => {
    const { guard, calls } = makeGuard({
      onFatal: () => {
        throw new Error("диалог не открылся");
      },
    });

    guard.handleUncaught(new Error("первое"));
    expect(calls.exit).toEqual([1]);

    guard.handleUncaught(new Error("второе"));
    expect(calls.exit).toEqual([1, 1]);
    expect(guard.counts.fatal).toBe(1); // второй раз уже не считаем как новый отказ
  });

  test("OSE_KEEP_RUNNING_ON_UNCAUGHT=1 оставляет процесс живым", () => {
    const dir = tmpDir();
    const { guard, calls } = makeGuard({ getLogsDir: () => dir, env: { OSE_KEEP_RUNNING_ON_UNCAUGHT: "1" } });

    guard.handleUncaught(new Error("терпимо"));

    expect(calls.exit).toEqual([]);
    expect(calls.fatal).toHaveLength(0);
    expect(calls.flush).toBe(1);
    expect(reportFiles(dir)).toHaveLength(1);
  });

  test("непойманное обещание логируется, но не завершает процесс", () => {
    const dir = tmpDir();
    const { guard, calls, consoleStub } = makeGuard({ getLogsDir: () => dir });

    guard.handleRejection(new Error("сеть отвалилась"));

    expect(calls.exit).toEqual([]);
    expect(calls.fatal).toHaveLength(0);
    expect(guard.counts.rejections).toBe(1);
    expect(reportFiles(dir)).toHaveLength(1);
    expect(consoleStub.lines.join("\n")).toContain("непойманное обещание");
  });

  test("OSE_STRICT_REJECTIONS=1 делает реджект фатальным", () => {
    const { guard, calls } = makeGuard({ env: { OSE_STRICT_REJECTIONS: "1" } });

    guard.handleRejection(new Error("баг"));

    expect(calls.flush).toBe(1);
    expect(calls.exit).toEqual([1]);
    expect(calls.fatal[0].kind).toBe("unhandledRejection");
  });

  test("шторм непойманных обещаний не пишет отчёт на каждый", () => {
    const dir = tmpDir();
    const { guard } = makeGuard({ getLogsDir: () => dir });

    for (let i = 0; i < 30; i++) guard.handleRejection(new Error(`отвал сети ${i}`));

    expect(guard.counts.rejections).toBe(30);
    // Счётчик растёт на всё, а файлов — только первые несколько.
    expect(reportFiles(dir).length).toBeLessThanOrEqual(5);
    expect(reportFiles(dir).length).toBeGreaterThan(0);
  });

  test("install/uninstall подписывают и снимают обработчики процесса", () => {
    const before = {
      uncaught: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
    };
    const { guard } = makeGuard();

    guard.install();
    expect(process.listenerCount("uncaughtException")).toBe(before.uncaught + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection + 1);

    guard.uninstall();
    expect(process.listenerCount("uncaughtException")).toBe(before.uncaught);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection);
  });

  test("под установленным guard'ом реджект доходит до обработчика", () => {
    const { guard, calls } = makeGuard();
    guard.install();
    try {
      process.emit("unhandledRejection", new Error("из процесса"), Promise.resolve());
    } finally {
      guard.uninstall();
    }

    expect(guard.counts.rejections).toBe(1);
    expect(calls.exit).toEqual([]);
  });

  test("writeCrashReport без каталога не падает, а молчит", () => {
    expect(writeCrashReport(null, "uncaught", new Error("x"))).toBeNull();
    expect(writeCrashReport("", "uncaught", new Error("x"))).toBeNull();
  });

  test("старые отчёты не копятся без ограничения", () => {
    const dir = tmpDir();
    for (let i = 0; i < 25; i++) {
      writeCrashReport(dir, "uncaught", new Error(`ошибка ${i}`));
    }
    expect(reportFiles(dir)).toHaveLength(20);
  });
});
