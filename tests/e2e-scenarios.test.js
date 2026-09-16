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
  Сквозные сценарии: сервер + живые клиенты шины + файлы на диске.

  Юнит-тесты проверяют звенья по отдельности, а здесь — цепочку целиком, как её
  видит пользователь:

    панель (роль control) → команда → сервер → рассылка оверлею (роль overlay)
                                              → запись в local-db.json / JSONL

  Ломается обычно именно на стыках: не тот тип события в рассылке, потерянная
  запись на диск, микрокадры, ушедшие не тому клиенту, история, разъехавшаяся с
  сессией стрима.

  Сервер поднимается как в жизни — через `start()`, — но конфиг в темп-каталоге
  заранее выключает все интеграции, поэтому наружу ничего не уходит.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const { WebSocket } = require("ws");
const MicFrame = require("../shared/mic-frame");
const { EVENT_TYPES } = require("../shared/events");

const { configureStorage } = require("../server/storage-paths");
const { createDatabase } = require("../server/db");
const { createServer } = require("../server");
const { sleep, freePort, waitForListening, createClient: makeClient } = require("./helpers/ws-client");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ose-e2e-"));
}

// Клиент шины — из общего хелпера; здесь только привязка к текущему порту.
function createClient(port, role) {
  return makeClient(WebSocket, port, role);
}

