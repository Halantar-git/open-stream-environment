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
*/

import { el, on } from "./dom.js";

const ALERT_TESTS = [
  ["follow", "properties.testFollow"],
  ["sub", "properties.testSub"],
  ["gift_sub", "properties.testGift"],
  ["cheer", "properties.testCheer"],
  ["donation", "properties.testDonation"],
];

export function initDebugPanel({ t, ICONS, send, EVENT_TYPES }) {
  const panel = el("debugPanel");
  const body = el("debugBody");
  const toggleBtn = el("toggleDebugBtn");

  function setOpen(open) {
    if (!panel || !toggleBtn) return;
    panel.hidden = !open;
    toggleBtn.classList.toggle("is-active", open);
  }

  function toggle() {
    setOpen(panel && panel.hidden);
  }

  function refreshLabel() {
    if (toggleBtn) toggleBtn.innerHTML = `${ICONS.bug} ${t("debug.title")}`;
  }

  function render() {
    if (!body) return;

    const alertButtons = ALERT_TESTS.map(
      ([kind, key]) =>
        `<button class="debug-panel__btn" data-test="${kind}">${t(key)}</button>`
    ).join("");
    const chatButton =
      `<button class="debug-panel__btn" data-test="chat">${t("editor.testChat")}</button>`;

    body.innerHTML = `
      <div class="debug-panel__group">${t("debug.alerts")}</div>
      <div class="debug-panel__grid">${alertButtons}</div>
      <div class="debug-panel__group">${t("debug.chat")}</div>
      <div class="debug-panel__grid">${chatButton}</div>
    `;

    body.querySelectorAll("[data-test]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.dataset.test;
        if (kind === "chat") {
          send(EVENT_TYPES.CMD_TEST_CHAT, { count: 6 });
        } else {
          send(EVENT_TYPES.CMD_TEST_ALERT, { kind });
        }
      });
    });
  }

  function refresh() {
    refreshLabel();
    render();
  }

  refreshLabel();
  render();

  on("toggleDebugBtn", "click", toggle);
  on("debugCloseBtn", "click", () => setOpen(false));

  return { setOpen, toggle, refreshLabel, refresh };
}
