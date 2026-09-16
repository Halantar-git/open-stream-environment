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
  math to turn 3-4 seed colors into a full, readable token set with sane
  on-color contrast, in either the dark or the light scheme. Isomorphic
  (server + browser), same export pattern as the other shared/ modules.
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

  // WCAG relative luminance / contrast ratio — used to keep derived accents and
  // automatic on-surface text readable on the effective background.
  function srgbLuminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    const ch = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  }

  function contrastRatio(hexA, hexB) {
    const a = srgbLuminance(hexA);
    const b = srgbLuminance(hexB);
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  // HSL lightness is not perceived brightness: a yellow at L40 is far brighter
  // than a blue at L40, so a fixed-lightness role can come out unreadable on
  // the surface (the light scheme makes this easy to hit). Walk the lightness
  // in both directions until `target` is met, keeping hue and saturation, and
  // return the colour untouched when it already passes.
  function readableOn(hex, bgHex, target) {
    if (contrastRatio(hex, bgHex) >= target) return hex;
    const { h, s, l } = hexToHsl(hex);
    const darkBg = srgbLuminance(bgHex) < 0.35;
    let best = hex;
    let bestRatio = contrastRatio(hex, bgHex);
    for (let step = 1; step <= 100; step += 1) {
      const candidates = darkBg ? [l + step, l - step] : [l - step, l + step];
      for (const next of candidates) {
        if (next < 0 || next > 100) continue;
        const candidate = hslToHex(h, s, next);
        const ratio = contrastRatio(candidate, bgHex);
        if (ratio > bestRatio) {
          bestRatio = ratio;
          best = candidate;
        }
        if (ratio >= target) return candidate;
      }
    }
    return best;
  }

  // A "role" is a primary/secondary/tertiary accent: a readable tone for use on
  // the scheme's surfaces, a dark tone to put text on top of it, and a mid
  // container tone with its own readable on-color — mirrors M3's tone
  // relationships (dark: ~T80/T20/T30/T90, light: ~T40/T99/T88/T18) without the
  // full HCT math.
  function deriveRole(seedHex, scheme) {
    const { h, s } = hexToHsl(seedHex);
    if (scheme === "light") {
      // HSL saturation lies about pastels (a pale lavender reads as 100%), and
      // at L40 that would give a garish accent — cap it well below the dark
      // formula, the way M3's light tones behave.
      const roleSat = Math.min(60, s * 0.35 + 12);
      return {
        role: hslToHex(h, roleSat, 40),
        onRole: hslToHex(h, Math.min(60, s * 0.6), 99),
        container: hslToHex(h, Math.min(70, s * 0.7 + 10), 88),
        onContainer: hslToHex(h, Math.min(40, s * 0.3), 18),
      };
    }
    return {
      role: hslToHex(h, Math.min(90, s * 0.9 + 10), 78),
      onRole: hslToHex(h, Math.min(60, s * 0.6), 15),
      container: hslToHex(h, Math.min(70, s * 0.7 + 10), 32),
      onContainer: hslToHex(h, Math.min(40, s * 0.3), 92),
    };
  }

  function deriveSurfaces(seedHex, scheme) {
    const { h } = hexToHsl(seedHex);
    // surfaces stay near-neutral so widget text stays legible
    const sat = scheme === "light" ? 10 : 12;
    if (scheme === "light") {
      return {
        dim: hslToHex(h, sat, 87),
        base: hslToHex(h, sat, 98),
        bright: hslToHex(h, sat, 100),
        containerLowest: hslToHex(h, sat, 100),
        containerLow: hslToHex(h, sat, 96),
        container: hslToHex(h, sat, 93),
        containerHigh: hslToHex(h, sat, 90),
        containerHighest: hslToHex(h, sat, 87),
        onSurface: hslToHex(h, 8, 12),
        onSurfaceVariant: hslToHex(h, 8, 32),
        outline: hslToHex(h, 10, 46),
        outlineVariant: hslToHex(h, 10, 70),
      };
    }
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

  // Dark is the app's own scheme and the default for themes saved before the
  // scheme existed; light derives the same token set from a bright surface
  // scale so a theme can be legible over bright game footage.
  const SCHEMES = ["dark", "light"];

  // Пресеты кривой появления алертов. Хранится ключ, в токен идёт готовая
  // cubic-bezier-строка — так UI не может вылить произвольный CSS в тему.
  const ALERT_EASINGS = {
    smooth: "cubic-bezier(0.05, 0.7, 0.1, 1)",
    decelerate: "cubic-bezier(0, 0, 0.2, 1)",
    spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    sharp: "cubic-bezier(0.4, 0, 0.2, 1)",
    linear: "linear",
  };

  function shapeTokens(mode, primaryHex, surfaceContainerHex, outlineVariantHex, scheme) {
    const light = scheme === "light";
    const glass = hexToRgba(surfaceContainerHex, 0.82);
    const base = {
      "--panel-radius": "24px",
      "--panel-clip": "none",
      "--panel-decoration": "none",
      "--panel-glow": light ? "0 12px 32px rgba(0,0,0,0.18)" : "0 24px 48px rgba(0,0,0,0.45)",
      "--panel-bg": glass,
      "--panel-blur": "20px",
      "--panel-border": light ? "1px solid rgba(0, 0, 0, 0.10)" : "1px solid rgba(255, 255, 255, 0.12)",
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

  // seeds: { primary, secondary, tertiary, surfaceSeed, error?, shapeMode,
  //          mode?: "dark" | "light", fontPreset, alertEnterDuration?,
  //          alertEnterEasing?, fontDisplay?, fontBody?, fontMono?,
  //          panelRadius?, panelBorderWidth?, panelBorderStyle?,
  //          panelBorderColor?, panelGlowColor?, panelGlowStrength?,
  //          background?, text?, panelOpacity?, panelBlur? }
  // Optional granular fields override the preset/derived token only when set.
  function buildThemeTokens(seeds) {
    const scheme = SCHEMES.includes(seeds.mode) ? seeds.mode : "dark";
    const light = scheme === "light";
    const primary = deriveRole(seeds.primary, scheme);
    const secondary = deriveRole(seeds.secondary, scheme);
    const tertiary = deriveRole(seeds.tertiary, scheme);
    const error = seeds.error && String(seeds.error).trim() ? deriveRole(seeds.error, scheme) : null;
    const surf = deriveSurfaces(seeds.surfaceSeed || seeds.primary, scheme);
    const fonts = FONT_PRESETS[seeds.fontPreset] || FONT_PRESETS.nebula;
    const shape = shapeTokens(seeds.shapeMode, seeds.primary, surf.container, surf.outlineVariant, scheme);

    // Readability guard: accents and automatic on-surface text are measured
    // against the effective background (the `background` seed when set), so a
    // theme never renders invisible text — e.g. a light background left under
    // the dark scheme, or a bright seed whose derived tone is too light for a
    // light surface. Explicit overrides (background/text) are respected as-is;
    // the editor flags those with its contrast check instead.
    const surfaceHex = seeds.background && String(seeds.background).trim() ? String(seeds.background).trim() : surf.base;
    const onSurfaceHex = seeds.text && String(seeds.text).trim() ? String(seeds.text).trim() : readableOn(surf.onSurface, surfaceHex, 4.5);
    const onSurfaceVariantHex = readableOn(surf.onSurfaceVariant, surfaceHex, 4.5);
    primary.role = readableOn(primary.role, surfaceHex, 4.5);
    primary.onRole = readableOn(primary.onRole, primary.role, 4.5);
    secondary.role = readableOn(secondary.role, surfaceHex, 4.5);
    secondary.onRole = readableOn(secondary.onRole, secondary.role, 4.5);
    tertiary.role = readableOn(tertiary.role, surfaceHex, 4.5);
    tertiary.onRole = readableOn(tertiary.onRole, tertiary.role, 4.5);
    if (error) {
      error.role = readableOn(error.role, surfaceHex, 4.5);
      error.onRole = readableOn(error.onRole, error.role, 4.5);
    }

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
      "--md-error": error ? error.role : light ? "#ba1a1a" : "#ffb4ab",
      "--md-on-error": error ? error.onRole : light ? "#ffffff" : "#690005",
      "--md-error-container": error ? error.container : light ? "#ffdad6" : "#93000a",
      "--md-on-error-container": error ? error.onContainer : light ? "#410002" : "#ffdad6",
      "--md-surface-dim": surf.dim,
      "--md-surface": surf.base,
      "--md-surface-bright": surf.bright,
      "--md-surface-container-lowest": surf.containerLowest,
      "--md-surface-container-low": surf.containerLow,
      "--md-surface-container": surf.container,
      "--md-surface-container-high": surf.containerHigh,
      "--md-surface-container-highest": surf.containerHighest,
      "--md-on-surface": onSurfaceHex,
      "--md-on-surface-variant": onSurfaceVariantHex,
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
    const alertDuration = Number(seeds.alertEnterDuration);
    if (seeds.alertEnterDuration !== "" && seeds.alertEnterDuration != null && Number.isFinite(alertDuration)) {
      tokens["--alert-enter-duration"] = `${Math.max(0, Math.min(2000, Math.round(alertDuration)))}ms`;
    }
    const alertEasing = ALERT_EASINGS[seeds.alertEnterEasing];
    if (alertEasing) tokens["--alert-enter-easing"] = alertEasing;
    const opacity = Number(seeds.panelOpacity);
    if (seeds.panelOpacity !== "" && seeds.panelOpacity != null && Number.isFinite(opacity)) {
      tokens["--panel-bg"] = hexToRgba(surf.container, Math.max(0, Math.min(100, opacity)) / 100);
    }
    if ((seeds.panelBorderWidth && String(seeds.panelBorderWidth).trim()) || (seeds.panelBorderStyle && String(seeds.panelBorderStyle).trim()) || (seeds.panelBorderColor && String(seeds.panelBorderColor).trim())) {
      tokens["--panel-border"] = overridePanelBorder(tokens["--panel-border"], seeds.panelBorderWidth, seeds.panelBorderStyle, seeds.panelBorderColor);
    }

    return tokens;
  }

  const api = {
    hexToHsl,
    hslToHex,
    hexToRgba,
    deriveRole,
    deriveSurfaces,
    buildThemeTokens,
    contrastRatio,
    FONT_PRESETS,
    SHAPE_MODES,
    SCHEMES,
    ALERT_EASINGS,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.ThemeEngine = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
