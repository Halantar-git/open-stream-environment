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
  // Масштаб таймлайна: каждая ступень — своя ширина дорожек в долях видимой
  // части. Ниже половины не уходим — при 132 px на подписи слоёв дорожка
  // становится уже клипа. Больше восьми не даём — клип становится шире экрана
  // целиком.
  const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

  const statusLabel = document.getElementById("statusLabel");
  const editorTitle = document.getElementById("editorTitle");
  const saveBtn = document.getElementById("saveBtn");
  const testBtn = document.getElementById("testBtn");
  const previewBox = document.getElementById("previewBox");
  const stageWrap = document.getElementById("stageWrap");
  const stage = document.getElementById("stage");
  const selection = document.getElementById("selection");
  const scopeSelect = document.getElementById("scopeSelect");
  const rows = document.getElementById("rows");
  const rulerTrack = document.getElementById("rulerTrack");
  const layerList = document.getElementById("layerList");
  const inspector = document.getElementById("inspector");
  const composition = document.getElementById("composition");
  const playhead = document.getElementById("playhead");
  const timelineEl = document.querySelector(".te-timeline");
  const timelineScroll = document.getElementById("timelineScroll");
  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const zoomResetBtn = document.getElementById("zoomResetBtn");
  const toggleGridBtn = document.getElementById("toggleGridBtn");
  const togglePreviewGridBtn = document.getElementById("togglePreviewGrid");

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
    config: LC.normalizeConfig({
      eventKinds: [],
      durationMs: 6000,
      layers: [],
      reactions: {},
    }),
    scope: "",
    selectedId: null,
    selectedIds: [],
    playing: false,
    drag: null,
    previewDrag: null,
    zoom: 1,
    grid: true,
    previewGrid: true,
    gridSize: 10,
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
    t,
  };

  const player = LC.createPlayer(stage, previewOptions);
  const stackPlayer = LC.createStack(stage, previewOptions);
  let testTimer = 0;
  let testTimers = [];

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
    return activeLayers().find((layer) => layer.id === id) || null;
  }

  function isSelected(id) {
    return state.selectedIds.indexOf(id) >= 0;
  }

  function setSelection(ids, primary) {
    state.selectedIds = ids.slice();
    state.selectedId = primary != null ? primary : ids.length ? ids[ids.length - 1] : null;
  }

  // Редактор показывает либо общую композицию, либо реакцию выбранной
  // категории. Пока своей реакции нет, показываем общую — она и играет в
  // эфире, — но первая же правка создаст копию через `ensureActive()`.
  function active() {
    if (state.scope && state.config.reactions[state.scope]) {
      return state.config.reactions[state.scope];
    }
    return state.config;
  }

  function activeLayers() {
    return active().layers;
  }

  function ownsReaction() {
    return !!state.scope && !!state.config.reactions[state.scope];
  }

  function cloneComposition(composition) {
    return {
      durationMs: composition.durationMs,
      stack: composition.stack === true,
      stackMax: composition.stackMax,
      stackGap: composition.stackGap,
      persistent: composition.persistent === true,
      minAmount: composition.minAmount,
      layers: composition.layers.map((layer) => Object.assign({}, layer)),
    };
  }

  // Копия «на запись»: пока категория наследует общую композицию, правка
  // отделяет её. Иначе первое же перетаскивание клипа меняло бы алерты всех
  // остальных категорий.
  function ensureActive() {
    if (!state.scope) return state.config;
    const existing = state.config.reactions[state.scope];
    if (existing) return existing;
    const created = cloneComposition(state.config);
    state.config.reactions[state.scope] = created;
    renderScopeSelect();
    renderReactionBanner();
    return created;
  }

  function layerKindLabel(type) {
    if (type === "image") return t("timelineEditor.layerImage");
    if (type === "video") return t("timelineEditor.layerVideo");
    if (type === "audio") return t("timelineEditor.layerAudio");
    if (type === "shape") return t("timelineEditor.layerShape");
    return t("timelineEditor.layerText");
  }

  function typeMark(type) {
    if (type === "image") return "IMG";
    if (type === "video") return "VID";
    if (type === "audio") return "AUD";
    if (type === "shape") return "PLT";
    return "T";
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
      resub: "timelineEditor.kinds.resub",
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
    const total = LC.compositionDuration(active());
    return Math.max(4000, Math.ceil(total / 1000) * 1000);
  }

  // Сколько времени занимает ширина дорожки. При приближении дорожка растёт
  // по CSS (--te-zoom), и в неё по-прежнему влезает только видимая часть.
  // При отдалении дорожка остаётся во всю ширину, а шкала продолжается
  // вправо: композиция занимает левую часть, дальше — пустое время.
  function timelineSpan() {
    const total = timelineTotal();
    return state.zoom < 1 ? total / state.zoom : total;
  }

  function sampleAlert() {
    // Если у выбранного слоя задано событие, превью показывает именно его:
    // иначе слой, привязанный к фолловерам, исчезал бы при выборе.
    const selected = findLayer(state.selectedId);
    const layerKind = selected && Array.isArray(selected.kinds) && selected.kinds.length ? selected.kinds[0] : "";
    const kind = layerKind || state.scope || state.config.eventKinds[0] || "donation";
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
    if (!previewBox || !stageWrap) return;
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
    stageWrap.style.width = Math.round(stageW) + "px";
    stageWrap.style.height = Math.round(stageH) + "px";
  }

  function renderPreview() {
    if (state.playing) {
      renderSelection();
      return;
    }
    const composition = active();
    stage.innerHTML = "";
    // В списке эфирная строка занимает долю рамки, и текст уменьшается вместе
    // с ней. Повторяем тот же коэффициент в превью, иначе шрифт, выставленный
    // по превью, в эфире оказывается другим.
    stage.style.setProperty("--la-text-scale", String(stackSlot(composition).height / 100));
    LC.renderStatic(stage, composition, sampleAlert(), previewOptions);
    bindPreviewLayers();
    renderSelection();
  }

  // Высота одной строки списка в процентах рамки. Считается так же, как в
  // `createStack`: строки делят остаток после зазоров.
  function stackSlot(composition) {
    if (!composition.stack) return { height: 100 };
    const max = Math.max(1, composition.stackMax);
    const gap = composition.stackGap || 0;
    return { height: Math.max(5, (100 - gap * (max - 1)) / max) };
  }

  function findPreviewLayer(id) {
    return (
      Array.from(stage.querySelectorAll(".la-layer")).find((el) => el.dataset.layerId === id) || null
    );
  }

  // Рамка выделения живёт рядом со сценой, а не внутри неё: `renderStatic`
  // очищает сцену, и рамка исчезала бы при каждом обновлении превью.
  function renderSelection() {
    const layer = findLayer(state.selectedId);
    if (!layer || state.playing || layer.type === "audio" || state.selectedIds.length > 1) {
      selection.hidden = true;
      return;
    }
    selection.hidden = false;
    selection.style.left = layer.x + "%";
    selection.style.top = layer.y + "%";
    selection.style.width = layer.w + "%";
    selection.style.height = layer.h + "%";
  }

  function updatePreviewLayer(layer) {
    const el = findPreviewLayer(layer.id);
    if (!el) return;
    el.style.left = layer.x + "%";
    el.style.top = layer.y + "%";
    el.style.width = layer.w + "%";
    el.style.height = layer.h + "%";
  }

  function syncGeometryFields(layer) {
    const values = { fX: layer.x, fY: layer.y, fW: layer.w, fH: layer.h };
    Object.keys(values).forEach((id) => {
      const field = inspector.querySelector("#" + id);
      if (field) field.value = String(round1(values[id]));
    });
  }

  function bindPreviewLayers() {
    stage.querySelectorAll(".la-layer").forEach((el) => {
      if (el.classList.contains("la-layer--audio")) return;
      el.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        const id = el.dataset.layerId;
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        selectLayer(id);
        startPreviewDrag(event, "move", id);
      });
    });
  }

  function schedulePreview(delay) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, delay == null ? 120 : delay);
  }

  // ---- масштаб и сетка ----

  function updateZoomUi() {
    if (zoomResetBtn) zoomResetBtn.textContent = state.zoom + "×";
  }

  function setZoom(value) {
    const next = clamp(value, ZOOM_STEPS[0], ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    if (next === state.zoom) return;
    // Держим середину видимой части на месте: иначе при приближении теряется
    // место, где работал пользователь.
    const ratio =
      timelineScroll.scrollWidth > 0
        ? (timelineScroll.scrollLeft + timelineScroll.clientWidth / 2) /
          timelineScroll.scrollWidth
        : 0;
    state.zoom = next;
    // Дорожки не бывают уже видимой части: отдаление расширяет шкалу, а не
    // сжимает её — иначе на узком окне подписи слипаются в кашу.
    timelineEl.style.setProperty("--te-zoom", String(Math.max(next, 1)));
    updateZoomUi();
    // При отдалении меняется не ширина дорожки, а сколько времени в неё
    // влезает, поэтому клипы нужно пересчитать заново.
    renderRows();
    renderRuler();
    requestAnimationFrame(() => {
      timelineScroll.scrollLeft = Math.max(
        0,
        ratio * timelineScroll.scrollWidth - timelineScroll.clientWidth / 2
      );
    });
  }

  function setGrid(on) {
    state.grid = on;
    timelineEl.classList.toggle("is-grid-off", !on);
    if (!toggleGridBtn) return;
    toggleGridBtn.classList.toggle("is-on", on);
    toggleGridBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  // Сетка превью: линии идут по кратным `gridSize` процентам кадра, как на
  // канвасе панели, только без привязки перетаскивания — слои ставятся свободно.
  function applyPreviewGrid() {
    stage.classList.toggle("show-grid", state.previewGrid);
    stage.style.setProperty("--te-grid-step", state.gridSize + "%");
    if (!togglePreviewGridBtn) return;
    togglePreviewGridBtn.classList.toggle("is-on", state.previewGrid);
    togglePreviewGridBtn.setAttribute("aria-pressed", state.previewGrid ? "true" : "false");
  }

  function renderRuler() {
    const span = timelineSpan();
    // Шаг подбираем по фактической ширине дорожки: при фиксированном числе
    // делений в узком окне подписи наезжали бы друг на друга.
    const track = Math.max(1, rows.clientWidth - LABEL_WIDTH);
    const target = span / Math.max(1, Math.floor(track / 48));
    const LADDER = [100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000];
    const step = LADDER.find((value) => value >= target) || LADDER[LADDER.length - 1];
    const parts = [];
    for (let ms = 0; ms <= span; ms += step) {
      const percent = (ms / span) * 100;
      parts.push(
        '<span class="te-tick" style="left:' +
          percent +
          '%"><i></i><b>' +
          ms / 1000 +
          "s</b></span>"
      );
    }
    rulerTrack.innerHTML = parts.join("");
    rows.style.setProperty("--te-tick-step", (step / span) * 100 + "%");
    // Мелкие линии сетки — пятикратное дробление шага шкалы.
    rows.style.setProperty("--te-minor-step", (step / 5 / span) * 100 + "%");
  }

  function updateClipVisual(layer) {
    const span = state.drag ? state.drag.total : timelineSpan();
    const clip = Array.from(rows.querySelectorAll(".te-clip")).find(
      (node) => node.dataset.id === layer.id
    );
    if (!clip) return;
    clip.style.left = (layer.start / span) * 100 + "%";
    clip.style.width = Math.max(1, (layer.duration / span) * 100) + "%";
  }

  function renderRows() {
    const span = timelineSpan();
    rows.innerHTML = "";
    // Сетка живёт в дорожках, а `innerHTML = ""` её стирает — создаём заново.
    const grid = document.createElement("div");
    grid.className = "te-grid";
    rows.appendChild(grid);
    activeLayers().forEach((layer, index) => {
      const row = document.createElement("div");
      row.className = "te-row" + (isSelected(layer.id) ? " is-selected" : "");
      row.dataset.id = layer.id;

      const label = document.createElement("button");
      label.type = "button";
      label.className = "te-row__label";
      label.innerHTML =
        '<span class="te-row__kind">' +
        escapeHtml(typeMark(layer.type)) +
        '</span><span class="te-row__name">' +
        escapeHtml(layerTitle(layer, index)) +
        "</span>";
      label.addEventListener("click", (event) => selectLayer(layer.id, event.ctrlKey || event.metaKey ? "toggle" : event.shiftKey ? "range" : ""));

      const track = document.createElement("div");
      track.className = "te-row__track";
      const clip = document.createElement("div");
      clip.className =
        "te-clip te-clip--" + layer.type + (isSelected(layer.id) ? " is-selected" : "");
      clip.dataset.id = layer.id;
      clip.style.left = (layer.start / span) * 100 + "%";
      clip.style.width = Math.max(1, (layer.duration / span) * 100) + "%";
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
    const layers = activeLayers();
    if (!layers.length) {
      const empty = document.createElement("p");
      empty.className = "te-empty";
      empty.textContent = t("timelineEditor.emptyLayers");
      layerList.appendChild(empty);
      return;
    }
    layers.forEach((layer, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "te-layer-item" + (isSelected(layer.id) ? " is-selected" : "");
      item.innerHTML =
        '<span class="te-layer-item__kind">' +
        escapeHtml(typeMark(layer.type)) +
        '</span><span class="te-layer-item__name">' +
        escapeHtml(layerTitle(layer, index)) +
        '</span><span class="te-layer-item__time">' +
        (layer.start / 1000).toFixed(1) +
        "s</span>";
      item.addEventListener("click", (event) =>
        selectLayer(
          layer.id,
          event.ctrlKey || event.metaKey ? "toggle" : event.shiftKey ? "range" : ""
        )
      );
      layerList.appendChild(item);
    });
  }

  // Общий кусок инспектора для звука и медиа: путь к файлу и кнопка выбора.
  function sourceField(layer) {
    return (
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.fieldSrc")) +
      '</label><div class="te-file"><input type="text" id="fSrc" value="' +
      escapeHtml(layer.src) +
      '"><button class="md-button md-button--tonal" id="pickFile" type="button">' +
      escapeHtml(t("timelineEditor.chooseFile")) +
      "</button></div></div>"
    );
  }

  function loopCheck(layer) {
    return (
      '<label class="te-check"><input type="checkbox" id="fLoop"' +
      (layer.loop ? " checked" : "") +
      ">" +
      escapeHtml(t("timelineEditor.loop")) +
      "</label>"
    );
  }

  // Звук не видно на сцене, поэтому вместо координат и прозрачности у него
  // громкость: без неё музыка в эфире звучала бы в полную силу, а тише её
  // сделать из приложения было бы негде.
  function audioInspector(layer) {
    const volume = Math.round(layer.volume * 100);
    return (
      sourceField(layer) +
      '<p class="te-hint">' +
      escapeHtml(t("timelineEditor.audioHint")) +
      "</p>" +
      '<div class="te-row2">' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.audioVolume")) +
      ': <span id="fVolumeValue">' +
      volume +
      '</span></label><input type="range" id="fVolume" min="0" max="100" step="1" value="' +
      volume +
      '"></div>' +
      loopCheck(layer) +
      "</div>"
    );
  }

  function mediaInspector(layer, fitOptions) {
    const volume = Math.round(layer.volume * 100);
    return (
      sourceField(layer) +
      '<div class="te-row2">' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.fitLabel")) +
      '</label><select id="fFit">' +
      fitOptions +
      "</select></div>" +
      (layer.type === "video" ? loopCheck(layer) : "") +
      "</div>" +
      (layer.type === "video"
        ? '<label class="te-check"><input type="checkbox" id="fSound"' +
          (layer.sound ? " checked" : "") +
          ">" +
          escapeHtml(t("timelineEditor.videoSound")) +
          "</label>" +
          '<p class="te-hint">' +
          escapeHtml(t("timelineEditor.videoSoundHint")) +
          "</p>" +
          (layer.sound
            ? '<div class="te-row2"><div class="te-field"><label>' +
              escapeHtml(t("timelineEditor.audioVolume")) +
              ': <span id="fVolumeValue">' +
              volume +
              '</span></label><input type="range" id="fVolume" min="0" max="100" step="1" value="' +
              volume +
              '"></div></div>'
            : "")
        : "")
    );
  }

  // Плашка — градиент без файла: полоса под именем в списке событий и т.п.
  function shapeInspector(layer) {
    return (
      '<div class="te-section">' +
      escapeHtml(t("timelineEditor.shapeStyle")) +
      "</div>" +
      '<div class="te-row2">' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.shapeFrom")) +
      '</label><input type="color" id="fColor" value="' +
      escapeHtml(layer.color) +
      '"></div>' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.shapeTo")) +
      '</label><input type="color" id="fColor2" value="' +
      escapeHtml(layer.color2) +
      '"' +
      (layer.fade ? " disabled" : "") +
      "></div></div>" +
      '<div class="te-row2">' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.shapeAngle")) +
      '</label><input type="number" id="fAngle" min="0" max="360" step="15" value="' +
      Math.round(layer.angle) +
      '"></div>' +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.shapeRadius")) +
      '</label><input type="number" id="fRadius" min="0" max="50" step="0.5" value="' +
      round1(layer.radius) +
      '"></div></div>' +
      '<label class="te-check"><input type="checkbox" id="fFade"' +
      (layer.fade ? " checked" : "") +
      ">" +
      escapeHtml(t("timelineEditor.shapeFade")) +
      "</label>" +
      '<p class="te-hint">' +
      escapeHtml(t("timelineEditor.shapeHint")) +
      "</p>"
    );
  }

  // Подстановки в подсказке — кнопки: клик вставляет токен в текст, а над
  // полем он превращается в чип с крестиком.
  function placeholderHintHtml() {
    const title = escapeHtml(t("timelineEditor.insertPlaceholder"));
    return t("timelineEditor.placeholders")
      .split(/(\{\{[^}]*\}\})/g)
      .map((part) =>
        /^\{\{[^}]*\}\}$/.test(part)
          ? '<button type="button" class="te-token" data-token="' +
            escapeHtml(part) +
            '" title="' +
            title +
            '">' +
            escapeHtml(part) +
            "</button>"
          : escapeHtml(part)
      )
      .join("");
  }

  function renderTextTokens(text) {
    const host = inspector.querySelector("#fTokens");
    if (!host) return;
    const tokens = [];
    const re = /\{\{[^}]*\}\}/g;
    let match;
    while ((match = re.exec(text))) tokens.push(match[0]);
    if (!tokens.length) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    const remove = escapeHtml(t("timelineEditor.removePlaceholder"));
    host.hidden = false;
    host.innerHTML = tokens
      .map(
        (token, index) =>
          '<span class="te-chip"><span class="te-chip__text">' +
          escapeHtml(token) +
          '</span><button type="button" class="te-chip__remove" data-index="' +
          index +
          '" title="' +
          remove +
          '" aria-label="' +
          remove +
          '">×</button></span>'
      )
      .join("");
  }

  function insertPlaceholder(token) {
    if (!token) return;
    const textarea = inspector.querySelector("#fText");
    if (!textarea) return;
    // Если поле в фокусе — вставляем по каретке, иначе в конец текста.
    const focused = document.activeElement === textarea;
    const start =
      focused && textarea.selectionStart != null ? textarea.selectionStart : textarea.value.length;
    const end = focused && textarea.selectionEnd != null ? textarea.selectionEnd : start;
    const next = textarea.value.slice(0, start) + token + textarea.value.slice(end);
    textarea.value = next;
    textarea.focus();
    textarea.setSelectionRange(start + token.length, start + token.length);
    patchLayer({ text: next });
    renderTextTokens(next);
  }

  function removeTextToken(index) {
    const textarea = inspector.querySelector("#fText");
    if (!textarea) return;
    const re = /\{\{[^}]*\}\}/g;
    let current = 0;
    let match;
    while ((match = re.exec(textarea.value))) {
      if (current === index) {
        const next =
          textarea.value.slice(0, match.index) +
          textarea.value.slice(match.index + match[0].length);
        textarea.value = next;
        patchLayer({ text: next });
        renderTextTokens(next);
        return;
      }
      current += 1;
    }
  }

  // Выделено несколько слоёв: общие поля меняют всех сразу. Сейчас такое
  // поле одно — длительность, ради него и нужно было множественное выделение.
  function renderBulkInspector(selected) {
    const duration = Math.round(selected[0].duration);
    inspector.innerHTML =
      '<div class="te-inspector__title"><span>' +
      escapeHtml(t("timelineEditor.selectedCount", { count: selected.length })) +
      '</span><button class="md-button md-button--text" id="delLayer" type="button">' +
      escapeHtml(t("timelineEditor.deleteSelected")) +
      "</button></div>" +
      '<p class="te-hint">' +
      escapeHtml(t("timelineEditor.selectionHint")) +
      "</p>" +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.durationMs")) +
      '</label><input type="number" id="fBulkDuration" min="' +
      MIN_DURATION +
      '" step="50" value="' +
      duration +
      '"></div>';

    const input = inspector.querySelector("#fBulkDuration");
    input.addEventListener("input", (event) => {
      const value = Number(event.target.value);
      if (!Number.isFinite(value)) return;
      applyDurationToSelected(value);
    });
    input.addEventListener("change", (event) => {
      const value = Number(event.target.value);
      if (!Number.isFinite(value)) return;
      event.target.value = String(clamp(value, MIN_DURATION, MAX_TIME));
    });
    inspector.querySelector("#delLayer").addEventListener("click", deleteSelected);
  }

  function applyDurationToSelected(value) {
    const ids = new Set(state.selectedIds);
    if (!ids.size) return;
    const composition = ensureActive();
    const duration = clamp(value, MIN_DURATION, MAX_TIME);
    composition.layers.forEach((layer, index) => {
      if (!ids.has(layer.id)) return;
      layer.duration = duration;
      Object.assign(layer, LC.normalizeLayer(layer, index));
    });
    renderRows();
    renderLayerList();
    renderRuler();
    updateActualDuration();
    schedulePreview();
  }

  function renderInspector() {
    const layers = activeLayers();
    const selected = layers.filter((layer) => isSelected(layer.id));
    if (selected.length > 1) {
      renderBulkInspector(selected);
      return;
    }
    const layer = selected.length === 1 ? selected[0] : findLayer(state.selectedId);
    if (!layer) {
      inspector.innerHTML = '<p class="te-empty">' + escapeHtml(t("timelineEditor.noSelection")) + "</p>";
      return;
    }
    const index = activeLayers().indexOf(layer);
    const isText = layer.type === "text";
    const isAudio = layer.type === "audio";
    const isShape = layer.type === "shape";

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
    const textAnimOptions = LC.TEXT_ANIMS.map(
      (name) =>
        '<option value="' +
        name +
        '"' +
        (layer.textAnim === name ? " selected" : "") +
        ">" +
        escapeHtml(t("timelineEditor.textAnim." + name)) +
        "</option>"
    ).join("");
    // Событие слоя: пусто — слой в каждой реакции, иначе только для своей.
    const layerKind = Array.isArray(layer.kinds) && layer.kinds.length ? layer.kinds[0] : "";
    const layerKindOptions =
      '<option value=""' +
      (layerKind ? "" : " selected") +
      ">" +
      escapeHtml(t("timelineEditor.allEvents")) +
      "</option>" +
      LC.EVENT_KINDS.map(
        (name) =>
          '<option value="' +
          name +
          '"' +
          (layerKind === name ? " selected" : "") +
          ">" +
          escapeHtml(kindLabel(name)) +
          "</option>"
      ).join("");

    inspector.innerHTML =
      '<div class="te-inspector__title"><span>' + +
      escapeHtml(layerTitle(layer, index)) +
      '</span><button class="md-button md-button--text" id="delLayer" type="button">' +
      escapeHtml(t("timelineEditor.deleteLayer")) +
      "</button></div>" +
      (isText
        ? '<div class="te-field"><label>' +
          escapeHtml(t("timelineEditor.fieldText")) +
          '</label><div class="te-tokens" id="fTokens" hidden></div><textarea id="fText">' +
          escapeHtml(layer.text) +
          "</textarea></div>" +
          '<p class="te-hint" id="fPlaceholders">' +
          placeholderHintHtml() +
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
          '>800</option></select></div></div>' +
          '<label class="te-check"><input type="checkbox" id="fItalic"' +
          (layer.italic ? " checked" : "") +
          ">" +
          escapeHtml(t("timelineEditor.italic")) +
          "</label>" +
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
          "</select></div></div>" +
          '<div class="te-row2">' +
          '<div class="te-field"><label>' +
          escapeHtml(t("timelineEditor.textAnimLabel")) +
          '</label><select id="fTextAnim">' +
          textAnimOptions +
          "</select></div>" +
          '<div class="te-field"><label>' +
          escapeHtml(t("timelineEditor.typeSpeed")) +
          '</label><input type="number" id="fTypeMs" min="4" max="120" step="1" value="' +
          Math.round(layer.typeMs) +
          '"' +
          (layer.textAnim === "none" ? " disabled" : "") +
          "></div></div>"
        : isAudio
          ? audioInspector(layer)
          : isShape
            ? shapeInspector(layer)
            : mediaInspector(layer, fitOptions)) +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.layerEvent")) +
      '</label><select id="fLayerKind">' +
      layerKindOptions +
      "</select></div>" +
      (isAudio
        ? ""
        : '<div class="te-section">' +
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
          '"></div></div>') +
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
      (isAudio
        ? ""
        : '<div class="te-row2">' +
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
          '"></div></div>');

    if (isText) renderTextTokens(layer.text);
    bindInspector(layer);
  }

  function bindInspector(layer) {
    const field = (id) => inspector.querySelector("#" + id);
    const bind = (id, event, handler) => {
      const el = field(id);
      if (el) el.addEventListener(event, handler);
    };

    bind("delLayer", "click", () => deleteSelected());
    bind("fLayerKind", "change", (event) => {
      patchLayer({ kinds: event.target.value ? [event.target.value] : [] });
    });

    if (layer.type === "text") {
      bind("fText", "input", (event) => {
        patchLayer({ text: event.target.value });
        renderTextTokens(event.target.value);
      });
      bind("fSize", "input", (event) => {
        const value = Number(event.target.value);
        const label = field("fSizeValue");
        if (label) label.textContent = round1(value);
        patchLayer({ size: value });
      });
      bind("fColor", "input", (event) => patchLayer({ color: event.target.value }));
      bind("fWeight", "change", (event) => patchLayer({ weight: Number(event.target.value) }));
      bind("fItalic", "change", (event) => patchLayer({ italic: event.target.checked }));
      bind("fAlign", "change", (event) => patchLayer({ align: event.target.value }));
      bind("fFont", "change", (event) => patchLayer({ font: event.target.value }));
      bind("fTextAnim", "change", (event) => {
        // Скорость нужна только появлению — без него поле выглядит как мёртвое.
        const speed = field("fTypeMs");
        if (speed) speed.disabled = event.target.value === "none";
        patchLayer({ textAnim: event.target.value });
      });
      bind("fTypeMs", "change", (event) => {
        const value = Number(event.target.value);
        if (Number.isFinite(value)) patchLayer({ typeMs: clamp(Math.round(value), 4, 120) });
      });
    } else if (layer.type === "audio") {
      bind("fSrc", "change", (event) => patchLayer({ src: event.target.value.trim() }));
      bind("pickFile", "click", () => pickFile(layer));
      bind("fLoop", "change", (event) => patchLayer({ loop: event.target.checked }));
      bind("fVolume", "input", (event) => {
        const value = Number(event.target.value);
        const label = field("fVolumeValue");
        if (label) label.textContent = String(Math.round(value));
        patchLayer({ volume: value / 100 });
      });
    } else if (layer.type === "shape") {
      bind("fColor", "input", (event) => patchLayer({ color: event.target.value }));
      bind("fColor2", "input", (event) => patchLayer({ color2: event.target.value }));
      bind("fAngle", "change", (event) => {
        const value = Number(event.target.value);
        if (Number.isFinite(value)) patchLayer({ angle: clamp(Math.round(value), 0, 360) });
      });
      bind("fRadius", "change", (event) => {
        const value = Number(event.target.value);
        if (Number.isFinite(value)) patchLayer({ radius: clamp(value, 0, 50) });
      });
      bind("fFade", "change", (event) => {
        // Второй цвет не нужен, когда правый край растворяется в прозрачность.
        const to = field("fColor2");
        if (to) to.disabled = event.target.checked;
        patchLayer({ fade: event.target.checked });
      });
    } else {
      bind("fSrc", "change", (event) => patchLayer({ src: event.target.value.trim() }));
      bind("pickFile", "click", () => pickFile(layer));
      bind("fFit", "change", (event) => patchLayer({ fit: event.target.value }));
      bind("fLoop", "change", (event) => patchLayer({ loop: event.target.checked }));
      bind("fSound", "change", (event) => {
        patchLayer({ sound: event.target.checked });
        // Появляется или исчезает громкость — инспектор нужно перерисовать.
        renderInspector();
      });
      bind("fVolume", "input", (event) => {
        const value = Number(event.target.value);
        const label = field("fVolumeValue");
        if (label) label.textContent = String(Math.round(value));
        patchLayer({ volume: value / 100 });
      });
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

  function renderScopeSelect() {
    if (!scopeSelect) return;
    const options = [
      '<option value="">' + escapeHtml(t("timelineEditor.scopeDefault")) + "</option>",
    ];
    LC.EVENT_KINDS.forEach((kind) => {
      const own = !!state.config.reactions[kind];
      options.push(
        '<option value="' +
          escapeHtml(kind) +
          '">' +
          escapeHtml(kindLabel(kind)) +
          (own ? " •" : "") +
          "</option>"
      );
    });
    scopeSelect.innerHTML = options.join("");
    scopeSelect.value = state.scope;
    scopeSelect.title = t("timelineEditor.scopeDefaultHint");
  }

  function renderReactionBanner() {
    const host = document.getElementById("reactionBanner");
    if (!host) return;
    if (!state.scope) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    host.hidden = false;
    const kind = kindLabel(state.scope);
    if (ownsReaction()) {
      host.innerHTML =
        '<div class="te-note"><span>' +
        escapeHtml(t("timelineEditor.scopeOwn", { kind })) +
        '</span><button class="md-button md-button--text" id="resetReaction" type="button">' +
        escapeHtml(t("timelineEditor.scopeReset")) +
        "</button></div>";
      host.querySelector("#resetReaction").addEventListener("click", resetReaction);
    } else {
      host.innerHTML =
        '<div class="te-note te-note--muted"><span>' +
        escapeHtml(t("timelineEditor.scopeInherit", { kind })) +
        '</span><button class="md-button md-button--tonal" id="createReaction" type="button">' +
        escapeHtml(t("timelineEditor.scopeCreate")) +
        "</button></div>";
      host.querySelector("#createReaction").addEventListener("click", createReaction);
    }
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
      active().durationMs +
      '"></div>' +
      '<p class="te-hint">' +
      escapeHtml(t("timelineEditor.durationHint")) +
      "</p>" +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.minAmount")) +
      '</label><input type="number" id="compMinAmount" min="0" step="1" value="' +
      Math.round(active().minAmount) +
      '"></div>' +
      '<p class="te-hint">' +
      escapeHtml(t("timelineEditor.minAmountHint")) +
      "</p>" +
      '<div class="te-row2">' +
      '<label class="te-check"><input type="checkbox" id="compStack"' +
      (active().stack ? " checked" : "") +
      ">" +
      escapeHtml(t("timelineEditor.stackSeveral")) +
      "</label>" +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.stackMax")) +
      '</label><input type="number" id="compStackMax" min="2" max="6" step="1" value="' +
      active().stackMax +
      '"' +
      (active().stack ? "" : " disabled") +
      "></div></div>" +
      '<p class="te-hint">' +
      escapeHtml(t("timelineEditor.stackHint")) +
      "</p>" +
      '<div class="te-field"><label>' +
      escapeHtml(t("timelineEditor.stackGap")) +
      '</label><input type="number" id="compStackGap" min="0" max="30" step="0.5" value="' +
      active().stackGap +
      '"' +
      (active().stack ? "" : " disabled") +
      "></div>" +
      '<label class="te-check"><input type="checkbox" id="compPersistent"' +
      (active().persistent ? " checked" : "") +
      (active().stack ? "" : " disabled") +
      ">" +
      escapeHtml(t("timelineEditor.persistent")) +
      "</label>" +
      '<p class="te-hint">' +
      escapeHtml(t("timelineEditor.persistentHint")) +
      "</p>" +
      '<div class="te-section">' +
      escapeHtml(t("timelineEditor.eventKinds")) +
      "</div>" +
      '<div id="eventKinds">' +
      checks +
      "</div>" +
      '<p class="te-hint">' +
      escapeHtml(t("timelineEditor.eventKindsHint")) +
      "</p>";

    renderReactionBanner();

    const durationInput = composition.querySelector("#compDuration");
    durationInput.addEventListener("input", (event) => {
      const value = Number(event.target.value);
      if (!Number.isFinite(value)) return;
      const target = ensureActive();
      target.durationMs = clamp(value, MIN_DURATION, MAX_TIME);
      renderRuler();
      updateActualDuration();
      schedulePreview();
    });

    composition.querySelectorAll('#eventKinds input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", () => {
        state.config.eventKinds = Array.from(
          composition.querySelectorAll('#eventKinds input[type="checkbox"]:checked')
        ).map((el) => el.value);
        schedulePreview();
      });
    });

    const minAmountInput = composition.querySelector("#compMinAmount");
    minAmountInput.addEventListener("input", (event) => {
      const value = Number(event.target.value);
      if (!Number.isFinite(value)) return;
      ensureActive().minAmount = Math.max(0, Math.round(value));
    });

    const persistentInput = composition.querySelector("#compPersistent");
    persistentInput.addEventListener("change", (event) => {
      ensureActive().persistent = event.target.checked;
    });

    const gapInput = composition.querySelector("#compStackGap");
    gapInput.addEventListener("input", (event) => {
      const value = Number(event.target.value);
      if (!Number.isFinite(value)) return;
      ensureActive().stackGap = clamp(value, 0, 30);
      schedulePreview(0);
      renderSelection();
    });

    const stackInput = composition.querySelector("#compStack");
    stackInput.addEventListener("change", (event) => {
      const target = ensureActive();
      target.stack = event.target.checked;
      const maxInput = composition.querySelector("#compStackMax");
      if (maxInput) maxInput.disabled = !target.stack;
      const persistentInput = composition.querySelector("#compPersistent");
      if (persistentInput) persistentInput.disabled = !target.stack;
      const gapInput = composition.querySelector("#compStackGap");
      if (gapInput) gapInput.disabled = !target.stack;
      schedulePreview(0);
      renderSelection();
    });

    const stackMaxInput = composition.querySelector("#compStackMax");
    stackMaxInput.addEventListener("input", (event) => {
      const value = Number(event.target.value);
      if (!Number.isFinite(value)) return;
      const target = ensureActive();
      target.stackMax = clamp(Math.round(value), 2, 6);
      schedulePreview(0);
      renderSelection();
    });

    updateActualDuration();
  }

  function updateActualDuration() {
    const label = document.getElementById("compActual");
    if (!label) return;
    label.textContent = (LC.compositionDuration(active()) / 1000).toFixed(2) + " s";
  }

  function renderAll() {
    renderEditorTitle();
    renderScopeSelect();
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
    // Правка в категории создаёт её собственную реакцию — общую композицию
    // трогать нельзя, иначе менялись бы все остальные категории.
    const composition = ensureActive();
    const layer = composition.layers.find((item) => item.id === state.selectedId);
    if (!layer) return;
    const index = composition.layers.indexOf(layer);
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

  function selectLayer(id, mode) {
    const layers = activeLayers();
    const ids = state.selectedIds.slice();
    if (mode === "toggle") {
      const at = ids.indexOf(id);
      if (at >= 0) ids.splice(at, 1);
      else ids.push(id);
      setSelection(ids, ids.indexOf(id) >= 0 ? id : ids[ids.length - 1]);
    } else if (mode === "range" && state.selectedId) {
      const from = layers.findIndex((layer) => layer.id === state.selectedId);
      const to = layers.findIndex((layer) => layer.id === id);
      if (from >= 0 && to >= 0) {
        const [a, b] = from <= to ? [from, to] : [to, from];
        setSelection(
          layers.slice(a, b + 1).map((layer) => layer.id),
          id
        );
      } else {
        setSelection([id], id);
      }
    } else {
      setSelection([id], id);
    }
    renderRows();
    renderLayerList();
    renderInspector();
    renderSelection();
  }

  // В заголовке окна монтажа видно имя композиции: при нескольких виджетах
  // иначе не понять, какой из них открыт.
  function renderEditorTitle() {
    if (!editorTitle) return;
    const name = state.config.name;
    editorTitle.textContent = name
      ? t("timelineEditor.title") + " — " + name
      : t("timelineEditor.title");
  }

  function setScope(scope) {
    if (state.scope === scope) return;
    stopPlayback();
    state.scope = scope;
    const layers = activeLayers();
    const first = layers.length ? layers[0].id : null;
    setSelection(first ? [first] : [], first);
    renderAll();
  }

  function createReaction() {
    ensureActive();
    const layers = activeLayers();
    const first = layers.length ? layers[0].id : null;
    setSelection(first ? [first] : [], first);
    renderAll();
  }

  function resetReaction() {
    if (!state.scope) return;
    stopPlayback();
    delete state.config.reactions[state.scope];
    const layers = activeLayers();
    const first = layers.length ? layers[0].id : null;
    setSelection(first ? [first] : [], first);
    renderAll();
  }

  function deleteSelected() {
    const ids = new Set(state.selectedIds);
    if (!ids.size) return;
    const current = activeLayers();
    const index = current.findIndex((layer) => ids.has(layer.id));
    if (index < 0) return;
    const message =
      ids.size > 1
        ? t("timelineEditor.confirmDeleteMany", { count: ids.size })
        : t("timelineEditor.confirmDelete");
    if (typeof window.confirm === "function" && !window.confirm(message)) {
      return;
    }
    const composition = ensureActive();
    composition.layers = composition.layers.filter((layer) => !ids.has(layer.id));
    const next = composition.layers[Math.min(index, composition.layers.length - 1)];
    setSelection(next ? [next.id] : [], next ? next.id : null);
    renderAll();
  }

  function addLayer(type, src) {
    const current = activeLayers();
    if (type === "video") {
      const videos = current.filter((layer) => layer.type === "video").length;
      if (videos >= 4) {
        if (typeof window.alert === "function") window.alert(t("timelineEditor.videoLimit"));
        return null;
      }
    }
    const isAudio = type === "audio";
    const isShape = type === "shape";
    const composition = ensureActive();
    const maxZ = composition.layers.reduce((max, layer) => Math.max(max, layer.z), 0);
    const first = composition.layers.length === 0;
    const layer = LC.normalizeLayer(
      {
        id: newLayerId(type),
        type,
        text: type === "text" ? (first ? "{{user}}" : "{{message}}") : "",
        src: src || "",
        x: isAudio ? 0 : 10,
        y: isAudio ? 0 : type === "text" ? 30 : 10,
        w: isAudio ? 100 : 80,
        h: isAudio ? 100 : type === "text" ? 20 : isShape ? 12 : 80,
        start: 0,
        duration: 5000,
        z: maxZ + 1,
        opacity: 1,
        size: type === "text" ? 5 : undefined,
        color: isShape ? "#7b2cff" : "#ffffff",
        color2: "#ff4fd8",
        angle: 90,
        radius: isShape ? 1 : 0,
        fade: false,
        align: "center",
        weight: type === "text" ? 700 : undefined,
        font: "body",
        italic: false,
        fit: "contain",
        loop: true,
        volume: isAudio ? 0.8 : undefined,
        textAnim: "none",
        typeMs: 16,
        in: "fade",
        out: "fade",
        inMs: 300,
        outMs: 300,
      },
      composition.layers.length
    );
    composition.layers.push(layer);
    setSelection([layer.id], layer.id);
    renderAll();
    return layer;
  }

  async function pickFile(layer) {
    if (!window.desktop || typeof window.desktop.pickSoundFile !== "function") return;
    const kind =
      layer.type === "video" ? "video" : layer.type === "audio" ? "sound" : "image";
    const result = await window.desktop.pickSoundFile(kind);
    if (!result || !result.ok || !result.relativePath) return;
    patchLayer({ src: result.relativePath });
    renderInspector();
  }

  // ---- timeline drag ----

  function startDrag(event, layer) {
    if (event.button !== 0) return;
    event.preventDefault();
    // С модификатором клип только меняет выделение — тянуть его не начинаем.
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      selectLayer(layer.id, event.ctrlKey || event.metaKey ? "toggle" : "range");
      return;
    }
    const handle = event.target && event.target.classList;
    const mode =
      handle && handle.contains("te-clip__handle--start")
        ? "start"
        : handle && handle.contains("te-clip__handle--end")
          ? "end"
          : "move";

    selectLayer(layer.id);
    const composition = ensureActive();
    const liveLayer = composition.layers.find((item) => item.id === layer.id);
    if (!liveLayer) return;
    const track = rows.querySelector('.te-row[data-id="' + layer.id + '"] .te-row__track');
    if (!track) return;
    const width = track.getBoundingClientRect().width;
    if (!(width > 0)) return;

    state.drag = {
      id: liveLayer.id,
      mode,
      startX: event.clientX,
      width,
      total: timelineSpan(),
      origStart: liveLayer.start,
      origDuration: liveLayer.duration,
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
  }

  // ---- preview drag (как в OBS: тянем сам слой за рамку) ----

  function startPreviewDrag(event, dir, id) {
    const composition = ensureActive();
    const layer = composition.layers.find((item) => item.id === id);
    if (!layer) return;
    if (layer.type === "audio") return;
    const rect = stage.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;

    state.previewDrag = {
      id: layer.id,
      dir,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
      orig: { x: layer.x, y: layer.y, w: layer.w, h: layer.h },
    };
    document.addEventListener("pointermove", onPreviewDragMove);
    document.addEventListener("pointerup", onPreviewDragEnd, { once: true });
    document.addEventListener("pointercancel", onPreviewDragEnd, { once: true });
  }

  function onPreviewDragMove(event) {
    const drag = state.previewDrag;
    if (!drag) return;
    const layer = findLayer(drag.id);
    if (!layer) return;

    const dx = ((event.clientX - drag.startX) / drag.width) * 100;
    const dy = ((event.clientY - drag.startY) / drag.height) * 100;
    const dragged = LC.applyLayerDrag(drag.orig, drag.dir, dx, dy);
    // Сетка включена — края «щёлкают» по её линиям; Alt отпускает слой.
    const next = event.altKey
      ? dragged
      : LC.snapToGrid(dragged, drag.dir, state.previewGrid ? state.gridSize : 0);

    layer.x = next.x;
    layer.y = next.y;
    layer.w = next.w;
    layer.h = next.h;

    updatePreviewLayer(layer);
    renderSelection();
    syncGeometryFields(layer);
  }

  function onPreviewDragEnd() {
    document.removeEventListener("pointermove", onPreviewDragMove);
    document.removeEventListener("pointerup", onPreviewDragEnd);
    document.removeEventListener("pointercancel", onPreviewDragEnd);
    state.previewDrag = null;
    renderSelection();
  }

  // ---- playback ----

  function updatePlayhead(progress, total) {
    const label = rows.querySelector(".te-row__label");
    const offset = label ? label.offsetWidth : LABEL_WIDTH;
    const trackWidth = Math.max(1, rows.clientWidth - offset);
    // При отдалении композиция занимает только левую часть дорожки — бегунок
    // должен остановиться на её конце, а не уехать за пустое время.
    const fraction = clamp((progress * total) / timelineSpan(), 0, 1);
    playhead.hidden = false;
    playhead.style.left = offset + trackWidth * fraction + "px";
  }

  function startProgress(total) {
    const started = performance.now();
    const step = () => {
      if (!state.playing) return;
      const progress = Math.min(1, (performance.now() - started) / total);
      updatePlayhead(progress, total);
      if (progress < 1) progressRaf = requestAnimationFrame(step);
    };
    progressRaf = requestAnimationFrame(step);
  }

  function stopPlayback() {
    state.playing = false;
    clearTimeout(testTimer);
    testTimer = 0;
    testTimers.forEach((id) => clearTimeout(id));
    testTimers = [];
    cancelAnimationFrame(progressRaf);
    playhead.hidden = true;
    stackPlayer.clear();
    player.stop();
  }

  function testPlayback() {
    const composition = active();
    if (!composition.layers.length) return;
    stopPlayback();
    state.playing = true;
    renderSelection();

    if (composition.stack) {
      // Список проверяем сразу тремя событиями: так видно сдвиг строк вниз.
      const alerts = [
        sampleAlert(),
        Object.assign(sampleAlert(), { user: "Nova" }),
        Object.assign(sampleAlert(), { user: "Pilot" }),
      ].slice(0, composition.stackMax);
      alerts.forEach((alert, index) => {
        testTimers.push(
          setTimeout(() => {
            if (state.playing) stackPlayer.push(composition, alert);
          }, index * 350)
        );
      });
      const total = LC.compositionDuration(composition) + alerts.length * 350 + 500;
      testTimer = setTimeout(() => {
        if (!state.playing) return;
        state.playing = false;
        playhead.hidden = true;
        stackPlayer.clear();
        renderPreview();
      }, total);
      startProgress(total);
      return;
    }

    const total = player.play(composition, sampleAlert(), () => {
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
      name: config.name,
      durationMs: config.durationMs,
      stack: config.stack,
      stackMax: config.stackMax,
      stackGap: config.stackGap,
      persistent: config.persistent,
      minAmount: config.minAmount,
      layers: config.layers,
      reactions: config.reactions,
    });
    state.scope = "";
    const first = state.config.layers.length ? state.config.layers[0].id : null;
    setSelection(first ? [first] : [], first);
    renderAll();
  }

  function handleMessage(message) {
    if (message.type === EVENT_TYPES.STATE) {
      const payload = message.payload || {};
      // Шаг сетки превью берём из настроек редактора — тот же, что на канвасе.
      const editor = payload.editor || {};
      const gridSize = Number(editor.gridSize);
      if (Number.isFinite(gridSize) && gridSize > 0) state.gridSize = gridSize;
      applyPreviewGrid();
      const layout = payload.layout || [];
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
    const reactions = {};
    Object.keys(state.config.reactions).forEach((kind) => {
      const composition = state.config.reactions[kind];
      reactions[kind] = {
        durationMs: composition.durationMs,
        stack: composition.stack === true,
        stackMax: composition.stackMax,
        stackGap: composition.stackGap,
        persistent: composition.persistent === true,
        minAmount: composition.minAmount,
        layers: composition.layers.map((layer) => Object.assign({}, layer)),
      };
    });
    const config = {
      eventKinds: state.config.eventKinds.slice(),
      name: state.config.name || "",
      durationMs: state.config.durationMs,
      stack: state.config.stack === true,
      stackMax: state.config.stackMax,
      stackGap: state.config.stackGap,
      persistent: state.config.persistent === true,
      minAmount: state.config.minAmount,
      layers: state.config.layers.map((layer) => Object.assign({}, layer)),
      reactions,
    };
    send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: widgetId, patch: { config } });
    setStatus("saved");
    renderPreview();
  }

  // ---- wiring ----

  saveBtn.addEventListener("click", save);
  testBtn.addEventListener("click", testPlayback);
  if (scopeSelect) {
    scopeSelect.addEventListener("change", () => setScope(scopeSelect.value));
  }

  // Рамка выделения: ручки меняют размер, внутренняя область — положение.
  selection.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const dir = (event.target && event.target.dataset && event.target.dataset.dir) || "move";
    startPreviewDrag(event, dir, state.selectedId);
  });
  // Клик по пустому месту сцены снимает выделение.
  stage.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (target && typeof target.closest === "function" && target.closest(".la-layer")) return;
    selectLayer(null);
  });
  stage.addEventListener("dragstart", (event) => event.preventDefault());
  document.getElementById("addText").addEventListener("click", () => addLayer("text"));
  document.getElementById("addImage").addEventListener("click", async () => {
    const layer = addLayer("image");
    if (layer) await pickFile(layer);
  });
  document.getElementById("addVideo").addEventListener("click", async () => {
    const layer = addLayer("video");
    if (layer) await pickFile(layer);
  });
  document.getElementById("addAudio").addEventListener("click", async () => {
    const layer = addLayer("audio");
    if (layer) await pickFile(layer);
  });
  document.getElementById("addShape").addEventListener("click", () => {
    addLayer("shape");
  });

  if (zoomInBtn) {
    zoomInBtn.addEventListener("click", () => {
      const next = ZOOM_STEPS.find((step) => step > state.zoom);
      if (next) setZoom(next);
    });
  }
  if (zoomOutBtn) {
    zoomOutBtn.addEventListener("click", () => {
      const previous = ZOOM_STEPS.slice()
        .reverse()
        .find((step) => step < state.zoom);
      if (previous) setZoom(previous);
    });
  }
  if (zoomResetBtn) zoomResetBtn.addEventListener("click", () => setZoom(1));
  if (toggleGridBtn) toggleGridBtn.addEventListener("click", () => setGrid(!state.grid));
  if (togglePreviewGridBtn) {
    togglePreviewGridBtn.addEventListener("click", () => {
      state.previewGrid = !state.previewGrid;
      applyPreviewGrid();
    });
  }
  updateZoomUi();
  setGrid(true);
  applyPreviewGrid();

  function isEditableTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    const tag = String(target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    return target.isContentEditable === true;
  }

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
      return;
    }
    // Delete (и Backspace на клавиатурах Mac) удаляет выбранный слой, но
    // только когда фокус не в поле ввода: там эти клавиши правят текст.
    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      !isEditableTarget(event.target) &&
      !widgetGone &&
      state.selectedId
    ) {
      event.preventDefault();
      deleteSelected();
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

  // Подстановки добавляются кликом, а чипы над полем убираются крестиком.
  // Делегирование живёт на контейнере: сам инспектор перерисовывается.
  inspector.addEventListener("mousedown", (event) => {
    if (event.target && event.target.closest && event.target.closest(".te-token")) {
      event.preventDefault();
    }
  });
  inspector.addEventListener("click", (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const token = target.closest(".te-token");
    if (token) {
      insertPlaceholder(token.dataset.token || "");
      return;
    }
    const remove = target.closest(".te-chip__remove");
    if (remove) removeTextToken(Number(remove.dataset.index));
  });

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
