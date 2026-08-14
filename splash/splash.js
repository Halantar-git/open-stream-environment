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
  const params = new URLSearchParams(location.search);
  const version = params.get("version");
  const subtitleEl = document.getElementById("subtitle");
  if (subtitleEl) subtitleEl.textContent = version ? `Desktop // v${version}` : "Desktop";

  const logs = [
    ">> CONNECTING LOCAL DATABASE (LOWDB)...",
    "[OK] DATABASE INITIALIZED & VACUUMED",
    ">> LOADING AUDIO ENGINE (FIELD OF FORTUNE STYLES)...",
    ">> ESTABLISHING WEBSOCKETS (TWITCH & DONATIONALERTS)...",
    ">> RUNNING SYSTEM UNIT TESTS (JEST)...",
    "[SUCCESS] ALL TESTS PASSED. STREAM WORKSPACE IS READY",
  ];
  let currentLog = 0;
  const logBox = document.getElementById("logBox");

  const interval = setInterval(() => {
    if (currentLog < logs.length) {
      const line = document.createElement("div");
      line.className = currentLog === logs.length - 1 ? "log-line success" : "log-line";
      line.textContent = logs[currentLog];
      logBox.appendChild(line);

      if (logBox.children.length > 4) {
        logBox.removeChild(logBox.children[0]);
      }
      currentLog++;
    } else {
      clearInterval(interval);
    }
  }, 800);
})();
