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

  Наборы своего канала чужие смайлы не покрывают: в чате пишут смайлы других
  каналов, и по имени их можно найти только поиском провайдера. Такой поиск
  уходит один раз на слово (и промах тоже запоминается), а картинка
  подставляется, как только ответ пришёл.

  Each page keeps its own copy; a failed request (network, CORS, unknown
  channel) simply leaves that provider out instead of breaking the chat.
*/
(function (root) {
  const EMOTE_CDN = "https://static-cdn.jtvnw.net/emoticons/v2";
  const BTTV_CDN = "https://cdn.betterttv.net/emote";
  const SEVEN_CDN = "https://cdn.7tv.app/emote";
  const REQUEST_TIMEOUT_MS = 8000;

  // Поиск незнакомого смайла по имени: в живом чате таких слов не так много,
  // но лимиты всё равно нужны — одно слово стоит двух запросов к провайдерам.
  const LOOKUP_CONCURRENCY = 3;
  const LOOKUP_BUDGET = 300;
  // Код смайла — латиница с цифрами без пробелов. Чистое слово в нижнем
  // регистре — обычный текст, его не ищем: промахи стоят запросов.
  const LOOKUP_NAME = /^[A-Za-z][A-Za-z0-9]{2,24}$/;

  // Точка входа: `{ channel, channelId }` последнего configure(). Хранится,
  // чтобы refresh() мог перезагрузить наборы, не дожидаясь нового STATE.
  let current = { channel: "", channelId: "" };
  let loadedKey = null;
  let loading = null;
  // Имя смайла -> URL картинки. Канальные наборы перекрывают глобальные.
  let thirdParty = new Map();
  // Результаты поиска по имени: `pending` — запрос в пути, пустая строка —
  // провайдеры такого смайла не знают. Кэш живёт страницу целиком.
  const lookups = new Map();
  let lookupActive = 0;
  let lookupBudget = LOOKUP_BUDGET;

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

  async function fetchJson(url, init) {
    if (typeof fetch !== "function") return null;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const response = await fetch(
        url,
        Object.assign(
          {
            mode: "cors",
            signal: controller ? controller.signal : undefined,
          },
          init || {}
        )
      );
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

  function emoteImg(name, url) {
    return `<img src="${url}" alt="${escapeHtml(name)}" title="${escapeHtml(name)}" class="twitch-emote" loading="lazy" />`;
  }

  // ---- поиск смайла чужого канала по имени ----

  /*
    В чате пишут смайлы других каналов, а их наборов у нас нет: загружены
    только свой канал и глобальные наборы. Искать по имени умеют 7TV и
    FrankerFaceZ; BetterTTV свой поиск закрыл, а родные смайлы Twitch анонимному
    чату вообще не видны — у них остаётся только `emotes`-тег от Twitch.
  */

  async function sevenTvByName(name) {
    const body = JSON.stringify({
      query: `{emotes(query:"${name}",limit:8){items{id name}}}`,
    });
    const data = await fetchJson("https://7tv.io/v3/gql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const items = data && data.data && data.data.emotes && data.data.emotes.items;
    const hit = Array.isArray(items) ? items.find((item) => item && item.name === name) : null;
    return hit && hit.id ? `${SEVEN_CDN}/${hit.id}/2x.webp` : "";
  }

  async function ffzByName(name) {
    const data = await fetchJson(
      `https://api.frankerfacez.com/v1/emotes?q=${encodeURIComponent(name)}`
    );
    const items = data && data.emoticons;
    const hit = Array.isArray(items) ? items.find((item) => item && item.name === name) : null;
    if (!hit) return "";
    const urls = hit.urls || {};
    const url = urls["2"] || urls["1"] || urls["4"];
    if (!url) return "";
    return url.startsWith("//") ? `https:${url}` : url;
  }

  function looksLikeEmoteName(name) {
    // Только смешанный регистр: обычные слова и КАПС из чата отсекаются, а
    // промахи по чужим словам всё равно стоят двух запросов.
    return LOOKUP_NAME.test(name) && /[A-Z]/.test(name) && name !== name.toUpperCase();
  }

  // Подменить заглушки, которые уже нарисованы в чате, на картинку.
  function applyEmote(name, url) {
    if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
    const nodes = document.querySelectorAll(`.twitch-emote-pending[data-emote="${name}"]`);
    for (const node of nodes) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = name;
      img.title = name;
      img.className = "twitch-emote";
      img.loading = "lazy";
      if (node.parentNode && node.parentNode.replaceChild) node.parentNode.replaceChild(img, node);
    }
  }

  /**
   * Начать поиск смайла по имени. `true` — запрос ушёл и на его место можно
   * поставить заглушку; `false` — слово уже искали или лимит исчерпан.
   */
  function startLookup(name) {
    if (!lookupBudget || lookupActive >= LOOKUP_CONCURRENCY) return false;
    lookups.set(name, "pending");
    lookupBudget -= 1;
    lookupActive += 1;
    Promise.resolve()
      .then(() => sevenTvByName(name))
      .then((url) => url || ffzByName(name))
      .then((url) => {
        lookups.set(name, url || "");
        if (url) {
          thirdParty.set(name, url);
          applyEmote(name, url);
        }
      })
      .catch(() => lookups.set(name, ""))
      .finally(() => {
        lookupActive -= 1;
      });
    return true;
  }

   /** Загрузить сторонние наборы для канала. Повторный вызов с теми же каналом и
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
    // Режем по пробелам, сохраняя их: имя смайла — это целое слово.
    return chunk
      .split(/(\s+)/)
      .map((token) => {
        if (!token || /^\s+$/.test(token)) return escapeHtml(token);
        const url = thirdParty.get(token);
        if (url) return emoteImg(token, url);
        // Смайл чужого канала: ищем по имени, а пока рисуем заглушку — как
        // только ответ придёт, она станет картинкой.
        const known = lookups.get(token);
        if (typeof known === "string" && known) return emoteImg(token, known);
        if (known === undefined && looksLikeEmoteName(token) && startLookup(token)) {
          return `<span class="twitch-emote-pending" data-emote="${token}">${escapeHtml(token)}</span>`;
        }
        return escapeHtml(token);
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
