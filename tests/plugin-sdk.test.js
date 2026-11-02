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
  SDK пакетов: заготовка и проверка.

  Проверяем то, на что рассчитывает автор пакета: `create.mjs` делает пакет,
  который приложение примет, `validate.mjs` ловит ошибки манифеста до установки,
  а список типов настроек и версия API не расходятся с Rust-загрузчиком.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SDK = path.join(ROOT, "sdk");

function run(script, args, options = {}) {
  const full = [path.join(ROOT, script), ...args];
  try {
    const out = execFileSync(process.execPath, full, { cwd: ROOT, encoding: "utf8", ...options });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status, out: `${error.stdout || ""}${error.stderr || ""}` };
  }
}

function create(args, options) {
  return run("sdk/create.mjs", args, options);
}

function validate(target) {
  return run("sdk/validate.mjs", ["--json", target]);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ose-sdk-"));
}

function writePackage(dir, name, file, content) {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, file), content, "utf8");
  return folder;
}

function widgetManifest(overrides = {}) {
  return {
    apiVersion: 1,
    kind: "widget",
    id: "demo",
    name: "Демо",
    entry: "widget.js",
    ...overrides,
  };
}

function writeWidget(dir, overrides = {}) {
  const folder = writePackage(
    dir,
    overrides.id || "demo",
    "widget.json",
    JSON.stringify(widgetManifest(overrides), null, 2)
  );
  fs.writeFileSync(path.join(folder, "widget.js"), "(function () {})();\n", "utf8");
  return folder;
}

function manifestOf(folder, file) {
  return JSON.parse(fs.readFileSync(path.join(folder, file), "utf8"));
}

function report(out) {
  return JSON.parse(out);
}

/*
  Минимальная распаковка для проверки `pack`: читаем локальные заголовки по
  порядку и разворачиваем deflate. Этого достаточно, чтобы убедиться, что
  смещения, размеры и CRC посчитаны правильно.
*/
function unzip(buffer) {
  const entries = {};
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString("utf8", offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    const body = buffer.subarray(start, start + size);
    entries[name] = method === 8 ? zlib.inflateRawSync(body) : body;
    offset = start + size;
  }
  return entries;
}

