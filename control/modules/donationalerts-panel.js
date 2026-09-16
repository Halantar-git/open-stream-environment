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
  Панель DonationAlerts.

  Отвечает на вопрос «почему донаты не приходят», поэтому показывает три вещи,
  которых нет в обычных настройках:

    * состояние подключения и здоровья токена (есть ли он, можно ли обновить,
      до какого срока действителен) — самый частый ответ на этот вопрос;
    * быстрые действия, которые нужны прямо в эфире: переподключить, показать
      тестовый донат, подтянуть пропущенное, переключить озвучку от сервиса;
    * живой журнал только этого сервиса (события `terminal_log` с
      service === "donationalerts").

  Журнал копится с запуска приложения, даже пока панель закрыта, — открыв её
  после сбоя, видно, что происходило до этого, а не пустой экран.

  Настройки подключения (Client ID/Secret, «Подключить») остаются на вкладке
  «Настройки»: здесь только управление уже подключённым сервисом.
*/

import { el, on } from "./dom.js";

const MAX_LINES = 300;
const SERVICE = "donationalerts";
// Сколько последних донатов показываем. Полная история с фильтрами и пагинацией
// живёт в панели «История»: здесь нужен быстрый ответ «дошло ли» и повтор алерта.
const DONATIONS_LIMIT = 10;
// Живой эфир может дать всплеск донатов; столько ждём перед перезапросом истории,
// чтобы серия донатов стоила одного обращения к базе, а не пяти.
const DONATIONS_REFRESH_DEBOUNCE_MS = 400;
// Столько ждём ответ на «подтянуть пропущенные», прежде чем разблокировать
// кнопку: у DonationAlerts лимит запросов, и без снятия блокировки панель
// выглядела бы зависшей, если ответ потеряется.
const RECOVER_TIMEOUT_MS = 30000;

