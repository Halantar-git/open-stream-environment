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
  Minimal hand-drawn icon set (stroke-based, matches M3's outlined icon
  style) so neither the overlay nor the control panel need an external
  icon font/library. Isomorphic export, same pattern as events.js.
*/
(function (root) {
  const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

  const ICONS = {
    // alert kinds
    follow: `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 21s-7-4.35-9.5-8.5C.8 8.9 2.6 5 6.2 5c2 0 3.3 1 4.8 2.7C12.5 6 13.8 5 15.8 5c3.6 0 5.4 3.9 3.7 7.5C19 16.65 12 21 12 21z"/></svg>`,
    sub: `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 2l2.4 5.8L20 9l-4.6 3.8L16.9 19 12 15.6 7.1 19l1.5-6.2L4 9l5.6-1.2L12 2z"/></svg>`,
    gift_sub: `<svg viewBox="0 0 24 24" ${stroke}><rect x="3" y="9" width="18" height="12" rx="1.5"/><path d="M3 13h18M12 9v12"/><path d="M12 9C9 9 7.5 7.7 7.5 6.2 7.5 5 8.4 4 9.7 4 11 4 12 6 12 9zM12 9c3 0 4.5-1.3 4.5-2.8 0-1.2-.9-2.2-2.2-2.2-1.3 0-2.3 2-2.3 5z"/></svg>`,
    cheer: `<svg viewBox="0 0 24 24" ${stroke}><path d="M13 2 4 14h6l-1 8 10-13h-6l1-7z"/></svg>`,
    donation: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.5c0-1.1 1.2-2 2.8-2 1.7 0 2.8.8 2.8 2s-1.1 1.7-2.8 2c-1.7.3-2.8.9-2.8 2.1 0 1.2 1.2 2.1 2.8 2.1 1.6 0 2.8-.7 2.8-1.9"/></svg>`,
    // widget-type icons for the editor library rail
    widgetAlerts: `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/><circle cx="12" cy="12" r="3.4"/></svg>`,
    widgetGoal: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>`,
    widgetChat: `<svg viewBox="0 0 24 24" ${stroke}><path d="M4 5h16v11H8l-4 4V5z"/></svg>`,
    widgetRecent: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
    widgetCustom: `<svg viewBox="0 0 24 24" ${stroke}><rect x="3" y="3" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="3" width="7.5" height="4.5" rx="1"/><rect x="13.5" y="9" width="7.5" height="12" rx="1"/><rect x="3" y="12.5" width="7.5" height="8.5" rx="1"/></svg>`,
    widgetStat: `<svg viewBox="0 0 24 24" ${stroke}><path d="M4 19h16M8 19V9M13 19V5M18 19v-7"/></svg>`,
    widgetSocial: `<svg viewBox="0 0 24 24" ${stroke}><rect x="3" y="7" width="18" height="10" rx="5"/><circle cx="8" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>`,
    widgetParticipants: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="9" cy="8" r="3"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.5c2.8.3 4.8 2.3 4.8 4.5"/></svg>`,
    widgetMic: `<svg viewBox="0 0 24 24" ${stroke}><path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 12h2"/></svg>`,
    widgetDeath: `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 3a8 8 0 0 0-8 8c0 2.6 1.1 4.3 2.4 5.6V19a1 1 0 0 0 1 1h2.6v-2h4v2H16a1 1 0 0 0 1-1v-2.4C18.9 15.3 20 13.6 20 11a8 8 0 0 0-8-8z"/><circle cx="9" cy="10.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="10.5" r="1.3" fill="currentColor" stroke="none"/><path d="M9 14h6"/></svg>`,
    palette: `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a4 4 0 0 0 4-4c0-4.4-3.6-8.2-8-8.2z"/><circle cx="7.5" cy="10.5" r="1.2" fill="currentColor"/><circle cx="11" cy="7" r="1.2" fill="currentColor"/><circle cx="15.5" cy="8" r="1.2" fill="currentColor"/></svg>`,
    download: `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 4v11m0 0-4-4m4 4 4-4M5 18h14"/></svg>`,
    upload: `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 20V9m0 0-4 4m4-4 4 4M5 4h14"/></svg>`,
    grid: `<svg viewBox="0 0 24 24" ${stroke}><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>`,
    scenePlay: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5-6-3.5z" fill="currentColor" stroke="none"/></svg>`,
    sceneBrb: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"/><path d="M8 12h8M8 9h5M8 15h5"/></svg>`,
    sceneEnd: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none"/></svg>`,
    sceneWheel: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6M5.6 5.6l4.2 4.2M14.2 14.2l4.2 4.2M18.4 5.6l-4.2 4.2M9.8 14.2l-4.2 4.2"/></svg>`,
    sceneTalk: `<svg viewBox="0 0 24 24" ${stroke}><path d="M4 5h16v11H8l-4 4V5z"/><path d="M8 9h8M8 12h5"/></svg>`,
    // editor chrome icons
    trash: `<svg viewBox="0 0 24 24" ${stroke}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" ${stroke}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`,
    eyeOff: `<svg viewBox="0 0 24 24" ${stroke}><path d="M3 3l18 18M10.6 5.2A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7c1.4 0 2.6-.3 3.7-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 5v14M5 12h14"/></svg>`,
    settings: `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3.9a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.4a7.4 7.4 0 0 0-1.7 1l-2.3-.9-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-.9c.5.4 1.1.8 1.7 1L10 21h4l.4-2.4c.6-.2 1.2-.6 1.7-1l2.3.9 2-3.4-2-1.5z"/></svg>`,
    layers: `<svg viewBox="0 0 24 24" ${stroke}><path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M2 13l10 5 10-5M2 17.5 12 22l10-4.5"/></svg>`,
    link: `<svg viewBox="0 0 24 24" ${stroke}><path d="M9 15l6-6M8 12l-2.5 2.5a3.5 3.5 0 0 0 5 5L13 17M16 12l2.5-2.5a3.5 3.5 0 0 0-5-5L11 7"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" ${stroke}><rect x="9" y="9" width="12" height="12" rx="1.5"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`,
    terminal: `<svg viewBox="0 0 24 24" ${stroke}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>`,
    back: `<svg viewBox="0 0 24 24" ${stroke}><path d="M15 5l-7 7 7 7"/></svg>`,
    heart: `<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.35-9.5-8.5C.8 8.9 2.6 5 6.2 5c2 0 3.3 1 4.8 2.7C12.5 6 13.8 5 15.8 5c3.6 0 5.4 3.9 3.7 7.5C19 16.65 12 21 12 21z" fill="currentColor"/></svg>`,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { ICONS };
  } else {
    root.SharedIcons = { ICONS };
  }
})(typeof window !== "undefined" ? window : globalThis);
