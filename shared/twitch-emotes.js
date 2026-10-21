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
  Twitch chat emotes shared between the OBS overlay chat widget
  (overlay/overlay.js) and the desktop streamer chat window
  (chatwindow/chat-window.js). Loaded as a plain <script>.

  Native Twitch emotes arrive in the IRC `emotes` tag, so they are rendered by
  position. Third-party emotes (BetterTTV, FrankerFaceZ, 7TV) never appear in
  that tag: they are matched by name, which is why configure() downloads the
  channel's sets once and renderEmotes() walks the text that is left between
  native ranges.

  Each page keeps its own copy; a failed request (network, CORS, unknown
  channel) simply leaves that provider out instead of breaking the chat.
*/
(function (root) {
  const EMOTE_CDN = "https://static-cdn.jtvnw.net/emoticons/v2";
  const BTTV_CDN = "https://cdn.betterttv.net/emote";
  const REQUEST_TIMEOUT_MS = 8000;

  // Точка входа: `{ channel, channelId }` последнего configure(). Хранится,
  // чтобы refresh() мог перезагрузить наборы, не дожидаясь нового STATE.
  let current = { channel: "", channelId: "" };
  let loadedKey = null;
  let loading = null;
  // Имя смайла -> URL картинки. Канальные наборы перекрывают глобальные.
  let thirdParty = new Map();

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

  async function fetchJson(url) {
    if (typeof fetch !== "function") return null;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const response = await fetch(url, {
        mode: "cors",
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (_) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---- BetterTTV ----

  function bttvEntries(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((emote) => emote && emote.code && emote.id)
      .map((emote) => [emote.code, `${BTTV_CDN}/${emote.id}/2x`]);
  }

  async function bttvGlobal() {
    return bttvEntries(await fetchJson("https://api.betterttv.net/3/cached/emotes/global"));
  }

  async function bttvChannel(channelId) {
    const data = await fetchJson(
      `https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(channelId)}`
    );
    if (!data) return [];
    return [...bttvEntries(data.channelEmotes), ...bttvEntries(data.sharedEmotes)];
  }

  // ---- FrankerFaceZ ----

  function ffzEntries(sets) {
    const entries = [];
    for (const set of Object.values(sets || {})) {
      for (const emote of (set && set.emoticons) || []) {
        const urls = emote && emote.urls;
        const url = urls && (urls["4"] || urls["2"] || urls["1"]);
        if (emote && emote.name && url) {
          entries.push([emote.name, url.startsWith("//") ? `https:${url}` : url]);
        }
      }
    }
    return entries;
  }

  async function ffzGlobal() {
    const data = await fetchJson("https://api.frankerfacez.com/v1/set/global");
    if (!data) return [];
    const ids = Array.isArray(data.default_sets) ? data.default_sets : Object.keys(data.sets || {});
    const sets = {};
    for (const id of ids) {
      if (data.sets && data.sets[id]) sets[id] = data.sets[id];
    }
    return ffzEntries(sets);
  }

  async function ffzChannel(channel) {
    const data = await fetchJson(
      `https://api.frankerfacez.com/v1/room/${encodeURIComponent(channel)}`
    );
    return data ? ffzEntries(data.sets) : [];
  }

  // ---- 7TV ----

  function sevenTvEntries(list) {
    if (!Array.isArray(list)) return [];
    const entries = [];
    for (const emote of list) {
      const host = emote && emote.data && emote.data.host;
      if (!emote || !emote.name || !host || !host.url) continue;
      const base = host.url.startsWith("//") ? `https:${host.url}` : host.url;
      entries.push([emote.name, `${base}/2x.webp`]);
    }
    return entries;
  }

  async function sevenTvGlobal() {
    const data = await fetchJson("https://7tv.io/v3/emote-sets/global");
    return data ? sevenTvEntries(data.emotes) : [];
  }

  async function sevenTvChannel(channelId) {
    const data = await fetchJson(
      `https://7tv.io/v3/users/twitch/${encodeURIComponent(channelId)}`
    );
    return data && data.emote_set ? sevenTvEntries(data.emote_set.emotes) : [];
  }

  async function loadThirdParty(channel, channelId) {
    const [bttvG, ffzG, sevenG, bttvC, ffzC, sevenC] = await Promise.all([
      bttvGlobal(),
      ffzGlobal(),
      sevenTvGlobal(),
      channelId ? bttvChannel(channelId) : [],
      channel ? ffzChannel(channel) : [],
      channelId ? sevenTvChannel(channelId) : [],
    ]);

    const merged = new Map();
    // Канальные наборы идут после глобальных и перекрывают одноимённые.
    for (const entries of [bttvG, ffzG, sevenG, bttvC, ffzC, sevenC]) {
      for (const [name, url] of entries) merged.set(name, url);
    }
    return merged;
  }

  /**
   * Загрузить сторонние наборы для канала. Повторный вызов с теми же каналом и
   * id ничего не делает; смена канала перезагружает наборы.
   */
  function configure(options) {
    const channel = String((options && options.channel) || "").trim().toLowerCase();
    const channelId = String((options && options.channelId) || "").trim();
    current = { channel, channelId };
    const key = `${channel}|${channelId}`;
    if (key === loadedKey) return loading || Promise.resolve(thirdParty);

    loadedKey = key;
    thirdParty = new Map();
    loading = loadThirdParty(channel, channelId)
      .then((map) => {
        thirdParty = map;
        loading = null;
        return map;
      })
      .catch(() => {
        thirdParty = new Map();
        loading = null;
        return thirdParty;
      });
    return loading;
  }

  /** Перезагрузить наборы (например, после ручного обновления настроек). */
  function refresh() {
    loadedKey = null;
    return configure(current);
  }

  function thirdPartyHtml(chunk) {
    if (!thirdParty.size) return escapeHtml(chunk);
    // Режем по пробелам, сохраняя их: имя смайла — это целое слово.
    return chunk
      .split(/(\s+)/)
      .map((token) => {
        if (!token || /^\s+$/.test(token)) return escapeHtml(token);
        const url = thirdParty.get(token);
        if (!url) return escapeHtml(token);
        return `<img src="${url}" alt="${escapeHtml(token)}" title="${escapeHtml(token)}" class="twitch-emote" loading="lazy" />`;
      })
      .join("");
  }

  function renderEmotes(message, emotes) {
    const text = String(message || "");
    const ranges = parseEmoteRanges(emotes);
    let html = "";
    let cursor = 0;

    for (const r of ranges) {
      if (r.start < cursor || r.start >= text.length || r.end >= text.length) continue;
      html += thirdPartyHtml(text.slice(cursor, r.start));
      const emoteName = text.slice(r.start, r.end + 1);
      html += `<img src="${EMOTE_CDN}/${r.id}/default/dark/2.0" alt="${escapeHtml(emoteName)}" title="${escapeHtml(emoteName)}" class="twitch-emote" loading="lazy" />`;
      cursor = r.end + 1;
    }

    html += thirdPartyHtml(text.slice(cursor));
    return html;
  }

  root.TwitchEmotes = { renderEmotes, configure, refresh };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.TwitchEmotes;
  }
})(typeof window !== "undefined" ? window : globalThis);
