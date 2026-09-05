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
  Elgato Stream Deck plugin for Open Stream Environment (OSE).

  Scene-only remote: one key per OSE scene (start / brb / wheel / talk / end).
  The active scene is highlighted via a second state, and custom icons from the
  OSE control panel (streamdeck.icons.<scene>) are applied over the defaults.

  Bridges two WebSockets:
    - the Stream Deck application on 127.0.0.1 (registration + key events);
    - the OSE local bus (ws://localhost:8710/ws).
*/

const WebSocket = require("ws");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ---- Command-line arguments passed by the Stream Deck application ----
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^-+/, "");
  args[key] = process.argv[i + 1];
}

const SD_PORT = args.port;
const PLUGIN_UUID = args.pluginUUID;
const REGISTER_EVENT = args.registerEvent;

const OSE_URL = process.env.OSE_WS_URL || "ws://localhost:8710/ws";
const OSE_HTTP_BASE = OSE_URL
  .replace(/^wss:\/\//i, "https://")
  .replace(/^ws:\/\//i, "http://")
  .replace(/\/ws\/?$/, "");

const ACTION_UUID = "com.openstreamenvironment.streamdeck.scene";

const SCENES = [
  ["start", "Start"],
  ["brb", "BRB"],
  ["wheel", "Wheel"],
  ["talk", "Talk"],
  ["main", "Main"],
  ["end", "End"],
  ["poll", "Poll"],
];

let sd = null; // Stream Deck app
let ose = null; // OSE bus
let oseReconnectTimer = null;
let pendingAction = null; // queued remote_action while OSE is offline

// context -> { settings, action }
const instances = new Map();
const iconCache = new Map();   // iconPath -> data URL
const appliedIcon = new Map(); // context -> iconPath

let oseState = {
  activeScene: null,
  icons: { start: "", brb: "", wheel: "", talk: "", main: "", end: "" },
};

function sceneLabel(scene) {
  const found = SCENES.find(([id]) => id === scene);
  return found ? found[1] : String(scene || "start");
}

// ---- OSE bus ----
function connectOse() {
  ose = new WebSocket(OSE_URL);

  ose.on("open", () => {
    console.log("[OSE] connected");
    if (pendingAction) {
      ose.send(JSON.stringify({ type: "remote_action", action: pendingAction.action, payload: pendingAction.payload || {} }));
      pendingAction = null;
    }
  });

  ose.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleOseMessage(msg);
  });

  ose.on("close", () => {
    console.log("[OSE] disconnected, retrying…");
    clearTimeout(oseReconnectTimer);
    oseReconnectTimer = setTimeout(connectOse, 2000);
  });

  ose.on("error", () => {
    if (ose) ose.close();
  });
}

function sendRemoteAction(action, payload) {
  const message = JSON.stringify({ type: "remote_action", action, payload: payload || {} });
  if (ose && ose.readyState === WebSocket.OPEN) {
    ose.send(message);
    pendingAction = null;
  } else {
    pendingAction = { action, payload: payload || {} };
  }
}

function handleOseMessage(msg) {
  switch (msg.type) {
    case "state": {
      const p = msg.payload || {};
      if (p.activeScene) oseState.activeScene = p.activeScene;
      if (p.streamdeck && p.streamdeck.icons) oseState.icons = p.streamdeck.icons;
      syncAll();
      break;
    }
    case "remote_action": {
      if (msg.action === "SCENE_SET" && msg.payload && msg.payload.scene) {
        oseState.activeScene = msg.payload.scene;
        syncAll();
      }
      break;
    }
    default:
      break;
  }
}

// ---- Stream Deck application ----
function connectStreamDeck() {
  sd = new WebSocket(`ws://127.0.0.1:${SD_PORT}`);

  sd.on("open", () => {
    sd.send(JSON.stringify({ event: REGISTER_EVENT, uuid: PLUGIN_UUID }));
    console.log("[SD] registered");
  });

  sd.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleStreamDeckEvent(msg);
  });

  sd.on("close", () => {
    process.exit(0);
  });

  sd.on("error", (err) => {
    console.error("[SD] error", err.message);
  });
}

function sdSend(obj) {
  if (sd && sd.readyState === WebSocket.OPEN) {
    sd.send(JSON.stringify(obj));
  }
}

function setTitle(context, title) {
  sdSend({ event: "setTitle", context, payload: { title: String(title), target: 0 } });
}

