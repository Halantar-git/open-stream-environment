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
  WebSocket client + connection-status rendering for the control panel.

  Owns the transport lifecycle (connect / auto-reconnect / send) and the
  `connectionStatus` map plus the status chips in the top bar and settings.
  Incoming messages are delegated to the `onMessage` callback — this module
  does not know how individual event types mutate overlay state.
*/

import { el } from "./dom.js";

export function initWsClient({ url, t, onMessage, onStatusClick, resolveUrl }) {
  let ws = null;
  let connectionStatus = {};
  let currentUrl = url;
  let failures = 0;

  const STATUS_LABEL = (service) =>
    ({ twitchChat: t("status.twitchChat"), twitchEvents: t("status.twitchEvents"), donationAlerts: t("status.donationAlerts"), youtube: t("status.youtube"), obs: "OBS" }[service] || service);

  const STATUS_TEXT = (status) =>
    ({ connected: t("status.connected"), connecting: t("status.connecting"), disconnected: t("status.disconnected"), error: t("status.error"), not_configured: t("status.notConfigured"), disabled: t("status.disabled") }[status] || status);

  function statusClass(status) {
    if (status === "connected") return "is-connected";
    if (status === "error") return "is-error";
    if (status === "connecting") return "is-pending";
    return "";
  }

  function renderStatusChips() {
    const container = el("statusFabList");
    if (!container) return;
    const order = ["twitchChat", "twitchEvents", "donationAlerts", "youtube", "obs"];
    container.innerHTML = order
      .filter((service) => connectionStatus[service] !== undefined && connectionStatus[service] !== "disabled")
      .map((service) => {
        const status = connectionStatus[service];
        return `<button class="status-fab ${statusClass(status)}" data-service="${service}" type="button" title="${STATUS_LABEL(service)}">
          <span class="status-fab__dot"></span>
          <span class="status-fab__label">${STATUS_LABEL(service)}</span>
          <span class="status-fab__status">${STATUS_TEXT(status)}</span>
        </button>`;
      })
      .join("");
    container.querySelectorAll(".status-fab").forEach((btn) => {
      btn.addEventListener("click", () => onStatusClick && onStatusClick(btn.dataset.service));
    });
  }

  function updateSettingsChips() {
    ["twitchChat", "twitchEvents", "donationAlerts", "youtube", "obs"].forEach((service) => {
      const chip = el("chip-" + service);
      if (!chip) return;
      const status = connectionStatus[service];
      chip.style.display = status === "disabled" ? "none" : "";
      chip.className = "md-chip " + statusClass(status);
      const label = chip.querySelector(".md-chip__label");
      if (label) label.textContent = `${STATUS_LABEL(service)}: ${STATUS_TEXT(status)}`;
    });
  }

  function refreshStatusChips() {
    renderStatusChips();
    updateSettingsChips();
  }

  function setStatuses(statuses) {
    connectionStatus = statuses || {};
    refreshStatusChips();
  }

  function updateStatus(service, status) {
    connectionStatus[service] = status;
    refreshStatusChips();
  }

  function send(type, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
  }

  function connect() {
    ws = new WebSocket(currentUrl);
    ws.onopen = () => {
      failures = 0;
    };
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      failures += 1;
      // After a live port switch the saved URL can be stale (e.g. a switch
      // that failed and rolled back to the previous port). Re-resolve the
      // authoritative port from the main process so the panel self-heals.
      if (typeof resolveUrl === "function" && failures % 5 === 0) {
        Promise.resolve(resolveUrl())
          .then((resolved) => {
            if (resolved && resolved !== currentUrl) currentUrl = resolved;
          })
          .catch(() => {})
          .finally(() => setTimeout(connect, 2000));
      } else {
        setTimeout(connect, 2000);
      }
    };
    ws.onerror = () => ws.close();
  }

  function setUrl(next) {
    if (next && next !== currentUrl) currentUrl = next;
  }

  connect();

  return { send, setStatuses, updateStatus, refreshStatusChips, setUrl };
}
