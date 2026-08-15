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

const tmi = require("tmi.js");

const { createLogger } = require("../logger");

/**
 * Reads chat as an anonymous viewer (tmi.js's "justinfan" mode) — no
 * Twitch app or token required, just the channel name. This only lets us
 * read; follows/subs/cheers need EventSub (see twitch-eventsub.js).
 */
function startTwitchChat({ bus, channel }) {
  const logger = createLogger(bus, "twitch-chat");

  if (!channel) {
    logger.warn("no channel configured");
    bus.emit("connection_status", { service: "twitchChat", status: "not_configured" });
    return { stop() {} };
  }

  const client = new tmi.Client({
    options: { skipMembership: true },
    connection: { reconnect: true, secure: true },
    channels: [channel],
  });

  client.on("message", (_channel, tags, message, self) => {
    if (self) return;
    bus.emit("chat_message", {
      user: tags["display-name"] || tags.username || "viewer",
      color: tags.color || "#c9c1d6",
      badges: Object.keys(tags.badges || {}),
      message,
      emotes: tags.emotes || {},
    });
  });

  client.on("connected", () => {
    logger.success("connected to chat", { channel });
    bus.emit("connection_status", { service: "twitchChat", status: "connected" });
  });
  client.on("disconnected", () => {
    logger.warn("chat disconnected", { channel });
    bus.emit("connection_status", { service: "twitchChat", status: "disconnected" });
  });

  logger.info("connecting to chat", { channel });
  bus.emit("connection_status", { service: "twitchChat", status: "connecting" });
  client.connect().catch((err) => {
    logger.error("chat connect failed", { message: err.message });
    bus.emit("connection_status", { service: "twitchChat", status: "error" });
  });

  return {
    stop() {
      client.disconnect().catch(() => {});
    },
  };
}

module.exports = { startTwitchChat };
