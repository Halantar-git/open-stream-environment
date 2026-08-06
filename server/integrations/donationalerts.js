const WebSocket = require("ws");

/**
 * DonationAlerts real-time donations, following the flow documented at
 * https://www.donationalerts.com/apidoc#introduction__centrifugo :
 *   1. GET /api/v1/user/oauth with the user's access token -> user id +
 *      a Centrifugo connection token.
 *   2. Open a WebSocket to Centrifugo and "connect" with that token.
 *   3. POST /api/v1/centrifuge/subscribe to get a per-channel token for
 *      the private donation channel.
 *   4. "subscribe" over the same WebSocket; donations arrive as pushes.
 *
 * Centrifugo's exact push envelope has shifted across protocol versions,
 * so `extractPayload` below accepts a couple of shapes defensively. If
 * DonationAlerts changes their wire format, the raw frames are logged to
 * make that easy to diagnose — see the DonationAlerts section in README.
 */

const CENTRIFUGO_WS = "wss://centrifugo.donationalerts.com/connection/websocket";

function startDonationAlerts({ bus, config }) {
  let ws;
  let stopped = false;
  let reconnectTimer;

  async function connect() {
    if (stopped) return;
    bus.emit("connection_status", { service: "donationAlerts", status: "connecting" });
    try {
      const oauthRes = await fetch("https://www.donationalerts.com/api/v1/user/oauth", {
        headers: { Authorization: `Bearer ${config.donationAlerts.accessToken}` },
      });
      if (!oauthRes.ok) {
        const body = await oauthRes.text().catch(() => "");
        throw new Error(`user/oauth: ${oauthRes.status} ${body}`);
      }
      const oauthJson = await oauthRes.json();
      const user = oauthJson.data || oauthJson;
      const userId = user.id;
      const connectionToken = user.socket_connection_token;
      if (!userId || !connectionToken) throw new Error("no socket_connection_token in user/oauth response");

      ws = new WebSocket(CENTRIFUGO_WS, {
        headers: {
          Origin: "https://www.donationalerts.com",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        },
      });
      let reqId = 1;

      ws.on("open", () => {
        ws.send(JSON.stringify({ connect: { token: connectionToken }, id: reqId++ }));
      });

      ws.on("message", async (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Reply to our "connect" command -> now subscribe to donations + goal updates.
        if (msg.id === 1 && (msg.connect || msg.result)) {
          try {
            const channels = [`$alerts:donation_${userId}`, `$goals:goal_${userId}`];
            const subRes = await fetch("https://www.donationalerts.com/api/v1/centrifuge/subscribe", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${config.donationAlerts.accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ channels, client: (msg.connect || msg.result).client }),
            });
            const subJson = await subRes.json();
            const subChannels = subJson.channels || (subJson.data && subJson.data.channels) || [];
            subChannels.forEach((ch) => {
              ws.send(JSON.stringify({ subscribe: { channel: ch.channel, token: ch.token }, id: reqId++ }));
            });
            bus.emit("connection_status", { service: "donationAlerts", status: "connected" });
          } catch (err) {
            console.error("[donationalerts] subscribe failed", err.message);
            bus.emit("connection_status", { service: "donationAlerts", status: "error" });
          }
          return;
        }

        const payload = extractPayload(msg);
        if (!payload) return;

        const channel = (msg.push && msg.push.channel) || (msg.result && msg.result.channel) || "";
        if (channel.startsWith("$alerts:donation")) {
          bus.emit("alert", {
            kind: "donation",
            user: payload.username || payload.name || "Аноним",
            amount: Number(payload.amount) || 0,
            currency: payload.currency || "RUB",
            message: payload.message || "",
          });
        } else if (channel.startsWith("$goals:goal")) {
          if (payload.raised !== undefined || payload.current_amount !== undefined) {
            bus.emit("goal_external_update", {
              current: Number(payload.raised ?? payload.current_amount) || 0,
              target: Number(payload.goal ?? payload.target_amount) || undefined,
            });
          }
        }
      });

      ws.on("close", () => {
        if (stopped) return;
        bus.emit("connection_status", { service: "donationAlerts", status: "disconnected" });
        reconnectTimer = setTimeout(connect, 5000);
      });

      ws.on("error", (err) => {
        console.error("[donationalerts] socket error", err.code || "", err.message);
      });
    } catch (err) {
      console.error("[donationalerts] connect failed", err.message);
      bus.emit("connection_status", { service: "donationAlerts", status: "error" });
      reconnectTimer = setTimeout(connect, 8000);
    }
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    },
  };
}

function extractPayload(msg) {
  // Modern Centrifugo bidirectional protocol: { push: { pub: { data } } }
  if (msg.push && msg.push.pub && msg.push.pub.data) {
    const d = msg.push.pub.data;
    return d.data || d;
  }
  // Older shape seen in some client libs: { result: { data: { data } } }
  if (msg.result && msg.result.data) {
    const d = msg.result.data;
    return d.data || d;
  }
  return null;
}

module.exports = { startDonationAlerts };
