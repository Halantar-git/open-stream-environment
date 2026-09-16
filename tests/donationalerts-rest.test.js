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
  Чистые хелперы REST-догрузки донатов DonationAlerts и учёт уже известных
  source_id в истории:

  - parseDonationDate разбирает дату ответа API ("YYYY-MM-DD HH.MM.SS") как UTC;
  - normalizeDonationRow переводит строку /alerts/donations в наш формат;
  - fetchRecentDonations тянет список через подменённый fetch (сеть не трогаем)
    и возвращает ошибки объектом, а не исключением;
  - appendStreamEvent + knownSourceIds позволяют не добавлять пропущенные
    донаты второй раз.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  parseDonationDate,
  normalizeDonationRow,
  fetchRecentDonations,
  DONATIONS_URL,
} = require("../server/integrations/donationalerts");
const { configureStorage } = require("../server/storage-paths");
const { createDatabase } = require("../server/db");

// Минимальный ответ в форме fetch: тело отдаётся через json(), как у настоящего.
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("parseDonationDate", () => {
  test("разбирает дату DA как UTC", () => {
    expect(parseDonationDate("2026-03-04 12:30:45")).toBe(Date.UTC(2026, 2, 4, 12, 30, 45));
  });

  test("принимает T и точки как разделители", () => {
    const expected = Date.UTC(2026, 2, 4, 12, 30, 45);
    expect(parseDonationDate("2026-03-04T12:30:45")).toBe(expected);
    expect(parseDonationDate("2026-03-04 12.30.45")).toBe(expected);
    expect(parseDonationDate("2026-03-04T12.30.45")).toBe(expected);
  });

  test("хвост со часовым поясом и миллисекундами не сдвигает метку, мусор даёт 0", () => {
    const expected = Date.UTC(2026, 3, 5, 1, 2, 3);
    expect(parseDonationDate("2026-04-05 01:02:03+03:00")).toBe(expected);
    expect(parseDonationDate("2026-04-05T01:02:03.123Z")).toBe(expected);

    expect(parseDonationDate("")).toBe(0);
    expect(parseDonationDate(null)).toBe(0);
    expect(parseDonationDate(undefined)).toBe(0);
    expect(parseDonationDate("вчера")).toBe(0);
    expect(parseDonationDate("2026-03-04")).toBe(0);
    expect(parseDonationDate(20260304123045)).toBe(0);
  });
});

describe("normalizeDonationRow", () => {
  test("нормализует полную строку из ответа DA", () => {
    const row = normalizeDonationRow({
      id: 987654,
      username: "viewer",
      message: "gg",
      amount: "250.5",
      currency: "RUB",
      is_shown: 1,
      created_at: "2026-03-04 12:30:45",
      shown_at: "2026-03-04 12:31:00",
    });

    expect(row).toEqual({
      sourceId: "987654",
      kind: "donation",
      user: "viewer",
      amount: 250.5,
      currency: "RUB",
      message: "gg",
      createdAt: Date.UTC(2026, 2, 4, 12, 30, 45),
      shown: true,
    });
  });

  test("sourceId всегда строка, отсутствующий id — null, остальное по умолчанию", () => {
    expect(normalizeDonationRow({ id: 42 }).sourceId).toBe("42");
    expect(normalizeDonationRow({ id: "42" }).sourceId).toBe("42");
    expect(normalizeDonationRow({}).sourceId).toBeNull();

    // Пустые поля: ник, валюта и сообщение получают значения по умолчанию.
    const empty = normalizeDonationRow({ id: 1 });
    expect(empty.user).toBe("Аноним");
    expect(empty.currency).toBe("RUB");
    expect(empty.message).toBe("");
  });

  test("is_shown: 1 или непустой shown_at означают «уже показан»", () => {
    expect(normalizeDonationRow({ id: 1, is_shown: 1 }).shown).toBe(true);
    expect(normalizeDonationRow({ id: 1, is_shown: 0, shown_at: "2026-01-01 00:00:00" }).shown).toBe(true);
    expect(normalizeDonationRow({ id: 1, is_shown: 0, shown_at: null }).shown).toBe(false);
  });

  test("нечисловая или отсутствующая сумма даёт 0", () => {
    expect(normalizeDonationRow({ id: 1, amount: "abc" }).amount).toBe(0);
    expect(normalizeDonationRow({ id: 1, amount: null }).amount).toBe(0);
    expect(normalizeDonationRow({ id: 1 }).amount).toBe(0);
  });

  test("null и не-объект на входе дают null", () => {
    expect(normalizeDonationRow(null)).toBeNull();
    expect(normalizeDonationRow(undefined)).toBeNull();
    expect(normalizeDonationRow("viewer")).toBeNull();
    expect(normalizeDonationRow(123)).toBeNull();
  });
});

