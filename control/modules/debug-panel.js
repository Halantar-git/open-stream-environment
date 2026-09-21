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
  Debug panel — a slide-out panel (like the terminal) with one-click buttons
  for all test events: five alert kinds plus a test chat burst. Replaces the
  per-widget test buttons, so tests live in one place.

  The log follows new lines only while the reader is already at the bottom —
  same as the terminal and the DA panel. An unconditional jump to the bottom is
  exactly what makes a log unreadable here: protocol frames (they land in this
  panel too) arrive often enough to yank the view away on every line.
*/

import { el, on } from "./dom.js";

const ALERT_TESTS = [
  ["follow", "properties.testFollow"],
  ["sub", "properties.testSub"],
  ["gift_sub", "properties.testGift"],
  ["cheer", "properties.testCheer"],
  ["donation", "properties.testDonation"],
  ["donation_long", "properties.testDonationLong"],
];

export function initDebugPanel({ t, ICONS, send, EVENT_TYPES }) {
  const panel = el("debugPanel");
  const body = el("debugBody");
  const testsEl = el("debugTests");
  const logEl = el("debugLogList");
  const toggleBtn = el("toggleDebugBtn");

  const MAX_DEBUG_LINES = 200;
  // Идём за новыми строками только пока читатель внизу (как в терминале)
  let atBottom = true;

  function formatTime(ts) {
    const d = new Date(Number(ts) || Date.now());
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
    if (toggleBtn) toggleBtn.innerHTML = `${ICONS.bug} ${t("debug.title")}`;
  }

  function render() {
    if (!testsEl) return;

    const alertButtons = ALERT_TESTS.map(
      ([kind, key]) =>
        `<button class="debug-panel__btn" data-test="${kind}">${t(key)}</button>`
    ).join("");
    const chatButton =
      `<button class="debug-panel__btn" data-test="chat">${t("editor.testChat")}</button>`;
    const pollButton =
      `<button class="debug-panel__btn" data-test="poll">${t("debug.testPoll")}</button>`;

    testsEl.innerHTML = `
      <div class="debug-panel__group">${t("debug.alerts")}</div>
      <div class="debug-panel__grid">${alertButtons}</div>
      <div class="debug-panel__group">${t("debug.chat")}</div>
      <div class="debug-panel__grid">${chatButton}</div>
      <div class="debug-panel__group">${t("debug.poll")}</div>
      <div class="debug-panel__grid">${pollButton}</div>
    `;

    testsEl.querySelectorAll("[data-test]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.dataset.test;
        if (kind === "chat") {
          send(EVENT_TYPES.CMD_TEST_CHAT, { count: 6 });
        } else if (kind === "poll") {
          send(EVENT_TYPES.CMD_TEST_POLL, {});
        } else {
          send(EVENT_TYPES.CMD_TEST_ALERT, { kind });
        }
      });
    });
  }

  function appendDebug(entry) {
    if (!logEl || !entry) return;

    const line = document.createElement("div");
    line.className = "debug-panel__line";

    const time = document.createElement("span");
    time.className = "debug-panel__line__time";
    time.textContent = formatTime(entry.timestamp);

    const service = document.createElement("span");
    service.className = "debug-panel__line__service";
    service.textContent = entry.service || "server";

    const message = document.createElement("span");
    message.className = "debug-panel__line__message";
    message.textContent = entry.message || "";

    // См. logger-panel: сообщение и данные держим в одном flex-элементе,
    // чтобы длинный JSON не сжимал сообщение до одной буквы в строке.
    const text = document.createElement("span");
    text.className = "debug-panel__line__text";
    text.appendChild(message);
    line.append(time, service, text);

    if (entry.data != null && entry.data !== "") {
      const data = document.createElement("span");
      data.className = "debug-panel__line__data";
      data.textContent = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data);
      text.appendChild(document.createTextNode(" "));
      text.appendChild(data);
    }

    logEl.appendChild(line);
    while (logEl.children.length > MAX_DEBUG_LINES) {
      logEl.removeChild(logEl.firstChild);
    }
    if (body && atBottom) body.scrollTop = body.scrollHeight;
  }

  function clearDebug() {
    if (logEl) logEl.innerHTML = "";
    // Выше читать уже нечего — снова следуем за новыми строками
    atBottom = true;
  }

  function refresh() {
    refreshLabel();
    render();
  }

  refreshLabel();
  render();

  on("debugClearBtn", "click", clearDebug);
  on("debugCloseBtn", "click", () => setOpen(false));

  if (body) {
    body.addEventListener("scroll", () => {
      atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    });
  }

  return { setOpen, toggle, refreshLabel, refresh, appendDebug, clearDebug };
}
