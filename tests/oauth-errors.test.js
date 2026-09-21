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
  Страница подключения говорит с пользователем текстом, а не JSON.

  Раньше при провале обмена кода на токен на странице показывался ровно ответ
  сервиса: «{"error":"invalid_client","error_description":"Client authentication
  failed","message":"Client authentication failed"}». По нему невозможно понять,
  что делать: пользователь видит ошибку на английском и не знает, что дело в
  ключах приложения. Здесь зафиксированы формулировки, которые он читает вместо
  этого, — поэтому они и проверяются тестом.
*/

const {
  missingCredentials,
  credentialsProblemMessage,
  describeTokenExchangeFailure,
  describeSentCredentials,
  buildTwitchAuthorizeUrl,
  pendingStateCount,
} = require("../server/oauth");

const { once } = require("events");

describe("oauth: что видит пользователь при неудачном подключении", () => {
  test("незаполненные ключи называются по именам", () => {
    expect(missingCredentials({ clientId: "123", clientSecret: "secret" })).toEqual([]);
    expect(missingCredentials({ clientId: "123", clientSecret: "" })).toEqual(["Client Secret"]);
    expect(missingCredentials({ clientId: "   ", clientSecret: "secret" })).toEqual(["Client ID"]);
    expect(missingCredentials({})).toEqual(["Client ID", "Client Secret"]);
    expect(missingCredentials(null)).toEqual(["Client ID", "Client Secret"]);
  });

  test("нерасшифрованный секрет считается незаполненным: в сервис уходит не он", () => {
    // Так выглядит секрет, который не удалось прочитать (см. server/secret-store.js).
    // Раньше такая строка считалась заполненным секретом и уходила в сервис
    // вместо него — ровно поэтому DonationAlerts отвечал invalid_client.
    const sealedSecret = "enc:" + Buffer.from("da-client-secret", "utf8").toString("base64");

    expect(missingCredentials({ clientId: "123", clientSecret: sealedSecret })).toEqual(["Client Secret"]);
  });

  test("объяснение для незаполненного секрета не отправляет в кабинет за новым приложением", () => {
    const text = credentialsProblemMessage("DonationAlerts", ["Client Secret"]);

    expect(text).toContain("Client Secret");
    expect(text).toContain("Настройках DonationAlerts");
    // Второй вариант причины: секрет сохранили, но прочитать не смогли.
    expect(text).toContain("вставьте заново");
    // Без секрета среди незаполненного лишнего совета нет.
    expect(credentialsProblemMessage("Twitch", ["Client ID"])).not.toContain("вставьте заново");
  });

  test("invalid_client объясняется через пересозданное приложение", () => {
    const text = describeTokenExchangeFailure("DonationAlerts", {
      error: "invalid_client",
      error_description: "Client authentication failed",
      message: "Client authentication failed",
    });

    // Объяснение — про ключи приложения и про то, что секрет придётся вставить заново.
    expect(text).toContain("Client ID");
    expect(text).toContain("Client Secret");
    expect(text).toContain("пересоздавали");
    // И сам ответ сервиса остаётся на странице: ничего не прячем.
    expect(text).toContain("invalid_client");
  });

  test("разная запись ошибки у разных сервисов распознаётся одинаково", () => {
    // DonationAlerts (Laravel Passport) пишет invalid_client, Twitch — «invalid client».
    expect(describeTokenExchangeFailure("Twitch", { message: "invalid client" })).toContain("Client ID");
    expect(describeTokenExchangeFailure("Twitch", { message: "Invalid Client" })).toContain("Client ID");
    expect(describeTokenExchangeFailure("Twitch", { status: 400, message: "invalid client" })).toContain("Client ID");
  });

  test("invalid_grant и redirect_uri получают свои подсказки", () => {
    expect(describeTokenExchangeFailure("Twitch", { message: "invalid grant" })).toContain("заново");
    expect(describeTokenExchangeFailure("YouTube", { error: "redirect_uri_mismatch" })).toContain("Redirect URI");
  });

  test("неизвестная ошибка показывается как есть, без выдумок", () => {
    const text = describeTokenExchangeFailure("YouTube", { error: "access_denied" });

    expect(text).toBe('Ответ сервиса: {"error":"access_denied"}');
    // Без ответа сервиса объяснять нечего — пустая строка, а не наугад.
    expect(describeTokenExchangeFailure("YouTube", null)).toBe("");
  });

  test("в отчёте видно, какие ключи ушли, но не сам секрет", () => {
    const sent = describeSentCredentials({
      clientId: "  12345  ",
      clientSecret: "da-refresh-token-xyz",
      redirectUri: "http://localhost:8710/oauth/donationalerts/callback",
    });

    // client_id — публичное значение, по нему и сверяются с кабинетом.
    expect(sent).toContain("client_id = 12345");
    expect(sent).toContain("redirect_uri = http://localhost:8710/oauth/donationalerts/callback");
    // Секрет — только длиной: страница и её скриншоты уходят в переписку.
    expect(sent).toContain(`секрет — ${"da-refresh-token-xyz".length} симв.`);
    expect(sent).not.toContain("da-refresh-token-xyz");
  });

  test("пустые ключи в отчёте выглядят пустыми, а не пугают длиной", () => {
    const sent = describeSentCredentials({ clientId: "", clientSecret: "" });

    expect(sent).toBe("Отправлено: client_id = (пусто), секрет — не заполнен");
    // Без аргументов функция тоже не должна падать.
    expect(describeSentCredentials()).toContain("client_id = (пусто)");
  });
});

/*
  Неудачное подключение должно оставаться в журнале, а не только на странице в
  браузере: страница закрывается и не сохраняется, и тогда по факту остаётся
  один вопрос «почему invalid_client» без единой детали — какие ключи уходили и
  что ответил сервис. Поэтому разбор ошибки идёт в тот же журнал, что и всё
  остальное, под именем сервиса.
*/
describe("oauth: попытка подключения остаётся в журнале", () => {
  async function callDonationAlertsCallback(config) {
    const express = require("express");
    const { mountOAuthRoutes, buildDonationAlertsAuthorizeUrl } = require("../server/oauth");

    // Тот же государственный токен, что выдаёт приложение: колбэк принимает
    // запрос только со своим state (защита от подмены ответа).
    const authorizeUrl = new URL(buildDonationAlertsAuthorizeUrl(config, 8710));
    const state = authorizeUrl.searchParams.get("state");

    const entries = [];
    const toLogger = (service) =>
      ["info", "warn", "error", "success"].reduce(
        (acc, level) => Object.assign(acc, { [level]: (message, data) => entries.push({ service, level, message, data }) }),
        {}
      );

    const app = express();
    mountOAuthRoutes(app, { state: { config }, hooks: {}, loggerFor: toLogger });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}/oauth/donationalerts/callback?code=probe&state=${state}`
      );
      return { status: res.status, body: await res.text(), entries };
    } finally {
      server.close();
    }
  }

  test("нечего отправлять — в журнале видно, какого ключа не хватает", async () => {
    const config = { port: 8710, donationAlerts: { clientId: "20511", clientSecret: "" } };

    const result = await callDonationAlertsCallback(config);

    // Пользователь видит объяснение на странице…
    expect(result.status).toBe(400);
    expect(result.body).toContain("Client Secret");
    // …а в журнале остаётся то же событие с деталями для разбора.
    const warn = result.entries.find((entry) => entry.level === "warn");
    expect(warn.service).toBe("donationAlerts");
    expect(warn.data.missing).toEqual(["Client Secret"]);
    expect(warn.data.client_id).toBe("20511");
    expect(warn.data.client_secret_len).toBe(0);
  });

  test("в журнале нет ни одной попытки обмена без ключей", async () => {
    const config = { port: 8710, donationAlerts: { clientId: "", clientSecret: "" } };

    const result = await callDonationAlertsCallback(config);

    expect(result.body).toContain("Client ID");
    expect(result.entries.filter((entry) => entry.level === "error")).toEqual([]);
  });
});

/*
  Начатые, но не доведённые до конца подключения не должны копиться в памяти:
  state — одноразовый пропуск, который возвращается только успешным ответом
  браузера. Закрытая вкладка не возвращает ничего, поэтому просроченные записи
  подчищаются при выдаче нового state.
*/
describe("oauth: state для подключения не копится", () => {
  test("просроченные state подчищаются при выдаче нового", () => {
    jest.useFakeTimers();
    try {
      const config = { port: 8710, twitch: { clientId: "app-id" } };
      const before = pendingStateCount();

      for (let i = 0; i < 5; i++) buildTwitchAuthorizeUrl(config, 8710);
      expect(pendingStateCount()).toBe(before + 5);

      // Прошло больше времени жизни state — остаётся только свежий.
      jest.advanceTimersByTime(11 * 60 * 1000);
      buildTwitchAuthorizeUrl(config, 8710);
      expect(pendingStateCount()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
