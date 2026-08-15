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

const { buildTestAlert, eventTypeForKind, toStreamEvent } = require("../server/index");

describe("server/index helpers", () => {
  test("buildTestAlert формирует корректные поля по kind", () => {
    const follow = buildTestAlert("follow");
    expect(follow.kind).toBe("follow");
    expect(typeof follow.user).toBe("string");

    expect(buildTestAlert("sub")).toMatchObject({ kind: "sub", tier: "1000" });
    expect(buildTestAlert("gift_sub")).toMatchObject({ kind: "gift_sub", count: 3 });
    expect(buildTestAlert("cheer")).toMatchObject({ kind: "cheer", amount: 250 });
    expect(buildTestAlert("donation")).toMatchObject({ kind: "donation", amount: 300, currency: "RUB" });
    expect(buildTestAlert()).toMatchObject({ kind: "follow" });
  });

  test("eventTypeForKind маппит kind в тип события", () => {
    expect(eventTypeForKind("follow")).toBe("follow");
    expect(eventTypeForKind("sub")).toBe("subscription");
    expect(eventTypeForKind("gift_sub")).toBe("subscription");
    expect(eventTypeForKind("donation")).toBe("donation");
    expect(eventTypeForKind("cheer")).toBe("cheer");
    expect(eventTypeForKind(undefined)).toBe("unknown");
  });

  test("toStreamEvent собирает запись истории", () => {
    const record = toStreamEvent(
      { kind: "sub", user: "viewer", count: 2, tier: "1000" },
      false
    );

    expect(record).toMatchObject({
      type: "subscription",
      kind: "sub",
      username: "viewer",
      amount: null,
      currency: null,
      message: "",
      is_test: false,
      count: 2,
      tier: "1000",
    });
    expect(typeof record.timestamp).toBe("number");
  });

  test("toStreamEvent подставляет Анонима и помечает тест", () => {
    const record = toStreamEvent({ kind: "donation", amount: 10 }, true);
    expect(record.username).toBe("Аноним");
    expect(record.is_test).toBe(true);
    expect(record.amount).toBe(10);
    expect(record.type).toBe("donation");
  });
});
