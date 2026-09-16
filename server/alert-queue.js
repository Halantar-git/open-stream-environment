/*
  Copyright (C) 2026  Halantar

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License along
  with this program.  If not, see <https://gnu.org>.
*/

/*
  Очередь алертов на стороне сервера.

  Раньше очередь была только внутри виджета алертов в оверлее: он складывал
  приходящее в массив и показывал по одному. Это работало, пока страница OBS
  жива — но панель не знала, что происходит, перезагрузка страницы выбрасывала
  всё непоказанное, а повлиять на порядок было нельзя.

  Здесь очередь становится одна на всё приложение:

    * сервер решает, что играет сейчас, и рассылает алерты по одному, соблюдая
      паузу между ними (длительность алерта + хвост на анимацию ухода);
    * панель и пульт видят состояние (что играет, что ждёт) и могут вмешаться:
      пропустить, убрать, поднять наверх, проиграть сейчас, очистить, поставить
      на паузу;
    * при переподключении оверлея текущий алерт отправляется заново — то, что
      играло, не теряется из-за перезагрузки страницы;
    * правила: не показывать донаты ниже суммы, объединять подряд идущие донаты
      одного зрителя в один алерт с суммой и счётчиком.

  Что здесь намеренно НЕ происходит: история, цель сбора и «последние события»
  обновляются в момент прихода доната (это делает index.js), а не в момент
  показа. Донат случился тогда, когда случился, — очередь управляет только
  картинкой.

  Модуль чистый: часы и таймеры инжектируются, поэтому правила и порядок
  проверяются тестами без ожиданий и без оверлея.
*/

// Хвост после алерта: виджету нужно время на анимацию ухода, иначе следующий
// алерт начнётся поверх уезжающего.
const TAIL_MS = 400;

function defaultRules() {
  return { minAmount: 0, mergeSameUser: true, mergeWindowSec: 20 };
}

