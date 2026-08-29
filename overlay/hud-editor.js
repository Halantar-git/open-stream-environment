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
  HUD edit mode — direct manipulation of widgets inside the game overlay
  window (WoW-style addon layout). Active only while the Electron window is
  in edit mode (`#canvas.is-editing`); during normal play the window is
  click-through and this module does nothing, so it costs 0 CPU/GPU.

  Geometry contract: widgets are stored in percent of the canvas (0-100),
  but snapping works in device pixels because the overlay window is sized to
  the game monitor. We convert px <-> % on the fly.

  The resize handle lives as a sibling of each widget inside #canvas (not as
  a child), so it also works for <canvas> / 3D widgets whose element cannot
  render child nodes. Handles are kept in sync through the WidgetManager
  mount/update/unmount hooks, so widgets added/removed from the control panel
  while editing get a handle on the fly.

  Every widget in the layout is made visible while editing: hidden widgets
  (visible:false) are ghosted, and widgets that are not mounted at all
  (theme/service-gated) get a placeholder "ghost" frame with a type label.

  Snap math is exposed as `OSEWidgets.HudEditor.snap` so the frontend widget
  manager (and future tools) can reuse the same grid without duplicating
  constants.
*/
(function (root) {
  "use strict";

  const GRID_SIZE = 20; // px — snap step inside the HUD window
  const HANDLE_SIZE = 14; // px — corner handle footprint

  // Snap a raw pixel coordinate to the nearest grid line.
  function snap(raw) {
    return Math.round(raw / GRID_SIZE) * GRID_SIZE;
  }

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
  const pxToPercent = (px, total) => (total ? (px / total) * 100 : 0);
  const percentToPx = (pct, total) => (pct / 100) * total;

  let opts = null;
  let enabled = false;
  const handles = new Map(); // widget id -> scale handle element
  const ghosts = new Map(); // widget id -> placeholder frame (unmounted widgets)

  function layoutItems() {
    return opts && opts.getLayout ? opts.getLayout() : [];
  }

  function itemById(id) {
    return layoutItems().find((w) => String(w.id) === String(id));
  }

  function commit() {
    if (opts && opts.send) opts.send(opts.EVENT_TYPES.CMD_SAVE_LAYOUT, { layout: layoutItems() });
  }

  // ---- handles (resize) ----

  function positionHandle(inst) {
    const handle = handles.get(String(inst.id));
    if (!handle || !inst.element) return;
    const r = inst.element.getBoundingClientRect();
    handle.style.left = r.right - HANDLE_SIZE / 2 + "px";
    handle.style.top = r.bottom - HANDLE_SIZE / 2 + "px";
  }

  function ensureHandle(inst) {
    if (!enabled || !inst || !inst.element || !opts || !opts.canvas) return;
    const key = String(inst.id);
    let handle = handles.get(key);
    if (!handle) {
      handle = document.createElement("div");
      handle.className = "scale-handle";
      handle.dataset.id = inst.id || "";
      opts.canvas.appendChild(handle);
      handles.set(key, handle);
    }
    positionHandle(inst);
  }

  function removeHandle(id) {
    const handle = handles.get(String(id));
    if (handle) {
      handle.remove();
      handles.delete(String(id));
    }
  }

  function clearHandles() {
    for (const [, handle] of handles) handle.remove();
    handles.clear();
  }

  // ---- ghosts (unmounted / hidden widgets) ----

  function applyVisibility(inst) {
    if (inst && inst.element) {
      inst.element.classList.toggle("is-hidden", inst.geometry.visible === false);
    }
  }

  function ensureGhost(item) {
    const canvas = opts && opts.canvas;
    if (!canvas || !item || item.id == null) return;
    const key = String(item.id);
    let ghost = ghosts.get(key);
    if (!ghost) {
      ghost = document.createElement("div");
      ghost.className = "widget-instance widget-instance--ghost";
      ghost.dataset.type = item.type || "";
      ghost.dataset.id = key;
      canvas.appendChild(ghost);
      ghosts.set(key, ghost);
    }
    const s = ghost.style;
    s.position = "absolute";
    s.left = (item.x || 0) + "%";
    s.top = (item.y || 0) + "%";
    s.width = (item.w || 10) + "%";
    s.height = (item.h || 10) + "%";
    s.zIndex = "1";
  }

  function removeGhost(id) {
    const ghost = ghosts.get(String(id));
    if (ghost) {
      ghost.remove();
      ghosts.delete(String(id));
    }
  }

  function shouldGhost(item) {
    return opts && opts.shouldGhost ? !!opts.shouldGhost(item) : false;
  }

  function clearGhosts() {
    for (const [, ghost] of ghosts) ghost.remove();
    ghosts.clear();
  }

  // Reconcile visibility: mark mounted-but-hidden widgets, and create a ghost
  // frame only for theme-gated widgets that have no mounted instance.
  function syncGhostsAndVisibility() {
    if (!enabled || !opts || !opts.manager) return;

    for (const [, inst] of opts.manager.instances) applyVisibility(inst);

    const mounted = new Set([...opts.manager.instances.keys()].map(String));
    for (const item of layoutItems()) {
      const id = String(item.id);
      if (mounted.has(id)) removeGhost(id);
      else if (shouldGhost(item)) ensureGhost(item);
      else removeGhost(id);
    }
    for (const id of [...ghosts.keys()]) {
      if (!itemById(id)) removeGhost(id);
    }
  }

  function scanHandles() {
    const manager = opts && opts.manager;
    if (!manager) return;
    for (const [, inst] of manager.instances) {
      ensureHandle(inst);
      applyVisibility(inst);
    }
  }

  // Full reconciliation of handles, visibility and ghosts. Called on enter and
  // after every layout/theme sync (see overlay.js) so a theme switch can't
  // leave stale ghosts behind.
  function refresh() {
    if (!enabled) return;
    scanHandles();
    syncGhostsAndVisibility();
  }

  function setEnabled(next) {
    next = !!next;
    if (next === enabled) return;
    enabled = next;
    const canvas = opts && opts.canvas;
    if (!canvas) return;
    canvas.classList.toggle("is-editing", enabled);
    document.body.classList.toggle("is-editing", enabled);
    if (enabled) {
      scanHandles();
      syncGhostsAndVisibility();
    } else {
      clearHandles();
      clearGhosts();
    }
  }

  // ---- drag / resize ----

  function startDrag(ev, el, inst) {
    const rect = el.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const left = rect.left;
    const top = rect.top;
    const width = rect.width;
    const height = rect.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    el.setPointerCapture(ev.pointerId);
    el.classList.add("is-dragging");

    const onMove = (e) => {
      const sx = clamp(snap(left + (e.clientX - startX)), 0, vw - width);
      const sy = clamp(snap(top + (e.clientY - startY)), 0, vh - height);
      el.style.left = pxToPercent(sx, vw) + "%";
      el.style.top = pxToPercent(sy, vh) + "%";
      const item = itemById(inst.id);
      if (item) {
        item.x = pxToPercent(sx, vw);
        item.y = pxToPercent(sy, vh);
      }
      positionHandle(inst);
    };

    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.classList.remove("is-dragging");
      commit();
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  function startResize(ev, el, inst) {
    const rect = el.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const left = rect.left;
    const top = rect.top;
    const startW = rect.width;
    const startH = rect.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minW = 40; // px — sanity floor so a widget can't collapse to nothing
    const minH = 24;
    el.setPointerCapture(ev.pointerId);
    el.classList.add("is-resizing");

    const onMove = (e) => {
      const w = clamp(snap(startW + (e.clientX - startX)), minW, vw - left);
      const h = clamp(snap(startH + (e.clientY - startY)), minH, vh - top);
      el.style.width = pxToPercent(w, vw) + "%";
      el.style.height = pxToPercent(h, vh) + "%";
      const item = itemById(inst.id);
      if (item) {
        item.w = pxToPercent(w, vw);
        item.h = pxToPercent(h, vh);
      }
      positionHandle(inst);
    };

    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.classList.remove("is-resizing");
      commit();
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  function onPointerDown(ev) {
    if (!enabled || !opts) return;
    const handle = ev.target.closest(".scale-handle");
    const instEl = handle
      ? (opts.manager && opts.manager.get(handle.dataset.id)
          ? opts.manager.get(handle.dataset.id).element
          : null)
      : ev.target.closest(".widget-instance");
    if (!instEl || !opts.canvas.contains(instEl)) return;
    const inst = opts.manager ? opts.manager.get(instEl.dataset.id) : null;
    if (!inst) return;
    ev.preventDefault();
    if (handle) startResize(ev, instEl, inst);
    else startDrag(ev, instEl, inst);
  }

  function init(options) {
    opts = options || {};
    if (opts.canvas) opts.canvas.addEventListener("pointerdown", onPointerDown);
    installHooks();
  }

  // Keep handles and ghosts in sync with widgets mounted/updated/unmounted by
  // the manager, chaining any hooks the composition root may have set.
  function installHooks() {
    const manager = opts && opts.manager;
    if (!manager) return;
    const hooks = manager.hooks || (manager.hooks = {});
    const prevMount = hooks.mount;
    const prevUpdate = hooks.update;
    const prevUnmount = hooks.unmount;
    hooks.mount = (inst, item) => {
      if (prevMount) prevMount(inst, item);
      ensureHandle(inst);
      applyVisibility(inst);
      removeGhost(inst && inst.id);
    };
    hooks.update = (inst, item) => {
      if (prevUpdate) prevUpdate(inst, item);
      ensureHandle(inst);
      applyVisibility(inst);
    };
    hooks.unmount = (inst) => {
      removeHandle(inst && inst.id);
      const id = inst && inst.id;
      const item = id != null ? itemById(id) : null;
      // Theme-gated widgets stay in the layout but lose their element:
      // replace them with a ghost frame. Service-disabled widgets stay hidden.
      if (item && shouldGhost(item)) ensureGhost(item);
      else removeGhost(id);
      if (prevUnmount) prevUnmount(inst);
    };
  }

  root.OSEWidgets = root.OSEWidgets || {};
  root.OSEWidgets.HudEditor = {
    init,
    setEnabled,
    refresh,
    snap,
    GRID_SIZE,
    pxToPercent,
    percentToPx,
  };
})(typeof window !== "undefined" ? window : globalThis);