describe("fetchRecentDonations", () => {
  test("без токена запрос не отправляется", async () => {
    let called = false;
    const res = await fetchRecentDonations({
      getAccessToken: () => null,
      fetchImpl: async () => {
        called = true;
        return jsonResponse(200, { data: [] });
      },
    });

    expect(res).toEqual({ ok: false, error: "not_authorized", donations: [] });
    expect(called).toBe(false);
  });

  test("асинхронный геттер токена подставляется в Authorization", async () => {
    const calls = [];
    const res = await fetchRecentDonations({
      getAccessToken: async () => "tok-123",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse(200, { data: [] });
      },
    });

    expect(res).toEqual({ ok: true, donations: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${DONATIONS_URL}?page=1`);
    expect(calls[0].options.headers.Authorization).toBe("Bearer tok-123");
  });

  test("401 и 403 — токен выдан без scope oauth-donation-index", async () => {
    const withStatus = (status) =>
      fetchRecentDonations({ getAccessToken: () => "tok", fetchImpl: async () => jsonResponse(status, {}) });

    await expect(withStatus(401)).resolves.toEqual({
      ok: false,
      error: "insufficient_scope",
      status: 401,
      donations: [],
    });
    await expect(withStatus(403)).resolves.toEqual({
      ok: false,
      error: "insufficient_scope",
      status: 403,
      donations: [],
    });
  });

  test("прочие HTTP-ошибки отдаются кодом http_<status>", async () => {
    const res = await fetchRecentDonations({
      getAccessToken: () => "tok",
      fetchImpl: async () => jsonResponse(500, {}),
    });

    expect(res).toEqual({ ok: false, error: "http_500", status: 500, donations: [] });
  });

  test("успешный ответ нормализует донаты и соблюдает limit", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: 100 + i,
      username: `u${i}`,
      amount: String(10 + i),
      currency: "RUB",
      message: `m${i}`,
      is_shown: 0,
      created_at: "2026-03-04 12:30:45",
      shown_at: null,
    }));

    const res = await fetchRecentDonations({
      getAccessToken: () => "tok",
      limit: 2,
      fetchImpl: async () => jsonResponse(200, { data: rows }),
    });

    expect(res.ok).toBe(true);
    expect(res.donations).toHaveLength(2);
    expect(res.donations[0]).toEqual({
      sourceId: "100",
      kind: "donation",
      user: "u0",
      amount: 10,
      currency: "RUB",
      message: "m0",
      createdAt: Date.UTC(2026, 2, 4, 12, 30, 45),
      shown: false,
    });
    expect(res.donations[1].sourceId).toBe("101");
  });

  test("исключение fetch возвращается ошибкой, а не летит наружу", async () => {
    const res = await fetchRecentDonations({
      getAccessToken: () => "tok",
      fetchImpl: async () => {
        throw new Error("сеть недоступна");
      },
    });

    expect(res.ok).toBe(false);
    expect(res.donations).toEqual([]);
    expect(res.error).toContain("сеть недоступна");
  });

  test("page санитизируется и всегда даёт рабочий URL", async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return jsonResponse(200, { data: [] });
    };
    const call = (page) => fetchRecentDonations({ getAccessToken: () => "tok", page, fetchImpl });

    await call(undefined); // значение по умолчанию
    await call(3);
    await call("2.9");
    await call(0);
    await call("abc");
    await call(-5);

    expect(urls.map((url) => url.replace(DONATIONS_URL, ""))).toEqual([
      "?page=1",
      "?page=3",
      "?page=2",
      "?page=1",
      "?page=1",
      "?page=1",
    ]);
  });
});

describe("db: source_id и knownSourceIds", () => {
  let dir;
  let dbPath;
  let db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ose-da-rest-"));
    configureStorage({ configDir: dir });
    dbPath = path.join(dir, "local-db.json");
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test("source_id записывается строкой, события без него и дубликаты не мешают", async () => {
    db.appendStreamEvent({ type: "follow", username: "no_source" });
    db.appendStreamEvent({ type: "donation", username: "a", source_id: 555 });
    db.appendStreamEvent({ type: "donation", username: "b", source_id: "556" });
    db.appendStreamEvent({ type: "donation", username: "c", source_id: "556" });
    await db.flush();

    const known = db.knownSourceIds();
    expect(known).toBeInstanceOf(Set);
    expect([...known].sort()).toEqual(["555", "556"]);
    expect(known.has("555")).toBe(true);
  });

  test("source_id переживает запись на диск", async () => {
    db.appendStreamEvent({ type: "donation", username: "a", source_id: "777" });
    await db.flush();

    const reopened = createDatabase(dbPath);
    expect(reopened.knownSourceIds().has("777")).toBe(true);
  });

  test("limit ограничивает выборку самыми новыми событиями", async () => {
    db.appendStreamEvent({ type: "donation", source_id: "old", timestamp: 1000 });
    db.appendStreamEvent({ type: "donation", source_id: "mid", timestamp: 2000 });
    db.appendStreamEvent({ type: "donation", source_id: "new", timestamp: 3000 });
    await db.flush();

    expect([...db.knownSourceIds(2)].sort()).toEqual(["mid", "new"]);
  });
});
