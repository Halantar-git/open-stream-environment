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
  «Подтянуть пропущенные»: донаты, пришедшие пока приложение было выключено.

  Сокет DonationAlerts отдаёт только живые события, поэтому прошлое берётся из
  REST-списка донатов. Здесь проверяется именно решение о том, что считать
  пропущенным, — а не HTTP: сеть и подключение к DonationAlerts подменены
  заглушками, поэтому тест ничего не открывает наружу.

  Проверяем на настоящем сервере (start → шина → очередь → история), потому что
  ценность здесь как раз в стыке: подтянутый донат обязан попасть и в эфир, и в
  историю, но не попасть туда дважды.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const { WebSocket } = require("ws");
const { EVENT_TYPES } = require("../shared/events");

// Заглушки ставятся до загрузки сервера: server/index.js берёт эти функции из
// модуля интеграции, и подменить их позже уже нельзя.
let mockStartDonationAlerts = () => ({
  stop() {},
  getAccessToken: async () => "token",
});
let mockFetchRecentDonations = async () => ({ ok: true, donations: [] });

jest.mock("../server/integrations/donationalerts", () => {
  const actual = jest.requireActual("../server/integrations/donationalerts");
  return {
    ...actual,
    startDonationAlerts: (...args) => mockStartDonationAlerts(...args),
    fetchRecentDonations: (...args) => mockFetchRecentDonations(...args),
  };
});

const { configureStorage } = require("../server/storage-paths");
const { createDatabase } = require("../server/db");
const { createServer } = require("../server");
const { sleep, freePort, waitForListening, createClient } = require("./helpers/ws-client");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ose-recover-"));
}

function donation(overrides) {
  return {
    sourceId: "1",
    kind: "donation",
    user: "viewer",
    amount: 100,
    currency: "RUB",
    message: "",
    createdAt: Date.UTC(2026, 0, 1, 12, 0, 0),
    shown: false,
    ...overrides,
  };
}

