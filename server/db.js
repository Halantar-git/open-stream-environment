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

const crypto = require("crypto");
const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");

const { getDbPath } = require("./storage-paths");

function defaultData() {
  return {
    // Единый источник истины для раскладки оверлея.
    overlay: { widgets: [] },
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
      color: "#0060A8",
      opacity: 0.9,
      visualizer_mode: "sine", // "sine" | "bars" | "ring"
      barCount: 32,
      barGap: 2,
    },
    // Язык интерфейса ("en" | "ru").
    language: "en",
  };
}

function createDatabase(dbPath = getDbPath()) {
  const adapter = new FileSync(dbPath);
  const db = low(adapter);
  db.defaults(defaultData()).write();

  function getWidgets() {
    return db.get("overlay.widgets").value() || [];
  }

  function saveWidgets(widgets) {
    db.get("overlay").set("widgets", widgets).write();
    return widgets;
  }

  function startSession(channel) {
    const session = {
      id: crypto.randomUUID(),
      channel: channel || "",
      startedAt: Date.now(),
      endedAt: null,
    };
    db.get("sessions").push(session).write();
    return session;
  }

  function endSession(sessionId) {
    const session = db.get("sessions").find({ id: sessionId }).value();
    if (!session) return null;
    db.get("sessions").find({ id: sessionId }).assign({ endedAt: Date.now() }).write();
    return db.get("sessions").find({ id: sessionId }).value();
  }

  // Логирование чата отключено для оптимизации производительности:
  // раньше на каждое сообщение выполнялась синхронная запись на диск
  // (db.write()), что на активном чате заметно тормозило приложение.
  // Сообщения по-прежнему доставляются в оверлей и окно чата по WebSocket.
  function appendChat() {
    return null;
  }

  function getChat(opts = {}) {
    if (opts.sessionId) return db.get("chatMessages").filter({ sessionId: opts.sessionId }).value();
    return db.get("chatMessages").value();
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
    db.get("stream_events").push(row).write();
    return row;
  }

  function getStreamEventById(id) {
    return db.get("stream_events").find({ id }).value() || null;
  }

  function getStreamEvents(opts = {}) {
    const limit = Math.max(1, Number(opts.limit) || 50);
    const offset = Math.max(0, Number(opts.offset) || 0);
    let all = db.get("stream_events").value() || [];

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
    return db.get("sessions").value();
  }

  function getParticipantsConfig() {
    const raw = db.get("overlay_participants_config").value() || {};
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
    db.set("overlay_participants_config", next).write();
    return next;
  }

  function getWheelConfig() {
    const raw = db.get("wheel_config").value() || {};
    return { musicVolume: typeof raw.musicVolume === "number" ? raw.musicVolume : 50 };
  }

  function saveWheelConfig(config) {
    const next = { ...getWheelConfig(), ...(config || {}) };
    db.set("wheel_config", next).write();
    return next;
  }

  function getWheelSpeedConfig() {
    const raw = db.get("wheel_speed_config").value() || {};
    return { speed: typeof raw.speed === "number" ? raw.speed : 3 };
  }

  function saveWheelSpeedConfig(config) {
    const next = { ...getWheelSpeedConfig(), ...(config || {}) };
    db.set("wheel_speed_config", next).write();
    return next;
  }

  function getMicConfig() {
    const raw = db.get("overlay_mic_config").value() || {};
    const mode = raw.visualizer_mode === "bars" || raw.visualizer_mode === "ring" ? raw.visualizer_mode : "sine";
    return {
      sensitivity: typeof raw.sensitivity === "number" ? raw.sensitivity : 1.5,
      lineWidth: typeof raw.lineWidth === "number" ? raw.lineWidth : 2,
      color: typeof raw.color === "string" ? raw.color : "#0060A8",
      opacity: typeof raw.opacity === "number" ? raw.opacity : 0.9,
      visualizer_mode: mode,
      barCount: Math.min(64, Math.max(10, Math.round(Number(raw.barCount) || 32))),
      barGap: typeof raw.barGap === "number" ? raw.barGap : 2,
    };
  }

  function saveMicConfig(config) {
    const next = { ...getMicConfig(), ...(config || {}) };
    db.set("overlay_mic_config", next).write();
    return next;
  }

  function getLanguage() {
    const raw = db.get("language").value();
    return raw === "ru" ? "ru" : "en";
  }

  function saveLanguage(lang) {
    const next = lang === "ru" ? "ru" : "en";
    db.set("language", next).write();
    return next;
  }

  function clearStreamEvents() {
    db.set("stream_events", []).write();
    return true;
  }

  function clearHistory() {
    db.set("sessions", []).write();
    db.set("chatMessages", []).write();
    db.set("stream_events", []).write();
    return true;
  }

  function clearAll() {
    const defaults = defaultData();
    Object.keys(defaults).forEach((key) => {
      db.set(key, defaults[key]).write();
    });
    return true;
  }

  return {
    raw: db,
    getWidgets,
    saveWidgets,
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
