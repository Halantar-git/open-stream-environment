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

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { getDbPath } = require("./storage-paths");

function defaultData() {
  return {
    // Единый источник истины для раскладки оверлея.
    overlay: { widgets: [] },
    // Сохранённые пользовательские пресеты раскладки (виджеты + геометрия).
    layout_presets: [],
    // Сессии стрима.
    sessions: [],
    // История чата / логов, привязанная к sessionId.
    // Накопление отключено (см. appendChat) — массив оставлен для обратной
    // совместимости и методов очистки истории.
    chatMessages: [],
    // История всех входящих событий (донаты, подписки, фоллоу).
    stream_events: [],
    // Настройки виджета списка участников розыгрыша.
    overlay_participants_config: {
      maxNames: 10,
      marquee: false,
      fontSize: 16,
      textColor: "#e8e1f0",
      backgroundOpacity: 82,
      x: 1.25,
      y: 50,
    },
    // Настройки Колеса Фортуны (звук).
    wheel_config: {
      musicVolume: 50,
    },
    // Настройки скорости вращения Колеса Фортуны.
    wheel_speed_config: {
      speed: 3,
    },
    // Настройки виджета аудио-визуализатора (микрофон).
    overlay_mic_config: {
      sensitivity: 1.5,
      lineWidth: 2,
      color: "", // пусто = цвет берётся из активной темы (--md-primary)
      opacity: 0.9,
      visualizer_mode: "sine", // "sine" | "bars" | "ring" | "equalizer"
      barCount: 32,
      barGap: 2,
      peakFall: 2.5, // скорость спада пика эквалайзера (ячеек/сек)
    },
    // Язык интерфейса ("en" | "ru").
    language: "en",
  };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Аналог _.defaultsDeep из lowdb v1: дополняет данные дефолтами, не затирая
// уже сохранённые значения. Объекты мёрджатся рекурсивно, массивы/примитивы
// берутся из данных, если они уже есть.
function deepDefaults(defaults, data) {
  const out = { ...(data || {}) };
  Object.keys(defaults).forEach((key) => {
    const def = defaults[key];
    const cur = out[key];
    if (cur === undefined || cur === null) {
      out[key] = Array.isArray(def) ? [...def] : isPlainObject(def) ? { ...def } : def;
    } else if (isPlainObject(def) && isPlainObject(cur)) {
      out[key] = deepDefaults(def, cur);
    }
  });
  return out;
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/*
  Лёгкое синхронное JSON-хранилище вместо lowdb v1. Сохраняет прежний файл
  (config/local-db.json), прежнюю схему и прежний API, но без устаревшей
  зависимости. Все чтения идут напрямую из `data`, запись — в `persist()`.
*/
function createDatabase(dbPath = getDbPath()) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let data = deepDefaults(defaultData(), readJson(dbPath));

  function persist() {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
  }
  persist(); // при первом запуске создаём файл с дефолтами

  function get(pathStr) {
    return String(pathStr).split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), data);
  }

  function set(pathStr, value) {
    const keys = String(pathStr).split(".");
    let node = data;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (node[key] == null || typeof node[key] !== "object") node[key] = {};
      node = node[key];
    }
    node[keys[keys.length - 1]] = value;
  }

  function getWidgets() {
    return get("overlay.widgets") || [];
  }

  function saveWidgets(widgets) {
    set("overlay.widgets", widgets);
    persist();
    return widgets;
  }

  function getLayoutPresets() {
    const raw = get("layout_presets");
    return Array.isArray(raw) ? raw : [];
  }

  function saveLayoutPresets(presets) {
    set("layout_presets", Array.isArray(presets) ? presets : []);
    persist();
    return getLayoutPresets();
  }

  function startSession(channel) {
    const session = {
      id: crypto.randomUUID(),
      channel: channel || "",
      startedAt: Date.now(),
      endedAt: null,
    };
    get("sessions").push(session);
    persist();
    return session;
  }

  function endSession(sessionId) {
    const sessions = get("sessions");
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    session.endedAt = Date.now();
    persist();
    return session;
  }

  // Логирование чата отключено для оптимизации производительности:
  // раньше на каждое сообщение выполнялась синхронная запись на диск,
  // что на активном чате заметно тормозило приложение. Сообщения по-прежнему
  // доставляются в оверлей и окно чата по WebSocket.
  function appendChat() {
    return null;
  }

  function getChat(opts = {}) {
    const all = get("chatMessages") || [];
    if (opts.sessionId) return all.filter((m) => m.sessionId === opts.sessionId);
    return all;
  }

  function appendStreamEvent(event) {
    const row = {
      id: event.id || crypto.randomUUID(),
      timestamp: event.timestamp || Date.now(),
      type: event.type,
      kind: event.kind || event.type,
      username: event.username || "Аноним",
      amount: typeof event.amount === "number" ? event.amount : null,
      currency: event.currency || null,
      message: event.message || "",
      is_test: !!event.is_test,
      count: typeof event.count === "number" ? event.count : null,
      tier: event.tier || null,
    };
    get("stream_events").push(row);
    persist();
    return row;
  }

  function getStreamEventById(id) {
    return get("stream_events").find((e) => e.id === id) || null;
  }

  function getStreamEvents(opts = {}) {
    const limit = Math.max(1, Number(opts.limit) || 50);
    const offset = Math.max(0, Number(opts.offset) || 0);
    let all = get("stream_events") || [];

    if (opts.type) {
      all = all.filter((e) => e.type === opts.type);
    }
    if (opts.includeTest === false) {
      all = all.filter((e) => !e.is_test);
    }
    if (opts.search) {
      const q = String(opts.search).trim().toLowerCase();
      if (q) {
        all = all.filter((e) =>
          String(e.username || "").toLowerCase().includes(q) ||
          String(e.message || "").toLowerCase().includes(q)
        );
      }
    }

    const sorted = [...all].sort((a, b) => b.timestamp - a.timestamp);
    return {
      items: sorted.slice(offset, offset + limit),
      total: sorted.length,
    };
  }

  function getSessions() {
    return get("sessions") || [];
  }

  function getParticipantsConfig() {
    const raw = get("overlay_participants_config") || {};
    return {
      maxNames: typeof raw.maxNames === "number" ? raw.maxNames : 10,
      marquee: !!raw.marquee,
      fontSize: typeof raw.fontSize === "number" ? raw.fontSize : 16,
      textColor: typeof raw.textColor === "string" ? raw.textColor : "#e8e1f0",
      backgroundOpacity: typeof raw.backgroundOpacity === "number" ? raw.backgroundOpacity : 82,
      x: typeof raw.x === "number" ? raw.x : 1.25,
      y: typeof raw.y === "number" ? raw.y : 50,
    };
  }

  function saveParticipantsConfig(config) {
    const next = { ...getParticipantsConfig(), ...(config || {}) };
    set("overlay_participants_config", next);
    persist();
    return next;
  }

  function getWheelConfig() {
    const raw = get("wheel_config") || {};
    return { musicVolume: typeof raw.musicVolume === "number" ? raw.musicVolume : 50 };
  }

  function saveWheelConfig(config) {
    const next = { ...getWheelConfig(), ...(config || {}) };
    set("wheel_config", next);
    persist();
    return next;
  }

  function getWheelSpeedConfig() {
    const raw = get("wheel_speed_config") || {};
    return { speed: typeof raw.speed === "number" ? raw.speed : 3 };
  }

  function saveWheelSpeedConfig(config) {
    const next = { ...getWheelSpeedConfig(), ...(config || {}) };
    set("wheel_speed_config", next);
    persist();
    return next;
  }

  function getMicConfig() {
    const raw = get("overlay_mic_config") || {};
    const mode =
      raw.visualizer_mode === "bars" ||
      raw.visualizer_mode === "ring" ||
      raw.visualizer_mode === "equalizer"
        ? raw.visualizer_mode
        : "sine";
    return {
      sensitivity: typeof raw.sensitivity === "number" ? raw.sensitivity : 1.5,
      lineWidth: typeof raw.lineWidth === "number" ? raw.lineWidth : 2,
      color: typeof raw.color === "string" ? raw.color : "",
      opacity: typeof raw.opacity === "number" ? raw.opacity : 0.9,
      visualizer_mode: mode,
      barCount: Math.min(64, Math.max(10, Math.round(Number(raw.barCount) || 32))),
      barGap: typeof raw.barGap === "number" ? raw.barGap : 2,
      peakFall: Math.min(10, Math.max(0.5, Number(raw.peakFall) || 2.5)),
    };
  }

  function saveMicConfig(config) {
    const next = { ...getMicConfig(), ...(config || {}) };
    set("overlay_mic_config", next);
    persist();
    return next;
  }

  function getLanguage() {
    return get("language") === "ru" ? "ru" : "en";
  }

  function saveLanguage(lang) {
    const next = lang === "ru" ? "ru" : "en";
    set("language", next);
    persist();
    return next;
  }

  function clearStreamEvents() {
    set("stream_events", []);
    persist();
    return true;
  }

  function clearHistory() {
    set("sessions", []);
    set("chatMessages", []);
    set("stream_events", []);
    persist();
    return true;
  }

  function clearAll() {
    data = deepDefaults(defaultData(), {});
    persist();
    return true;
  }

  return {
    getWidgets,
    saveWidgets,
    getLayoutPresets,
    saveLayoutPresets,
    startSession,
    endSession,
    appendChat,
    getChat,
    getSessions,
    appendStreamEvent,
    getStreamEventById,
    getStreamEvents,
    getParticipantsConfig,
    saveParticipantsConfig,
    getWheelConfig,
    saveWheelConfig,
    getWheelSpeedConfig,
    saveWheelSpeedConfig,
    getMicConfig,
    saveMicConfig,
    getLanguage,
    saveLanguage,
    clearStreamEvents,
    clearHistory,
    clearAll,
  };
}

module.exports = { createDatabase, defaultData };
