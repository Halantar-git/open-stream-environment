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
  const t = (key, params) => (window.I18n ? window.I18n.t(key, params) : key);
  const params = new URLSearchParams(location.search);
  const port = params.get("port") || "8710";
  const widgetId = params.get("widgetId");

  let ws;
  let loaded = false;
  let widgetGone = false;
  let statusKind = null; // null | "saved" | "removed"

  const tabsEl = document.getElementById("tabs");
  const statusLabel = document.getElementById("statusLabel");
  const saveBtn = document.getElementById("saveBtn");
  const previewFrame = document.getElementById("previewFrame");
  const fields = {
    html: document.getElementById("codeHtml"),
    css: document.getElementById("codeCss"),
    js: document.getElementById("codeJs"),
  };

  tabsEl.querySelectorAll(".editor-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      tabsEl.querySelectorAll(".editor-tab").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      Object.entries(fields).forEach(([key, el]) => {
        el.hidden = key !== btn.dataset.tab;
      });
    });
  });

  function buildDocument() {
    return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#e8e1f0;font-family:sans-serif;}${fields.css.value}</style></head><body>${fields.html.value}<script>${fields.js.value}</script></body></html>`;
  }

  let previewTimer = null;
  function schedulePreviewUpdate() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewFrame.srcdoc = buildDocument();
    }, 300);
  }
  Object.values(fields).forEach((el) => el.addEventListener("input", schedulePreviewUpdate));

  function populateFrom(widget) {
    if (loaded) return; // don't clobber in-progress edits if the widget updates elsewhere
    loaded = true;
    const cfg = widget.config || {};
    fields.html.value = cfg.html || "";
    fields.css.value = cfg.css || "";
    fields.js.value = cfg.js || "";
    schedulePreviewUpdate();
    previewFrame.srcdoc = buildDocument();
  }

  function send(type, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
  }

  function renderStatus() {
    if (statusKind === "saved") statusLabel.textContent = t("widgetEditor.saved");
    else if (statusKind === "removed") statusLabel.textContent = t("widgetEditor.removed");
    else statusLabel.textContent = "";
  }

  saveBtn.addEventListener("click", () => {
    if (widgetGone) return;
    send(EVENT_TYPES.CMD_UPDATE_WIDGET, {
      id: widgetId,
      patch: { config: { mode: "html", html: fields.html.value, css: fields.css.value, js: fields.js.value } },
    });
    statusKind = "saved";
    renderStatus();
    setTimeout(() => {
      if (!widgetGone && statusKind === "saved") {
        statusKind = null;
        renderStatus();
      }
    }, 1500);
  });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      saveBtn.click();
    }
  });

  function handleMessage(msg) {
    if (msg.type === EVENT_TYPES.STATE) {
      const widget = (msg.payload.layout || []).find((w) => w.id === widgetId);
      if (widget) {
        populateFrom(widget);
      } else {
        widgetGone = true;
        statusKind = "removed";
        renderStatus();
        saveBtn.disabled = true;
      }
    } else if (msg.type === EVENT_TYPES.LAYOUT_UPDATE) {
      const stillExists = (msg.payload.layout || []).some((w) => w.id === widgetId);
      if (!stillExists && !widgetGone) {
        widgetGone = true;
        statusKind = "removed";
        renderStatus();
        saveBtn.disabled = true;
      }
    } else if (msg.type === EVENT_TYPES.LOCALES) {
      if (window.I18n) {
        window.I18n.setLocales(msg.payload && msg.payload.locales);
        window.I18n.setLang(msg.payload && msg.payload.lang);
        window.I18n.apply();
      }
      renderStatus();
    }
  }

  function connect() {
    ws = new WebSocket(`ws://localhost:${port}/ws`);
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
