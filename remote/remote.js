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
  Web Remote / Stream Deck — mobile quick-action pad.

  Connects to the same WebSocket bus as the overlay and control panel, sends
  `REMOTE_ACTION` commands, and reflects the server state (themes + death
  counter). Auto-reconnects when the phone screen locks or the Wi-Fi blips.
*/
(function () {
  const EVENT_TYPES = (window.SharedEvents && window.SharedEvents.EVENT_TYPES) || {
    REMOTE_ACTION: "remote_action",
    STATE: "state",
    THEME_UPDATE: "theme_update",
    DEATH_COUNT_UPDATE: "death_count_update",
    CAMERA_ANGLE_UPDATE: "camera_angle_update",
    CAMERA_FILTER_UPDATE: "camera_filter_update",
    OVERLAY_PARTICIPANTS_CONFIG: "overlay_participants_config",
    WHEEL_CONFIG: "wheel_config",
    WHEEL_SPEED_CONFIG: "wheel_speed_config",
    GIVEAWAY_UPDATE: "giveaway_update",
    GIVEAWAY_PARTICIPANTS: "giveaway_participants",
    CHAT_MESSAGE: "chat_message",
    LOCALES: "locales",
    CMD_SET_PARTICIPANTS_CONFIG: "cmd_set_participants_config",
    CMD_SET_WHEEL_CONFIG: "cmd_set_wheel_config",
    CMD_SET_WHEEL_SPEED_CONFIG: "cmd_set_wheel_speed_config",
    CMD_SET_GIVEAWAY_ELIMINATION: "cmd_set_giveaway_elimination",
    CMD_ADD_GIVEAWAY_PARTICIPANT: "cmd_add_giveaway_participant",
    CMD_REMOVE_GIVEAWAY_PARTICIPANT: "cmd_remove_giveaway_participant",
    CMD_CLEAR_GIVEAWAY_PARTICIPANTS: "cmd_clear_giveaway_participants",
    CMD_TEST_CHAT: "cmd_test_chat",
  };

  const wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

  const t = (key, params) => (window.I18n ? window.I18n.t(key, params) : key);

  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const deathValue = document.getElementById("deathValue");
  const sceneGrid = document.getElementById("sceneGrid");
  const wheelGrid = document.getElementById("wheelGrid");
  const alertGrid = document.getElementById("alertGrid");
  const themeGrid = document.getElementById("themeGrid");
  const obsCommandGrid = document.getElementById("obsCommandGrid");
  const cameraGrid = document.getElementById("cameraGrid");
  const filterGrid = document.getElementById("filterGrid");
  const chatList = document.getElementById("remoteChatList");
  const wheelCommand = document.getElementById("wheelCommand");
  const wheelElimination = document.getElementById("wheelElimination");
  const wsMaxNames = document.getElementById("wsMaxNames");
  const wsFontSize = document.getElementById("wsFontSize");
  const wsTextColor = document.getElementById("wsTextColor");
  const wsBgOpacity = document.getElementById("wsBgOpacity");
  const wsBgOpacityValue = document.getElementById("wsBgOpacityValue");
  const wsX = document.getElementById("wsX");
  const wsXValue = document.getElementById("wsXValue");
  const wsY = document.getElementById("wsY");
  const wsYValue = document.getElementById("wsYValue");
  const wsW = document.getElementById("wsW");
  const wsH = document.getElementById("wsH");
  const wsMarquee = document.getElementById("wsMarquee");
  const wsMusicVolume = document.getElementById("wsMusicVolume");
  const wsMusicVolumeValue = document.getElementById("wsMusicVolumeValue");
  const wsSpeed = document.getElementById("wsSpeed");
  const wsSpeedValue = document.getElementById("wsSpeedValue");
  const wheelParticipantsCount = document.getElementById("wheelParticipantsCount");
  const wheelParticipantsList = document.getElementById("wheelParticipantsList");
  const wheelParticipantName = document.getElementById("wheelParticipantName");
  const wheelAddParticipant = document.getElementById("wheelAddParticipant");
  const wheelClearParticipants = document.getElementById("wheelClearParticipants");

  let ws = null;
  let reconnectTimer = null;
  let isConnected = false;
  let hasLocales = false;
  let themes = [];
  let activeThemeId = null;
  let enable3d = false;
  let activeScene = null;
  let obsCommands = [];
  let cameraAngles = [];
  let activeCameraAngle = null;
  let cameraFilters = [];
  let activeFilters = [];
  let participantsConfig = { maxNames: 10, marquee: false, fontSize: 16, textColor: "#e8e1f0", backgroundOpacity: 82, x: 24, y: 340, w: 340, h: 400 };
  let wheelConfig = { musicVolume: 50 };
  let wheelSpeedConfig = { speed: 3 };
  let giveaway = { command: "!go", eliminationMode: false, participants: [], count: 0 };

  function setStatus(connected) {
    isConnected = connected;
    statusDot.classList.toggle("is-connected", connected);
    if (hasLocales) {
      statusText.textContent = connected ? t("remote.connected") : t("remote.reconnecting");
    }
  }

  function vibrate() {
    if (navigator.vibrate) {
      try {
        navigator.vibrate(40);
      } catch {
        /* vibration is best-effort (secure-context / device dependent) */
      }
    }
  }

  function send(action, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: EVENT_TYPES.REMOTE_ACTION, action, payload }));
    }
  }

  function sendCommand(type, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload: payload || {} }));
    }
  }

  function setSwitch(el, on) {
    if (!el) return;
    el.classList.toggle("is-on", !!on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  }

  function makeButton(label, action, payload, opts) {
    opts = opts || {};
    const btn = document.createElement("button");
    btn.className = "action-btn" + (opts.className ? " " + opts.className : "");
    btn.textContent = label;
    if (opts.title) btn.title = opts.title;
    btn.addEventListener("click", () => {
      vibrate();
      const p = typeof payload === "function" ? payload() : (payload || {});
      send(action, p);
    });
    return btn;
  }

  function renderScenes() {
    sceneGrid.innerHTML = "";
    const SCENE_CLASS = {
      main: "action-btn--main",
      start: "action-btn--start",
      end: "action-btn--end",
    };
    [
      [t("scene.startLabel"), "start"],
      [t("scene.mainLabel"), "main"],
      [t("scene.brbLabel"), "brb"],
      [t("scene.talkLabel"), "talk"],
      [t("scene.endLabel"), "end"],
      [t("scene.wheelLabel"), "wheel"],
      [t("scene.pollLabel"), "poll"],
    ].forEach(([label, scene]) => {
      const btn = document.createElement("button");
      btn.className = "action-btn" + (SCENE_CLASS[scene] ? " " + SCENE_CLASS[scene] : "") + (scene === activeScene ? " is-active" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => {
        vibrate();
        activeScene = scene;
        renderScenes();
        send("SCENE_SET", { scene });
      });
      sceneGrid.appendChild(btn);
    });
  }

  function renderWheel() {
    wheelGrid.innerHTML = "";
    wheelGrid.appendChild(makeButton(t("remote.wheelStart"), "WHEEL_START", () => ({ command: wheelCommand.value.trim() || "!go" })));
    wheelGrid.appendChild(makeButton(t("remote.wheelStop"), "WHEEL_STOP"));
    wheelGrid.appendChild(makeButton(t("remote.wheelSpin"), "WHEEL_SPIN"));
    wheelGrid.appendChild(makeButton(t("remote.wheelGenerate"), "WHEEL_GENERATE"));
    wheelGrid.appendChild(makeButton(t("remote.wheelResetParticipants"), "WHEEL_RESET_PARTICIPANTS", {}, { className: "action-btn--danger" }));
    wheelGrid.appendChild(makeButton(t("remote.wheelClearResult"), "WHEEL_CLEAR_RESULT"));
  }

  function renderWheelSettings() {
    if (wheelCommand && document.activeElement !== wheelCommand) {
      wheelCommand.value = giveaway.command || "!go";
    }
    setSwitch(wheelElimination, !!giveaway.eliminationMode);
    wsMaxNames.value = participantsConfig.maxNames ?? 10;
    wsFontSize.value = participantsConfig.fontSize ?? 16;
    wsTextColor.value = participantsConfig.textColor || "#e8e1f0";
    wsBgOpacity.value = participantsConfig.backgroundOpacity ?? 82;
    wsBgOpacityValue.textContent = `${participantsConfig.backgroundOpacity ?? 82}%`;
    wsX.value = participantsConfig.x ?? 24;
    wsXValue.textContent = `${participantsConfig.x ?? 24}px`;
    wsY.value = participantsConfig.y ?? 340;
    wsYValue.textContent = `${participantsConfig.y ?? 340}px`;
    wsW.value = participantsConfig.w ?? 340;
    wsH.value = participantsConfig.h ?? 400;
    setSwitch(wsMarquee, !!participantsConfig.marquee);
    wsMusicVolume.value = wheelConfig.musicVolume ?? 50;
    wsMusicVolumeValue.textContent = `${wheelConfig.musicVolume ?? 50}%`;
    wsSpeed.value = wheelSpeedConfig.speed ?? 3;
    wsSpeedValue.textContent = `${wheelSpeedConfig.speed ?? 3}`;
  }

  function wireWheelSettings() {
    wheelCommand.addEventListener("change", () => {
      giveaway.command = wheelCommand.value.trim() || "!go";
    });

    wheelElimination.addEventListener("click", () => {
      const on = !giveaway.eliminationMode;
      giveaway.eliminationMode = on;
      setSwitch(wheelElimination, on);
      sendCommand(EVENT_TYPES.CMD_SET_GIVEAWAY_ELIMINATION, { enabled: on });
    });

    wsMaxNames.addEventListener("change", () => {
      participantsConfig.maxNames = Math.max(1, Number(wsMaxNames.value) || 10);
      sendCommand(EVENT_TYPES.CMD_SET_PARTICIPANTS_CONFIG, { config: participantsConfig });
    });

    wsFontSize.addEventListener("change", () => {
      participantsConfig.fontSize = Number(wsFontSize.value) || 16;
      sendCommand(EVENT_TYPES.CMD_SET_PARTICIPANTS_CONFIG, { config: participantsConfig });
    });

    wsTextColor.addEventListener("input", () => {
      participantsConfig.textColor = wsTextColor.value;
      sendCommand(EVENT_TYPES.CMD_SET_PARTICIPANTS_CONFIG, { config: participantsConfig });
    });

    wsBgOpacity.addEventListener("input", () => {
      const v = Number(wsBgOpacity.value);
      participantsConfig.backgroundOpacity = v;
      wsBgOpacityValue.textContent = `${v}%`;
      sendCommand(EVENT_TYPES.CMD_SET_PARTICIPANTS_CONFIG, { config: participantsConfig });
    });

    wsX.addEventListener("input", () => {
      const v = Number(wsX.value);
      participantsConfig.x = v;
      wsXValue.textContent = `${v}px`;
      sendCommand(EVENT_TYPES.CMD_SET_PARTICIPANTS_CONFIG, { config: participantsConfig });
    });

    wsY.addEventListener("input", () => {
      const v = Number(wsY.value);
      participantsConfig.y = v;
      wsYValue.textContent = `${v}px`;
      sendCommand(EVENT_TYPES.CMD_SET_PARTICIPANTS_CONFIG, { config: participantsConfig });
    });

    wsW.addEventListener("change", () => {
      const v = Number(wsW.value);
      if (!Number.isFinite(v) || v <= 0) return;
      participantsConfig.w = v;
      sendCommand(EVENT_TYPES.CMD_SET_PARTICIPANTS_CONFIG, { config: participantsConfig });
    });

    wsH.addEventListener("change", () => {
      const v = Number(wsH.value);
      if (!Number.isFinite(v) || v <= 0) return;
      participantsConfig.h = v;
      sendCommand(EVENT_TYPES.CMD_SET_PARTICIPANTS_CONFIG, { config: participantsConfig });
    });

    wsMarquee.addEventListener("click", () => {
      const on = !participantsConfig.marquee;
      participantsConfig.marquee = on;
      setSwitch(wsMarquee, on);
      sendCommand(EVENT_TYPES.CMD_SET_PARTICIPANTS_CONFIG, { config: participantsConfig });
    });

    wsMusicVolume.addEventListener("input", () => {
      const v = Number(wsMusicVolume.value);
      wheelConfig.musicVolume = v;
      wsMusicVolumeValue.textContent = `${v}%`;
      sendCommand(EVENT_TYPES.CMD_SET_WHEEL_CONFIG, { config: wheelConfig });
    });

    wsSpeed.addEventListener("input", () => {
      const v = Number(wsSpeed.value);
      wheelSpeedConfig.speed = v;
      wsSpeedValue.textContent = `${v}`;
      sendCommand(EVENT_TYPES.CMD_SET_WHEEL_SPEED_CONFIG, { config: { speed: v } });
    });
  }

  function renderParticipants() {
    if (!wheelParticipantsList) return;
    const participants = giveaway.participants || [];
    if (wheelParticipantsCount) {
      wheelParticipantsCount.textContent = `${t("giveaway.participants")}: ${participants.length}`;
    }
    if (!participants.length) {
      wheelParticipantsList.innerHTML = `<div class="remote-participants__empty">${t("giveaway.noParticipants")}</div>`;
      return;
    }
    wheelParticipantsList.innerHTML = participants
      .map((name) => `<div class="remote-participants__row"><span class="remote-participants__name">${escapeHtml(name)}</span><button class="remote-participants__remove" type="button" data-remove-name="${escapeHtml(name)}" title="${escapeHtml(t("giveaway.removeParticipant"))}">✕</button></div>`)
      .join("");
  }

  function wireParticipants() {
    if (!wheelAddParticipant || !wheelParticipantName) return;
    const add = () => {
      const name = (wheelParticipantName.value || "").trim();
      if (!name) return;
      sendCommand(EVENT_TYPES.CMD_ADD_GIVEAWAY_PARTICIPANT, { username: name });
      wheelParticipantName.value = "";
    };
    wheelAddParticipant.addEventListener("click", add);
    wheelParticipantName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") add();
    });
    if (wheelClearParticipants) {
      wheelClearParticipants.addEventListener("click", () => {
        if (confirm(t("giveaway.clearParticipantsConfirm"))) {
          sendCommand(EVENT_TYPES.CMD_CLEAR_GIVEAWAY_PARTICIPANTS, {});
        }
      });
    }
    if (wheelParticipantsList) {
      wheelParticipantsList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-remove-name]");
        if (!btn) return;
        sendCommand(EVENT_TYPES.CMD_REMOVE_GIVEAWAY_PARTICIPANT, { username: btn.dataset.removeName });
      });
    }
  }

  function renderAlerts() {
    alertGrid.innerHTML = "";
    alertGrid.appendChild(makeButton("Follow", "TEST_ALERT", { kind: "follow" }));
    alertGrid.appendChild(makeButton("Sub", "TEST_ALERT", { kind: "sub" }));
    alertGrid.appendChild(makeButton("Donate", "TEST_ALERT", { kind: "donation" }));

    // Test chat: sends a raw command (not a REMOTE_ACTION) to emit chat messages.
    const chatBtn = document.createElement("button");
    chatBtn.className = "action-btn";
    chatBtn.textContent = t("editor.testChat");
    chatBtn.addEventListener("click", () => {
      vibrate();
      sendCommand(EVENT_TYPES.CMD_TEST_CHAT, { count: 6 });
    });
    alertGrid.appendChild(chatBtn);
  }

  function renderThemes() {
    themeGrid.innerHTML = "";
    if (!themes.length) {
      const empty = document.createElement("div");
      empty.className = "grid-empty";
      empty.textContent = t("remote.noThemes");
      themeGrid.appendChild(empty);
      return;
    }

    themes.forEach((theme) => {
      const isActive = theme.id === activeThemeId;
      const btn = makeButton(theme.name, "THEME_SET", { themeId: theme.id });
      if (isActive) btn.classList.add("is-active");
      themeGrid.appendChild(btn);

      if (theme.has3d) {
        const on = isActive && enable3d;
        const tgl = makeButton(
          t("settings.theme3dToggle"),
          "THEME_SET",
          { themeId: theme.id, enable3d: !on },
          { title: t("settings.theme3dToggleHint") }
        );
        if (on) tgl.classList.add("is-active");
        themeGrid.appendChild(tgl);
      }
    });
  }

  function renderObsCommands() {
    obsCommandGrid.innerHTML = "";
    if (!obsCommands.length) {
      const empty = document.createElement("div");
      empty.className = "grid-empty";
      empty.textContent = t("remote.noCommands");
      obsCommandGrid.appendChild(empty);
      return;
    }
    obsCommands.forEach((cmd) => {
      obsCommandGrid.appendChild(makeButton(cmd.label || cmd.requestType || cmd.id, "OBS_RAW_COMMAND", { id: cmd.id }));
    });
  }

  function renderCameras() {
    cameraGrid.innerHTML = "";
    if (!cameraAngles.length) {
      const empty = document.createElement("div");
      empty.className = "grid-empty";
      empty.textContent = t("remote.noCameras");
      cameraGrid.appendChild(empty);
      return;
    }
    cameraAngles.forEach((angle) => {
      const btn = makeButton(angle.label || angle.id, "CAMERA_SET", { angleId: angle.id });
      if (angle.id === activeCameraAngle) btn.classList.add("is-active");
      cameraGrid.appendChild(btn);
    });
  }

  function renderFilters() {
    filterGrid.innerHTML = "";
    if (!cameraFilters.length) {
      const empty = document.createElement("div");
      empty.className = "grid-empty";
      empty.textContent = t("remote.noFilters");
      filterGrid.appendChild(empty);
      return;
    }
    cameraFilters.forEach((filter) => {
      const btn = makeButton(filter.label || filter.id, "CAMERA_FILTER", { filterId: filter.id });
      if ((activeFilters || []).includes(filter.id)) btn.classList.add("is-active");
      filterGrid.appendChild(btn);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const MAX_CHAT_ROWS = 60;

  function pushChat(msg) {
    if (!chatList) return;
    const empty = chatList.querySelector(".remote-chat__empty");
    if (empty) empty.remove();

    const row = document.createElement("div");
    row.className = "remote-chat__msg";
    const badges = (msg.badges || [])
      .slice(0, 3)
      .map((b) => `<span class="remote-chat__badge">${escapeHtml(String(b).slice(0, 1).toUpperCase())}</span>`)
      .join("");
    row.innerHTML = `${badges}<span class="remote-chat__user" style="color:${escapeHtml(msg.color || "#cac4d0")}">${escapeHtml(msg.user)}</span><span class="remote-chat__colon">:</span><span class="remote-chat__text">${escapeHtml(msg.message)}</span>`;

    chatList.appendChild(row);
    while (chatList.children.length > MAX_CHAT_ROWS) chatList.removeChild(chatList.firstChild);
    chatList.scrollTop = chatList.scrollHeight;
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE: {
        const p = msg.payload || {};
        if (p.appearance) {
          themes = p.appearance.themes || [];
          activeThemeId = p.appearance.activeThemeId || null;
          enable3d = !!p.appearance.enable3d;
          renderThemes();
        }
        if (p.obs) {
          if (Array.isArray(p.obs.customCommands)) {
            obsCommands = p.obs.customCommands;
            renderObsCommands();
          }
          if (Array.isArray(p.obs.cameraAngles)) {
            cameraAngles = p.obs.cameraAngles;
            renderCameras();
          }
          if (Array.isArray(p.obs.cameraFilters)) {
            cameraFilters = p.obs.cameraFilters;
            renderFilters();
          }
        }
        if (typeof p.activeCameraAngle !== "undefined") {
          activeCameraAngle = p.activeCameraAngle || null;
          renderCameras();
        }
        if (Array.isArray(p.activeFilters)) {
          activeFilters = p.activeFilters;
          renderFilters();
        }
        if (typeof p.deathCount === "number") deathValue.textContent = String(p.deathCount);
        if (typeof p.activeScene === "string") {
          activeScene = p.activeScene;
          renderScenes();
        }
        if (p.giveaway) {
          giveaway = {
            command: p.giveaway.command || giveaway.command || "!go",
            eliminationMode: !!p.giveaway.eliminationMode,
            participants: Array.isArray(p.giveaway.participants) ? p.giveaway.participants : (giveaway.participants || []),
            count: typeof p.giveaway.count === "number" ? p.giveaway.count : (Array.isArray(p.giveaway.participants) ? p.giveaway.participants.length : (giveaway.count || 0)),
          };
          renderWheelSettings();
          renderParticipants();
        }
        break;
      }
      case EVENT_TYPES.THEME_UPDATE: {
        const p = msg.payload || {};
        if (p.themes) themes = p.themes;
        activeThemeId = p.activeThemeId || null;
        enable3d = !!p.enable3d;
        renderThemes();
        break;
      }
      case EVENT_TYPES.DEATH_COUNT_UPDATE: {
        const p = msg.payload || {};
        if (typeof p.count === "number") deathValue.textContent = String(p.count);
        break;
      }
      case EVENT_TYPES.CHAT_MESSAGE:
        pushChat(msg.payload);
        break;
      case EVENT_TYPES.CAMERA_ANGLE_UPDATE: {
        activeCameraAngle = (msg.payload && msg.payload.activeCameraAngle) || null;
        renderCameras();
        break;
      }
      case EVENT_TYPES.CAMERA_FILTER_UPDATE: {
        if (msg.payload && msg.payload.filterId) {
          const set = new Set(activeFilters || []);
          if (msg.payload.active) set.add(msg.payload.filterId);
          else set.delete(msg.payload.filterId);
          activeFilters = [...set];
        }
        renderFilters();
        break;
      }
      case EVENT_TYPES.GIVEAWAY_UPDATE: {
        const g = (msg.payload && msg.payload.giveaway) || {};
        giveaway.command = g.command || giveaway.command || "!go";
        giveaway.eliminationMode = !!g.eliminationMode;
        if (Array.isArray(g.participants)) giveaway.participants = g.participants;
        if (typeof g.count === "number") giveaway.count = g.count;
        else if (Array.isArray(g.participants)) giveaway.count = g.participants.length;
        renderWheelSettings();
        renderParticipants();
        break;
      }
      case EVENT_TYPES.GIVEAWAY_PARTICIPANTS: {
        const p = msg.payload || {};
        giveaway.participants = Array.isArray(p.participants) ? p.participants : [];
        giveaway.count = typeof p.count === "number" ? p.count : giveaway.participants.length;
        renderParticipants();
        break;
      }
      case EVENT_TYPES.OVERLAY_PARTICIPANTS_CONFIG:
        participantsConfig = (msg.payload && msg.payload.config) || participantsConfig;
        renderWheelSettings();
        break;
      case EVENT_TYPES.WHEEL_CONFIG:
        wheelConfig = (msg.payload && msg.payload.config) || wheelConfig;
        renderWheelSettings();
        break;
      case EVENT_TYPES.WHEEL_SPEED_CONFIG:
        wheelSpeedConfig = (msg.payload && msg.payload.config) || wheelSpeedConfig;
        renderWheelSettings();
        break;
      case EVENT_TYPES.LOCALES: {
        if (window.I18n) {
          window.I18n.setLocales((msg.payload && msg.payload.locales) || {});
          window.I18n.setLang(msg.payload && msg.payload.lang);
          window.I18n.apply();
        }
        hasLocales = true;
        renderScenes();
        renderWheel();
        renderWheelSettings();
        renderParticipants();
        renderAlerts();
        renderThemes();
        renderObsCommands();
        renderCameras();
        renderFilters();
        setStatus(isConnected);
        break;
      }
      case EVENT_TYPES.REMOTE_ACTION: {
        if (msg.action === "SCENE_SET" && msg.payload && msg.payload.scene) {
          activeScene = msg.payload.scene;
          renderScenes();
        }
        break;
      }
      default:
        break;
    }
  }

  function connect() {
    setStatus(false);
    ws = new WebSocket(wsUrl);
    ws.onopen = () => setStatus(true);
    ws.onmessage = (ev) => {
      try {
        handleMessage(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      setStatus(false);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      if (ws) ws.close();
    };
  }

  // Static quick-action buttons (death counter).
  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      vibrate();
      send(btn.dataset.action, {});
    });
  });

  // Tabs: control pad, wheel, and live chat.
  const remoteMain = document.getElementById("remoteMain");
  const remoteTabs = document.getElementById("remoteTabs");
  if (remoteTabs && remoteMain) {
    remoteTabs.querySelectorAll(".remote-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const name = tab.dataset.tab;
        remoteTabs.querySelectorAll(".remote-tab").forEach((b) => b.classList.toggle("is-active", b === tab));
        remoteMain.classList.toggle("is-chat", name === "chat");
        remoteMain.classList.toggle("is-wheel", name === "wheel");
        if (chatList) chatList.scrollTop = chatList.scrollHeight;
      });
    });
  }

  wireWheelSettings();
  renderWheelSettings();
  wireParticipants();
  renderParticipants();
  connect();
})();
