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
  Настройки гостевых камер: слоты хоста и подключение к чужому стриму.

  Хост видит три слота, для каждого — ссылку-приглашение и состояние. Гость
  вставляет приглашение и ждёт подтверждения; поток отправляет `guest-share`,
  а этот модуль только показывает состояние и передаёт события.
*/

import { createGuestShare } from "./guest-share.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function defaultSlots() {
  const protocol = typeof window !== "undefined" ? window.GuestProtocol : null;
  const slots = protocol && Array.isArray(protocol.SLOTS) ? protocol.SLOTS : ["cam2", "cam3", "cam4"];
  return slots.map((slot) => ({ slot, name: "", state: "free", guest: "" }));
}

export function initGuestPanel({ state, t, send, EVENT_TYPES, copyText }) {
  const list = document.getElementById("guestSlotsList");
  const joinInput = document.getElementById("guestJoinInvite");
  const nameInput = document.getElementById("guestJoinName");
  const joinBtn = document.getElementById("guestJoinBtn");
  const leaveBtn = document.getElementById("guestLeaveBtn");
  const statusEl = document.getElementById("guestJoinStatus");
  const modeSelect = document.getElementById("guestInviteMode");
  const signalInput = document.getElementById("guestSignalUrl");
  const stunInput = document.getElementById("guestStunUrls");
  const turnInput = document.getElementById("guestTurnUrls");
  const turnUserInput = document.getElementById("guestTurnUser");
  const turnPasswordInput = document.getElementById("guestTurnPassword");
  if (!list || !joinInput || !joinBtn) return { handleMessage() {}, render() {} };

  if (!state.guestSlots || !state.guestSlots.length) state.guestSlots = defaultSlots();
  if (!state.guestInvites) state.guestInvites = {};
  if (!state.guestPending) state.guestPending = {};
  if (!state.guestShare) state.guestShare = { slot: "", status: "idle", detail: "" };
  if (!state.guestSignalUrl) state.guestSignalUrl = "";
  if (!state.guestIce) state.guestIce = { stunUrls: "", turnUrls: "", turnUser: "", turnPassword: "" };
  if (!state.guestRemoteIce) state.guestRemoteIce = null;
  const ICE_INPUTS = [
    [stunInput, "stunUrls"],
    [turnInput, "turnUrls"],
    [turnUserInput, "turnUser"],
    [turnPasswordInput, "turnPassword"],
  ];
  if (modeSelect) {
    try {
      const saved = localStorage.getItem("ose.guestInviteMode");
      if (saved === "lan" || saved === "cloud") modeSelect.value = saved;
    } catch (_) {
      /* приватный режим */
    }
    modeSelect.addEventListener("change", () => {
      try {
        localStorage.setItem("ose.guestInviteMode", modeSelect.value);
      } catch (_) {
        /* приватный режим */
      }
    });
  }
  if (signalInput) {
    signalInput.addEventListener("change", () => {
      const value = signalInput.value.trim();
      // Пустое значение — вернуться к адресу по умолчанию.
      if (value && !/^wss?:\/\//i.test(value)) {
        signalInput.value = state.guestSignalUrl || "";
        return;
      }
      state.guestSignalUrl = value;
      send(EVENT_TYPES.CMD_SET_APP_CONFIG, { guestSignalUrl: value });
    });
  }

  // STUN/TURN правятся вместе: сервер пересобирает пару «адреса + логин» и
  // сохраняет в конфиг, а гость получит их с подтверждением.
  function saveIce() {
    const next = {};
    for (const [input, key] of ICE_INPUTS) next[key] = input ? input.value.trim() : state.guestIce[key];
    state.guestIce = next;
    send(EVENT_TYPES.CMD_SET_APP_CONFIG, { guestIce: next });
  }
  for (const [input] of ICE_INPUTS) {
    if (input) input.addEventListener("change", saveIce);
  }

  const share = createGuestShare({
    state,
    send,
    EVENT_TYPES,
    onStatus: () => render(),
  });

  const storedName = (() => {
    try {
      return localStorage.getItem("ose.guestName") || "";
    } catch (_) {
      return "";
    }
  })();
  if (!nameInput.value) nameInput.value = storedName;

  function slotLabel(slot, name) {
    return name ? name : t(`guests.slot.${slot}`);
  }

  function stateLabel(value) {
    const key = `guests.state.${value || "free"}`;
    const text = t(key);
    // Неизвестное состояние (новая версия сервера) не должно показывать ключ.
    return text === key ? value : text;
  }

  function errorDetail(detail) {
    if (!detail) return "";
    const key = `guests.error.${detail}`;
    const text = t(key);
    return text === key ? detail : text;
  }

  function shareStatus() {
    const info = state.guestShare || { status: "idle" };
    const key = `guests.status.${info.status || "idle"}`;
    const text = t(key);
    return text !== key ? text : info.status || "";
  }

  function slotRow(info) {
    const invite = state.guestInvites[info.slot] || "";
    const pending = info.state === "waiting";
    const live = info.state === "accepted" || info.state === "connected";
    // Гость подтверждён, но никто не принимает поток: слот висит в этом
    // состоянии вечно, и гость видит «ждём экран». Говорим хозяину, чего не
    // хватает, — иначе выглядит как «подключение не работает».
    const awaitingWidget = info.state === "accepted";
    const actions = [];
    if (!live) {
      actions.push(
        `<button class="md-button md-button--text" data-action="invite" data-slot="${escapeHtml(info.slot)}">${escapeHtml(
          t("guests.invite")
        )}</button>`
      );
    }
    if (pending) {
      actions.push(
        `<button class="md-button md-button--tonal" data-action="accept" data-slot="${escapeHtml(info.slot)}">${escapeHtml(
          t("guests.accept")
        )}</button>`,
        `<button class="md-button md-button--text" data-action="decline" data-slot="${escapeHtml(info.slot)}">${escapeHtml(
          t("guests.decline")
        )}</button>`
      );
    }
    if (live) {
      actions.push(
        `<button class="md-button md-button--text" data-action="decline" data-slot="${escapeHtml(info.slot)}">${escapeHtml(
          t("guests.revoke")
        )}</button>`
      );
    }
    const guest = info.guest ? `<span class="guest-slot__guest">${escapeHtml(info.guest)}</span>` : "";
    const link = invite
      ? `<div class="guest-slot__link-row">
           <input class="guest-slot__link" readonly value="${escapeHtml(invite)}" />
           <button class="md-button md-button--text" data-action="copy" data-slot="${escapeHtml(info.slot)}">${escapeHtml(
             t("guests.copy")
           )}</button>
         </div>`
      : "";
    return `<div class="guest-slot" data-slot="${escapeHtml(info.slot)}">
      <div class="guest-slot__head">
        <span class="guest-slot__name">${escapeHtml(slotLabel(info.slot, info.name))}</span>
        ${guest}
        <span class="guest-slot__state" data-state="${escapeHtml(info.state)}">${escapeHtml(stateLabel(info.state))}</span>
      </div>
      <div class="guest-slot__actions">${actions.join("")}</div>
      ${awaitingWidget ? `<p class="settings__hint settings__hint--warn">${escapeHtml(t("guests.waitingWidgetHint"))}</p>` : ""}
      ${link}
    </div>`;
  }

  function render() {
    const slots = Array.isArray(state.guestSlots) && state.guestSlots.length ? state.guestSlots : defaultSlots();
    // Порядок задаёт сервер (cam2…cam4); на случай старого снимка добавляем
    // недостающие слоты, чтобы ссылку всегда было куда вставить.
    const known = new Set(slots.map((item) => item.slot));
    const rows = slots.concat(defaultSlots().filter((item) => !known.has(item.slot)));
    const localHint = state.guestInviteLoopback
      ? `<p class="settings__hint">${escapeHtml(t("guests.noLanAddress"))}</p>`
      : "";
    list.innerHTML = rows.map(slotRow).join("") + localHint;
    if (signalInput && document.activeElement !== signalInput) {
      signalInput.value = state.guestSignalUrl || "";
    }
    for (const [input, key] of ICE_INPUTS) {
      if (input && document.activeElement !== input) input.value = state.guestIce[key] || "";
    }

    const outgoing = state.guestOutgoing;
    if (statusEl) {
      const parts = [];
      if (outgoing && outgoing.slot) parts.push(shareStatus());
      else if (state.guestShare && state.guestShare.status && state.guestShare.status !== "idle") {
        parts.push(shareStatus());
      }
      if (state.guestShare && state.guestShare.detail) {
        parts.push(`(${errorDetail(state.guestShare.detail)})`);
      }
      statusEl.textContent = parts.join(" ");
    }
    const joining = state.guestShare && state.guestShare.status === "joining";
    joinBtn.disabled = !!outgoing || !!joining;
    leaveBtn.disabled = !outgoing && !joining;
  }

  async function copyInvite(slot) {
    const text = state.guestInvites[slot] || "";
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) return;
  }

  list.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const slot = button.dataset.slot;
    switch (button.dataset.action) {
      case "invite":
        send(EVENT_TYPES.CMD_GUEST_INVITE, {
          slot,
          mode: modeSelect ? modeSelect.value || "cloud" : "cloud",
        });
        break;
      case "accept":
        send(EVENT_TYPES.CMD_GUEST_ACCEPT, { slot });
        break;
      case "decline":
        send(EVENT_TYPES.CMD_GUEST_DECLINE, { slot });
        state.guestInvites[slot] = "";
        break;
      case "copy":
        copyInvite(slot);
        break;
      default:
        break;
    }
  });

  joinBtn.addEventListener("click", () => {
    const protocol = typeof window !== "undefined" ? window.GuestProtocol : null;
    const invite = protocol ? protocol.parseInvite(joinInput.value) : null;
    if (!invite) {
      state.guestShare = { slot: "", status: "invalid", detail: "" };
      render();
      return;
    }
    const name = nameInput.value.trim().slice(0, 40);
    try {
      localStorage.setItem("ose.guestName", name);
    } catch (_) {
      /* приватный режим */
    }
    state.guestShare = { slot: invite.slot, status: "joining", detail: "" };
    render();
    if (invite.mode === "cloud") {
      send(EVENT_TYPES.CMD_GUEST_JOIN, {
        mode: "cloud",
        signal: invite.signal,
        room: invite.room,
        slot: invite.slot,
        token: invite.token,
        name,
      });
    } else {
      send(EVENT_TYPES.CMD_GUEST_JOIN, {
        mode: "lan",
        host: invite.host,
        port: invite.port,
        slot: invite.slot,
        token: invite.token,
        name,
      });
    }
  });

  leaveBtn.addEventListener("click", () => {
    share.stop();
    state.guestRemoteIce = null;
    send(EVENT_TYPES.CMD_GUEST_LEAVE, {});
    render();
  });

  // Сервер мог ещё не успеть прислать `guest_status` к моменту первого
  // события — слот приглашения уже известен из `guestShare`.
  function joinedSlot(slot) {
    if (state.guestOutgoing && state.guestOutgoing.slot === slot) return true;
    return !!(state.guestShare && state.guestShare.slot === slot);
  }

  // Событие касается нашего исходящего подключения (мы гость у другого
  // стримера), а не гостя, которого принимаем сами. Слоты могут совпадать
  // (cam2 с обеих сторон), поэтому смотрим ещё и на метку источника.
  function joinedOutgoing(slot, payload) {
    if (!joinedSlot(slot)) return false;
    return payload.outgoing === true || payload.local === true;
  }

  function handleMessage(message) {
    const type = message && message.type;
    const payload = (message && message.payload) || {};
    switch (type) {
      case EVENT_TYPES.GUEST_STATUS:
        state.guestSlots = Array.isArray(payload.slots) ? payload.slots : [];
        state.guestOutgoing = payload.outgoing || null;
        if (typeof payload.signalUrl === "string") state.guestSignalUrl = payload.signalUrl;
        if (payload.ice && typeof payload.ice === "object") {
          state.guestIce = { ...state.guestIce, ...payload.ice };
        }
        // Освободившийся слот больше не должен показывать старую ссылку:
        // сервер уже аннулировал её токен.
        for (const item of state.guestSlots) {
          if (item.state === "free") delete state.guestInvites[item.slot];
        }
        render();
        break;
      case EVENT_TYPES.GUEST_INVITE: {
        const protocol = typeof window !== "undefined" ? window.GuestProtocol : null;
        const text = protocol
          ? payload.mode === "cloud"
            ? protocol.createCloudInvite(payload)
            : protocol.createInvite(payload)
          : "";
        if (text && payload.slot) {
          state.guestInvites[payload.slot] = text;
          state.guestInviteLoopback = !!payload.loopback;
          copyText(text);
        }
        render();
        break;
      }
      case EVENT_TYPES.GUEST_JOIN_REQUEST:
        if (payload.slot) state.guestPending[payload.slot] = payload.name || "";
        render();
        break;
      case EVENT_TYPES.GUEST_ACCEPTED:
        // Настройки ICE хоста — для соединения, а не для полей ввода: свои
        // значения гость не теряет.
        if (payload.ice && typeof payload.ice === "object") state.guestRemoteIce = payload.ice;
        if (joinedOutgoing(payload.slot, payload)) share.markAccepted(payload.slot);
        render();
        break;
      case EVENT_TYPES.GUEST_RECEIVER_READY:
        if (joinedOutgoing(payload.slot, payload)) {
          share.start(payload.slot, payload.ice || state.guestRemoteIce || state.guestIce);
        }
        break;
      case EVENT_TYPES.GUEST_SIGNAL:
        if (joinedOutgoing(payload.slot, payload)) share.handleSignal(payload.payload);
        break;
      case EVENT_TYPES.GUEST_DECLINED:
        if (joinedOutgoing(payload.slot, payload)) {
          share.stop();
          state.guestOutgoing = null;
          // Причина есть у сетевой ошибки (сервер недоступен), у отказа хоста
          // её нет — это разные сообщения для пользователя.
          const reason = payload.reason || "";
          state.guestRemoteIce = null;
          state.guestShare = {
            slot: payload.slot,
            status: reason ? "error" : "declined",
            detail: reason,
          };
          // Закрываем и исходящее соединение, иначе слот останется занятым.
          send(EVENT_TYPES.CMD_GUEST_LEAVE, {});
          render();
        }
        break;
      case EVENT_TYPES.GUEST_LEFT:
        if (joinedOutgoing(payload.slot, payload)) {
          share.stop();
          state.guestOutgoing = null;
          state.guestRemoteIce = null;
          state.guestShare = { slot: payload.slot, status: "left", detail: "" };
          send(EVENT_TYPES.CMD_GUEST_LEAVE, {});
          render();
        }
        break;
      default:
        break;
    }
  }

  render();
  return { handleMessage, render };
}
