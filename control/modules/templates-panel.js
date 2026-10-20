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
  Панель «Шаблоны»: сохранённые текстовые заготовки для новостной ленты.

  Это простые фразы, которые стример пишет заранее и потом отправляет в ленту
  или в срочную полосу одной кнопкой — без набора текста в эфире. Список живёт
  в настройках приложения, поэтому панель не зависит от того, выбран ли виджет
  на холсте.
*/

import { el, on } from "./dom.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

// Дублируем ограничение сервера: список не должен расти бесконечно, а строка —
// съедать ленту целиком.
const MAX_MESSAGES = 20;
const MAX_LENGTH = 200;

export function initTemplatesPanel({ t, ICONS, send, EVENT_TYPES, state }) {
  const panel = el("templatesPanel");
  const body = el("templatesBody");
  const toggleBtn = el("toggleTemplatesBtn");
  const newInput = el("templatesNewText");
  const statusEl = el("templatesStatus");
  let statusTimer = 0;

  function messages() {
    return Array.isArray(state.tickerMessages) ? state.tickerMessages.slice() : [];
  }

  function setStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusEl.textContent = "";
      statusTimer = 0;
    }, 1600);
  }

  // Сохранение без перерисовки списка: `change` приходит при уходе из поля, и
  // пересборка DOM украла бы фокус у следующего элемента.
  function save(next) {
    state.tickerMessages = next;
    send(EVENT_TYPES.CMD_SET_APP_CONFIG, { tickerMessages: next });
  }

  function sendToTicker(text, priority) {
    const value = String(text || "").trim().slice(0, MAX_LENGTH);
    if (!value) return;
    send(EVENT_TYPES.CMD_TICKER_MESSAGE, { text: value, priority });
    setStatus(priority === "breaking" ? t("templates.sentBreaking") : t("templates.sentTicker"));
  }

  function rowHtml(text, index) {
    const value = escapeHtml(text);
    return `<div class="templates-row">
      <input class="templates-field__input" type="text" data-message="${index}" value="${value}" maxlength="${MAX_LENGTH}" autocomplete="off" spellcheck="false">
      <button class="terminal-panel__btn templates-row__btn" type="button" data-send="${index}" data-priority="normal">${escapeHtml(t("templates.sendTicker"))}</button>
      <button class="terminal-panel__btn templates-row__btn" type="button" data-send="${index}" data-priority="breaking">${escapeHtml(t("templates.sendBreaking"))}</button>
      <button class="terminal-panel__btn templates-row__btn" type="button" data-remove="${index}" title="${escapeHtml(t("templates.remove"))}">×</button>
    </div>`;
  }

  function render() {
    if (!body) return;
    const list = messages();
    const rows = list.length
      ? list.map(rowHtml).join("")
      : `<p class="templates-hint">${escapeHtml(t("templates.empty"))}</p>`;
    body.innerHTML = `<p class="templates-hint">${escapeHtml(t("templates.hint"))}</p>${rows}`;
  }

  function add() {
    const text = String(newInput ? newInput.value : "").trim().slice(0, MAX_LENGTH);
    if (!text) {
      if (newInput) newInput.focus();
      return;
    }
    const next = messages();
    if (!next.includes(text) && next.length < MAX_MESSAGES) next.push(text);
    if (newInput) newInput.value = "";
    save(next);
    render();
    setStatus(t("templates.saved"));
    if (newInput) newInput.focus();
  }

  // События делегируем на список: строки пересобираются, слушатели на них
  // пережили бы только одну перерисовку.
  if (body) {
    body.addEventListener("change", (event) => {
      const input = event.target.closest("[data-message]");
      if (!input) return;
      const index = Number(input.dataset.message);
      const next = messages();
      if (!Number.isInteger(index) || index < 0 || index >= next.length) return;
      const text = input.value.trim().slice(0, MAX_LENGTH);
      if (!text || next.some((item, i) => i !== index && item === text)) next.splice(index, 1);
      else next[index] = text;
      save(next);
      // Перерисовываем, потому что при пустом значении или дубле строка уходит.
      render();
    });

    body.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove]");
      if (remove) {
        const index = Number(remove.dataset.remove);
        const next = messages();
        if (!Number.isInteger(index) || index < 0 || index >= next.length) return;
        next.splice(index, 1);
        save(next);
        render();
        return;
      }
      const sendBtn = event.target.closest("[data-send]");
      if (!sendBtn) return;
      const index = Number(sendBtn.dataset.send);
      const input = body.querySelector(`[data-message="${index}"]`);
      const text = input ? input.value : messages()[index];
      sendToTicker(text, sendBtn.dataset.priority === "breaking" ? "breaking" : "normal");
    });
  }

  function setOpen(open) {
    if (!panel || !toggleBtn) return;
    panel.hidden = !open;
    toggleBtn.classList.toggle("is-active", open);
    if (open) {
      render();
      if (newInput) newInput.focus();
    }
  }

  function toggle() {
    setOpen(panel && panel.hidden);
  }

  function refreshLabel() {
    if (toggleBtn) toggleBtn.innerHTML = ICONS.widgetTicker;
  }

  on("templatesCloseBtn", "click", () => setOpen(false));
  on("templatesAddBtn", "click", add);
  if (newInput) {
    newInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        add();
      }
    });
  }

  refreshLabel();

  return { toggle, setOpen, refreshLabel, render };
}
