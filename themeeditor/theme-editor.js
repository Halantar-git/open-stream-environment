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
  Standalone custom-theme editor window.

  The form is declared once, in `FIELDS`: every control knows its tab, kind,
  label, default and (for optional ones) which token it falls back to when set
  to "Авто". That single schema drives rendering, reading, resetting, the auto
  state and the inline validation, so adding a seed means adding one entry.

  Around the seeds the window carries the tooling that keeps the whole loop
  inside the editor:

    - palette tools — preset gallery, harmony derivation, randomiser, screen
      eyedropper, hex inputs and recent colors;
    - a WCAG contrast check with one-click fixes for the seeded colors;
    - undo/redo over the whole form, dirty tracking, Ctrl+S / Ctrl+Z / Esc;
    - a live preview and a token inspector in a side rail.

  The wire format is unchanged: seeds are saved with `CMD_SAVE_CUSTOM_THEME`
  and live-previewed with `CMD_PREVIEW_THEME_DRAFT`, so the overlay, the canvas
  and `server/state.js` keep working exactly as before.
*/
(function () {
  const { EVENT_TYPES } = window.SharedEvents;
  const { WIDGET_TYPES } = window.WidgetCatalog;
  const ThemeEngine = window.ThemeEngine;
  const BuiltinThemes = window.BuiltinThemes;
  const t = (key, params) => (window.I18n ? window.I18n.t(key, params) : key);

  const port = new URLSearchParams(location.search).get("port") || "8710";

  const THEME_FONTS = [
    { label: "Manrope", value: '"Manrope", "Segoe UI", sans-serif' },
    { label: "JetBrains Mono", value: '"JetBrains Mono", "Consolas", monospace' },
    { label: "Orbitron", value: '"Orbitron", "Segoe UI", sans-serif' },
    { label: "Rajdhani", value: '"Rajdhani", "Segoe UI", sans-serif' },
    { label: "PT Sans Caption", value: '"PT Sans Caption", "Segoe UI", sans-serif' },
    { label: "Roboto Condensed", value: '"Roboto Condensed", "Segoe UI", sans-serif' },
    { label: "IBM Plex Mono", value: '"IBM Plex Mono", "Consolas", monospace' },
  ];

  const DEFAULT_CSS_TOKEN_KEYS = [
    "--md-primary", "--md-secondary", "--md-tertiary", "--md-surface", "--md-on-surface", "--md-surface-container",
    "--md-outline", "--panel-radius", "--panel-border", "--panel-glow", "--panel-bg", "--panel-blur",
    "--font-display", "--font-body", "--font-mono",
  ];

  const SIZE_UNITS = ["px", "rem", "em", "%"];
  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const NUMBER_UNIT_RE = /^(-?\d*\.?\d+)\s*(px|rem|em|%)$/i;
  const RECENT_KEY = "ose.themeEditor.recentColors";
  const HAS_EYEDROPPER = typeof window.EyeDropper === "function";
  const MAX_HISTORY = 80;
  const MAX_RECENT = 12;

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const escapeAttr = (s) => String(s).replace(/"/g, "&quot;");
  const val = (v) => escapeAttr(v == null ? "" : v);
  const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));

  // ---- color math (preview tint + WCAG contrast) --------------------------

  function parseColor(input) {
    const s = String(input == null ? "" : input).trim();
    let m = s.match(/^#([0-9a-f]{3})$/i);
    if (m) {
      const h = m[1];
      return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 };
    }
    m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      const h = m[1];
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
    }
    m = s.match(/^#([0-9a-f]{8})$/i);
    if (m) {
      const h = m[1];
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: parseInt(h.slice(6, 8), 16) / 255,
      };
    }
    m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const parts = m[1].split(/[,\s/]+/).filter((part) => part !== "");
      if (parts.length >= 3) {
        const channel = (part) => {
          const n = parseFloat(part);
          if (!Number.isFinite(n)) return 0;
          const scaled = String(part).includes("%") ? (n / 100) * 255 : n;
          return Math.max(0, Math.min(255, scaled));
        };
        let a = 1;
        if (parts.length >= 4) {
          const raw = parseFloat(parts[3]);
          if (Number.isFinite(raw)) a = String(parts[3]).includes("%") ? raw / 100 : raw;
        }
        return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: Math.max(0, Math.min(1, a)) };
      }
    }
    return null;
  }

  function toHex(c) {
    const f = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
    return `#${f(c.r)}${f(c.g)}${f(c.b)}`;
  }

  // Colors in tokens are often translucent (panel glass, outlines); blend them
  // onto their surface before measuring, otherwise the ratio is meaningless.
  function blendOver(fg, bg) {
    const a = fg.a == null ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }

  function luminance(c) {
    const ch = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }

  function contrastRatio(fg, bg) {
    const f = fg.a != null && fg.a < 1 ? blendOver(fg, bg) : fg;
    const l1 = luminance(f);
    const l2 = luminance(bg);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  function extractColor(value) {
    const s = String(value == null ? "" : value);
    const hex = s.match(/#[0-9a-f]{6}\b/i) || s.match(/#[0-9a-f]{3}\b/i);
    if (hex) return parseColor(hex[0]);
    const fn = s.match(/rgba?\([^)]*\)/i);
    if (fn) return parseColor(fn[0]);
    return null;
  }

  function colorHex(value, fallback) {
    const c = extractColor(value);
    return c ? toHex(c) : fallback || "";
  }

  function alphaOf(value) {
    const c = extractColor(value);
    if (!c) return null;
    return c.a == null ? 1 : c.a;
  }

  function intFrom(value, min, max, fallback) {
    const m = String(value == null ? "" : value).match(/-?\d+(\.\d+)?/);
    if (!m) return fallback;
    return clamp(parseFloat(m[0]), min, max);
  }

  // Walk the lightness of `hex` towards the nearest tone that reaches `target`
  // against `bgHex`, keeping hue/saturation. Used by the contrast "fix" action.
  function raiseContrast(hex, bgHex, target) {
    const bg = parseColor(bgHex);
    const fg = parseColor(hex);
    if (!bg || !fg) return hex;
    if (contrastRatio(fg, bg) >= target) return hex;

    const { h, s, l } = ThemeEngine.hexToHsl(toHex(fg));
    const darkBg = luminance(bg) < 0.35;
    let best = hex;
    let bestRatio = contrastRatio(fg, bg);
    for (let step = 1; step <= 100; step += 1) {
      const candidates = darkBg ? [l + step, l - step] : [l - step, l + step];
      for (const next of candidates) {
        if (next < 0 || next > 100) continue;
        const candidate = ThemeEngine.hslToHex(h, s, next);
        const ratio = contrastRatio(parseColor(candidate), bg);
        if (ratio > bestRatio) {
          bestRatio = ratio;
          best = candidate;
        }
        if (ratio >= target) return candidate;
      }
    }
    return best;
  }

  // ---- size helpers (radius / border width / blur) ------------------------

  function parseSize(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return { value: "", num: "", unit: "px", raw: false };
    const m = s.match(NUMBER_UNIT_RE);
    if (m) return { value: s, num: m[1], unit: m[2].toLowerCase(), raw: false };
    return { value: s, num: "", unit: "", raw: true };
  }

  function sizeProblem(composed, max) {
    const s = String(composed == null ? "" : composed).trim();
    if (!s) return "";
    // calc()/clamp()/var() are legitimate advanced values — no warning for them.
    if (/^(calc|clamp|min|max|var)\(/i.test(s)) return "";
    const m = s.match(NUMBER_UNIT_RE);
    if (!m) return "invalidSize";
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n) || n < 0) return "invalidSize";
    if (max != null && n > max) return "outOfRange";
    return "";
  }

  // ---- seed schema --------------------------------------------------------

  const DEFAULT_SEEDS = {
    primary: "#c6b8ff",
    secondary: "#7ee0d6",
    tertiary: "#ffb0d8",
    surfaceSeed: "#8878c8",
    mode: "dark",
    shapeMode: "rounded",
    fontPreset: "nebula",
    fontDisplay: "",
    fontBody: "",
    fontMono: "",
    panelRadius: "",
    panelBorderWidth: "",
    panelBorderStyle: "",
    panelBorderColor: "",
    panelGlowColor: "",
    panelGlowStrength: 40,
    background: "",
    text: "",
    panelOpacity: "",
    panelBlur: "",
    error: "",
    alertEnterDuration: "",
    alertEnterEasing: "",
    threeDWidgets: [],
    customCss: "",
  };

  const SCHEME_OPTIONS = [
    { value: "dark", labelKey: "schemeDark" },
    { value: "light", labelKey: "schemeLight" },
  ];

  const SHAPE_OPTIONS = [
    { value: "rounded", labelKey: "rounded" },
    { value: "angular", labelKey: "angular" },
    { value: "sharp", labelKey: "shapeSharp" },
    { value: "soft", labelKey: "shapeSoft" },
    { value: "pill", labelKey: "shapePill" },
    { value: "brackets4", labelKey: "shapeBrackets4" },
    { value: "hazard", labelKey: "shapeHazard" },
  ];

  const BORDER_STYLE_OPTIONS = [
    { value: "", labelKey: "auto" },
    { value: "solid", label: "Solid" },
    { value: "dashed", label: "Dashed" },
    { value: "dotted", label: "Dotted" },
    { value: "double", label: "Double" },
  ];

  const FONT_PRESET_OPTIONS = [
    { value: "nebula", label: "Manrope / JetBrains Mono (Material You)" },
    { value: "orbital", label: "Orbitron / Rajdhani (Orbital)" },
  ];

  const EASING_LABELS = {
    smooth: "easingSmooth",
    decelerate: "easingDecelerate",
    spring: "easingSpring",
    sharp: "easingSharp",
    linear: "easingLinear",
  };

  const EASING_OPTIONS = [
    { value: "", labelKey: "easingAuto" },
    ...Object.keys(ThemeEngine.ALERT_EASINGS || {}).map((k) => ({ value: k, labelKey: EASING_LABELS[k] || k })),
  ];

  // kind: color | colorAuto | size | sizeAuto | range | rangeAuto | select | font
  // autoFrom: token the control displays while "Авто" is checked.
  const FIELDS = [
    { key: "mode", tab: "palette", kind: "select", labelKey: "scheme", options: SCHEME_OPTIONS },
    { key: "primary", tab: "palette", kind: "color", labelKey: "primary" },
    { key: "secondary", tab: "palette", kind: "color", labelKey: "secondary" },
    { key: "tertiary", tab: "palette", kind: "color", labelKey: "tertiary" },
    { key: "surfaceSeed", tab: "palette", kind: "color", labelKey: "surface" },

    { key: "background", tab: "surface", kind: "colorAuto", labelKey: "background", autoFrom: "--md-surface" },
    { key: "text", tab: "surface", kind: "colorAuto", labelKey: "text", autoFrom: "--md-on-surface" },
    { key: "panelOpacity", tab: "surface", kind: "rangeAuto", labelKey: "panelOpacity", min: 0, max: 100, step: 1, suffix: "%", autoFrom: "--panel-bg" },
    { key: "panelBlur", tab: "surface", kind: "sizeAuto", labelKey: "panelBlur", max: 60, autoFrom: "--panel-blur" },

    { key: "shapeMode", tab: "shape", kind: "select", labelKey: "shape", options: SHAPE_OPTIONS },
    { key: "panelRadius", tab: "shape", kind: "size", labelKey: "panelRadius", max: 200 },
    { key: "panelBorderWidth", tab: "shape", kind: "size", labelKey: "panelBorderWidth", max: 24 },
    { key: "panelBorderStyle", tab: "shape", kind: "select", labelKey: "panelBorderStyle", options: BORDER_STYLE_OPTIONS },
    { key: "panelBorderColor", tab: "shape", kind: "colorAuto", labelKey: "panelBorderColor", autoFrom: "--panel-border" },
    { key: "panelGlowColor", tab: "shape", kind: "colorAuto", labelKey: "panelGlowColor", autoFrom: "--panel-glow" },
    { key: "panelGlowStrength", tab: "shape", kind: "range", labelKey: "glowStrength", min: 0, max: 100, step: 1, suffix: "%", dependsOn: "panelGlowColor" },

    { key: "fontPreset", tab: "fonts", kind: "select", labelKey: "fonts", options: FONT_PRESET_OPTIONS },
    { key: "fontDisplay", tab: "fonts", kind: "font", labelKey: "fontDisplay" },
    { key: "fontBody", tab: "fonts", kind: "font", labelKey: "fontBody" },
    { key: "fontMono", tab: "fonts", kind: "font", labelKey: "fontMono" },

    { key: "error", tab: "motion", kind: "colorAuto", labelKey: "errorColor", autoFrom: "--md-error" },
    { key: "alertEnterDuration", tab: "motion", kind: "rangeAuto", labelKey: "alertDuration", min: 0, max: 2000, step: 10, suffix: "ms", autoFrom: "--alert-enter-duration" },
    { key: "alertEnterEasing", tab: "motion", kind: "select", labelKey: "alertEasing", options: EASING_OPTIONS },
  ];

  const FIELD_BY_KEY = {};
  FIELDS.forEach((f) => { FIELD_BY_KEY[f.key] = f; });

  const TABS = [
    {
      id: "palette",
      labelKey: "tabPalette",
      blocks: [
        { fields: ["mode"], cols: 2 },
        { id: "presets" },
        { id: "harmony" },
        { fields: ["primary", "secondary", "tertiary", "surfaceSeed"], cols: 2 },
        { id: "recent" },
      ],
    },
    {
      id: "surface",
      labelKey: "tabSurface",
      blocks: [
        { fields: ["background", "text"], cols: 2 },
        { fields: ["panelOpacity", "panelBlur"], cols: 2 },
      ],
    },
    {
      id: "shape",
      labelKey: "tabShape",
      blocks: [
        { fields: ["shapeMode"], cols: 2 },
        { fields: ["panelRadius", "panelBorderWidth"], cols: 2 },
        { fields: ["panelBorderStyle", "panelBorderColor"], cols: 2 },
        { fields: ["panelGlowColor", "panelGlowStrength"], cols: 2 },
      ],
    },
    {
      id: "fonts",
      labelKey: "tabFonts",
      blocks: [
        { fields: ["fontPreset"], cols: 2 },
        { fields: ["fontDisplay", "fontBody", "fontMono"], cols: 1 },
      ],
    },
    { id: "motion", labelKey: "tabMotion", blocks: [{ fields: ["error", "alertEnterEasing"], cols: 2 }, { fields: ["alertEnterDuration"], cols: 1 }] },
    { id: "threeD", labelKey: "tab3d", blocks: [{ id: "threeD" }] },
    { id: "css", labelKey: "tabCss", blocks: [{ id: "css" }] },
  ];

  const CONTRAST_PAIRS = [
    { id: "text", labelKey: "text", fg: "--md-on-surface", target: 4.5, fix: "text" },
    { id: "muted", labelKey: "contrastMuted", fg: "--md-on-surface-variant", target: 4.5 },
    { id: "primary", labelKey: "primary", fg: "--md-primary", target: 3, fix: "primary" },
    { id: "error", labelKey: "errorColor", fg: "--md-error", target: 3, fix: "error" },
    { id: "onPrimary", labelKey: "contrastOnPrimary", fg: "--md-on-primary", bg: "--md-primary", target: 4.5 },
  ];

  const HARMONY_SHIFTS = {
    analogous: { secondary: 30, tertiary: -30 },
    complementary: { secondary: 180, tertiary: 30 },
    triadic: { secondary: 120, tertiary: 240 },
    split: { secondary: 150, tertiary: 210 },
  };

  // Palette presets: curated seeds first, then one entry per builtin 2D theme so
  // the gallery follows whatever themes ship with the app. Every preset carries
  // its own scheme, so applying one always gives a coherent result.
  const CURATED_PRESETS = [
    { name: "Daylight", seeds: { mode: "light", primary: "#3b5bdb", secondary: "#0b7285", tertiary: "#9c36b5", surfaceSeed: "#5c7cfa" } },
    { name: "Paper", seeds: { mode: "light", primary: "#8a5a2b", secondary: "#557a2d", tertiary: "#a13d63", surfaceSeed: "#c9a227" } },
    { name: "Neon", seeds: { mode: "dark", primary: "#00e5ff", secondary: "#ff2d95", tertiary: "#b388ff", surfaceSeed: "#0d2b33" } },
    { name: "Sunset", seeds: { mode: "dark", primary: "#ff8a65", secondary: "#ffd54f", tertiary: "#ba68c8", surfaceSeed: "#3d2119" } },
    { name: "Ocean", seeds: { mode: "dark", primary: "#4fc3f7", secondary: "#26a69a", tertiary: "#9fa8da", surfaceSeed: "#123040" } },
    { name: "Berry", seeds: { mode: "dark", primary: "#f48fb1", secondary: "#ce93d8", tertiary: "#80cbc4", surfaceSeed: "#3b1f2b" } },
    { name: "Sand", seeds: { mode: "dark", primary: "#e6c36b", secondary: "#c98f5a", tertiary: "#a3b18a", surfaceSeed: "#33291a" } },
  ];

  function builtinPresets() {
    return Object.values(BuiltinThemes.BUILTIN_THEMES || {})
      .filter((theme) => theme && theme.tokens && !theme.variant)
      .map((theme) => ({
        name: theme.name,
        seeds: {
          mode: "dark",
          primary: colorHex(theme.tokens["--md-primary"]),
          secondary: colorHex(theme.tokens["--md-secondary"]),
          tertiary: colorHex(theme.tokens["--md-tertiary"]),
          surfaceSeed: colorHex(theme.tokens["--md-surface-container"]) || colorHex(theme.tokens["--md-surface"]),
        },
      }))
      .filter((preset) => preset.seeds.primary && preset.seeds.secondary && preset.seeds.tertiary && preset.seeds.surfaceSeed);
  }

  // ---- state --------------------------------------------------------------

  let ws = null;
  let initData = null;
  let localesReady = false;
  let theme = null; // { id, name, seeds } | null
  let seedsState = { ...DEFAULT_SEEDS };
  let currentTokens = ThemeEngine.buildThemeTokens(DEFAULT_SEEDS);
  let draftTimer = null;
  let historyTimer = null;
  let toastTimer = null;
  let railFrame = null;

  let history = [];
  let histIndex = -1;
  let initialSnapshot = "";
  let initialName = "";
  let allowClose = false;
  let closePending = false;
  let lastColorKey = "primary";
  let recentColors = [];
  let presets = [];
  let listenersReady = false;

  function send(type, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
  }

  // ---- generic bits -------------------------------------------------------

  function label(field) {
    return field.labelKey ? t("themeEditor." + field.labelKey) : field.label || "";
  }

  function optionLabel(option) {
    return option.label != null ? option.label : t("themeEditor." + option.labelKey);
  }

  function fontSelect(id, current) {
    let found = false;
    const options = [`<option value="">${escapeHtml(t("themeEditor.auto"))}</option>`];
    THEME_FONTS.forEach((font) => {
      const selected = current === font.value;
      if (selected) found = true;
      options.push(`<option value="${escapeAttr(font.value)}"${selected ? " selected" : ""}>${escapeHtml(font.label)}</option>`);
    });
    if (current && !found) options.push(`<option value="${escapeAttr(current)}" selected>${escapeHtml(current)}</option>`);
    return `<select id="${id}">${options.join("")}</select>`;
  }

  function defaultCustomCss(tokens) {
    return [
      "/* " + t("themeEditor.customCssDefaultTitle") + " */",
      "",
      "/* " + t("themeEditor.customCssVariables") + " */",
      ":root {",
      ...DEFAULT_CSS_TOKEN_KEYS.map((key) => `  /* ${key}: ${tokens[key]}; */`),
      "}",
      "",
      "/* " + t("themeEditor.customCssExample") + " */",
      "/* .widget-alert { border-radius: 0; box-shadow: none; } */",
      "",
    ].join("\n");
  }

  function isAutoKind(field) {
    return field.kind === "colorAuto" || field.kind === "rangeAuto" || field.kind === "sizeAuto";
  }

  function elFor(key, suffix) {
    return document.getElementById("f_" + key + (suffix || ""));
  }

  function isAuto(field) {
    const el = elFor(field.key, "_auto");
    return !!(el && el.checked);
  }

  function hasExplicit(key) {
    const field = FIELD_BY_KEY[key];
    if (!field) return false;
    if (isAuto(field)) return false;
    const el = elFor(key);
    return !!(el && String(el.value).trim());
  }

  // ---- read ---------------------------------------------------------------

  function composedSize(field) {
    const raw = (elFor(field.key).value || "").trim();
    if (!raw) return "";
    const m = raw.match(NUMBER_UNIT_RE);
    if (m) return m[1] + m[2].toLowerCase();
    const unitEl = elFor(field.key, "_unit");
    const unit = unitEl ? unitEl.value : "";
    return unit ? raw + unit : raw;
  }

  function readField(field) {
    const el = elFor(field.key);
    if (!el) return DEFAULT_SEEDS[field.key];
    switch (field.kind) {
      case "color":
        return HEX_RE.test(el.value) ? el.value.toLowerCase() : DEFAULT_SEEDS[field.key];
      case "colorAuto":
        return isAuto(field) ? "" : HEX_RE.test(el.value) ? el.value.toLowerCase() : "";
      case "range":
        return Number(el.value);
      case "rangeAuto":
        return isAuto(field) ? "" : Number(el.value);
      case "size":
        return composedSize(field);
      case "sizeAuto":
        return isAuto(field) ? "" : composedSize(field);
      case "select":
        return el.value;
      case "font":
        return el.value.trim();
      default:
        return DEFAULT_SEEDS[field.key];
    }
  }

  function readThreeD() {
    return Array.from(document.querySelectorAll("#threeDPanel input[data-3d-widget]"))
      .filter((el) => el.checked)
      .map((el) => el.getAttribute("data-3d-widget"));
  }

  function readSeeds() {
    const seeds = { ...DEFAULT_SEEDS };
    FIELDS.forEach((field) => { seeds[field.key] = readField(field); });
    seeds.threeDWidgets = readThreeD();
    const css = elFor("customCss");
    seeds.customCss = css ? css.value : seedsState.customCss || "";
    return seeds;
  }

  // ---- write --------------------------------------------------------------

  function setColorControl(key, hex) {
    const picker = elFor(key);
    const hexEl = elFor(key, "_hex");
    if (picker) picker.value = hex;
    if (hexEl) hexEl.value = hex;
  }

  function setRangeControl(field, value) {
    const el = elFor(field.key);
    const valueEl = elFor(field.key, "_value");
    if (el) el.value = String(value);
    if (valueEl) valueEl.textContent = value + (field.suffix || "");
  }

  function setSizeControl(field, parsed) {
    const input = elFor(field.key);
    const unitEl = elFor(field.key, "_unit");
    if (!input) return;
    if (parsed.raw) {
      input.value = parsed.value;
      if (unitEl) unitEl.value = "";
    } else {
      input.value = parsed.num;
      if (unitEl) unitEl.value = parsed.unit || "px";
    }
  }

  function derivedControlValue(field) {
    const tokenValue = currentTokens[field.autoFrom];
    switch (field.kind) {
      case "colorAuto":
        return colorHex(tokenValue, "#888888");
      case "rangeAuto": {
        if (field.key === "panelOpacity") {
          const alpha = alphaOf(tokenValue);
          return Math.round((alpha == null ? 1 : alpha) * 100);
        }
        return intFrom(tokenValue, field.min, field.max, field.min);
      }
      case "sizeAuto": {
        const parsed = parseSize(tokenValue);
        return parsed.value;
      }
      default:
        return "";
    }
  }

  function autoDisplay(field) {
    if (field.kind === "colorAuto") return elFor(field.key).value;
    if (field.kind === "rangeAuto") return elFor(field.key).value + (field.suffix || "");
    if (field.kind === "sizeAuto") return composedSize(field);
    return "";
  }

  function applyFieldState(field) {
    const auto = isAuto(field);
    const blocked = field.dependsOn ? !hasExplicit(field.dependsOn) : false;
    const disabled = auto || blocked;
    [elFor(field.key), elFor(field.key, "_hex"), elFor(field.key, "_unit")].forEach((el) => {
      if (el) el.disabled = disabled;
    });
    const pick = document.querySelector(`[data-pick="${field.key}"]`);
    if (pick) pick.disabled = disabled;
  }

  function writeControl(field, value, tokens) {
    const autoEl = elFor(field.key, "_auto");
    const empty = value === "" || value == null;
    const auto = isAutoKind(field) && empty;
    if (autoEl) autoEl.checked = auto;

    switch (field.kind) {
      case "color":
      case "colorAuto": {
        const hex = HEX_RE.test(String(value)) ? String(value) : colorHex(tokens[field.autoFrom], "#888888");
        setColorControl(field.key, hex);
        break;
      }
      case "range":
      case "rangeAuto": {
        const num = empty ? intFrom(tokens[field.autoFrom], field.min, field.max, field.min) : Number(value);
        setRangeControl(field, clamp(num, field.min, field.max));
        break;
      }
      case "size":
      case "sizeAuto": {
        const source = empty && field.autoFrom ? tokens[field.autoFrom] : value;
        setSizeControl(field, parseSize(source));
        break;
      }
      case "select": {
        const el = elFor(field.key);
        if (el) el.value = String(value == null ? "" : value);
        break;
      }
      case "font": {
        const el = elFor(field.key);
        const next = String(value == null ? "" : value);
        if (el) {
          el.value = next;
          // Fonts saved by an older build (or a hand-edited config) may not be
          // in the preset list — keep them selectable instead of showing blank.
          if (next && el.value !== next) {
            const option = document.createElement("option");
            option.value = next;
            option.textContent = next;
            el.appendChild(option);
            el.value = next;
          }
        }
        break;
      }
      default:
        break;
    }
    applyFieldState(field);
  }

  function writeThreeD(list) {
    const selected = new Set(Array.isArray(list) ? list : []);
    document.querySelectorAll("#threeDPanel input[data-3d-widget]").forEach((el) => {
      el.checked = selected.has(el.getAttribute("data-3d-widget"));
    });
  }

  function writeAllControls() {
    const tokens = ThemeEngine.buildThemeTokens(seedsState);
    FIELDS.forEach((field) => writeControl(field, seedsState[field.key], tokens));
    const css = elFor("customCss");
    if (css) css.value = seedsState.customCss || "";
    writeThreeD(seedsState.threeDWidgets || []);
  }

  // While a control is on "Авто" it mirrors the token it inherits, so the
  // disabled state still tells the user what the theme will actually use.
  function refreshAutoControls() {
    FIELDS.forEach((field) => {
      if (!isAutoKind(field) || !isAuto(field)) return;
      const value = derivedControlValue(field);
      if (field.kind === "colorAuto") setColorControl(field.key, value);
      else if (field.kind === "rangeAuto") setRangeControl(field, value);
      else if (field.kind === "sizeAuto") setSizeControl(field, parseSize(value));
    });
  }

  function refreshNotes() {
    FIELDS.forEach((field) => {
      const noteEl = elFor(field.key, "_note");
      if (!noteEl) return;
      let text = "";
      let warn = false;
      if (isAutoKind(field) && isAuto(field)) {
        text = t("themeEditor.autoValue", { value: autoDisplay(field) });
      } else if (field.kind === "size" || field.kind === "sizeAuto") {
        const problem = sizeProblem(composedSize(field), field.max);
        if (problem) {
          text = t("themeEditor." + problem);
          warn = true;
        }
      }
      noteEl.textContent = text;
      noteEl.classList.toggle("is-warn", warn);
    });
  }

  // ---- markup -------------------------------------------------------------

  function fieldHtml(field) {
    switch (field.kind) {
      case "color":
      case "colorAuto":
        return colorFieldHtml(field);
      case "size":
      case "sizeAuto":
        return sizeFieldHtml(field);
      case "range":
      case "rangeAuto":
        return rangeFieldHtml(field);
      case "select":
        return selectFieldHtml(field);
      case "font":
        return fontFieldHtml(field);
      default:
        return "";
    }
  }

  function colorFieldHtml(field) {
    const auto = isAutoKind(field);
    return `
      <div class="te-field md-field">
        <div class="te-field__head">
          <label for="f_${field.key}">${escapeHtml(label(field))}</label>
          ${auto ? `<label class="te-auto"><input type="checkbox" id="f_${field.key}_auto"> ${escapeHtml(t("themeEditor.auto"))}</label>` : ""}
        </div>
        <div class="te-color-row">
          <input type="color" id="f_${field.key}">
          <input type="text" class="te-hex" id="f_${field.key}_hex" maxlength="7" spellcheck="false">
          ${HAS_EYEDROPPER ? `<button class="te-pick" type="button" data-pick="${field.key}" title="${escapeAttr(t("themeEditor.eyedropper"))}">◎</button>` : ""}
        </div>
        <div class="te-field__note md-field__hint" id="f_${field.key}_note"></div>
      </div>`;
  }

  function sizeFieldHtml(field) {
    const auto = isAutoKind(field);
    const units = [`<option value="">—</option>`]
      .concat(SIZE_UNITS.map((u) => `<option value="${u}">${u}</option>`))
      .join("");
    return `
      <div class="te-field md-field">
        <div class="te-field__head">
          <label for="f_${field.key}">${escapeHtml(label(field))}</label>
          ${auto ? `<label class="te-auto"><input type="checkbox" id="f_${field.key}_auto"> ${escapeHtml(t("themeEditor.auto"))}</label>` : ""}
        </div>
        <div class="te-size-row">
          <input type="text" id="f_${field.key}" inputmode="decimal" autocomplete="off" spellcheck="false">
          <select id="f_${field.key}_unit">${units}</select>
        </div>
        <div class="te-field__note md-field__hint" id="f_${field.key}_note"></div>
      </div>`;
  }

  function rangeFieldHtml(field) {
    const auto = isAutoKind(field);
    return `
      <div class="te-field md-field">
        <div class="te-field__head">
          <label for="f_${field.key}">${escapeHtml(label(field))}</label>
          ${auto ? `<label class="te-auto"><input type="checkbox" id="f_${field.key}_auto"> ${escapeHtml(t("themeEditor.auto"))}</label>` : ""}
        </div>
        <div class="te-range-row">
          <input type="range" id="f_${field.key}" min="${field.min}" max="${field.max}" step="${field.step}">
          <span class="te-range-value" id="f_${field.key}_value"></span>
        </div>
        <div class="te-field__note md-field__hint" id="f_${field.key}_note"></div>
      </div>`;
  }

  function selectFieldHtml(field) {
    const options = field.options
      .map((option) => `<option value="${escapeAttr(option.value)}">${escapeHtml(optionLabel(option))}</option>`)
      .join("");
    return `
      <div class="te-field md-field">
        <div class="te-field__head"><label for="f_${field.key}">${escapeHtml(label(field))}</label></div>
        <select id="f_${field.key}">${options}</select>
        <div class="te-field__note md-field__hint" id="f_${field.key}_note"></div>
      </div>`;
  }

  function fontFieldHtml(field) {
    return `
      <div class="te-field md-field">
        <div class="te-field__head"><label for="f_${field.key}">${escapeHtml(label(field))}</label></div>
        ${fontSelect("f_" + field.key, "")}
        <div class="te-field__note md-field__hint" id="f_${field.key}_note"></div>
      </div>`;
  }

  function presetsBlockHtml() {
    return `
      <div class="te-block md-card">
        <div class="te-block__title">${escapeHtml(t("themeEditor.presets"))}</div>
        <div class="te-presets">
          ${presets
            .map((preset) => {
              const dots = ["primary", "secondary", "tertiary", "surfaceSeed"]
                .map((key) => `<span style="background:${val(preset.seeds[key])}"></span>`)
                .join("");
              return `<button class="te-preset" type="button" data-preset="${escapeAttr(preset.name)}" title="${escapeAttr(preset.name)}">
                <span class="te-preset__dots">${dots}</span>
                <span class="te-preset__name">${escapeHtml(preset.name)}</span>
              </button>`;
            })
            .join("")}
        </div>
      </div>`;
  }

  function harmonyBlockHtml() {
    const options = ["analogous", "complementary", "triadic", "split", "mono"]
      .map((mode) => `<option value="${mode}">${escapeHtml(t("themeEditor.harmony" + mode.charAt(0).toUpperCase() + mode.slice(1)))}</option>`)
      .join("");
    return `
      <div class="te-block md-card">
        <div class="te-block__title">${escapeHtml(t("themeEditor.harmony"))}</div>
        <div class="te-row">
          <select id="harmonySelect">
            <option value="">${escapeHtml(t("themeEditor.harmonyPick"))}</option>
            ${options}
          </select>
          <button class="md-button md-button--outlined" type="button" id="randomizeBtn">${escapeHtml(t("themeEditor.randomize"))}</button>
        </div>
      </div>`;
  }

  function recentBlockHtml() {
    return `
      <div class="te-block md-card">
        <div class="te-block__title">${escapeHtml(t("themeEditor.recentColors"))}</div>
        <div class="te-recent" id="recentRow"></div>
        <div class="te-field__note md-field__hint">${escapeHtml(t("themeEditor.recentColorsHint"))}</div>
      </div>`;
  }

  function threeDBlockHtml() {
    const selected = new Set(Array.isArray(seedsState.threeDWidgets) ? seedsState.threeDWidgets : []);
    const groups = (BuiltinThemes.THREE_D_STYLES || [])
      .map((style) => ({ id: style.id, name: style.name, widgets: (window.WidgetCatalog && window.WidgetCatalog.widgetsForTheme(style.id)) || [] }))
      .filter((group) => group.widgets.length)
      .map(
        (group) => `
        <div class="te-3d-group">
          <div class="te-3d-group__title">${escapeHtml(group.name)}</div>
          ${group.widgets
            .map(
              (widget) => `<label class="te-3d-row"><input type="checkbox" data-3d-widget="${escapeAttr(widget.type)}" ${
                selected.has(widget.type) ? "checked" : ""
              }> <span>${escapeHtml(t("widgets." + widget.type))}</span></label>`
            )
            .join("")}
        </div>`
      )
      .join("");
    return `
      <div class="te-block md-card" id="threeDPanel">
        <div class="te-3d-list">${groups}</div>
        <div class="te-field__note md-field__hint">${escapeHtml(t("themeEditor.threeDHint"))}</div>
      </div>`;
  }

  function cssBlockHtml() {
    return `
      <div class="te-block md-card">
        <div class="te-row">
          <button class="md-button md-button--outlined" type="button" id="editCssBtn">${escapeHtml(t("themeEditor.editCss"))}</button>
        </div>
        <textarea id="f_customCss" hidden></textarea>
        <div class="te-field__note md-field__hint">${escapeHtml(t("themeEditor.customCssHint"))}</div>
      </div>`;
  }

  function customBlockHtml(id) {
    if (id === "presets") return presetsBlockHtml();
    if (id === "harmony") return harmonyBlockHtml();
    if (id === "recent") return recentBlockHtml();
    if (id === "threeD") return threeDBlockHtml();
    if (id === "css") return cssBlockHtml();
    return "";
  }

  function fieldsBlockHtml(block) {
    const fields = block.fields.map((key) => FIELD_BY_KEY[key]).filter(Boolean);
    return `<div class="te-block md-card"><div class="te-grid" style="--te-cols:${block.cols || 1}">${fields.map(fieldHtml).join("")}</div></div>`;
  }

  function tabsHtml() {
    return TABS.map(
      (tab, index) =>
        `<button class="te-tab-btn${index === 0 ? " is-active" : ""}" type="button" role="tab" id="tabbtn_${tab.id}" aria-controls="tab_${tab.id}" aria-selected="${index === 0}" data-tab="${tab.id}">${escapeHtml(
          t("themeEditor." + tab.labelKey)
        )}</button>`
    ).join("");
  }

  function tabsCanReset(tab) {
    return tab.blocks.some((block) => block.fields);
  }

  function panelsHtml() {
    return TABS.map(
      (tab, index) =>
        `<div class="te-tab" id="tab_${tab.id}" role="tabpanel" aria-labelledby="tabbtn_${tab.id}" data-tab="${tab.id}"${index === 0 ? "" : " hidden"}>${
          tabsCanReset(tab)
            ? `<div class="te-tab__tools"><button class="te-link" type="button" data-reset-tab="${tab.id}">${escapeHtml(t("themeEditor.resetSection"))}</button></div>`
            : ""
        }${tab.blocks.map((block) => (block.fields ? fieldsBlockHtml(block) : customBlockHtml(block.id))).join("")}</div>`
    ).join("");
  }

  function previewHtml() {
    const option = (n) => escapeHtml(t("themeEditor.previewPollOption", { n }));
    const bars = [[1, 55], [2, 30], [3, 15]]
      .map(
        ([n, pct]) =>
          `<div class="te-pv__bar"><span class="te-pv__opt">${option(n)}</span><span class="te-pv__track"><span class="te-pv__fill" style="width:${pct}%"></span></span><b>${pct}%</b></div>`
      )
      .join("");
    return `
      <div class="te-preview" id="previewRoot">
        <div class="te-pv te-pv--alert">
          <div class="te-pv__icon">★</div>
          <div class="te-pv__body">
            <div class="te-pv__title">${escapeHtml(t("themeEditor.previewAlertTitle"))}</div>
            <div class="te-pv__text">${escapeHtml(t("themeEditor.previewAlertText"))}</div>
          </div>
        </div>
        <div class="te-pv te-pv--chat">
          <div class="te-pv__row"><span class="te-pv__user">nova_viewer</span><span class="te-pv__msg">${escapeHtml(t("themeEditor.previewChatMsg"))}</span></div>
          <div class="te-pv__row"><span class="te-pv__user">star_gazer</span><span class="te-pv__msg">${escapeHtml(t("themeEditor.previewChatMsg2"))}</span></div>
        </div>
        <div class="te-pv te-pv--goal">
          <div class="te-pv__head"><span>${escapeHtml(t("themeEditor.previewGoal"))}</span><span class="te-pv__num">7 500 / 10 000 ₽</span></div>
          <div class="te-pv__track"><div class="te-pv__fill" style="width:75%"></div></div>
        </div>
        <div class="te-pv te-pv--poll">
          <div class="te-pv__title">${escapeHtml(t("themeEditor.previewPoll"))}</div>
          ${bars}
        </div>
      </div>`;
  }

  function railHtml() {
    return `
      <section class="te-rail__group">
        <div class="te-rail__head">
          <span class="te-rail__title">${escapeHtml(t("themeEditor.preview"))}</span>
          <span class="te-rail__tools">
            <button class="te-mini" type="button" data-open="preview">${escapeHtml(t("themeEditor.previewInWindow"))}</button>
            <button class="te-mini" type="button" data-open="samples">${escapeHtml(t("themeEditor.samples"))}</button>
          </span>
        </div>
        ${previewHtml()}
        <div class="te-field__note">${escapeHtml(t("themeEditor.previewHint"))}</div>
      </section>
      <section class="te-rail__group">
        <div class="te-rail__head"><span class="te-rail__title">${escapeHtml(t("themeEditor.contrast"))}</span></div>
        <div class="te-contrast" id="contrastList"></div>
        <div class="te-field__note">${escapeHtml(t("themeEditor.contrastHint"))}</div>
      </section>
      <section class="te-rail__group">
        <div class="te-rail__head"><span class="te-rail__title">${escapeHtml(t("themeEditor.tokens"))}</span></div>
        <div class="te-tokens" id="tokensList"></div>
        <div class="te-field__note">${escapeHtml(t("themeEditor.tokensHint"))}</div>
      </section>`;
  }

  // ---- rail rendering -----------------------------------------------------

  function applyPreview(tokens) {
    const root = document.getElementById("previewRoot");
    if (!root) return;
    Object.entries(tokens).forEach(([name, value]) => root.style.setProperty(name, value));
  }

  function renderContrast(tokens) {
    const list = document.getElementById("contrastList");
    if (!list) return;
    const surfaceHex = colorHex(tokens["--md-surface"], "#000000");
    const surface = parseColor(surfaceHex);
    if (!surface) {
      list.innerHTML = "";
      return;
    }
    list.innerHTML = CONTRAST_PAIRS.map((pair) => {
      const bgHex = pair.bg ? colorHex(tokens[pair.bg], surfaceHex) : surfaceHex;
      const bg = pair.bg ? parseColor(bgHex) : surface;
      const fgHex = colorHex(tokens[pair.fg]);
      const fg = parseColor(fgHex);
      if (!fg || !bg) return "";
      const ratio = contrastRatio(fg, bg);
      const ok = ratio >= pair.target;
      const fix = pair.fix && !ok
        ? `<button class="te-mini" type="button" data-fix="${pair.fix}" data-target="${pair.target}" data-bg="${pair.bg || ""}">${escapeHtml(
            t("themeEditor.contrastFix")
          )}</button>`
        : "";
      return `<div class="te-contrast__row${ok ? "" : " is-low"}" ${
        ok ? "" : `title="${escapeAttr(t("themeEditor.contrastLow", { ratio: ratio.toFixed(2), min: pair.target }))}"`
      }>
        <span class="te-contrast__dot" style="background:${val(fgHex)};border-color:${val(bgHex)}"></span>
        <span class="te-contrast__label">${escapeHtml(t("themeEditor." + pair.labelKey))}</span>
        <span class="te-contrast__ratio">${ratio.toFixed(2)}:1</span>
        <span class="te-contrast__badge">${ok ? "✓" : "✕"}</span>
        ${fix}
      </div>`;
    }).join("");
  }

  function renderTokens(tokens) {
    const list = document.getElementById("tokensList");
    if (!list) return;
    list.innerHTML = Object.entries(tokens)
      .map(([name, value]) => {
        const hex = colorHex(value, "");
        const dot = hex
          ? `<span class="te-tokens__dot" style="background:${val(hex)}"></span>`
          : `<span class="te-tokens__dot te-tokens__dot--none"></span>`;
        return `<button class="te-tokens__row" type="button" data-token="${escapeAttr(name)}" title="${escapeAttr(name + ": " + value)}">
          ${dot}<span class="te-tokens__name">${escapeHtml(name)}</span><span class="te-tokens__value">${escapeHtml(value)}</span>
        </button>`;
      })
      .join("");
  }

  function scheduleRailRender() {
    if (railFrame) return;
    railFrame = requestAnimationFrame(() => {
      railFrame = null;
      renderContrast(currentTokens);
      renderTokens(currentTokens);
    });
  }

  // ---- status / history ---------------------------------------------------

  function snapshot() {
    return JSON.stringify(readSeeds());
  }

  function isDirty() {
    // The form is built after the locales arrive; nothing can be dirty before that.
    if (!initialSnapshot) return false;
    return snapshot() !== initialSnapshot || themeNameValue() !== initialName;
  }

  function refreshStatus() {
    const chip = document.getElementById("statusLabel");
    const text = document.getElementById("statusText");
    if (!chip || !text) return;
    const dirty = isDirty();
    text.textContent = dirty ? t("themeEditor.statusDirty") : t("themeEditor.statusSaved");
    // `.md-chip.is-pending` pulses its dot — the panel's own "not settled yet" state.
    chip.classList.toggle("is-pending", dirty);
    chip.classList.toggle("is-connected", !dirty);
  }

  function pushHistory() {
    const snap = snapshot();
    if (history[histIndex] === snap) {
      updateHistoryButtons();
      return;
    }
    history = history.slice(0, histIndex + 1);
    history.push(snap);
    if (history.length > MAX_HISTORY) history.shift();
    histIndex = history.length - 1;
    updateHistoryButtons();
  }

  function scheduleHistory(immediate) {
    clearTimeout(historyTimer);
    if (immediate) {
      pushHistory();
      return;
    }
    historyTimer = setTimeout(pushHistory, 500);
  }

  function updateHistoryButtons() {
    const undoBtn = document.getElementById("undoBtn");
    const redoBtn = document.getElementById("redoBtn");
    if (undoBtn) undoBtn.disabled = histIndex <= 0;
    if (redoBtn) redoBtn.disabled = histIndex >= history.length - 1;
  }

  function undo() {
    if (histIndex <= 0) return;
    histIndex -= 1;
    applySeeds(JSON.parse(history[histIndex]));
    updateHistoryButtons();
  }

  function redo() {
    if (histIndex >= history.length - 1) return;
    histIndex += 1;
    applySeeds(JSON.parse(history[histIndex]));
    updateHistoryButtons();
  }

  function toast(text, isError) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("is-error", !!isError);
    el.hidden = false;
    el.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("is-on");
      el.hidden = true;
    }, isError ? 3600 : 1800);
  }

  function copyText(text) {
    try {
      if (window.desktop && window.desktop.copyText) {
        window.desktop.copyText(text);
        return;
      }
    } catch (_) {
      /* fall through to the browser clipboard */
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
  }

  // ---- change pipeline ----------------------------------------------------

  function applySeeds(nextSeeds) {
    seedsState = { ...DEFAULT_SEEDS, ...nextSeeds };
    writeAllControls();
    handleChange();
  }

  function handleChange() {
    seedsState = readSeeds();
    currentTokens = ThemeEngine.buildThemeTokens(seedsState);
    refreshAutoControls();
    refreshNotes();
    applyPreview(currentTokens);
    scheduleRailRender();
    refreshStatus();
    scheduleDraft();
    scheduleHistory(false);
  }

  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(sendDraft, 200);
  }

  function sendDraft() {
    send(EVENT_TYPES.CMD_PREVIEW_THEME_DRAFT, {
      tokens: currentTokens,
      customCss: seedsState.customCss,
      threeDWidgets: seedsState.threeDWidgets,
      themeId: (theme && theme.id) || "",
      name: themeNameValue(),
    });
  }

  function themeNameValue() {
    const el = document.getElementById("themeName");
    const value = el ? el.value.trim() : "";
    return value || t("themeEditor.myTheme");
  }

  // ---- palette tools ------------------------------------------------------

  function loadRecent() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      recentColors = Array.isArray(parsed) ? parsed.filter((c) => HEX_RE.test(String(c))).slice(0, MAX_RECENT) : [];
    } catch (_) {
      recentColors = [];
    }
  }

  function rememberColor(hex) {
    const lower = String(hex).toLowerCase();
    if (!HEX_RE.test(lower)) return;
    recentColors = [lower, ...recentColors.filter((c) => c !== lower)].slice(0, MAX_RECENT);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentColors));
    } catch (_) {
      /* storage is optional */
    }
    renderRecent();
  }

  function renderRecent() {
    const row = document.getElementById("recentRow");
    if (!row) return;
    row.innerHTML = recentColors
      .map((hex) => `<button class="te-recent__chip" type="button" data-recent="${val(hex)}" title="${val(hex)}" style="background:${val(hex)}"></button>`)
      .join("");
  }

  function setColorValue(key, hex, markExplicit) {
    const field = FIELD_BY_KEY[key];
    if (!field || !HEX_RE.test(hex)) return;
    const value = hex.toLowerCase();
    setColorControl(key, value);
    if (markExplicit) {
      const autoEl = elFor(key, "_auto");
      if (autoEl) autoEl.checked = false;
      rememberColor(value);
    }
    applyFieldState(field);
    handleChange();
    scheduleHistory(true);
  }

  async function openEyedropper(key) {
    if (!HAS_EYEDROPPER) return;
    try {
      const result = await new window.EyeDropper().open();
      if (result && result.sRGBHex) setColorValue(key, result.sRGBHex, true);
    } catch (_) {
      /* the user cancelled the picker */
    }
  }

  function applyHarmony(mode) {
    const seeds = readSeeds();
    const base = ThemeEngine.hexToHsl(seeds.primary);
    let derived;
    if (mode === "mono") {
      derived = {
        secondary: ThemeEngine.hslToHex(base.h, base.s, clamp(base.l + 12, 40, 88)),
        tertiary: ThemeEngine.hslToHex(base.h + 8, Math.max(20, base.s * 0.6), clamp(base.l - 12, 45, 88)),
      };
    } else {
      const shifts = HARMONY_SHIFTS[mode];
      if (!shifts) return;
      const role = (shift) => ThemeEngine.hslToHex(base.h + shift, clamp(Math.max(30, base.s), 20, 92), clamp(base.l, 58, 84));
      derived = { secondary: role(shifts.secondary), tertiary: role(shifts.tertiary) };
    }
    derived.surfaceSeed = ThemeEngine.hslToHex(base.h, Math.min(35, base.s * 0.5), 45);
    applySeeds({ ...seeds, ...derived });
    scheduleHistory(true);
  }

  function randomizePalette() {
    const modes = Object.keys(HARMONY_SHIFTS).concat("mono");
    const hue = Math.random() * 360;
    const saturation = 45 + Math.random() * 45;
    const lightness = 60 + Math.random() * 20;
    const seeds = readSeeds();
    applySeeds({ ...seeds, primary: ThemeEngine.hslToHex(hue, saturation, lightness) });
    applyHarmony(modes[Math.floor(Math.random() * modes.length)]);
  }

  function applyPreset(name) {
    const preset = presets.find((p) => p.name === name);
    if (!preset) return;
    applySeeds({ ...readSeeds(), ...preset.seeds });
    scheduleHistory(true);
  }

  function resetTab(tabId) {
    const tab = TABS.find((entry) => entry.id === tabId);
    if (!tab) return;
    const keys = [];
    tab.blocks.forEach((block) => {
      (block.fields || []).forEach((key) => keys.push(key));
    });
    if (!keys.length) return;
    const seeds = readSeeds();
    keys.forEach((key) => {
      seeds[key] = Array.isArray(DEFAULT_SEEDS[key]) ? [] : DEFAULT_SEEDS[key];
    });
    applySeeds(seeds);
    scheduleHistory(true);
  }

  function fixContrast(seedKey, bgToken, target) {
    const field = FIELD_BY_KEY[seedKey];
    if (!field) return;
    const bgHex = colorHex(bgToken ? currentTokens[bgToken] : currentTokens["--md-surface"], "#000000");
    const seeds = readSeeds();
    const current = HEX_RE.test(String(seeds[seedKey])) ? seeds[seedKey] : colorHex(currentTokens[field.autoFrom], seeds.primary);
    const next = raiseContrast(current, bgHex, target);
    if (next === current) {
      toast(t("themeEditor.fixed"));
      return;
    }
    applySeeds({ ...seeds, [seedKey]: next });
    scheduleHistory(true);
    toast(t("themeEditor.fixed"));
  }

  // ---- form events --------------------------------------------------------

  function idParts(id) {
    const m = String(id || "").match(/^f_(.+?)(?:_(hex|auto|unit|value))?$/);
    if (!m) return null;
    return { key: m[1], part: m[2] || "" };
  }

  function handleControlInput(target) {
    const parts = idParts(target.id);
    if (!parts) return;
    const field = FIELD_BY_KEY[parts.key];
    if (!field) {
      if (parts.key === "customCss") {
        handleChange();
        scheduleHistory(false);
      }
      return;
    }

    if (parts.part === "value") return;

    if (parts.part === "auto") {
      const autoEl = target;
      if (!autoEl.checked) {
        // Un-checking "Авто" should not jump: seed the control with what the
        // token had been showing while it was inherited.
        const value = derivedControlValue(field);
        if (field.kind === "colorAuto") setColorControl(field.key, value);
        else if (field.kind === "rangeAuto") setRangeControl(field, value);
        else if (field.kind === "sizeAuto") setSizeControl(field, parseSize(value));
      }
      applyFieldState(field);
      handleChange();
      scheduleHistory(true);
      return;
    }

    if (parts.part === "hex") {
      const value = target.value.trim();
      if (HEX_RE.test(value)) {
        const picker = elFor(field.key);
        if (picker) picker.value = value;
        const autoEl = elFor(field.key, "_auto");
        if (autoEl) autoEl.checked = false;
        target.classList.remove("is-invalid");
        applyFieldState(field);
      } else {
        target.classList.add("is-invalid");
        return;
      }
    } else if (parts.part === "") {
      const autoEl = elFor(field.key, "_auto");
      if (autoEl && (field.kind === "colorAuto" || field.kind === "sizeAuto" || field.kind === "rangeAuto")) {
        autoEl.checked = false;
      }
      if (field.kind === "colorAuto" || field.kind === "color") {
        const hexEl = elFor(field.key, "_hex");
        if (hexEl) {
          hexEl.value = target.value;
          hexEl.classList.remove("is-invalid");
        }
      }
      if (field.kind === "size" || field.kind === "sizeAuto") {
        // Typing "24px" straight into the number field should sync the unit
        // select instead of composing "24pxpx".
        const parsed = parseSize(target.value);
        const unitEl = elFor(field.key, "_unit");
        if (unitEl && !parsed.raw) unitEl.value = parsed.unit || "px";
      }
    }

    applyFieldState(field);
    handleChange();
  }

  function handleFormChange(target) {
    const parts = idParts(target.id);
    if (parts && parts.part === "hex" && !HEX_RE.test(target.value.trim())) {
      const picker = elFor(parts.key);
      if (picker) target.value = picker.value;
      target.classList.remove("is-invalid");
    }
    if (parts && parts.part === "" && (FIELD_BY_KEY[parts.key] || {}).kind === "color") {
      rememberColor(target.value);
    }
  }

  function selectTab(id) {
    document.querySelectorAll(".te-tab-btn").forEach((btn) => {
      const on = btn.getAttribute("data-tab") === id;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll(".te-tab").forEach((panel) => {
      panel.hidden = panel.getAttribute("data-tab") !== id;
    });
  }

  function wireFormOnce() {
    if (listenersReady) return;
    listenersReady = true;

    const form = document.getElementById("form");
    const rail = document.getElementById("rail");
    const tabs = document.getElementById("tabs");

    form.addEventListener("input", (e) => {
      if (!e.target) return;
      if (e.target.id === "themeName") {
        refreshStatus();
        return;
      }
      if (e.target.id === "harmonySelect") return; // applied on change
      handleControlInput(e.target);
    });
    form.addEventListener("change", (e) => {
      if (e.target && e.target.id === "harmonySelect") {
        // Acts as an action menu: derive, then snap back to the placeholder.
        const mode = e.target.value;
        e.target.value = "";
        if (mode) applyHarmony(mode);
        return;
      }
      handleFormChange(e.target);
    });
    form.addEventListener("focusin", (e) => {
      const el = e.target.closest ? e.target.closest("input[type=color], .te-hex") : null;
      if (!el) return;
      const parts = idParts(el.id);
      if (parts && FIELD_BY_KEY[parts.key]) lastColorKey = parts.key;
    });
    form.addEventListener("click", (e) => {
      const pick = e.target.closest("[data-pick]");
      if (pick) {
        openEyedropper(pick.getAttribute("data-pick"));
        return;
      }
      const preset = e.target.closest("[data-preset]");
      if (preset) {
        applyPreset(preset.getAttribute("data-preset"));
        return;
      }
      const resetBtn = e.target.closest("[data-reset-tab]");
      if (resetBtn) {
        resetTab(resetBtn.getAttribute("data-reset-tab"));
        return;
      }
      const recent = e.target.closest("[data-recent]");
      if (recent) {
        setColorValue(lastColorKey, recent.getAttribute("data-recent"), true);
        return;
      }
      if (e.target.closest("#randomizeBtn")) {
        randomizePalette();
        return;
      }
      if (e.target.closest("#editCssBtn")) openCssEditor();
    });

    rail.addEventListener("click", (e) => {
      const recent = e.target.closest("[data-recent]");
      if (recent) {
        setColorValue(lastColorKey, recent.getAttribute("data-recent"), true);
        return;
      }
      const fix = e.target.closest("[data-fix]");
      if (fix) {
        fixContrast(fix.getAttribute("data-fix"), fix.getAttribute("data-bg"), Number(fix.getAttribute("data-target")) || 4.5);
        return;
      }
      const token = e.target.closest("[data-token]");
      if (token) {
        copyText(`var(${token.getAttribute("data-token")})`);
        token.classList.add("is-copied");
        setTimeout(() => token.classList.remove("is-copied"), 700);
        toast(t("themeEditor.copied"));
        return;
      }
      const open = e.target.closest("[data-open]");
      if (open) {
        const kind = open.getAttribute("data-open");
        if (kind === "preview") window.desktop.openThemePreview();
        else window.desktop.openThemeSamples();
        sendDraft();
        setTimeout(sendDraft, 400);
      }
    });

    tabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".te-tab-btn");
      if (!btn) return;
      // A tab click always lands on the form, even if the CSS panel is open.
      closeCssPanel();
      selectTab(btn.getAttribute("data-tab"));
    });

    document.getElementById("undoBtn").addEventListener("click", undo);
    document.getElementById("redoBtn").addEventListener("click", redo);
    document.getElementById("exportBtn").addEventListener("click", exportTheme);
    document.getElementById("saveBtn").addEventListener("click", () => saveTheme());
    document.getElementById("cancelBtn").addEventListener("click", () => closeWindow());

    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey) {
        const key = String(e.key).toLowerCase();
        // Inside the code editor the textarea keeps its own undo history.
        const inCodeEditor = e.target && e.target.closest && e.target.closest(".css-editor");
        if ((key === "z" || key === "y") && inCodeEditor) return;
        if (key === "z") {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        } else if (key === "y") {
          e.preventDefault();
          redo();
        } else if (key === "s") {
          e.preventDefault();
          saveTheme();
        }
        return;
      }
      if (e.key === "Escape") {
        // The autocomplete popup consumes its own Esc.
        if (e.defaultPrevented) return;
        if (!closeCssPanel()) closeWindow();
      }
    });
  }

  // ---- embedded CSS editor ------------------------------------------------

  /*
    The custom CSS used to open in its own window. It now lives in a panel that
    replaces the form column, so the rail (draft preview, contrast check, token
    list) and the header actions stay in view while writing CSS. The chrome is
    csseditor/css-editor.css (`.csswin-*`); the editor itself is
    control/modules/css-editor.js, loaded as a module by theme-editor.html and
    exposed as `window.TeCssEditor`.
  */

  let cssEditor = null;
  let cssSyncTimer = null;

  function cssEditorFactory() {
    return (window.TeCssEditor && window.TeCssEditor.initCssEditor) || null;
  }

  function cssSelectors() {
    return [
      ":root",
      "body",
      "#canvas",
      ".md-card",
      ".md-linear-progress",
      ...Object.values(WIDGET_TYPES).map((def) => ".widget-" + def.type),
    ];
  }

  function cssPanelHtml() {
    return `
      <header class="csswin-header">
        <span class="csswin-header__title">${escapeHtml(t("themeEditor.cssEditorTitle"))}</span>
        <span class="csswin-header__status" id="cssSyncLabel"></span>
        <button class="csswin-done" type="button" id="cssDoneBtn">${escapeHtml(t("themeEditor.cssEditorDone"))}</button>
      </header>
      <div class="csswin-toolbar">
        <button class="csswin-btn" type="button" id="cssUndoBtn" title="${escapeAttr(t("themeEditor.cssUndo"))}">↶</button>
        <button class="csswin-btn" type="button" id="cssRedoBtn" title="${escapeAttr(t("themeEditor.cssRedo"))}">↷</button>
        <span class="csswin-toolbar__sep"></span>
        <button class="csswin-btn" type="button" id="cssSelectAllBtn">${escapeHtml(t("themeEditor.cssSelectAll"))}</button>
        <button class="csswin-btn" type="button" id="cssClearBtn">${escapeHtml(t("themeEditor.cssClear"))}</button>
        <button class="csswin-btn" type="button" id="cssCopyBtn">${escapeHtml(t("themeEditor.cssCopy"))}</button>
        <span class="csswin-toolbar__sep"></span>
        <button class="csswin-btn" type="button" id="cssFindBtn">${escapeHtml(t("themeEditor.cssFind"))}</button>
        <button class="csswin-btn" type="button" id="cssReplaceBtn">${escapeHtml(t("themeEditor.cssReplace"))}</button>
      </div>
      <div class="csswin-findbar" id="cssFindBar" hidden>
        <input class="csswin-input" id="cssFindInput" type="text" placeholder="${escapeAttr(t("themeEditor.cssFindPlaceholder"))}">
        <button class="csswin-btn" type="button" id="cssFindPrevBtn">↑</button>
        <button class="csswin-btn" type="button" id="cssFindNextBtn">↓</button>
        <span class="csswin-toolbar__sep"></span>
        <input class="csswin-input" id="cssReplaceInput" type="text" placeholder="${escapeAttr(t("themeEditor.cssReplacePlaceholder"))}">
        <button class="csswin-btn" type="button" id="cssReplaceOneBtn">${escapeHtml(t("themeEditor.cssReplaceOne"))}</button>
        <button class="csswin-btn" type="button" id="cssReplaceAllBtn">${escapeHtml(t("themeEditor.cssReplaceAll"))}</button>
        <button class="csswin-btn csswin-btn--close" type="button" id="cssCloseFindBtn" title="${escapeAttr(t("themeEditor.cssClose"))}">✕</button>
      </div>
      <div class="csswin-body">
        <div id="cssEditorWrap"></div>
        <div class="csswin-hint">${escapeHtml(t("themeEditor.customCssHint"))}</div>
      </div>
      <div class="csswin-statusbar">
        <span id="cssPosLabel"></span>
        <span id="cssCountLabel"></span>
      </div>`;
  }

  function updateCssStatus() {
    if (!cssEditor) return;
    const pos = document.getElementById("cssPosLabel");
    const count = document.getElementById("cssCountLabel");
    const value = cssEditor.getValue();
    const caret = cssEditor.textarea.selectionStart;
    const lines = value.slice(0, caret).split("\n");
    if (pos) pos.textContent = `${t("themeEditor.cssLine")} ${lines.length}, ${t("themeEditor.cssColumn")} ${lines[lines.length - 1].length + 1}`;
    if (count) count.textContent = `${value.length} ${t("themeEditor.cssChars")}`;
  }

  // Writes the editor buffer into the hidden field the seeds are read from, so
  // the draft, the rail preview and the undo stack all follow along.
  function flushCssSync() {
    clearTimeout(cssSyncTimer);
    if (!cssEditor) return;
    const field = elFor("customCss");
    if (field) field.value = cssEditor.getValue();
    handleChange();
  }

  function scheduleCssSync() {
    const label = document.getElementById("cssSyncLabel");
    if (label) label.textContent = "";
    clearTimeout(cssSyncTimer);
    cssSyncTimer = setTimeout(() => {
      flushCssSync();
      if (label) label.textContent = t("themeEditor.cssSynced");
    }, 250);
  }

  function closeCssPanel() {
    const panel = document.getElementById("cssPanel");
    const form = document.getElementById("form");
    if (!panel || panel.hidden) return false;
    flushCssSync();
    panel.hidden = true;
    if (form) form.hidden = false;
    scheduleHistory(true);
    return true;
  }

  function findCssMatch(dir) {
    const findInput = document.getElementById("cssFindInput");
    if (!cssEditor || !findInput) return;
    const query = String(findInput.value || "");
    if (!query) return;
    const value = cssEditor.getValue();
    const lower = value.toLowerCase();
    const needle = query.toLowerCase();
    const textarea = cssEditor.textarea;
    let index;
    if (dir === -1) {
      index = lower.lastIndexOf(needle, textarea.selectionStart - 1);
      if (index === -1) index = lower.lastIndexOf(needle);
    } else {
      index = lower.indexOf(needle, textarea.selectionEnd);
      if (index === -1) index = lower.indexOf(needle);
    }
    if (index === -1) return;
    textarea.focus();
    textarea.setSelectionRange(index, index + needle.length);
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    const line = value.slice(0, index).split("\n").length;
    textarea.scrollTop = Math.max(0, (line - 1) * lineHeight);
    updateCssStatus();
    cssEditor.highlightMatches(findInput.value);
  }

  function replaceCssOne() {
    const findInput = document.getElementById("cssFindInput");
    const replaceInput = document.getElementById("cssReplaceInput");
    if (!cssEditor || !findInput || !replaceInput) return;
    const query = findInput.value;
    if (!query) return;
    const textarea = cssEditor.textarea;
    const selected = cssEditor.getValue().slice(textarea.selectionStart, textarea.selectionEnd);
    if (selected.toLowerCase() !== query.toLowerCase() && !findCssMatch(1)) return;
    textarea.focus();
    document.execCommand("insertText", false, replaceInput.value);
    updateCssStatus();
  }

  function replaceCssAll() {
    const findInput = document.getElementById("cssFindInput");
    const replaceInput = document.getElementById("cssReplaceInput");
    if (!cssEditor || !findInput || !replaceInput) return;
    const query = findInput.value;
    if (!query) return;
    const value = cssEditor.getValue();
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const next = value.replace(new RegExp(escaped, "gi"), replaceInput.value);
    if (next === value) return;
    cssEditor.setValue(next);
    cssEditor.textarea.dispatchEvent(new Event("input", { bubbles: true }));
    updateCssStatus();
  }

  function wireCssEditor() {
    const findBar = document.getElementById("cssFindBar");
    const findInput = document.getElementById("cssFindInput");
    const onClick = (id, handler) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", handler);
    };

    cssEditor.textarea.addEventListener("input", () => {
      updateCssStatus();
      scheduleCssSync();
    });
    ["keyup", "click"].forEach((evt) => cssEditor.textarea.addEventListener(evt, updateCssStatus));

    onClick("cssUndoBtn", () => { cssEditor.textarea.focus(); document.execCommand("undo"); updateCssStatus(); });
    onClick("cssRedoBtn", () => { cssEditor.textarea.focus(); document.execCommand("redo"); updateCssStatus(); });
    onClick("cssSelectAllBtn", () => { cssEditor.textarea.focus(); cssEditor.textarea.select(); updateCssStatus(); });
    onClick("cssClearBtn", () => {
      cssEditor.setValue("");
      cssEditor.textarea.dispatchEvent(new Event("input", { bubbles: true }));
      cssEditor.textarea.focus();
    });
    onClick("cssCopyBtn", () => copyText(cssEditor.getValue()));
    onClick("cssFindBtn", () => { findBar.hidden = false; findInput.focus(); });
    onClick("cssReplaceBtn", () => { findBar.hidden = false; findInput.focus(); });
    onClick("cssCloseFindBtn", () => { findBar.hidden = true; cssEditor.highlightMatches(""); cssEditor.textarea.focus(); });
    onClick("cssFindPrevBtn", () => findCssMatch(-1));
    onClick("cssFindNextBtn", () => findCssMatch(1));
    onClick("cssReplaceOneBtn", replaceCssOne);
    onClick("cssReplaceAllBtn", replaceCssAll);
    onClick("cssDoneBtn", () => closeCssPanel());

    findInput.addEventListener("input", () => cssEditor.highlightMatches(findInput.value));
    findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        findCssMatch(e.shiftKey ? -1 : 1);
      }
    });
  }

  function openCssEditor() {
    const factory = cssEditorFactory();
    if (!factory) {
      // The editor module is deferred; open as soon as it lands.
      window.addEventListener("te-css-editor-ready", () => openCssEditor(), { once: true });
      return;
    }
    const panel = document.getElementById("cssPanel");
    const form = document.getElementById("form");
    if (!panel) return;

    const field = elFor("customCss");
    const current = field ? field.value : "";
    const initial = current.trim() ? current : defaultCustomCss(currentTokens);

    if (!panel.dataset.built) {
      panel.innerHTML = cssPanelHtml();
      cssEditor = factory({
        container: document.getElementById("cssEditorWrap"),
        initialValue: initial,
        // Live keys of the draft theme, so `var(--…)` completion matches what
        // the theme actually defines.
        tokens: Object.keys(currentTokens),
        selectors: cssSelectors(),
        id: "teCssInput",
        t,
      });
      wireCssEditor();
      panel.dataset.built = "1";
    } else if (cssEditor && cssEditor.getValue() !== initial) {
      cssEditor.setValue(initial);
    }

    panel.hidden = false;
    if (form) form.hidden = true;
    updateCssStatus();
    if (cssEditor) cssEditor.textarea.focus();
  }

  function saveTheme() {
    flushCssSync(); // the buffer can be a keystroke ahead of the hidden field
    if (theme && !confirm(t("themeEditor.overwriteConfirm"))) return false;
    send(EVENT_TYPES.CMD_SAVE_CUSTOM_THEME, { id: theme ? theme.id : null, name: themeNameValue(), seeds: readSeeds() });
    initialName = themeNameValue();
    initialSnapshot = snapshot();
    allowClose = true;
    closeWindow(true);
    return true;
  }

  async function exportTheme() {
    const result = await window.desktop?.exportTheme?.({ name: themeNameValue(), seeds: readSeeds() });
    if (!result || result.canceled) return;
    if (result.ok) toast(t("themeEditor.themeExported", { path: result.filePath }));
    else toast(t("themeEditor.themeExportFailed", { error: result.error }), true);
  }

  function closeWindow(force) {
    flushCssSync();
    if (!force && isDirty() && !confirm(t("themeEditor.discardConfirm"))) return;
    allowClose = true;
    send(EVENT_TYPES.CMD_PREVIEW_THEME_DRAFT, { clear: true });
    setTimeout(() => window.desktop.closeCurrentWindow(), 60);
  }

  function buildForm() {
    theme = (initData && initData.theme) || null;
    seedsState = theme && theme.seeds ? { ...DEFAULT_SEEDS, ...theme.seeds } : { ...DEFAULT_SEEDS };
    currentTokens = ThemeEngine.buildThemeTokens(seedsState);
    presets = CURATED_PRESETS.concat(builtinPresets());
    loadRecent();

    allowClose = false;
    closePending = false;
    history = [];
    histIndex = -1;

    const titleEl = document.getElementById("titleLabel");
    if (titleEl) titleEl.textContent = theme ? t("themeEditor.editTitle") : t("themeEditor.createTitle");
    const undoBtn = document.getElementById("undoBtn");
    const redoBtn = document.getElementById("redoBtn");
    const exportBtn = document.getElementById("exportBtn");
    const saveBtn = document.getElementById("saveBtn");
    const cancelBtn = document.getElementById("cancelBtn");
    if (undoBtn) {
      undoBtn.title = t("themeEditor.undo");
      undoBtn.textContent = "↶";
    }
    if (redoBtn) {
      redoBtn.title = t("themeEditor.redo");
      redoBtn.textContent = "↷";
    }
    if (exportBtn) {
      exportBtn.title = t("themeEditor.exportTheme");
      exportBtn.textContent = "⤓";
    }
    if (saveBtn) saveBtn.textContent = t("themeEditor.save");
    if (cancelBtn) cancelBtn.textContent = t("themeEditor.cancel");

    document.getElementById("tabs").innerHTML = tabsHtml();
    document.getElementById("form").innerHTML = `
      <div class="te-block md-card">
        <div class="te-field md-field">
          <div class="te-field__head"><label for="themeName">${escapeHtml(t("themeEditor.themeName"))}</label></div>
          <input type="text" id="themeName" maxlength="40" value="${escapeAttr(theme ? theme.name : t("themeEditor.myTheme"))}">
        </div>
      </div>
      ${panelsHtml()}`;
    document.getElementById("rail").innerHTML = railHtml();

    // A rebuild (first load or a theme switch) drops the embedded CSS editor
    // along with the form it belongs to.
    const cssPanel = document.getElementById("cssPanel");
    if (cssPanel) {
      cssPanel.hidden = true;
      cssPanel.innerHTML = "";
      delete cssPanel.dataset.built;
    }
    cssEditor = null;
    clearTimeout(cssSyncTimer);
    document.getElementById("form").hidden = false;

    selectTab(TABS[0].id);
    writeAllControls();
    renderRecent();
    handleChange();
    initialName = themeNameValue();
    initialSnapshot = snapshot();
    history = [initialSnapshot];
    histIndex = 0;
    updateHistoryButtons();
    refreshStatus();
  }

  // ---- bootstrap ----------------------------------------------------------

  function connect() {
    ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.onmessage = (ev) => {
      try {
        handleMessage(JSON.parse(ev.data));
      } catch (_) {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws.close();
  }

  function handleMessage(msg) {
    if (msg.type === EVENT_TYPES.LOCALES) {
      if (window.I18n) {
        window.I18n.setLocales(msg.payload && msg.payload.locales);
        window.I18n.setLang(msg.payload && msg.payload.lang);
        window.I18n.apply();
      }
      localesReady = true;
      maybeBuild();
    }
  }

  async function bootstrap() {
    try {
      initData = (await window.desktop.getThemeEditorInit()) || {};
    } catch (_) {
      initData = {};
    }
    maybeBuild();
  }

  function maybeBuild() {
    if (!initData || !localesReady) return;
    wireFormOnce();
    buildForm();
  }

  window.desktop.onThemeEditorInit((data) => {
    initData = data || {};
    if (localesReady) buildForm();
  });

  // The OS close button cannot host a dialog, so cancel the unload first and
  // ask from a fresh task — that keeps "Отмена" honest for the window chrome too.
  window.addEventListener("beforeunload", (e) => {
    if (allowClose || !isDirty()) {
      send(EVENT_TYPES.CMD_PREVIEW_THEME_DRAFT, { clear: true });
      return;
    }
    e.preventDefault();
    e.returnValue = false;
    if (closePending) return;
    closePending = true;
    setTimeout(() => {
      closePending = false;
      if (confirm(t("themeEditor.discardConfirm"))) closeWindow(true);
      else sendDraft();
    }, 0);
  });

  connect();
  bootstrap();
})();
