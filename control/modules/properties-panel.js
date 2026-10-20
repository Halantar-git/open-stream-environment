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

// Signs with a "Motion" switch in the inspector: it stops the widget from
// drifting (sway, roll, spin) while its neon animation keeps playing. The TESO
// seal, the Pixel cube and the Wardogs cube are left out — they always spin.
const MOTION_TOGGLE_TYPES = ["grimhex", "musain", "nuclear", "cobra", "elite-sign", "md3-orb"];

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
  micRotationPatch,
  sendMicCaptureConfig,
  refreshMicDevices,
  sendCameraCaptureConfig,
  refreshCameraDevices,
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

  // Фактический размер кадра: что отдаёт источник и что уходит в эфир. Для
  // телефона разница заметная — мост легко отдаёт 1080p и выше, а виджет
  // меньше, поэтому шкала ширины описывает выход, а не источник.
  function cameraStreamText() {
    const info = state.cameraStreamInfo;
    if (!info || !info.width || !info.height) return t("properties.webcamStreamIdle");
    const output = `${info.width}×${info.height}`;
    const source = info.sourceWidth && info.sourceHeight ? `${info.sourceWidth}×${info.sourceHeight}` : "";
    if (!source || source === output) return t("properties.webcamStreamSize", { size: output });
    return t("properties.webcamStreamSize", { size: `${source} → ${output}` });
  }

  // Мост обновляет подпись на лету, не перестраивая весь инспектор: иначе
  // каждый новый размер кадра сбрасывал бы фокус с ползунков.
  function updateCameraStreamInfo() {
    const node = propertiesEl.querySelector("#pCameraStreamSize");
    if (node) node.textContent = cameraStreamText();
  }

  function invalidate() {
    lastSig = null;
  }

  // Свободный гостевой слот для нового виджета. Пустой слот у источника
  // «Гостевая камера» — самая незаметная поломка: виджет рисует заглушку,
  // ни на что не подписывается, и гость после подтверждения навсегда остаётся
  // с «ждём экран». Поэтому слот подставляем сами и не занимаем тот, что уже
  // выбран другим гостевым виджетом.
  function unusedGuestSlot(widgetId) {
    const known =
      Array.isArray(state.guestSlots) && state.guestSlots.length
        ? state.guestSlots
        : ["cam2", "cam3", "cam4"].map((slot) => ({ slot }));
    const used = new Set(
      (state.layout || [])
        .filter(
          (item) =>
            item.id !== widgetId &&
            item.type === "webcam" &&
            item.config &&
            item.config.source === "remote" &&
            item.config.guestSlot
        )
        .map((item) => item.config.guestSlot)
    );
    const free = known.find((item) => !used.has(item.slot));
    return (free || known[0]).slot;
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
    // Поворот меняет не только рисунок, но и подпись под кнопками — без него
    // рендер с активной кнопкой в панели пропускался бы и состояние отставало.
    const micRotation = type === "mic" ? Number(raw.config && raw.config.rotation) || 0 : "";
    // Зеркало не меняет набор полей, но заголовок состояния под кнопками
    // зависит от него — без него рендер с включённым зеркалом пропускался бы.
    const micMirror = type === "mic" ? ((raw.config && raw.config.mirror) || (state.micConfig && state.micConfig.mirror) ? 1 : 0) : "";
    const webcamSource = type === "webcam" ? (raw.config && raw.config.source) || "frame" : "";
    // Включённый неон добавляет ползунок силы свечения — без него в сигнатуре
    // инспектор не перестроится и поле не появится до смены виджета.
    const webcamNeon = type === "webcam" ? (raw.config && raw.config.neon ? 1 : 0) : "";
    const cameraCodec = type === "webcam" ? (state.cameraConfig && state.cameraConfig.codec) || "auto" : "";
    const guestSlotsSig = type === "webcam" ? (state.guestSlots || []).map((s) => `${s.slot}:${s.state}`).join(",") : "";
    const sig = `${raw.id}|${raw.type}|${type}|${micMode}|${micRotation}|${micMirror}|${webcamSource}|${webcamNeon}|${cameraCodec}|${(raw.config && raw.config.guestSlot) || ""}|${guestSlotsSig}|${(state.micDevices || []).length}|${(state.cameraDevices || []).length}`;
    if (!force && sig === lastSig && propertiesEl.contains(document.activeElement)) return;
    lastSig = sig;
    const def = WIDGET_TYPES[type] || {};
    propertiesTitle.textContent = t("widgets." + (def.type || type));
    const config = inst.config || {};

    let extraHtml = "";
    if (inst.type === "goal" || inst.type === "grimhex-goal" || inst.type === "nuclear-goal" || inst.type === "cobra-goal" || inst.type === "wardogs-goal" || inst.type === "md3-goal" || inst.type === "pixel-goal" || inst.type === "teso-goal" || inst.type === "retrowave-goal") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.goalTitle")}</label><input type="text" id="pGoalTitle" value="${escapeAttr(state.goal.title || "")}"></div>
        <div class="properties__row">
          <div class="md-field"><label>${t("properties.current")}</label><input type="number" id="pGoalCurrent" value="${state.goal.current || 0}"></div>
          <div class="md-field"><label>${t("properties.target")}</label><input type="number" id="pGoalTarget" value="${state.goal.target || 0}"></div>
        </div>
        <div class="md-field"><label>${t("properties.currency")}</label><input type="text" id="pGoalCurrency" value="${escapeAttr(state.goal.currency || "")}"></div>
        <div class="properties__toggle-row"><label>${t("properties.showPercent")}</label>${switchHtml("pShowPercent", !!config.showPercentage)}</div>
        <div class="properties__toggle-row"><label>${t("properties.showBackground")}</label>${switchHtml("pShowBackground", config.showBackground !== false)}</div>
        ${inst.type === "goal" ? "" : `<div class="md-field"><label>${t("properties.perspective")}: <span id="pPerspectiveValue">${config.perspective || 0}</span></label><input type="range" id="pPerspective" min="0" max="100" step="1" value="${config.perspective || 0}"></div>
        <div class="md-field"><label>${t("properties.perspectiveDirection")}</label>
          <select id="pPerspectiveDirection">
            <option value="left" ${(config.perspectiveDirection || "left") === "left" ? "selected" : ""}>${t("properties.perspectiveLeft")}</option>
            <option value="right" ${config.perspectiveDirection === "right" ? "selected" : ""}>${t("properties.perspectiveRight")}</option>
            <option value="up" ${config.perspectiveDirection === "up" ? "selected" : ""}>${t("properties.perspectiveUp")}</option>
            <option value="down" ${config.perspectiveDirection === "down" ? "selected" : ""}>${t("properties.perspectiveDown")}</option>
          </select>
        </div>`}`;
    } else if (inst.type === "chat") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.maxMessages")}</label><input type="number" id="pMaxMessages" min="1" max="20" value="${config.maxMessages || 8}"></div>
        <div class="properties__toggle-row"><label>${t("properties.showBadges")}</label>${switchHtml("pShowBadges", config.showBadges !== false)}</div>`;
    } else if (inst.type === "grimhex-chat" || inst.type === "nuclear-chat" || inst.type === "cobra-chat" || inst.type === "md3-chat" || inst.type === "pixel-chat" || inst.type === "teso-chat" || inst.type === "wardogs-chat" || inst.type === "retrowave-chat") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.maxMessages")}</label><input type="number" id="pMaxMessages" min="1" max="100" value="${config.maxMessages || 50}"></div>
        ${inst.type === "teso-chat" ? "" : `<div class="properties__toggle-row"><label>${t("properties.chatShowTime")}</label>${switchHtml("pChatShowTime", config.showTime !== false)}</div>`}
        <div class="md-field"><label>${t("properties.perspective")}: <span id="pPerspectiveValue">${config.perspective || 0}</span></label><input type="range" id="pPerspective" min="0" max="100" step="1" value="${config.perspective || 0}"></div>`;
    } else if (inst.type === "grimhex" || inst.type === "musain" || inst.type === "nuclear" || inst.type === "cobra" || inst.type === "elite-sign" || inst.type === "teso-seal" || inst.type === "md3-orb" || inst.type === "pixel-cube" || inst.type === "wardogs-cube" || inst.type === "retrowave-symbol") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.perspective")}: <span id="pPerspectiveValue">${config.perspective || 0}</span></label><input type="range" id="pPerspective" min="0" max="100" step="1" value="${config.perspective || 0}"></div>
        ${MOTION_TOGGLE_TYPES.includes(inst.type) ? `<div class="properties__toggle-row"><label>${t("properties.motion")}</label>${switchHtml("pMotion", config.motion !== false)}</div>` : ""}`;
    } else if (inst.type === "cobra-shield" || inst.type === "cobra-radar" || inst.type === "grimhex-radar") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.opacity")}: <span id="pOpacityValue">${config.opacity ?? 100}%</span></label><input type="range" id="pOpacity" min="0" max="100" step="1" value="${config.opacity ?? 100}"></div>`;
    } else if (inst.type.endsWith("-recent")) {
      extraHtml = `
        <div class="md-field"><label>${t("properties.maxItems")}</label><input type="number" id="pMaxItems" min="1" max="15" value="${config.maxItems || 5}"></div>
        <div class="md-field"><label>${t("properties.recentAnimationMs")}: <span id="pRecentAnimationValue">${config.animationMs || 840}</span></label><input type="range" id="pRecentAnimation" min="100" max="1500" step="10" value="${config.animationMs || 840}"></div>
        <div class="md-field"><label>${t("properties.perspective")}: <span id="pPerspectiveValue">${config.perspective || 0}</span></label><input type="range" id="pPerspective" min="0" max="100" step="1" value="${config.perspective || 0}"></div>
        <div class="md-field"><label>${t("properties.perspectiveDirection")}</label>
          <select id="pPerspectiveDirection">
            <option value="left" ${(config.perspectiveDirection || "left") === "left" ? "selected" : ""}>${t("properties.perspectiveLeft")}</option>
            <option value="right" ${config.perspectiveDirection === "right" ? "selected" : ""}>${t("properties.perspectiveRight")}</option>
            <option value="up" ${config.perspectiveDirection === "up" ? "selected" : ""}>${t("properties.perspectiveUp")}</option>
            <option value="down" ${config.perspectiveDirection === "down" ? "selected" : ""}>${t("properties.perspectiveDown")}</option>
          </select>
        </div>
        <p class="properties__hint">${t("properties.recentAnimationHint")}</p>`;
    } else if (inst.type === "recent") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.maxItems")}</label><input type="number" id="pMaxItems" min="1" max="15" value="${config.maxItems || 5}"></div>
        <div class="md-field"><label>${t("properties.perspective")}: <span id="pPerspectiveValue">${config.perspective || 0}</span></label><input type="range" id="pPerspective" min="0" max="100" step="1" value="${config.perspective || 0}"></div>
        <div class="md-field"><label>${t("properties.perspectiveDirection")}</label>
          <select id="pPerspectiveDirection">
            <option value="left" ${(config.perspectiveDirection || "left") === "left" ? "selected" : ""}>${t("properties.perspectiveLeft")}</option>
            <option value="right" ${config.perspectiveDirection === "right" ? "selected" : ""}>${t("properties.perspectiveRight")}</option>
            <option value="up" ${config.perspectiveDirection === "up" ? "selected" : ""}>${t("properties.perspectiveUp")}</option>
            <option value="down" ${config.perspectiveDirection === "down" ? "selected" : ""}>${t("properties.perspectiveDown")}</option>
          </select>
        </div>`;
    } else if (inst.type === "ticker" || inst.type.endsWith("-ticker")) {
      const sources = {
        donations: true,
        follows: true,
        subs: true,
        rewards: true,
        chat: false,
        goal: false,
        top: false,
        ...(config.sources || {}),
      };
      const ticker3d = inst.type.endsWith("-ticker") || String(type).endsWith("-ticker");
      const sourceToggle = (id, key, labelKey) =>
        `<div class="properties__toggle-row"><label>${t(labelKey)}</label>${switchHtml(id, sources[key] === true)}</div>`;
      extraHtml = `
        <div class="md-field"><label>${t("properties.tickerSpeed")}</label><input type="number" id="pTickerSpeed" min="20" max="200" step="5" value="${config.speed || 80}"></div>
        <div class="md-field"><label>${t("properties.tickerDirection")}</label>
          <select id="pTickerDirection">
            <option value="left" ${(config.direction || "left") === "left" ? "selected" : ""}>${t("properties.tickerDirectionLeft")}</option>
            <option value="right" ${config.direction === "right" ? "selected" : ""}>${t("properties.tickerDirectionRight")}</option>
          </select>
        </div>
        <div class="md-field"><label>${t("properties.tickerLabel")}</label><input type="text" id="pTickerLabel" value="${escapeAttr(config.label || "")}" placeholder="${escapeAttr(t("ticker.label"))}"></div>
        <div class="properties__toggle-row"><label>${t("properties.tickerShowLabel")}</label>${switchHtml("pTickerShowLabel", config.showLabel !== false)}</div>
        <div class="md-field"><label>${t("properties.tickerSources")}</label></div>
        ${sourceToggle("pTickerSourceDonations", "donations", "properties.tickerSourceDonations")}
        ${sourceToggle("pTickerSourceFollows", "follows", "properties.tickerSourceFollows")}
        ${sourceToggle("pTickerSourceSubs", "subs", "properties.tickerSourceSubs")}
        ${sourceToggle("pTickerSourceRewards", "rewards", "properties.tickerSourceRewards")}
        <div class="properties__toggle-row"><label>${t("properties.tickerRewardsBreaking")}</label>${switchHtml("pTickerRewardsBreaking", config.rewardsBreaking !== false)}</div>
        ${sourceToggle("pTickerSourceChat", "chat", "properties.tickerSourceChat")}
        ${sourceToggle("pTickerSourceGoal", "goal", "properties.tickerSourceGoal")}
        ${sourceToggle("pTickerSourceTop", "top", "properties.tickerSourceTop")}
        <div class="md-field"><label>${t("properties.tickerMaxItems")}</label><input type="number" id="pTickerMaxItems" min="1" max="60" value="${config.maxItems || 24}"></div>
        ${ticker3d ? `<div class="md-field"><label>${t("properties.perspective")}: <span id="pPerspectiveValue">${config.perspective || 0}</span></label><input type="range" id="pPerspective" min="0" max="100" step="1" value="${config.perspective || 0}"></div>` : ""}
        <p class="properties__hint">${t("properties.tickerHint")}</p>`;
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
    } else if (inst.type === "participants") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.participantsMaxNames")}</label><input type="number" id="pParticipantsMaxNames" min="1" max="200" value="${config.maxNames || 10}"></div>
        <div class="md-field"><label>${t("properties.participantsFontSize")}</label><input type="number" id="pParticipantsFontSize" min="8" max="64" value="${config.fontSize || 16}"></div>
        <div class="md-field"><label>${t("properties.participantsTextColor")}</label><input type="color" id="pParticipantsTextColor" value="${escapeAttr(config.textColor || "#e8e1f0")}"></div>
        <div class="md-field"><label>${t("properties.participantsBgOpacity")}: <span id="pParticipantsBgOpacityValue">${config.backgroundOpacity ?? 82}%</span></label><input type="range" id="pParticipantsBgOpacity" min="0" max="100" value="${config.backgroundOpacity ?? 82}"></div>
        <div class="properties__toggle-row"><label>${t("properties.participantsMarquee")}</label>${switchHtml("pParticipantsMarquee", !!config.marquee)}</div>
        <p class="properties__hint">${t("properties.participantsHint")}</p>`;
    } else if (inst.type === "grimhex-timer" || inst.type === "timer") {
      // Источник выбирает сервер (Exectimer, затем Longshot): заголовок
      // фиксирован, редактируемых заметки и источника нет — только статус
      // синхронизации, наклон и переключатели отображения.
      const ls = state.longshot || null;
      // Скрытый виджет не держит опрос внешнего таймера — говорим об этом прямо,
      // иначе подсказка «ещё нет данных» выглядела бы как поломка.
      const lsSource = ls && ls.source === "exectimer" ? "Exectimer" : ls && ls.source === "longshot" ? "Longshot" : "—";
      const lsStatus =
        raw.visible === false
          ? t("properties.timerRemoteHidden")
          : !ls
            ? t("properties.timerRemotePending")
            : ls.ok
              ? t("properties.timerRemoteOk", { source: lsSource })
              : t("properties.timerRemoteError", { error: ls.error || "—" });
      extraHtml = `
        <div class="properties__hint">${escapeHtml(lsStatus)}</div>
        <button class="md-button md-button--tonal" id="pTimerRefresh">${t("properties.timerRefresh")}</button>
        <div class="properties__toggle-row"><label>${t("properties.timerShowLights")}</label>${switchHtml("pTimerShowLights", config.showLights !== false)}</div>
        <div class="properties__toggle-row"><label>${t("properties.timerShowCycle")}</label>${switchHtml("pTimerShowCycle", config.showCycle !== false)}</div>
        <div class="properties__toggle-row"><label>${t("properties.timerShowTelemetry")}</label>${switchHtml("pTimerShowTelemetry", config.showTelemetry !== false)}</div>
        <div class="md-field"><label>${t("properties.perspective")}: <span id="pPerspectiveValue">${config.perspective || 0}</span></label><input type="range" id="pPerspective" min="0" max="100" step="1" value="${config.perspective || 0}"></div>
        <div class="md-field"><label>${t("properties.perspectiveDirection")}</label>
          <select id="pPerspectiveDirection">
            <option value="left" ${(config.perspectiveDirection || "left") === "left" ? "selected" : ""}>${t("properties.perspectiveLeft")}</option>
            <option value="right" ${config.perspectiveDirection === "right" ? "selected" : ""}>${t("properties.perspectiveRight")}</option>
            <option value="up" ${config.perspectiveDirection === "up" ? "selected" : ""}>${t("properties.perspectiveUp")}</option>
            <option value="down" ${config.perspectiveDirection === "down" ? "selected" : ""}>${t("properties.perspectiveDown")}</option>
          </select>
        </div>`;
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
      const mirror = micDef("mirror", false) === true;
      const rawRotation = Number(config.rotation);
      const rotation = rawRotation === 90 || rawRotation === 180 || rawRotation === 270 ? rawRotation : 0;
      const vertical = rotation === 90 || rotation === 270;
      const reversed = rotation >= 180;
      const themePrimary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#0060A8";
      const micColor = config.color || state.micConfig.color || themePrimary;
      // «default» — псевдоним системного выбора, а не пункт списка: иначе
      // выбранным оказался бы несуществующий пункт или виртуальный вход.
      const rawDeviceId = state.micConfig.deviceId || "";
      const deviceId = rawDeviceId === "default" ? "" : rawDeviceId;
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
      if (mode === "sine" || mode === "ring" || mode === "curve") {
        fields += `<div class="md-field"><label>${t("mic.lineWidth")}: <span id="pMicLineWidthValue">${num("lineWidth", 2)}</span></label><input type="range" id="pMicLineWidth" min="1" max="12" step="0.5" value="${num("lineWidth", 2)}"></div>`;
      }
      if (mode === "bars" || mode === "bars-up" || mode === "ring" || mode === "curve") {
        fields += `<div class="md-field"><label>${t("mic.barCount")}: <span id="pMicBarCountValue">${num("barCount", 32)}</span></label><input type="range" id="pMicBarCount" min="10" max="64" step="1" value="${num("barCount", 32)}"></div>`;
      }
      if (mode === "bars" || mode === "bars-up") {
        fields += `<div class="md-field"><label>${t("mic.barGap")}: <span id="pMicBarGapValue">${num("barGap", 2)}</span></label><input type="range" id="pMicBarGap" min="0" max="12" step="0.5" value="${num("barGap", 2)}"></div>`;
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
      fields += `<div class="md-field"><label>${t("mic.color")}</label>
          <div class="properties__color-row">
            <input type="color" id="pMicColor" value="${escapeAttr(micColor)}">
            <button class="md-button md-button--text" id="pMicColorReset" title="${t("mic.colorAuto")}">${t("mic.colorAuto")}</button>
          </div>
        </div>`;
      fields += `<div class="md-field"><label>${t("mic.opacity")}: <span id="pMicOpacityValue">${Math.round(num("opacity", 0.9) * 100)}%</span></label><input type="range" id="pMicOpacity" min="5" max="100" step="1" value="${Math.round(num("opacity", 0.9) * 100)}"></div>`;
      fields += `<div class="md-field"><label>${t("properties.perspective")}: <span id="pPerspectiveValue">${config.perspective || 0}</span></label><input type="range" id="pPerspective" min="0" max="100" step="1" value="${config.perspective || 0}"></div>
        <div class="md-field"><label>${t("properties.perspectiveDirection")}</label>
          <select id="pPerspectiveDirection">
            <option value="left" ${(config.perspectiveDirection || "left") === "left" ? "selected" : ""}>${t("properties.perspectiveLeft")}</option>
            <option value="right" ${config.perspectiveDirection === "right" ? "selected" : ""}>${t("properties.perspectiveRight")}</option>
            <option value="up" ${config.perspectiveDirection === "up" ? "selected" : ""}>${t("properties.perspectiveUp")}</option>
            <option value="down" ${config.perspectiveDirection === "down" ? "selected" : ""}>${t("properties.perspectiveDown")}</option>
          </select>
        </div>`;

      const captureHtml = `
        <p class="properties__hint" style="font-weight:600;margin:8px 0 0;">${t("mic.capture")}</p>
        <div class="md-field"><label>${t("mic.device")}</label>
          <div class="properties__row">
            <select id="pMicDevice">${deviceOptions}</select>
            <button class="md-button md-button--text" id="pMicDeviceRefresh" title="${t("mic.deviceRefresh")}">↻</button>
          </div>
        </div>
        <p class="properties__hint" style="margin:0;">${escapeHtml(
          state.micActiveDevice ? t("mic.captureDevice", { device: state.micActiveDevice.label }) : t("mic.captureNone")
        )}</p>
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
            <option value="bars-up" ${mode === "bars-up" ? "selected" : ""}>${t("mic.modeBarsUp")}</option>
            <option value="curve" ${mode === "curve" ? "selected" : ""}>${t("mic.modeCurve")}</option>
            <option value="ring" ${mode === "ring" ? "selected" : ""}>${t("mic.modeRing")}</option>
          </select>
        </div>
        <div class="properties__toggle-row"><label>${t("mic.mirror")}</label>${switchHtml("pMicMirror", mirror)}</div>
        <div class="properties__actions">
          <button class="md-button md-button--tonal" id="pMicRotate" title="${t("mic.rotateHint")}">↻ ${t("mic.rotateAction")}</button>
          <button class="md-button md-button--tonal" id="pMicFlip" title="${t("mic.directionHint")}">⇄ ${t("mic.directionAction")}</button>
        </div>
        <p class="properties__hint" style="margin:0;">${vertical ? t("mic.orientationVertical") : t("mic.orientationHorizontal")} · ${reversed ? t("mic.directionReverse") : t("mic.directionNormal")}${mirror ? ` · ${t("mic.mirrorOn")}` : ""}</p>
        ${fields}
        ${captureHtml}`;
    } else if (inst.type === "death") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.deathLabel")}</label><input type="text" id="pDeathLabel" value="${escapeAttr(config.label || "")}"></div>
        <div class="md-field"><label>${t("properties.deathColor")}</label><input type="color" id="pDeathColor" value="${escapeAttr(config.color || "#ff4d4d")}"></div>`;
    } else if (inst.type === "webcam") {
      // «Рамка» ничего не захватывает: камера — отдельный источник OBS.
      // «Живое видео» тянет кадры из моста панели. Подсказка в инспекторе
      // объясняет разницу, иначе легко решить, что виджет сломан.
      const themePrimary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#c6b8ff";
      // Рамка без явного радиуса повторяет форму панелей темы.
      const themeRadiusRaw = parseFloat((state.appearance.tokens && state.appearance.tokens["--panel-radius"]) || "");
      const themeRadius = Number.isFinite(themeRadiusRaw) ? Math.max(0, Math.min(64, Math.round(themeRadiusRaw))) : 16;
      const legacyRadius = Number(config.radius) === 16 && config.radiusAuto !== false;
      const radius = config.radius == null || legacyRadius ? themeRadius : Math.max(0, Math.min(64, Math.round(Number(config.radius) || 0)));
      const label = config.label == null ? "LIVE" : config.label;
      const position = config.labelPosition || "top-left";
      const source = config.source === "remote" ? "remote" : config.source === "camera" ? "camera" : "frame";
      const cameraCfg = state.cameraConfig || {};
      const guestSlot = config.guestSlot || "";
      const cornerColor = /^#[0-9a-f]{3,8}$/i.test(String(config.cornerColor || "").trim()) ? String(config.cornerColor).trim() : "";
      const neon = config.neon === true;
      const neonStrength = Math.max(2, Math.min(40, Math.round(Number(config.neonStrength) || 14)));
      const guestSlots = Array.isArray(state.guestSlots) && state.guestSlots.length
        ? state.guestSlots
        : ["cam2", "cam3", "cam4"].map((slot) => ({ slot, state: "free" }));
      const guestVolume = Math.round(Math.min(100, Math.max(0, Number(config.volume) || (config.volume === 0 ? 0 : 100))));
      const guestSlotOptions = guestSlots
        .map((item) => {
          const label = t(`guests.slot.${item.slot}`);
          const stateLabel = t(`guests.state.${item.state || "free"}`);
          return `<option value="${escapeAttr(item.slot)}" ${guestSlot === item.slot ? "selected" : ""}>${escapeHtml(label)} — ${escapeHtml(stateLabel)}</option>`;
        })
        .join("");
      const devices = Array.isArray(state.cameraDevices) ? state.cameraDevices : [];
      const deviceId = cameraCfg.deviceId || "";
      const deviceOptions = [
        `<option value="" ${deviceId ? "" : "selected"}>${t("properties.webcamDeviceDefault")}</option>`,
        ...devices.map(
          (d) => `<option value="${escapeAttr(d.deviceId)}" ${deviceId === d.deviceId ? "selected" : ""}>${escapeHtml(d.label)}</option>`
        ),
      ].join("");
      const widths = [320, 480, 640, 960, 1280, 1920];
      const widthOptions = widths
        .map((w) => `<option value="${w}" ${Number(cameraCfg.width) === w ? "selected" : ""}>${w} px</option>`)
        .join("");
      const fps = Math.round(Number(cameraCfg.fps) || 12);
      const quality = Math.round((Number(cameraCfg.quality) || 0.6) * 100);
      const codecMode = cameraCfg.codec || "auto";
      const bitrateKbps = Math.round(Number(cameraCfg.bitrateKbps) || 4000);
      const captureHtml =
        source === "camera"
          ? `
        <div class="inspector__title" style="margin-top:10px;">${t("properties.webcamCapture")}</div>
        <div class="properties__toggle-row"><label>${t("properties.webcamEnabled")}</label>${switchHtml("pCameraEnabled", cameraCfg.enabled !== false)}</div>
        <p class="properties__hint">${t("properties.webcamEnabledHint")}</p>
        <div class="md-field"><label>${t("properties.webcamDevice")}</label>
          <div class="properties__row">
            <select id="pCameraDevice">${deviceOptions}</select>
            <button class="md-button md-button--text" id="pCameraDeviceRefresh" title="${t("properties.webcamDeviceRefresh")}">↻</button>
          </div>
        </div>
        <div class="md-field"><label>${t("properties.webcamWidth")}</label><select id="pCameraWidth">${widthOptions}</select></div>
        <p class="properties__hint" id="pCameraStreamSize">${cameraStreamText()}</p>
        <div class="md-field"><label>${t("properties.webcamFps")}: <span id="pCameraFpsValue">${fps}</span></label><input type="range" id="pCameraFps" min="1" max="60" step="1" value="${fps}"></div>
        <div class="md-field"><label>${t("properties.webcamCodec")}</label>
          <select id="pCameraCodec">
            <option value="auto" ${codecMode === "auto" ? "selected" : ""}>${t("properties.webcamCodecAuto")}</option>
            <option value="h264" ${codecMode === "h264" ? "selected" : ""}>${t("properties.webcamCodecH264")}</option>
            <option value="jpeg" ${codecMode === "jpeg" ? "selected" : ""}>${t("properties.webcamCodecJpeg")}</option>
          </select>
        </div>
        ${codecMode !== "jpeg"
            ? `<div class="md-field"><label>${t("properties.webcamBitrate")}: <span id="pCameraBitrateValue">${(bitrateKbps / 1000).toFixed(1)}</span> Mbps</label><input type="range" id="pCameraBitrate" min="500" max="20000" step="500" value="${bitrateKbps}"></div>`
            : ""}
        ${codecMode !== "h264"
            ? `<div class="md-field"><label>${t("properties.webcamQuality")}: <span id="pCameraQualityValue">${quality}%</span></label><input type="range" id="pCameraQuality" min="20" max="95" step="5" value="${quality}"></div>`
            : ""}
        <div class="properties__toggle-row"><label>${t("properties.webcamMirror")}</label>${switchHtml("pWebcamMirror", !!config.mirror)}</div>
        <div class="md-field"><label>${t("properties.webcamFit")}</label>
          <select id="pWebcamFit">
            <option value="cover" ${(config.fit || "cover") === "cover" ? "selected" : ""}>${t("properties.webcamFitCover")}</option>
            <option value="contain" ${config.fit === "contain" ? "selected" : ""}>${t("properties.webcamFitContain")}</option>
          </select>
        </div>`
          : "";
      extraHtml = `
        <div class="md-field"><label>${t("properties.webcamSource")}</label>
          <select id="pWebcamSource">
            <option value="frame" ${source === "frame" ? "selected" : ""}>${t("properties.webcamSourceFrame")}</option>
            <option value="camera" ${source === "camera" ? "selected" : ""}>${t("properties.webcamSourceCamera")}</option>
            <option value="remote" ${source === "remote" ? "selected" : ""}>${t("properties.webcamSourceRemote")}</option>
          </select>
        </div>
        ${source === "remote"
            ? `<div class="md-field"><label>${t("properties.webcamGuestSlot")}</label>
                 <select id="pWebcamGuestSlot">
                   <option value="" ${guestSlot ? "" : "selected"}>${t("properties.webcamGuestNoSlot")}</option>
                   ${guestSlotOptions}
                 </select>
               </div>
               ${guestSlot ? "" : `<p class="properties__hint properties__hint--warn">${t("properties.webcamGuestSlotRequired")}</p>`}
               <div class="md-field"><label>${t("properties.webcamGuestVolume")}: <span id="pWebcamGuestVolumeValue">${guestVolume}%</span></label><input type="range" id="pWebcamGuestVolume" min="0" max="100" step="1" value="${guestVolume}"></div>
               <div class="properties__toggle-row"><label>${t("properties.webcamGuestVideoOnly")}</label>${switchHtml("pWebcamVideoOnly", config.videoOnly === true)}</div>`
            : ""}
        <div class="md-field"><label>${t("properties.webcamLabel")}</label><input type="text" id="pWebcamLabel" value="${escapeAttr(label)}" placeholder="LIVE"></div>
        <div class="properties__toggle-row"><label>${t("properties.webcamShowLabel")}</label>${switchHtml("pWebcamShowLabel", config.showLabel !== false)}</div>
        <div class="md-field"><label>${t("properties.webcamLabelPosition")}</label>
          <select id="pWebcamLabelPosition">
            <option value="top-left" ${position === "top-left" ? "selected" : ""}>${t("properties.webcamPosTopLeft")}</option>
            <option value="top-right" ${position === "top-right" ? "selected" : ""}>${t("properties.webcamPosTopRight")}</option>
            <option value="bottom-left" ${position === "bottom-left" ? "selected" : ""}>${t("properties.webcamPosBottomLeft")}</option>
            <option value="bottom-right" ${position === "bottom-right" ? "selected" : ""}>${t("properties.webcamPosBottomRight")}</option>
          </select>
        </div>
        <div class="properties__toggle-row"><label>${t("properties.webcamShowBorder")}</label>${switchHtml("pWebcamShowBorder", config.showBorder !== false)}</div>
        <div class="properties__toggle-row"><label>${t("properties.webcamShowCorners")}</label>${switchHtml("pWebcamShowCorners", config.showCorners !== false)}</div>
        <div class="properties__toggle-row"><label>${t("properties.webcamShowBackground")}</label>${switchHtml("pWebcamShowBackground", !!config.showBackground)}</div>
        <div class="properties__toggle-row"><label>${t("properties.webcamShowVignette")}</label>${switchHtml("pWebcamShowVignette", !!config.showVignette)}</div>
        <div class="md-field"><label>${t("properties.webcamThickness")}: <span id="pWebcamThicknessValue">${config.thickness ?? 4}</span> px</label><input type="range" id="pWebcamThickness" min="1" max="16" step="1" value="${config.thickness ?? 4}"></div>
        <div class="md-field"><label>${t("properties.webcamRadius")}: <span id="pWebcamRadiusValue">${radius}</span> px</label>
          <div class="properties__row" style="align-items:center;">
            <input type="range" id="pWebcamRadius" min="0" max="64" step="1" value="${radius}" style="flex:1;min-width:0;">
            <button class="md-button md-button--text" id="pWebcamRadiusReset" title="${t("properties.webcamRadiusAuto")}">${t("properties.webcamRadiusAuto")}</button>
          </div>
        </div>
        <div class="md-field"><label>${t("properties.webcamColor")}</label>
          <div class="properties__color-row">
            <input type="color" id="pWebcamColor" value="${escapeAttr(config.color || themePrimary)}">
            <button class="md-button md-button--text" id="pWebcamColorReset">${t("properties.webcamColorAuto")}</button>
          </div>
        </div>
        <div class="md-field"><label>${t("properties.webcamCornerColor")}</label>
          <div class="properties__color-row">
            <input type="color" id="pWebcamCornerColor" value="${escapeAttr(cornerColor || themePrimary)}">
            <button class="md-button md-button--text" id="pWebcamCornerColorReset">${t("properties.webcamCornerColorAuto")}</button>
          </div>
        </div>
        <div class="properties__toggle-row"><label>${t("properties.webcamNeon")}</label>${switchHtml("pWebcamNeon", neon)}</div>
        ${neon ? `<div class="md-field"><label>${t("properties.webcamNeonStrength")}: <span id="pWebcamNeonValue">${neonStrength}</span> px</label><input type="range" id="pWebcamNeonStrength" min="2" max="40" step="1" value="${neonStrength}"></div>` : ""}
        ${captureHtml}
        <div class="md-field"><label>${t("properties.perspective")}: <span id="pPerspectiveValue">${config.perspective || 0}</span></label><input type="range" id="pPerspective" min="0" max="100" step="1" value="${config.perspective || 0}"></div>
        <div class="md-field"><label>${t("properties.perspectiveDirection")}</label>
          <select id="pPerspectiveDirection">
            <option value="left" ${(config.perspectiveDirection || "left") === "left" ? "selected" : ""}>${t("properties.perspectiveLeft")}</option>
            <option value="right" ${config.perspectiveDirection === "right" ? "selected" : ""}>${t("properties.perspectiveRight")}</option>
            <option value="up" ${config.perspectiveDirection === "up" ? "selected" : ""}>${t("properties.perspectiveUp")}</option>
            <option value="down" ${config.perspectiveDirection === "down" ? "selected" : ""}>${t("properties.perspectiveDown")}</option>
          </select>
        </div>
        <p class="properties__hint">${t("properties.webcamHint")}</p>`;
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
    } else if (inst.type === "donatex-ai") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.donatexAiLink")}</label><input type="text" id="pDonatexUrl" value="${escapeAttr(config.url || "")}" placeholder="https://..."></div>
        <div class="md-field"><label>${t("properties.donatexAiAvatar")}</label><input type="text" id="pDonatexAvatar" value="${escapeAttr(config.avatarUrl || "")}" placeholder="https://..."></div>
        <div class="properties__toggle-row"><label>${t("properties.donatexAiShowName")}</label>${switchHtml("pDonatexShowName", config.showName !== false)}</div>
        <div class="md-field"><label>${t("properties.volume")}: <span id="pDonatexVolumeValue">${Math.round((config.volume ?? 0.8) * 100)}%</span></label><input type="range" id="pDonatexVolume" min="0" max="100" step="1" value="${Math.round((config.volume ?? 0.8) * 100)}"></div>
        <div class="md-field"><label>${t("properties.donatexAiHideDelay")}</label><input type="number" id="pDonatexHideDelay" min="500" max="60000" step="500" value="${config.hideDelayMs || 5000}"></div>`;
    } else if (inst.type === "music") {
      extraHtml = `
        <div class="properties__toggle-row"><label>${t("properties.musicAutoplay")}</label>${switchHtml("pMusicAutoplay", config.autoplay !== false)}</div>`;
    } else if (inst.type === "uec-transfer") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.uecChannel")}</label><input type="text" id="pUecChannel" value="${escapeAttr(config.channel || "")}" placeholder="${escapeAttr(t("uec.channel"))}"></div>
        <div class="md-field"><label>${t("properties.uecDuration")}</label><input type="number" id="pUecDuration" min="1500" max="60000" step="500" value="${config.durationMs || 9000}"></div>
        <div class="md-field"><label>${t("properties.uecDecode")}</label><input type="number" id="pUecDecode" min="10" max="500" step="10" value="${config.decodeTickMs || 76}"></div>
        <div class="properties__toggle-row"><label>${t("properties.uecShowAmount")}</label>${switchHtml("pUecShowAmount", config.showAmount !== false)}</div>
        <div class="properties__toggle-row"><label>${t("properties.uecShowMessage")}</label>${switchHtml("pUecShowMessage", config.showMessage !== false)}</div>`;
    } else if (inst.type === "garland") {
      // Режим, палитра и размеры: сторона у гирлянды всегда верхняя.
      const mode = String(config.mode || "twinkle");
      const palette = typeof config.palette === "string" ? config.palette : "classic";
      const option = (value, selected, label) =>
        `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`;
      extraHtml = `
        <div class="md-field"><label>${t("properties.garlandMode")}</label>
          <select id="pGarlandMode">
            ${option("twinkle", mode, t("properties.garlandModeTwinkle"))}
            ${option("chase", mode, t("properties.garlandModeChase"))}
            ${option("wave", mode, t("properties.garlandModeWave"))}
            ${option("blink", mode, t("properties.garlandModeBlink"))}
            ${option("steady", mode, t("properties.garlandModeSteady"))}
          </select>
        </div>
        <div class="md-field"><label>${t("properties.garlandPalette")}</label>
          <select id="pGarlandPalette">
            ${option("classic", palette, t("properties.garlandPaletteClassic"))}
            ${option("warm", palette, t("properties.garlandPaletteWarm"))}
            ${option("cool", palette, t("properties.garlandPaletteCool"))}
            ${option("redgreen", palette, t("properties.garlandPaletteRedGreen"))}
            ${option("retro", palette, t("properties.garlandPaletteRetro"))}
          </select>
        </div>
        <div class="properties__row">
          <div class="md-field"><label>${t("properties.garlandBulbs")}</label><input type="number" id="pGarlandBulbs" min="4" max="240" step="1" value="${config.bulbs || 24}"></div>
          <div class="md-field"><label>${t("properties.garlandSwags")}</label><input type="number" id="pGarlandSwags" min="1" max="24" step="1" value="${config.swags || 5}"></div>
        </div>
        <div class="properties__row">
          <div class="md-field"><label>${t("properties.garlandSag")}</label><input type="number" id="pGarlandSag" min="0" max="1" step="0.05" value="${config.sag ?? 0.5}"></div>
          <div class="md-field"><label>${t("properties.garlandSpeed")}</label><input type="number" id="pGarlandSpeed" min="0.25" max="4" step="0.25" value="${config.speed ?? 1}"></div>
        </div>
        <div class="properties__toggle-row"><label>${t("properties.garlandReact")}</label>${switchHtml("pGarlandReact", config.reactToAlerts !== false)}</div>`;
    } else if (inst.type === "snow") {
      const density = Math.round(config.density ?? 40);
      const speed = config.speed ?? 1;
      const size = config.size ?? 3;
      const wind = config.wind ?? 0.2;
      extraHtml = `
        <div class="md-field"><label>${t("properties.snowDensity")}: <span id="pSnowDensityValue">${density}</span></label><input type="range" id="pSnowDensity" min="5" max="100" step="1" value="${density}"></div>
        <div class="md-field"><label>${t("properties.snowSpeed")}: <span id="pSnowSpeedValue">${speed}</span></label><input type="range" id="pSnowSpeed" min="0.25" max="3" step="0.25" value="${speed}"></div>
        <div class="properties__row">
          <div class="md-field"><label>${t("properties.snowSize")}</label><input type="number" id="pSnowSize" min="1" max="8" step="0.5" value="${size}"></div>
          <div class="md-field"><label>${t("properties.snowWind")}</label><input type="number" id="pSnowWind" min="-1" max="1" step="0.1" value="${wind}"></div>
        </div>
        <div class="md-field"><label>${t("properties.snowColor")}</label><input type="text" id="pSnowColor" value="${escapeAttr(config.color || "#ffffff")}" placeholder="#ffffff"></div>
        <div class="properties__toggle-row"><label>${t("properties.snowReact")}</label>${switchHtml("pSnowReact", config.reactToAlerts !== false)}</div>`;
    }

    // Поворот в плоскости кадра — всем 3D-виджетам. Угол складывается с
    // наклоном перспективы, поэтому знак можно поставить под любым углом к
    // кадру, а не только «ровно» или «с наклоном». У 2D-виджета поле остаётся,
    // если угол уже задан: тему могли переключить после поворота, и убрать
    // его из 2D-темы иначе было бы нечем.
    if (def.dimension === "3d" || config.angle != null) {
      const angle = Math.round((((Number(config.angle) || 0) % 360) + 360) % 360);
      extraHtml += `
        <div class="md-field"><label>${t("properties.angle")}: <span id="pWidgetAngleValue">${angle}</span>°</label><input type="range" id="pWidgetAngle" min="0" max="359" step="1" value="${angle}"></div>`;
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

    // Ползунок поворота общий для всех 3D-виджетов.
    const angleInput = propertiesEl.querySelector("#pWidgetAngle");
    if (angleInput) {
      angleInput.addEventListener("input", (e) => {
        const value = Number(e.target.value);
        const label = propertiesEl.querySelector("#pWidgetAngleValue");
        if (label) label.textContent = String(value);
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { angle: value } } });
      });
    }

    if (inst.type === "goal" || inst.type === "grimhex-goal" || inst.type === "nuclear-goal" || inst.type === "cobra-goal" || inst.type === "wardogs-goal" || inst.type === "md3-goal" || inst.type === "pixel-goal" || inst.type === "teso-goal" || inst.type === "retrowave-goal") {
      propertiesEl.querySelector("#pGoalTitle").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { title: e.target.value }));
      propertiesEl.querySelector("#pGoalCurrent").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { current: Number(e.target.value) }));
      propertiesEl.querySelector("#pGoalTarget").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { target: Number(e.target.value) }));
      propertiesEl.querySelector("#pGoalCurrency").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { currency: e.target.value }));
      wireSwitch(propertiesEl.querySelector("#pShowPercent"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showPercentage: on } } }));
      wireSwitch(propertiesEl.querySelector("#pShowBackground"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showBackground: on } } }));
      // Наклон есть только у 3D-целей: у обычной «goal» ползунка нет.
      const perspective = propertiesEl.querySelector("#pPerspective");
      if (perspective) {
        perspective.addEventListener("input", (e) => {
          const value = Number(e.target.value);
          const label = propertiesEl.querySelector("#pPerspectiveValue");
          if (label) label.textContent = String(value);
          send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { perspective: value } } });
        });
      }
      const perspectiveDirection = propertiesEl.querySelector("#pPerspectiveDirection");
      if (perspectiveDirection) {
        perspectiveDirection.addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { perspectiveDirection: e.target.value } } }));
      }
    } else if (inst.type === "chat") {
      propertiesEl.querySelector("#pMaxMessages").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { maxMessages: Number(e.target.value) } } }));
      wireSwitch(propertiesEl.querySelector("#pShowBadges"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showBadges: on } } }));
    } else if (inst.type === "grimhex-chat" || inst.type === "nuclear-chat" || inst.type === "cobra-chat" || inst.type === "md3-chat" || inst.type === "pixel-chat" || inst.type === "teso-chat" || inst.type === "wardogs-chat" || inst.type === "retrowave-chat") {
      propertiesEl.querySelector("#pMaxMessages").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { maxMessages: Number(e.target.value) } } }));
      wireSwitch(propertiesEl.querySelector("#pChatShowTime"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showTime: on } } }));
      propertiesEl.querySelector("#pPerspective").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pPerspectiveValue");
        if (label) label.textContent = String(v);
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { perspective: v } } });
      });
    } else if (inst.type === "grimhex" || inst.type === "musain" || inst.type === "nuclear" || inst.type === "cobra" || inst.type === "elite-sign" || inst.type === "teso-seal" || inst.type === "md3-orb" || inst.type === "pixel-cube" || inst.type === "wardogs-cube" || inst.type === "retrowave-symbol") {
      propertiesEl.querySelector("#pPerspective").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pPerspectiveValue");
        if (label) label.textContent = String(v);
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { perspective: v } } });
      });
      // Only MOTION_TOGGLE_TYPES carry the switch: for the other types of this
      // branch the element is absent, and wireSwitch(null) does nothing.
      wireSwitch(propertiesEl.querySelector("#pMotion"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { motion: on } } }));
    } else if (inst.type === "cobra-shield" || inst.type === "cobra-radar" || inst.type === "grimhex-radar") {
      propertiesEl.querySelector("#pOpacity").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        const label = propertiesEl.querySelector("#pOpacityValue");
        if (label) label.textContent = `${v}%`;
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { opacity: v } } });
      });
    } else if (inst.type.endsWith("-recent")) {
      const patchRecent = (configPatch) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: configPatch } });
      propertiesEl.querySelector("#pMaxItems").addEventListener("change", (e) => patchRecent({ maxItems: Number(e.target.value) || 5 }));
      propertiesEl.querySelector("#pRecentAnimation").addEventListener("input", (e) => {
        const value = Number(e.target.value);
        const label = propertiesEl.querySelector("#pRecentAnimationValue");
        if (label) label.textContent = String(value);
        patchRecent({ animationMs: value, animationMsCustom: true });
      });
      propertiesEl.querySelector("#pPerspective").addEventListener("input", (e) => {
        const value = Number(e.target.value);
        const label = propertiesEl.querySelector("#pPerspectiveValue");
        if (label) label.textContent = String(value);
        patchRecent({ perspective: value });
      });
      propertiesEl.querySelector("#pPerspectiveDirection").addEventListener("change", (e) => patchRecent({ perspectiveDirection: e.target.value }));
    } else if (inst.type === "recent") {
      const patchRecent = (configPatch) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: configPatch } });
      propertiesEl.querySelector("#pMaxItems").addEventListener("change", (e) => patchRecent({ maxItems: Number(e.target.value) }));
      propertiesEl.querySelector("#pPerspective").addEventListener("input", (e) => {
        const value = Number(e.target.value);
        const label = propertiesEl.querySelector("#pPerspectiveValue");
        if (label) label.textContent = String(value);
        patchRecent({ perspective: value });
      });
      propertiesEl.querySelector("#pPerspectiveDirection").addEventListener("change", (e) => patchRecent({ perspectiveDirection: e.target.value }));
    } else if (inst.type === "ticker" || inst.type.endsWith("-ticker")) {
      const patchTicker = (configPatch) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: configPatch } });
      const sources = {
        donations: true,
        follows: true,
        subs: true,
        rewards: true,
        chat: false,
        goal: false,
        top: false,
        ...(config.sources || {}),
      };
      const setSource = (key, on) => {
        sources[key] = on;
        patchTicker({ sources: { ...sources } });
      };
      propertiesEl.querySelector("#pTickerSpeed").addEventListener("change", (e) => patchTicker({ speed: Math.max(20, Math.min(200, Number(e.target.value) || 80)) }));
      propertiesEl.querySelector("#pTickerDirection").addEventListener("change", (e) => patchTicker({ direction: e.target.value }));
      propertiesEl.querySelector("#pTickerLabel").addEventListener("change", (e) => patchTicker({ label: e.target.value.trim() }));
      wireSwitch(propertiesEl.querySelector("#pTickerShowLabel"), (on) => patchTicker({ showLabel: on }));
      wireSwitch(propertiesEl.querySelector("#pTickerSourceDonations"), (on) => setSource("donations", on));
      wireSwitch(propertiesEl.querySelector("#pTickerSourceFollows"), (on) => setSource("follows", on));
      wireSwitch(propertiesEl.querySelector("#pTickerSourceSubs"), (on) => setSource("subs", on));
      wireSwitch(propertiesEl.querySelector("#pTickerSourceRewards"), (on) => setSource("rewards", on));
      wireSwitch(propertiesEl.querySelector("#pTickerRewardsBreaking"), (on) => patchTicker({ rewardsBreaking: on }));
      wireSwitch(propertiesEl.querySelector("#pTickerSourceChat"), (on) => setSource("chat", on));
      wireSwitch(propertiesEl.querySelector("#pTickerSourceGoal"), (on) => setSource("goal", on));
      wireSwitch(propertiesEl.querySelector("#pTickerSourceTop"), (on) => setSource("top", on));
      propertiesEl.querySelector("#pTickerMaxItems").addEventListener("change", (e) => patchTicker({ maxItems: Math.max(1, Math.min(60, Number(e.target.value) || 24)) }));
      const perspective = propertiesEl.querySelector("#pPerspective");
      if (perspective) {
        perspective.addEventListener("input", (e) => {
          const value = Number(e.target.value);
          const label = propertiesEl.querySelector("#pPerspectiveValue");
          if (label) label.textContent = String(value);
          patchTicker({ perspective: value });
        });
      }
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
      const patchParticipants = (configPatch) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: configPatch } });
      propertiesEl.querySelector("#pParticipantsMaxNames").addEventListener("change", (e) => patchParticipants({ maxNames: Number(e.target.value) || 10 }));
      propertiesEl.querySelector("#pParticipantsFontSize").addEventListener("change", (e) => patchParticipants({ fontSize: Number(e.target.value) || 16 }));
      propertiesEl.querySelector("#pParticipantsTextColor").addEventListener("input", (e) => patchParticipants({ textColor: e.target.value }));
      propertiesEl.querySelector("#pParticipantsBgOpacity").addEventListener("input", (e) => {
        const value = Number(e.target.value);
        const label = propertiesEl.querySelector("#pParticipantsBgOpacityValue");
        if (label) label.textContent = `${value}%`;
        patchParticipants({ backgroundOpacity: value });
      });
      wireSwitch(propertiesEl.querySelector("#pParticipantsMarquee"), (on) => patchParticipants({ marquee: on }));
    } else if (inst.type === "grimhex-timer" || inst.type === "timer") {
      const patchTimer = (configPatch) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: configPatch } });
      wireSwitch(propertiesEl.querySelector("#pTimerShowLights"), (on) => patchTimer({ showLights: on }));
      wireSwitch(propertiesEl.querySelector("#pTimerShowCycle"), (on) => patchTimer({ showCycle: on }));
      wireSwitch(propertiesEl.querySelector("#pTimerShowTelemetry"), (on) => patchTimer({ showTelemetry: on }));
      const refreshBtn = propertiesEl.querySelector("#pTimerRefresh");
      if (refreshBtn) refreshBtn.addEventListener("click", () => send(EVENT_TYPES.CMD_REFRESH_LONGSHOT, {}));
      const perspective = propertiesEl.querySelector("#pPerspective");
      if (perspective) {
        perspective.addEventListener("input", (e) => {
          const value = Number(e.target.value);
          const label = propertiesEl.querySelector("#pPerspectiveValue");
          if (label) label.textContent = String(value);
          send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { perspective: value } } });
        });
      }
      const perspectiveDirection = propertiesEl.querySelector("#pPerspectiveDirection");
      if (perspectiveDirection) {
        perspectiveDirection.addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { perspectiveDirection: e.target.value } } }));
      }
    } else if (inst.type === "mic") {
      // Настройки отображения пишем в конфиг виджета (per-widget).
      const setMic = (key, value) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { [key]: value } } });
      // Поворот и направление — быстрые действия. «Поворот» каждый раз
      // добавляет 90° и меняет стороны рамки: горизонтальный виджет становится
      // вертикальным и наоборот. «Направление» разворачивает рисунок на 180°,
      // не трогая рамку. Угол читаем из живого пункта раскладки, а не из
      // замыкания: быстрые щелчки до перерисовки панели иначе считали бы от
      // одного и того же значения.
      const rotateMic = (delta) => {
        const item = state.layout.find((w) => w.id === inst.id) || inst;
        const current = Number(item.config && item.config.rotation);
        const base = current === 90 || current === 180 || current === 270 ? current : 0;
        const rect = micRotationPatch(item, (base + delta) % 360);
        const geo = rect.swapped
          ? { x: round1(rect.x), y: round1(rect.y), w: round1(rect.w), h: round1(rect.h) }
          : null;
        const patch = { config: { rotation: rect.rotation } };
        if (geo) Object.assign(patch, geo);
        // Подгоняем снимок сразу, иначе следующий рендер откатит состояние.
        item.config = Object.assign({}, item.config, { rotation: rect.rotation });
        if (geo) Object.assign(item, geo);
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch });
      };
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
      const micRotateEl = propertiesEl.querySelector("#pMicRotate");
      if (micRotateEl) micRotateEl.addEventListener("click", () => rotateMic(90));
      const micFlipEl = propertiesEl.querySelector("#pMicFlip");
      if (micFlipEl) micFlipEl.addEventListener("click", () => rotateMic(180));
      wireSwitch(propertiesEl.querySelector("#pMicMirror"), (on) => setMic("mirror", on));
      onMicRange("pMicSensitivity", "pMicSensitivityValue", (v) => v.toFixed(1), (v) => setMic("sensitivity", v));
      onMicRange("pMicLineWidth", "pMicLineWidthValue", (v) => v.toFixed(1), (v) => setMic("lineWidth", v));
      onMicRange("pMicBarCount", "pMicBarCountValue", (v) => String(Math.round(v)), (v) => setMic("barCount", Math.round(v)));
      onMicRange("pMicBarGap", "pMicBarGapValue", (v) => v.toFixed(1), (v) => setMic("barGap", v));
      onMicRange("pMicSmoothing", "pMicSmoothingValue", (v) => `${Math.round(v * 100)}%`, (v) => setMic("smoothing", v));
      onMicRange("pMicGain", "pMicGainValue", (v) => `${v.toFixed(1)}×`, (v) => setMic("gain", v));
      onMicRange("pMicNoiseGate", "pMicNoiseGateValue", (v) => `${Math.round(v * 100)}%`, (v) => setMic("noiseGate", v));
      onMicRange("pMicOpacity", "pMicOpacityValue", (v) => `${Math.round(v)}%`, (v) => setMic("opacity", v / 100));
      const micPerspective = propertiesEl.querySelector("#pPerspective");
      if (micPerspective) {
        micPerspective.addEventListener("input", (e) => {
          const v = Number(e.target.value);
          const label = propertiesEl.querySelector("#pPerspectiveValue");
          if (label) label.textContent = String(v);
          setMic("perspective", v);
        });
      }
      const micPerspectiveDirection = propertiesEl.querySelector("#pPerspectiveDirection");
      if (micPerspectiveDirection) {
        micPerspectiveDirection.addEventListener("change", (e) => setMic("perspectiveDirection", e.target.value));
      }
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
    } else if (inst.type === "webcam") {
      const patchWebcam = (configPatch) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: configPatch } });
      propertiesEl.querySelector("#pWebcamSource").addEventListener("change", (e) => {
        const nextSource = e.target.value;
        const patch = { source: nextSource };
        // Без слота приёмник не подпишется на гостя — подставляем свободный.
        if (nextSource === "remote" && !String(config.guestSlot || "").trim()) {
          patch.guestSlot = unusedGuestSlot(inst.id);
        }
        patchWebcam(patch);
        if (nextSource === "camera" && typeof refreshCameraDevices === "function") refreshCameraDevices();
      });
      propertiesEl.querySelector("#pWebcamLabel").addEventListener("change", (e) => patchWebcam({ label: e.target.value }));
      wireSwitch(propertiesEl.querySelector("#pWebcamShowLabel"), (on) => patchWebcam({ showLabel: on }));
      propertiesEl.querySelector("#pWebcamLabelPosition").addEventListener("change", (e) => patchWebcam({ labelPosition: e.target.value }));
      wireSwitch(propertiesEl.querySelector("#pWebcamShowBorder"), (on) => patchWebcam({ showBorder: on }));
      wireSwitch(propertiesEl.querySelector("#pWebcamShowCorners"), (on) => patchWebcam({ showCorners: on }));
      wireSwitch(propertiesEl.querySelector("#pWebcamShowBackground"), (on) => patchWebcam({ showBackground: on }));
      wireSwitch(propertiesEl.querySelector("#pWebcamShowVignette"), (on) => patchWebcam({ showVignette: on }));
      const thickness = propertiesEl.querySelector("#pWebcamThickness");
      thickness.addEventListener("input", (e) => {
        const value = Number(e.target.value);
        const label = propertiesEl.querySelector("#pWebcamThicknessValue");
        if (label) label.textContent = String(value);
        patchWebcam({ thickness: value });
      });
      const radius = propertiesEl.querySelector("#pWebcamRadius");
      radius.addEventListener("input", (e) => {
        const value = Number(e.target.value);
        const label = propertiesEl.querySelector("#pWebcamRadiusValue");
        if (label) label.textContent = String(value);
        patchWebcam({ radius: value, radiusAuto: false });
      });
      propertiesEl.querySelector("#pWebcamRadiusReset").addEventListener("click", () => {
        patchWebcam({ radius: null, radiusAuto: true });
      });
      propertiesEl.querySelector("#pWebcamColor").addEventListener("input", (e) => patchWebcam({ color: e.target.value }));
      propertiesEl.querySelector("#pWebcamColorReset").addEventListener("click", () => patchWebcam({ color: "" }));
      const cornerColorInput = propertiesEl.querySelector("#pWebcamCornerColor");
      if (cornerColorInput) cornerColorInput.addEventListener("input", (e) => patchWebcam({ cornerColor: e.target.value }));
      const cornerColorReset = propertiesEl.querySelector("#pWebcamCornerColorReset");
      if (cornerColorReset) cornerColorReset.addEventListener("click", () => patchWebcam({ cornerColor: "" }));
      wireSwitch(propertiesEl.querySelector("#pWebcamNeon"), (on) => patchWebcam({ neon: on }));
      const neonRange = propertiesEl.querySelector("#pWebcamNeonStrength");
      if (neonRange) {
        neonRange.addEventListener("input", (e) => {
          const value = Number(e.target.value);
          const label = propertiesEl.querySelector("#pWebcamNeonValue");
          if (label) label.textContent = String(value);
          patchWebcam({ neonStrength: value });
        });
      }
      const guestSlotSelect = propertiesEl.querySelector("#pWebcamGuestSlot");
      if (guestSlotSelect) {
        guestSlotSelect.addEventListener("change", (e) => patchWebcam({ guestSlot: e.target.value }));
      }
      const guestVolumeRange = propertiesEl.querySelector("#pWebcamGuestVolume");
      if (guestVolumeRange) {
        guestVolumeRange.addEventListener("input", (e) => {
          const value = Number(e.target.value);
          const label = propertiesEl.querySelector("#pWebcamGuestVolumeValue");
          if (label) label.textContent = `${value}%`;
          patchWebcam({ volume: value });
        });
      }
      wireSwitch(propertiesEl.querySelector("#pWebcamVideoOnly"), (on) => patchWebcam({ videoOnly: on }));
      wireSwitch(propertiesEl.querySelector("#pCameraEnabled"), (on) => sendCameraCaptureConfig({ enabled: on }));
      const cameraDevice = propertiesEl.querySelector("#pCameraDevice");
      if (cameraDevice) {
        cameraDevice.addEventListener("change", (e) => sendCameraCaptureConfig({ deviceId: e.target.value }));
      }
      const cameraDeviceRefresh = propertiesEl.querySelector("#pCameraDeviceRefresh");
      if (cameraDeviceRefresh) cameraDeviceRefresh.addEventListener("click", () => refreshCameraDevices());
      const cameraWidth = propertiesEl.querySelector("#pCameraWidth");
      if (cameraWidth) cameraWidth.addEventListener("change", (e) => sendCameraCaptureConfig({ width: Number(e.target.value) }));
      const cameraCodec = propertiesEl.querySelector("#pCameraCodec");
      if (cameraCodec) cameraCodec.addEventListener("change", (e) => sendCameraCaptureConfig({ codec: e.target.value }));
      const cameraBitrate = propertiesEl.querySelector("#pCameraBitrate");
      if (cameraBitrate) {
        cameraBitrate.addEventListener("input", (e) => {
          const value = Number(e.target.value);
          const label = propertiesEl.querySelector("#pCameraBitrateValue");
          if (label) label.textContent = (value / 1000).toFixed(1);
          sendCameraCaptureConfig({ bitrateKbps: value });
        });
      }
      const cameraFps = propertiesEl.querySelector("#pCameraFps");
      if (cameraFps) {
        cameraFps.addEventListener("input", (e) => {
          const value = Number(e.target.value);
          const label = propertiesEl.querySelector("#pCameraFpsValue");
          if (label) label.textContent = String(value);
          sendCameraCaptureConfig({ fps: value });
        });
      }
      const cameraQuality = propertiesEl.querySelector("#pCameraQuality");
      if (cameraQuality) {
        cameraQuality.addEventListener("input", (e) => {
          const value = Number(e.target.value);
          const label = propertiesEl.querySelector("#pCameraQualityValue");
          if (label) label.textContent = `${value}%`;
          sendCameraCaptureConfig({ quality: value / 100 });
        });
      }
      wireSwitch(propertiesEl.querySelector("#pWebcamMirror"), (on) => patchWebcam({ mirror: on }));
      const fit = propertiesEl.querySelector("#pWebcamFit");
      if (fit) fit.addEventListener("change", (e) => patchWebcam({ fit: e.target.value }));
      propertiesEl.querySelector("#pPerspective").addEventListener("input", (e) => {
        const value = Number(e.target.value);
        const label = propertiesEl.querySelector("#pPerspectiveValue");
        if (label) label.textContent = String(value);
        patchWebcam({ perspective: value });
      });
      propertiesEl.querySelector("#pPerspectiveDirection").addEventListener("change", (e) => patchWebcam({ perspectiveDirection: e.target.value }));
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
    } else if (inst.type === "donatex-ai") {
      propertiesEl.querySelector("#pDonatexUrl").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { url: e.target.value.trim() } } }));
      propertiesEl.querySelector("#pDonatexAvatar").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { avatarUrl: e.target.value.trim() } } }));
      wireSwitch(propertiesEl.querySelector("#pDonatexShowName"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showName: on } } }));
      propertiesEl.querySelector("#pDonatexVolume").addEventListener("input", (e) => {
        const value = Number(e.target.value);
        const label = propertiesEl.querySelector("#pDonatexVolumeValue");
        if (label) label.textContent = `${value}%`;
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { volume: value / 100 } } });
      });
      propertiesEl.querySelector("#pDonatexHideDelay").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { hideDelayMs: Math.max(500, Number(e.target.value) || 5000) } } }));
    } else if (inst.type === "music") {
      wireSwitch(propertiesEl.querySelector("#pMusicAutoplay"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { autoplay: on } } }));
    } else if (inst.type === "uec-transfer") {
      propertiesEl.querySelector("#pUecChannel").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { channel: e.target.value.trim() } } }));
      propertiesEl.querySelector("#pUecDuration").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { durationMs: Math.max(1500, Math.min(60000, Number(e.target.value) || 9000)) } } }));
      propertiesEl.querySelector("#pUecDecode").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { decodeTickMs: Math.max(10, Math.min(500, Number(e.target.value) || 76)) } } }));
      wireSwitch(propertiesEl.querySelector("#pUecShowAmount"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showAmount: on } } }));
      wireSwitch(propertiesEl.querySelector("#pUecShowMessage"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showMessage: on } } }));
    } else if (inst.type === "garland") {
      const patchGarland = (config) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config } });
      propertiesEl.querySelector("#pGarlandMode").addEventListener("change", (e) => patchGarland({ mode: e.target.value }));
      propertiesEl.querySelector("#pGarlandPalette").addEventListener("change", (e) => patchGarland({ palette: e.target.value }));
      propertiesEl.querySelector("#pGarlandBulbs").addEventListener("change", (e) =>
        patchGarland({ bulbs: Math.max(4, Math.min(240, Math.round(Number(e.target.value) || 24))) }),
      );
      propertiesEl.querySelector("#pGarlandSwags").addEventListener("change", (e) =>
        patchGarland({ swags: Math.max(1, Math.min(24, Math.round(Number(e.target.value) || 5))) }),
      );
      propertiesEl.querySelector("#pGarlandSag").addEventListener("change", (e) =>
        patchGarland({ sag: Math.max(0, Math.min(1, Number(e.target.value) || 0)) }),
      );
      propertiesEl.querySelector("#pGarlandSpeed").addEventListener("change", (e) =>
        patchGarland({ speed: Math.max(0.25, Math.min(4, Number(e.target.value) || 1)) }),
      );
      wireSwitch(propertiesEl.querySelector("#pGarlandReact"), (on) => patchGarland({ reactToAlerts: on }));
    } else if (inst.type === "snow") {
      const patchSnow = (config) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config } });
      // Два ползунка с живой подписью: плотность и скорость важнее всего
      // крутить на глаз.
      const snowRange = (id, key, min, max) => {
        const input = propertiesEl.querySelector("#" + id);
        if (!input) return;
        input.addEventListener("input", (e) => {
          const value = Math.max(min, Math.min(max, Number(e.target.value)));
          const label = propertiesEl.querySelector("#" + id + "Value");
          if (label) label.textContent = String(value);
          patchSnow({ [key]: value });
        });
      };
      snowRange("pSnowDensity", "density", 5, 100);
      snowRange("pSnowSpeed", "speed", 0.25, 3);
      propertiesEl.querySelector("#pSnowSize").addEventListener("change", (e) =>
        patchSnow({ size: Math.max(1, Math.min(8, Number(e.target.value) || 3)) }),
      );
      propertiesEl.querySelector("#pSnowWind").addEventListener("change", (e) =>
        patchSnow({ wind: Math.max(-1, Math.min(1, Number(e.target.value) || 0)) }),
      );
      propertiesEl.querySelector("#pSnowColor").addEventListener("change", (e) => patchSnow({ color: e.target.value.trim() }));
      wireSwitch(propertiesEl.querySelector("#pSnowReact"), (on) => patchSnow({ reactToAlerts: on }));
    }

    document.getElementById("pDeleteBtn").addEventListener("click", () => {
      const label = inst.type === "custom" && config.name ? config.name : t("widgets." + (def.type || inst.type));
      if (!confirm(t("common.deleteWidgetConfirm", { name: label }))) return;
      send(EVENT_TYPES.CMD_REMOVE_WIDGET, { id: inst.id });
      state.selectedId = null;
    });
  }

  return { render, invalidate, updateCameraStreamInfo };
}
