const WebSocket = require("ws");

/**
 * Follows/subs/cheers via Twitch EventSub over WebSocket:
 * https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
 *
 * Requires a User Access Token (not an app token — EventSub's WebSocket
 * transport only accepts subscriptions authorized by the connecting
 * user) with scopes: moderator:read:followers, channel:read:subscriptions,
 * bits:read. Obtained via Settings -> Connect Twitch in the control panel.
 */

const SUBSCRIPTIONS = [
  { type: "channel.follow", version: "2", condition: (id) => ({ broadcaster_user_id: id, moderator_user_id: id }) },
  { type: "channel.subscribe", version: "1", condition: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.subscription.gift", version: "1", condition: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.cheer", version: "1", condition: (id) => ({ broadcaster_user_id: id }) },
];

function startTwitchEvents({ bus, state }) {
  let ws;
  let stopped = false;
  const initialUrl = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";

  function connect(url) {
    if (stopped) return;
    bus.emit("connection_status", { service: "twitchEvents", status: "connecting" });
    ws = new WebSocket(url);

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const type = msg.metadata && msg.metadata.message_type;

      if (type === "session_welcome") {
        const sessionId = msg.payload.session.id;
        try {
          await subscribeAll(state.config.twitch, sessionId);
          bus.emit("connection_status", { service: "twitchEvents", status: "connected" });
          fetchInitialStats(state.config.twitch, bus);
        } catch (err) {
          console.error("[twitch-eventsub] subscribe failed:", err.message);
          bus.emit("connection_status", { service: "twitchEvents", status: "error" });
        }
      } else if (type === "session_reconnect") {
        const reconnectUrl = msg.payload.session.reconnect_url;
        const old = ws;
        connect(reconnectUrl);
        setTimeout(() => old.close(), 5000);
      } else if (type === "notification") {
        handleNotification(msg.payload, bus);
      }
    });

    ws.on("close", () => {
      if (stopped) return;
      bus.emit("connection_status", { service: "twitchEvents", status: "disconnected" });
      setTimeout(() => connect(initialUrl), 3000);
    });

    ws.on("error", (err) => {
      console.error("[twitch-eventsub] socket error", err.message);
    });
  }

  connect(initialUrl);

  return {
    stop() {
      stopped = true;
      if (ws) ws.close();
    },
  };
}

async function fetchInitialStats(twitchConfig, bus) {
  const headers = { "Client-Id": twitchConfig.clientId, Authorization: `Bearer ${twitchConfig.userAccessToken}` };
  const snapshot = {};
  try {
    const res = await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${twitchConfig.broadcasterId}&first=1`, { headers });
    if (res.ok) snapshot.followerCount = (await res.json()).total;
  } catch (err) {
    console.error("[twitch-eventsub] followers total fetch failed:", err.message);
  }
  try {
    const res = await fetch(`https://api.twitch.tv/helix/subscriptions?broadcaster_id=${twitchConfig.broadcasterId}&first=1`, { headers });
    if (res.ok) snapshot.subscriberCount = (await res.json()).total;
  } catch (err) {
    console.error("[twitch-eventsub] subscribers total fetch failed:", err.message);
  }
  if (Object.keys(snapshot).length) bus.emit("stat_snapshot", snapshot);
}

async function subscribeAll(twitchConfig, sessionId) {
  if (!twitchConfig.broadcasterId) throw new Error("no broadcasterId — reconnect via Settings");
  for (const sub of SUBSCRIPTIONS) {
    const res = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
      method: "POST",
      headers: {
        "Client-Id": twitchConfig.clientId,
        Authorization: `Bearer ${twitchConfig.userAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: sub.type,
        version: sub.version,
        condition: sub.condition(twitchConfig.broadcasterId),
        transport: { method: "websocket", session_id: sessionId },
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`${sub.type}: ${res.status} ${body.message || ""}`);
    }
  }
}

function handleNotification(payload, bus) {
  const type = payload.subscription.type;
  const event = payload.event;
  switch (type) {
    case "channel.follow":
      bus.emit("alert", { kind: "follow", user: event.user_name });
      bus.emit("stat_delta", { followerDelta: 1 });
      break;
    case "channel.subscribe":
      if (event.is_gift) return; // gift recipients also fire this; the gifter is reported via channel.subscription.gift
      bus.emit("alert", { kind: "sub", user: event.user_name, tier: event.tier });
      bus.emit("stat_delta", { subscriberDelta: 1 });
      break;
    case "channel.subscription.gift":
      bus.emit("alert", {
        kind: "gift_sub",
        user: event.is_anonymous ? "Аноним" : event.user_name,
        count: event.total,
        tier: event.tier,
      });
      bus.emit("stat_delta", { subscriberDelta: event.total || 1 });
      break;
    case "channel.cheer":
      bus.emit("alert", {
        kind: "cheer",
        user: event.is_anonymous ? "Аноним" : event.user_name,
        amount: event.bits,
      });
      break;
    default:
      break;
  }
}

module.exports = { startTwitchEvents };
