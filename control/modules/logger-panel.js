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
  Terminal / log panel + interactive CLI console for the control panel.

  Single responsibility: render `terminal_log` entries into the slide-out
  panel, handle auto-scroll, the clear button, the 500-line DOM cap, and the
  command input (Enter submit, ArrowUp/Down history, Tab autocompletion with
  a live ghost preview). Tab requests authoritative completions from the
  server via `exec_cli_completion` and receives `cli_completions` in return.
*/

import { el, on } from "./dom.js";

const MAX_LINES = 500;
const HISTORY_LIMIT = 100;

const COMMANDS = [
  "scene", "cam", "filter", "sound", "death", "wheel", "giveaway",
  "sim", "alert", "chat", "theme", "themes", "goal", "obs",
  "sounds", "cameras", "filters", "logs", "media", "lang", "status", "clear", "help",
];

const SUBCOMMANDS = {
  sim: ["sub", "points", "raid"],
  wheel: ["spin", "generate", "reset", "clear"],
  giveaway: ["start", "stop", "add", "remove", "shuffle", "elimination", "list"],
  death: ["+1", "-1", "set", "reset"],
  goal: ["add"],
  lang: ["ru", "en"],
  alert: ["follow", "sub", "gift_sub", "cheer", "donation"],
  logs: ["info", "success", "warn", "error", "hint", "all"],
  media: ["list", "cleanup"],
};

function commonPrefix(strings) {
  if (!strings.length) return "";
  let p = strings[0];
  for (const s of strings.slice(1)) {
    while (p && !s.startsWith(p)) p = p.slice(0, -1);
  }
  return p;
}

