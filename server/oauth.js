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

const crypto = require("crypto");

// state -> { provider, expiresAt }. Authorization-code flow round-trips
// through the user's system browser, so we validate the `state` param
// on the way back instead of trusting the redirect blindly.
const pending = new Map();

function makeState(provider) {
  const token = crypto.randomBytes(16).toString("hex");
  pending.set(token, { provider, expiresAt: Date.now() + 10 * 60 * 1000 });
  return token;
}

function consumeState(token, provider) {
  const entry = pending.get(token);
  pending.delete(token);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) return false;
  return entry.provider === provider;
}

function redirectUri(port, provider) {
  return `http://localhost:${port}/oauth/${provider}/callback`;
}

function buildTwitchAuthorizeUrl(config, port) {
  const state = makeState("twitch");
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    redirect_uri: redirectUri(port, "twitch"),
    response_type: "code",
    scope: "moderator:read:followers channel:read:subscriptions bits:read",
    state,
    force_verify: "true",
  });
  return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
}

function buildDonationAlertsAuthorizeUrl(config, port) {
  const state = makeState("donationalerts");
  const params = new URLSearchParams({
    client_id: config.donationAlerts.clientId,
    redirect_uri: redirectUri(port, "donationalerts"),
    response_type: "code",
    scope: "oauth-user-show oauth-donation-subscribe oauth-goal-subscribe",
    state,
  });
  return `https://www.donationalerts.com/oauth/authorize?${params.toString()}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function resultPage(title, message, ok) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
  <style>
    body{background:#131019;color:#e8e1f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .card{background:#1f1b27;border:1px solid #4a4553;border-radius:16px;padding:32px 40px;text-align:center;max-width:520px}
    h1{font-size:18px;margin:0 0 12px;color:${ok ? "#7ee0d6" : "#ffb4ab"}}
    pre{font-size:12.5px;color:#c9c1d6;line-height:1.5;text-align:left;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;margin:0}
  </style></head>
  <body><div class="card"><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(message)}</pre></div></body></html>`;
}

/**
 * Mounts /oauth/twitch/callback and /oauth/donationalerts/callback on the
 * given Express app. `hooks.onTwitchConnected` / `onDonationAlertsConnected`
 * are called after tokens are saved so index.js can (re)start the relevant
 * integration without this module needing to know about tmi.js/EventSub.
 */
function mountOAuthRoutes(app, { state, hooks }) {
  app.get("/oauth/twitch/callback", async (req, res) => {
    const { code, state: returnedState, error, error_description } = req.query;
    if (error) {
      res.status(400).send(resultPage("Twitch: ошибка авторизации", String(error_description || error), false));
      return;
    }
    if (!consumeState(returnedState, "twitch")) {
      res.status(400).send(resultPage("Twitch: недействительный запрос", "state не совпадает, попробуйте подключиться заново.", false));
      return;
    }
    try {
      const port = state.config.port;
      const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: state.config.twitch.clientId,
          client_secret: state.config.twitch.clientSecret,
          code: String(code),
          grant_type: "authorization_code",
          redirect_uri: redirectUri(port, "twitch"),
        }),
      });
      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok) {
        console.error("[oauth/twitch] token exchange failed:", tokenRes.status, JSON.stringify(tokenJson));
        throw new Error(JSON.stringify(tokenJson, null, 2));
      }

      const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(state.config.twitch.channel)}`, {
        headers: {
          "Client-Id": state.config.twitch.clientId,
          Authorization: `Bearer ${tokenJson.access_token}`,
        },
      });
      const userJson = await userRes.json();
      const broadcasterId = userJson.data && userJson.data[0] ? userJson.data[0].id : undefined;

      state.saveTwitchTokens({
        userAccessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token,
        broadcasterId,
      });

      res.send(resultPage("Twitch подключён", "Можно закрыть эту вкладку и вернуться в приложение.", true));
      hooks.onTwitchConnected();
    } catch (err) {
      res.status(500).send(resultPage("Twitch: не удалось подключиться", err.message || String(err), false));
    }
  });

  app.get("/oauth/donationalerts/callback", async (req, res) => {
    const { code, state: returnedState, error, error_description } = req.query;
    if (error) {
      res.status(400).send(resultPage("DonationAlerts: ошибка авторизации", String(error_description || error), false));
      return;
    }
    if (!consumeState(returnedState, "donationalerts")) {
      res.status(400).send(resultPage("DonationAlerts: недействительный запрос", "state не совпадает, попробуйте подключиться заново.", false));
      return;
    }
    try {
      const port = state.config.port;
      const tokenRes = await fetch("https://www.donationalerts.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: state.config.donationAlerts.clientId,
          client_secret: state.config.donationAlerts.clientSecret,
          grant_type: "authorization_code",
          redirect_uri: redirectUri(port, "donationalerts"),
          code: String(code),
        }),
      });
      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok) {
        console.error(
          "[oauth/donationalerts] token exchange failed:",
          tokenRes.status,
          JSON.stringify(tokenJson),
          "| sent:",
          JSON.stringify({
            client_id: state.config.donationAlerts.clientId,
            grant_type: "authorization_code",
            redirect_uri: redirectUri(port, "donationalerts"),
            code_length: String(code).length,
          })
        );
        throw new Error(JSON.stringify(tokenJson, null, 2));
      }

      const userRes = await fetch("https://www.donationalerts.com/api/v1/user/oauth", {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      const userJson = await userRes.json();
      const userData = userJson.data || userJson;

      state.saveDonationAlertsTokens({
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token,
        userId: userData && userData.id,
      });

      res.send(resultPage("DonationAlerts подключён", "Можно закрыть эту вкладку и вернуться в приложение.", true));
      hooks.onDonationAlertsConnected();
    } catch (err) {
      res.status(500).send(resultPage("DonationAlerts: не удалось подключиться", err.message || String(err), false));
    }
  });
}

module.exports = { mountOAuthRoutes, buildTwitchAuthorizeUrl, buildDonationAlertsAuthorizeUrl, redirectUri };