export function initDonationAlertsPanel({ t, ICONS, send, EVENT_TYPES, state, showToast, statusText, statusClass, utils }) {
  const { escapeHtml, escapeAttr, formatMoney, currencySymbol, formatEventTime } = utils;
  const panel = el("daPanel");
  const toggleBtn = el("toggleDaBtn");
  const chip = el("daStatusChip");
  const chipLabel = el("daStatusChipLabel");
  const facts = el("daFacts");
  const enabledSwitch = el("daEnabledSwitch");
  const voiceSwitch = el("daPanelVoiceSwitch");
  const recoverBtn = el("daRecoverBtn");
  const recoverStatus = el("daRecoverStatus");
  const logBody = el("daLog");
  const logEmpty = el("daLogEmpty");
  const logSearch = el("daLogSearch");
  const donationsBody = el("daDonations");
  const donationsEmpty = el("daDonationsEmpty");
  const donationsMeta = el("daDonationsMeta");
  const sessionOnlyInput = el("daDonationsSessionOnly");
  const sessionStats = el("daSessionStats");

  let status = "not_configured";
  let auth = { connected: false, refreshable: false, userId: "", expiresAt: 0 };
  // Client ID показываем в списке фактов: он публичен (он же в адресе авторизации),
  // а сверить его с кабинетом — первый шаг разбора «почему не подключается».
  let clientId = "";
  // Заполнен ли Client Secret. Сам секрет панель не получает и не показывает —
  // только факт наличия: без него обмен кода на токен заведомо провалится.
  let hasClientSecret = false;
  // Сохранённый секрет не удалось прочитать (конфиг перенесён, недоступно
  // системное хранилище). Для пользователя это другое действие, чем «не заполнен»:
  // ключ надо вставить заново.
  let clientSecretUnreadable = false;
  let enabled = true;
  let voiceOn = false;
  let searchTerm = "";
  let atBottom = true;
  let recovering = false;
  let recoverTimer = null;
  let donationsLoading = false;
  let donationsQueued = false;
  let donationsTimer = null;
  let sessionOnly = false;
  let sessionStartedAt = 0;
  let sessionCounts = { count: 0, amount: 0, currency: "" };

  function formatTime(ts) {
    const date = new Date(Number(ts) || Date.now());
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function formatDateTime(ts) {
    const date = new Date(Number(ts));
    return date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function serializeData(data) {
    if (data === null || data === undefined) return "";
    if (typeof data === "string") return data;
    try {
      const text = JSON.stringify(data);
      return text && text !== "{}" ? text : "";
    } catch {
      return String(data);
    }
  }

  // ---- журнал сервиса ----

  function updateEmptyState() {
    if (logEmpty) logEmpty.hidden = !!(logBody && logBody.children.length);
  }

  function appendLog(entry) {
    if (!logBody || !entry || entry.service !== SERVICE) return;

    const line = document.createElement("div");
    line.className = `da-log__line da-log__line--${entry.level || "info"}`;
    line.dataset.level = entry.level || "info";

    const time = document.createElement("span");
    time.className = "da-log__time";
    time.textContent = formatTime(entry.timestamp);

    const level = document.createElement("span");
    level.className = "da-log__level";
    level.textContent = String(entry.level || "info").toUpperCase();

    const message = document.createElement("span");
    message.className = "da-log__message";
    message.textContent = entry.message || "";

    // См. logger-panel: сообщение и данные — один flex-элемент, иначе длинный
    // JSON сжимает сообщение до одной буквы в строке.
    const text = document.createElement("span");
    text.className = "da-log__text";
    text.appendChild(message);
    line.append(time, level, text);

    const dataText = serializeData(entry.data);
    if (dataText) {
      const data = document.createElement("span");
      data.className = "da-log__data";
      data.textContent = dataText;
      text.appendChild(document.createTextNode(" "));
      text.appendChild(data);
    }

    if (searchTerm && !line.textContent.toLowerCase().includes(searchTerm)) line.hidden = true;
    logBody.appendChild(line);
    while (logBody.children.length > MAX_LINES) logBody.removeChild(logBody.firstChild);

    updateEmptyState();
    if (atBottom) logBody.scrollTop = logBody.scrollHeight;
  }

  function clearLog() {
    if (logBody) logBody.innerHTML = "";
    updateEmptyState();
  }

  function applySearch(term) {
    searchTerm = String(term || "").toLowerCase();
    if (!logBody) return;
    Array.from(logBody.children).forEach((line) => {
      line.hidden = !!searchTerm && !line.textContent.toLowerCase().includes(searchTerm);
    });
  }

  // ---- состояние ----

  function applyStatus(next) {
    status = next || "not_configured";
    render();
  }

  function applySnapshot(payload) {
    if (!payload) return;
    if (payload.donationAlertsAuth) {
      auth = {
        connected: !!payload.donationAlertsAuth.connected,
        refreshable: !!payload.donationAlertsAuth.refreshable,
        userId: payload.donationAlertsAuth.userId || "",
        expiresAt: Number(payload.donationAlertsAuth.expiresAt) || 0,
      };
    }
    if (typeof payload.donationAlertsEnabled === "boolean") enabled = payload.donationAlertsEnabled;
    if (typeof payload.donationAlertsClientId === "string") clientId = payload.donationAlertsClientId;
    if (payload.donationAlertsAuth) {
      hasClientSecret = payload.donationAlertsAuth.hasClientSecret !== false;
      clientSecretUnreadable = payload.donationAlertsAuth.clientSecretUnreadable === true;
    }
    if (payload.donationVoice) voiceOn = !!payload.donationVoice.donationAlerts;
    if (payload.connectionStatus && payload.connectionStatus.donationAlerts) {
      status = payload.connectionStatus.donationAlerts;
    }
    // Граница текущей сессии нужна режиму «только этот стрим».
    if (payload.sessionStartedAt !== undefined) sessionStartedAt = Number(payload.sessionStartedAt) || 0;
    // Счёт стрима живёт отдельным событием, но в снимке он тоже есть — иначе
    // только что подключённая панель показывала бы ноль до первого доната.
    if (payload.sessionDonations) applySessionStats(payload.sessionDonations);
    render();
  }

  function setRecovering(value) {
    recovering = !!value;
    if (recoverTimer) {
      clearTimeout(recoverTimer);
      recoverTimer = null;
    }
    if (recovering) {
      recoverTimer = setTimeout(() => {
        recovering = false;
        recoverTimer = null;
        render();
      }, RECOVER_TIMEOUT_MS);
    }
    render();
  }

  function showRecoverResult(result) {
    setRecovering(false);
    // Подтянутые донаты уже легли в историю — список должен их показать.
    if (result && result.ok === true) refreshDonations();
    if (!recoverStatus || !result) return;

    let key = "queue.recoverFailed";
    let params = undefined;

    if (result.ok === true && result.count > 0) {
      key = "queue.recoverDone";
      params = { count: result.count };
    } else if (result.ok === true) {
      key = "queue.recoverNone";
    } else if (result.error === "insufficient_scope") {
      key = "queue.recoverScope";
    } else if (result.error === "not_authorized") {
      key = "queue.recoverNoAuth";
    } else if (result.error === "in_progress") {
      key = "queue.recoverBusy";
    } else {
      params = { error: String(result.error || "") };
    }

    recoverStatus.hidden = false;
    recoverStatus.classList.toggle("is-error", result.ok !== true);
    recoverStatus.textContent = t(key, params);
  }

  function fact(labelKey, value, warn) {
    return `<div class="da-fact"><span class="da-fact__label">${t(labelKey)}</span><span class="da-fact__value${warn ? " is-warn" : ""}">${value}</span></div>`;
  }

  // ---- последние донаты ----

  function donationHtml(item) {
    const amount =
      typeof item.amount === "number" ? `${formatMoney(item.amount)} ${currencySymbol(item.currency)}`.trim() : "";
    const message = item.message ? `<div class="da-donation__message">«${escapeHtml(item.message)}»</div>` : "";
    return `
      <div class="da-donation">
        <div class="da-donation__main">
          <div class="da-donation__top">
            <span class="da-donation__user">${escapeHtml(item.username || "—")}</span>
            ${amount ? `<span class="da-donation__amount">${escapeHtml(amount)}</span>` : ""}
          </div>
          ${message}
          <div class="da-donation__time">${escapeHtml(formatEventTime(item.timestamp))}</div>
        </div>
        <button class="da-btn da-btn--small da-donation__replay" data-replay-id="${escapeAttr(item.id)}">${escapeHtml(t("da.replay"))}</button>
      </div>`;
  }

  function renderDonations(items, total) {
    if (!donationsBody) return;
    donationsBody.innerHTML = items.map(donationHtml).join("");
    donationsBody.querySelectorAll("[data-replay-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        // Повтор уходит в очередь на сервере (см. server/index.js:replayEvent),
        // поэтому кнопку достаточно нажать ещё раз, когда очередь дойдёт.
        btn.disabled = true;
        await window.desktop?.replayEvent?.(btn.dataset.replayId);
        setTimeout(() => {
          btn.disabled = false;
        }, 600);
      });
    });
    if (donationsEmpty) {
      donationsEmpty.hidden = items.length > 0;
      donationsEmpty.textContent = t("da.donationsEmpty");
    }
    if (donationsMeta) {
      // В режиме «только этот стрим» счёт стрима уже показан строкой выше,
      // поэтому второй счётчик не дублируем.
      donationsMeta.textContent = !items.length || sessionOnly ? "" : t("da.donationsTotal", { count: total });
    }
  }

  /*
    Счёт текущего стрима приходит с сервера (см. state.addDonationToSession):
    он складывает донаты в момент прихода и потому всегда точный, в отличие от
    подсчёта по видимой странице истории.
  */
  function renderSessionStats() {
    if (!sessionStats) return;
    const symbol = sessionCounts.currency ? currencySymbol(sessionCounts.currency) : "";
    const amount = `${formatMoney(sessionCounts.amount)}${symbol ? ` ${symbol}` : ""}`;
    sessionStats.textContent = `${t("session.count", { count: sessionCounts.count })} · ${t("session.amount", { amount })}`;
  }

  function applySessionStats(payload) {
    if (!payload) return;
    sessionCounts = {
      count: Number(payload.count) || 0,
      amount: Number(payload.amount) || 0,
      currency: payload.currency || "",
    };
    renderSessionStats();
  }

  function setDonationsUnavailable() {
    if (donationsBody) donationsBody.innerHTML = "";
    if (donationsMeta) donationsMeta.textContent = "";
    if (donationsEmpty) {
      donationsEmpty.hidden = false;
      donationsEmpty.textContent = t("da.donationsUnavailable");
    }
  }

  async function loadDonations() {
    if (!donationsBody) return;
    const db = window.desktop?.db;
    if (!db || typeof db.getStreamEvents !== "function") {
      // В обычном браузере базы нет — говорим об этом, а не рисуем пустой список,
      // который выглядит как «донатов не было».
      setDonationsUnavailable();
      return;
    }
    if (donationsLoading) {
      // Запрос уже идёт: запоминаем, что после него нужен ещё один, иначе во время
      // всплеска донатов список остановился бы на середине серии.
      donationsQueued = true;
      return;
    }

    donationsLoading = true;
    try {
      /*
        Тестовые алерты в списке не нужны: он про реальные донаты.

        «Только этот стрим» — это граница по времени, а не фильтр по сессии: у
        стрим-событий нет sessionId, сессия считается по времени (так же, как в
        агрегатах сессий). Границы нет — значит ограничения нет.
      */
      const query = { limit: DONATIONS_LIMIT, type: "donation", includeTest: false };
      if (sessionOnly && sessionStartedAt > 0) query.since = sessionStartedAt;
      const result = await db.getStreamEvents(query);
      renderDonations((result && result.items) || [], (result && result.total) || 0);
    } catch {
      // Ошибка чтения истории — не повод ронять панель: результат запроса всё
      // равно виден в журнале сервиса, а здесь показываем пустое состояние.
      renderDonations([], 0);
    } finally {
      donationsLoading = false;
    }

    if (donationsQueued) {
      donationsQueued = false;
      loadDonations();
    }
  }

  // Перезапрос с задержкой: донат за донатом в эфире — это одно обращение к базе.
  function refreshDonations() {
    if (donationsTimer) clearTimeout(donationsTimer);
    donationsTimer = setTimeout(() => {
      donationsTimer = null;
      loadDonations();
    }, DONATIONS_REFRESH_DEBOUNCE_MS);
  }

  function renderFacts() {
    if (!facts) return;
    const rows = [fact("da.connection", escapeHtml(statusText(status)))];
    rows.push(fact("da.clientId", clientId ? escapeHtml(clientId) : escapeHtml(t("da.notFilled")), !clientId));
    // Три состояния, а не два: «секрет не читается» — не то же самое, что «не
    // заполнен». В первом случае сохранённый ключ надо вставить заново, иначе
    // сервис ответит невнятным invalid_client, а поле будет выглядеть заполненным.
    rows.push(
      fact(
        "da.clientSecret",
        escapeHtml(
          clientSecretUnreadable ? t("da.clientSecretUnreadable") : hasClientSecret ? t("da.filled") : t("da.notFilled")
        ),
        !hasClientSecret
      )
    );
    rows.push(fact("da.account", auth.userId ? escapeHtml(auth.userId) : t("da.accountUnknown")));

    if (!auth.connected) {
      rows.push(fact("da.token", escapeHtml(t("da.tokenMissing")), true));
    } else {
      const parts = [escapeHtml(t("da.tokenOk"))];
      if (auth.expiresAt > 0) parts.push(escapeHtml(t("da.tokenUntil", { time: formatDateTime(auth.expiresAt) })));
      else parts.push(escapeHtml(t("da.tokenUnknownExpiry")));
      rows.push(fact("da.token", parts.join(" · ")));
      rows.push(fact("da.refresh", escapeHtml(auth.refreshable ? t("da.tokenRefreshable") : t("da.tokenNotRefreshable")), !auth.refreshable));
    }

    facts.innerHTML = rows.join("");
  }

  function render() {
    renderFacts();
    renderSessionStats();

    if (chip) {
      chip.className = `da-panel__chip ${statusClass ? statusClass(status) : ""}`;
    }
    if (chipLabel) chipLabel.textContent = statusText(status);

    if (enabledSwitch) enabledSwitch.checked = enabled;
    if (voiceSwitch) voiceSwitch.checked = voiceOn;
    if (recoverBtn) {
      recoverBtn.disabled = recovering;
      recoverBtn.textContent = recovering ? t("queue.recovering") : t("queue.recover");
    }
    if (toggleBtn) toggleBtn.classList.toggle("is-connected", status === "connected");
  }

  function setOpen(open) {
    if (!panel || !toggleBtn) return;
    panel.hidden = !open;
    toggleBtn.classList.toggle("is-active", open);
    if (open) {
      render();
      // Список донатов читается из локальной базы, поэтому обновляем его при
      // каждом открытии: панель могла висеть закрытой весь стрим.
      loadDonations();
      if (logBody) logBody.scrollTop = logBody.scrollHeight;
    }
  }

  function toggle() {
    setOpen(!!(panel && panel.hidden));
  }

  function refreshLabel() {
    // В шапке — короткое «DA»: рядом стоят ещё восемь кнопок, и полное
    // «DonationAlerts» растягивало панель. Полное имя осталось в подсказке
    // (data-i18n-title в разметке) и в заголовке самой панели.
    if (toggleBtn) toggleBtn.innerHTML = `${ICONS.donation} ${t("da.short")}`;
    if (logSearch) logSearch.placeholder = t("da.logSearchPlaceholder");
    render();
  }

  // ---- привязка ----

  on("daCloseBtn", "click", () => setOpen(false));
  on("daLogClearBtn", "click", clearLog);
  on("daDonationsRefreshBtn", "click", loadDonations);
  on("daSessionResetBtn", "click", () => {
    // Счёт стрима — только цифра на экране: история и цель сбора его сбросом не
    // затрагиваются, но подтверждение всё равно нужно — промах обнулит итог стрима.
    if (confirm(t("session.resetConfirm"))) send(EVENT_TYPES.CMD_RESET_SESSION_STATS, {});
  });

  if (logSearch) {
    logSearch.addEventListener("input", () => applySearch(logSearch.value));
  }

  if (sessionOnlyInput) {
    sessionOnlyInput.addEventListener("change", () => {
      sessionOnly = sessionOnlyInput.checked;
      loadDonations();
    });
  }

  if (enabledSwitch) {
    enabledSwitch.addEventListener("change", () => {
      enabled = enabledSwitch.checked;
      send(EVENT_TYPES.CMD_SET_INTEGRATION_ENABLED, { service: "donationAlerts", enabled });
      render();
    });
  }

  if (voiceSwitch) {
    voiceSwitch.addEventListener("change", () => {
      voiceOn = voiceSwitch.checked;
      send(EVENT_TYPES.CMD_SET_DONATION_VOICE, { config: { donationAlerts: voiceOn } });
      render();
    });
  }

  on("daReconnectBtn", "click", () => {
    send(EVENT_TYPES.CMD_RESTART_INTEGRATION, { service: "donationAlerts" });
    if (showToast) showToast(t("da.reconnected"), "", "donation");
  });

  on("daTestDonationBtn", "click", () => send(EVENT_TYPES.CMD_TEST_ALERT, { kind: "donation" }));

  on("daConsoleBtn", "click", () => window.desktop?.openExternal?.("https://www.donationalerts.com/application/clients"));

  if (recoverBtn) {
    recoverBtn.addEventListener("click", () => {
      if (recovering) return;
      setRecovering(true);
      if (recoverStatus) {
        recoverStatus.hidden = true;
        recoverStatus.classList.remove("is-error");
      }
      send(EVENT_TYPES.CMD_RECOVER_DONATIONS, {});
    });
  }

  if (logBody) {
    logBody.addEventListener("scroll", () => {
      atBottom = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 40;
    });
  }

  // При первом подключении состояние уже могло прийти в снимке — берём его
  // отсюда, чтобы панель не показывала «не настроено» на подключённом сервисе.
  if (state && state.connectionStatus) applyStatus(state.connectionStatus.donationAlerts);

  return {
    appendLog,
    applySnapshot,
    applyStatus,
    applySessionStats,
    showRecoverResult,
    refreshDonations,
    setOpen,
    toggle,
    refreshLabel,
    clearLog,
  };
}
