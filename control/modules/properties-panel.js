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

export function initPropertiesPanel({
  state,
  t,
  ICONS,
  WIDGET_TYPES,
  EVENT_TYPES,
  send,
  switchHtml,
  wireSwitch,
  escapeAttr,
  round1,
  sendParticipantsConfig,
  sendMicConfig,
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
        <div class="md-field"><label>${t("custom.imageUrl")}</label><input type="text" id="pImageUrl" value="${escapeAttr(config.imageUrl || "")}" placeholder="https://..."></div>
        <div class="md-field"><label>${t("custom.imageFit")}</label>
          <select id="pImageFit">
            <option value="contain" ${config.imageFit !== "cover" ? "selected" : ""}>${t("custom.fitContain")}</option>
            <option value="cover" ${config.imageFit === "cover" ? "selected" : ""}>${t("custom.fitCover")}</option>
          </select>
        </div>`;
      host.querySelector("#pImageUrl").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { imageUrl: e.target.value.trim() } } }));
      host.querySelector("#pImageFit").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { imageFit: e.target.value } } }));
    } else if (mode === "html") {
      host.innerHTML = `
        <div class="properties__hint">${t("custom.htmlHint")}</div>
        <button class="md-button md-button--filled" id="pOpenEditor" style="width:100%;justify-content:center;">${t("custom.editCode")}</button>`;
      host.querySelector("#pOpenEditor").addEventListener("click", () => window.desktop?.openWidgetEditor(inst.id));
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

  function render() {
    const inst = state.layout.find((w) => w.id === state.selectedId);
    if (!inst) {
      propertiesSection.hidden = true;
      return;
    }
    propertiesSection.hidden = false;
    const def = WIDGET_TYPES[inst.type] || {};
    propertiesTitle.textContent = t("widgets." + (def.type || inst.type));
    const config = inst.config || {};

    let extraHtml = "";
    if (inst.type === "goal" || inst.type === "grimhex-goal" || inst.type === "nuclear-goal") {
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
    } else if (inst.type === "grimhex-chat" || inst.type === "nuclear-chat") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.maxMessages")}</label><input type="number" id="pMaxMessages" min="1" max="100" value="${config.maxMessages || 50}"></div>
        <div class="md-field"><label>${t("properties.perspective")}: <span id="pPerspectiveValue">${config.perspective || 0}</span></label><input type="range" id="pPerspective" min="0" max="100" step="1" value="${config.perspective || 0}"></div>`;
    } else if (inst.type === "grimhex" || inst.type === "musain" || inst.type === "nuclear") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.perspective")}: <span id="pPerspectiveValue">${config.perspective || 0}</span></label><input type="range" id="pPerspective" min="0" max="100" step="1" value="${config.perspective || 0}"></div>`;
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
    } else if (inst.type === "participants") {
      extraHtml = `
        <div class="properties__row">
          <div class="md-field"><label>${t("properties.showNames")}</label><input type="number" id="pPwMaxNames" min="1" max="200" value="${state.participantsConfig.maxNames ?? 10}"></div>
          <div class="md-field"><label>${t("properties.fontSize")}</label><input type="number" id="pPwFontSize" min="10" max="48" value="${state.participantsConfig.fontSize ?? 16}"></div>
        </div>
        <div class="md-field"><label>${t("properties.textColor")}</label><input type="color" id="pPwTextColor" value="${escapeAttr(state.participantsConfig.textColor || "#e8e1f0")}"></div>
        <div class="md-field"><label>${t("properties.backgroundOpacity")}: <span id="pPwBgOpacityValue">${state.participantsConfig.backgroundOpacity ?? 82}%</span></label><input type="range" id="pPwBgOpacity" min="0" max="100" value="${state.participantsConfig.backgroundOpacity ?? 82}"></div>
        <div class="properties__toggle-row"><label>${t("properties.marquee")}</label>${switchHtml("pPwMarquee", !!state.participantsConfig.marquee)}</div>`;
    } else if (inst.type === "mic") {
      const mode = state.micConfig.visualizer_mode || "sine";
      const themePrimary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#0060A8";
      const micColor = config.color || state.micConfig.color || themePrimary;
      extraHtml = `
        <div class="md-field"><label>${t("mic.mode")}</label>
          <select id="pMicMode">
            <option value="sine" ${mode === "sine" ? "selected" : ""}>${t("mic.modeSine")}</option>
            <option value="bars" ${mode === "bars" ? "selected" : ""}>${t("mic.modeBars")}</option>
            <option value="ring" ${mode === "ring" ? "selected" : ""}>${t("mic.modeRing")}</option>
            <option value="equalizer" ${mode === "equalizer" ? "selected" : ""}>${t("mic.modeEqualizer")}</option>
          </select>
        </div>
        <div class="md-field"><label>${t("mic.sensitivity")}: <span id="pMicSensitivityValue">${state.micConfig.sensitivity ?? 1.5}</span></label><input type="range" id="pMicSensitivity" min="0.2" max="6" step="0.1" value="${state.micConfig.sensitivity ?? 1.5}"></div>
        <div class="md-field"><label>${t("mic.lineWidth")}: <span id="pMicLineWidthValue">${state.micConfig.lineWidth ?? 2}</span></label><input type="range" id="pMicLineWidth" min="1" max="12" step="0.5" value="${state.micConfig.lineWidth ?? 2}"></div>
        <div class="md-field"><label>${t("mic.barCount")}: <span id="pMicBarCountValue">${state.micConfig.barCount ?? 32}</span></label><input type="range" id="pMicBarCount" min="10" max="64" step="1" value="${state.micConfig.barCount ?? 32}"></div>
        <div class="md-field"><label>${t("mic.barGap")}: <span id="pMicBarGapValue">${state.micConfig.barGap ?? 2}</span></label><input type="range" id="pMicBarGap" min="0" max="12" step="0.5" value="${state.micConfig.barGap ?? 2}"></div>
        <div class="md-field"><label>${t("mic.peakFall")}: <span id="pMicPeakFallValue">${state.micConfig.peakFall ?? 2.5}</span></label><input type="range" id="pMicPeakFall" min="0.5" max="10" step="0.1" value="${state.micConfig.peakFall ?? 2.5}"></div>
        <div class="md-field"><label>${t("mic.color")}</label>
          <div class="properties__color-row">
            <input type="color" id="pMicColor" value="${escapeAttr(micColor)}">
            <button class="md-button md-button--text" id="pMicColorReset" title="${t("mic.colorAuto")}">${t("mic.colorAuto")}</button>
          </div>
        </div>
        <div class="md-field"><label>${t("mic.opacity")}: <span id="pMicOpacityValue">${Math.round((state.micConfig.opacity ?? 0.9) * 100)}%</span></label><input type="range" id="pMicOpacity" min="5" max="100" step="1" value="${Math.round((state.micConfig.opacity ?? 0.9) * 100)}"></div>`;
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
        <div class="md-field"><label>${t("properties.customMode")}</label>
          <select id="pCustomMode">
            <option value="text" ${mode === "text" ? "selected" : ""}>${t("properties.modeText")}</option>
            <option value="image" ${mode === "image" ? "selected" : ""}>${t("properties.modeImage")}</option>
            <option value="html" ${mode === "html" ? "selected" : ""}>${t("properties.modeHtml")}</option>
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

    if (inst.type === "goal" || inst.type === "grimhex-goal" || inst.type === "nuclear-goal") {
      propertiesEl.querySelector("#pGoalTitle").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { title: e.target.value }));
      propertiesEl.querySelector("#pGoalCurrent").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { current: Number(e.target.value) }));
      propertiesEl.querySelector("#pGoalTarget").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { target: Number(e.target.value) }));
      propertiesEl.querySelector("#pGoalCurrency").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { currency: e.target.value }));
      wireSwitch(propertiesEl.querySelector("#pShowPercent"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showPercentage: on } } }));
      wireSwitch(propertiesEl.querySelector("#pShowBackground"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showBackground: on } } }));
    } else if (inst.type === "chat") {
      propertiesEl.querySelector("#pMaxMessages").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { maxMessages: Number(e.target.value) } } }));
      wireSwitch(propertiesEl.querySelector("#pShowBadges"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showBadges: on } } }));
    } else if (inst.type === "grimhex-chat" || inst.type === "nuclear-chat") {
      propertiesEl.querySelector("#pMaxMessages").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { maxMessages: Number(e.target.value) } } }));
      propertiesEl.querySelector("#pPerspective").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pPerspectiveValue");
        if (label) label.textContent = String(v);
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { perspective: v } } });
      });
    } else if (inst.type === "grimhex" || inst.type === "musain" || inst.type === "nuclear") {
      propertiesEl.querySelector("#pPerspective").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pPerspectiveValue");
        if (label) label.textContent = String(v);
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { perspective: v } } });
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
    } else if (inst.type === "participants") {
      propertiesEl.querySelector("#pPwMaxNames").addEventListener("change", (e) => sendParticipantsConfig({ maxNames: Number(e.target.value) || 10 }));
      propertiesEl.querySelector("#pPwFontSize").addEventListener("change", (e) => sendParticipantsConfig({ fontSize: Number(e.target.value) || 16 }));
      propertiesEl.querySelector("#pPwTextColor").addEventListener("input", (e) => sendParticipantsConfig({ textColor: e.target.value }));
      propertiesEl.querySelector("#pPwBgOpacity").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pPwBgOpacityValue");
        if (label) label.textContent = `${v}%`;
        sendParticipantsConfig({ backgroundOpacity: v });
      });
      wireSwitch(propertiesEl.querySelector("#pPwMarquee"), (on) => sendParticipantsConfig({ marquee: on }));
    } else if (inst.type === "mic") {
      propertiesEl.querySelector("#pMicSensitivity").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pMicSensitivityValue");
        if (label) label.textContent = v.toFixed(1);
        sendMicConfig({ sensitivity: v });
      });
      propertiesEl.querySelector("#pMicLineWidth").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pMicLineWidthValue");
        if (label) label.textContent = v.toFixed(1);
        sendMicConfig({ lineWidth: v });
      });
      propertiesEl.querySelector("#pMicColor").addEventListener("input", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { color: e.target.value } } }));
      propertiesEl.querySelector("#pMicColorReset").addEventListener("click", () => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { color: "" } } }));
      propertiesEl.querySelector("#pMicOpacity").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pMicOpacityValue");
        if (label) label.textContent = `${v}%`;
        sendMicConfig({ opacity: v / 100 });
      });
      propertiesEl.querySelector("#pMicMode").addEventListener("change", (e) => sendMicConfig({ visualizer_mode: e.target.value }));
      propertiesEl.querySelector("#pMicBarCount").addEventListener("input", (e) => {
        const v = Math.round(Number(e.target.value));
        const label = propertiesEl.querySelector("#pMicBarCountValue");
        if (label) label.textContent = String(v);
        sendMicConfig({ barCount: v });
      });
      propertiesEl.querySelector("#pMicBarGap").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pMicBarGapValue");
        if (label) label.textContent = v.toFixed(1);
        sendMicConfig({ barGap: v });
      });
      propertiesEl.querySelector("#pMicPeakFall").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pMicPeakFallValue");
        if (label) label.textContent = v.toFixed(1);
        sendMicConfig({ peakFall: v });
      });
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
      document.getElementById("pCustomMode").addEventListener("change", (e) => {
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { mode: e.target.value } } });
      });
    }

    document.getElementById("pDeleteBtn").addEventListener("click", () => {
      if (!confirm(t("common.deleteWidgetConfirm", { name: t("widgets." + (def.type || inst.type)) }))) return;
      send(EVENT_TYPES.CMD_REMOVE_WIDGET, { id: inst.id });
      state.selectedId = null;
    });
  }

  return { render };
}
