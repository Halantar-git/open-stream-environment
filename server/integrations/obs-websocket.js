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
  OBS WebSocket client (obs-websocket protocol v5, built into OBS 28+).

  Connects to the OBS WebSocket server, performs the v5 handshake
  (Hello -> Identify with challenge-response auth), keeps the connection
  status in sync on the bus and exposes `switchScene(sceneName)` so remote
  quick actions can drive `SetCurrentProgramScene`.
*/

const crypto = require("crypto");
const WebSocket = require("ws");

function sha256Base64(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("base64");
}

// obs-websocket v5 authentication:
//   secret = base64(sha256(password + salt))
//   auth   = base64(sha256(secret + challenge))
function computeAuth(password, challenge, salt) {
  const secret = sha256Base64(`${password}${salt}`);
  return sha256Base64(`${secret}${challenge}`);
}

// План переключения: для целевого ракурса включаем источник, для остальных —
// выключаем. Углы без sceneName/cameraSource пропускаются.
function buildCameraSwitchPlan(angles, angleId) {
  return (Array.isArray(angles) ? angles : [])
    .filter((a) => a.sceneName && a.cameraSource)
    .map((a) => ({
      sceneName: a.sceneName,
      cameraSource: a.cameraSource,
      enabled: a.id === angleId,
    }));
}

