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
  OAuth2 GoodGame в Worker (signal/oauth.js): адреса, формы обмена и то, что
  наружу из запроса не уходит. Сеть и Durable Object проверяются на месте, в
  Cloudflare, — здесь только чистые правила.
*/

const oauth = require("../signal/oauth");

describe("signal/oauth: маршруты", () => {
  test("callback принимается со слэшем и без него", () => {
    expect(oauth.isCallbackPath("/oauth/goodgame/callback")).toBe(true);
    expect(oauth.isCallbackPath("/oauth/goodgame/callback/")).toBe(true);
    expect(oauth.isCallbackPath("/oauth/goodgame/callbackx")).toBe(false);
  });

  test("служебные маршруты различаются", () => {
    expect(oauth.isPreparePath("/oauth/goodgame/prepare")).toBe(true);
    expect(oauth.isPreparePath("/oauth/goodgame/prepare/")).toBe(false);
    expect(oauth.isTicketPath("/oauth/goodgame/ticket")).toBe(true);
    expect(oauth.isRefreshPath("/oauth/goodgame/refresh")).toBe(true);
    expect(oauth.isRefreshPath("/oauth/goodgame/ticket")).toBe(false);
  });
});

describe("signal/oauth: возврат в приложение", () => {
  test("пропускает только известные поля", () => {
    const url = new URL(
      oauth.localCallbackUrl({
        state: "s".repeat(32),
        ticket: "t".repeat(48),
        next: "https://evil.test/",
        token: "secret",
      }),
    );
    expect(url.origin).toBe("http://127.0.0.1:8710");
    expect(url.pathname).toBe("/oauth/goodgame/callback");
    expect(url.searchParams.get("state")).toBe("s".repeat(32));
    expect(url.searchParams.get("ticket")).toBe("t".repeat(48));
    expect(url.searchParams.has("next")).toBe(false);
    expect(url.searchParams.has("token")).toBe(false);
  });

  test("порт из подготовки, а мусор — порт по умолчанию", () => {
    expect(new URL(oauth.localCallbackUrl({}, 9000)).port).toBe("9000");
    expect(new URL(oauth.localCallbackUrl({}, 80)).port).toBe("8710");
    expect(new URL(oauth.localCallbackUrl({}, "abc")).port).toBe("8710");
  });

  test("пустые значения в адрес не попадают", () => {
    const url = new URL(oauth.localCallbackUrl({ state: "", error: "" }));
    expect([...url.searchParams.keys()]).toEqual([]);
  });
});

describe("signal/oauth: адрес авторизации", () => {
  const env = {
    GOODGAME_CLIENT_ID: "MyClient",
    GOODGAME_REDIRECT_URI: "https://example.test/oauth/goodgame/callback/",
  };

  test("несёт код ответа, ключ приложения и state", () => {
    const url = new URL(oauth.authorizeUrl(env, "s".repeat(32)));
    expect(url.origin + url.pathname).toBe("https://goodgame.ru/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("MyClient");
    expect(url.searchParams.get("state")).toBe("s".repeat(32));
    expect(url.searchParams.get("redirect_uri")).toBe(env.GOODGAME_REDIRECT_URI);
  });

  test("без переменной адрес возврата — умолчание с хвостовым слэшем", () => {
    expect(oauth.redirectUri({})).toBe(oauth.DEFAULT_REDIRECT_URI);
    expect(oauth.DEFAULT_REDIRECT_URI.endsWith("/")).toBe(true);
  });
});

describe("signal/oauth: обмен кода и обновление", () => {
  const env = {
    GOODGAME_CLIENT_ID: "MyClient",
    GOODGAME_CLIENT_SECRET: "secret",
    GOODGAME_REDIRECT_URI: "https://example.test/oauth/goodgame/callback/",
  };

  test("форма обмена содержит секрет только на сервере", () => {
    const form = oauth.tokenForm(env, "code-1");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_id")).toBe("MyClient");
    expect(form.get("client_secret")).toBe("secret");
    expect(form.get("redirect_uri")).toBe(env.GOODGAME_REDIRECT_URI);
    expect(form.get("code")).toBe("code-1");
  });

  test("форма обновления не требует кода", () => {
    const form = oauth.refreshForm(env, "refresh-1");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-1");
    expect(form.has("code")).toBe(false);
  });
});

describe("signal/oauth: форматы", () => {
  test("state, verifier и ticket — только безопасный алфавит", () => {
    expect(oauth.validState("a".repeat(32))).toBe(true);
    expect(oauth.validState("a".repeat(8))).toBe(false);
    expect(oauth.validState("a".repeat(32) + "!")).toBe(false);
    expect(oauth.validVerifier("b".repeat(64))).toBe(true);
    expect(oauth.validVerifier("b".repeat(16))).toBe(false);
    expect(oauth.validTicket("c".repeat(48))).toBe(true);
    expect(oauth.validTicket("c".repeat(8))).toBe(false);
  });

  test("доказательство связывает state и verifier", () => {
    expect(oauth.proofInput("s", "v")).toBe("s:v");
    expect(oauth.proofInput("s", "v")).not.toBe(oauth.proofInput("s", "w"));
    expect(oauth.keyFor("prepare", "s")).toBe("prepare:s");
  });
});