describe("подтягивание пропущенных донатов", () => {
  let dir;
  let db;
  let handle;
  let port;
  let control;
  let overlay;
  // Токен с узнаваемым именем: по нему проверяем, что в снимок состояния он не
  // протекает (в самом config.json он есть — это его законное место).
  const ACCESS_TOKEN = "da-access-token-xyz";
  const TOKEN_EXPIRES_AT = Date.UTC(2026, 5, 1, 12, 0, 0);

  beforeAll(async () => {
    dir = tmpDir();
    configureStorage({ configDir: dir });
    port = await freePort();

    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        port,
        language: "ru",
        twitch: { channel: "", enabled: false },
        // Интеграция включена намеренно: без неё подтягивать нечем, а сам
        // «сокет» DonationAlerts подменён заглушкой и наружу не выходит.
        donationAlerts: {
          enabled: true,
          clientId: "da-client-id-123",
          clientSecret: "da-client-secret-xyz",
          accessToken: ACCESS_TOKEN,
          refreshToken: "da-refresh-token-xyz",
          userId: "4242",
          expiresAt: TOKEN_EXPIRES_AT,
        },
        youtube: { enabled: false },
        obs: { enabled: false },
        appearance: { activeThemeId: "nebula", customThemes: [] },
      })
    );

    db = createDatabase(path.join(dir, "local-db.json"));
    handle = createServer({ db, appName: "OSE recover", version: "9.9.9" });
    handle.start();
    await waitForListening(handle.server);

    control = createClient(WebSocket, port, "control");
    overlay = createClient(WebSocket, port, "overlay");
    await Promise.all([control.opened, overlay.opened]);
  });

  afterAll(async () => {
    [control, overlay].forEach((client) => client && client.close());
    handle.stop();
    await db.flush();
  });

  beforeEach(() => {
    handle.alertQueue.clear();
    handle.alertQueue.finishCurrent("skip");
    handle.alertQueue.resume();
    // Заглушка контроллера восстанавливается перед каждым тестом: тест «без
    // подключения» намеренно подсовывает контроллер без getAccessToken.
    mockStartDonationAlerts = () => ({ stop() {}, getAccessToken: async () => "token" });
    mockFetchRecentDonations = async () => ({ ok: true, donations: [] });
    handle.restartDonationAlerts();
  });

  test("снимок состояния рассказывает о подключении, не выдавая токены", () => {
    const auth = handle.state.snapshot().donationAlertsAuth;

    expect(auth).toEqual({
      connected: true,
      refreshable: true,
      userId: "4242",
      expiresAt: TOKEN_EXPIRES_AT,
      hasClientSecret: true,
      clientSecretUnreadable: false,
    });
    // Секретов в снимке нет: панель получает только «есть/можно обновить/до когда».
    expect(JSON.stringify(auth)).not.toContain("da-access-token");
    expect(JSON.stringify(auth)).not.toContain("da-refresh-token");
    expect(JSON.stringify(auth)).not.toContain("da-client-secret");
  });

  test("переподключение по кнопке перезапускает интеграцию", async () => {
    const started = [];
    const stopped = [];
    mockStartDonationAlerts = () => {
      const controller = {
        stop: () => stopped.push(true),
        getAccessToken: async () => "token",
      };
      started.push(controller);
      return controller;
    };
    handle.restartDonationAlerts();
    const startedBefore = started.length;

    control.send(EVENT_TYPES.CMD_RESTART_INTEGRATION, { service: "donationAlerts" });
    await sleep(40);

    // Новый контроллер создан, старый остановлен: иначе остались бы два живых
    // сокета и донаты приходили бы дважды.
    expect(started.length).toBe(startedBefore + 1);
    expect(stopped.length).toBeGreaterThanOrEqual(1);
  });

  test("неизвестный сервис для переподключения не роняет шину", async () => {
    control.send(EVENT_TYPES.CMD_RESTART_INTEGRATION, { service: "nope" });
    control.send(EVENT_TYPES.CMD_RESTART_INTEGRATION, {});
    await sleep(40);

    // Следующая команда доходит и применяется — значит сервер жив.
    control.send(EVENT_TYPES.CMD_ALERT_QUEUE_PAUSE, { minutes: 5 });
    const update = await control.waitFor(
      (msg) => msg.type === EVENT_TYPES.ALERT_QUEUE_UPDATE && msg.payload.queue.paused === true
    );
    expect(update.payload.queue.paused).toBe(true);
    control.send(EVENT_TYPES.CMD_ALERT_QUEUE_RESUME, {});
  });

  test("новые донаты уходят в очередь, историю и цель сбора", async () => {
    const goalBefore = handle.state.snapshot().goal.current;

    mockFetchRecentDonations = async () => ({
      ok: true,
      donations: [
        // Уже показанный сервисом донат не всплывает второй раз.
        donation({ sourceId: "shown-1", user: "already_seen", shown: true }),
        donation({ sourceId: "miss-1", user: "missed_one", amount: 150, createdAt: Date.UTC(2026, 0, 1, 10, 0, 0) }),
        donation({ sourceId: "miss-2", user: "missed_two", amount: 50, createdAt: Date.UTC(2026, 0, 1, 11, 0, 0) }),
      ],
    });

    const result = await handle.recoverDonations({ limit: 10 });
    expect(result).toEqual({ ok: true, count: 2 });

    // Панель получает ответ на свою кнопку вместе со свежим снимком очереди.
    // Ждём именно этот ответ (в файле есть и другие подтягивания), поэтому
    // сверяем и число: иначе можно поймать предыдущий ответ из истории клиента.
    const update = await control.waitFor(
      (msg) => msg.type === EVENT_TYPES.ALERT_QUEUE_UPDATE && msg.payload.recover && msg.payload.recover.count === 2
    );
    expect(update.payload.recover).toEqual({ ok: true, count: 2 });
    expect(update.payload.queue).toHaveProperty("rules");

    // Порядок — как в эфире: от старых к новым, иначе «пропущенное» перемешается.
    const snapshot = handle.alertQueue.snapshot();
    const queued = [snapshot.now, ...snapshot.items].filter(Boolean).map((item) => item.user);
    expect(queued).toEqual(["missed_one", "missed_two"]);
    expect(snapshot.now.recovered).toBe(true);

    // Подтянутый донат — настоящий донат: он попал в историю и в цель сбора.
    await db.flush();
    const rows = db.getStreamEvents({ limit: 100 }).items;
    expect(rows.map((item) => item.username)).toEqual(expect.arrayContaining(["missed_one", "missed_two"]));
    expect(rows.filter((item) => item.username === "missed_one")[0].source_id).toBe("miss-1");
    expect(handle.state.snapshot().goal.current).toBe(goalBefore + 200);
  });

  test("повторное подтягивание не дублирует уже подтянутое", async () => {
    mockFetchRecentDonations = async () => ({
      ok: true,
      donations: [donation({ sourceId: "miss-1", user: "missed_one", amount: 150 })],
    });

    const first = await handle.recoverDonations({ limit: 10 });
    expect(first.count).toBe(0);

    await db.flush();
    const rows = db.getStreamEvents({ limit: 100 }).items.filter((item) => item.source_id === "miss-1");
    expect(rows).toHaveLength(1);
    expect(handle.alertQueue.snapshot()).toMatchObject({ now: null, items: [] });
  });

  test("донат без id не считается известным и подтягивается один раз", async () => {
    mockFetchRecentDonations = async () => ({
      ok: true,
      donations: [donation({ sourceId: null, user: "anonymous_source", amount: 77 })],
    });

    const result = await handle.recoverDonations({ limit: 10 });
    expect(result.count).toBe(1);
    expect(handle.alertQueue.snapshot().now.user).toBe("anonymous_source");

    // В следующий раз он уже в истории по времени — но по id его не отсеять,
    // поэтому проверяем именно то, что запись появилась ровно одна.
    await db.flush();
    const rows = db.getStreamEvents({ limit: 100 }).items.filter((item) => item.username === "anonymous_source");
    expect(rows).toHaveLength(1);
  });

  test("нехватка scope объясняется понятной ошибкой, а не падением", async () => {
    mockFetchRecentDonations = async () => ({ ok: false, error: "insufficient_scope", donations: [] });

    const result = await handle.recoverDonations({ limit: 10 });
    expect(result).toEqual({ ok: false, error: "insufficient_scope", count: 0 });

    const update = await control.waitFor(
      (msg) => msg.type === EVENT_TYPES.ALERT_QUEUE_UPDATE && msg.payload.recover && msg.payload.recover.ok === false
    );
    expect(update.payload.recover.error).toBe("insufficient_scope");
  });

  test("без подключённого DonationAlerts подтягивать нечего", async () => {
    mockStartDonationAlerts = () => ({ stop() {} }); // контроллер без getAccessToken
    handle.restartDonationAlerts();

    const result = await handle.recoverDonations({ limit: 10 });
    expect(result).toEqual({ ok: false, error: "not_authorized", count: 0 });
    expect(handle.alertQueue.snapshot()).toMatchObject({ now: null, items: [] });
  });

  test("параллельный запрос не дублируется", async () => {
    let started = 0;
    mockFetchRecentDonations = async () => {
      started += 1;
      await sleep(60);
      return { ok: true, donations: [donation({ sourceId: "slow-1", user: "slow_donor" })] };
    };

    const [first, second] = await Promise.all([
      handle.recoverDonations({ limit: 10 }),
      handle.recoverDonations({ limit: 10 }),
    ]);

    // Один запрос к DonationAlerts уходит, второй отсекается: у сервиса лимит
    // 60 запросов в минуту, и кнопку может нажать несколько человек сразу.
    expect(started).toBe(1);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect([first.error, second.error]).toContain("in_progress");
  });

  test("ограничивается число запрашиваемых донатов", async () => {
    const limits = [];
    mockFetchRecentDonations = async (options) => {
      limits.push(options.limit);
      return { ok: true, donations: [] };
    };

    await handle.recoverDonations({ limit: 5 });
    await handle.recoverDonations({ limit: 10_000 });
    await handle.recoverDonations({ limit: -3 });
    await handle.recoverDonations({});

    expect(limits).toEqual([5, 100, 1, 30]);
  });

  test("подтянутые донаты не идут в счёт текущего стрима", async () => {
    const before = handle.state.snapshot().sessionDonations;
    mockFetchRecentDonations = async () => ({
      ok: true,
      donations: [
        donation({ sourceId: "past-1", user: "past_donor", amount: 900, createdAt: Date.UTC(2020, 0, 1, 0, 0, 0) }),
      ],
    });

    const result = await handle.recoverDonations({ limit: 10 });
    expect(result.count).toBe(1);

    // Донат подтянулся в очередь и в историю, но «за этот стрим» он не считается:
    // он случился в прошлом, и сумма за стрим должна остаться правдой.
    expect(handle.state.snapshot().sessionDonations).toEqual(before);
    // А вот в цель сбора он идёт — она накопительная, не по сессии.
    expect(handle.state.snapshot().goal.current).toBeGreaterThanOrEqual(900);
  });
});
