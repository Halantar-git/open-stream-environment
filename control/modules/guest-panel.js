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
  Настройки гостевых камер: слоты хоста и подключение к чужим стримам.

  Хост видит четыре слота, для каждого — ссылку-приглашение и состояние. Гость
  вставляет приглашения и ждёт подтверждения; поток отправляет `guest-share`,
  а этот модуль только показывает состояние и передаёт события.

  Подключений у гостя может быть несколько: в сетке каждый отправляет камеру
  нескольким стримерам, а те — ему. Поэтому состояния живут по `link`, а не по
  слоту: два хоста могут выдать один и тот же `cam2`.
*/

import { createGuestShare } from "./guest-share.js";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function defaultSlots() {
  const protocol = typeof window !== "undefined" ? window.GuestProtocol : null;
  const slots = protocol && Array.isArray(protocol.SLOTS) ? protocol.SLOTS : ["cam2", "cam3", "cam4", "cam5"];
  return slots.map((slot) => ({ slot, name: "", state: "free", guest: "" }));
}

export function initGuestPanel({ state, t, send, EVENT_TYPES, copyText }) {
  const list = document.getElementById("guestSlotsList");
  const linksList = document.getElementById("guestLinksList");
  const linksHead = document.getElementById("guestLinksHead");
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
  // Исходящие связи: сервер отдаёт список, `guestShares` — их живые состояния.
  if (!Array.isArray(state.guestOutgoing)) state.guestOutgoing = [];
  if (!state.guestShares || typeof state.guestShares !== "object") state.guestShares = {};
  if (!state.guestOutgoingLimit) state.guestOutgoingLimit = 4;
  if (!state.guestShare) state.guestShare = { slot: "", status: "idle", detail: "" };
  if (!state.guestSignalUrl) state.guestSignalUrl = "";
  if (!state.guestIce) state.guestIce = { stunUrls: "", turnUrls: "", turnUser: "", turnPassword: "" };
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

  function statusLabel(value) {
    const key = `guests.status.${value || "idle"}`;
    const text = t(key);
    return text === key ? value || "" : text;
  }

  function errorDetail(detail) {
    if (!detail) return "";
    const key = `guests.error.${detail}`;
    const text = t(key);
    return text === key ? detail : text;
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

  // Строка исходящего подключения: слот, который выдал хост, и состояние
  // именно этой связи. Отключается отдельно — остальные продолжают идти.
  function outgoingRow(info, index) {
    const local = state.guestShares[info.link] || { status: "joining", detail: "" };
    const status = local.status || "joining";
    const detail = local.detail
      ? ` <span class="guest-slot__guest">(${escapeHtml(errorDetail(local.detail))})</span>`
      : "";
    return `<div class="guest-slot" data-link="${escapeHtml(info.link)}">
      <div class="guest-slot__head">
        <span class="guest-slot__name">${escapeHtml(
          t("guests.linkTitle", { number: index + 1 })
        )} · ${escapeHtml(slotLabel(info.slot, ""))}</span>
        ${detail}
        <span class="guest-slot__state" data-state="${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>
      </div>
      <div class="guest-slot__actions">
        <button class="md-button md-button--text" data-action="disconnect" data-link="${escapeHtml(
          info.link
        )}">${escapeHtml(t("guests.disconnect"))}</button>
      </div>
    </div>`;
  }

  function outgoingList() {
    return Array.isArray(state.guestOutgoing) ? state.guestOutgoing : [];
  }

  function render() {
    const slots = Array.isArray(state.guestSlots) && state.guestSlots.length ? state.guestSlots : defaultSlots();
    // Порядок задаёт сервер (cam2…cam5); на случай старого снимка добавляем
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

    const outgoing = outgoingList();
    if (linksList) linksList.innerHTML = outgoing.map(outgoingRow).join("");
    if (linksHead) linksHead.hidden = outgoing.length === 0;

    const joining = state.guestShare && state.guestShare.status === "joining";
    if (statusEl) {
      const parts = [];
      const formStatus = state.guestShare && state.guestShare.status !== "idle" ? state.guestShare.status : "";
      if (formStatus) parts.push(statusLabel(formStatus));
      if (state.guestShare && state.guestShare.detail) {
        parts.push(`(${errorDetail(state.guestShare.detail)})`);
      }
      if (!parts.length && outgoing.length >= state.guestOutgoingLimit) {
        parts.push(t("guests.limitReached", { count: state.guestOutgoingLimit }));
      }
      statusEl.textContent = parts.join(" ");
    }
    joinBtn.disabled = !!joining || outgoing.length >= state.guestOutgoingLimit;
    leaveBtn.disabled = !outgoing.length && !joining;
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

  if (linksList) {
    linksList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action=\"disconnect\"]");
      const link = button && button.dataset.link;
      if (!link) return;
      share.stop(link);
      delete state.guestShares[link];
      state.guestOutgoing = outgoingList().filter((item) => item.link !== link);
      send(EVENT_TYPES.CMD_GUEST_LEAVE, { link });
      render();
    });
  }

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
    // Поле очищаем сразу: следующее приглашение вставляется на его место, а
    // ссылка уже ушла на сервер.
    joinInput.value = "";
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
    share.stopAll();
    state.guestShares = {};
    state.guestOutgoing = [];
    state.guestShare = { slot: "", status: "idle", detail: "" };
    send(EVENT_TYPES.CMD_GUEST_LEAVE, {});
    render();
  });

  /*
    Связь, которой касается событие. Сервер помечает кадры исходящей сессии
    (`outgoing`) и присылает `link`; старый снимок без идентификатора
    сопоставляем по слоту, пока связь одна.
  */
  function eventLink(payload) {
    if (!payload) return "";
    if (typeof payload.link === "string" && payload.link) return payload.link;
    const matches = outgoingList().filter((item) => item.slot === payload.slot);
    return matches.length === 1 ? matches[0].link : "";
  }

  function isOutgoingEvent(payload) {
    return !!payload && (payload.outgoing === true || payload.local === true);
  }

  function forgetLink(link) {
    if (!link) return;
    share.stop(link);
    delete state.guestShares[link];
    state.guestOutgoing = outgoingList().filter((item) => item.link !== link);
  }

  function handleMessage(message) {
    const type = message && message.type;
    const payload = (message && message.payload) || {};
    switch (type) {
      case EVENT_TYPES.GUEST_STATUS: {
        const previous = outgoingList().length;
        state.guestSlots = Array.isArray(payload.slots) ? payload.slots : [];
        state.guestOutgoing = Array.isArray(payload.outgoing) ? payload.outgoing : [];
        if (Number(payload.outgoingLimit) > 0) state.guestOutgoingLimit = Number(payload.outgoingLimit);
        if (typeof payload.signalUrl === "string") state.guestSignalUrl = payload.signalUrl;
        if (payload.ice && typeof payload.ice === "object") {
          state.guestIce = { ...state.guestIce, ...payload.ice };
        }
        // Состояния закрытых связей больше не нужны: список — источник истины.
        const known = new Set(outgoingList().map((item) => item.link));
        for (const link of Object.keys(state.guestShares)) {
          if (!known.has(link)) {
            share.stop(link);
            delete state.guestShares[link];
          }
        }
        if (outgoingList().length !== previous && state.guestShare.status === "joining") {
          state.guestShare = { slot: "", status: "idle", detail: "" };
        }
        // Освободившийся слот больше не должен показывать старую ссылку:
        // сервер уже аннулировал её токен.
        for (const item of state.guestSlots) {
          if (item.state === "free") delete state.guestInvites[item.slot];
        }
        render();
        break;
      }
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
      case EVENT_TYPES.GUEST_ACCEPTED: {
        if (!isOutgoingEvent(payload)) break;
        const link = eventLink(payload);
        if (link) share.markAccepted(link, payload.slot);
        render();
        break;
      }
      case EVENT_TYPES.GUEST_RECEIVER_READY: {
        if (!isOutgoingEvent(payload)) break;
        const link = eventLink(payload);
        if (link) share.start(link, payload.slot, payload.ice || state.guestIce);
        break;
      }
      case EVENT_TYPES.GUEST_SIGNAL: {
        if (!isOutgoingEvent(payload)) break;
        const link = eventLink(payload);
        if (link) share.handleSignal(link, payload.payload);
        break;
      }
      case EVENT_TYPES.GUEST_DECLINED: {
        if (!isOutgoingEvent(payload)) break;
        const link = eventLink(payload);
        const reason = payload.reason || "";
        if (!link) {
          // Связь не началась: приглашение битое или исчерпан предел.
          state.guestShare = { slot: payload.slot || "", status: "error", detail: reason };
          render();
          break;
        }
        forgetLink(link);
        // Отказ показываем в строке статуса: самой связи в списке уже нет.
        state.guestShare = {
          slot: payload.slot || "",
          status: reason ? "error" : "declined",
          detail: reason,
        };
        render();
        break;
      }
      case EVENT_TYPES.GUEST_LEFT: {
        if (!isOutgoingEvent(payload)) break;
        const link = eventLink(payload);
        if (!link) break;
        forgetLink(link);
        render();
        break;
      }
      default:
        break;
    }
  }

  render();
  return { handleMessage, render };
}