function createAlertQueue(options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const schedule = typeof options.schedule === "function" ? options.schedule : (fn, ms) => setTimeout(fn, ms);
  const cancel = typeof options.cancel === "function" ? options.cancel : (timer) => clearTimeout(timer);
  const onPlay = typeof options.onPlay === "function" ? options.onPlay : () => {};
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
  const tailMs = Number.isFinite(options.tailMs) ? Number(options.tailMs) : TAIL_MS;

  let rules = { ...defaultRules(), ...(options.rules || {}) };
  let now = null; // алерт в эфире
  let items = []; // ожидающие, первый — следующий
  let paused = false;
  let pausedUntil = 0; // 0 = пауза без срока
  let timer = null;
  let pauseTimer = null;
  let seq = 0;
  const stats = { received: 0, played: 0, skipped: 0, merged: 0, filtered: 0, recovered: 0 };

  function publicItem(item) {
    if (!item) return null;
    return { ...item };
  }

  function snapshot() {
    return {
      now: publicItem(now),
      items: items.map(publicItem),
      paused: isPaused(),
      pausedUntil: pausedUntil || null,
      rules: { ...rules },
      stats: { ...stats },
      pending: items.length,
    };
  }

  function changed(reason) {
    onChange({ reason, ...snapshot() });
  }

  // Пауза со сроком истекла сама — это не «на паузе», а ожидание продолжения.
  function pauseExpired() {
    return paused && pausedUntil > 0 && pausedUntil <= clock();
  }

  function isPaused() {
    return paused && !pauseExpired();
  }

  function clearTimers() {
    if (timer) cancel(timer);
    timer = null;
  }

  function scheduleNext(ms) {
    clearTimers();
    timer = schedule(() => {
      timer = null;
      finishCurrent("auto");
    }, Math.max(0, ms));
  }

  /*
    Постановка алерта в очередь.

    meta:
      force      — не фильтровать по минимальной сумме (тестовые алерты и
                   ручной повтор: пользователь нажал кнопку, значит хочет видеть);
      front      — поставить в начало очереди (повтор «сейчас»);
      ignorePause — играть даже на паузе (тестовые алерты);
      recovered  — донат, который подтянули с DonationAlerts как пропущенный.

    ignorePause подразумевает front: человек нажал кнопку «тестовый алерт» и ждёт
    картинку сейчас, а не после пяти реальных донатов.
  */
  function enqueue(alert, meta = {}) {
    return enqueueInternal(alert, meta.ignorePause ? { ...meta, front: true } : meta);
  }

  function enqueueInternal(alert, meta) {
    if (!alert || typeof alert !== "object") return { accepted: false, reason: "empty" };
    stats.received += 1;

    const amount = typeof alert.amount === "number" ? alert.amount : null;
    if (alert.kind === "donation" && amount !== null && !meta.force && rules.minAmount > 0 && amount < rules.minAmount) {
      stats.filtered += 1;
      return { accepted: false, reason: "below-min-amount" };
    }

    const at = clock();
    const item = {
      id: `al-${++seq}`,
      kind: String(alert.kind || "unknown"),
      user: alert.user || "",
      amount,
      currency: alert.currency || null,
      message: alert.message || "",
      count: Number(alert.count) || 0,
      tier: alert.tier || null,
      isTest: !!alert.isTest,
      recovered: !!meta.recovered,
      sourceId: alert.sourceId != null ? String(alert.sourceId) : null,
      durationMs: Number(alert.durationMs) || 5000,
      queuedAt: at,
    };
    if (item.recovered) stats.recovered += 1;

    /*
      Объединяем только с ожидающим хвостом очереди: алерт, который уже играет,
      задним числом не меняется — виджет уже нарисовал сумму и текст, и подмена
      значения на экране была бы враньём. Поэтому при всплеске донатов от одного
      зрителя первый алерт выходит как есть, а второй и третий — одним алертом
      с суммой и счётчиком.
    */
    const mergeTarget = items.length ? items[items.length - 1] : null;
    const withinWindow = mergeTarget && at - mergeTarget.queuedAt <= rules.mergeWindowSec * 1000;
    const canMerge =
      rules.mergeSameUser &&
      !meta.front &&
      item.kind === "donation" &&
      mergeTarget &&
      mergeTarget.kind === "donation" &&
      mergeTarget.user &&
      mergeTarget.user.toLowerCase() === item.user.toLowerCase() &&
      withinWindow;

    if (canMerge) {
      mergeTarget.amount = (mergeTarget.amount || 0) + (item.amount || 0);
      mergeTarget.count = (mergeTarget.count || 1) + 1;
      mergeTarget.message = item.message || mergeTarget.message;
      if (item.recovered) mergeTarget.recovered = true;
      stats.merged += 1;
      changed("merged");
      return { accepted: true, merged: true, item: publicItem(mergeTarget) };
    }

    if (meta.front) items.unshift(item);
    else items.push(item);
    changed("queued");
    drain({ ignorePause: !!meta.ignorePause });
    return { accepted: true, merged: false, item: publicItem(item) };
  }

  function drain(options = {}) {
    if (now) return;
    if (!items.length) return;
    if (pauseExpired()) {
      // Срок паузы вышел — продолжаем сами, без вмешательства пользователя.
      resume("timeout");
      return;
    }
    // ignorePause — для тестовых алертов: человек нажал кнопку и ждёт картинку
    // сейчас, но пауза при этом не снимается — остальная очередь стоит.
    if (paused && !options.ignorePause) return;

    now = items.shift();
    now.startedAt = clock();
    stats.played += 1;
    changed("playing");
    onPlay(publicItem(now));
    scheduleNext(now.durationMs + tailMs);
  }

  function finishCurrent(reason = "manual") {
    if (!now) return null;
    const finished = now;
    now = null;
    if (reason === "skip") stats.skipped += 1;
    clearTimers();
    changed("finished");
    drain();
    return publicItem(finished);
  }

  function remove(id) {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    items.splice(index, 1);
    changed("removed");
    return true;
  }

  // Поднять наверх: следующий алерт выйдет раньше остальных.
  function moveUp(id) {
    const index = items.findIndex((item) => item.id === id);
    if (index <= 0) return false;
    const [item] = items.splice(index, 1);
    items.unshift(item);
    changed("reordered");
    return true;
  }

  function playNow(id) {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [item] = items.splice(index, 1);
    if (now) {
      // Текущий возвращаем в начало ожидающих: пользователь не просил его убрать.
      items.unshift(now);
      now = null;
      clearTimers();
    }
    items.unshift(item);
    changed("play-now");
    drain();
    return true;
  }

  function clear() {
    const dropped = items.length;
    items = [];
    changed("cleared");
    return dropped;
  }

  /*
    Пауза: без аргумента — до явного продолжения, с минутами — на срок.
    Срок хранит index.js в конфиге, поэтому перезапуск приложения паузу не снимает.
  */
  function pause(minutes = 0) {
    paused = true;
    pausedUntil = minutes > 0 ? clock() + minutes * 60000 : 0;
    if (pauseTimer) cancel(pauseTimer);
    pauseTimer = minutes > 0 ? schedule(() => resume("timeout"), minutes * 60000) : null;
    changed("paused");
    return snapshot();
  }

  function resume(reason = "manual") {
    paused = false;
    pausedUntil = 0;
    if (pauseTimer) cancel(pauseTimer);
    pauseTimer = null;
    changed(reason === "timeout" ? "scroll-resumed" : "resumed");
    drain();
    return snapshot();
  }

  function setRules(patch = {}) {
    if (patch.minAmount !== undefined) rules.minAmount = Math.max(0, Number(patch.minAmount) || 0);
    if (patch.mergeSameUser !== undefined) rules.mergeSameUser = !!patch.mergeSameUser;
    if (patch.mergeWindowSec !== undefined) rules.mergeWindowSec = Math.max(0, Number(patch.mergeWindowSec) || 0);
    changed("rules");
    return { ...rules };
  }

  // Восстановление паузы из конфига при старте.
  function restorePause(pausedUntilTs) {
    const until = Number(pausedUntilTs) || 0;
    if (until <= clock()) return false;
    paused = true;
    pausedUntil = until;
    const ms = until - clock();
    if (pauseTimer) cancel(pauseTimer);
    if (ms > 0) {
      pauseTimer = schedule(() => resume("timeout"), ms);
      if (pauseTimer && typeof pauseTimer.unref === "function") pauseTimer.unref();
    }
    return true;
  }

  function stop() {
    clearTimers();
    if (pauseTimer) cancel(pauseTimer);
    pauseTimer = null;
  }

  return {
    enqueue,
    drain,
    finishCurrent,
    remove,
    moveUp,
    playNow,
    clear,
    pause,
    resume,
    setRules,
    restorePause,
    snapshot,
    stop,
    get rules() {
      return { ...rules };
    },
  };
}

module.exports = { createAlertQueue, defaultRules, TAIL_MS };
