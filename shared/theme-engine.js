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
      "--font-display": '"Roboto", "Google Sans", "Segoe UI", sans-serif',
      "--font-body": '"Roboto", "Segoe UI", sans-serif',
      "--font-mono": '"Roboto Mono", "Consolas", monospace',
    },
    orbital: {
      "--font-display": '"Orbitron", "Segoe UI", sans-serif',
      "--font-body": '"Rajdhani", "Segoe UI", sans-serif',
      "--font-mono": '"Orbitron", "Consolas", monospace',
    },
  };

  function shapeTokens(mode, primaryHex, surfaceContainerHex, outlineVariantHex) {
    if (mode === "angular") {
      return {
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
    }
    return {
      "--panel-radius": "24px",
      "--panel-clip": "none",
      "--panel-decoration": "none",
      "--panel-glow": "0 24px 48px rgba(0,0,0,0.45)",
      "--panel-bg": hexToRgba(surfaceContainerHex, 0.82),
      "--panel-blur": "20px",
      "--panel-border": "1px solid rgba(255, 255, 255, 0.12)",
      "--alert-enter-easing": "cubic-bezier(0.05, 0.7, 0.1, 1)",
      "--alert-enter-duration": "480ms",
    };
  }

  // seeds: { primary, secondary, tertiary, surfaceSeed, shapeMode: 'rounded'|'angular', fontPreset }
  function buildThemeTokens(seeds) {
    const primary = deriveRole(seeds.primary);
    const secondary = deriveRole(seeds.secondary);
    const tertiary = deriveRole(seeds.tertiary);
    const surf = deriveSurfaces(seeds.surfaceSeed || seeds.primary);
    const fonts = FONT_PRESETS[seeds.fontPreset] || FONT_PRESETS.nebula;
    const shape = shapeTokens(seeds.shapeMode, seeds.primary, surf.container, surf.outlineVariant);

    return {
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
  }

  const api = { hexToHsl, hslToHex, hexToRgba, deriveRole, deriveSurfaces, buildThemeTokens, FONT_PRESETS };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.ThemeEngine = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
