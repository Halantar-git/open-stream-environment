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

const core = require("../shared/css-editor-core");

describe("shared/css-editor-core", () => {
  test("highlightCss подсвечивает токены", () => {
    const html = core.highlightCss("/* c */ a { color: #fff; }");
    expect(html).toContain('<span class="tok-comment">/* c */</span>');
    expect(html).toContain('<span class="tok-hex">#fff</span>');
  });

  test("detectContext распознаёт property/value/var/selector", () => {
    const property = "a { col";
    const value = "a { color: r";
    const varCtx = "a { color: var(--md-pr";
    const selector = "a { }\n.wid";

    expect(core.detectContext(property, property.length).type).toBe("property");
    expect(core.detectContext(value, value.length).type).toBe("value");
    expect(core.detectContext(varCtx, varCtx.length).type).toBe("var");
    expect(core.detectContext(selector, selector.length).type).toBe("selector");
  });

  test("getCompletions предлагает свойства и селекторы", () => {
    const props = core.getCompletions({ type: "property", range: [0, 0], query: "bor" }, [], []);
    expect(props.some((c) => c.text === "border: ")).toBe(true);

    const sels = core.getCompletions({ type: "selector", range: [0, 0], query: ".widget-go" }, [], [".widget-alert", ".widget-goal"]);
    expect(sels.map((c) => c.label)).toEqual([".widget-goal"]);
  });

  describe("validate", () => {
    beforeEach(() => {
      global.CSSStyleSheet = class {
        replaceSync(css) {
          if (css.includes("BAD")) throw new Error("bad css");
        }
      };
      global.CSS = {
        supports: (prop, value) => {
          const known = new Set(["color", "background", "border-radius", "display", "opacity", "width", "height"]);
          if (!known.has(prop)) return false;
          if (value === "initial") return true;
          return !["notacolor", "bogus"].includes(value);
        },
      };
    });

    afterEach(() => {
      delete global.CSSStyleSheet;
      delete global.CSS;
    });

    test("находит неизвестные свойства и невалидные значения с номером строки", () => {
      const issues = core.validate("div {\n  color: red;\n  unknown-prop: 1px;\n  border-radius: notacolor;\n}");
      const property = issues.find((i) => i.kind === "property");
      const value = issues.find((i) => i.kind === "value");

      expect(property).toBeTruthy();
      expect(property.name).toBe("unknown-prop");
      expect(property.line).toBe(3);

      expect(value).toBeTruthy();
      expect(value.value).toContain("border-radius");
      expect(value.line).toBe(4);
    });

    test("пропускает валидные значения и var()", () => {
      expect(core.validate("div { color: var(--md-primary); opacity: 1; }")).toEqual([]);
    });

    test("ловит структурную ошибку", () => {
      const issues = core.validate("BAD div { color: red; }");
      expect(issues.length).toBe(1);
      expect(issues[0].kind).toBe("syntax");
    });
  });
});
