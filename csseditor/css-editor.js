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
  Standalone CSS editor window for the custom theme — Notepad++-style chrome:
  toolbar (undo/redo/select all/clear/copy), find & replace, and a status bar.

  Edits are live-synced back to the theme editor in the control panel through
  the main process (`css-editor:update` → `css-editor:updated`).
*/

import { initCssEditor } from "../control/modules/css-editor.js";

async function init() {
  const initData = (await window.cssEditor.getInit()) || {};
  const strings = initData.strings || {};

  const t = (key, params) => {
    if (key === "themeEditor.cssIssueSyntax") return strings.syntax || key;
    if (key === "themeEditor.cssIssueUnknownProperty") return (strings.unknownProp || key).replace("%s", (params && params.name) || "");
    if (key === "themeEditor.cssIssueInvalidValue") return (strings.invalidValue || key).replace("%s", (params && params.value) || "");
    if (key === "themeEditor.cssLine") return strings.line || key;
    return key;
  };

  if (strings.title) {
    document.title = strings.title;
    document.getElementById("titleLabel").textContent = strings.title;
  }
  document.getElementById("doneBtn").textContent = strings.done || "Done";
  document.getElementById("undoBtn").title = strings.undo || "Undo";
  document.getElementById("redoBtn").title = strings.redo || "Redo";
  document.getElementById("selectAllBtn").textContent = strings.selectAll || "Select all";
  document.getElementById("clearBtn").textContent = strings.clear || "Clear";
  document.getElementById("copyBtn").textContent = strings.copy || "Copy";
  document.getElementById("findBtn").textContent = strings.find || "Find";
  document.getElementById("replaceBtn").textContent = strings.replace || "Replace";
  document.getElementById("findInput").placeholder = strings.findPlaceholder || "Find…";
  document.getElementById("replaceInput").placeholder = strings.replacePlaceholder || "Replace with…";
  document.getElementById("replaceOneBtn").textContent = strings.replaceOne || "Replace";
  document.getElementById("replaceAllBtn").textContent = strings.replaceAll || "Replace all";
  document.getElementById("closeFindBtn").title = strings.close || "Close";

  const editor = initCssEditor({
    container: document.getElementById("editorWrap"),
    initialValue: initData.css || "",
    tokens: initData.tokens || [],
    selectors: initData.selectors || [],
    id: "cssEditorTextarea",
    t,
  });

  // Reopening the editor for another theme pushes fresh content here.
  window.cssEditor.onInit((data) => {
    if (data && typeof data.css === "string") editor.setValue(data.css);
  });

  const statusLabel = document.getElementById("statusLabel");
  const posLabel = document.getElementById("posLabel");
  const countLabel = document.getElementById("countLabel");
  const findBar = document.getElementById("findBar");
  const findInput = document.getElementById("findInput");
  const replaceInput = document.getElementById("replaceInput");
  const doneBtn = document.getElementById("doneBtn");

  let syncTimer = null;
  const flush = () => window.cssEditor.update(editor.getValue());
  const scheduleSync = () => {
    statusLabel.textContent = "";
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      flush();
      statusLabel.textContent = strings.synced || "";
    }, 200);
  };

  function updateStatus() {
    const val = editor.getValue();
    const pos = editor.textarea.selectionStart;
    const before = val.slice(0, pos);
    const lines = before.split("\n");
    posLabel.textContent = `${strings.line || "Line"} ${lines.length}, ${strings.column || "column"} ${lines[lines.length - 1].length + 1}`;
    countLabel.textContent = `${val.length} ${strings.chars || "chars"}`;
  }

  editor.textarea.addEventListener("input", () => {
    scheduleSync();
    updateStatus();
  });
  editor.textarea.addEventListener("keyup", () => {
    updateStatus();
    editor.highlightMatches(findInput.value);
  });
  editor.textarea.addEventListener("click", () => {
    updateStatus();
    editor.highlightMatches(findInput.value);
  });

  // Never lose the final edit when the window is closed mid-typing.
  window.addEventListener("beforeunload", flush);

  // ---- toolbar ----
  document.getElementById("undoBtn").addEventListener("click", () => {
    editor.textarea.focus();
    document.execCommand("undo");
    updateStatus();
  });
  document.getElementById("redoBtn").addEventListener("click", () => {
    editor.textarea.focus();
    document.execCommand("redo");
    updateStatus();
  });
  document.getElementById("selectAllBtn").addEventListener("click", () => {
    editor.textarea.focus();
    editor.textarea.select();
    updateStatus();
  });
  document.getElementById("clearBtn").addEventListener("click", () => {
    editor.setValue("");
    editor.textarea.dispatchEvent(new Event("input", { bubbles: true }));
    editor.textarea.focus();
    updateStatus();
  });
  document.getElementById("copyBtn").addEventListener("click", () => {
    if (navigator.clipboard) navigator.clipboard.writeText(editor.getValue());
  });

  // ---- find & replace ----
  document.getElementById("findBtn").addEventListener("click", () => {
    findBar.hidden = false;
    findInput.focus();
  });
  document.getElementById("replaceBtn").addEventListener("click", () => {
    findBar.hidden = false;
    findInput.focus();
  });
  document.getElementById("closeFindBtn").addEventListener("click", () => {
    findBar.hidden = true;
    editor.highlightMatches("");
    editor.textarea.focus();
  });
  findInput.addEventListener("input", () => editor.highlightMatches(findInput.value));

  function findMatch(query, dir) {
    const q = String(query || "");
    if (!q) return false;
    const val = editor.getValue();
    const lower = val.toLowerCase();
    const needle = q.toLowerCase();
    let idx;
    if (dir === -1) {
      idx = lower.lastIndexOf(needle, editor.textarea.selectionStart - 1);
      if (idx === -1) idx = lower.lastIndexOf(needle);
    } else {
      idx = lower.indexOf(needle, editor.textarea.selectionEnd);
      if (idx === -1) idx = lower.indexOf(needle);
    }
    if (idx === -1) return false;

    editor.textarea.focus();
    editor.textarea.setSelectionRange(idx, idx + needle.length);
    const lineHeight = parseFloat(getComputedStyle(editor.textarea).lineHeight) || 18;
    const line = val.slice(0, idx).split("\n").length;
    editor.textarea.scrollTop = Math.max(0, (line - 1) * lineHeight);
    updateStatus();
    editor.highlightMatches(findInput.value);
    return true;
  }

  function replaceOne() {
    const q = findInput.value;
    if (!q) return;
    const selected = editor.getValue().slice(editor.textarea.selectionStart, editor.textarea.selectionEnd);
    if (selected.toLowerCase() !== q.toLowerCase()) {
      if (!findMatch(q, 1)) return;
    }
    editor.textarea.focus();
    document.execCommand("insertText", false, replaceInput.value);
    updateStatus();
  }

  function replaceAll() {
    const q = findInput.value;
    if (!q) return;
    const rep = replaceInput.value;
    const val = editor.getValue();
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const next = val.replace(new RegExp(escaped, "gi"), rep);
    if (next !== val) {
      editor.setValue(next);
      editor.textarea.dispatchEvent(new Event("input", { bubbles: true }));
      updateStatus();
    }
  }

  document.getElementById("findPrevBtn").addEventListener("click", () => findMatch(findInput.value, -1));
  document.getElementById("findNextBtn").addEventListener("click", () => findMatch(findInput.value, 1));
  document.getElementById("replaceOneBtn").addEventListener("click", replaceOne);
  document.getElementById("replaceAllBtn").addEventListener("click", replaceAll);
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      findMatch(findInput.value, e.shiftKey ? -1 : 1);
    }
  });

  doneBtn.addEventListener("click", () => {
    flush();
    window.cssEditor.close();
  });

  updateStatus();
}

init();
