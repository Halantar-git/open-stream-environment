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
  Terminal/log panel for the control panel.

  Single responsibility: render `terminal_log` entries into the slide-out
  panel, handle auto-scroll (paused when the user scrolls up), the clear
  button and the 500-line DOM cap. It does not know anything about WebSocket,
  state or other views.
*/

import { el, on } from "./dom.js";

const MAX_LINES = 500;

export function initLoggerPanel({ t, ICONS }) {
  const panel = el("terminalPanel");
  const body = el("terminalBody");
  const toggleBtn = el("toggleTerminalBtn");

  let atBottom = true;

  function formatTime(ts) {
    const d = new Date(Number(ts) || Date.now());
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function serializeData(data) {
    if (data === null || data === undefined) return "";
    if (typeof data === "string") return data;
    try {
      const s = JSON.stringify(data);
      return s && s !== "{}" ? s : "";
    } catch {
      return String(data);
    }
  }

  function append(entry) {
    if (!body || !entry) return;

    const line = document.createElement("div");
    line.className = `terminal-line terminal-line--${entry.level || "info"}`;
    line.dataset.service = entry.service || "server";

    const time = document.createElement("span");
    time.className = "terminal-line__time";
    time.textContent = formatTime(entry.timestamp);

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

    const dataStr = serializeData(entry.data);
    if (dataStr) {
      const data = document.createElement("span");
      data.className = "terminal-line__data";
      data.textContent = dataStr;
      line.appendChild(document.createTextNode(" "));
      line.appendChild(data);
    }

    body.appendChild(line);
    while (body.children.length > MAX_LINES) {
      body.removeChild(body.firstChild);
    }

    if (atBottom) {
      body.scrollTop = body.scrollHeight;
    }
  }

  function setOpen(open) {
    if (!panel || !toggleBtn) return;
    panel.hidden = !open;
    toggleBtn.classList.toggle("is-active", open);
    if (open && body) body.scrollTop = body.scrollHeight;
  }

  function toggle() {
    setOpen(panel && panel.hidden);
  }

  function refreshLabel() {
    if (toggleBtn) toggleBtn.innerHTML = `${ICONS.terminal} ${t("editor.terminal")}`;
  }

  refreshLabel();

  if (toggleBtn) on("toggleTerminalBtn", "click", toggle);
  on("terminalCloseBtn", "click", () => setOpen(false));
  on("terminalClearBtn", "click", () => { if (body) body.innerHTML = ""; });

  if (body) {
    body.addEventListener("scroll", () => {
      atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    });
  }

  return { append, setOpen, toggle, refreshLabel };
}
