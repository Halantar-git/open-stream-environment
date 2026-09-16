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

const { buildTestAlert, eventTypeForKind, toStreamEvent, roleFromUrl, shouldHideWheelAfterSpin, isAllowedWsOrigin } = require("../server/index");

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

  test("roleFromUrl читает роль из query строки подключения", () => {
    expect(roleFromUrl("/ws?role=overlay")).toBe("overlay");
    expect(roleFromUrl("/ws?foo=1&role=chat")).toBe("chat");
    expect(roleFromUrl("/ws?role=")).toBe("other");
    expect(roleFromUrl("/ws")).toBe("other");
    expect(roleFromUrl("")).toBe("other");
    expect(roleFromUrl(undefined)).toBe("other");
    expect(roleFromUrl("/ws", "scene")).toBe("scene");
  });

  test("shouldHideWheelAfterSpin: прячем только когда цикл закончен", () => {
    // Обычный режим — прячем после любого победителя.
    expect(shouldHideWheelAfterSpin({ eliminationMode: false, isFinalWinner: false })).toBe(true);
    // На выбывание, но победитель финальный — цикл закончен.
    expect(shouldHideWheelAfterSpin({ eliminationMode: true, isFinalWinner: true })).toBe(true);
    // На выбывание, есть ещё участники — колесо должно остаться для следующего спина.
    expect(shouldHideWheelAfterSpin({ eliminationMode: true, isFinalWinner: false })).toBe(false);
    // Защита от пустого значения.
    expect(shouldHideWheelAfterSpin(null)).toBe(true);
  });

  describe("isAllowedWsOrigin", () => {
    const withOrigin = (origin) => ({ headers: { origin } });

    test("клиент без Origin (Stream Deck, тесты) допускается", () => {
      expect(isAllowedWsOrigin({ headers: {} }, 8710)).toBe(true);
      expect(isAllowedWsOrigin(undefined, 8710)).toBe(true);
    });

    test("окна Electron из file:// допускаются", () => {
      expect(isAllowedWsOrigin(withOrigin("file://"), 8710)).toBe(true);
      expect(isAllowedWsOrigin(withOrigin("null"), 8710)).toBe(true);
    });

    test("локальные и LAN-источники допускаются", () => {
      expect(isAllowedWsOrigin(withOrigin("http://localhost:8710"), 8710)).toBe(true);
      expect(isAllowedWsOrigin(withOrigin("http://127.0.0.1:8710"), 8710)).toBe(true);
      expect(isAllowedWsOrigin(withOrigin("http://[::1]:8710"), 8710)).toBe(true);
      expect(isAllowedWsOrigin(withOrigin("http://192.168.1.50:8710"), 8710)).toBe(true);
      expect(isAllowedWsOrigin(withOrigin("http://10.0.0.7:8710"), 8710)).toBe(true);
      expect(isAllowedWsOrigin(withOrigin("http://mypc.local:8710"), 8710)).toBe(true);
      expect(isAllowedWsOrigin(withOrigin("http://DESKTOP-ABC:8710"), 8710)).toBe(true);
    });

    test("сторонние сайты и подмена порта/схемы отклоняются", () => {
      expect(isAllowedWsOrigin(withOrigin("https://evil.com"), 8710)).toBe(false);
      expect(isAllowedWsOrigin(withOrigin("http://evil.com:8710"), 8710)).toBe(false);
      expect(isAllowedWsOrigin(withOrigin("http://localhost:8711"), 8710)).toBe(false);
      expect(isAllowedWsOrigin(withOrigin("ftp://localhost:8710"), 8710)).toBe(false);
      expect(isAllowedWsOrigin(withOrigin("not a url"), 8710)).toBe(false);
    });
  });
});
