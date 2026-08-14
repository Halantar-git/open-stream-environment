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

const {
  extractPayload,
  donationAlertFromPayload,
} = require("../server/integrations/donationalerts");

describe("donationalerts parsing", () => {
  test("extractPayload разбирает современный Centrifugo push", () => {
    const msg = {
      push: {
        pub: {
          data: {
            data: { username: "viewer", amount: "300", currency: "RUB", message: "hi" },
          },
        },
      },
    };
    expect(extractPayload(msg)).toEqual({
      username: "viewer",
      amount: "300",
      currency: "RUB",
      message: "hi",
    });
  });

  test("extractPayload разбирает данные-строку JSON", () => {
    const msg = {
      push: { pub: { data: JSON.stringify({ username: "v", amount: 10 }) } },
    };
    expect(extractPayload(msg)).toEqual({ username: "v", amount: 10 });
  });

  test("extractPayload возвращает null для неизвестной формы", () => {
    expect(extractPayload({})).toBeNull();
  });

  test("donationAlertFromPayload собирает единый формат алерта", () => {
    const alert = donationAlertFromPayload({
      username: "nick",
      amount: "250",
      currency: "RUB",
      message: "gg",
    });
    expect(alert).toEqual({
      kind: "donation",
      user: "nick",
      amount: 250,
      currency: "RUB",
      message: "gg",
    });
  });
});
