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
  Twitch IRC emote parsing shared between the OBS overlay chat widget
  (overlay/overlay.js) and the desktop streamer chat window
  (chatwindow/chat-window.js). Loaded as a plain <script>.
*/
(function (root) {
  const EMOTE_CDN = "https://static-cdn.jtvnw.net/emoticons/v2";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function toRanges(id, positions) {
    const list = Array.isArray(positions) ? positions : String(positions || "").split(",");
    return list
      .map((p) => String(p).split("-").map(Number))
      .filter(([a]) => Number.isFinite(a))
      .map(([a, b]) => ({ id, start: a, end: Number.isFinite(b) ? b : a }));
  }

  function parseEmoteRanges(emotes) {
    if (!emotes) return [];

    const ranges = [];

    if (typeof emotes === "string") {
      // Raw IRC tag form: "id:start-end[,start-end][/id:...]"
      for (const part of emotes.split("/")) {
        const sep = part.indexOf(":");
        if (sep === -1) continue;
        ranges.push(...toRanges(part.slice(0, sep), part.slice(sep + 1)));
      }
    } else if (typeof emotes === "object") {
      for (const [id, positions] of Object.entries(emotes)) {
        ranges.push(...toRanges(id, positions));
      }
    }

    return ranges
      .filter((r) => /^\d+$/.test(String(r.id)))
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function renderEmotes(message, emotes) {
    const text = String(message || "");
    const ranges = parseEmoteRanges(emotes);
    if (!ranges.length) return escapeHtml(text);

    let html = "";
    let cursor = 0;

    for (const r of ranges) {
      if (r.start < cursor || r.start >= text.length || r.end >= text.length) continue;
      html += escapeHtml(text.slice(cursor, r.start));
      const emoteName = text.slice(r.start, r.end + 1);
      html += `<img src="${EMOTE_CDN}/${r.id}/default/dark/2.0" alt="${escapeHtml(emoteName)}" title="${escapeHtml(emoteName)}" class="twitch-emote" loading="lazy" />`;
      cursor = r.end + 1;
    }

    html += escapeHtml(text.slice(cursor));
    return html;
  }

  root.TwitchEmotes = { renderEmotes };
})(typeof window !== "undefined" ? window : globalThis);
