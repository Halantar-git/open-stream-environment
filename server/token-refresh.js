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
  Общая логика обновления OAuth-токенов через refresh_token.

  Каждая интеграция (Twitch EventSub, YouTube, DonationAlerts) использует один
  и тот же паттерн:
    - дедупликация конкурентных вызовов refresh;
    - обмен refresh_token на access_token;
    - сохранение нового токена и времени протухания (expiresAt);
    - ensureAccessToken(): возвращает ещё валидный токен из памяти/конфига,
      иначе делает refresh.
*/

function createTokenRefresher({
  tokenUrl,
  logger,
  label,
  getConfig,
  buildParams,
  accessTokenKey,
  saveTokens,
}) {
  let refreshPromise = null;
  let tokenExpiresAt = 0;

  function refreshAccessToken() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = doRefreshAccessToken().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  async function doRefreshAccessToken() {
    const cfg = getConfig();
    if (!cfg.refreshToken) throw new Error(`no ${label} refreshToken available`);

    logger.info("refreshing access token…");
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(buildParams(cfg)),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new Error(`refresh_token: ${res.status} ${JSON.stringify(json)}`);
    }

    const expiresAt = json.expires_in ? Date.now() + (Number(json.expires_in) - 60) * 1000 : 0;
    tokenExpiresAt = expiresAt;

    saveTokens(json, expiresAt);

    logger.success("access token refreshed");
    return json.access_token;
  }

  async function ensureAccessToken() {
    const cfg = getConfig();
    const expiresAt = tokenExpiresAt || Number(cfg.expiresAt) || 0;
    if (expiresAt && Date.now() < expiresAt) return cfg[accessTokenKey];
    if (cfg.refreshToken) return await refreshAccessToken();
    return cfg[accessTokenKey];
  }

  return { ensureAccessToken, refreshAccessToken };
}

module.exports = { createTokenRefresher };
