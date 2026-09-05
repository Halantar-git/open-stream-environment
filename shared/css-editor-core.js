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
  Pure, browser-independent logic for the lightweight CSS editor. Split out of
  control/modules/css-editor.js so it can be unit-tested from Node and reused
  from both the control panel and the standalone CSS editor window.

  Isomorphic, same export pattern as the other shared/ modules: `module.exports`
  on Node, `window.CssEditorCore` in the browser.
*/
(function (root) {
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const CSS_PROPERTIES = [
    "align-items", "align-self", "animation", "animation-delay", "animation-duration",
    "animation-iteration-count", "animation-name", "animation-timing-function",
    "backdrop-filter", "background", "background-color", "background-image",
    "background-position", "background-repeat", "background-size",
    "border", "border-bottom", "border-bottom-left-radius", "border-bottom-right-radius",
    "border-color", "border-left", "border-radius", "border-right", "border-style",
    "border-top", "border-top-left-radius", "border-top-right-radius", "border-width",
    "bottom", "box-shadow", "box-sizing", "color", "column-gap", "content", "cursor",
    "display", "filter", "flex", "flex-basis", "flex-direction", "flex-grow",
    "flex-shrink", "flex-wrap", "font", "font-family", "font-size", "font-style",
    "font-weight", "gap", "grid", "grid-column", "grid-gap", "grid-row",
    "grid-template-columns", "grid-template-rows", "height", "inset", "justify-content",
    "justify-items", "left", "letter-spacing", "line-height", "margin", "margin-bottom",
    "margin-left", "margin-right", "margin-top", "max-height", "max-width", "min-height",
    "min-width", "object-fit", "opacity", "order", "outline", "overflow", "overflow-x",
    "overflow-y", "padding", "padding-bottom", "padding-left", "padding-right",
    "padding-top", "pointer-events", "position", "right", "row-gap", "text-align",
    "text-decoration", "text-overflow", "text-shadow", "text-transform", "top",
    "transform", "transform-origin", "transition", "vertical-align", "visibility",
    "white-space", "width", "word-break", "z-index",
  ];

  const CSS_VALUES = {
    display: ["block", "flex", "grid", "inline", "inline-block", "inline-flex", "none", "contents"],
    position: ["static", "relative", "absolute", "fixed", "sticky"],
    color: ["transparent", "currentColor", "inherit", "initial", "unset", "white", "black", "red", "#", "rgb(", "rgba(", "hsl(", "var("],
    "background-color": ["transparent", "currentColor", "#", "rgb(", "rgba(", "hsl(", "var("],
    border: ["1px solid ", "2px solid ", "none", "solid", "dashed", "dotted", "var("],
    "border-radius": ["0", "4px", "8px", "12px", "24px", "50%", "var("],
    "box-shadow": ["none", "0 0 10px ", "inset 0 0 10px ", "var("],
    "font-family": ['"Manrope", sans-serif', '"JetBrains Mono", monospace', "var("],
    "font-weight": ["400", "500", "600", "700", "bold", "normal"],
    "font-size": ["12px", "13px", "14px", "16px", "18px", "24px", "1rem", "var("],
    "text-align": ["left", "center", "right", "justify"],
    "text-transform": ["none", "uppercase", "lowercase", "capitalize"],
    overflow: ["visible", "hidden", "scroll", "auto"],
    opacity: ["0", "0.5", "1", "var("],
    "z-index": ["0", "1", "10", "100", "999"],
    transition: ["150ms ease", "300ms ease", "var("],
    transform: ["none", "scale(", "translate(", "rotate(", "var("],
    gap: ["4px", "8px", "12px", "16px", "var("],
    margin: ["0", "4px", "8px", "16px", "auto", "var("],
    padding: ["0", "4px", "8px", "16px", "var("],
    width: ["100%", "auto", "max-content", "min-content", "var("],
    height: ["100%", "auto", "var("],
    cursor: ["pointer", "default", "text", "not-allowed"],
    "pointer-events": ["none", "auto"],
    "white-space": ["nowrap", "pre", "pre-wrap", "normal"],
    "object-fit": ["cover", "contain", "fill", "none"],
  };

  const CSS_FUNCTIONS = [
    "var(", "rgb(", "rgba(", "hsl(", "linear-gradient(", "radial-gradient(", "calc(",
    "min(", "max(", "clamp(", "url(", "translate(", "rotate(", "scale(", "cubic-bezier(",
  ];

  // Master tokenizer. Group order matters: more specific tokens come first so the
  // regex engine prefers them (e.g. `--x` over a generic identifier).
  const TOKEN_RE = /(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(@[a-zA-Z-]+)|(--[a-zA-Z0-9-]+)|(#[0-9a-fA-F]{3,8})|(-?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|%|vw|vh|vmin|vmax|s|ms|deg|fr|ch|ex|cm|mm|in|pt|pc)?\b)|([a-zA-Z-]+(?=\s*\())|([a-zA-Z-][\w-]*)|([{}:;,()>~+*])|(\s+)|([\s\S])/g;

  function highlightCss(code) {
    const out = [];
    let last = 0;
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(code))) {
      if (m.index > last) out.push(escapeHtml(code.slice(last, m.index)));
      const text = m[0];
      const cls =
        m[1] ? "tok-comment" :
        m[2] ? "tok-string" :
        m[3] ? "tok-atrule" :
        m[4] ? "tok-var" :
        m[5] ? "tok-hex" :
        m[6] ? "tok-number" :
        m[7] ? "tok-fn" :
        m[9] ? "tok-punct" : "";
      out.push(cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text));
      last = m.index + text.length;
      if (TOKEN_RE.lastIndex === m.index) TOKEN_RE.lastIndex++; // safety: never stall
    }
    out.push(escapeHtml(code.slice(last)));
    return out.join("");
  }

  function detectContext(value, pos) {
    const before = value.slice(0, pos);

    // var(--...)
    const varIdx = before.lastIndexOf("var(");
    if (varIdx !== -1 && before.slice(varIdx).indexOf(")") === -1) {
      const m = before.slice(varIdx).match(/^var\(\s*(--[a-zA-Z0-9-]*)$/);
      if (m) return { type: "var", range: [varIdx, pos], query: m[1] };
    }

    // Inside a rule block only (last `{` is after the last `}`).
    const lastOpen = before.lastIndexOf("{");
    const lastClose = before.lastIndexOf("}");
    if (lastOpen > lastClose) {
      const seg = before.slice(lastOpen + 1);
      const lastSemi = seg.lastIndexOf(";");
      const decl = lastSemi === -1 ? seg : seg.slice(lastSemi + 1);
      const colonIdx = decl.indexOf(":");

      if (colonIdx !== -1) {
        const prop = decl.slice(0, colonIdx).trim();
        const rawVal = decl.slice(colonIdx + 1);
        const lead = rawVal.match(/^\s*/)[0].length;
        return {
          type: "value",
          property: prop,
          range: [pos - rawVal.length + lead, pos],
          query: rawVal.slice(lead),
        };
      }

      const m = decl.match(/([a-zA-Z-][\w-]*)$/);
      if (m) return { type: "property", range: [pos - m[1].length, pos], query: m[1] };
      return null;
    }

    // Outside a rule block → selector context.
    const sel = before.match(/([.#:a-zA-Z][\w-]*)$/);
    if (sel) return { type: "selector", range: [pos - sel[1].length, pos], query: sel[1] };
    return null;
  }

  function getCompletions(context, tokens, selectors) {
    if (!context) return [];
    if (context.type === "var") {
      const q = context.query.toLowerCase();
      return tokens
        .filter((t) => t.startsWith("--") && t.toLowerCase().includes(q))
        .slice(0, 30)
        .map((v) => ({ label: v, text: `var(${v})`, kind: "var" }));
    }
    if (context.type === "property") {
      const q = context.query.toLowerCase();
      return CSS_PROPERTIES
        .filter((p) => p.includes(q))
        .slice(0, 20)
        .map((p) => ({ label: p, text: p + ": ", kind: "prop" }));
    }
    if (context.type === "value") {
      const prop = context.property.toLowerCase();
      const q = context.query.toLowerCase();
      const base = (CSS_VALUES[prop] || []).slice();
      CSS_FUNCTIONS.forEach((f) => {
        if (!base.includes(f)) base.push(f);
      });
      return base
        .filter((v) => v.toLowerCase().includes(q))
        .slice(0, 20)
        .map((v) => ({ label: v, text: v, kind: "value" }));
    }
    if (context.type === "selector") {
      const q = context.query.toLowerCase();
      return (selectors || [])
        .filter((s) => s.toLowerCase().includes(q))
        .slice(0, 20)
        .map((s) => ({ label: s, text: s, kind: "sel" }));
    }
    return [];
  }

  // Remove comments/strings and at-rule preludes so declaration scanning only sees
  // real rule bodies (avoids flagging media/container features as properties).
  function stripNonDeclarations(css) {
    let out = "";
    let i = 0;
    const n = css.length;
    while (i < n) {
      const ch = css[i];
      if (ch === "/" && css[i + 1] === "*") {
        const end = css.indexOf("*/", i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let j = i + 1;
        while (j < n && css[j] !== quote) {
          if (css[j] === "\\") j++;
          j++;
        }
        out += css.slice(i, Math.min(j + 1, n));
        i = Math.min(j + 1, n);
        continue;
      }
      if (ch === "@") {
        const brace = css.indexOf("{", i);
        if (brace === -1) break;
        i = brace + 1;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  function isKnownProperty(prop) {
    return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports(prop, "initial");
  }

  function lineOf(css, needle) {
    const idx = String(css || "").indexOf(needle);
    if (idx === -1) return 0;
    return String(css).slice(0, idx).split("\n").length;
  }

  function validate(css) {
    const issues = [];
    const trimmed = String(css || "").trim();
    if (!trimmed) return issues;

    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
    } catch (err) {
      issues.push({ kind: "syntax", line: 0, message: (err && err.message) || "syntax error" });
      return issues;
    }

    const body = stripNonDeclarations(css);
    const re = /(?:^|[;{}])\s*([a-zA-Z-][\w-]*)\s*:\s*([^;{}]+)/g;
    let m;
    while ((m = re.exec(body))) {
      const rawProp = m[1];
      const prop = rawProp.toLowerCase();
      const value = m[2].trim();
      const line = lineOf(css, rawProp + ":");
      if (prop.startsWith("-")) continue; // vendor/custom property
      if (!isKnownProperty(prop)) {
        issues.push({ kind: "property", line, name: prop });
        continue;
      }
      if (value.includes("var(")) continue; // resolves later
      if (typeof CSS !== "undefined" && typeof CSS.supports === "function" && !CSS.supports(prop, value)) {
        issues.push({ kind: "value", line, value: `${prop}: ${value}` });
      }
    }
    return issues;
  }

  const api = {
    escapeHtml,
    CSS_PROPERTIES,
    CSS_VALUES,
    CSS_FUNCTIONS,
    highlightCss,
    detectContext,
    getCompletions,
    stripNonDeclarations,
    validate,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.CssEditorCore = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
