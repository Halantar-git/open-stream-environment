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

const { createTokenRefresher } = require("../server/token-refresh");

describe("server/token-refresh", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    delete global.fetch;
  });

  function makeRefresher(config) {
    const logger = { info: jest.fn(), success: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const saveTokens = jest.fn();
    const refresher = createTokenRefresher({
      tokenUrl: "https://example.test/token",
      logger,
      label: "test",
      getConfig: () => config,
      buildParams: (cfg) => ({
        grant_type: "refresh_token",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken,
      }),
      accessTokenKey: "accessToken",
      saveTokens,
    });
    return { refresher, logger, saveTokens };
  }

  test("ensureAccessToken возвращает валидный токен из config.expiresAt без refresh", async () => {
    const config = { clientId: "id", clientSecret: "secret", refreshToken: "rt", accessToken: "old", expiresAt: Date.now() + 100000 };
    const { refresher } = makeRefresher(config);

    await expect(refresher.ensureAccessToken()).resolves.toBe("old");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refreshAccessToken обменивает refresh_token и сохраняет expiresAt", async () => {
    const config = { clientId: "id", clientSecret: "secret", refreshToken: "rt", accessToken: "old", expiresAt: 0 };
    const { refresher, saveTokens } = makeRefresher(config);

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: "new", expires_in: 3600 }) });

    await expect(refresher.refreshAccessToken()).resolves.toBe("new");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/token");
    expect(init.method).toBe("POST");
    expect(init.body.toString()).toContain("refresh_token=rt");

    expect(saveTokens).toHaveBeenCalledTimes(1);
    const [json, expiresAt] = saveTokens.mock.calls[0];
    expect(json.access_token).toBe("new");
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  test("ensureAccessToken делает refresh когда токен протух", async () => {
    const config = { clientId: "id", clientSecret: "secret", refreshToken: "rt", accessToken: "old", expiresAt: Date.now() - 1000 };
    const { refresher } = makeRefresher(config);

    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: "fresh", expires_in: 3600 }) });

    await expect(refresher.ensureAccessToken()).resolves.toBe("fresh");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("дедуплицирует конкурентные вызовы refresh", async () => {
    const config = { clientId: "id", clientSecret: "secret", refreshToken: "rt", accessToken: "old", expiresAt: 0 };
    const { refresher } = makeRefresher(config);

    let resolveFetch;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveFetch = () => resolve({ ok: true, json: async () => ({ access_token: "new", expires_in: 3600 }) });
      })
    );

    const p1 = refresher.refreshAccessToken();
    const p2 = refresher.refreshAccessToken();
    resolveFetch();

    await expect(Promise.all([p1, p2])).resolves.toEqual(["new", "new"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("бросает ошибку без refreshToken", async () => {
    const config = { clientId: "id", clientSecret: "secret", refreshToken: "", accessToken: "old", expiresAt: 0 };
    const { refresher } = makeRefresher(config);

    await expect(refresher.refreshAccessToken()).rejects.toThrow("no test refreshToken available");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("ensureAccessToken без refreshToken возвращает accessToken без fetch", async () => {
    const config = { clientId: "id", clientSecret: "secret", refreshToken: "", accessToken: "static", expiresAt: 0 };
    const { refresher } = makeRefresher(config);

    await expect(refresher.ensureAccessToken()).resolves.toBe("static");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