export function initLoggerPanel({ t, ICONS, send, EVENT_TYPES, state }) {
  const panel = el("terminalPanel");
  const body = el("terminalBody");
  const toggleBtn = el("toggleTerminalBtn");
  const input = el("terminalInput");
  const ghost = el("terminalGhost");
  const search = el("terminalSearch");

  let atBottom = true;
  let history = [];
  let historyIndex = -1;
  let pendingCompletion = null;
  let filterLevel = "all";
  let searchTerm = "";

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
    line.dataset.level = entry.level || "info";

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

    if (!lineMatches(line)) {
      line.hidden = true;
    }

    body.appendChild(line);
    while (body.children.length > MAX_LINES) {
      body.removeChild(body.firstChild);
    }

    if (atBottom) {
      body.scrollTop = body.scrollHeight;
    }
  }

  function clear() {
    if (body) body.innerHTML = "";
  }

  function lineMatches(line) {
    const levelOk = filterLevel === "all" || line.dataset.level === filterLevel;
    const textOk = !searchTerm || line.textContent.toLowerCase().includes(searchTerm);
    return levelOk && textOk;
  }

  function applyFilter() {
    if (!body) return;
    Array.from(body.children).forEach((line) => {
      line.hidden = !lineMatches(line);
    });
  }

  function setFilter(level) {
    filterLevel = typeof level === "string" ? level : "all";
    applyFilter();
  }

  function setSearch(term) {
    searchTerm = String(term || "").toLowerCase();
    applyFilter();
  }

  function appendHint(options) {
    append({ timestamp: Date.now(), service: "CLI", level: "hint", message: `Доступные варианты: ${options.join("  ")}` });
  }

  function setGhost(text) {
    if (ghost) ghost.textContent = text || "";
  }

  // Local completions mirror the server `getCompletions` so the live ghost
  // preview can render instantly while typing (no network round-trip).
  function argListFor(cmd) {
    switch (cmd) {
      case "scene":
        return Object.keys((state.obs && state.obs.sceneMap) || {});
      case "sound":
        return ((state.soundboard && state.soundboard.sounds) || []).map((s) => s.id);
      case "cam":
        return ((state.obs && state.obs.cameraAngles) || []).map((a) => a.id);
      case "filter":
        return ((state.obs && state.obs.cameraFilters) || []).map((f) => f.id);
      case "theme":
        return ((state.appearance && state.appearance.themes) || []).map((t) => t.id);
      case "obs":
        return ["list", ...((state.obs && state.obs.customCommands) || []).map((c) => c.id)];
      default:
        return null;
    }
  }

  function localCompletions(value) {
    const input = String(value || "");
    const trimmed = input.replace(/^\s+/, "");
    const endsWithSpace = /\s$/.test(trimmed);
    const parts = trimmed.split(/\s+/).filter(Boolean);

    if (!parts.length || (parts.length === 1 && !endsWithSpace)) {
      const prefix = (parts[0] || "").toLowerCase();
      return COMMANDS.filter((c) => c.startsWith(prefix)).map((c) => `${c} `);
    }

    const cmd = parts[0].toLowerCase();

    if (SUBCOMMANDS[cmd]) {
      if (parts.length === 1 && endsWithSpace) {
        return SUBCOMMANDS[cmd].map((s) => `${cmd} ${s} `);
      }
      if (parts.length === 2 && !endsWithSpace) {
        const prefix = parts[1].toLowerCase();
        return SUBCOMMANDS[cmd].filter((s) => s.toLowerCase().startsWith(prefix)).map((s) => `${cmd} ${s} `);
      }
      return [];
    }

    const list = argListFor(cmd);
    if (list) {
      if (parts.length === 1 && endsWithSpace) {
        return list.map((x) => `${cmd} ${x} `);
      }
      if (parts.length === 2 && !endsWithSpace) {
        const prefix = parts[1].toLowerCase();
        return list.filter((x) => String(x).toLowerCase().startsWith(prefix)).map((x) => `${cmd} ${x} `);
      }
    }

    return [];
  }

  function updateGhost() {
    if (!input || !ghost) return;
    const list = localCompletions(input.value);
    setGhost(list.length === 1 ? list[0] : commonPrefix(list));
  }

  function applyCompletions({ input: requestedInput, completions }) {
    if (!input) return;
    if (requestedInput !== pendingCompletion) return; // stale response
    pendingCompletion = null;

    const list = Array.isArray(completions) ? completions : [];
    if (!list.length) {
      setGhost("");
      return;
    }
    if (list.length === 1) {
      input.value = list[0];
      setGhost("");
      moveCaretToEnd();
      return;
    }

    const prefix = commonPrefix(list);
    if (prefix.length > input.value.length) {
      input.value = prefix;
      moveCaretToEnd();
    }
    const options = list.map((c) => c.trim().split(/\s+/).pop()).filter(Boolean);
    appendHint(options);
    setGhost(prefix);
  }

  function moveCaretToEnd() {
    if (!input) return;
    try {
      input.setSelectionRange(input.value.length, input.value.length);
    } catch {
      /* ignore */
    }
  }

  function setOpen(open) {
    if (!panel || !toggleBtn) return;
    panel.hidden = !open;
    toggleBtn.classList.toggle("is-active", open);
    if (open && body) body.scrollTop = body.scrollHeight;
    if (open && input) input.focus();
  }

  function toggle() {
    setOpen(panel && panel.hidden);
  }

  function refreshLabel() {
    if (toggleBtn) toggleBtn.innerHTML = `${ICONS.terminal} ${t("editor.terminal")}`;
    if (input) input.placeholder = t("terminal.inputPlaceholder");
  }

  function submitCommand() {
    if (!input) return;
    const value = input.value.trim();
    if (!value) return;
    history.push(value);
    if (history.length > HISTORY_LIMIT) history.shift();
    historyIndex = -1;
    input.value = "";
    setGhost("");
    if (send && EVENT_TYPES) send(EVENT_TYPES.EXEC_CLI_COMMAND, { command: value });
  }

  function requestCompletion() {
    if (!input || !send || !EVENT_TYPES) return;
    pendingCompletion = input.value;
    send(EVENT_TYPES.EXEC_CLI_COMPLETION, { input: input.value });
  }

  refreshLabel();

  on("terminalCloseBtn", "click", () => setOpen(false));
  on("terminalClearBtn", "click", clear);

  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitCommand();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!history.length) return;
        if (historyIndex < 0) historyIndex = history.length - 1;
        else historyIndex = Math.max(0, historyIndex - 1);
        input.value = history[historyIndex] || "";
        moveCaretToEnd();
        setGhost("");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!history.length) return;
        if (historyIndex < 0) return;
        if (historyIndex >= history.length - 1) {
          historyIndex = -1;
          input.value = "";
        } else {
          historyIndex += 1;
          input.value = history[historyIndex] || "";
        }
        moveCaretToEnd();
        setGhost("");
      } else if (e.key === "Tab") {
        e.preventDefault();
        requestCompletion();
      }
    });

    input.addEventListener("input", updateGhost);
  }

  if (search) {
    search.addEventListener("input", () => setSearch(search.value));
  }

  if (body) {
    body.addEventListener("scroll", () => {
      atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    });
  }

  return { append, setOpen, toggle, refreshLabel, clear, applyCompletions, setFilter, setSearch };
}