describe("SDK пакетов", () => {
  test("заготовка виджета создаётся и проходит проверку", () => {
    const dir = tempDir();
    const created = create(["hello", "--dir", dir]);
    expect(created.code).toBe(0);

    const folder = path.join(dir, "hello");
    ["widget.json", "widget.js", "widget.css", "README.md"].forEach((file) => {
      expect(fs.existsSync(path.join(folder, file))).toBe(true);
    });
    const manifest = manifestOf(folder, "widget.json");
    expect(manifest.kind).toBe("widget");
    expect(manifest.id).toBe("hello");
    expect(manifest.entry).toBe("widget.js");

    const checked = validate(folder);
    expect(checked.code).toBe(0);
    expect(report(checked.out).ok).toBe(true);
  });

  test("заготовка темы создаётся и проходит проверку", () => {
    const dir = tempDir();
    const created = create(["plain", "--theme", "--name", 'Plain "X"', "--dir", dir]);
    expect(created.code).toBe(0);

    const folder = path.join(dir, "plain");
    const manifest = manifestOf(folder, "theme.json");
    expect(manifest.kind).toBe("theme");
    expect(manifest.name).toBe('Plain "X"');
    expect(Object.keys(manifest.tokens).length).toBeGreaterThan(0);

    expect(validate(folder).code).toBe(0);
  });

  test("непустую папку без --force не перезаписывает", () => {
    const dir = tempDir();
    expect(create(["hello", "--dir", dir]).code).toBe(0);
    const again = create(["hello", "--dir", dir]);
    expect(again.code).toBe(1);
    expect(again.out).toContain("--force");
    expect(create(["hello", "--dir", dir, "--force"]).code).toBe(0);
  });

  test("негодный id отвергается", () => {
    const dir = tempDir();
    const created = create(["Hello!", "--dir", dir]);
    expect(created.code).toBe(1);
    expect(created.out).toContain("латиница");
  });

  test("неизвестный тип настройки — ошибка", () => {
    const dir = tempDir();
    const folder = writeWidget(dir, {
      settings: { color: { type: "gradient", label: "Градиент" } },
    });
    const checked = validate(folder);
    expect(checked.code).toBe(1);
    expect(checked.out).toContain("неизвестный type");
  });

  test("entry за пределы пакета — ошибка", () => {
    const dir = tempDir();
    const folder = writeWidget(dir, { entry: "../widget.js" });
    const checked = validate(folder);
    expect(checked.code).toBe(1);
    expect(checked.out).toContain("за пределы пакета");
  });

  test("3D-виджет без theme — ошибка", () => {
    const dir = tempDir();
    const folder = writeWidget(dir, { renderType: "canvas" });
    const checked = validate(folder);
    expect(checked.code).toBe(1);
    expect(checked.out).toContain("семейство темы");
  });

  test("неизвестный renderType — ошибка", () => {
    const dir = tempDir();
    const folder = writeWidget(dir, { renderType: "dom", theme: "orbit" });
    const checked = validate(folder);
    expect(checked.code).toBe(1);
    expect(checked.out).toContain("renderType");
  });

  test("тема с threeDWidgets проходит проверку", () => {
    const dir = tempDir();
    const folder = writePackage(
      dir,
      "orbit",
      "theme.json",
      JSON.stringify(
        {
          apiVersion: 1,
          kind: "theme",
          id: "orbit",
          name: "Orbit",
          tokens: { "--md-primary": "#00f0ff" },
          threeDWidgets: ["plugin:ring"],
        },
        null,
        2
      )
    );
    const checked = validate(folder);
    expect(checked.code).toBe(0);
  });

  test("id не совпадает с именем папки — ошибка", () => {
    const dir = tempDir();
    const folder = writePackage(
      dir,
      "demo",
      "widget.json",
      JSON.stringify({ ...widgetManifest(), id: "other" }, null, 2)
    );
    fs.writeFileSync(path.join(folder, "widget.js"), "", "utf8");
    const checked = validate(folder);
    expect(checked.code).toBe(1);
    expect(checked.out).toContain("совпадать с именем папки");
  });

  test("default не из options — предупреждение, но пакет принимается", () => {
    const dir = tempDir();
    const folder = writeWidget(dir, {
      settings: {
        mode: { type: "select", label: "Режим", default: "centre", options: ["center", "left"] },
      },
    });
    const checked = validate(folder);
    expect(checked.code).toBe(0);
    const payload = report(checked.out);
    expect(payload.ok).toBe(true);
    expect(payload.packages[0].warnings.join(" ")).toContain("нет в options");
  });

  test("примеры из docs/examples проходят проверку", () => {
    const checked = run("sdk/validate.mjs", ["--json", "docs/examples/plugins"]);
    const payload = report(checked.out);
    expect(checked.code).toBe(0);
    expect(payload.packages.map((pkg) => pkg.dir).sort()).toEqual(["hello", "last-donation", "plain-theme"]);
  });

  test("команда ose-plugin создаёт и проверяет пакет", () => {
    const dir = tempDir();
    const created = run("sdk/bin/ose-plugin.mjs", ["create", "demo", "--dir", dir]);
    expect(created.code).toBe(0);
    expect(fs.existsSync(path.join(dir, "demo", "widget.json"))).toBe(true);

    const checked = run("sdk/bin/ose-plugin.mjs", ["check", path.join(dir, "demo")]);
    expect(checked.code).toBe(0);
    expect(checked.out).toContain("ошибок нет");
  });

  test("ose-plugin check без пути проверяет текущую папку", () => {
    const dir = tempDir();
    expect(create(["hello", "--dir", dir]).code).toBe(0);
    const checked = run("sdk/bin/ose-plugin.mjs", ["check"], { cwd: path.join(dir, "hello") });
    expect(checked.code).toBe(0);
  });

  test("ose-plugin pack собирает архив без мусора", () => {
    const dir = tempDir();
    expect(create(["hello", "--dir", dir]).code).toBe(0);
    const folder = path.join(dir, "hello");
    // Мусор, который не должен уехать в архив: зависимости и файлы Finder.
    fs.mkdirSync(path.join(folder, "node_modules", "junk"), { recursive: true });
    fs.writeFileSync(path.join(folder, "node_modules", "junk", "index.js"), "x", "utf8");
    fs.writeFileSync(path.join(folder, ".DS_Store"), "x", "utf8");

    const out = path.join(dir, "hello.zip");
    const packed = run("sdk/bin/ose-plugin.mjs", ["pack", folder, "--out", out]);
    expect(packed.code).toBe(0);
    expect(packed.out).toContain("Архив готов");

    const archive = unzip(fs.readFileSync(out));
    expect(Object.keys(archive).sort()).toEqual(["README.md", "widget.css", "widget.js", "widget.json"]);
    // Содержимое совпадает с файлами папки: смещения и deflate не сдвинуты.
    expect(archive["widget.js"].toString("utf8")).toBe(
      fs.readFileSync(path.join(folder, "widget.js"), "utf8")
    );
    expect(JSON.parse(archive["widget.json"].toString("utf8")).id).toBe("hello");
  });

  test("pack не собирает битый пакет", () => {
    const dir = tempDir();
    const folder = writePackage(dir, "demo", "widget.json", JSON.stringify({ apiVersion: 1 }, null, 2));
    const packed = run("sdk/bin/ose-plugin.mjs", ["pack", folder, "--out", path.join(dir, "demo.zip")]);
    expect(packed.code).toBe(1);
    expect(packed.out).toContain("ошибка");
    expect(fs.existsSync(path.join(dir, "demo.zip"))).toBe(false);
  });

  test("npm-пакет содержит команду, шаблоны и лицензию", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SDK, "package.json"), "utf8"));
    expect(pkg.name).toBe("ose-plugin");
    expect(pkg.bin["ose-plugin"]).toBe("bin/ose-plugin.mjs");
    ["bin", "templates", "schema", "index.d.ts", "LICENSE", "pack.mjs"].forEach((entry) => {
      expect(pkg.files).toContain(entry);
    });
    expect(fs.existsSync(path.join(SDK, "bin", "ose-plugin.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(SDK, "LICENSE"))).toBe(true);

    const help = run("sdk/bin/ose-plugin.mjs", ["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("create");
    expect(help.out).toContain("check");
    expect(help.out).toContain("pack");
  });

  test("типы настроек и версия API не расходятся с Rust-загрузчиком", () => {
    const rust = fs.readFileSync(path.join(ROOT, "src-tauri", "src", "plugins.rs"), "utf8");
    const apiVersion = Number((rust.match(/pub const API_VERSION: i64 = (\d+);/) || [])[1]);
    const types = ((rust.match(/const SETTING_TYPES: &\[&str\] = &\[([\s\S]*?)\];/) || [])[1] || "")
      .split(",")
      .map((value) => value.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    expect(apiVersion).toBe(1);
    expect(types.length).toBeGreaterThan(0);

    const schema = JSON.parse(fs.readFileSync(path.join(SDK, "schema", "widget.schema.json"), "utf8"));
    expect(schema.properties.apiVersion.const).toBe(apiVersion);
    expect(schema.$defs.setting.properties.type.enum).toEqual(types);

    const dir = tempDir();
    const settings = {};
    types.forEach((type) => {
      settings[`f_${type}`] = {
        type,
        label: type,
        default: type === "boolean" ? true : type === "number" || type === "range" ? 1 : "x",
        ...(type === "select" ? { options: ["x", "y"] } : {}),
      };
    });
    const folder = writeWidget(dir, { settings });
    expect(validate(folder).code).toBe(0);

    const broken = writeWidget(tempDir(), {
      id: "bad",
      apiVersion: apiVersion + 1,
    });
    expect(validate(broken).code).toBe(1);
  });
});
