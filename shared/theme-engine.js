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
  Small HSL-based color engine for custom themes. Not the real Material
  Color Utilities (HCT) algorithm — just enough hue/saturation/lightness
  math to turn 3-4 seed colors into a full, readable dark-theme token set
  with sane on-color contrast. Isomorphic (server + browser), same
  export pattern as the other shared/ modules.
*/
(function (root) {
  function hexToRgb(hex) {
    const m = String(hex).replace("#", "").match(/^([0-9a-f]{6})$/i);
    const h = m ? m[1] : "888888";
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  function rgbToHex(r, g, b) {
    const c = (n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
    return `#${c(r)}${c(g)}${c(b)}`;
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s;
    const l = (max + min) / 2;
    if (max === min) { h = 0; s = 0; } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    s = Math.min(100, Math.max(0, s)) / 100;
    l = Math.min(100, Math.max(0, l)) / 100;
    if (s === 0) { const v = l * 255; return { r: v, g: v, b: v }; }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return { r: hue2rgb(p, q, h + 1 / 3) * 255, g: hue2rgb(p, q, h) * 255, b: hue2rgb(p, q, h - 1 / 3) * 255 };
  }
  function hexToHsl(hex) {
    const { r, g, b } = hexToRgb(hex);
    return rgbToHsl(r, g, b);
  }
  function hslToHex(h, s, l) {
    const { r, g, b } = hslToRgb(h, s, l);
    return rgbToHex(r, g, b);
  }
  function hexToRgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
  }

  // A "role" is a primary/secondary/tertiary accent: a light readable tone
  // for use on dark surfaces, a dark tone to put text on top of it, and a
  // mid container tone with its own readable on-color — mirrors M3's
  // tone relationships (~T80 / ~T20 / ~T30 / ~T90) without the full HCT math.
  function deriveRole(seedHex) {
    const { h, s } = hexToHsl(seedHex);
    return {
      role: hslToHex(h, Math.min(90, s * 0.9 + 10), 78),
      onRole: hslToHex(h, Math.min(60, s * 0.6), 15),
      container: hslToHex(h, Math.min(70, s * 0.7 + 10), 32),
      onContainer: hslToHex(h, Math.min(40, s * 0.3), 92),
    };
  }

  function deriveSurfaces(seedHex) {
    const { h } = hexToHsl(seedHex);
    const sat = 12; // surfaces stay near-neutral so widget text stays legible
    return {
      dim: hslToHex(h, sat, 5),
      base: hslToHex(h, sat, 7),
      bright: hslToHex(h, sat, 20),
      containerLowest: hslToHex(h, sat, 3),
      containerLow: hslToHex(h, sat, 10),
      container: hslToHex(h, sat, 12),
      containerHigh: hslToHex(h, sat, 16),
      containerHighest: hslToHex(h, sat, 20),
      onSurface: hslToHex(h, 8, 92),
      onSurfaceVariant: hslToHex(h, 8, 78),
      outline: hslToHex(h, 10, 52),
      outlineVariant: hslToHex(h, 10, 26),
    };
  }

  const FONT_PRESETS = {
    nebula: {
      "--font-display": '"Manrope", "Segoe UI", sans-serif',
      "--font-body": '"Manrope", "Segoe UI", sans-serif',
      "--font-mono": '"JetBrains Mono", "Consolas", monospace',
    },
    orbital: {
      "--font-display": '"Orbitron", "Segoe UI", sans-serif',
      "--font-body": '"Rajdhani", "Segoe UI", sans-serif',
      "--font-mono": '"Orbitron", "Consolas", monospace',
    },
  };

  const SHAPE_MODES = ["rounded", "angular", "sharp", "soft", "pill", "brackets4", "hazard"];

  function shapeTokens(mode, primaryHex, surfaceContainerHex, outlineVariantHex) {
    const glass = hexToRgba(surfaceContainerHex, 0.82);
    const base = {
      "--panel-radius": "24px",
      "--panel-clip": "none",
      "--panel-decoration": "none",
      "--panel-glow": "0 24px 48px rgba(0,0,0,0.45)",
      "--panel-bg": glass,
      "--panel-blur": "20px",
      "--panel-border": "1px solid rgba(255, 255, 255, 0.12)",
      "--alert-enter-easing": "cubic-bezier(0.05, 0.7, 0.1, 1)",
      "--alert-enter-duration": "480ms",
    };

    switch (mode) {
      case "angular":
        return {
          ...base,
          "--panel-radius": "2px",
          "--panel-clip": "polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 0 100%)",
          "--panel-decoration": "brackets2",
          "--panel-glow": `0 0 16px ${hexToRgba(primaryHex, 0.22)}, inset 0 0 24px ${hexToRgba(primaryHex, 0.05)}`,
          "--panel-bg": surfaceContainerHex,
          "--panel-blur": "0px",
          "--panel-border": `1px solid ${outlineVariantHex}`,
          "--alert-enter-easing": "cubic-bezier(0.175, 0.885, 0.32, 1.2)",
          "--alert-enter-duration": "350ms",
        };
      case "sharp":
        return {
          ...base,
          "--panel-radius": "0px",
          "--panel-glow": "0 1px 3px rgba(0,0,0,0.4)",
          "--panel-bg": surfaceContainerHex,
          "--panel-blur": "0px",
          "--panel-border": `1px solid ${outlineVariantHex}`,
        };
      case "soft":
        return {
          ...base,
          "--panel-radius": "12px",
          "--panel-bg": hexToRgba(surfaceContainerHex, 0.72),
          "--panel-blur": "12px",
          "--panel-border": "1px solid rgba(255, 255, 255, 0.10)",
        };
      case "pill":
        return {
          ...base,
          "--panel-radius": "999px",
          "--panel-blur": "16px",
        };
      case "brackets4":
        return {
          ...base,
          "--panel-radius": "8px",
          "--panel-decoration": "brackets4",
          "--panel-glow": `0 0 14px ${hexToRgba(primaryHex, 0.2)}, inset 0 0 20px ${hexToRgba(primaryHex, 0.05)}`,
          "--panel-bg": surfaceContainerHex,
          "--panel-blur": "0px",
          "--panel-border": `1px solid ${outlineVariantHex}`,
          "--alert-enter-easing": "cubic-bezier(0.175, 0.885, 0.32, 1.2)",
          "--alert-enter-duration": "350ms",
        };
      case "hazard":
        return {
          ...base,
          "--panel-radius": "4px",
          "--panel-decoration": "hazard",
          "--panel-glow": `0 0 14px ${hexToRgba(primaryHex, 0.22)}, inset 0 0 20px ${hexToRgba(primaryHex, 0.04)}`,
          "--panel-bg": surfaceContainerHex,
          "--panel-blur": "0px",
          "--panel-border": `1px solid ${outlineVariantHex}`,
          "--alert-enter-easing": "cubic-bezier(0.175, 0.885, 0.32, 1.2)",
          "--alert-enter-duration": "350ms",
        };
      default:
        return base;
    }
  }

  // Rebuild `--panel-border` from optional granular width/style/color overrides
  // while keeping the derived default for whichever part is left blank.
  function overridePanelBorder(current, width, style, color) {
    const parts = String(current || "1px solid rgba(255,255,255,0.12)").split(" ");
    const w = (width && String(width).trim()) || parts[0] || "1px";
    const s = (style && String(style).trim()) || parts[1] || "solid";
    const c = (color && String(color).trim()) || parts.slice(2).join(" ") || "rgba(255,255,255,0.12)";
    return `${w} ${s} ${c}`;
  }

  // Build `--panel-glow` from a color + intensity (0-100). Intensity drives both
  // opacity and blur/spread, so the picker/slider UI never has to emit raw CSS.
  function panelGlow(colorHex, strength) {
    const hex = String(colorHex).replace("#", "").slice(0, 6).padEnd(6, "0");
    const s = Math.max(0, Math.min(100, Number(strength) || 0));
    const alpha = Math.round((0.05 + (s / 100) * 0.55) * 255).toString(16).padStart(2, "0");
    const blur = Math.round(4 + (s / 100) * 40);
    const spread = Math.round((s / 100) * 8);
    return `0 0 ${blur}px ${spread}px #${hex}${alpha}`;
  }

  // seeds: { primary, secondary, tertiary, surfaceSeed, shapeMode, fontPreset,
  //          fontDisplay?, fontBody?, fontMono?, panelRadius?, panelBorderWidth?,
  //          panelBorderStyle?, panelBorderColor?, panelGlowColor?, panelGlowStrength?,
  //          background?, text?, panelOpacity?, panelBlur? }
  // Optional granular fields override the preset/derived token only when set.
  function buildThemeTokens(seeds) {
    const primary = deriveRole(seeds.primary);
    const secondary = deriveRole(seeds.secondary);
    const tertiary = deriveRole(seeds.tertiary);
    const surf = deriveSurfaces(seeds.surfaceSeed || seeds.primary);
    const fonts = FONT_PRESETS[seeds.fontPreset] || FONT_PRESETS.nebula;
    const shape = shapeTokens(seeds.shapeMode, seeds.primary, surf.container, surf.outlineVariant);

    const tokens = {
      "--md-primary": primary.role,
      "--md-on-primary": primary.onRole,
      "--md-primary-container": primary.container,
      "--md-on-primary-container": primary.onContainer,
      "--md-secondary": secondary.role,
      "--md-on-secondary": secondary.onRole,
      "--md-secondary-container": secondary.container,
      "--md-on-secondary-container": secondary.onContainer,
      "--md-tertiary": tertiary.role,
      "--md-on-tertiary": tertiary.onRole,
      "--md-tertiary-container": tertiary.container,
      "--md-on-tertiary-container": tertiary.onContainer,
      "--md-error": "#ffb4ab",
      "--md-on-error": "#690005",
      "--md-error-container": "#93000a",
      "--md-on-error-container": "#ffdad6",
      "--md-surface-dim": surf.dim,
      "--md-surface": surf.base,
      "--md-surface-bright": surf.bright,
      "--md-surface-container-lowest": surf.containerLowest,
      "--md-surface-container-low": surf.containerLow,
      "--md-surface-container": surf.container,
      "--md-surface-container-high": surf.containerHigh,
      "--md-surface-container-highest": surf.containerHighest,
      "--md-on-surface": surf.onSurface,
      "--md-on-surface-variant": surf.onSurfaceVariant,
      "--md-outline": surf.outline,
      "--md-outline-variant": surf.outlineVariant,
      ...fonts,
      ...shape,
    };

    // Granular overrides (empty = keep the preset/derived value).
    if (seeds.fontDisplay && String(seeds.fontDisplay).trim()) tokens["--font-display"] = String(seeds.fontDisplay).trim();
    if (seeds.fontBody && String(seeds.fontBody).trim()) tokens["--font-body"] = String(seeds.fontBody).trim();
    if (seeds.fontMono && String(seeds.fontMono).trim()) tokens["--font-mono"] = String(seeds.fontMono).trim();
    if (seeds.panelRadius && String(seeds.panelRadius).trim()) tokens["--panel-radius"] = String(seeds.panelRadius).trim();
    if (seeds.panelGlowColor && String(seeds.panelGlowColor).trim()) tokens["--panel-glow"] = panelGlow(seeds.panelGlowColor, seeds.panelGlowStrength);
    if (seeds.background && String(seeds.background).trim()) tokens["--md-surface"] = String(seeds.background).trim();
    if (seeds.text && String(seeds.text).trim()) tokens["--md-on-surface"] = String(seeds.text).trim();
    if (seeds.panelBlur && String(seeds.panelBlur).trim()) tokens["--panel-blur"] = String(seeds.panelBlur).trim();
    const opacity = Number(seeds.panelOpacity);
    if (seeds.panelOpacity !== "" && seeds.panelOpacity != null && Number.isFinite(opacity)) {
      tokens["--panel-bg"] = hexToRgba(surf.container, Math.max(0, Math.min(100, opacity)) / 100);
    }
    if ((seeds.panelBorderWidth && String(seeds.panelBorderWidth).trim()) || (seeds.panelBorderStyle && String(seeds.panelBorderStyle).trim()) || (seeds.panelBorderColor && String(seeds.panelBorderColor).trim())) {
      tokens["--panel-border"] = overridePanelBorder(tokens["--panel-border"], seeds.panelBorderWidth, seeds.panelBorderStyle, seeds.panelBorderColor);
    }

    return tokens;
  }

  const api = { hexToHsl, hslToHex, hexToRgba, deriveRole, deriveSurfaces, buildThemeTokens, FONT_PRESETS, SHAPE_MODES };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.ThemeEngine = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
