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
  Pure automatic-moderation engine for the chat bot.

  Detects link spam, blacklisted words (with a small de-leet pass), caps spam
  and emote spam, and accumulates warnings per user. It only *decides* what to
  do — the actual Twitch timeout/ban calls happen in the bot wiring layer, so
  this module stays fully unit-testable.
*/

const URL_RE = /(?:https?:\/\/|www\.)[^\s]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi;

// Latin/digit lookalikes that are commonly used to hide Cyrillic words.
const LEET = {
  "0": "о",
  o: "о",
  a: "а",
  e: "е",
  "ё": "е",
  y: "у",
  k: "к",
  x: "х",
  b: "в",
  m: "м",
  n: "н",
  t: "т",
  c: "с",
  p: "р",
  h: "н",
  "3": "з",
  "4": "ч",
  "6": "б",
  "7": "т",
  "9": "д",
  "@": "а",
};

function deleetize(text) {
  return String(text || "")
    .toLowerCase()
    .split("")
    .map((ch) => LEET[ch] || ch)
    .join("");
}

function compactCyrillic(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^а-яё]/g, "");
}

function countEmotes(emotes) {
  if (!emotes) return 0;
  if (typeof emotes === "string") {
    // Raw IRC form: "id:start-end[,start-end][/id:...]"
    return String(emotes)
      .split("/")
      .reduce((sum, part) => {
        const sep = part.indexOf(":");
        if (sep === -1) return sum;
        return sum + part.slice(sep + 1).split(",").filter(Boolean).length;
      }, 0);
  }
  if (typeof emotes === "object") {
    return Object.values(emotes).reduce((sum, positions) => {
      if (Array.isArray(positions)) return sum + positions.length;
      return sum + String(positions || "").split(",").filter(Boolean).length;
    }, 0);
  }
  return 0;
}

function capsRatio(message) {
  const text = String(message || "");
  const letters = text.match(/[a-zа-яё]/gi);
  if (!letters || !letters.length) return 0;
  const upper = text.match(/[A-ZА-ЯЁ]/g) || [];
  return upper.length / letters.length;
}

function extractHost(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .split(":")[0]
    .trim();
}

function findDisallowedLink(message, whitelist) {
  const matches = String(message || "").match(URL_RE) || [];
  for (const match of matches) {
    const host = extractHost(match);
    if (!host || !host.includes(".")) continue;
    const allowed = (whitelist || []).some((w) => w && (host === w || host.endsWith("." + w)));
    if (!allowed) return host;
  }
  return null;
}

function findBadWord(message, badWords) {
  const deleet = deleetize(message);
  const compact = compactCyrillic(deleet);
  for (const word of badWords || []) {
    const dw = deleetize(word);
    if (!dw) continue;
    const cw = compactCyrillic(dw);
    if (cw && (compact.includes(cw) || deleet.includes(dw))) return word;
  }
  return null;
}

function defaultModerationConfig() {
  return {
    enabled: false,
    linkProtection: true,
    whitelistDomains: ["youtube.com", "youtu.be", "clips.twitch.tv", "twitch.tv", "boosty.to"],
    badWords: [],
    capsThreshold: 0.7,
    maxEmotes: 15,
    maxWarns: 3,
    warnTimeoutSec: 600,
  };
}

function createMemoryStore() {
  const map = new Map();
  return {
    get(key) {
      return map.get(key) || 0;
    },
    set(key, count) {
      map.set(key, count);
    },
    delete(key) {
      map.delete(key);
    },
  };
}

function createModerationEngine(config = {}, store = createMemoryStore()) {
  const cfg = { ...defaultModerationConfig(), ...(config || {}) };
  const whitelist = (Array.isArray(cfg.whitelistDomains) ? cfg.whitelistDomains : [])
    .map((d) => extractHost(d))
    .filter((d) => d && d.includes("."));
  const badWords = (Array.isArray(cfg.badWords) ? cfg.badWords : [])
    .map((w) => String(w).trim().toLowerCase())
    .filter(Boolean);

  function isPrivileged(level, badges) {
    if (level === "broadcaster" || level === "moderator") return true;
    const set = new Set((badges || []).map((b) => String(b).toLowerCase()));
    return set.has("vip");
  }

  function check(msg = {}) {
    if (!cfg.enabled) return null;

    const level = msg.level || "everyone";
    if (isPrivileged(level, msg.badges)) return null;

    const message = String(msg.message || "");
    const key = String(msg.userId || msg.user || "").toLowerCase();
    if (!key || !message.trim()) return null;

    let type = null;
    let reason = "";

    if (cfg.linkProtection) {
      const domain = findDisallowedLink(message, whitelist);
      if (domain) {
        type = "link";
        reason = `ссылка на ${domain}`;
      }
    }
    if (!type && badWords.length) {
      const word = findBadWord(message, badWords);
      if (word) {
        type = "badword";
        reason = "запрещённое слово";
      }
    }
    if (!type && typeof cfg.capsThreshold === "number" && cfg.capsThreshold > 0 && cfg.capsThreshold < 1) {
      if (message.length > 10 && capsRatio(message) > cfg.capsThreshold) {
        type = "caps";
        reason = "слишком много заглавных букв";
      }
    }
    if (!type && Number(cfg.maxEmotes) > 0) {
      const n = countEmotes(msg.emotes);
      if (n > Number(cfg.maxEmotes)) {
        type = "emotes";
        reason = `слишком много смайлов (${n})`;
      }
    }

    if (!type) return null;

    const maxWarns = Math.max(1, Math.round(Number(cfg.maxWarns) || 3));
    const count = (store.get(key) || 0) + 1;
    store.set(key, count);

    const warnTimeoutSec = Math.max(1, Math.round(Number(cfg.warnTimeoutSec) || 600));
    const user = msg.user || "viewer";

    let timeoutSec = 1; // 1-second timeout clears the message without the delete scope
    let ban = false;
    let warning;

    if (count >= maxWarns) {
      ban = true;
      timeoutSec = null;
      warning = `@${user}, ${reason}. Перманентный бан.`;
    } else if (count === 1) {
      warning = `@${user}, ${reason}. Предупреждение 1/${maxWarns}`;
    } else {
      timeoutSec = warnTimeoutSec;
      warning = `@${user}, ${reason}. Таймаут ${Math.round(warnTimeoutSec / 60)} мин. Предупреждение ${count}/${maxWarns}`;
    }

    return { type, warn: count, timeoutSec: ban ? null : timeoutSec, ban, reason, message: warning };
  }

  function resetWarn(key) {
    store.delete(String(key || "").toLowerCase());
  }

  return { check, resetWarn, store };
}

module.exports = {
  createModerationEngine,
  createMemoryStore,
  defaultModerationConfig,
  deleetize,
  countEmotes,
  capsRatio,
  findDisallowedLink,
  findBadWord,
  extractHost,
};