function setState(context, state) {
  sdSend({ event: "setState", context, payload: { state: Number(state) || 0 } });
}

function setImage(context, image, state) {
  sdSend({ event: "setImage", context, payload: { image, target: 0, state: Number(state) || 0 } });
}

function fetchImageAsDataUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const ext = (url.split("?")[0].match(/\.([a-zA-Z0-9]+)$/) || [])[1] || "png";
        const mime = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
        }[ext.toLowerCase()] || "image/png";
        resolve(`data:${mime};base64,${buf.toString("base64")}`);
      });
    }).on("error", reject);
  });
}

// Default manifest icons, pre-read so we can restore them after a custom icon
// is cleared. Try both `__dirname` (unbundled) and `process.cwd()` (bundled into
// dist/app.js) since the plugin runs from the plugin root directory.
const DEFAULT_IMAGES = { 0: null, 1: null };

function loadDefaultIcon(file) {
  for (const base of [__dirname, process.cwd()]) {
    try {
      return "data:image/png;base64," + fs.readFileSync(path.join(base, file)).toString("base64");
    } catch {
      // keep trying the next candidate
    }
  }
  return null;
}

DEFAULT_IMAGES[0] = loadDefaultIcon("assets/scene.png");
DEFAULT_IMAGES[1] = loadDefaultIcon("assets/scene-active.png");

function applyCustomIcon(context, iconPath) {
  const prev = appliedIcon.get(context);
  if (prev === iconPath) return;

  if (!iconPath) {
    // Restore the manifest defaults, but only if we had pushed a custom icon.
    if (prev) {
      if (DEFAULT_IMAGES[0]) setImage(context, DEFAULT_IMAGES[0], 0);
      if (DEFAULT_IMAGES[1]) setImage(context, DEFAULT_IMAGES[1], 1);
    }
    appliedIcon.set(context, "");
    return;
  }

  appliedIcon.set(context, iconPath);

  const cached = iconCache.get(iconPath);
  if (cached) {
    setImage(context, cached, 0);
    setImage(context, cached, 1);
    return;
  }
  const url = OSE_HTTP_BASE + "/" + String(iconPath).replace(/^\/+/, "");
  fetchImageAsDataUrl(url)
    .then((dataUrl) => {
      iconCache.set(iconPath, dataUrl);
      setImage(context, dataUrl, 0);
      setImage(context, dataUrl, 1);
    })
    .catch((err) => console.warn("[OSE] icon fetch failed", iconPath, err.message));
}

function sendToPI(context, actionUuid, payload) {
  sdSend({ event: "sendToPropertyInspector", action: actionUuid, context, payload });
}

function handleStreamDeckEvent(msg) {
  switch (msg.event) {
    case "willAppear": {
      const settings = (msg.payload && msg.payload.settings) || {};
      instances.set(msg.context, { settings, action: msg.action });
      sendOptions(msg.context);
      syncInstance(msg.context);
      break;
    }
    case "keyDown": {
      const inst = instances.get(msg.context);
      if (!inst) return;
      const settings = (msg.payload && msg.payload.settings) || inst.settings;
      inst.settings = settings;
      onKeyDown(settings);
      break;
    }
    case "keyUp":
      break;
    case "didReceiveSettings": {
      const inst = instances.get(msg.context);
      if (!inst) return;
      inst.settings = (msg.payload && msg.payload.settings) || {};
      syncInstance(msg.context);
      break;
    }
    case "propertyInspectorDidAppear": {
      // Re-push the scene list when the PI opens.
      sendOptions(msg.context);
      break;
    }
    case "willDisappear":
      instances.delete(msg.context);
      break;
    default:
      break;
  }
}

function onKeyDown(settings) {
  sendRemoteAction("SCENE_SET", { scene: settings.scene || "start" });
}

function sendOptions(context) {
  const inst = instances.get(context);
  if (!inst) return;
  sendToPI(context, inst.action, {
    kind: "scene",
    scenes: SCENES.map(([id, label]) => ({ id, label })),
  });
}

function syncInstance(context) {
  const inst = instances.get(context);
  if (!inst) return;

  const scene = inst.settings.scene || "start";
  setTitle(context, sceneLabel(scene));
  setState(context, oseState.activeScene === scene ? 1 : 0);

  const icon = oseState.icons && oseState.icons[scene];
  applyCustomIcon(context, icon || "");
}

function syncAll() {
  for (const context of instances.keys()) {
    syncInstance(context);
  }
}

connectStreamDeck();
connectOse();
