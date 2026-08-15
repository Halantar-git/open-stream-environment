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
  Canvas editor for the overlay layout.

  Single responsibility: render the widget layout onto the editor canvas and
  own every canvas interaction — drag-and-drop from the library, drag/resize of
  placed widgets, selection, layers (z-order / visibility), the snap grid and
  the theme applied to the canvas preview. It also owns the widget preview HTML
  used inside the canvas boxes.

  It reads the live `state` object and delegates "the selection changed" to
  `onSelectionChange` so the properties inspector can stay decoupled.
*/

import { el } from "./dom.js";

export function initCanvasEditor({
  state,
  t,
  ICONS,
  WIDGET_TYPES,
  EVENT_TYPES,
  send,
  clamp,
  round1,
  escapeHtml,
  escapeAttr,
  formatMoney,
  currencySymbol,
  onSelectionChange,
}) {
  const canvasWrapEl = el("canvasWrap");
  const canvasEl = el("canvas");
  const layersEl = el("layers");
  const gridSizeSelect = el("gridSizeSelect");

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
        const pct = state.goal.target ? Math.min(100, Math.round((state.goal.current / state.goal.target) * 100)) : 0;
        return `<div class="widget-goal">
          <div class="widget-goal__row">
            <span class="widget-goal__title">${escapeHtml(state.goal.title || t("preview.goalTitle"))}</span>
            <span class="widget-goal__amounts"><b>${formatMoney(state.goal.current)}</b> / ${formatMoney(state.goal.target)} ${escapeHtml(currencySymbol(state.goal.currency))}</span>
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
            ? { icon: ICONS.sub, label: config.label || t("preview.subscribers"), value: state.stats.subscriberCount != null ? formatMoney(state.stats.subscriberCount) : "—" }
            : metric === "latestFollower"
            ? { icon: ICONS.follow, label: config.label || t("preview.latestFollower"), value: "star_gazer" }
            : metric === "latestSubscriber"
            ? { icon: ICONS.sub, label: config.label || t("preview.latestSubscriber"), value: "nova_viewer" }
            : metric === "topDonation"
            ? { icon: ICONS.donation, label: config.label || t("preview.topDonation"), value: state.topDonation.amount > 0 ? `${state.topDonation.user} (${formatMoney(state.topDonation.amount)} ${currencySymbol(state.topDonation.currency)})` : t("scene.notYet") }
            : { icon: ICONS.follow, label: config.label || t("preview.followers"), value: state.stats.followerCount != null ? formatMoney(state.stats.followerCount) : "—" };
        return `<div class="widget-stat"><div class="widget-stat__icon">${sample.icon}</div><div class="widget-stat__info"><span class="widget-stat__label">${escapeHtml(sample.label)}</span><span class="widget-stat__value">${escapeHtml(sample.value)}</span></div></div>`;
      }
      case "social": {
        const s = (config.socials || [])[0] || { platform: "TG", text: "t.me/your_channel" };
        return `<div class="widget-social"><div class="widget-social__content"><span class="widget-social__icon">${escapeHtml(s.platform)}</span><div class="widget-social__info"><span class="widget-social__platform">${escapeHtml(s.platform)}</span><span class="widget-social__handle">${escapeHtml(s.text)}</span></div></div></div>`;
      }
      case "participants": {
        const names = ["viewer_1", "viewer_2", "viewer_3", "viewer_4"].slice(0, Math.max(1, Number(state.participantsConfig.maxNames) || 10));
        const chips = names.map((n) => `<span class="widget-participants__chip">${escapeHtml(n)}</span>`).join("");
        const style = `--pw-font-size:${state.participantsConfig.fontSize ?? 16}px;--pw-text:${escapeAttr(state.participantsConfig.textColor || "#e8e1f0")};--pw-bg-opacity:${state.participantsConfig.backgroundOpacity ?? 82}%;`;
        return `<div class="widget-participants" style="${style}">
          <div class="widget-participants__title">${t("wheelScene.participantsTitle", { count: 4 })}</div>
          <div class="widget-participants__list">${chips}</div>
        </div>`;
      }
      case "mic": {
        const color = state.micConfig.color || "#0060A8";
        const opacity = state.micConfig.opacity ?? 0.9;
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
            <path d="${d}" fill="none" stroke="${escapeAttr(color)}" stroke-width="${state.micConfig.lineWidth || 2}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
          </svg>
        </div>`;
      }
      case "death": {
        const label = config.label || t("preview.death");
        const color = config.color || "#ff4d4d";
        return `<div class="widget-death"><div class="widget-death__label">${escapeHtml(label)}</div><div class="widget-death__value" style="color:${escapeAttr(color)}">${state.deathCount ?? 0}</div></div>`;
      }
      default:
        return "";
    }
  }

  // ---- canvas render + drag/resize ----
  function renderCanvas() {
    canvasEl.innerHTML = "";
    [...state.layout]
      .sort((a, b) => (a.z || 0) - (b.z || 0))
      .forEach((inst) => {
        const box = document.createElement("div");
        box.className = "canvas-widget" + (inst.id === state.selectedId ? " is-selected" : "");
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
      el.classList.toggle("is-selected", el.dataset.id === state.selectedId);
    });
  }

  function selectWidget(id) {
    state.selectedId = id;
    applySelectionClasses();
    renderLayers();
    onSelectionChange();
  }

  function addWidget(type, dropXY) {
    state.pendingAdd = { knownIds: new Set(state.layout.map((w) => w.id)), dropXY };
    send(EVENT_TYPES.CMD_ADD_WIDGET, { type });
  }

  // ---- theme + grid (canvas preview only — app chrome stays fixed Nebula) ----
  function applyThemeToCanvas(tokens) {
    if (!tokens) return;
    Object.entries(tokens).forEach(([k, v]) => canvasEl.style.setProperty(k, v));
    canvasEl.dataset.decoration = tokens["--panel-decoration"] || "none";
  }

  function applyGridToCanvas() {
    const size = state.editorPrefs.gridSize || 0;
    canvasEl.classList.toggle("show-grid", size > 0);
    if (size > 0) {
      canvasEl.style.setProperty("--grid-x", (size / 100) * 960 + "px");
      canvasEl.style.setProperty("--grid-y", (size / 100) * 540 + "px");
    }
  }

  function snapValue(v) {
    const size = state.editorPrefs.gridSize;
    if (!state.editorPrefs.snapEnabled || !size) return v;
    return Math.round(v / size) * size;
  }

  function attachDragHandlers(boxEl, inst) {
    boxEl.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".resize-handle")) return;
      e.preventDefault();
      selectWidget(inst.id);
      const canvasRect = canvasEl.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const cur = state.layout.find((w) => w.id === inst.id) || inst;
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
        const cur = state.layout.find((w) => w.id === inst.id) || inst;
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

  // ---- layers panel ----
  function renderLayers() {
    if (!state.layout.length) {
      layersEl.innerHTML = `<div class="layers__empty">${t("editor.layersEmpty")}</div>`;
      return;
    }
    layersEl.innerHTML = "";
    [...state.layout]
      .sort((a, b) => (b.z || 0) - (a.z || 0))
      .forEach((inst) => {
        const def = WIDGET_TYPES[inst.type] || {};
        const row = document.createElement("div");
        row.className = "layer-row" + (inst.id === state.selectedId ? " is-selected" : "");
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

  // ---- event wiring ----
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

  gridSizeSelect.addEventListener("change", () => {
    const size = Number(gridSizeSelect.value);
    send(EVENT_TYPES.CMD_SET_EDITOR_PREFS, { gridSize: size, snapEnabled: size > 0 });
  });

  canvasEl.addEventListener("pointerdown", (e) => {
    if (e.target === canvasEl) selectWidget(null);
  });

  document.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId && document.activeElement.tagName !== "INPUT") {
      send(EVENT_TYPES.CMD_REMOVE_WIDGET, { id: state.selectedId });
      state.selectedId = null;
    }
  });

  return { addWidget, renderCanvas, renderLayers, applyThemeToCanvas, applyGridToCanvas };
}
