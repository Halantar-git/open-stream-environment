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
  Окно монтажа алерта. Сверху — превью рамки виджета, снизу — дорожки со
  слоями, справа — свойства выбранного слоя и события, на которые реагирует
  композиция.

  Окно не хранит копию раскладки: оно читает виджет из снимка `state`, а
  сохраняет через `CMD_UPDATE_WIDGET` — тем же путём, что инспектор. Поэтому
  случайная правка в панели и монтаж не расходятся между собой.
*/
(function () {
  const LC = window.OSEWidgets && window.OSEWidgets.LayerComposition;
  if (!LC) return;

  const { EVENT_TYPES } = window.SharedEvents;
  const t = (key, params) => (window.I18n ? window.I18n.t(key, params) : key);
  const params = new URLSearchParams(location.search);
  const port = params.get("port") || "8710";
  const widgetId = params.get("widgetId");

  const LABEL_WIDTH = 132;
  const MIN_DURATION = 100;
  const MAX_TIME = 600000;

  const statusLabel = document.getElementById("statusLabel");
  const saveBtn = document.getElementById("saveBtn");
  const testBtn = document.getElementById("testBtn");
  const previewBox = document.getElementById("previewBox");
  const stage = document.getElementById("stage");
  const rows = document.getElementById("rows");
  const rulerTrack = document.getElementById("rulerTrack");
  const layerList = document.getElementById("layerList");
  const inspector = document.getElementById("inspector");
  const composition = document.getElementById("composition");
  const playhead = document.getElementById("playhead");

  let ws;
  let loaded = false;
  let widgetGone = false;
  let statusKind = null;
  let statusTimer = null;
  let previewTimer = null;
  let progressRaf = 0;
  let layerCounter = 0;

  const state = {
    geometry: { w: 48, h: 30 },
    config: LC.normalizeConfig({ eventKinds: [], durationMs: 6000, layers: [] }),
    selectedId: null,
    playing: false,
    drag: null,
  };

  const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", UAH: "₴", KZT: "₸", GBP: "£" };

  function formatMoney(value) {
    const locale = window.I18n && window.I18n.getLang() === "ru" ? "ru-RU" : "en-US";
    return Number(value || 0).toLocaleString(locale);
  }

  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || code || "";
  }

  const previewOptions = {
    formatMoney,
    currencySymbol,
    resolveMediaUrl: (path) => LC.resolveMedia(path),
  };

  const player = LC.createPlayer(stage, previewOptions);

  // ---- utils ----

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function round1(value) {
    return Math.round(Number(value) * 10) / 10;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }

  function basename(path) {
    const parts = String(path || "").split(/[\\/]/);
    return parts[parts.length - 1] || "";
  }

  function findLayer(id) {
    return state.config.layers.find((layer) => layer.id === id) || null;
  }

  function layerKindLabel(type) {
    if (type === "image") return t("timelineEditor.layerImage");
    if (type === "video") return t("timelineEditor.layerVideo");
    return t("timelineEditor.layerText");
  }

  function layerTitle(layer, index) {
    return layerKindLabel(layer.type) + " " + (index + 1);
  }

  function clipLabel(layer) {
    if (layer.type === "text") {
      const text = String(layer.text || "").replace(/\s+/g, " ").trim();
      return text ? text.slice(0, 42) : layerKindLabel("text");
    }
    return basename(layer.src) || layerKindLabel(layer.type);
  }

  function kindLabel(kind) {
    const keys = {
      follow: "timelineEditor.kinds.follow",
      sub: "timelineEditor.kinds.sub",
      gift_sub: "timelineEditor.kinds.giftSub",
      cheer: "timelineEditor.kinds.cheer",
      donation: "timelineEditor.kinds.donation",
      reward: "timelineEditor.kinds.reward",
      ai: "timelineEditor.kinds.ai",
      boosty_sub: "timelineEditor.kinds.boostySub",
      boosty_resub: "timelineEditor.kinds.boostyResub",
    };
    return t(keys[kind] || kind);
  }

  function timelineTotal() {
    const total = LC.compositionDuration(state.config);
    return Math.max(4000, Math.ceil(total / 1000) * 1000);
  }

  function sampleAlert() {
    const kind = state.config.eventKinds[0] || "donation";
    return {
      kind,
      user: "Stargazer",
      amount: 1000,
      currency: "RUB",
      message: t("timelineEditor.sampleMessage"),
      count: 5,
      months: 3,
      rewardTitle: t("timelineEditor.sampleReward"),
    };
  }

  function newLayerId(type) {
    layerCounter += 1;
    return type + "-" + Date.now().toString(36) + "-" + layerCounter;
  }

  // ---- rendering ----

  function renderStatus() {
    if (!statusLabel) return;
    if (statusKind === "saved") statusLabel.textContent = t("timelineEditor.saved");
    else if (statusKind === "removed") statusLabel.textContent = t("timelineEditor.removed");
    else statusLabel.textContent = "";
  }

  function setStatus(kind) {
    statusKind = kind;
    renderStatus();
    clearTimeout(statusTimer);
    if (kind === "saved") {
      statusTimer = setTimeout(() => {
        if (statusKind === "saved") {
          statusKind = null;
          renderStatus();
        }
      }, 1500);
    }
  }

  function updateStageSize() {
    if (!previewBox || !stage) return;
    const rect = previewBox.getBoundingClientRect();
    const availW = Math.max(40, rect.width - 8);
    const availH = Math.max(30, rect.height - 8);
    const w = Number(state.geometry.w) || 48;
    const h = Number(state.geometry.h) || 30;
    const aspect = (w * 16) / (h * 9);
    let stageW = availW;
    let stageH = stageW / aspect;
    if (stageH > availH) {
      stageH = availH;
      stageW = stageH * aspect;
    }
    stage.style.width = Math.round(stageW) + "px";
    stage.style.height = Math.round(stageH) + "px";
  }

  function renderPreview() {
    if (state.playing) return;
    LC.renderStatic(stage, state.config, sampleAlert(), previewOptions);
  }

  function schedulePreview(delay) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, delay == null ? 120 : delay);
  }

  function renderRuler() {
    const total = timelineTotal();
    const step = total <= 8000 ? 1000 : total <= 20000 ? 2000 : 5000;
    const parts = [];
    for (let ms = 0; ms <= total; ms += step) {
      const percent = (ms / total) * 100;
      parts.push(
        '<span class="te-tick" style="left:' +
          percent +
          '%"><i></i><b>' +
          ms / 1000 +
          "s</b></span>"
      );
    }
    rulerTrack.innerHTML = parts.join("");
    rows.style.setProperty("--te-tick-step", (step / total) * 100 + "%");
  }

  function updateClipVisual(layer) {
    const total = state.drag ? state.drag.total : timelineTotal();
    const clip = Array.from(rows.querySelectorAll(".te-clip")).find(
      (node) => node.dataset.id === layer.id
    );
    if (!clip) return;
    clip.style.left = (layer.start / total) * 100 + "%";
    clip.style.width = Math.max(1, (layer.duration / total) * 100) + "%";
  }

  function renderRows() {
    const total = timelineTotal();
    rows.innerHTML = "";
    state.config.layers.forEach((layer, index) => {
      const row = document.createElement("div");
      row.className = "te-row" + (layer.id === state.selectedId ? " is-selected" : "");
      row.dataset.id = layer.id;

      const label = document.createElement("button");
      label.type = "button";
      label.className = "te-row__label";
      label.innerHTML =
        '<span class="te-row__kind">' +
        escapeHtml(layer.type === "text" ? "T" : layer.type === "image" ? "IMG" : "VID") +
        '</span><span class="te-row__name">' +
        escapeHtml(layerTitle(layer, index)) +
        "</span>";
      label.addEventListener("click", () => selectLayer(layer.id));

      const track = document.createElement("div");
      track.className = "te-row__track";
      const clip = document.createElement("div");
      clip.className =
        "te-clip te-clip--" + layer.type + (layer.id === state.selectedId ? " is-selected" : "");
      clip.dataset.id = layer.id;
      clip.style.left = (layer.start / total) * 100 + "%";
      clip.style.width = Math.max(1, (layer.duration / total) * 100) + "%";
      clip.innerHTML =
        '<span class="te-clip__handle te-clip__handle--start"></span><span class="te-clip__label">' +
        escapeHtml(clipLabel(layer)) +
        '</span><span class="te-clip__handle te-clip__handle--end"></span>';
      clip.addEventListener("pointerdown", (event) => startDrag(event, layer));
      track.appendChild(clip);

      row.appendChild(label);
      row.appendChild(track);
      rows.appendChild(row);
    });
    rows.appendChild(playhead);
  }

  function renderLayerList() {
    layerList.innerHTML = "";
    if (!state.config.layers.length) {
      const empty = document.createElement("p");
      empty.className = "te-empty";
      empty.textContent = t("timelineEditor.emptyLayers");
      layerList.appendChild(empty);
      return;
    }
    state.config.layers.forEach((layer, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "te-layer-item" + (layer.id === state.selectedId ? " is-selected" : "");
      item.innerHTML =
        '<span class="te-layer-item__kind">' +
        escapeHtml(layer.type === "text" ? "T" : layer.type === "image" ? "IMG" : "VID") +
        '</span><span class="te-layer-item__name">' +
        escapeHtml(layerTitle(layer, index)) +
        '</span><span class="te-layer-item__time">' +
        (layer.start / 1000).toFixed(1) +
        "s</span>";
      item.addEventListener("click", () => selectLayer(layer.id));
      layerList.appendChild(item);
    });
  }

  function renderInspector() {
    const layer = findLayer(state.selectedId);
    if (!layer) {
      inspector.innerHTML = '<p class="te-empty">' + escapeHtml(t("timelineEditor.noSelection")) + "</p>";
      return;
    }
    const index = state.config.layers.indexOf(layer);
    const isText = layer.type === "text";
    const isVideo = layer.type === "video";

    const animationOptions = LC.ANIMATIONS.map(
      (name) =>
        '<option value="' +
        name +
        '"' +
        (layer.in === name ? " selected" : "") +
        ">" +
        escapeHtml(t("timelineEditor.anim." + name)) +
        "</option>"
    ).join("");
    const outOptions = LC.ANIMATIONS.map(
      (name) =>
        '<option value="' +
        name +
        '"' +
        (layer.out === name ? " selected" : "") +
        ">" +
        escapeHtml(t("timelineEditor.anim." + name)) +
        "</option>"
    ).join("");
    const alignOptions = LC.ALIGNS.map(
      (name) =>
        '<option value="' +
        name +
        '"' +
        (layer.align === name ? " selected" : "") +
        ">" +
        escapeHtml(t("timelineEditor.align." + name)) +
        "</option>"
    ).join("");
    const fontOptions = LC.FONTS.map(
      (name) =>
        '<option value="' +
        name +
        '"' +
        (layer.font === name ? " selected" : "") +
        ">" +
        escapeHtml(t("timelineEditor.font." + name)) +
        "</option>"
    ).join("");
    const fitOptions = LC.FITS.map(
      (name) =>
        '<option value="' +
        name +
        '"' +
        (layer.fit === name ? " selected" : "") +
        ">" +
        escapeHtml(t("timelineEditor.fit" + (name === "cover" ? "Cover" : "Contain"))) +
        "</option>"
    ).join("");

    inspector.innerHTML =
      '<div class="te-inspector__title"><span>' +
      escapeHtml(layerTitle(layer, index)) +
      '</span><button class="md-button md-button--text" id="delLayer" type="button">' +
      escapeHtml(t("timelineEditor.deleteLayer")) +
      "</button></div>" +
      (isText
        ? '<div class="te-field"><label>' +
          escapeHtml(t("timelineEditor.fieldText")) +
          '</label><textarea id="fText">' +
          escapeHtml(layer.text) +
          "</textarea></div>" +
          '<p class="te-hint">' +
          escapeHtml(t("timelineEditor.placeholders")) +
          "</p>" +
          '<div class="te-section">' +
          escapeHtml(t("timelineEditor.textStyle")) +
          "</div>" +
          '<div class="te-field"><label>' +
          escapeHtml(t("timelineEditor.fontSize")) +
          ': <span id="fSizeValue">' +
          round1(layer.size) +
          '</span></label><input type="range" id="fSize" min="0.5" max="30" step="0.5" value="' +
          layer.size +
          '"></div>' +
          '<div class="te-row2">' +
          '<div class="te-field"><label>' +
          escapeHtml(t("timelineEditor.color")) +
          '</label><input type="color" id="fColor" value="' +
          escapeHtml(layer.color) +
          '"></div>' +
          '<div class="te-field"><label>' +
          escapeHtml(t("timelineEditor.weight")) +
          '</label><select id="fWeight"><option value="400"' +
          (layer.weight === 400 ? " selected" : "") +
          '>400</option><option value="600"' +
          (layer.weight === 600 ? " selected" : "") +
          '>600</option><option value="700"' +
          (layer.weight === 700 ? " selected" : "") +
          '>700</option><option value="800"' +
          (layer.weight === 800 ? " selected" : "") +
          ">800</option></select></div></div>" +
          '<div class="te-row2">' +
          '<div class="te-field"><label>' +
          escapeHtml(t("timelineEditor.alignLabel")) +
          '</label><select id="fAlign">' +
          alignOptions +
          "</select></div>" +
          '<div class="te-field"><label>' +
          escapeHtml(t("timelineEditor.fontLabel")) +
          '</label><select id="fFont">' +
          fontOptions +
          "</select></div></div>"
        : '<div class="te-field"><label>' +
          escapeHtml(t("timelineEditor.fieldSrc")) +
          '</label><div class="te-file"><input type="text" id="fSrc" value="' +
          escapeHtml(layer.src) +
          '"><button class="md-button md-button--tonal" id="pickFile" type="button">' +
          escapeHtml(t("timelineEditor.chooseFile")) +
          "</button></div></div>" +
          '<div class="te-row2">' +
          '<div class="te-field"><label>' +
          escapeHtml(t("timelineEditor.fitLabel")) +
          '</label><select id="fFit">' +
          fitOptions +
          "</select></div>" +
          (isVideo
            ? '<label class="te-check"><input type="checkbox" id="fLoop"' +
              (layer.loop ? " checked" : "") +
              ">" +
              escapeHtml(t("timelineEditor.loop")) +
              "</label>"
            : "") +
          "</div>") +
      '<div class="te-section">' +
      escapeHtml(t("timelineEditor.position")) +
      "</div>" +
      '<div class="te-row4">' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.x")) +
      '</label><input type="number" id="fX" step="0.5" value="' +
      round1(layer.x) +
      '"></div>' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.y")) +
      '</label><input type="number" id="fY" step="0.5" value="' +
      round1(layer.y) +
      '"></div>' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.w")) +
      '</label><input type="number" id="fW" step="0.5" value="' +
      round1(layer.w) +
      '"></div>' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.h")) +
      '</label><input type="number" id="fH" step="0.5" value="' +
      round1(layer.h) +
      '"></div></div>' +
      '<div class="te-section">' +
      escapeHtml(t("timelineEditor.timing")) +
      "</div>" +
      '<div class="te-row2">' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.start")) +
      '</label><input type="number" id="fStart" min="0" step="50" value="' +
      Math.round(layer.start) +
      '"></div>' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.durationMs")) +
      '</label><input type="number" id="fDuration" min="100" step="50" value="' +
      Math.round(layer.duration) +
      '"></div></div>' +
      '<div class="te-row2">' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.opacity")) +
      ': <span id="fOpacityValue">' +
      Math.round(layer.opacity * 100) +
      '</span></label><input type="range" id="fOpacity" min="0" max="100" step="1" value="' +
      Math.round(layer.opacity * 100) +
      '"></div>' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.z")) +
      '</label><input type="number" id="fZ" min="0" max="100" step="1" value="' +
      layer.z +
      '"></div></div>' +
      '<div class="te-row2">' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.animationIn")) +
      '</label><select id="fIn">' +
      animationOptions +
      "</select></div>" +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.animationOut")) +
      '</label><select id="fOut">' +
      outOptions +
      "</select></div></div>" +
      '<div class="te-row2">' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.animationInMs")) +
      '</label><input type="number" id="fInMs" min="0" max="5000" step="50" value="' +
      Math.round(layer.inMs) +
      '"></div>' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.animationOutMs")) +
      '</label><input type="number" id="fOutMs" min="0" max="5000" step="50" value="' +
      Math.round(layer.outMs) +
      '"></div></div>';

    bindInspector(layer);
  }

  function bindInspector(layer) {
    const field = (id) => inspector.querySelector("#" + id);
    const bind = (id, event, handler) => {
      const el = field(id);
      if (el) el.addEventListener(event, handler);
    };

    bind("delLayer", "click", () => deleteSelected());

    if (layer.type === "text") {
      bind("fText", "input", (event) => patchLayer({ text: event.target.value }));
      bind("fSize", "input", (event) => {
        const value = Number(event.target.value);
        const label = field("fSizeValue");
        if (label) label.textContent = round1(value);
        patchLayer({ size: value });
      });
      bind("fColor", "input", (event) => patchLayer({ color: event.target.value }));
      bind("fWeight", "change", (event) => patchLayer({ weight: Number(event.target.value) }));
      bind("fAlign", "change", (event) => patchLayer({ align: event.target.value }));
      bind("fFont", "change", (event) => patchLayer({ font: event.target.value }));
    } else {
      bind("fSrc", "change", (event) => patchLayer({ src: event.target.value.trim() }));
      bind("pickFile", "click", () => pickFile(layer));
      bind("fFit", "change", (event) => patchLayer({ fit: event.target.value }));
      bind("fLoop", "change", (event) => patchLayer({ loop: event.target.checked }));
    }

    const number = (id, setter, min, max) => {
      bind(id, "input", (event) => {
        const value = Number(event.target.value);
        if (!Number.isFinite(value)) return;
        setter(clamp(value, min, max));
      });
    };
    number("fX", (value) => patchLayer({ x: value }), -100, 200);
    number("fY", (value) => patchLayer({ y: value }), -100, 200);
    number("fW", (value) => patchLayer({ w: value }), 1, 200);
    number("fH", (value) => patchLayer({ h: value }), 1, 200);
    number("fStart", (value) => patchLayer({ start: value }, true), 0, MAX_TIME);
    number("fDuration", (value) => patchLayer({ duration: value }, true), MIN_DURATION, MAX_TIME);
    number("fZ", (value) => patchLayer({ z: Math.round(value) }), 0, 100);
    number("fInMs", (value) => patchLayer({ inMs: value }), 0, 5000);
    number("fOutMs", (value) => patchLayer({ outMs: value }), 0, 5000);

    bind("fOpacity", "input", (event) => {
      const value = Number(event.target.value);
      const label = field("fOpacityValue");
      if (label) label.textContent = String(Math.round(value));
      patchLayer({ opacity: value / 100 });
    });
    bind("fIn", "change", (event) => patchLayer({ in: event.target.value }));
    bind("fOut", "change", (event) => patchLayer({ out: event.target.value }));
  }

  function renderComposition() {
    const checks = LC.EVENT_KINDS.map(
      (kind) =>
        '<label class="te-check"><input type="checkbox" value="' +
        kind +
        '"' +
        (state.config.eventKinds.indexOf(kind) >= 0 ? " checked" : "") +
        ">" +
        escapeHtml(kindLabel(kind)) +
        "</label>"
    ).join("");

    composition.innerHTML =
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.duration")) +
      ': <span id="compActual"></span></label><input type="number" id="compDuration" min="100" max="600000" step="100" value="' +
      state.config.durationMs +
      '"></div>' +
      '<p class="te-hint">' +
      escapeHtml(t("timelineEditor.durationHint")) +
      "</p>" +
      '<div class="te-section">' +
      escapeHtml(t("timelineEditor.eventKinds")) +
      "</div>" +
      checks +
      '<p class="te-hint">' +
      escapeHtml(t("timelineEditor.eventKindsHint")) +
      "</p>";

    const durationInput = composition.querySelector("#compDuration");
    durationInput.addEventListener("input", (event) => {
      const value = Number(event.target.value);
      if (!Number.isFinite(value)) return;
      state.config.durationMs = clamp(value, MIN_DURATION, MAX_TIME);
      renderRuler();
      updateActualDuration();
    });

    composition.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", () => {
        state.config.eventKinds = Array.from(
          composition.querySelectorAll('input[type="checkbox"]:checked')
        ).map((el) => el.value);
        schedulePreview();
      });
    });
    updateActualDuration();
  }

  function updateActualDuration() {
    const label = document.getElementById("compActual");
    if (!label) return;
    label.textContent = (LC.compositionDuration(state.config) / 1000).toFixed(2) + " s";
  }

  function renderAll() {
    renderLayerList();
    renderRows();
    renderRuler();
    renderInspector();
    renderComposition();
    updateStageSize();
    schedulePreview(0);
  }

  // ---- edits ----

  function patchLayer(patch, timelines) {
    const layer = findLayer(state.selectedId);
    if (!layer) return;
    const index = state.config.layers.indexOf(layer);
    Object.assign(layer, patch);
    Object.assign(layer, LC.normalizeLayer(layer, index));
    if (timelines !== false) {
      renderRows();
      renderLayerList();
      renderRuler();
      updateActualDuration();
    }
    schedulePreview();
  }

  function selectLayer(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    renderRows();
    renderLayerList();
    renderInspector();
  }

  function deleteSelected() {
    const index = state.config.layers.findIndex((layer) => layer.id === state.selectedId);
    if (index < 0) return;
    if (typeof window.confirm === "function" && !window.confirm(t("timelineEditor.confirmDelete"))) {
      return;
    }
    state.config.layers.splice(index, 1);
    const next = state.config.layers[Math.min(index, state.config.layers.length - 1)];
    state.selectedId = next ? next.id : null;
    renderAll();
  }

  function addLayer(type, src) {
    if (type === "video") {
      const videos = state.config.layers.filter((layer) => layer.type === "video").length;
      if (videos >= 4) {
        if (typeof window.alert === "function") window.alert(t("timelineEditor.videoLimit"));
        return null;
      }
    }
    const maxZ = state.config.layers.reduce((max, layer) => Math.max(max, layer.z), 0);
    const first = state.config.layers.length === 0;
    const layer = LC.normalizeLayer(
      {
        id: newLayerId(type),
        type,
        text: type === "text" ? (first ? "{{user}}" : "{{message}}") : "",
        src: src || "",
        x: type === "text" ? 10 : 10,
        y: type === "text" ? 30 : 10,
        w: type === "text" ? 80 : 80,
        h: type === "text" ? 20 : 80,
        start: 0,
        duration: 5000,
        z: maxZ + 1,
        opacity: 1,
        size: type === "text" ? 5 : undefined,
        color: "#ffffff",
        align: "center",
        weight: type === "text" ? 700 : undefined,
        font: "body",
        fit: "contain",
        loop: true,
        in: "fade",
        out: "fade",
        inMs: 300,
        outMs: 300,
      },
      state.config.layers.length
    );
    state.config.layers.push(layer);
    state.selectedId = layer.id;
    renderAll();
    return layer;
  }

  async function pickFile(layer) {
    if (!window.desktop || typeof window.desktop.pickSoundFile !== "function") return;
    const kind = layer.type === "video" ? "video" : "image";
    const result = await window.desktop.pickSoundFile(kind);
    if (!result || !result.ok || !result.relativePath) return;
    patchLayer({ src: result.relativePath });
    renderInspector();
  }

  // ---- timeline drag ----

  function startDrag(event, layer) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.target && event.target.classList;
    const mode =
      handle && handle.contains("te-clip__handle--start")
        ? "start"
        : handle && handle.contains("te-clip__handle--end")
          ? "end"
          : "move";

    selectLayer(layer.id);
    const track = rows.querySelector('.te-row[data-id="' + layer.id + '"] .te-row__track');
    if (!track) return;
    const width = track.getBoundingClientRect().width;
    if (!(width > 0)) return;

    state.drag = {
      id: layer.id,
      mode,
      startX: event.clientX,
      width,
      total: timelineTotal(),
      origStart: layer.start,
      origDuration: layer.duration,
    };
    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd, { once: true });
    document.addEventListener("pointercancel", onDragEnd, { once: true });
  }

  function onDragMove(event) {
    const drag = state.drag;
    if (!drag) return;
    const layer = findLayer(drag.id);
    if (!layer) return;
    const delta = Math.round(((event.clientX - drag.startX) / drag.width) * drag.total / 50) * 50;

    if (drag.mode === "move") {
      layer.start = clamp(drag.origStart + delta, 0, MAX_TIME - layer.duration);
    } else if (drag.mode === "end") {
      layer.duration = clamp(drag.origDuration + delta, MIN_DURATION, MAX_TIME - layer.start);
    } else {
      const maxStart = drag.origStart + drag.origDuration - MIN_DURATION;
      const nextStart = clamp(drag.origStart + delta, 0, maxStart);
      layer.start = nextStart;
      layer.duration = drag.origDuration + (drag.origStart - nextStart);
    }

    updateClipVisual(layer);
    const startField = inspector.querySelector("#fStart");
    if (startField) startField.value = String(Math.round(layer.start));
    const durationField = inspector.querySelector("#fDuration");
    if (durationField) durationField.value = String(Math.round(layer.duration));
    updateActualDuration();
    schedulePreview();
  }

  function onDragEnd() {
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", onDragEnd);
    document.removeEventListener("pointercancel", onDragEnd);
    state.drag = null;
    renderRows();
    renderRuler();
    renderLayerList();
    renderInspector();
    schedulePreview();
  }

  // ---- playback ----

  function updatePlayhead(progress) {
    const label = rows.querySelector(".te-row__label");
    const offset = label ? label.offsetWidth : LABEL_WIDTH;
    const trackWidth = Math.max(1, rows.clientWidth - offset);
    playhead.hidden = false;
    playhead.style.left = offset + trackWidth * progress + "px";
  }

  function startProgress(total) {
    const started = performance.now();
    const step = () => {
      if (!state.playing) return;
      const progress = Math.min(1, (performance.now() - started) / total);
      updatePlayhead(progress);
      if (progress < 1) progressRaf = requestAnimationFrame(step);
    };
    progressRaf = requestAnimationFrame(step);
  }

  function stopPlayback() {
    state.playing = false;
    cancelAnimationFrame(progressRaf);
    playhead.hidden = true;
    player.stop();
  }

  function testPlayback() {
    if (!state.config.layers.length) return;
    stopPlayback();
    state.playing = true;
    const total = player.play(state.config, sampleAlert(), () => {
      state.playing = false;
      playhead.hidden = true;
      renderPreview();
    });
    startProgress(total);
  }

  // ---- socket ----

  function send(type, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
  }

  function markRemoved() {
    widgetGone = true;
    stopPlayback();
    saveBtn.disabled = true;
    testBtn.disabled = true;
    setStatus("removed");
  }

  function populateFrom(widget) {
    const w = Number(widget.w);
    const h = Number(widget.h);
    if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
      state.geometry = { w, h };
      updateStageSize();
    }
    if (loaded) return;
    loaded = true;
    const config = widget.config || {};
    state.config = LC.normalizeConfig({
      eventKinds: config.eventKinds,
      durationMs: config.durationMs,
      layers: config.layers,
    });
    state.selectedId = state.config.layers.length ? state.config.layers[0].id : null;
    renderAll();
  }

  function handleMessage(message) {
    if (message.type === EVENT_TYPES.STATE) {
      const layout = (message.payload && message.payload.layout) || [];
      const widget = layout.find((item) => item.id === widgetId);
      if (widget) populateFrom(widget);
      else markRemoved();
    } else if (message.type === EVENT_TYPES.LAYOUT_UPDATE) {
      const layout = (message.payload && message.payload.layout) || [];
      const widget = layout.find((item) => item.id === widgetId);
      if (widget) populateFrom(widget);
      else if (!widgetGone) markRemoved();
    } else if (message.type === EVENT_TYPES.LOCALES) {
      if (window.I18n) {
        window.I18n.setLocales(message.payload && message.payload.locales);
        window.I18n.setLang(message.payload && message.payload.lang);
        window.I18n.apply();
      }
      renderAll();
      renderStatus();
    }
  }

  function save() {
    if (widgetGone) return;
    stopPlayback();
    const config = {
      eventKinds: state.config.eventKinds.slice(),
      durationMs: state.config.durationMs,
      layers: state.config.layers.map((layer) => Object.assign({}, layer)),
    };
    send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: widgetId, patch: { config } });
    setStatus("saved");
    renderPreview();
  }

  // ---- wiring ----

  saveBtn.addEventListener("click", save);
  testBtn.addEventListener("click", testPlayback);
  document.getElementById("addText").addEventListener("click", () => addLayer("text"));
  document.getElementById("addImage").addEventListener("click", async () => {
    const layer = addLayer("image");
    if (layer) await pickFile(layer);
  });
  document.getElementById("addVideo").addEventListener("click", async () => {
    const layer = addLayer("video");
    if (layer) await pickFile(layer);
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
      event.preventDefault();
      save();
    }
  });

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(updateStageSize).observe(previewBox);
  } else {
    window.addEventListener("resize", updateStageSize);
  }

  window.addEventListener("beforeunload", () => {
    clearTimeout(previewTimer);
    stopPlayback();
  });

  renderAll();

  function connect() {
    ws = new WebSocket("ws://localhost:" + port + "/ws");
    ws.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(event.data));
      } catch (_) {
        /* кадр не по адресу — следующий может быть нашим */
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws.close();
  }

  connect();
})();
