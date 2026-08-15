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

(function () {
  const { EVENT_TYPES } = window.SharedEvents;
  const { ICONS } = window.SharedIcons;
  const { WIDGET_TYPES } = window.WidgetCatalog;
  const t = (key, params) => (window.I18n ? window.I18n.t(key, params) : key);

  const params = new URLSearchParams(location.search);
  const port = params.get("port") || "8710";
  const wsUrl = `ws://localhost:${port}/ws`;
  const overlayUrl = `http://localhost:${port}/overlay/overlay.html`;

  // ---- state ----
  let ws;
  let layout = [];
  let goal = { title: "Цель", current: 0, target: 1, currency: "RUB" };
  let connectionStatus = {};
  let twitchChannel = "";
  let twitchClientId = "";
  let daClientId = "";
  let youtubeClientId = "";
  let youtubeVideoId = "";
  let twitchEnabled = true;
  let donationAlertsEnabled = true;
  let youtubeEnabled = true;
  let selectedId = null;
  let pendingAdd = null; // { knownIds:Set, dropXY:{x,y}|null }
  let appearance = { activeThemeId: "nebula", tokens: {}, themes: [] };
  let editorPrefs = { gridSize: 5, snapEnabled: true };
  let editingThemeId = null; // theme currently open in the editor form, or null for "new"
  let scenes = {};
  let topDonation = { user: "", amount: 0, currency: "RUB" };
  let stats = { followerCount: null, subscriberCount: null };
  let activeSceneId = "start";
  let giveaway = { active: false, command: "!go", eliminationMode: false, winner: null, count: 0, participants: [] };
  let participantsConfig = { maxNames: 10, marquee: false, fontSize: 16, textColor: "#e8e1f0", backgroundOpacity: 82 };
  let wheelConfig = { musicVolume: 50 };
  let wheelSpeedConfig = { speed: 3 };
  let micConfig = { sensitivity: 1.5, lineWidth: 2, color: "#0060A8", opacity: 0.9, visualizer_mode: "sine", barCount: 32, barGap: 2 };

  // ---- dom refs ----
  const tabsEl = document.getElementById("tabs");
  const viewEditor = document.getElementById("view-editor");
  const viewScenes = document.getElementById("view-scenes");
  const viewSettings = document.getElementById("view-settings");
  const libraryListEl = document.getElementById("libraryList");
  const canvasWrapEl = document.getElementById("canvasWrap");
  const canvasEl = document.getElementById("canvas");
  const layersEl = document.getElementById("layers");
  const propertiesSection = document.getElementById("propertiesSection");
  const propertiesTitle = document.getElementById("propertiesTitle");
  const propertiesEl = document.getElementById("properties");
  const statusChipsEl = document.getElementById("statusChips");
  const obsUrlLabel = document.getElementById("obsUrlLabel");
  const copyUrlBtn = document.getElementById("copyUrlBtn");
  const gridSizeSelect = document.getElementById("gridSizeSelect");
  const themeGridEl = document.getElementById("themeGrid");
  const themeEditorEl = document.getElementById("themeEditor");
  const newThemeBtn = document.getElementById("newThemeBtn");
  const exportConfigBtn = document.getElementById("exportConfigBtn");
  const importConfigBtn = document.getElementById("importConfigBtn");
  const exportImportStatus = document.getElementById("exportImportStatus");
  const scenesNavListEl = document.getElementById("scenesNavList");
  const scenesPreviewFrame = document.getElementById("scenesPreviewFrame");
  const sceneUrlLabel = document.getElementById("sceneUrlLabel");
  const copySceneUrlBtn = document.getElementById("copySceneUrlBtn");
  const sceneFormTitle = document.getElementById("sceneFormTitle");
  const sceneFormEl = document.getElementById("sceneForm");

  const twitchChannelInput = document.getElementById("twitchChannel");
  const twitchClientIdInput = document.getElementById("twitchClientId");
  const twitchClientSecretInput = document.getElementById("twitchClientSecret");
  const twitchRedirectUriEl = document.getElementById("twitchRedirectUri");
  const daClientIdInput = document.getElementById("daClientId");
  const daClientSecretInput = document.getElementById("daClientSecret");
  const daRedirectUriEl = document.getElementById("daRedirectUri");
  const youtubeClientIdInput = document.getElementById("youtubeClientId");
  const youtubeClientSecretInput = document.getElementById("youtubeClientSecret");
  const youtubeRedirectUriEl = document.getElementById("youtubeRedirectUri");
  const youtubeVideoIdInput = document.getElementById("youtubeVideoId");
  const twitchEnabledSwitch = document.getElementById("twitchEnabledSwitch");
  const donationAlertsEnabledSwitch = document.getElementById("donationAlertsEnabledSwitch");
  const youtubeEnabledSwitch = document.getElementById("youtubeEnabledSwitch");
  const appPortInput = document.getElementById("appPort");
  const appOverlayUrlInput = document.getElementById("appOverlayUrl");
  const eventsHistoryEl = document.getElementById("eventsHistory");
  const refreshEventsBtn = document.getElementById("refreshEventsBtn");
  const loadMoreEventsBtn = document.getElementById("loadMoreEventsBtn");
  const eventsFiltersEl = document.getElementById("eventsFilters");
  const eventsSearchInput = document.getElementById("eventsSearch");
  const clearEventsBtn = document.getElementById("clearEventsBtn");
  const eventsMetaEl = document.getElementById("eventsMeta");
  const toggleTerminalBtn = document.getElementById("toggleTerminalBtn");
  const terminalPanel = document.getElementById("terminalPanel");
  const terminalBody = document.getElementById("terminalBody");
  const terminalClearBtn = document.getElementById("terminalClearBtn");
  const terminalCloseBtn = document.getElementById("terminalCloseBtn");

  // ---- helpers ----
  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
  function round1(n) { return Math.round(n * 10) / 10; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }
  function formatMoney(n) { return Number(n || 0).toLocaleString("ru-RU"); }
  const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", UAH: "₴", KZT: "₸", GBP: "£" };
  function currencySymbol(code) { return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || code || ""; }
  function send(type, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
  }
  function switchHtml(id, on) {
    return `<div class="md-switch${on ? " is-on" : ""}" id="${id}"><div class="md-switch__thumb"></div></div>`;
  }
  function wireSwitch(el, cb) {
    if (!el) return;
    el.addEventListener("click", () => {
      const now = !el.classList.contains("is-on");
      el.classList.toggle("is-on", now);
      cb(now);
    });
  }

  // ---- tabs ----
  tabsEl.querySelectorAll(".topbar__tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      tabsEl.querySelectorAll(".topbar__tab").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const view = btn.dataset.view;
      viewEditor.hidden = view !== "editor";
      viewScenes.hidden = view !== "scenes";
      viewSettings.hidden = view !== "settings";
      if (view === "settings") renderStreamEvents();
    });
  });

  // ---- library rail ----
  function renderLibrary() {
    libraryListEl.innerHTML = "";
    Object.values(WIDGET_TYPES).forEach((def) => {
      const card = document.createElement("div");
      card.className = "library-card";
      card.draggable = true;
      card.innerHTML = `
        <span class="library-card__icon">${ICONS[def.icon] || ""}</span>
        <span class="library-card__text">
          <span class="library-card__label">${t("widgets." + def.type)}</span>
          <span class="library-card__desc">${t("widgets." + def.type + "Desc")}</span>
        </span>`;
      card.addEventListener("click", () => addWidget(def.type, null));
      card.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/widget-type", def.type);
        e.dataTransfer.effectAllowed = "copy";
      });
      libraryListEl.appendChild(card);
    });
  }

  canvasWrapEl.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("text/widget-type")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    canvasWrapEl.classList.add("is-drop-target");
  });
  canvasWrapEl.addEventListener("dragleave", (e) => {
    if (e.target === canvasWrapEl) canvasWrapEl.classList.remove("is-drop-target");
  });
  canvasWrapEl.addEventListener("drop", (e) => {
    e.preventDefault();
    canvasWrapEl.classList.remove("is-drop-target");
    const type = e.dataTransfer.getData("text/widget-type");
    if (!type) return;
    const rect = canvasEl.getBoundingClientRect();
    const xPct = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
    const yPct = clamp(((e.clientY - rect.top) / rect.height) * 100, 0, 100);
    addWidget(type, { x: xPct, y: yPct });
  });

  function addWidget(type, dropXY) {
    pendingAdd = { knownIds: new Set(layout.map((w) => w.id)), dropXY };
    send(EVENT_TYPES.CMD_ADD_WIDGET, { type });
  }

  // ---- canvas preview content (sample data for event-driven widgets, real data for goal) ----
  function sampleChat() {
    return [
      { user: "nova_viewer", color: "#7ee0d6", message: t("preview.chat1"), badges: ["subscriber"] },
      { user: "star_gazer", color: "#ffb0d8", message: t("preview.chat2"), badges: [] },
      { user: "orbit_fan", color: "#c6b8ff", message: t("preview.chat3"), badges: ["moderator"] },
    ];
  }
  const SAMPLE_RECENT = [
    { kind: "donation", user: "comet_watcher", amount: 300 },
    { kind: "sub", user: "nova_viewer" },
    { kind: "follow", user: "star_gazer" },
  ];

  function recentTextPreview(e) {
    const user = `<b>${e.user}</b>`;
    switch (e.kind) {
      case "donation": return t("preview.recentDonation", { user, amount: formatMoney(e.amount) });
      case "sub": return t("preview.recentSub", { user });
      case "follow": return t("preview.recentFollow", { user });
      default: return user;
    }
  }

  function buildCustomWidgetDocument(cfg) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#e8e1f0;font-family:sans-serif;}${cfg.css || ""}</style></head><body>${cfg.html || ""}<script>${cfg.js || ""}</script></body></html>`;
  }

  function buildPreviewHtml(inst) {
    const config = inst.config || {};
    switch (inst.type) {
      case "goal": {
        const pct = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
        return `<div class="widget-goal">
          <div class="widget-goal__row">
            <span class="widget-goal__title">${escapeHtml(goal.title || t("preview.goalTitle"))}</span>
            <span class="widget-goal__amounts"><b>${formatMoney(goal.current)}</b> / ${formatMoney(goal.target)} ${escapeHtml(currencySymbol(goal.currency))}</span>
          </div>
          <div class="md-linear-progress"><div class="md-linear-progress__bar" style="width:${pct}%"></div></div>
          ${config.showPercentage ? `<div class="widget-goal__percent">${pct}%</div>` : ""}
        </div>`;
      }
      case "chat": {
        const max = Math.min(3, config.maxMessages || 8);
        const rows = sampleChat().slice(0, max)
          .map((m) => {
            const badges = config.showBadges === false ? "" : (m.badges || []).map((b) => `<span class="widget-chat__badge">${b.slice(0, 1).toUpperCase()}</span>`).join("");
            return `<div class="widget-chat__msg">${badges}<span class="widget-chat__user" style="color:${m.color}">${m.user}</span><span class="widget-chat__colon">:</span><span class="widget-chat__text">${escapeHtml(m.message)}</span></div>`;
          })
          .join("");
        return `<div class="widget-chat">${rows}</div>`;
      }
      case "recent": {
        const max = Math.min(3, config.maxItems || 5);
        const items = SAMPLE_RECENT.slice(0, max)
          .map((e) => `<div class="widget-recent__item"><span class="widget-recent__dot" data-kind="${e.kind}"></span><span>${recentTextPreview(e)}</span></div>`)
          .join("");
        return `<div class="widget-recent"><div class="widget-recent__title">${t("preview.recentTitle")}</div><div class="widget-recent__list">${items}</div></div>`;
      }
      case "alerts":
        return `<div class="widget-alerts-host"><div class="widget-alert" data-kind="follow">
          <div class="widget-alert__icon">${ICONS.follow}</div>
          <div class="widget-alert__body">
            <div class="widget-alert__status"><span class="widget-alert__dot"></span><span class="widget-alert__kicker">${t("preview.followKicker")}</span></div>
            <div class="widget-alert__name">nova_viewer</div>
          </div>
          <div class="widget-alert__lockbar"><div class="widget-alert__lockbar-fill"></div></div>
        </div></div>`;
      case "custom": {
        const mode = config.mode || "text";
        const withCard = mode !== "image" && config.showBackground !== false;
        if (mode === "image") {
          return config.imageUrl
            ? `<div class="widget-custom"><img class="widget-custom__image" src="${escapeAttr(config.imageUrl)}" style="object-fit:${escapeAttr(config.imageFit || "contain")}" alt=""></div>`
            : `<div class="widget-custom"></div>`;
        }
        if (mode === "html") {
          const doc = buildCustomWidgetDocument(config);
          return `<div class="widget-custom${withCard ? " has-card" : ""}"><iframe class="widget-custom__html" srcdoc="${escapeAttr(doc)}"></iframe></div>`;
        }
        const title = config.textTitle ? `<div class="widget-custom__title">${escapeHtml(config.textTitle)}</div>` : "";
        const colorStyle = config.textColor ? ` style="color:${escapeAttr(config.textColor)}"` : "";
        return `<div class="widget-custom${withCard ? " has-card" : ""}"><div class="widget-custom__text" data-align="${escapeAttr(config.textAlign || "center")}">${title}<div class="widget-custom__body" data-size="${escapeAttr(config.textSize || "medium")}"${colorStyle}>${escapeHtml(config.text || "")}</div></div></div>`;
      }
      case "stat": {
        const metric = config.metric || "followers";
        const sample =
          metric === "subscribers"
            ? { icon: ICONS.sub, label: config.label || t("preview.subscribers"), value: stats.subscriberCount != null ? formatMoney(stats.subscriberCount) : "—" }
            : metric === "latestFollower"
            ? { icon: ICONS.follow, label: config.label || t("preview.latestFollower"), value: "star_gazer" }
            : metric === "latestSubscriber"
            ? { icon: ICONS.sub, label: config.label || t("preview.latestSubscriber"), value: "nova_viewer" }
            : metric === "topDonation"
            ? { icon: ICONS.donation, label: config.label || t("preview.topDonation"), value: topDonation.amount > 0 ? `${topDonation.user} (${formatMoney(topDonation.amount)} ${currencySymbol(topDonation.currency)})` : t("scene.notYet") }
            : { icon: ICONS.follow, label: config.label || t("preview.followers"), value: stats.followerCount != null ? formatMoney(stats.followerCount) : "—" };
        return `<div class="widget-stat"><div class="widget-stat__icon">${sample.icon}</div><div class="widget-stat__info"><span class="widget-stat__label">${escapeHtml(sample.label)}</span><span class="widget-stat__value">${escapeHtml(sample.value)}</span></div></div>`;
      }
      case "social": {
        const s = (config.socials || [])[0] || { platform: "TG", text: "t.me/your_channel" };
        return `<div class="widget-social"><div class="widget-social__content"><span class="widget-social__icon">${escapeHtml(s.platform)}</span><div class="widget-social__info"><span class="widget-social__platform">${escapeHtml(s.platform)}</span><span class="widget-social__handle">${escapeHtml(s.text)}</span></div></div></div>`;
      }
      case "participants": {
        const names = ["viewer_1", "viewer_2", "viewer_3", "viewer_4"].slice(0, Math.max(1, Number(participantsConfig.maxNames) || 10));
        const chips = names.map((n) => `<span class="widget-participants__chip">${escapeHtml(n)}</span>`).join("");
        const style = `--pw-font-size:${participantsConfig.fontSize ?? 16}px;--pw-text:${escapeAttr(participantsConfig.textColor || "#e8e1f0")};--pw-bg-opacity:${participantsConfig.backgroundOpacity ?? 82}%;`;
        return `<div class="widget-participants" style="${style}">
          <div class="widget-participants__title">${t("wheelScene.participantsTitle", { count: 4 })}</div>
          <div class="widget-participants__list">${chips}</div>
        </div>`;
      }
      case "mic": {
        const color = micConfig.color || "#0060A8";
        const opacity = micConfig.opacity ?? 0.9;
        const width = 400;
        const height = 80;
        const pts = [];
        for (let x = 0; x <= width; x += 6) {
          const y = height / 2 + Math.sin(x * 0.045) * 22 + Math.sin(x * 0.012) * 9;
          pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        }
        const d = "M" + pts.join(" L");
        return `<div class="widget-mic widget-mic--preview">
          <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:100%;opacity:${opacity}">
            <path d="${d}" fill="none" stroke="${escapeAttr(color)}" stroke-width="${micConfig.lineWidth || 2}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
          </svg>
        </div>`;
      }
      default:
        return "";
    }
  }

  // ---- canvas render + drag/resize ----
  function renderCanvas() {
    canvasEl.innerHTML = "";
    [...layout]
      .sort((a, b) => (a.z || 0) - (b.z || 0))
      .forEach((inst) => {
        const box = document.createElement("div");
        box.className = "canvas-widget" + (inst.id === selectedId ? " is-selected" : "");
        box.dataset.id = inst.id;
        box.style.left = inst.x + "%";
        box.style.top = inst.y + "%";
        box.style.width = inst.w + "%";
        box.style.height = inst.h + "%";
        box.style.zIndex = inst.z || 0;
        box.style.opacity = inst.visible ? "1" : "0.35";

        const label = document.createElement("div");
        label.className = "canvas-widget__label";
        label.textContent = t("widgets." + inst.type);
        box.appendChild(label);

        const content = document.createElement("div");
        content.className = "canvas-widget__content";
        content.innerHTML = buildPreviewHtml(inst);
        box.appendChild(content);

        canvasEl.appendChild(box);
        attachDragHandlers(box, inst);
        attachResizeHandlers(box, inst);
      });
  }

  function applySelectionClasses() {
    canvasEl.querySelectorAll(".canvas-widget").forEach((el) => {
      el.classList.toggle("is-selected", el.dataset.id === selectedId);
    });
  }

  function selectWidget(id) {
    selectedId = id;
    applySelectionClasses();
    renderLayers();
    renderProperties();
  }

  // ---- theme + grid (canvas preview only — app chrome stays fixed Nebula) ----

  function applyThemeToCanvas(tokens) {
    if (!tokens) return;
    Object.entries(tokens).forEach(([k, v]) => canvasEl.style.setProperty(k, v));
    canvasEl.dataset.decoration = tokens["--panel-decoration"] || "none";
  }

  function applyGridToCanvas() {
    const size = editorPrefs.gridSize || 0;
    canvasEl.classList.toggle("show-grid", size > 0);
    if (size > 0) {
      canvasEl.style.setProperty("--grid-x", (size / 100) * 960 + "px");
      canvasEl.style.setProperty("--grid-y", (size / 100) * 540 + "px");
    }
  }

  function snapValue(v) {
    const size = editorPrefs.gridSize;
    if (!editorPrefs.snapEnabled || !size) return v;
    return Math.round(v / size) * size;
  }

  gridSizeSelect.addEventListener("change", () => {
    const size = Number(gridSizeSelect.value);
    send(EVENT_TYPES.CMD_SET_EDITOR_PREFS, { gridSize: size, snapEnabled: size > 0 });
  });

  function attachDragHandlers(boxEl, inst) {
    boxEl.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".resize-handle")) return;
      e.preventDefault();
      selectWidget(inst.id);
      const canvasRect = canvasEl.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const cur = layout.find((w) => w.id === inst.id) || inst;
      const startXPct = cur.x;
      const startYPct = cur.y;
      let moved = false;
      boxEl.classList.add("is-dragging");
      boxEl.setPointerCapture(e.pointerId);

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        const dxPct = (dx / canvasRect.width) * 100;
        const dyPct = (dy / canvasRect.height) * 100;
        const nx = snapValue(clamp(startXPct + dxPct, 0, 100 - cur.w));
        const ny = snapValue(clamp(startYPct + dyPct, 0, 100 - cur.h));
        boxEl.style.left = nx + "%";
        boxEl.style.top = ny + "%";
        boxEl.dataset.pendingX = nx;
        boxEl.dataset.pendingY = ny;
      }
      function onUp() {
        boxEl.removeEventListener("pointermove", onMove);
        boxEl.removeEventListener("pointerup", onUp);
        boxEl.classList.remove("is-dragging");
        if (moved) {
          send(EVENT_TYPES.CMD_UPDATE_WIDGET, {
            id: inst.id,
            patch: { x: round1(parseFloat(boxEl.dataset.pendingX)), y: round1(parseFloat(boxEl.dataset.pendingY)) },
          });
        }
      }
      boxEl.addEventListener("pointermove", onMove);
      boxEl.addEventListener("pointerup", onUp);
    });
  }

  function attachResizeHandlers(boxEl, inst) {
    ["nw", "ne", "sw", "se"].forEach((pos) => {
      const handle = document.createElement("div");
      handle.className = "resize-handle";
      handle.dataset.h = pos;
      boxEl.appendChild(handle);

      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectWidget(inst.id);
        const canvasRect = canvasEl.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        const cur = layout.find((w) => w.id === inst.id) || inst;
        const start = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
        const def = WIDGET_TYPES[inst.type] || { minW: 5, minH: 5 };
        handle.setPointerCapture(e.pointerId);

        function onMove(ev) {
          const dxPct = ((ev.clientX - startX) / canvasRect.width) * 100;
          const dyPct = ((ev.clientY - startY) / canvasRect.height) * 100;
          let { x, y, w, h } = start;
          if (pos.includes("e")) w = start.w + dxPct;
          if (pos.includes("s")) h = start.h + dyPct;
          if (pos.includes("w")) { w = start.w - dxPct; x = start.x + dxPct; }
          if (pos.includes("n")) { h = start.h - dyPct; y = start.y + dyPct; }
          w = Math.max(def.minW, w);
          h = Math.max(def.minH, h);
          x = clamp(x, 0, 100 - w);
          y = clamp(y, 0, 100 - h);
          w = snapValue(w);
          h = snapValue(h);
          x = snapValue(x);
          y = snapValue(y);
          boxEl.style.left = x + "%";
          boxEl.style.top = y + "%";
          boxEl.style.width = w + "%";
          boxEl.style.height = h + "%";
          boxEl.dataset.pendingGeo = JSON.stringify({ x, y, w, h });
        }
        function onUp() {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          if (boxEl.dataset.pendingGeo) {
            const geo = JSON.parse(boxEl.dataset.pendingGeo);
            send(EVENT_TYPES.CMD_UPDATE_WIDGET, {
              id: inst.id,
              patch: { x: round1(geo.x), y: round1(geo.y), w: round1(geo.w), h: round1(geo.h) },
            });
            delete boxEl.dataset.pendingGeo;
          }
        }
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
      });
    });
  }

  canvasEl.addEventListener("pointerdown", (e) => {
    if (e.target === canvasEl) selectWidget(null);
  });

  document.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && selectedId && document.activeElement.tagName !== "INPUT") {
      send(EVENT_TYPES.CMD_REMOVE_WIDGET, { id: selectedId });
      selectedId = null;
    }
  });

  // ---- layers panel ----
  function renderLayers() {
    if (!layout.length) {
      layersEl.innerHTML = `<div class="layers__empty">${t("editor.layersEmpty")}</div>`;
      return;
    }
    layersEl.innerHTML = "";
    [...layout]
      .sort((a, b) => (b.z || 0) - (a.z || 0))
      .forEach((inst) => {
        const def = WIDGET_TYPES[inst.type] || {};
        const row = document.createElement("div");
        row.className = "layer-row" + (inst.id === selectedId ? " is-selected" : "");
        row.innerHTML = `
          <span class="layer-row__icon">${ICONS[def.icon] || ""}</span>
          <span class="layer-row__label">${t("widgets." + (def.type || inst.type))}</span>
          <span class="layer-row__btns">
            <button class="layer-row__btn" data-action="forward" title="${t("common.forward")}">▲</button>
            <button class="layer-row__btn" data-action="backward" title="${t("common.backward")}">▼</button>
            <button class="layer-row__btn" data-action="toggle" title="${t("common.toggleVisibility")}">${ICONS[inst.visible ? "eye" : "eyeOff"]}</button>
          </span>`;
        row.addEventListener("click", (e) => {
          if (e.target.closest("[data-action]")) return;
          selectWidget(inst.id);
        });
        row.querySelector('[data-action="toggle"]').addEventListener("click", (e) => {
          e.stopPropagation();
          send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { visible: !inst.visible } });
        });
        row.querySelector('[data-action="forward"]').addEventListener("click", (e) => {
          e.stopPropagation();
          send(EVENT_TYPES.CMD_REORDER_WIDGET, { id: inst.id, direction: "forward" });
        });
        row.querySelector('[data-action="backward"]').addEventListener("click", (e) => {
          e.stopPropagation();
          send(EVENT_TYPES.CMD_REORDER_WIDGET, { id: inst.id, direction: "backward" });
        });
        layersEl.appendChild(row);
      });
  }

  // ---- properties panel ----
  function renderProperties() {
    const inst = layout.find((w) => w.id === selectedId);
    if (!inst) {
      propertiesSection.hidden = true;
      return;
    }
    propertiesSection.hidden = false;
    const def = WIDGET_TYPES[inst.type] || {};
    propertiesTitle.textContent = t("widgets." + (def.type || inst.type));
    const config = inst.config || {};

    let extraHtml = "";
    if (inst.type === "goal") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.goalTitle")}</label><input type="text" id="pGoalTitle" value="${escapeAttr(goal.title || "")}"></div>
        <div class="properties__row">
          <div class="md-field"><label>${t("properties.current")}</label><input type="number" id="pGoalCurrent" value="${goal.current || 0}"></div>
          <div class="md-field"><label>${t("properties.target")}</label><input type="number" id="pGoalTarget" value="${goal.target || 0}"></div>
        </div>
        <div class="md-field"><label>${t("properties.currency")}</label><input type="text" id="pGoalCurrency" value="${escapeAttr(goal.currency || "")}"></div>
        <div class="properties__toggle-row"><label>${t("properties.showPercent")}</label>${switchHtml("pShowPercent", !!config.showPercentage)}</div>`;
    } else if (inst.type === "chat") {
      extraHtml = `
        <div class="md-field"><label>${t("properties.maxMessages")}</label><input type="number" id="pMaxMessages" min="1" max="20" value="${config.maxMessages || 8}"></div>
        <div class="properties__toggle-row"><label>${t("properties.showBadges")}</label>${switchHtml("pShowBadges", config.showBadges !== false)}</div>`;
    } else if (inst.type === "recent") {
      extraHtml = `<div class="md-field"><label>${t("properties.maxItems")}</label><input type="number" id="pMaxItems" min="1" max="15" value="${config.maxItems || 5}"></div>`;
    } else if (inst.type === "alerts") {
      extraHtml = `
        <div class="properties__hint">${t("properties.testAlertHint")}</div>
        <div class="properties__test-grid">
          <button class="md-button md-button--tonal" data-test="follow">${t("properties.testFollow")}</button>
          <button class="md-button md-button--tonal" data-test="sub">${t("properties.testSub")}</button>
          <button class="md-button md-button--tonal" data-test="gift_sub">${t("properties.testGift")}</button>
          <button class="md-button md-button--tonal" data-test="cheer">${t("properties.testCheer")}</button>
          <button class="md-button md-button--tonal" data-test="donation">${t("properties.testDonation")}</button>
        </div>`;
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
          <div class="md-field"><label>${t("properties.showNames")}</label><input type="number" id="pPwMaxNames" min="1" max="200" value="${participantsConfig.maxNames ?? 10}"></div>
          <div class="md-field"><label>${t("properties.fontSize")}</label><input type="number" id="pPwFontSize" min="10" max="48" value="${participantsConfig.fontSize ?? 16}"></div>
        </div>
        <div class="md-field"><label>${t("properties.textColor")}</label><input type="color" id="pPwTextColor" value="${escapeAttr(participantsConfig.textColor || "#e8e1f0")}"></div>
        <div class="md-field"><label>${t("properties.backgroundOpacity")}: <span id="pPwBgOpacityValue">${participantsConfig.backgroundOpacity ?? 82}%</span></label><input type="range" id="pPwBgOpacity" min="0" max="100" value="${participantsConfig.backgroundOpacity ?? 82}"></div>
        <div class="properties__toggle-row"><label>${t("properties.marquee")}</label>${switchHtml("pPwMarquee", !!participantsConfig.marquee)}</div>`;
    } else if (inst.type === "mic") {
      const mode = micConfig.visualizer_mode || "sine";
      extraHtml = `
        <div class="md-field"><label>${t("mic.mode")}</label>
          <select id="pMicMode">
            <option value="sine" ${mode === "sine" ? "selected" : ""}>${t("mic.modeSine")}</option>
            <option value="bars" ${mode === "bars" ? "selected" : ""}>${t("mic.modeBars")}</option>
            <option value="ring" ${mode === "ring" ? "selected" : ""}>${t("mic.modeRing")}</option>
          </select>
        </div>
        <div class="md-field"><label>${t("mic.sensitivity")}: <span id="pMicSensitivityValue">${micConfig.sensitivity ?? 1.5}</span></label><input type="range" id="pMicSensitivity" min="0.2" max="6" step="0.1" value="${micConfig.sensitivity ?? 1.5}"></div>
        <div class="md-field"><label>${t("mic.lineWidth")}: <span id="pMicLineWidthValue">${micConfig.lineWidth ?? 2}</span></label><input type="range" id="pMicLineWidth" min="1" max="12" step="0.5" value="${micConfig.lineWidth ?? 2}"></div>
        <div class="md-field"><label>${t("mic.barCount")}: <span id="pMicBarCountValue">${micConfig.barCount ?? 32}</span></label><input type="range" id="pMicBarCount" min="10" max="64" step="1" value="${micConfig.barCount ?? 32}"></div>
        <div class="md-field"><label>${t("mic.barGap")}: <span id="pMicBarGapValue">${micConfig.barGap ?? 2}</span></label><input type="range" id="pMicBarGap" min="0" max="12" step="0.5" value="${micConfig.barGap ?? 2}"></div>
        <div class="md-field"><label>${t("mic.color")}</label><input type="color" id="pMicColor" value="${escapeAttr(micConfig.color || "#0060A8")}"></div>
        <div class="md-field"><label>${t("mic.opacity")}: <span id="pMicOpacityValue">${Math.round((micConfig.opacity ?? 0.9) * 100)}%</span></label><input type="range" id="pMicOpacity" min="5" max="100" step="1" value="${Math.round((micConfig.opacity ?? 0.9) * 100)}"></div>`;
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

    if (inst.type === "goal") {
      propertiesEl.querySelector("#pGoalTitle").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { title: e.target.value }));
      propertiesEl.querySelector("#pGoalCurrent").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { current: Number(e.target.value) }));
      propertiesEl.querySelector("#pGoalTarget").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { target: Number(e.target.value) }));
      propertiesEl.querySelector("#pGoalCurrency").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { currency: e.target.value }));
      wireSwitch(propertiesEl.querySelector("#pShowPercent"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showPercentage: on } } }));
    } else if (inst.type === "chat") {
      propertiesEl.querySelector("#pMaxMessages").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { maxMessages: Number(e.target.value) } } }));
      wireSwitch(propertiesEl.querySelector("#pShowBadges"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showBadges: on } } }));
    } else if (inst.type === "recent") {
      propertiesEl.querySelector("#pMaxItems").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { maxItems: Number(e.target.value) } } }));
    } else if (inst.type === "alerts") {
      propertiesEl.querySelectorAll("[data-test]").forEach((btn) => btn.addEventListener("click", () => send(EVENT_TYPES.CMD_TEST_ALERT, { kind: btn.dataset.test })));
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
      propertiesEl.querySelector("#pMicColor").addEventListener("input", (e) => sendMicConfig({ color: e.target.value }));
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
    } else if (inst.type === "custom") {
      wireCustomWidgetFields(inst, config);
      document.getElementById("pCustomMode").addEventListener("change", (e) => {
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { mode: e.target.value } } });
      });
    }

    document.getElementById("pDeleteBtn").addEventListener("click", () => {
      if (!confirm(t("common.deleteWidgetConfirm", { name: t("widgets." + (def.type || inst.type)) }))) return;
      send(EVENT_TYPES.CMD_REMOVE_WIDGET, { id: inst.id });
      selectedId = null;
    });
  }

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

  // ---- status chips ----
  const STATUS_LABEL = (service) =>
    ({ twitchChat: t("status.twitchChat"), twitchEvents: t("status.twitchEvents"), donationAlerts: t("status.donationAlerts"), youtube: t("status.youtube") }[service] || service);
  const STATUS_TEXT = (status) =>
    ({ connected: t("status.connected"), connecting: t("status.connecting"), disconnected: t("status.disconnected"), error: t("status.error"), not_configured: t("status.notConfigured"), disabled: t("status.disabled") }[status] || status);

  function statusClass(status) {
    if (status === "connected") return "is-connected";
    if (status === "error") return "is-error";
    if (status === "connecting") return "is-pending";
    return "";
  }

  function renderStatusChips() {
    statusChipsEl.innerHTML = Object.entries(connectionStatus)
      .map(([service, status]) => `<span class="md-chip ${statusClass(status)}"><span class="md-chip__dot"></span>${STATUS_LABEL(service)}</span>`)
      .join("");
  }

  function updateSettingsChips() {
    ["twitchChat", "twitchEvents", "donationAlerts", "youtube"].forEach((service) => {
      const el = document.getElementById("chip-" + service);
      if (!el) return;
      const status = connectionStatus[service];
      el.className = "md-chip " + statusClass(status);
      el.querySelector(".md-chip__label").textContent = `${STATUS_LABEL(service)}: ${STATUS_TEXT(status)}`;
    });
  }

  // ---- settings view ----
  function populateSettings() {
    twitchChannelInput.value = twitchChannel || "";
    twitchClientIdInput.value = twitchClientId || "";
    daClientIdInput.value = daClientId || "";
    youtubeClientIdInput.value = youtubeClientId || "";
    youtubeVideoIdInput.value = youtubeVideoId || "";
    appPortInput.value = port;
    appOverlayUrlInput.value = overlayUrl;
    twitchRedirectUriEl.textContent = `http://localhost:${port}/oauth/twitch/callback`;
    daRedirectUriEl.textContent = `http://localhost:${port}/oauth/donationalerts/callback`;
    youtubeRedirectUriEl.textContent = `http://localhost:${port}/oauth/youtube/callback`;
  }

  twitchChannelInput.addEventListener("change", () => {
    send(EVENT_TYPES.CMD_SET_APP_CONFIG, { twitchChannel: twitchChannelInput.value.trim() });
  });

  youtubeVideoIdInput.addEventListener("change", () => {
    send(EVENT_TYPES.CMD_SET_YOUTUBE_VIDEO_ID, { videoId: youtubeVideoIdInput.value.trim() });
  });

  document.getElementById("connectTwitchBtn").addEventListener("click", () => {
    window.desktop?.connectTwitch({
      clientId: twitchClientIdInput.value.trim(),
      clientSecret: twitchClientSecretInput.value.trim(),
      channel: twitchChannelInput.value.trim(),
    });
  });
  document.getElementById("connectDaBtn").addEventListener("click", () => {
    window.desktop?.connectDonationAlerts({
      clientId: daClientIdInput.value.trim(),
      clientSecret: daClientSecretInput.value.trim(),
    });
  });
  document.getElementById("connectYoutubeBtn").addEventListener("click", () => {
    window.desktop?.connectYoutube({
      clientId: youtubeClientIdInput.value.trim(),
      clientSecret: youtubeClientSecretInput.value.trim(),
    });
  });
  document.getElementById("openTwitchConsole").addEventListener("click", () => window.desktop?.openExternal("https://dev.twitch.tv/console/apps"));
  document.getElementById("openDaConsole").addEventListener("click", () => window.desktop?.openExternal("https://www.donationalerts.com/application/clients"));
  document.getElementById("openYoutubeConsole").addEventListener("click", () => window.desktop?.openExternal("https://console.cloud.google.com/apis/credentials"));

  function setSwitchState(el, on) {
    if (!el) return;
    el.classList.toggle("is-on", on);
    el.setAttribute("aria-checked", String(on));
  }

  function syncIntegrationSwitches() {
    setSwitchState(twitchEnabledSwitch, twitchEnabled);
    setSwitchState(donationAlertsEnabledSwitch, donationAlertsEnabled);
    setSwitchState(youtubeEnabledSwitch, youtubeEnabled);
  }

  [[twitchEnabledSwitch, "twitch"], [donationAlertsEnabledSwitch, "donationAlerts"], [youtubeEnabledSwitch, "youtube"]].forEach(([el, service]) => {
    if (!el) return;
    el.addEventListener("click", () => {
      const on = !el.classList.contains("is-on");
      setSwitchState(el, on);
      send(EVENT_TYPES.CMD_SET_INTEGRATION_ENABLED, { service, enabled: on });
    });
  });
  document.getElementById("resetLayoutBtn").addEventListener("click", () => {
    if (!confirm(t("common.resetLayoutConfirm"))) return;
    layout.forEach((w) => send(EVENT_TYPES.CMD_REMOVE_WIDGET, { id: w.id }));
    ["recent", "alerts", "goal", "chat"].forEach((type) => send(EVENT_TYPES.CMD_ADD_WIDGET, { type }));
    selectedId = null;
  });

  // ---- events history ----
  const EVENTS_TYPE_LABEL = (type) =>
    ({ donation: t("events.donation"), subscription: t("events.subscription"), follow: t("events.follow"), cheer: t("events.cheer") }[type] || type);
  const EVENTS_PAGE_SIZE = 20;
  let eventsOffset = 0;
  let eventsTotal = 0;
  let eventsFilter = "all";
  let eventsSearch = "";
  let eventsSearchTimer = null;

  function formatEventTime(ts) {
    const locale = (window.I18n && window.I18n.getLang() === "ru") ? "ru-RU" : "en-US";
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function renderEventRow(ev) {
    const amount = typeof ev.amount === "number" ? `${formatMoney(ev.amount)} ${currencySymbol(ev.currency)}` : "";
    const testBadge = ev.is_test ? '<span class="events-history__test">' + t("events.test") + '</span>' : "";
    return `
      <div class="events-history__row">
        <span class="events-history__type events-history__type--${escapeAttr(ev.type)}">${escapeHtml(EVENTS_TYPE_LABEL(ev.type))}</span>
        <span class="events-history__user">${escapeHtml(ev.username)}</span>
        ${amount ? `<span class="events-history__amount">${escapeHtml(amount)}</span>` : ""}
        ${ev.message ? `<span class="events-history__message">${escapeHtml(ev.message)}</span>` : ""}
        <span class="events-history__time">${formatEventTime(ev.timestamp)}</span>
        ${testBadge}
        <button class="md-button md-button--text events-history__replay" data-replay-id="${escapeAttr(ev.id)}">${t("events.replay")}</button>
      </div>`;
  }

  async function renderStreamEvents(reset = true) {
    if (!window.desktop?.db?.getStreamEvents) return;

    if (reset) {
      eventsOffset = 0;
      eventsTotal = 0;
      eventsHistoryEl.innerHTML = '<div class="events-history__empty">' + t("events.loading") + '</div>';
      eventsMetaEl.textContent = "";
      loadMoreEventsBtn.hidden = true;
    }

    try {
      const result = await window.desktop.db.getStreamEvents({
        limit: EVENTS_PAGE_SIZE,
        offset: eventsOffset,
        type: eventsFilter === "all" ? undefined : eventsFilter,
        search: eventsSearch,
      });
      const items = (result && result.items) || [];
      eventsTotal = (result && result.total) || 0;

      if (reset) {
        eventsHistoryEl.innerHTML = "";
        eventsMetaEl.textContent = t("events.totalCount", { count: eventsTotal });
      }

      if (!items.length && reset) {
        eventsHistoryEl.innerHTML = '<div class="events-history__empty">' + t("events.empty") + '</div>';
        return;
      }

      items.forEach((ev) => eventsHistoryEl.insertAdjacentHTML("beforeend", renderEventRow(ev)));
      eventsOffset += items.length;

      const hasMore = eventsOffset < eventsTotal;
      loadMoreEventsBtn.hidden = !hasMore;
      if (hasMore) loadMoreEventsBtn.textContent = t("events.showMore", { current: eventsOffset, total: eventsTotal });
    } catch (err) {
      if (reset) {
        eventsHistoryEl.innerHTML = '<div class="events-history__empty">' + t("events.loadError") + '</div>';
        eventsMetaEl.textContent = "";
      }
    }
  }

  refreshEventsBtn.addEventListener("click", () => renderStreamEvents(true));
  loadMoreEventsBtn.addEventListener("click", () => renderStreamEvents(false));

  function updateEventsFilterButtons() {
    eventsFiltersEl.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.filter === eventsFilter);
    });
  }

  eventsFiltersEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-filter]");
    if (!btn) return;
    eventsFilter = btn.dataset.filter;
    updateEventsFilterButtons();
    renderStreamEvents(true);
  });

  eventsSearchInput.addEventListener("input", () => {
    clearTimeout(eventsSearchTimer);
    eventsSearchTimer = setTimeout(() => {
      eventsSearch = eventsSearchInput.value.trim();
      renderStreamEvents(true);
    }, 300);
  });

  clearEventsBtn.addEventListener("click", async () => {
    if (!confirm(t("events.clearConfirm"))) return;
    await window.desktop?.db?.clearStreamEvents?.();
    renderStreamEvents(true);
  });

  eventsHistoryEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-replay-id]");
    if (!btn) return;
    await window.desktop?.replayEvent?.(btn.dataset.replayId);
  });

  renderStreamEvents(true);

  // ---- giveaway / fortune wheel ----
  function renderGiveaway() {
    const commandEl = document.getElementById("giveawayCommand");
    if (!commandEl) return; // wheel scene form not currently rendered
    if (document.activeElement !== commandEl) {
      commandEl.value = giveaway.command || "!go";
    }
    const countEl = document.getElementById("giveawayCount");
    const chipEl = document.getElementById("giveawayChip");
    const listEl = document.getElementById("giveawayParticipants");
    const eliminationEl = document.getElementById("giveawayElimination");
    if (countEl) countEl.textContent = `${t("giveaway.participants")}: ${giveaway.count}`;
    if (chipEl) chipEl.className = "md-chip " + (giveaway.active ? "is-pending" : "");

    const items = giveaway.participants || [];
    if (listEl) {
      listEl.innerHTML = items.length
        ? items.map((u) => `
            <div class="giveaway-participant-row">
              <span class="giveaway-participant__name">${escapeHtml(u)}</span>
              <button class="giveaway-participant__remove" data-remove-name="${escapeAttr(u)}" title="${t("giveaway.removeParticipant")}">✕</button>
            </div>`).join("")
        : '<div class="events-history__empty">' + t("giveaway.noParticipants") + '</div>';
    }

    if (eliminationEl && eliminationEl.classList.contains("is-on") !== !!giveaway.eliminationMode) {
      eliminationEl.classList.toggle("is-on", !!giveaway.eliminationMode);
    }
  }

  function wireGiveawayControls() {
    document.getElementById("startGiveawayBtn")?.addEventListener("click", () => {
      const commandEl = document.getElementById("giveawayCommand");
      send(EVENT_TYPES.CMD_START_GIVEAWAY, { command: commandEl ? commandEl.value.trim() : "!go" });
    });
    document.getElementById("stopGiveawayBtn")?.addEventListener("click", () => send(EVENT_TYPES.CMD_STOP_GIVEAWAY, {}));
    document.getElementById("shuffleGiveawayBtn")?.addEventListener("click", () => send(EVENT_TYPES.CMD_SHUFFLE_GIVEAWAY, {}));
    document.getElementById("generateWheelBtn")?.addEventListener("click", () => send(EVENT_TYPES.CMD_GENERATE_WHEEL, {}));
    document.getElementById("spinWheelBtn")?.addEventListener("click", () => send(EVENT_TYPES.CMD_SPIN_WHEEL, {}));
    const eliminationEl = document.getElementById("giveawayElimination");
    if (eliminationEl) wireSwitch(eliminationEl, (on) => send(EVENT_TYPES.CMD_SET_GIVEAWAY_ELIMINATION, { enabled: on }));

    document.getElementById("addParticipantBtn")?.addEventListener("click", () => {
      const input = document.getElementById("giveawayManualName");
      if (!input) return;
      const name = input.value.trim();
      if (!name) return;
      send(EVENT_TYPES.CMD_ADD_GIVEAWAY_PARTICIPANT, { username: name });
      input.value = "";
    });

    document.getElementById("giveawayParticipants")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove-name]");
      if (!btn) return;
      send(EVENT_TYPES.CMD_REMOVE_GIVEAWAY_PARTICIPANT, { username: btn.dataset.removeName });
    });
  }

  // ---- participants widget settings ----
  function sendParticipantsConfig(patch) {
    participantsConfig = { ...participantsConfig, ...patch };
    send(EVENT_TYPES.CMD_SET_PARTICIPANTS_CONFIG, { config: participantsConfig });
  }

  // ---- microphone visualizer widget settings ----
  function sendMicConfig(patch) {
    micConfig = { ...micConfig, ...patch };
    send(EVENT_TYPES.CMD_SET_MIC_CONFIG, { config: micConfig });
  }

  // ---- appearance: theme picker + custom theme editor ----

  function renderThemeGrid() {
    themeGridEl.innerHTML = "";
    (appearance.themes || []).forEach((theme) => {
      const card = document.createElement("div");
      card.className = "theme-swatch" + (theme.id === appearance.activeThemeId ? " is-active" : "");
      const dotColors = theme.builtin
        ? BuiltinThemes.BUILTIN_THEMES[theme.id].tokens
        : null;
      const dots = theme.builtin
        ? [dotColors["--md-primary"], dotColors["--md-secondary"], dotColors["--md-tertiary"]]
        : theme.seeds
        ? [theme.seeds.primary, theme.seeds.secondary, theme.seeds.tertiary]
        : ["#888", "#888", "#888"];
      card.innerHTML = `
        <div class="theme-swatch__dots">${dots.map((c) => `<span class="theme-swatch__dot" style="background:${c}"></span>`).join("")}</div>
        <div class="theme-swatch__row">
          <span class="theme-swatch__name">${escapeHtml(theme.name)}</span>
          ${
            theme.builtin
              ? ""
              : `<span class="layer-row__btns">
                  <button class="theme-swatch__btn" data-action="edit" title="${t("common.edit")}">✎</button>
                  <button class="theme-swatch__btn" data-action="delete" title="${t("common.remove")}">${ICONS.trash}</button>
                </span>`
          }
        </div>`;
      card.addEventListener("click", (e) => {
        if (e.target.closest("[data-action]")) return;
        send(EVENT_TYPES.CMD_SET_ACTIVE_THEME, { id: theme.id });
      });
      if (!theme.builtin) {
        card.querySelector('[data-action="edit"]').addEventListener("click", (e) => {
          e.stopPropagation();
          openThemeEditor(theme);
        });
        card.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
          e.stopPropagation();
          if (confirm(t("common.deleteThemeConfirm", { name: theme.name }))) send(EVENT_TYPES.CMD_DELETE_CUSTOM_THEME, { id: theme.id });
        });
      }
      themeGridEl.appendChild(card);
    });
  }

  function openThemeEditor(theme) {
    editingThemeId = theme ? theme.id : null;
    const seeds = theme && theme.seeds
      ? theme.seeds
      : { primary: "#c6b8ff", secondary: "#7ee0d6", tertiary: "#ffb0d8", surfaceSeed: "#8878c8", shapeMode: "rounded", fontPreset: "nebula" };

    themeEditorEl.hidden = false;
    themeEditorEl.innerHTML = `
      <div class="md-field"><label>${t("themeEditor.themeName")}</label><input type="text" id="themeName" value="${escapeAttr(theme ? theme.name : t("themeEditor.myTheme"))}"></div>
      <div class="theme-editor__colors">
        <div class="theme-editor__color"><label>${t("themeEditor.primary")}</label><input type="color" id="seedPrimary" value="${seeds.primary}"></div>
        <div class="theme-editor__color"><label>${t("themeEditor.secondary")}</label><input type="color" id="seedSecondary" value="${seeds.secondary}"></div>
        <div class="theme-editor__color"><label>${t("themeEditor.tertiary")}</label><input type="color" id="seedTertiary" value="${seeds.tertiary}"></div>
        <div class="theme-editor__color"><label>${t("themeEditor.surface")}</label><input type="color" id="seedSurface" value="${seeds.surfaceSeed}"></div>
      </div>
      <div class="theme-editor__row">
        <div class="md-field"><label>${t("themeEditor.shape")}</label>
          <select id="seedShape">
            <option value="rounded" ${seeds.shapeMode !== "angular" ? "selected" : ""}>${t("themeEditor.rounded")}</option>
            <option value="angular" ${seeds.shapeMode === "angular" ? "selected" : ""}>${t("themeEditor.angular")}</option>
          </select>
        </div>
        <div class="md-field"><label>${t("themeEditor.fonts")}</label>
          <select id="seedFont">
            <option value="nebula" ${seeds.fontPreset !== "orbital" ? "selected" : ""}>Roboto (Material You)</option>
            <option value="orbital" ${seeds.fontPreset === "orbital" ? "selected" : ""}>Orbitron / Rajdhani (Orbital)</option>
          </select>
        </div>
      </div>
      <div class="settings__actions">
        <button class="md-button md-button--filled" id="saveThemeBtn">${t("themeEditor.save")}</button>
        <button class="md-button md-button--text" id="cancelThemeBtn">${t("themeEditor.cancel")}</button>
      </div>`;

    const previewFromForm = () => {
      const liveSeeds = {
        primary: document.getElementById("seedPrimary").value,
        secondary: document.getElementById("seedSecondary").value,
        tertiary: document.getElementById("seedTertiary").value,
        surfaceSeed: document.getElementById("seedSurface").value,
        shapeMode: document.getElementById("seedShape").value,
        fontPreset: document.getElementById("seedFont").value,
      };
      applyThemeToCanvas(ThemeEngine.buildThemeTokens(liveSeeds));
      return liveSeeds;
    };
    themeEditorEl.querySelectorAll("input, select").forEach((el) => el.addEventListener("input", previewFromForm));

    document.getElementById("saveThemeBtn").addEventListener("click", () => {
      const liveSeeds = previewFromForm();
      send(EVENT_TYPES.CMD_SAVE_CUSTOM_THEME, {
        id: editingThemeId,
        name: document.getElementById("themeName").value.trim() || t("themeEditor.myTheme"),
        seeds: liveSeeds,
      });
      closeThemeEditor();
    });
    document.getElementById("cancelThemeBtn").addEventListener("click", closeThemeEditor);

    themeEditorEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closeThemeEditor() {
    editingThemeId = null;
    themeEditorEl.hidden = true;
    themeEditorEl.innerHTML = "";
    applyThemeToCanvas(appearance.tokens); // revert live-preview back to the actually active theme
  }

  newThemeBtn.addEventListener("click", () => openThemeEditor(null));

  // ---- export / import ----

  function showExportImportStatus(text, isError) {
    exportImportStatus.hidden = false;
    exportImportStatus.textContent = text;
    exportImportStatus.style.color = isError ? "var(--md-error)" : "";
  }

  exportConfigBtn.textContent = t("settings.export");
  exportConfigBtn.addEventListener("click", async () => {
    const res = await window.desktop?.exportConfig();
    if (!res) return;
    if (res.canceled) return;
    if (res.ok) showExportImportStatus(t("settings.exportSaved", { path: res.filePath }), false);
    else showExportImportStatus(t("settings.exportFailed", { error: res.error }), true);
  });

  importConfigBtn.textContent = t("settings.import");
  importConfigBtn.addEventListener("click", async () => {
    if (!confirm(t("settings.importConfirm"))) return;
    const res = await window.desktop?.importConfig();
    if (!res) return;
    if (res.canceled) return;
    if (res.ok) {
      showExportImportStatus(t("settings.imported"), false);
      selectedId = null;
    } else {
      showExportImportStatus(t("settings.importFailed", { error: res.error }), true);
    }
  });

  // ---- scenes ----

  function sceneUrl(id) {
    if (id === "wheel") return `http://localhost:${port}/overlay/wheel-scene.html`;
    return `http://localhost:${port}/overlay/scene.html?type=${id}`;
  }

  function renderScenesNav() {
    scenesNavListEl.innerHTML = "";
    Object.values(SceneCatalog.SCENE_DEFS).forEach((def) => {
      const card = document.createElement("div");
      card.className = "library-card" + (def.id === activeSceneId ? " is-active" : "");
      card.innerHTML = `<span class="library-card__icon">${ICONS[def.icon] || ""}</span><span class="library-card__text"><span class="library-card__label">${t("scene." + def.id + "Label")}</span></span>`;
      card.addEventListener("click", () => selectScene(def.id));
      scenesNavListEl.appendChild(card);
    });
  }

  function selectScene(id) {
    activeSceneId = id;
    const url = sceneUrl(id);
    if (scenesPreviewFrame.src !== url) scenesPreviewFrame.src = url;
    sceneUrlLabel.textContent = url;
    renderScenesNav();
    renderSceneForm();
  }

  function sendSceneUpdate(patch) {
    send(EVENT_TYPES.CMD_SET_SCENE_CONFIG, { sceneId: activeSceneId, patch });
  }

  function renderSceneForm() {
    const scene = scenes[activeSceneId];
    if (!scene) return;
    const def = SceneCatalog.SCENE_DEFS[activeSceneId];
    sceneFormTitle.textContent = t("scene." + def.id + "Label");

    if (activeSceneId === "wheel") {
      sceneFormEl.innerHTML = `
        <div class="md-field"><label>${t("giveaway.command")}</label><input type="text" id="giveawayCommand" placeholder="!go" value="${escapeAttr(giveaway.command || "!go")}"></div>
        <div class="settings__statuses"><span class="md-chip" id="giveawayChip"><span class="md-chip__dot"></span><span id="giveawayCount">${t("giveaway.participants")}: ${giveaway.count}</span></span></div>
        <div class="properties__test-grid">
          <button class="md-button md-button--filled" id="startGiveawayBtn">${t("giveaway.start")}</button>
          <button class="md-button md-button--outlined" id="stopGiveawayBtn">${t("giveaway.stop")}</button>
          <button class="md-button md-button--tonal" id="shuffleGiveawayBtn">${t("giveaway.shuffle")}</button>
          <button class="md-button md-button--tonal" id="generateWheelBtn">${t("giveaway.generateWheel")}</button>
          <button class="md-button md-button--filled" id="spinWheelBtn">${t("giveaway.spinWheel")}</button>
        </div>
        <div class="properties__toggle-row"><label>${t("giveaway.eliminationMode")}</label>${switchHtml("giveawayElimination", !!giveaway.eliminationMode)}</div>
        <div class="giveaway-manual">
          <input type="text" id="giveawayManualName" placeholder="${t("giveaway.participantPlaceholder")}" />
        </div>
        <button class="md-button md-button--tonal" id="addParticipantBtn" title="${t("giveaway.addParticipant")}">+ ${t("giveaway.addParticipant")}</button>
        <div class="giveaway-participants" id="giveawayParticipants"></div>

        <div class="inspector__title" style="margin-top:10px;">${t("giveaway.participantsWidgetTitle")}</div>
        <div class="properties__row">
          <div class="md-field"><label>${t("giveaway.showNames")}</label><input type="number" id="wsMaxNames" min="1" max="200" value="${participantsConfig.maxNames ?? 10}"></div>
          <div class="md-field"><label>${t("giveaway.fontSize")} (px)</label><input type="number" id="wsFontSize" min="10" max="48" value="${participantsConfig.fontSize ?? 16}"></div>
        </div>
        <div class="md-field"><label>${t("giveaway.textColor")}</label><input type="color" id="wsTextColor" value="${escapeAttr(participantsConfig.textColor || "#e8e1f0")}"></div>
        <div class="md-field"><label>${t("giveaway.backgroundOpacity")}: <span id="wsBgOpacityValue">${participantsConfig.backgroundOpacity ?? 82}%</span></label><input type="range" id="wsBgOpacity" min="0" max="100" value="${participantsConfig.backgroundOpacity ?? 82}"></div>
        <div class="properties__row">
          <div class="md-field"><label>X: <span id="wsXValue">${participantsConfig.x ?? 1.25}%</span></label><input type="range" id="wsX" min="0" max="100" step="0.25" value="${participantsConfig.x ?? 1.25}"></div>
          <div class="md-field"><label>Y: <span id="wsYValue">${participantsConfig.y ?? 50}%</span></label><input type="range" id="wsY" min="0" max="100" step="0.25" value="${participantsConfig.y ?? 50}"></div>
        </div>
        <div class="properties__toggle-row"><label>${t("giveaway.marquee")}</label>${switchHtml("wsMarquee", !!participantsConfig.marquee)}</div>

        <div class="inspector__title" style="margin-top:10px;">${t("giveaway.wheelSettings")}</div>
        <div class="md-field"><label>${t("giveaway.musicVolume")}: <span id="wsMusicVolumeValue">${wheelConfig.musicVolume ?? 50}%</span></label><input type="range" id="wsMusicVolume" min="0" max="100" value="${wheelConfig.musicVolume ?? 50}"></div>
        <div class="md-field"><label>${t("giveaway.spinSpeed")}: <span id="wsSpeedValue">${wheelSpeedConfig.speed ?? 3}</span></label><input type="range" id="wsSpeed" min="1" max="5" value="${wheelSpeedConfig.speed ?? 3}"></div>
      `;

      renderGiveaway();
      wireGiveawayControls();

      sceneFormEl.querySelector("#wsMaxNames").addEventListener("change", (e) => sendParticipantsConfig({ maxNames: Number(e.target.value) || 10 }));
      sceneFormEl.querySelector("#wsFontSize").addEventListener("change", (e) => sendParticipantsConfig({ fontSize: Number(e.target.value) || 16 }));
      sceneFormEl.querySelector("#wsTextColor").addEventListener("input", (e) => sendParticipantsConfig({ textColor: e.target.value }));
      sceneFormEl.querySelector("#wsBgOpacity").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        sceneFormEl.querySelector("#wsBgOpacityValue").textContent = `${v}%`;
        sendParticipantsConfig({ backgroundOpacity: v });
      });
      sceneFormEl.querySelector("#wsX").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        sceneFormEl.querySelector("#wsXValue").textContent = `${v}%`;
        sendParticipantsConfig({ x: v });
      });
      sceneFormEl.querySelector("#wsY").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        sceneFormEl.querySelector("#wsYValue").textContent = `${v}%`;
        sendParticipantsConfig({ y: v });
      });
      wireSwitch(sceneFormEl.querySelector("#wsMarquee"), (on) => sendParticipantsConfig({ marquee: on }));

      sceneFormEl.querySelector("#wsMusicVolume").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        sceneFormEl.querySelector("#wsMusicVolumeValue").textContent = `${v}%`;
        wheelConfig = { ...wheelConfig, musicVolume: v };
        send(EVENT_TYPES.CMD_SET_WHEEL_CONFIG, { config: wheelConfig });
      });
      sceneFormEl.querySelector("#wsSpeed").addEventListener("input", (e) => {
        const v = Number(e.target.value);
        sceneFormEl.querySelector("#wsSpeedValue").textContent = `${v}`;
        wheelSpeedConfig = { ...wheelSpeedConfig, speed: v };
        send(EVENT_TYPES.CMD_SET_WHEEL_SPEED_CONFIG, { config: wheelSpeedConfig });
      });
      return;
    }

    sceneFormEl.innerHTML = `
      <div class="md-field"><label>${t("sceneForm.statusBadge")}</label><input type="text" id="sStatusLabel" value="${escapeAttr(scene.statusLabel)}"></div>
      <div class="md-field"><label>${t("sceneForm.title")}</label><input type="text" id="sTitle" value="${escapeAttr(scene.title)}"></div>
      <div class="md-field"><label>${t("sceneForm.subtitle")}</label><input type="text" id="sSubtitle" value="${escapeAttr(scene.subtitle)}"></div>
      <div class="properties__toggle-row"><label>${t("sceneForm.timer")}</label>${switchHtml("sShowTimer", scene.showTimer)}</div>
      <div class="md-field"><label>${t("sceneForm.timerDuration")}</label><input type="number" id="sTimerDuration" min="0" value="${scene.timerDuration}"></div>
      <div class="md-field"><label>${t("sceneForm.timerDoneText")}</label><input type="text" id="sTimerDoneText" value="${escapeAttr(scene.timerDoneText || "")}"></div>
      <div class="properties__toggle-row"><label>${t("sceneForm.recentEvents")}</label>${switchHtml("sShowEvents", scene.showEvents)}</div>
      <div class="properties__toggle-row"><label>${t("sceneForm.socials")}</label>${switchHtml("sShowSocials", scene.showSocials)}</div>
      <div class="md-field">
        <label>${t("sceneForm.socials")}</label>
        <div class="scene-socials-list" id="sSocialsList"></div>
        <button class="md-button md-button--text" id="sAddSocial" style="align-self:flex-start;margin-top:4px;">+ ${t("sceneForm.addSocial")}</button>
      </div>
      <div class="inspector__title" style="margin-top:4px;">${t("sceneForm.topDonation")}</div>
      <div class="properties__hint">${topDonation.amount > 0 ? `${escapeHtml(topDonation.user)} — ${formatMoney(topDonation.amount)} ${escapeHtml(currencySymbol(topDonation.currency))}` : t("sceneForm.noDonations")}</div>
      <button class="md-button md-button--outlined" id="sResetTopDonation">${t("sceneForm.resetTopDonation")}</button>
    `;

    renderSocialsList(scene.socials || []);

    sceneFormEl.querySelector("#sStatusLabel").addEventListener("change", (e) => sendSceneUpdate({ statusLabel: e.target.value }));
    sceneFormEl.querySelector("#sTitle").addEventListener("change", (e) => sendSceneUpdate({ title: e.target.value }));
    sceneFormEl.querySelector("#sSubtitle").addEventListener("change", (e) => sendSceneUpdate({ subtitle: e.target.value }));
    sceneFormEl.querySelector("#sTimerDuration").addEventListener("change", (e) => sendSceneUpdate({ timerDuration: Number(e.target.value) }));
    sceneFormEl.querySelector("#sTimerDoneText").addEventListener("change", (e) => sendSceneUpdate({ timerDoneText: e.target.value }));
    wireSwitch(sceneFormEl.querySelector("#sShowTimer"), (on) => sendSceneUpdate({ showTimer: on }));
    wireSwitch(sceneFormEl.querySelector("#sShowEvents"), (on) => sendSceneUpdate({ showEvents: on }));
    wireSwitch(sceneFormEl.querySelector("#sShowSocials"), (on) => sendSceneUpdate({ showSocials: on }));
    sceneFormEl.querySelector("#sAddSocial").addEventListener("click", () => {
      sendSceneUpdate({ socials: [...(scene.socials || []), { platform: "", text: "" }] });
    });
    sceneFormEl.querySelector("#sResetTopDonation").addEventListener("click", () => {
      if (confirm(t("sceneForm.resetTopDonationConfirm"))) send(EVENT_TYPES.CMD_RESET_TOP_DONATION, {});
    });
  }

  function renderSocialsList(socials) {
    const host = document.getElementById("sSocialsList");
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
        sendSceneUpdate({ socials: socials.map((s, i) => (i === idx ? { ...s, [field]: inp.value } : s)) });
      });
    });
    host.querySelectorAll('[data-action="remove-social"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        sendSceneUpdate({ socials: socials.filter((_, i) => i !== idx) });
      });
    });
  }

  copySceneUrlBtn.textContent = t("scenes.copyUrl");
  copySceneUrlBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(sceneUrl(activeSceneId));
    copySceneUrlBtn.textContent = t("scenes.copied");
    setTimeout(() => (copySceneUrlBtn.textContent = t("scenes.copyUrl")), 1400);
  });

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.textContent = t("common.copy");
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.copy);
      navigator.clipboard.writeText(target.textContent);
      btn.textContent = t("editor.copied");
      setTimeout(() => (btn.textContent = t("common.copy")), 1400);
    });
  });

  obsUrlLabel.textContent = overlayUrl;
  copyUrlBtn.textContent = t("editor.copyUrl");
  copyUrlBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(overlayUrl);
    copyUrlBtn.textContent = t("editor.copied");
    setTimeout(() => (copyUrlBtn.textContent = t("editor.copyUrl")), 1400);
  });

  const openChatWindowBtn = document.getElementById("openChatWindowBtn");
  openChatWindowBtn.innerHTML = `${ICONS.widgetChat} ${t("editor.chat")}`;
  openChatWindowBtn.addEventListener("click", () => window.desktop?.openChatWindow());

  const openBoostyBtn = document.getElementById("openBoostyBtn");
  if (openBoostyBtn) {
    openBoostyBtn.innerHTML = `${ICONS.heart} ${t("boosty.support")}`;
    openBoostyBtn.addEventListener("click", () => window.desktop?.openExternal("https://boosty.to/halantar/donate"));
  }

  document.querySelectorAll("#languageSwitcher [data-lang]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lang = btn.dataset.lang;
      if (window.desktop && window.desktop.changeLanguage) window.desktop.changeLanguage(lang);
      else send(EVENT_TYPES.CMD_SET_LANGUAGE, { lang });
    });
  });

  // ---- terminal ----
  const TERMINAL_MAX_LINES = 500;
  let terminalAtBottom = true;

  function formatTerminalTime(ts) {
    const d = new Date(Number(ts) || Date.now());
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function serializeTerminalData(data) {
    if (data === null || data === undefined) return "";
    if (typeof data === "string") return data;
    try {
      const s = JSON.stringify(data);
      return s && s !== "{}" ? s : "";
    } catch {
      return String(data);
    }
  }

  function appendTerminalLine(entry) {
    if (!terminalBody || !entry) return;

    const line = document.createElement("div");
    line.className = `terminal-line terminal-line--${entry.level || "info"}`;
    line.dataset.service = entry.service || "server";

    const time = document.createElement("span");
    time.className = "terminal-line__time";
    time.textContent = formatTerminalTime(entry.timestamp);

    const service = document.createElement("span");
    service.className = "terminal-line__service";
    service.textContent = entry.service || "server";

    const level = document.createElement("span");
    level.className = "terminal-line__level";
    level.textContent = String(entry.level || "info").toUpperCase();

    const message = document.createElement("span");
    message.className = "terminal-line__message";
    message.textContent = entry.message || "";

    line.append(time, service, level, message);

    const dataStr = serializeTerminalData(entry.data);
    if (dataStr) {
      const data = document.createElement("span");
      data.className = "terminal-line__data";
      data.textContent = dataStr;
      line.appendChild(document.createTextNode(" "));
      line.appendChild(data);
    }

    terminalBody.appendChild(line);
    while (terminalBody.children.length > TERMINAL_MAX_LINES) {
      terminalBody.removeChild(terminalBody.firstChild);
    }

    if (terminalAtBottom) {
      terminalBody.scrollTop = terminalBody.scrollHeight;
    }
  }

  function setTerminalOpen(open) {
    if (!terminalPanel || !toggleTerminalBtn) return;
    terminalPanel.hidden = !open;
    toggleTerminalBtn.classList.toggle("is-active", open);
    if (open && terminalBody) terminalBody.scrollTop = terminalBody.scrollHeight;
  }

  function toggleTerminal() {
    setTerminalOpen(terminalPanel && terminalPanel.hidden);
  }

  if (toggleTerminalBtn) {
    toggleTerminalBtn.innerHTML = `${ICONS.terminal} ${t("editor.terminal")}`;
    toggleTerminalBtn.addEventListener("click", toggleTerminal);
  }
  if (terminalCloseBtn) terminalCloseBtn.addEventListener("click", () => setTerminalOpen(false));
  if (terminalClearBtn) terminalClearBtn.addEventListener("click", () => { if (terminalBody) terminalBody.innerHTML = ""; });
  if (terminalBody) {
    terminalBody.addEventListener("scroll", () => {
      terminalAtBottom = terminalBody.scrollHeight - terminalBody.scrollTop - terminalBody.clientHeight < 40;
    });
  }

  // ---- websocket ----
  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE:
        layout = msg.payload.layout || [];
        goal = msg.payload.goal;
        twitchChannel = msg.payload.twitchChannel;
        twitchClientId = msg.payload.twitchClientId;
        daClientId = msg.payload.donationAlertsClientId;
        youtubeClientId = msg.payload.youtubeClientId;
        youtubeVideoId = msg.payload.youtubeVideoId;
        twitchEnabled = msg.payload.twitchEnabled !== false;
        donationAlertsEnabled = msg.payload.donationAlertsEnabled !== false;
        youtubeEnabled = msg.payload.youtubeEnabled !== false;
        connectionStatus = msg.payload.connectionStatus || {};
        appearance = msg.payload.appearance || appearance;
        editorPrefs = msg.payload.editor || editorPrefs;
        scenes = msg.payload.scenes || scenes;
        topDonation = msg.payload.topDonation || topDonation;
        stats = msg.payload.stats || stats;
        giveaway = msg.payload.giveaway || giveaway;
        gridSizeSelect.value = String(editorPrefs.gridSize || 0);
        applyThemeToCanvas(appearance.tokens);
        applyGridToCanvas();
        renderThemeGrid();
        renderLibrary();
        renderCanvas();
        renderLayers();
        renderProperties();
        renderStatusChips();
        updateSettingsChips();
        populateSettings();
        syncIntegrationSwitches();
        renderGiveaway();
        selectScene(activeSceneId);
        break;
      case EVENT_TYPES.LAYOUT_UPDATE:
        handleLayoutUpdate(msg.payload.layout || []);
        break;
      case EVENT_TYPES.THEME_UPDATE:
        appearance = msg.payload;
        if (!editingThemeId) applyThemeToCanvas(appearance.tokens);
        renderThemeGrid();
        renderCanvas();
        break;
      case EVENT_TYPES.EDITOR_PREFS_UPDATE:
        editorPrefs = msg.payload;
        gridSizeSelect.value = String(editorPrefs.gridSize || 0);
        applyGridToCanvas();
        break;
      case EVENT_TYPES.SCENES_UPDATE:
        scenes = msg.payload;
        renderSceneForm();
        break;
      case EVENT_TYPES.TOP_DONATION_UPDATE:
        topDonation = msg.payload;
        renderSceneForm();
        renderCanvas();
        break;
      case EVENT_TYPES.STAT_UPDATE:
        stats = msg.payload;
        renderCanvas();
        break;
      case EVENT_TYPES.GIVEAWAY_UPDATE:
        giveaway = msg.payload.giveaway || giveaway;
        renderGiveaway();
        break;
      case EVENT_TYPES.OVERLAY_PARTICIPANTS_CONFIG:
        participantsConfig = (msg.payload && msg.payload.config) || participantsConfig;
        renderCanvas();
        renderProperties();
        if (activeSceneId === "wheel") renderSceneForm();
        break;
      case EVENT_TYPES.WHEEL_CONFIG:
        wheelConfig = (msg.payload && msg.payload.config) || wheelConfig;
        if (activeSceneId === "wheel") renderSceneForm();
        break;
      case EVENT_TYPES.WHEEL_SPEED_CONFIG:
        wheelSpeedConfig = (msg.payload && msg.payload.config) || wheelSpeedConfig;
        if (activeSceneId === "wheel") renderSceneForm();
        break;
      case EVENT_TYPES.OVERLAY_MIC_CONFIG:
        micConfig = (msg.payload && msg.payload.config) || micConfig;
        renderCanvas();
        renderProperties();
        break;
      case EVENT_TYPES.GOAL_UPDATE:
        goal = msg.payload;
        renderCanvas();
        renderProperties();
        break;
      case EVENT_TYPES.CONNECTION_STATUS:
        connectionStatus[msg.payload.service] = msg.payload.status;
        renderStatusChips();
        updateSettingsChips();
        break;
      case EVENT_TYPES.LOCALES:
        applyLocales(msg.payload && msg.payload.lang, msg.payload && msg.payload.locales);
        break;
      case EVENT_TYPES.TERMINAL_LOG:
        appendTerminalLine(msg.payload);
        break;
      default:
        break; // ALERT / CHAT_MESSAGE / RECENT_EVENT are for the overlay, not the editor
    }
  }

  function updateLanguageButtons() {
    const lang = window.I18n ? window.I18n.getLang() : "en";
    document.querySelectorAll("#languageSwitcher [data-lang]").forEach((btn) => {
      const active = btn.dataset.lang === lang;
      btn.classList.toggle("md-button--filled", active);
      btn.classList.toggle("md-button--tonal", !active);
    });
  }

  function applyLocales(lang, locales) {
    if (window.I18n) {
      window.I18n.setLocales(locales);
      window.I18n.setLang(lang);
      window.I18n.apply();
    }
    updateLanguageButtons();
    renderLibrary();
    renderScenesNav();
    renderCanvas();
    renderLayers();
    renderProperties();
    renderSceneForm();
    renderGiveaway();
    renderStatusChips();
    updateSettingsChips();
    updateEventsFilterButtons();
    renderStreamEvents(true);
    copyUrlBtn.textContent = t("editor.copyUrl");
    copySceneUrlBtn.textContent = t("scenes.copyUrl");
    exportConfigBtn.textContent = t("settings.export");
    importConfigBtn.textContent = t("settings.import");
    const chatBtn = document.getElementById("openChatWindowBtn");
    if (chatBtn) chatBtn.innerHTML = `${ICONS.widgetChat} ${t("editor.chat")}`;
    if (toggleTerminalBtn) toggleTerminalBtn.innerHTML = `${ICONS.terminal} ${t("editor.terminal")}`;
    const boostyBtn = document.getElementById("openBoostyBtn");
    if (boostyBtn) boostyBtn.innerHTML = `${ICONS.heart} ${t("boosty.support")}`;
  }

  function handleLayoutUpdate(newLayout) {
    layout = newLayout;
    if (pendingAdd) {
      const newItem = layout.find((w) => !pendingAdd.knownIds.has(w.id));
      if (newItem) {
        if (pendingAdd.dropXY) {
          const x = clamp(pendingAdd.dropXY.x - newItem.w / 2, 0, 100 - newItem.w);
          const y = clamp(pendingAdd.dropXY.y - newItem.h / 2, 0, 100 - newItem.h);
          send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: newItem.id, patch: { x: round1(x), y: round1(y) } });
        }
        selectedId = newItem.id;
      }
      pendingAdd = null;
    }
    if (selectedId && !layout.find((w) => w.id === selectedId)) selectedId = null;
    renderCanvas();
    renderLayers();
    renderProperties();
  }

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onmessage = (ev) => {
      try {
        handleMessage(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws.close();
  }

  connect();
})();
