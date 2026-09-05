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
  Standalone custom-theme editor window. Owns the full theme form that used to
  live inline in the control panel: name, colors, panel shape, fonts, borders,
  glow and the custom CSS hand-off. Saves via the WebSocket bus and live-pushes
  a draft preview so the overlay / control-panel canvas follow every edit.
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

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const escapeAttr = (s) => String(s).replace(/"/g, "&quot;");
  const val = (v) => escapeAttr(v == null ? "" : v);

  let ws = null;
  let initData = null;
  let localesReady = false;
  let theme = null; // { id, name, seeds } | null
  let seeds = null;
  let draftTimer = null;

  function send(type, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
  }

  function fontSelect(id, current) {
    let found = false;
    const options = [`<option value="">${escapeHtml(t("themeEditor.auto"))}</option>`];
    THEME_FONTS.forEach((f) => {
      const selected = current === f.value;
      if (selected) found = true;
      options.push(`<option value="${escapeAttr(f.value)}"${selected ? " selected" : ""}>${escapeHtml(f.label)}</option>`);
    });
    if (current && !found) {
      options.push(`<option value="${escapeAttr(current)}" selected>${escapeHtml(current)}</option>`);
    }
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

  function connect() {
    ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.onmessage = (ev) => {
      try { handleMessage(JSON.parse(ev.data)); } catch (_) { /* ignore */ }
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
    if (initData && localesReady) buildForm();
  }

  function previewFromForm() {
    return {
      primary: document.getElementById("seedPrimary").value,
      secondary: document.getElementById("seedSecondary").value,
      tertiary: document.getElementById("seedTertiary").value,
      surfaceSeed: document.getElementById("seedSurface").value,
      shapeMode: document.getElementById("seedShape").value,
      fontPreset: document.getElementById("seedFont").value,
      fontDisplay: document.getElementById("seedFontDisplay").value.trim(),
      fontBody: document.getElementById("seedFontBody").value.trim(),
      fontMono: document.getElementById("seedFontMono").value.trim(),
      panelRadius: document.getElementById("seedPanelRadius").value.trim(),
      panelBorderWidth: document.getElementById("seedPanelBorderWidth").value.trim(),
      panelBorderStyle: document.getElementById("seedPanelBorderStyle").value,
      panelBorderColor: document.getElementById("seedPanelBorderColorAuto").checked ? "" : document.getElementById("seedPanelBorderColor").value,
      panelGlowColor: document.getElementById("seedPanelGlowAuto").checked ? "" : document.getElementById("seedPanelGlowColor").value,
      panelGlowStrength: Number(document.getElementById("seedPanelGlowStrength").value),
      background: document.getElementById("seedBackgroundAuto").checked ? "" : document.getElementById("seedBackground").value,
      text: document.getElementById("seedTextAuto").checked ? "" : document.getElementById("seedText").value,
      panelOpacity: document.getElementById("seedPanelOpacityAuto").checked ? "" : document.getElementById("seedPanelOpacity").value,
      panelBlur: document.getElementById("seedPanelBlurAuto").checked ? "" : (document.getElementById("seedPanelBlur").value + "px"),
      customCss: document.getElementById("seedCustomCss").value,
    };
  }

  function sendDraft() {
    const liveSeeds = previewFromForm();
    send(EVENT_TYPES.CMD_PREVIEW_THEME_DRAFT, {
      tokens: ThemeEngine.buildThemeTokens(liveSeeds),
      customCss: liveSeeds.customCss,
      themeId: (theme && theme.id) || "",
      name: document.getElementById("themeName").value.trim() || t("themeEditor.myTheme"),
    });
  }

  function closeWindow() {
    send(EVENT_TYPES.CMD_PREVIEW_THEME_DRAFT, { clear: true });
    setTimeout(() => window.desktop.closeCurrentWindow(), 60);
  }

  function buildForm() {
    theme = (initData && initData.theme) || null;
    seeds = (theme && theme.seeds)
      ? theme.seeds
      : {
          primary: "#c6b8ff", secondary: "#7ee0d6", tertiary: "#ffb0d8", surfaceSeed: "#8878c8",
          shapeMode: "rounded", fontPreset: "nebula",
          fontDisplay: "", fontBody: "", fontMono: "",
          panelRadius: "", panelBorderWidth: "", panelBorderStyle: "", panelBorderColor: "", panelGlowColor: "", panelGlowStrength: 40,
          background: "", text: "", panelOpacity: "", panelBlur: "",
          customCss: "",
        };

    const borderColorHex = /^#[0-9a-f]{6}$/i.test(String(seeds.panelBorderColor || "")) ? seeds.panelBorderColor : "#ffffff";
    const borderColorAuto = seeds.panelBorderColor ? "" : "checked";
    const glowColorHex = /^#[0-9a-f]{6}$/i.test(String(seeds.panelGlowColor || "")) ? seeds.panelGlowColor : (seeds.primary || "#c6b8ff");
    const glowStrengthNum = Number(seeds.panelGlowStrength);
    const glowStrength = Number.isFinite(glowStrengthNum) ? Math.max(0, Math.min(100, glowStrengthNum)) : 40;
    const glowAuto = seeds.panelGlowColor ? "" : "checked";

    const currentTokens = ThemeEngine.buildThemeTokens(seeds);
    const backgroundHex = /^#[0-9a-f]{6}$/i.test(String(seeds.background || "")) ? seeds.background : (currentTokens["--md-surface"] || "#1f1c26");
    const backgroundAuto = seeds.background ? "" : "checked";
    const textHex = /^#[0-9a-f]{6}$/i.test(String(seeds.text || "")) ? seeds.text : (currentTokens["--md-on-surface"] || "#e6e1e5");
    const textAuto = seeds.text ? "" : "checked";
    const opacityNum = Number(seeds.panelOpacity);
    const opacityValue = Number.isFinite(opacityNum) ? Math.max(0, Math.min(100, opacityNum)) : 100;
    const opacityAuto = seeds.panelOpacity === "" || seeds.panelOpacity == null ? "checked" : "";
    const blurValue = Math.max(0, Math.min(40, parseFloat(seeds.panelBlur) || 20));
    const blurAuto = seeds.panelBlur ? "" : "checked";

    const shapeOptions = [
      { value: "rounded", label: t("themeEditor.rounded") },
      { value: "angular", label: t("themeEditor.angular") },
      { value: "sharp", label: t("themeEditor.shapeSharp") },
      { value: "soft", label: t("themeEditor.shapeSoft") },
      { value: "pill", label: t("themeEditor.shapePill") },
      { value: "brackets4", label: t("themeEditor.shapeBrackets4") },
      { value: "hazard", label: t("themeEditor.shapeHazard") },
    ];
    const shapeOptionsHtml = shapeOptions
      .map((o) => `<option value="${o.value}" ${seeds.shapeMode === o.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`)
      .join("");

    document.getElementById("titleLabel").textContent = theme ? t("themeEditor.editTitle") : t("themeEditor.createTitle");
    document.getElementById("saveBtn").textContent = t("themeEditor.save");
    document.getElementById("cancelBtn").textContent = t("themeEditor.cancel");

    const form = document.getElementById("form");
    form.innerHTML = `
      <div class="md-field"><label>${t("themeEditor.themeName")}</label><input type="text" id="themeName" value="${escapeAttr(theme ? theme.name : t("themeEditor.myTheme"))}"></div>
      <div class="theme-editor__colors">
        <div class="theme-editor__color"><label>${t("themeEditor.primary")}</label><input type="color" id="seedPrimary" value="${val(seeds.primary)}"></div>
        <div class="theme-editor__color"><label>${t("themeEditor.secondary")}</label><input type="color" id="seedSecondary" value="${val(seeds.secondary)}"></div>
        <div class="theme-editor__color"><label>${t("themeEditor.tertiary")}</label><input type="color" id="seedTertiary" value="${val(seeds.tertiary)}"></div>
        <div class="theme-editor__color"><label>${t("themeEditor.surface")}</label><input type="color" id="seedSurface" value="${val(seeds.surfaceSeed)}"></div>
      </div>
      <div class="theme-editor__section">
        <div class="theme-editor__section-title">${t("themeEditor.surfaceColors")}</div>
        <div class="theme-editor__grid theme-editor__grid--2">
          <div class="md-field">
            <label>${t("themeEditor.background")}</label>
            <div class="theme-editor__color-row">
              <input type="color" id="seedBackground" value="${backgroundHex}">
              <label class="theme-editor__auto"><input type="checkbox" id="seedBackgroundAuto" ${backgroundAuto}> ${t("themeEditor.auto")}</label>
            </div>
          </div>
          <div class="md-field">
            <label>${t("themeEditor.text")}</label>
            <div class="theme-editor__color-row">
              <input type="color" id="seedText" value="${textHex}">
              <label class="theme-editor__auto"><input type="checkbox" id="seedTextAuto" ${textAuto}> ${t("themeEditor.auto")}</label>
            </div>
          </div>
        </div>
      </div>
      <div class="theme-editor__row">
        <div class="md-field"><label>${t("themeEditor.shape")}</label>
          <select id="seedShape">${shapeOptionsHtml}</select>
        </div>
        <div class="md-field"><label>${t("themeEditor.fonts")}</label>
          <select id="seedFont">
            <option value="nebula" ${seeds.fontPreset !== "orbital" ? "selected" : ""}>Manrope / JetBrains Mono (Material You)</option>
            <option value="orbital" ${seeds.fontPreset === "orbital" ? "selected" : ""}>Orbitron / Rajdhani (Orbital)</option>
          </select>
        </div>
      </div>
      <div class="theme-editor__section">
        <div class="theme-editor__section-title">${t("themeEditor.fontOverrides")}</div>
        <div class="theme-editor__grid theme-editor__grid--3">
          <div class="md-field"><label>${t("themeEditor.fontDisplay")}</label>${fontSelect("seedFontDisplay", seeds.fontDisplay)}</div>
          <div class="md-field"><label>${t("themeEditor.fontBody")}</label>${fontSelect("seedFontBody", seeds.fontBody)}</div>
          <div class="md-field"><label>${t("themeEditor.fontMono")}</label>${fontSelect("seedFontMono", seeds.fontMono)}</div>
        </div>
      </div>
      <div class="theme-editor__section">
        <div class="theme-editor__section-title">${t("themeEditor.panelOverrides")}</div>
        <div class="theme-editor__grid theme-editor__grid--2">
          <div class="md-field"><label>${t("themeEditor.panelRadius")}</label><input type="text" id="seedPanelRadius" value="${val(seeds.panelRadius)}" placeholder="24px"></div>
          <div class="md-field"><label>${t("themeEditor.panelBorderWidth")}</label><input type="text" id="seedPanelBorderWidth" value="${val(seeds.panelBorderWidth)}" placeholder="1px"></div>
          <div class="md-field">
            <label>${t("themeEditor.panelBorderColor")}</label>
            <div class="theme-editor__color-row">
              <input type="color" id="seedPanelBorderColor" value="${borderColorHex}">
              <label class="theme-editor__auto"><input type="checkbox" id="seedPanelBorderColorAuto" ${borderColorAuto}> ${t("themeEditor.auto")}</label>
            </div>
          </div>
          <div class="md-field">
            <label>${t("themeEditor.panelBorderStyle")}</label>
            <select id="seedPanelBorderStyle">
              <option value="">${t("themeEditor.auto")}</option>
              <option value="solid" ${seeds.panelBorderStyle === "solid" ? "selected" : ""}>Solid</option>
              <option value="dashed" ${seeds.panelBorderStyle === "dashed" ? "selected" : ""}>Dashed</option>
              <option value="dotted" ${seeds.panelBorderStyle === "dotted" ? "selected" : ""}>Dotted</option>
              <option value="double" ${seeds.panelBorderStyle === "double" ? "selected" : ""}>Double</option>
            </select>
          </div>
        </div>
        <div class="theme-editor__glow">
          <div class="theme-editor__glow-line">
            <span class="theme-editor__glow-label">${t("themeEditor.panelGlow")}</span>
            <label class="theme-editor__auto"><input type="checkbox" id="seedPanelGlowAuto" ${glowAuto}> ${t("themeEditor.auto")}</label>
          </div>
          <div class="theme-editor__glow-controls">
            <input type="color" id="seedPanelGlowColor" value="${glowColorHex}" title="${escapeAttr(t("themeEditor.panelGlowColor"))}">
            <input type="range" id="seedPanelGlowStrength" min="0" max="100" step="1" value="${glowStrength}">
            <span class="theme-editor__glow-value" id="seedPanelGlowValue">${glowStrength}%</span>
          </div>
        </div>
        <div class="theme-editor__glow">
          <div class="theme-editor__glow-line">
            <span class="theme-editor__glow-label">${t("themeEditor.panelOpacity")}</span>
            <label class="theme-editor__auto"><input type="checkbox" id="seedPanelOpacityAuto" ${opacityAuto}> ${t("themeEditor.auto")}</label>
          </div>
          <div class="theme-editor__glow-controls">
            <input type="range" id="seedPanelOpacity" min="0" max="100" step="1" value="${opacityValue}">
            <span class="theme-editor__glow-value" id="seedPanelOpacityValue">${opacityValue}%</span>
          </div>
        </div>
        <div class="theme-editor__glow">
          <div class="theme-editor__glow-line">
            <span class="theme-editor__glow-label">${t("themeEditor.panelBlur")}</span>
            <label class="theme-editor__auto"><input type="checkbox" id="seedPanelBlurAuto" ${blurAuto}> ${t("themeEditor.auto")}</label>
          </div>
          <div class="theme-editor__glow-controls">
            <input type="range" id="seedPanelBlur" min="0" max="40" step="1" value="${blurValue}">
            <span class="theme-editor__glow-value" id="seedPanelBlurValue">${blurValue}px</span>
          </div>
        </div>
        <div class="theme-editor__reset">
          <button class="md-button md-button--text" id="resetOverridesBtn" type="button">${t("themeEditor.resetOverrides")}</button>
        </div>
      </div>
      <div class="theme-editor__section">
        <div class="theme-editor__section-title">${t("themeEditor.customCss")}</div>
        <textarea id="seedCustomCss" hidden>${escapeHtml(seeds.customCss || "")}</textarea>
        <div class="theme-editor__actions">
          <button class="md-button md-button--outlined" id="editCssBtn">${t("themeEditor.editCss")}</button>
          <button class="md-button md-button--outlined" id="previewThemeBtn">${t("themeEditor.previewInWindow")}</button>
          <button class="md-button md-button--outlined" id="samplesBtn">${t("themeEditor.samples")}</button>
        </div>
        <div class="md-field__hint">${t("themeEditor.customCssHint")}</div>
      </div>`;

    // Live draft on any input (debounced).
    const onFormInput = () => {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(sendDraft, 200);
    };
    form.querySelectorAll("input, select, textarea").forEach((el) => el.addEventListener("input", onFormInput));

    document.getElementById("seedPanelBorderColor").addEventListener("input", () => {
      document.getElementById("seedPanelBorderColorAuto").checked = false;
    });

    const glowColorEl = document.getElementById("seedPanelGlowColor");
    const glowStrengthEl = document.getElementById("seedPanelGlowStrength");
    const glowValueEl = document.getElementById("seedPanelGlowValue");
    const glowAutoEl = document.getElementById("seedPanelGlowAuto");
    const syncGlowValue = () => { glowValueEl.textContent = glowStrengthEl.value + "%"; };
    glowColorEl.addEventListener("input", () => { glowAutoEl.checked = false; });
    glowStrengthEl.addEventListener("input", () => { glowAutoEl.checked = false; syncGlowValue(); });

    document.getElementById("seedBackground").addEventListener("input", () => {
      document.getElementById("seedBackgroundAuto").checked = false;
    });
    document.getElementById("seedText").addEventListener("input", () => {
      document.getElementById("seedTextAuto").checked = false;
    });

    const opacityEl = document.getElementById("seedPanelOpacity");
    const opacityValueEl = document.getElementById("seedPanelOpacityValue");
    const opacityAutoEl = document.getElementById("seedPanelOpacityAuto");
    opacityEl.addEventListener("input", () => { opacityAutoEl.checked = false; opacityValueEl.textContent = opacityEl.value + "%"; });

    const blurEl = document.getElementById("seedPanelBlur");
    const blurValueEl = document.getElementById("seedPanelBlurValue");
    const blurAutoEl = document.getElementById("seedPanelBlurAuto");
    blurEl.addEventListener("input", () => { blurAutoEl.checked = false; blurValueEl.textContent = blurEl.value + "px"; });

    document.getElementById("resetOverridesBtn").addEventListener("click", () => {
      document.getElementById("seedFontDisplay").value = "";
      document.getElementById("seedFontBody").value = "";
      document.getElementById("seedFontMono").value = "";
      document.getElementById("seedPanelRadius").value = "";
      document.getElementById("seedPanelBorderWidth").value = "";
      document.getElementById("seedPanelBorderStyle").value = "";
      document.getElementById("seedPanelBorderColorAuto").checked = true;
      document.getElementById("seedPanelGlowAuto").checked = true;
      document.getElementById("seedBackgroundAuto").checked = true;
      document.getElementById("seedTextAuto").checked = true;
      document.getElementById("seedPanelOpacityAuto").checked = true;
      document.getElementById("seedPanelBlurAuto").checked = true;
      syncGlowValue();
      sendDraft();
    });

    document.getElementById("editCssBtn").addEventListener("click", () => {
      const cssField = document.getElementById("seedCustomCss");
      const themeTokens = ThemeEngine.buildThemeTokens(previewFromForm());
      const initial = (cssField.value || "").trim() ? cssField.value : defaultCustomCss(themeTokens);
      const selectors = [":root", "body", "#canvas", ".md-card", ".md-linear-progress", ...Object.values(WIDGET_TYPES).map((d) => ".widget-" + d.type)];
      window.desktop.openCssEditor({
        css: initial,
        tokens: Object.keys(BuiltinThemes.BUILTIN_THEMES.nebula.tokens),
        selectors,
        strings: {
          title: t("themeEditor.cssEditorTitle"),
          synced: t("themeEditor.cssSynced"),
          done: t("themeEditor.cssEditorDone"),
          line: t("themeEditor.cssLine"),
          column: t("themeEditor.cssColumn"),
          chars: t("themeEditor.cssChars"),
          undo: t("themeEditor.cssUndo"),
          redo: t("themeEditor.cssRedo"),
          selectAll: t("themeEditor.cssSelectAll"),
          clear: t("themeEditor.cssClear"),
          copy: t("themeEditor.cssCopy"),
          find: t("themeEditor.cssFind"),
          replace: t("themeEditor.cssReplace"),
          replaceOne: t("themeEditor.cssReplaceOne"),
          replaceAll: t("themeEditor.cssReplaceAll"),
          close: t("themeEditor.cssClose"),
          findPlaceholder: t("themeEditor.cssFindPlaceholder"),
          replacePlaceholder: t("themeEditor.cssReplacePlaceholder"),
          syntax: t("themeEditor.cssIssueSyntax"),
          unknownProp: t("themeEditor.cssIssueUnknownProperty", { name: "%s" }),
          invalidValue: t("themeEditor.cssIssueInvalidValue", { value: "%s" }),
        },
      });
    });

    document.getElementById("previewThemeBtn").addEventListener("click", () => {
      window.desktop.openThemePreview();
      sendDraft();
      setTimeout(sendDraft, 400);
    });

    document.getElementById("samplesBtn").addEventListener("click", () => {
      window.desktop.openThemeSamples();
      sendDraft();
      setTimeout(sendDraft, 400);
    });

    document.getElementById("saveBtn").addEventListener("click", () => {
      if (theme && !confirm(t("themeEditor.overwriteConfirm"))) return;
      const liveSeeds = previewFromForm();
      send(EVENT_TYPES.CMD_SAVE_CUSTOM_THEME, {
        id: theme ? theme.id : null,
        name: document.getElementById("themeName").value.trim() || t("themeEditor.myTheme"),
        seeds: liveSeeds,
      });
      closeWindow();
    });

    document.getElementById("cancelBtn").addEventListener("click", closeWindow);

    sendDraft();
  }

  // Global listeners (registered once; `buildForm` may run again on reopen).
  window.desktop.onCssEditorUpdated((css) => {
    const cssField = document.getElementById("seedCustomCss");
    if (!cssField) return;
    cssField.value = String(css || "");
    sendDraft();
  });

  window.desktop.onThemeEditorInit((data) => {
    initData = data || {};
    if (localesReady) buildForm();
  });

  window.addEventListener("beforeunload", () => send(EVENT_TYPES.CMD_PREVIEW_THEME_DRAFT, { clear: true }));

  connect();
  bootstrap();
})();