function startObsWebSocket({ bus, config }) {
  let ws = null;
  let connected = false;
  let stopped = false;
  let reconnectTimer = null;
  let nextRequestId = 1;
  const pending = new Map();
  const filterTimers = new Map(); // filterId -> setTimeout handle

  function log(level, message, data) {
    bus.emit("terminal_log", { timestamp: Date.now(), service: "obs", level, message, data: data ?? null });
  }

  function setStatus(status) {
    bus.emit("connection_status", { service: "obs", status });
  }

  function connect() {
    if (stopped) return;
    const { host, port, password } = config.obs || {};
    if (!host || !port) {
      setStatus("not_configured");
      return;
    }

    setStatus("connecting");
    ws = new WebSocket(`ws://${host}:${port}`);

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.op === 0) {
        // Hello — identify now that we have the optional auth challenge/salt.
        const challengeInfo = msg.d && msg.d.authentication;
        if (challengeInfo && challengeInfo.challenge && challengeInfo.salt) {
          if (password) {
            const token = computeAuth(password, challengeInfo.challenge, challengeInfo.salt);
            ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, authentication: token } }));
            log("info", "OBS authentication sent");
          } else {
            log("warn", "OBS requires a password but none is configured", { host, port });
            ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1 } }));
          }
        } else {
          ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1 } }));
        }
      } else if (msg.op === 2) {
        connected = true;
        setStatus("connected");
        log("success", "connected to OBS WebSocket", { host, port });
      } else if (msg.op === 7 && msg.d) {
        const requestId = String(msg.d.requestId);
        const entry = pending.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timeout);
        pending.delete(requestId);
        if (msg.d.requestStatus && msg.d.requestStatus.result) {
          entry.resolve(msg.d.responseData || {});
        } else {
          const code = msg.d.requestStatus && msg.d.requestStatus.code;
          const comment = msg.d.requestStatus && msg.d.requestStatus.comment;
          log("warn", "OBS request failed", { requestType: msg.d.requestType, code, comment });
          entry.reject(new Error(`OBS request failed (${code}) ${comment || ""}`.trim()));
        }
      }
    });

    ws.on("close", () => {
      connected = false;
      if (!stopped) setStatus("disconnected");
      if (!stopped) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 3000);
      }
    });

    ws.on("error", (err) => {
      log("warn", "OBS WebSocket error", { message: err.message });
      if (ws) ws.close();
    });
  }

  function switchScene(sceneName) {
    if (!sceneName) {
      log("warn", "scene switch skipped (empty OBS scene name)");
      return false;
    }
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      log("warn", "scene switch skipped (OBS not connected)", { sceneName });
      return false;
    }

    ws.send(
      JSON.stringify({
        op: 6,
        d: {
          requestType: "SetCurrentProgramScene",
          requestId: String(nextRequestId++),
          requestData: { sceneName },
        },
      })
    );
    log("info", "switching OBS scene", { sceneName });
    return true;
  }

  function sendRawRequest(requestType, requestData = {}) {
    return new Promise((resolve, reject) => {
      if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("OBS не подключен"));
        return;
      }
      const requestId = String(nextRequestId++);
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`OBS request timeout: ${requestType}`));
      }, 10000);
      pending.set(requestId, { resolve, reject, timeout });
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      log("info", "OBS raw request", { requestType });
    });
  }

  // Permanent camera-angle switch: enable the target camera source and disable
  // all other configured camera sources (no timer). Emits `camera_angle_changed`
  // on success so the server can broadcast the active angle to every client.
  function setCameraAngle(angleId) {
    const angles = Array.isArray(config.obs && config.obs.cameraAngles) ? config.obs.cameraAngles : [];
    if (!angles.length) {
      return Promise.reject(new Error("No camera angles configured"));
    }
    const target = angles.find((a) => a.id === angleId);
    if (!target) {
      return Promise.reject(new Error(`Unknown camera angle: ${angleId}`));
    }
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("OBS не подключен"));
    }

    const plan = buildCameraSwitchPlan(angles, angleId);
    const jobs = plan.map(async (op) => {
      const { sceneItemId } = await sendRawRequest("GetSceneItemId", {
        sceneName: op.sceneName,
        sourceName: op.cameraSource,
      });
      await sendRawRequest("SetSceneItemEnabled", {
        sceneName: op.sceneName,
        sceneItemId,
        sceneItemEnabled: op.enabled,
      });
    });

    return Promise.all(jobs).then(() => {
      log("info", "camera angle set", { angleId });
      bus.emit("camera_angle_changed", { activeCameraAngle: angleId });
      return { activeCameraAngle: angleId };
    });
  }

  // Trigger an OBS source filter. Timed filters (durationSec > 0) enable the
  // filter and auto-disable it after the configured duration; durationSec === 0
  // toggles the current on/off state. Emits `camera_filter_changed` so the
  // server can broadcast the active state to remote + control panel.
  function triggerCameraFilter(filterId) {
    const filters = Array.isArray(config.obs && config.obs.cameraFilters) ? config.obs.cameraFilters : [];
    const filter = filters.find((f) => f.id === filterId);
    if (!filter) {
      return Promise.reject(new Error(`Unknown camera filter: ${filterId}`));
    }
    if (!filter.sourceName || !filter.filterName) {
      return Promise.reject(new Error(`Camera filter ${filterId} missing sourceName/filterName`));
    }
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("OBS не подключен"));
    }

    const durationSec = Math.max(0, Number(filter.durationSec) || 0);
    const req = { sourceName: filter.sourceName, filterName: filter.filterName };

    if (durationSec > 0) {
      return sendRawRequest("SetSourceFilterEnabled", { ...req, filterEnabled: true }).then(() => {
        bus.emit("camera_filter_changed", { filterId, active: true });

        const existing = filterTimers.get(filterId);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          filterTimers.delete(filterId);
          sendRawRequest("SetSourceFilterEnabled", { ...req, filterEnabled: false })
            .then(() => bus.emit("camera_filter_changed", { filterId, active: false }))
            .catch((err) => log("warn", "camera filter auto-disable failed", { filterId, message: err.message }));
        }, durationSec * 1000);
        filterTimers.set(filterId, timer);

        return { filterId, active: true };
      });
    }

    return sendRawRequest("GetSourceFilter", req).then(({ filterEnabled }) => {
      const next = !filterEnabled;
      return sendRawRequest("SetSourceFilterEnabled", { ...req, filterEnabled: next }).then(() => {
        bus.emit("camera_filter_changed", { filterId, active: next });
        return { filterId, active: next };
      });
    });
  }

  function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    for (const timer of filterTimers.values()) clearTimeout(timer);
    filterTimers.clear();
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      ws = null;
    }
    connected = false;
  }

  connect();

  return { stop, switchScene, sendRawRequest, setCameraAngle, triggerCameraFilter, isConnected: () => connected };
}

module.exports = { startObsWebSocket, computeAuth, sha256Base64, buildCameraSwitchPlan };
