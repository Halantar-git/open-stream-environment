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
  Панель «Шаблоны»: редактор общих шаблонов новостной ленты и отправка
  срочного сообщения в её верхнюю полосу.

  Шаблоны здесь общие для всех лент — их читает каждая лента, у которой нет
  своего набора в настройках виджета. Панель живёт рядом с терминалом и
  открывается кнопкой в верхней панели: правка не должна требовать найти
  виджет на холсте.
*/

import { el, on } from "./dom.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

// Ключ шаблона, подпись поля и текст-подсказка по умолчанию. Подсказка — та же
// строка словаря, которую лента берёт без своего шаблона, поэтому в поле видно
// ровно то, что уйдёт в эфир, и из чего собирать свой вариант.
const FIELDS = [
  ["donation", "properties.tickerTplDonation", "ticker.donation"],
  ["cheer", "properties.tickerTplCheer", "ticker.cheer"],
  ["follow", "properties.tickerTplFollow", "ticker.follow"],
  ["sub", "properties.tickerTplSub", "ticker.sub"],
  ["gift_sub", "properties.tickerTplGift", "ticker.gift"],
  ["reward", "properties.tickerTplReward", "ticker.rewardTitle"],
  ["chat", "properties.tickerTplChat", "ticker.chat"],
  ["goal", "properties.tickerTplGoal", "ticker.goalTitle"],
  ["top", "properties.tickerTplTop", "ticker.top"],
];

export function initTemplatesPanel({ t, ICONS, send, EVENT_TYPES, state }) {
  const panel = el("templatesPanel");
  const body = el("templatesBody");
  const toggleBtn = el("toggleTemplatesBtn");
  const breakingInput = el("templatesBreakingText");
  const statusEl = el("templatesBreakingStatus");
  let statusTimer = 0;

  function templates() {
    const value = state.tickerTemplates;
    return value && typeof value === "object" ? value : {};
  }

  function render() {
    if (!body) return;
    const current = templates();
    const fields = FIELDS.map(([key, labelKey, placeholderKey]) => {
      const value = typeof current[key] === "string" ? current[key] : "";
      return `<label class="templates-field">
        <span class="templates-field__label">${escapeHtml(t(labelKey))}</span>
        <input class="templates-field__input" type="text" data-template="${key}" value="${escapeHtml(value)}" placeholder="${escapeHtml(t(placeholderKey))}" autocomplete="off" spellcheck="false">
      </label>`;
    }).join("");
    body.innerHTML = `<p class="templates-hint">${escapeHtml(t("templates.hint"))}</p>${fields}`;
    body.querySelectorAll("[data-template]").forEach((input) => {
      input.addEventListener("change", () => {
        const next = { ...templates() };
        const value = input.value.trim();
        if (value) next[input.dataset.template] = value;
        else delete next[input.dataset.template];
        // Оптимистично: снимок с сервера может прийти на круг шины позже, а
        // следующая правка должна видеть уже сохранённое.
        state.tickerTemplates = next;
        send(EVENT_TYPES.CMD_SET_APP_CONFIG, { tickerTemplates: next });
      });
    });
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

  function sendBreaking() {
    const text = breakingInput ? breakingInput.value.trim() : "";
    if (!text) {
      if (breakingInput) breakingInput.focus();
      return;
    }
    send(EVENT_TYPES.CMD_TICKER_MESSAGE, { text, priority: "breaking" });
    if (breakingInput) {
      breakingInput.value = "";
      breakingInput.focus();
    }
    setStatus(t("templates.breakingSent"));
  }

  function setOpen(open) {
    if (!panel || !toggleBtn) return;
    panel.hidden = !open;
    toggleBtn.classList.toggle("is-active", open);
    if (open) {
      render();
      if (breakingInput) breakingInput.focus();
    }
  }

  function toggle() {
    setOpen(panel && panel.hidden);
  }

  function refreshLabel() {
    if (toggleBtn) toggleBtn.innerHTML = `${ICONS.widgetTicker} ${t("templates.title")}`;
  }

  on("templatesCloseBtn", "click", () => setOpen(false));
  on("templatesBreakingSend", "click", sendBreaking);
  if (breakingInput) {
    breakingInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendBreaking();
      }
    });
  }

  refreshLabel();

  return { toggle, setOpen, refreshLabel, render };
}