describe("сквозные сценарии", () => {
  let dir;
  let db;
  let handle;
  let port;
  let control;
  let overlay;
  let extra;

  beforeAll(async () => {
    dir = tmpDir();
    configureStorage({ configDir: dir });
    port = await freePort();

    // Конфиг «как у пользователя, но без интеграций»: Twitch/YouTube/OBS
    // выключены, канал пустой — старт сервера не лезет в сеть.
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        port,
        language: "ru",
        notificationVolume: 0.8,
        twitch: { channel: "", enabled: false },
        donationAlerts: { enabled: false },
        youtube: { enabled: false },
        obs: { enabled: false },
        appearance: { activeThemeId: "nebula", customThemes: [] },
      })
    );

    db = createDatabase(path.join(dir, "local-db.json"));
    handle = createServer({ db, appName: "OSE E2E", version: "9.9.9" });
    handle.start();
    await waitForListening(handle.server);

    control = createClient(port, "control");
    overlay = createClient(port, "overlay");
    await Promise.all([control.opened, overlay.opened]);
  });

  afterAll(async () => {
    [control, overlay, extra].forEach((client) => client && client.close());
    handle.stop();
    await db.flush();
  });

  test("старт сервера открывает сессию стрима", () => {
    const sessions = db.getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].channel).toBe("");
    expect(sessions[0].startedAt).toBeTruthy();
  });

  test("подключившись, клиент сразу получает словари и состояние", async () => {
    const locales = await overlay.waitFor((msg) => msg.type === EVENT_TYPES.LOCALES);
    const state = await overlay.waitFor((msg) => msg.type === EVENT_TYPES.STATE);

    expect(locales.payload.locales).toHaveProperty("ru");
    expect(locales.payload.locales).toHaveProperty("en");
    expect(state.payload).toHaveProperty("layout");
    expect(state.payload.remoteUrl).toContain(`:${port}/remote?token=`);
  });

  test("виджет из панели доезжает до оверлея и до диска", async () => {
    control.send(EVENT_TYPES.CMD_ADD_WIDGET, { type: "chat" });

    const update = await overlay.waitFor((msg) => msg.type === EVENT_TYPES.LAYOUT_UPDATE);
    const added = update.payload.layout.find((widget) => widget.type === "chat");
    expect(added).toBeTruthy();
    expect(added.id).toBeTruthy();

    // Та же раскладка ушла и панели (у неё свой сокет), и в память сервера.
    expect(control.messages.some((msg) => msg.type === EVENT_TYPES.LAYOUT_UPDATE)).toBe(true);
    expect(db.getWidgets().map((widget) => widget.id)).toContain(added.id);

    await db.flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "local-db.json"), "utf8"));
    expect(onDisk.overlay.widgets.map((widget) => widget.id)).toContain(added.id);
  });

  test("правка виджета применяется и сохраняется", async () => {
    const widget = db.getWidgets()[0];
    control.send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: widget.id, patch: { x: 12.5, y: 40, visible: false } });

    const update = await overlay.waitFor((msg) => {
      if (msg.type !== EVENT_TYPES.LAYOUT_UPDATE) return false;
      const target = msg.payload.layout.find((item) => item.id === widget.id);
      return !!target && target.x === 12.5 && target.visible === false;
    });

    const target = update.payload.layout.find((item) => item.id === widget.id);
    expect(target).toMatchObject({ x: 12.5, y: 40, visible: false });

    await db.flush();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "local-db.json"), "utf8"));
    expect(onDisk.overlay.widgets.find((item) => item.id === widget.id)).toMatchObject({ x: 12.5 });
  });

  test("тестовый алерт уходит оверлею с длительностью", async () => {
    control.send(EVENT_TYPES.CMD_TEST_ALERT, { kind: "donation" });

    const alert = await overlay.waitFor((msg) => msg.type === EVENT_TYPES.ALERT);

    expect(alert.payload.kind).toBe("donation");
    expect(alert.payload.amount).toBeGreaterThan(0);
    expect(alert.payload.durationMs).toBeGreaterThan(0);
  });

  test("сообщение чата из сети уходит оверлею и ложится в историю", async () => {
    // Так же, как это делает подключение к Twitch: событие приходит на шину.
    handle.bus.emit("chat_message", { user: "real_viewer", color: "#fff", badges: [], message: "живое сообщение", isTest: false });

    const chat = await overlay.waitFor((msg) => msg.type === EVENT_TYPES.CHAT_MESSAGE);
    expect(chat.payload.message).toBe("живое сообщение");

    await db.flush();
    const messages = db.getChat();
    expect(messages.map((item) => item.message)).toContain("живое сообщение");
    expect(messages[0].sessionId).toBe(db.getSessions()[0].id);
    expect(fs.readFileSync(path.join(dir, "local-db.chat.jsonl"), "utf8")).toContain("живое сообщение");
  });

  test("тестовое сообщение чата не засоряет историю", async () => {
    const before = db.getChat().length;
    control.send(EVENT_TYPES.CMD_TEST_CHAT, { count: 2 });

    const chat = await overlay.waitFor((msg) => msg.type === EVENT_TYPES.CHAT_MESSAGE && msg.payload.isTest === true);
    expect(chat.payload.user).toBeTruthy();

    await db.flush();
    expect(db.getChat()).toHaveLength(before);
  });

  test("событие стрима: запись, выдача в историю и повтор алерта", async () => {
    // Предыдущий тестовый алерт мог ещё играть: очередь решает, что в эфире, и
    // порядок в ней проверяется отдельно ниже. Здесь важно, что повтор вообще
    // встаёт в очередь и доезжает до оверлея.
    handle.alertQueue.clear();
    handle.alertQueue.finishCurrent("skip");

    const row = db.appendStreamEvent({
      type: "donation",
      kind: "donation",
      username: "e2e_viewer",
      amount: 250,
      currency: "RUB",
      message: "проверка сквозного сценария",
    });
    await db.flush();

    const page = handle.getStreamEvents({ limit: 10 });
    expect(page.items.map((item) => item.id)).toContain(row.id);

    /*
      Ставим в эфир «заглушку»: повтор должен встать перед очередью, но не
      выкинуть то, что уже играет.
    */
    handle.bus.emit("alert", { kind: "follow", user: "blocker_viewer" });
    await overlay.waitFor((msg) => msg.type === EVENT_TYPES.ALERT && msg.payload.user === "blocker_viewer");

    const replayed = handle.replayEvent(row.id);
    expect(replayed.username).toBe("e2e_viewer");
    expect(handle.alertQueue.snapshot().now.user).toBe("blocker_viewer");
    expect(handle.alertQueue.snapshot().items[0].user).toBe("e2e_viewer");
    handle.alertQueue.finishCurrent("skip");

    const alert = await overlay.waitFor((msg) => msg.type === EVENT_TYPES.ALERT && msg.payload.user === "e2e_viewer");
    expect(alert.payload.amount).toBe(250);
  });

  test("очередь алертов играет по одному, а панель видит снимок", async () => {
    handle.alertQueue.clear();
    handle.alertQueue.finishCurrent("skip");

    handle.bus.emit("alert", { kind: "follow", user: "queue_one" });
    const first = await overlay.waitFor((msg) => msg.type === EVENT_TYPES.ALERT && msg.payload.user === "queue_one");
    expect(first.payload.durationMs).toBeGreaterThan(0);

    // Второй алерт не отправляется сразу: пока играет первый, он ждёт.
    handle.bus.emit("alert", { kind: "follow", user: "queue_two" });
    await sleep(80);
    expect(overlay.messages.some((msg) => msg.type === EVENT_TYPES.ALERT && msg.payload.user === "queue_two")).toBe(false);

    const snapshot = handle.alertQueue.snapshot();
    expect(snapshot.now.user).toBe("queue_one");
    expect(snapshot.items.map((item) => item.user)).toContain("queue_two");

    // Та же картина ушла клиентам — по ней рисуется панель и пульт.
    const update = await control.waitFor((msg) => msg.type === EVENT_TYPES.ALERT_QUEUE_UPDATE);
    expect(update.payload.queue).toHaveProperty("rules");
    expect(update.payload.queue).toHaveProperty("stats");

    // «Пропустить» в панели — второй алерт выходит сразу.
    control.send(EVENT_TYPES.CMD_ALERT_QUEUE_SKIP, {});
    const second = await overlay.waitFor((msg) => msg.type === EVENT_TYPES.ALERT && msg.payload.user === "queue_two");
    expect(second.payload.kind).toBe("follow");
    expect(handle.alertQueue.snapshot().stats.skipped).toBeGreaterThan(0);
  });

  test("правило минимальной суммы прячет показ, но не сам донат", async () => {
    handle.alertQueue.clear();
    handle.alertQueue.finishCurrent("skip");
    const filteredBefore = handle.alertQueue.snapshot().stats.filtered;

    control.send(EVENT_TYPES.CMD_ALERT_QUEUE_CONFIG, { minAmount: 500 });
    const rules = await control.waitFor((msg) => msg.type === EVENT_TYPES.ALERT_QUEUE_UPDATE && msg.payload.queue.rules.minAmount === 500);
    expect(rules.payload.queue.rules.minAmount).toBe(500);

    handle.bus.emit("alert", { kind: "donation", user: "small_donor", amount: 10 });
    handle.bus.emit("alert", { kind: "donation", user: "big_donor", amount: 900, currency: "RUB" });

    const big = await overlay.waitFor((msg) => msg.type === EVENT_TYPES.ALERT && msg.payload.user === "big_donor");
    expect(big.payload.amount).toBe(900);
    expect(overlay.messages.some((msg) => msg.type === EVENT_TYPES.ALERT && msg.payload.user === "small_donor")).toBe(false);

    // Отсеян только показ: донат настоящий, он попал в историю и в цель сбора.
    expect(handle.alertQueue.snapshot().stats.filtered).toBe(filteredBefore + 1);
    expect(db.getStreamEvents({ limit: 10 }).items.some((item) => item.username === "small_donor")).toBe(true);

    control.send(EVENT_TYPES.CMD_ALERT_QUEUE_CONFIG, { minAmount: 0 });
    await control.waitFor((msg) => msg.type === EVENT_TYPES.ALERT_QUEUE_UPDATE && msg.payload.queue.rules.minAmount === 0);
  });

  test("пауза останавливает показ, но алерты не теряются", async () => {
    handle.alertQueue.clear();
    handle.alertQueue.finishCurrent("skip");

    control.send(EVENT_TYPES.CMD_ALERT_QUEUE_PAUSE, {});
    await control.waitFor((msg) => msg.type === EVENT_TYPES.ALERT_QUEUE_UPDATE && msg.payload.queue.paused === true);

    handle.bus.emit("alert", { kind: "follow", user: "paused_viewer" });
    await sleep(80);
    expect(overlay.messages.some((msg) => msg.type === EVENT_TYPES.ALERT && msg.payload.user === "paused_viewer")).toBe(false);
    expect(handle.alertQueue.snapshot().items.map((item) => item.user)).toContain("paused_viewer");

    control.send(EVENT_TYPES.CMD_ALERT_QUEUE_RESUME, {});
    const alert = await overlay.waitFor((msg) => msg.type === EVENT_TYPES.ALERT && msg.payload.user === "paused_viewer");
    expect(alert.payload.kind).toBe("follow");
  });

  test("переподключившийся оверлей получает алерт, который играет", async () => {
    handle.alertQueue.clear();
    handle.alertQueue.finishCurrent("skip");

    handle.bus.emit("alert", { kind: "follow", user: "reload_viewer" });
    await overlay.waitFor((msg) => msg.type === EVENT_TYPES.ALERT && msg.payload.user === "reload_viewer");

    // Перезагрузка страницы OBS не должна съедать то, что в эфире.
    const fresh = createClient(port, "overlay");
    await fresh.opened;

    const replayed = await fresh.waitFor((msg) => msg.type === EVENT_TYPES.ALERT);
    expect(replayed.payload.user).toBe("reload_viewer");

    // Но второй записи в историю от повторной отправки не появляется: историю
    // пишет приход доната, а не рассылка.
    await db.flush();
    const rows = db.getStreamEvents({ limit: 100 }).items.filter((item) => item.username === "reload_viewer");
    expect(rows).toHaveLength(1);

    fresh.close();
    handle.alertQueue.finishCurrent("skip");
  });

  test("микрокадры уходят только оверлею", async () => {
    extra = createClient(port, "chat");
    await extra.opened;

    const frame = MicFrame.encode(0.5, new Uint8Array(MicFrame.WAVE_LEN).fill(128), new Uint8Array(MicFrame.FREQ_LEN).fill(64));
    control.sendBinary(frame);

    const relayed = await overlay.waitForBinary();
    expect(relayed).toBeTruthy();
    expect(MicFrame.isFrame(relayed)).toBe(true);
    // Сервер пересылает кадр как есть, не разбирая: байты должны совпасть.
    expect(Buffer.compare(relayed, Buffer.from(frame))).toBe(0);

    // Клиенты других ролей микрокадры не получают — иначе панель и чат зря
    // тратили бы трафик на 30 кадров в секунду.
    await sleep(80);
    expect(extra.binary).toHaveLength(0);
  });

  test("переподключившийся оверлей получает актуальную раскладку, а не пустую", async () => {
    const fresh = createClient(port, "overlay");
    await fresh.opened;

    const state = await fresh.waitFor((msg) => msg.type === EVENT_TYPES.STATE);
    expect(state.payload.layout.map((widget) => widget.id)).toEqual(db.getWidgets().map((widget) => widget.id));

    fresh.close();
  });

  test("команды панели не отбрасываются ограничителем частоты", async () => {
    // Панель шлёт команды по одной на действие: серия подряд должна пройти
    // целиком, а не упереться в лимит 60 в секунду.
    for (let i = 0; i < 20; i++) control.send(EVENT_TYPES.CMD_SET_NOTIFICATION_VOLUME, { volume: 0.5 });
    control.send(EVENT_TYPES.CMD_SET_NOTIFICATION_VOLUME, { volume: 0.7 });

    const applied = await overlay.waitFor((msg) => msg.type === EVENT_TYPES.STATE && msg.payload.notificationVolume === 0.7);
    expect(applied).toBeTruthy();

    const limited = handle.recentAudit(200).filter((entry) => entry.limited);
    expect(limited).toEqual([]);
  });

  test("последние донаты для панели DonationAlerts читаются без тестовых", async () => {
    await db.flush();

    const withTest = db.getStreamEvents({ limit: 50, type: "donation" }).items;
    const withoutTest = db.getStreamEvents({ limit: 50, type: "donation", includeTest: false }).items;

    // Тестовый донат лежит в истории (он был показан выше), но в список
    // реальных донатов попадать не должен: панель показывает факты, не репетицию.
    expect(withTest.some((item) => item.is_test === true)).toBe(true);
    expect(withoutTest.some((item) => item.is_test === true)).toBe(false);
    expect(withoutTest.length).toBeGreaterThan(0);
    expect(withoutTest.every((item) => item.type === "donation")).toBe(true);
    // Поля, которые нужны строке списка для повтора алерта.
    withoutTest.forEach((item) => {
      expect(item.id).toBeTruthy();
      expect(typeof item.timestamp).toBe("number");
    });
  });

  test("выключение очереди возвращает прямую рассылку и сбрасывает ожидающих", async () => {
    handle.alertQueue.clear();
    handle.alertQueue.finishCurrent("skip");
    handle.alertQueue.resume();

    // Пока очередь включена, второй алерт ждёт первого.
    handle.bus.emit("alert", { kind: "follow", user: "queued_first" });
    handle.bus.emit("alert", { kind: "follow", user: "queued_second" });
    await overlay.waitFor((msg) => msg.type === EVENT_TYPES.ALERT && msg.payload.user === "queued_first");
    expect(handle.alertQueue.snapshot().items.map((item) => item.user)).toEqual(["queued_second"]);

    control.send(EVENT_TYPES.CMD_ALERT_QUEUE_CONFIG, { enabled: false });
    const off = await control.waitFor((msg) => msg.type === EVENT_TYPES.ALERT_QUEUE_UPDATE && msg.payload.queue.enabled === false);
    expect(off.payload.queue.enabled).toBe(false);

    // Ожидавшие сбрасываются: выключенная очередь не должна выстрелить залежавшимся.
    expect(handle.alertQueue.snapshot().items).toEqual([]);
    // Но тот, что уже в эфире, не обрывается: смена режима не должна выдёргивать
    // картинку из-под зрителя, он доиграет и уйдёт сам.
    expect(handle.alertQueue.snapshot().now.user).toBe("queued_first");

    // Теперь алерты уходят сразу и без правил — два подряд, без ожидания.
    control.send(EVENT_TYPES.CMD_ALERT_QUEUE_CONFIG, { minAmount: 500 });
    await control.waitFor((msg) => msg.type === EVENT_TYPES.ALERT_QUEUE_UPDATE && msg.payload.queue.rules.minAmount === 500);

    handle.bus.emit("alert", { kind: "donation", user: "off_one", amount: 5 });
    handle.bus.emit("alert", { kind: "donation", user: "off_two", amount: 7 });

    await overlay.waitFor((msg) => msg.type === EVENT_TYPES.ALERT && msg.payload.user === "off_two");
    const seen = overlay.messages.filter((m) => m.type === EVENT_TYPES.ALERT).map((m) => m.payload.user);
    expect(seen).toEqual(expect.arrayContaining(["off_one", "off_two"]));
    // В очередь никто не вставал: ожидающих нет, а в эфире всё ещё тот алерт,
    // что играл с включённой очередью.
    expect(handle.alertQueue.snapshot().items).toEqual([]);
    expect(handle.alertQueue.snapshot().now.user).toBe("queued_first");

    // Свежий клиент видит флаг в общем состоянии, а не только в событии очереди.
    const fresh = createClient(port, "control");
    await fresh.opened;
    const snapshot = await fresh.waitFor((msg) => msg.type === EVENT_TYPES.STATE);
    expect(snapshot.payload.alertQueue).toMatchObject({ enabled: false, pending: 0 });
    fresh.close();

    // Возвращаем обычный режим, чтобы не влиять на остальные проверки.
    handle.alertQueue.finishCurrent("skip");
    control.send(EVENT_TYPES.CMD_ALERT_QUEUE_CONFIG, { enabled: true, minAmount: 0 });
    await control.waitFor((msg) => msg.type === EVENT_TYPES.ALERT_QUEUE_UPDATE && msg.payload.queue.enabled === true);
  });

  test("счёт донатов текущего стрима приходит отдельным событием", async () => {
    const before = handle.state.snapshot().sessionDonations;
    const expected = before.amount + 250;

    handle.bus.emit("alert", { kind: "donation", user: "session_donor", amount: 250, currency: "RUB" });

    // Сумма уникальна и растёт, поэтому по ней находим именно свежее событие,
    // а не одно из тех, что уже прошли в этом же сценарии.
    const stats = await overlay.waitFor((msg) => msg.type === EVENT_TYPES.SESSION_STATS && msg.payload.amount === expected);
    expect(stats.payload).toEqual({ count: before.count + 1, amount: expected, currency: "RUB" });
    expect(handle.state.snapshot().sessionDonations.amount).toBe(expected);
  });

  test("подключившийся клиент сразу видит границу стрима и текущий счёт", async () => {
    const fresh = createClient(port, "control");
    await fresh.opened;

    const snapshot = await fresh.waitFor((msg) => msg.type === EVENT_TYPES.STATE);
    // Граница нужна режиму «только этот стрим» в панели DonationAlerts.
    expect(snapshot.payload.sessionStartedAt).toBeGreaterThan(0);
    expect(snapshot.payload.sessionStartedAt).toBeLessThanOrEqual(Date.now());
    expect(snapshot.payload.sessionDonations.count).toBeGreaterThan(0);

    // Донаты этой сессии находятся по этой же границе: у стрим-событий нет
    // sessionId, сессия считается по времени.
    const page = db.getStreamEvents({ limit: 50, type: "donation", since: snapshot.payload.sessionStartedAt });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.timestamp >= snapshot.payload.sessionStartedAt)).toBe(true);

    fresh.close();
  });

  test("счёт стрима обнуляется по команде, не задевая историю и цель", async () => {
    const before = handle.state.snapshot().sessionDonations;
    expect(before.count).toBeGreaterThan(0);

    control.send(EVENT_TYPES.CMD_RESET_SESSION_STATS, {});
    const stats = await control.waitFor(
      (msg) => msg.type === EVENT_TYPES.SESSION_STATS && msg.payload.count === 0 && msg.payload.amount === 0
    );
    expect(stats.payload).toEqual({ count: 0, amount: 0, currency: "" });

    // Сброс касается только цифры на экране: донаты остаются в истории,
    // а цель сбора — накопительная, еë он не трогает.
    await db.flush();
    expect(db.getStreamEvents({ limit: 5, type: "donation" }).items.length).toBeGreaterThan(0);
    expect(handle.state.snapshot().goal.current).toBeGreaterThan(0);
  });

  test("остановка сервера закрывает сессию и шину", async () => {
    const session = db.getSessions()[0];

    expect(() => handle.stop()).not.toThrow();

    expect(handle.server.listening).toBe(false);
    expect(db.getSessions()[0].endedAt).toBeTruthy();
    expect(db.getSessions()[0].id).toBe(session.id);
  });
});
