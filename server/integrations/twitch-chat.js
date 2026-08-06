const tmi = require("tmi.js");

/**
 * Reads chat as an anonymous viewer (tmi.js's "justinfan" mode) — no
 * Twitch app or token required, just the channel name. This only lets us
 * read; follows/subs/cheers need EventSub (see twitch-eventsub.js).
 */
function startTwitchChat({ bus, channel }) {
  if (!channel) {
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
    });
  });

  client.on("connected", () => bus.emit("connection_status", { service: "twitchChat", status: "connected" }));
  client.on("disconnected", () => bus.emit("connection_status", { service: "twitchChat", status: "disconnected" }));

  bus.emit("connection_status", { service: "twitchChat", status: "connecting" });
  client.connect().catch((err) => {
    console.error("[twitch-chat] connect failed", err.message);
    bus.emit("connection_status", { service: "twitchChat", status: "error" });
  });

  return {
    stop() {
      client.disconnect().catch(() => {});
    },
  };
}

module.exports = { startTwitchChat };
