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
  Static sample cards (alert, chat, goal, poll) used to evaluate a theme.
  Applies the theme tokens + custom CSS from STATE and the live editor draft
  (THEME_DRAFT_PREVIEW), exactly like the real overlay preview window.
*/
(function () {
  const { EVENT_TYPES } = window.SharedEvents;

  let ws = null;
  let lastAppearance = null;

  function applyCustomCss(css) {
    let style = document.getElementById("ose-custom-theme-css");
    if (!css) {
      if (style) style.remove();
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.id = "ose-custom-theme-css";
      document.head.appendChild(style);
    }
    style.textContent = css;
  }

  function applyTheme(appearance) {
    if (!appearance || !appearance.tokens) return;
    lastAppearance = appearance;
    const root = document.documentElement;
    Object.entries(appearance.tokens).forEach(([k, v]) => root.style.setProperty(k, v));
    applyCustomCss(appearance.customCss || "");
  }

  function applyDraft(draft) {
    if (!draft || draft.clear || !draft.tokens) {
      if (lastAppearance) applyTheme(lastAppearance);
      return;
    }
    applyTheme({
      ...(lastAppearance || {}),
      tokens: draft.tokens,
      customCss: draft.customCss || "",
    });
  }

  function handle(msg) {
    if (msg.type === EVENT_TYPES.STATE) {
      lastAppearance = msg.payload && msg.payload.appearance;
      applyTheme(lastAppearance);
    } else if (msg.type === EVENT_TYPES.THEME_UPDATE) {
      lastAppearance = msg.payload;
      applyTheme(lastAppearance);
    } else if (msg.type === EVENT_TYPES.THEME_DRAFT_PREVIEW) {
      applyDraft(msg.payload);
    }
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      try { handle(JSON.parse(ev.data)); } catch (_) { /* ignore */ }
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws.close();
  }

  connect();
})();
