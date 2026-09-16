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
  Properties inspector for the overlay widgets.

  Single responsibility: render the selected widget's editable properties and
  wire the form controls back to the server through the shared `send` callback.

  It owns the full inspector lifecycle (`renderProperties`) plus its two private
  helpers for socials (`wireWidgetSocialsList`) and custom-widget fields
  (`wireCustomWidgetFields`). It reads the live `state` object, so every render
  reflects the latest snapshot. Dynamic sub-elements are queried fresh via
  `document.getElementById` because the inspector's inner HTML is rebuilt on
  every render (cached lookups would go stale).
*/

import { el } from "./dom.js";

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function initPropertiesPanel({
  state,
  t,
  ICONS,
  WIDGET_TYPES,
  resolveTypeForTheme,
  EVENT_TYPES,
  send,
  switchHtml,
  wireSwitch,
  escapeAttr,
  round1,
  sendMicCaptureConfig,
  refreshMicDevices,
}) {
  const propertiesSection = el("propertiesSection");
  const propertiesTitle = el("propertiesTitle");
  const propertiesEl = el("properties");

  function wireWidgetSocialsList(inst, socials) {
    const host = document.getElementById("pSocialsList");
    host.innerHTML = socials
      .map(
        (s, i) => `
      <div class="scene-social-row">
        <input type="text" class="platform" data-idx="${i}" data-field="platform" value="${escapeAttr(s.platform)}" maxlength="4">
        <input type="text" class="text" data-idx="${i}" data-field="text" value="${escapeAttr(s.text)}">
        <button class="layer-row__btn" data-action="remove-social" data-idx="${i}" title="${t("common.remove")}">${ICONS.trash}</button>
      </div>`
      )
      .join("");
    host.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("change", () => {
        const idx = Number(inp.dataset.idx);
        const field = inp.dataset.field;
        const newSocials = socials.map((s, i) => (i === idx ? { ...s, [field]: inp.value } : s));
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { socials: newSocials } } });
      });
    });
    host.querySelectorAll('[data-action="remove-social"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const newSocials = socials.filter((_, i) => i !== idx);
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { socials: newSocials } } });
      });
    });
  }

  function wireCustomWidgetFields(inst, config) {
    const mode = config.mode || "text";
    const host = document.getElementById("pCustomFields");
    if (mode === "image") {
      host.innerHTML = `
        <div class="md-field"><label>${t("custom.imageUrl")}</label>
          <div class="sb-file"><input type="text" id="pImageUrl" value="${escapeAttr(config.imageUrl || "")}" placeholder="https://..."><button class="md-button md-button--text" type="button" id="pImageBrowse" title="${t("custom.imageFromDisk")}">📁</button></div>
        </div>
        <div class="md-field"><label>${t("custom.imageFit")}</label>
          <select id="pImageFit">
            <option value="contain" ${config.imageFit !== "cover" ? "selected" : ""}>${t("custom.fitContain")}</option>
            <option value="cover" ${config.imageFit === "cover" ? "selected" : ""}>${t("custom.fitCover")}</option>
          </select>
        </div>`;
      const imageUrlInput = host.querySelector("#pImageUrl");
      imageUrlInput.addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { imageUrl: e.target.value.trim() } } }));
      host.querySelector("#pImageBrowse").addEventListener("click", async () => {
        if (!window.desktop || !window.desktop.pickSoundFile) return;
        const res = await window.desktop.pickSoundFile("image");
        if (res && res.ok && res.relativePath) {
          imageUrlInput.value = res.relativePath;
          send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { imageUrl: res.relativePath } } });
        }
      });
      host.querySelector("#pImageFit").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { imageFit: e.target.value } } }));
    } else if (mode === "html") {
      host.innerHTML = `
        <div class="properties__hint">${t("custom.htmlHint")}</div>
        <button class="md-button md-button--filled" id="pOpenEditor" style="width:100%;justify-content:center;">${t("custom.editCode")}</button>`;
      host.querySelector("#pOpenEditor").addEventListener("click", () => window.desktop?.openWidgetEditor(inst.id));
    } else if (mode === "embed") {
      host.innerHTML = `
        <div class="md-field"><label>${t("custom.embedUrl")}</label><input type="text" id="pCustomEmbedUrl" value="${escapeAttr(config.embedUrl || "")}" placeholder="https://..."></div>
        <div class="properties__hint">${t("custom.embedHint")}</div>`;
      host.querySelector("#pCustomEmbedUrl").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { embedUrl: e.target.value.trim() } } }));
    } else {
      host.innerHTML = `
        <div class="md-field"><label>${t("custom.textTitle")}</label><input type="text" id="pTextTitle" value="${escapeAttr(config.textTitle || "")}"></div>
        <div class="md-field"><label>${t("custom.textBody")}</label><input type="text" id="pTextBody" value="${escapeAttr(config.text || "")}"></div>
        <div class="properties__row">
          <div class="md-field"><label>${t("custom.textAlign")}</label>
            <select id="pTextAlign">
              <option value="left" ${config.textAlign === "left" ? "selected" : ""}>${t("custom.alignLeft")}</option>
              <option value="center" ${config.textAlign !== "left" && config.textAlign !== "right" ? "selected" : ""}>${t("custom.alignCenter")}</option>
              <option value="right" ${config.textAlign === "right" ? "selected" : ""}>${t("custom.alignRight")}</option>
            </select>
          </div>
          <div class="md-field"><label>${t("custom.textSize")}</label>
            <select id="pTextSize">
              <option value="small" ${config.textSize === "small" ? "selected" : ""}>${t("custom.sizeSmall")}</option>
              <option value="medium" ${config.textSize !== "small" && config.textSize !== "large" ? "selected" : ""}>${t("custom.sizeMedium")}</option>
              <option value="large" ${config.textSize === "large" ? "selected" : ""}>${t("custom.sizeLarge")}</option>
            </select>
          </div>
        </div>
        <div class="properties__toggle-row"><label>${t("custom.showBg")}</label>${switchHtml("pShowBg", config.showBackground !== false)}</div>`;
      host.querySelector("#pTextTitle").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { textTitle: e.target.value } } }));
      host.querySelector("#pTextBody").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { text: e.target.value } } }));
      host.querySelector("#pTextAlign").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { textAlign: e.target.value } } }));
      host.querySelector("#pTextSize").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { textSize: e.target.value } } }));
      wireSwitch(host.querySelector("#pShowBg"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showBackground: on } } }));
    }
  }

  let lastSig = null;

  function invalidate() {
    lastSig = null;
  }

  function render(force) {
    const raw = state.layout.find((w) => w.id === state.selectedId);
    if (!raw) {
      propertiesSection.hidden = true;
      lastSig = null;
      return;
    }
    propertiesSection.hidden = false;
    // Resolve the effective type so a 2D widget that is auto-transformed to 3D
    // (or remapped across themes) shows the correct fields (e.g. a 3D chat
    // shows its perspective slider). id/config/geometry stay the raw widget's,
    // so edits still target the right item.
    const type = resolveTypeForTheme
      ? resolveTypeForTheme(raw.type, state.appearance.active3dWidgets || [])
      : raw.type;
    const inst = { ...raw, type };
    // Полная перерисовка нужна только при смене виджета/набора полей (например,
    // режима визуализатора). Иначе обновление значения (слайдер/цвет) не должно
    // пересоздавать элемент под курсором и ломать перетаскивание.
    const micMode =
      type === "mic"
        ? (raw.config && raw.config.visualizer_mode) || (state.micConfig && state.micConfig.visualizer_mode) || ""
        : "";
    const sig = `${raw.id}|${raw.type}|${type}|${micMode}|${(state.micDevices || []).length}`;
    if (!force && sig === lastSig && propertiesEl.contains(document.activeElement)) return;
    lastSig = sig;
    const def = WIDGET_TYPES[type] || {};
    propertiesTitle.textContent = t("widgets." + (def.type || type));
    const config = inst.config || {};

    let extraHtml = "";
    if (inst.type === "goal" || inst.type === "grimhex-goal" || inst.type === "nuclear-goal" || inst.type === "cobra-goal" || inst.type === "md3-goal" || inst.type === "pixel-goal" || inst.type === "teso-goal") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.goalTitle")}</label><input type="text" id="pGoalTitle" value="${escapeAttr(state.goal.title || "")}"></div>
        <div class="properties__row">
          <div class="md-field"><label>${t("properties.current")}</label><input type="number" id="pGoalCurrent" value="${state.goal.current || 0}"></div>
          <div class="md-field"><label>${t("properties.target")}</label><input type="number" id="pGoalTarget" value="${state.goal.target || 0}"></div>
        </div>
        <div class="md-field"><label>${t("properties.currency")}</label><input type="text" id="pGoalCurrency" value="${escapeAttr(state.goal.currency || "")}"></div>
        <div class="properties__toggle-row"><label>${t("properties.showPercent")}</label>${switchHtml("pShowPercent", !!config.showPercentage)}</div>
        <div class="properties__toggle-row"><label>${t("properties.showBackground")}</label>${switchHtml("pShowBackground", config.showBackground !== false)}</div>`;
    } else if (inst.type === "chat") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.maxMessages")}</label><input type="number" id="pMaxMessages" min="1" max="20" value="${config.maxMessages || 8}"></div>
        <div class="properties__toggle-row"><label>${t("properties.showBadges")}</label>${switchHtml("pShowBadges", config.showBadges !== false)}</div>`;
    } else if (inst.type === "grimhex-chat" || inst.type === "nuclear-chat" || inst.type === "cobra-chat" || inst.type === "md3-chat" || inst.type === "pixel-chat" || inst.type === "teso-chat") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.maxMessages")}</label><input type="number" id="pMaxMessages" min="1" max="100" value="${config.maxMessages || 50}"></div>
        <div class="md-field"><label>${t("properties.perspective")}: <span id="pPerspectiveValue">${config.perspective || 0}</span></label><input type="range" id="pPerspective" min="0" max="100" step="1" value="${config.perspective || 0}"></div>`;
    } else if (inst.type === "grimhex" || inst.type === "musain" || inst.type === "nuclear" || inst.type === "cobra" || inst.type === "elite-sign" || inst.type === "teso-seal" || inst.type === "md3-orb" || inst.type === "pixel-cube") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.perspective")}: <span id="pPerspectiveValue">${config.perspective || 0}</span></label><input type="range" id="pPerspective" min="0" max="100" step="1" value="${config.perspective || 0}"></div>`;
    } else if (inst.type === "cobra-shield" || inst.type === "cobra-radar" || inst.type === "grimhex-radar") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.opacity")}: <span id="pOpacityValue">${config.opacity ?? 100}%</span></label><input type="range" id="pOpacity" min="0" max="100" step="1" value="${config.opacity ?? 100}"></div>`;
    } else if (inst.type === "recent") {
      extraHtml = `<div class="md-field"><label>${t("properties.maxItems")}</label><input type="number" id="pMaxItems" min="1" max="15" value="${config.maxItems || 5}"></div>`;
    } else if (inst.type === "stat") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.statMetric")}</label>
          <select id="pStatMetric">
            <option value="followers" ${(config.metric || "followers") === "followers" ? "selected" : ""}>${t("properties.metricFollowers")}</option>
            <option value="subscribers" ${config.metric === "subscribers" ? "selected" : ""}>${t("properties.metricSubscribers")}</option>
            <option value="latestFollower" ${config.metric === "latestFollower" ? "selected" : ""}>${t("properties.metricLatestFollower")}</option>
            <option value="latestSubscriber" ${config.metric === "latestSubscriber" ? "selected" : ""}>${t("properties.metricLatestSubscriber")}</option>
            <option value="topDonation" ${config.metric === "topDonation" ? "selected" : ""}>${t("properties.metricTopDonation")}</option>
            <option value="sessionDonations" ${config.metric === "sessionDonations" ? "selected" : ""}>${t("properties.metricSessionDonations")}</option>
            <option value="sessionAmount" ${config.metric === "sessionAmount" ? "selected" : ""}>${t("properties.metricSessionAmount")}</option>
          </select>
        </div>
        <div class="md-field"><label>${t("properties.statLabel")}</label><input type="text" id="pStatLabel" value="${escapeAttr(config.label || "")}"></div>
        <div class="properties__hint">${t("properties.statHint")}</div>`;
    } else if (inst.type === "social") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.rotateSec")}</label><input type="number" id="pRotateSec" min="2" value="${config.rotateIntervalSec || 8}"></div>
        <div class="md-field">
          <label>${t("properties.socials")}</label>
          <div class="scene-socials-list" id="pSocialsList"></div>
          <button class="md-button md-button--text" id="pAddSocial" style="align-self:flex-start;margin-top:4px;">+ ${t("properties.addSocial")}</button>
        </div>`;
    } else if (inst.type === "grimhex-timer" || inst.type === "timer") {
      // Источник всегда Longshot: заголовок фиксирован, редактируемых заметки и
      // источника нет — только статус синхронизации и переключатели отображения.
      const ls = state.longshot || null;
      // Скрытый виджет не держит опрос Longshot — говорим об этом прямо,
      // иначе подсказка «ещё нет данных» выглядела бы как поломка.
      const lsStatus =
        raw.visible === false
          ? t("properties.timerRemoteHidden")
          : !ls
            ? t("properties.timerRemotePending")
            : ls.ok
              ? t("properties.timerRemoteOk")
              : t("properties.timerRemoteError", { error: ls.error || "—" });
      extraHtml = `
        <div class="properties__hint">${escapeHtml(lsStatus)}</div>
        <button class="md-button md-button--tonal" id="pTimerRefresh">${t("properties.timerRefresh")}</button>
        <div class="properties__toggle-row"><label>${t("properties.timerShowLights")}</label>${switchHtml("pTimerShowLights", config.showLights !== false)}</div>
        <div class="properties__toggle-row"><label>${t("properties.timerShowCycle")}</label>${switchHtml("pTimerShowCycle", config.showCycle !== false)}</div>
        <div class="properties__toggle-row"><label>${t("properties.timerShowTelemetry")}</label>${switchHtml("pTimerShowTelemetry", config.showTelemetry !== false)}</div>`;
    } else if (inst.type === "mic") {
      // Настройки отображения — на самом виджете (fallback на глобальные).
      const micDef = (key, fallback) => {
        const own = config[key];
        if (own !== undefined && own !== null && own !== "") return own;
        const g = state.micConfig[key];
        if (g !== undefined && g !== null && g !== "") return g;
        return fallback;
      };
      const mode = micDef("visualizer_mode", "sine");
      const themePrimary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#0060A8";
      const micColor = config.color || state.micConfig.color || themePrimary;
      const deviceId = state.micConfig.deviceId || "";
      const devices = Array.isArray(state.micDevices) ? state.micDevices : [];
      const deviceOptions = [
        `<option value="" ${deviceId ? "" : "selected"}>${t("mic.deviceDefault")}</option>`,
        ...devices.map(
          (d) => `<option value="${escapeAttr(d.deviceId)}" ${deviceId === d.deviceId ? "selected" : ""}>${escapeHtml(d.label)}</option>`
        ),
      ].join("");
      const num = (key, fb) => {
        const n = Number(micDef(key, fb));
        return Number.isFinite(n) ? n : fb;
      };

      // Настройки зависят от типа отображения — показываем только релевантные.
      let fields = "";
      if (mode === "sine") {
        fields += `<div class="md-field"><label>${t("mic.sensitivity")}: <span id="pMicSensitivityValue">${num("sensitivity", 1.5)}</span></label><input type="range" id="pMicSensitivity" min="0.2" max="6" step="0.1" value="${num("sensitivity", 1.5)}"></div>`;
      }
      if (mode === "sine" || mode === "ring") {
        fields += `<div class="md-field"><label>${t("mic.lineWidth")}: <span id="pMicLineWidthValue">${num("lineWidth", 2)}</span></label><input type="range" id="pMicLineWidth" min="1" max="12" step="0.5" value="${num("lineWidth", 2)}"></div>`;
      }
      if (mode === "bars" || mode === "ring" || mode === "equalizer") {
        fields += `<div class="md-field"><label>${t("mic.barCount")}: <span id="pMicBarCountValue">${num("barCount", 32)}</span></label><input type="range" id="pMicBarCount" min="10" max="64" step="1" value="${num("barCount", 32)}"></div>`;
      }
      if (mode === "bars" || mode === "equalizer") {
        fields += `<div class="md-field"><label>${t("mic.barGap")}: <span id="pMicBarGapValue">${num("barGap", 2)}</span></label><input type="range" id="pMicBarGap" min="0" max="12" step="0.5" value="${num("barGap", 2)}"></div>`;
      }
      if (mode === "equalizer") {
        fields += `<div class="md-field"><label>${t("mic.peakFall")}: <span id="pMicPeakFallValue">${num("peakFall", 2.5)}</span></label><input type="range" id="pMicPeakFall" min="0.5" max="10" step="0.1" value="${num("peakFall", 2.5)}"></div>
          <p class="properties__hint" style="margin:0;">${t("mic.equalizerPalette")}</p>`;
      }
      if (mode !== "sine") {
        const scale = micDef("freqScale", "log") === "linear" ? "linear" : "log";
        fields += `<div class="md-field"><label>${t("mic.freqScale")}</label>
          <select id="pMicFreqScale">
            <option value="log" ${scale === "log" ? "selected" : ""}>${t("mic.freqScaleLog")}</option>
            <option value="linear" ${scale === "linear" ? "selected" : ""}>${t("mic.freqScaleLinear")}</option>
          </select></div>`;
        fields += `<div class="md-field"><label>${t("mic.smoothing")}: <span id="pMicSmoothingValue">${Math.round(num("smoothing", 0.35) * 100)}%</span></label><input type="range" id="pMicSmoothing" min="0" max="1" step="0.05" value="${num("smoothing", 0.35)}"></div>`;
      }
      fields += `<div class="md-field"><label>${t("mic.gain")}: <span id="pMicGainValue">${num("gain", 1).toFixed(1)}×</span></label><input type="range" id="pMicGain" min="0.1" max="5" step="0.1" value="${num("gain", 1)}"></div>`;
      fields += `<div class="md-field"><label>${t("mic.noiseGate")}: <span id="pMicNoiseGateValue">${Math.round(num("noiseGate", 0) * 100)}%</span></label><input type="range" id="pMicNoiseGate" min="0" max="0.5" step="0.01" value="${num("noiseGate", 0)}"></div>`;
      if (mode !== "equalizer") {
        fields += `<div class="md-field"><label>${t("mic.color")}</label>
          <div class="properties__color-row">
            <input type="color" id="pMicColor" value="${escapeAttr(micColor)}">
            <button class="md-button md-button--text" id="pMicColorReset" title="${t("mic.colorAuto")}">${t("mic.colorAuto")}</button>
          </div>
        </div>`;
      }
      fields += `<div class="md-field"><label>${t("mic.opacity")}: <span id="pMicOpacityValue">${Math.round(num("opacity", 0.9) * 100)}%</span></label><input type="range" id="pMicOpacity" min="5" max="100" step="1" value="${Math.round(num("opacity", 0.9) * 100)}"></div>`;

      const captureHtml = `
        <p class="properties__hint" style="font-weight:600;margin:8px 0 0;">${t("mic.capture")}</p>
        <div class="md-field"><label>${t("mic.device")}</label>
          <div class="properties__row">
            <select id="pMicDevice">${deviceOptions}</select>
            <button class="md-button md-button--text" id="pMicDeviceRefresh" title="${t("mic.deviceRefresh")}">↻</button>
          </div>
        </div>
        <div class="properties__toggle-row"><label>${t("mic.echoCancellation")}</label>${switchHtml("pMicEcho", state.micConfig.echoCancellation !== false)}</div>
        <div class="properties__toggle-row"><label>${t("mic.noiseSuppression")}</label>${switchHtml("pMicNoise", state.micConfig.noiseSuppression !== false)}</div>
        <div class="properties__toggle-row"><label>${t("mic.autoGainControl")}</label>${switchHtml("pMicAgc", state.micConfig.autoGainControl !== false)}</div>
        <div class="md-field"><label>${t("mic.level")}: <span id="pMicLevelValue">0%</span></label>
          <div class="properties__level"><div class="properties__level-fill" id="pMicLevelBar"></div></div>
        </div>`;

      extraHtml = `
        <div class="md-field"><label>${t("mic.mode")}</label>
          <select id="pMicMode">
            <option value="sine" ${mode === "sine" ? "selected" : ""}>${t("mic.modeSine")}</option>
            <option value="bars" ${mode === "bars" ? "selected" : ""}>${t("mic.modeBars")}</option>
            <option value="ring" ${mode === "ring" ? "selected" : ""}>${t("mic.modeRing")}</option>
            <option value="equalizer" ${mode === "equalizer" ? "selected" : ""}>${t("mic.modeEqualizer")}</option>
          </select>
        </div>
        ${fields}
        ${captureHtml}`;
    } else if (inst.type === "death") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.deathLabel")}</label><input type="text" id="pDeathLabel" value="${escapeAttr(config.label || "")}"></div>
        <div class="md-field"><label>${t("properties.deathColor")}</label><input type="color" id="pDeathColor" value="${escapeAttr(config.color || "#ff4d4d")}"></div>`;
    } else if (inst.type === "soundboard") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.soundboardPopupDuration")}</label><input type="number" id="pSoundboardPopupDuration" min="1000" max="15000" step="100" value="${config.popupDurationMs || 4600}"></div>
        <div class="md-field"><label>${t("properties.soundboardImageSize")}</label><input type="number" id="pSoundboardImageSize" min="80" max="500" step="10" value="${config.imageSize || 200}"></div>
        <div class="properties__toggle-row"><label>${t("properties.soundboardShowImage")}</label>${switchHtml("pSoundboardShowImage", config.showImage !== false)}</div>
        <div class="properties__toggle-row"><label>${t("properties.soundboardShowText")}</label>${switchHtml("pSoundboardShowText", config.showText !== false)}</div>
        <div class="properties__toggle-row"><label>${t("properties.soundboardShowBackground")}</label>${switchHtml("pSoundboardShowBackground", config.showBackground !== false)}</div>
        <div class="properties__toggle-row"><label>${t("properties.soundboardShowBorder")}</label>${switchHtml("pSoundboardShowBorder", config.showBorder !== false)}</div>`;
    } else if (inst.type === "custom") {
      const mode = config.mode || "text";
      extraHtml = `
        <div class="md-field"><label>${t("custom.name")}</label><input type="text" id="pCustomName" value="${escapeAttr(config.name || "")}" placeholder="${t("widgets.custom")}"></div>
        <div class="md-field"><label>${t("properties.customMode")}</label>
          <select id="pCustomMode">
            <option value="text" ${mode === "text" ? "selected" : ""}>${t("properties.modeText")}</option>
            <option value="image" ${mode === "image" ? "selected" : ""}>${t("properties.modeImage")}</option>
            <option value="html" ${mode === "html" ? "selected" : ""}>${t("properties.modeHtml")}</option>
            <option value="embed" ${mode === "embed" ? "selected" : ""}>${t("properties.modeEmbed")}</option>
          </select>
        </div>
        <div id="pCustomFields"></div>`;
    }

    propertiesEl.innerHTML = `
      <div class="properties__toggle-row"><label>${t("properties.visibility")}</label>${switchHtml("pVisible", inst.visible)}</div>
      <div class="properties__row">
        <div class="md-field"><label>${t("properties.x")}</label><input type="number" id="pX" value="${round1(inst.x)}"></div>
        <div class="md-field"><label>${t("properties.y")}</label><input type="number" id="pY" value="${round1(inst.y)}"></div>
      </div>
      <div class="properties__row">
        <div class="md-field"><label>${t("properties.width")}</label><input type="number" id="pW" value="${round1(inst.w)}"></div>
        <div class="md-field"><label>${t("properties.height")}</label><input type="number" id="pH" value="${round1(inst.h)}"></div>
      </div>
      ${extraHtml}
      <div class="properties__delete"><button class="md-button md-button--text" id="pDeleteBtn">${ICONS.trash} ${t("common.remove")}</button></div>`;

    [["pX", "x"], ["pY", "y"], ["pW", "w"], ["pH", "h"]].forEach(([id, key]) => {
      propertiesEl.querySelector("#" + id).addEventListener("change", (e) => {
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { [key]: Number(e.target.value) } });
      });
    });
    wireSwitch(propertiesEl.querySelector("#pVisible"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { visible: on } }));

    if (inst.type === "goal" || inst.type === "grimhex-goal" || inst.type === "nuclear-goal" || inst.type === "cobra-goal" || inst.type === "md3-goal" || inst.type === "pixel-goal" || inst.type === "teso-goal") {
      propertiesEl.querySelector("#pGoalTitle").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { title: e.target.value }));
      propertiesEl.querySelector("#pGoalCurrent").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { current: Number(e.target.value) }));
      propertiesEl.querySelector("#pGoalTarget").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { target: Number(e.target.value) }));
      propertiesEl.querySelector("#pGoalCurrency").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { currency: e.target.value }));
      wireSwitch(propertiesEl.querySelector("#pShowPercent"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showPercentage: on } } }));
      wireSwitch(propertiesEl.querySelector("#pShowBackground"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showBackground: on } } }));
    } else if (inst.type === "chat") {
      propertiesEl.querySelector("#pMaxMessages").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { maxMessages: Number(e.target.value) } } }));
      wireSwitch(propertiesEl.querySelector("#pShowBadges"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showBadges: on } } }));
    } else if (inst.type === "grimhex-chat" || inst.type === "nuclear-chat" || inst.type === "cobra-chat" || inst.type === "md3-chat" || inst.type === "pixel-chat" || inst.type === "teso-chat") {
      propertiesEl.querySelector("#pMaxMessages").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { maxMessages: Number(e.target.value) } } }));
      propertiesEl.querySelector("#pPerspective").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pPerspectiveValue");
        if (label) label.textContent = String(v);
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { perspective: v } } });
      });
    } else if (inst.type === "grimhex" || inst.type === "musain" || inst.type === "nuclear" || inst.type === "cobra" || inst.type === "elite-sign" || inst.type === "teso-seal" || inst.type === "md3-orb" || inst.type === "pixel-cube") {
      propertiesEl.querySelector("#pPerspective").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pPerspectiveValue");
        if (label) label.textContent = String(v);
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { perspective: v } } });
      });
    } else if (inst.type === "cobra-shield" || inst.type === "cobra-radar" || inst.type === "grimhex-radar") {
      propertiesEl.querySelector("#pOpacity").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pOpacityValue");
        if (label) label.textContent = `${v}%`;
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { opacity: v } } });
      });
    } else if (inst.type === "recent") {
      propertiesEl.querySelector("#pMaxItems").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { maxItems: Number(e.target.value) } } }));
    } else if (inst.type === "stat") {
      propertiesEl.querySelector("#pStatMetric").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { metric: e.target.value } } }));
      propertiesEl.querySelector("#pStatLabel").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { label: e.target.value } } }));
    } else if (inst.type === "social") {
      propertiesEl.querySelector("#pRotateSec").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { rotateIntervalSec: Number(e.target.value) } } }));
      wireWidgetSocialsList(inst, config.socials || []);
      propertiesEl.querySelector("#pAddSocial").addEventListener("click", () => {
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { socials: [...(config.socials || []), { platform: "", text: "" }] } } });
      });
    } else if (inst.type === "grimhex-timer" || inst.type === "timer") {
      const patchTimer = (configPatch) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: configPatch } });
      wireSwitch(propertiesEl.querySelector("#pTimerShowLights"), (on) => patchTimer({ showLights: on }));
      wireSwitch(propertiesEl.querySelector("#pTimerShowCycle"), (on) => patchTimer({ showCycle: on }));
      wireSwitch(propertiesEl.querySelector("#pTimerShowTelemetry"), (on) => patchTimer({ showTelemetry: on }));
      const refreshBtn = propertiesEl.querySelector("#pTimerRefresh");
      if (refreshBtn) refreshBtn.addEventListener("click", () => send(EVENT_TYPES.CMD_REFRESH_LONGSHOT, {}));
    } else if (inst.type === "mic") {
      // Настройки отображения пишем в конфиг виджета (per-widget).
      const setMic = (key, value) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { [key]: value } } });
      const onMicRange = (id, labelId, fmt, apply) => {
        const input = propertiesEl.querySelector("#" + id);
        if (!input) return;
        input.addEventListener("input", (e) => {
          const v = Number(e.target.value);
          const label = propertiesEl.querySelector("#" + labelId);
          if (label) label.textContent = fmt(v);
          apply(v);
        });
      };
      const modeEl = propertiesEl.querySelector("#pMicMode");
      if (modeEl) modeEl.addEventListener("change", (e) => setMic("visualizer_mode", e.target.value));
      onMicRange("pMicSensitivity", "pMicSensitivityValue", (v) => v.toFixed(1), (v) => setMic("sensitivity", v));
      onMicRange("pMicLineWidth", "pMicLineWidthValue", (v) => v.toFixed(1), (v) => setMic("lineWidth", v));
      onMicRange("pMicBarCount", "pMicBarCountValue", (v) => String(Math.round(v)), (v) => setMic("barCount", Math.round(v)));
      onMicRange("pMicBarGap", "pMicBarGapValue", (v) => v.toFixed(1), (v) => setMic("barGap", v));
      onMicRange("pMicPeakFall", "pMicPeakFallValue", (v) => v.toFixed(1), (v) => setMic("peakFall", v));
      onMicRange("pMicSmoothing", "pMicSmoothingValue", (v) => `${Math.round(v * 100)}%`, (v) => setMic("smoothing", v));
      onMicRange("pMicGain", "pMicGainValue", (v) => `${v.toFixed(1)}×`, (v) => setMic("gain", v));
      onMicRange("pMicNoiseGate", "pMicNoiseGateValue", (v) => `${Math.round(v * 100)}%`, (v) => setMic("noiseGate", v));
      onMicRange("pMicOpacity", "pMicOpacityValue", (v) => `${Math.round(v)}%`, (v) => setMic("opacity", v / 100));
      const micScaleEl = propertiesEl.querySelector("#pMicFreqScale");
      if (micScaleEl) micScaleEl.addEventListener("change", (e) => setMic("freqScale", e.target.value));
      const micColorEl = propertiesEl.querySelector("#pMicColor");
      if (micColorEl) micColorEl.addEventListener("input", (e) => setMic("color", e.target.value));
      const micColorResetEl = propertiesEl.querySelector("#pMicColorReset");
      if (micColorResetEl) micColorResetEl.addEventListener("click", () => setMic("color", ""));
      const micDeviceEl = propertiesEl.querySelector("#pMicDevice");
      if (micDeviceEl) micDeviceEl.addEventListener("change", (e) => sendMicCaptureConfig({ deviceId: e.target.value }));
      const micDeviceRefreshEl = propertiesEl.querySelector("#pMicDeviceRefresh");
      if (micDeviceRefreshEl && typeof refreshMicDevices === "function") micDeviceRefreshEl.addEventListener("click", () => refreshMicDevices());
      wireSwitch(propertiesEl.querySelector("#pMicEcho"), (on) => sendMicCaptureConfig({ echoCancellation: on }));
      wireSwitch(propertiesEl.querySelector("#pMicNoise"), (on) => sendMicCaptureConfig({ noiseSuppression: on }));
      wireSwitch(propertiesEl.querySelector("#pMicAgc"), (on) => sendMicCaptureConfig({ autoGainControl: on }));
    } else if (inst.type === "death") {
      propertiesEl.querySelector("#pDeathLabel").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { label: e.target.value } } }));
      propertiesEl.querySelector("#pDeathColor").addEventListener("input", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { color: e.target.value } } }));
    } else if (inst.type === "soundboard") {
      propertiesEl.querySelector("#pSoundboardPopupDuration").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { popupDurationMs: Number(e.target.value) || 4600 } } }));
      propertiesEl.querySelector("#pSoundboardImageSize").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { imageSize: Math.max(40, Number(e.target.value) || 200) } } }));
      wireSwitch(propertiesEl.querySelector("#pSoundboardShowImage"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showImage: on } } }));
      wireSwitch(propertiesEl.querySelector("#pSoundboardShowText"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showText: on } } }));
      wireSwitch(propertiesEl.querySelector("#pSoundboardShowBackground"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showBackground: on } } }));
      wireSwitch(propertiesEl.querySelector("#pSoundboardShowBorder"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showBorder: on } } }));
    } else if (inst.type === "custom") {
      wireCustomWidgetFields(inst, config);
      document.getElementById("pCustomName").addEventListener("change", (e) => {
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { name: e.target.value } } });
      });
      document.getElementById("pCustomMode").addEventListener("change", (e) => {
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { mode: e.target.value } } });
      });
    }

    document.getElementById("pDeleteBtn").addEventListener("click", () => {
      const label = inst.type === "custom" && config.name ? config.name : t("widgets." + (def.type || inst.type));
      if (!confirm(t("common.deleteWidgetConfirm", { name: label }))) return;
      send(EVENT_TYPES.CMD_REMOVE_WIDGET, { id: inst.id });
      state.selectedId = null;
    });
  }

  return { render, invalidate };
}
