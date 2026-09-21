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

const { isSealed } = require("./secret-store");

// state -> { provider, expiresAt }. Authorization-code flow round-trips
// through the user's system browser, so we validate the `state` param
// on the way back instead of trusting the redirect blindly.
const pending = new Map();

// Сколько живёт state — столько времени есть на прохождение авторизации в браузере.
const STATE_TTL_MS = 10 * 60 * 1000;

/*
  Просроченные записи подчищаются при каждом обращении.

  Иначе карта растёт без предела: закрытая вкладка авторизации state не возвращает,
  а consumeState вызывается только при успешном возврате. Ссылок больше нет ни у
  кого, так что удалять просроченное безопасно.
*/
function sweepExpiredStates(now) {
  if (!pending.size) return;
  for (const [token, entry] of pending) {
    if (entry.expiresAt < now) pending.delete(token);
  }
}

function makeState(provider) {
  const now = Date.now();
  sweepExpiredStates(now);
  const token = crypto.randomBytes(16).toString("hex");
  pending.set(token, { provider, expiresAt: now + STATE_TTL_MS });
  return token;
}

function consumeState(token, provider) {
  const now = Date.now();
  sweepExpiredStates(now);
  const entry = pending.get(token);
  pending.delete(token);
  if (!entry) return false;
  if (entry.expiresAt < now) return false;
  return entry.provider === provider;
}

// Сколько state сейчас ждёт возврата из браузера. Нужно тесту, который следит за
// тем, чтобы неудачные попытки подключения не копились в памяти.
function pendingStateCount() {
  return pending.size;
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
    scope: "moderator:read:followers channel:read:subscriptions bits:read channel:read:redemptions user:write:chat moderator:manage:banned_users clips:edit channel:manage:broadcast channel:manage:redemptions",
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
    // oauth-donation-index нужен, чтобы подтянуть донаты, пришедшие пока
    // приложение было выключено: без него DonationAlerts отдаёт живые события,
    // но не список донатов (см. server/integrations/donationalerts.js).
    scope: "oauth-user-show oauth-donation-subscribe oauth-donation-index oauth-goal-subscribe",
    state,
  });
  return `https://www.donationalerts.com/oauth/authorize?${params.toString()}`;
}

function buildYoutubeAuthorizeUrl(config, port) {
  const state = makeState("youtube");
  const params = new URLSearchParams({
    client_id: config.youtube.clientId,
    redirect_uri: redirectUri(port, "youtube"),
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.readonly",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
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
/*
  Что именно мы отправили — для страницы-результата.

  client_id публичен (он же стоит в адресе авторизации), redirect_uri и так виден
  в адресной строке, а про секрет сообщается только его длина: сам секрет не
  должен попасть ни на страницу, ни в чей-нибудь скриншот с репортом об ошибке.

  Без этой строки разбор «почему invalid_client» превращается в переписку:
  непонятно, какие именно ключи ушли в сервис. Сравнив показанный client_id с
  кабинетом приложения, сразу видно, туда ли смотрит приложение.
*/
function describeSentCredentials({ clientId, clientSecret, redirectUri } = {}) {
  const id = String(clientId || "").trim();
  const secret = String(clientSecret || "");
  const parts = [`client_id = ${id || "(пусто)"}`];
  parts.push(secret ? `секрет — ${secret.length} симв.` : "секрет — не заполнен");
  if (redirectUri) parts.push(`redirect_uri = ${redirectUri}`);
  return `Отправлено: ${parts.join(", ")}`;
}

/*
  Пригоден ли ключ приложения для запроса к сервису.

  Кроме пустоты проверяется зашифрованный вид значения ("enc:…"): так выглядит
  секрет, который не удалось прочитать (см. server/secret-store.js). Раньше такая
  строка считалась заполненным секретом и уходила в сервис вместо него — ровно
  поэтому DonationAlerts отвечал невнятным invalid_client, а в настройках ключи
  выглядели заполненными.
*/
function usableCredential(value) {
  const text = String(value || "").trim();
  return !!text && !isSealed(text);
}

/*
  Ключи приложения, без которых обмен кода на токен заведомо провалится.

  Сервис отвечает на это машинным invalid_client, и по ответу невозможно понять,
  что дело в пустом поле в настройках — раньше пользователь видел на странице
  только JSON. Проверяем сами и говорим прямо, чего не хватает.
*/
function missingCredentials(config) {
  const missing = [];
  if (!String((config && config.clientId) || "").trim()) missing.push("Client ID");
  if (!usableCredential(config && config.clientSecret)) missing.push("Client Secret");
  return missing;
}

/*
  Что пользователю делать с незаполненными ключами.

  Если среди них Client Secret, добавляем второй вариант причины: секрет мог быть
  сохранён, но не прочитаться (сменился пользователь ОС, ключ DPAPI/Keychain,
  конфиг перенесён с другой машины). Для него действие другое — вставить ключ из
  кабинета заново.
*/
function credentialsProblemMessage(service, missing) {
  const where = service === "DonationAlerts" ? "Настройках DonationAlerts" : `Настройках ${service}`;
  const parts = [
    `Не заполнено: ${missing.join(" и ")}. Впишите ключи приложения в ${where} и нажмите «Подключить» ещё раз.`,
  ];
  if (missing.includes("Client Secret")) {
    parts.push(
      "Если секрет вы уже вписывали, значит сохранённое значение не удалось прочитать (например, конфиг перенесён с другой машины или сменился пользователь ОС) — тогда скопируйте Client Secret из кабинета и вставьте заново."
    );
  }
  return parts.join("\n\n");
}

/*
  Объяснение провала обмена кода на токен для страницы-результата.

  Ответ сервиса — машинный JSON, и раньше пользователь видел на странице ровно
  его: «{"error":"invalid_client",...}» — без единого слова о том, что делать.
  Известные случаи переводим в действия, а сам ответ оставляем ниже как факт,
  чтобы ничего не прятать.
*/
function describeTokenExchangeFailure(service, payload) {
  const code = String((payload && (payload.error || payload.message)) || "");
  const hints = [];

  // Разделитель между словами у сервисов разный: DonationAlerts (Laravel
  // Passport) пишет invalid_client, Twitch — «invalid client». Обе формы — одно
  // и то же, и обе означают, что ключи приложения не приняты.
  if (/invalid[\s_-]?client/i.test(code)) {
    hints.push(
      `Сервис не принял Client ID / Client Secret (ответ «Client authentication failed»). ` +
        `Обычно это значит, что приложение в кабинете ${service} пересоздавали: у нового приложения новые ключи, и вставить нужно оба. ` +
        `Секрет не показывается в интерфейсе повторно, поэтому скопируйте его из кабинета заново.`
    );
  } else if (/invalid[\s_-]?grant/i.test(code)) {
    hints.push("Код авторизации больше не действует или уже использован: нажмите «Подключить» заново.");
  } else if (/redirect_uri/i.test(code)) {
    hints.push(
      `Redirect URI не совпадает с указанным в кабинете ${service}: он должен быть ровно таким, как показано в Настройках.`
    );
  }

  const raw = payload ? `Ответ сервиса: ${JSON.stringify(payload)}` : "";
  return hints.length ? `${hints.join("\n\n")}\n\n${raw}` : raw;
}

function mountOAuthRoutes(app, { state, hooks, loggerFor } = {}) {
  /*
    Журнал приложения вместо одной консоли.

    Браузерная страница с ошибкой никуда не сохраняется: если пользователь
    закрыл вкладку, разбирать «почему invalid_client» больше не по чему — ни
    какие ключи ушли, ни что ответил сервис. Логер создаёт server/index.js, и его
    строки ложатся и в файл журнала, и в панель сервиса (там они рядом с ответами
    самого сервиса); без логера пишем в консоль, как раньше.
  */
  function reporter(service) {
    if (typeof loggerFor === "function") {
      const created = loggerFor(service);
      if (created) return created;
    }
    const label = `[oauth/${service}]`;
    return {
      info: (message, data) => console.log(label, message, data === undefined ? "" : data),
      warn: (message, data) => console.warn(label, message, data === undefined ? "" : data),
      error: (message, data) => console.error(label, message, data === undefined ? "" : data),
      success: (message, data) => console.log(label, message, data === undefined ? "" : data),
    };
  }

  /*
    Что именно ушло в сервис при обмене кода на токен.

    Без этой строки в журнале остаётся только ответ сервиса, и по нему не понять,
    какие ключи были в настройках в тот момент. Секрет не печатаем — только его
    длину: строка уходит в отчёт для поддержки.
  */
  function sentCredentials(service, config, port) {
    return {
      service,
      client_id: config.clientId || "",
      client_secret_len: String(config.clientSecret || "").length,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(port, service === "donationAlerts" ? "donationalerts" : service),
    };
  }

  // Ключи не заполнены — до сети дело не доходит, но в журнале это должно быть
  // видно так же явно, как ответ сервиса.
  function logMissingCredentials(service, config, missing) {
    reporter(service).warn(`${service}: app credentials are not usable`, {
      missing,
      client_id: config.clientId || "",
      client_secret_len: String(config.clientSecret || "").length,
    });
  }
  app.get("/oauth/twitch/callback", async (req, res) => {
    const log = reporter("twitch");
    const { code, state: returnedState, error, error_description } = req.query;
    if (error) {
      res.status(400).send(resultPage("Twitch: ошибка авторизации", String(error_description || error), false));
      return;
    }
    if (!consumeState(returnedState, "twitch")) {
      res.status(400).send(resultPage("Twitch: недействительный запрос", "state не совпадает, попробуйте подключиться заново.", false));
      return;
    }
    const missing = missingCredentials(state.config.twitch);
    if (missing.length) {
      logMissingCredentials("twitch", state.config.twitch, missing);
      res.status(400).send(
        resultPage(
          "Twitch: не удалось подключиться",
          credentialsProblemMessage("Twitch", missing),
          false
        )
      );
      return;
    }
    let tokenFailure = null;
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
        tokenFailure = tokenJson;
        log.error("twitch: token exchange failed", {
          status: tokenRes.status,
          response: tokenJson,
          sent: sentCredentials("twitch", state.config.twitch, port),
        });
        throw new Error("token exchange failed");
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
        expiresAt: tokenJson.expires_in ? Date.now() + (Number(tokenJson.expires_in) - 60) * 1000 : 0,
      });

      res.send(resultPage("Twitch подключён", "Можно закрыть эту вкладку и вернуться в приложение.", true));
      hooks.onTwitchConnected();
    } catch (err) {
      const config = state.config.twitch;
      const message = tokenFailure
        ? `${describeTokenExchangeFailure("Twitch", tokenFailure)}\n\n${describeSentCredentials({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: redirectUri(state.config.port, "twitch"),
          })}`
        : String((err && err.message) || err);
      res.status(500).send(resultPage("Twitch: не удалось подключиться", message, false));
    }
  });

  app.get("/oauth/donationalerts/callback", async (req, res) => {
    const log = reporter("donationAlerts");
    const { code, state: returnedState, error, error_description } = req.query;
    if (error) {
      res.status(400).send(resultPage("DonationAlerts: ошибка авторизации", String(error_description || error), false));
      return;
    }
    if (!consumeState(returnedState, "donationalerts")) {
      res.status(400).send(resultPage("DonationAlerts: недействительный запрос", "state не совпадает, попробуйте подключиться заново.", false));
      return;
    }
    // Обмен кода на токен: ключи могли не заполнить — тогда сервис ответит
    // невнятным invalid_client, и лучше сказать об этом прямо здесь.
    const missing = missingCredentials(state.config.donationAlerts);
    if (missing.length) {
      logMissingCredentials("donationAlerts", state.config.donationAlerts, missing);
      res.status(400).send(
        resultPage(
          "DonationAlerts: не удалось подключиться",
          credentialsProblemMessage("DonationAlerts", missing),
          false
        )
      );
      return;
    }
    let tokenFailure = null;
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
        // Сами токены в переменную не кладём: при провале обмена их и нет, а
        // страница-результат не должна показывать секреты.
        tokenFailure = tokenJson;
        log.error("donationAlerts: token exchange failed", {
          status: tokenRes.status,
          response: tokenJson,
          sent: sentCredentials("donationAlerts", state.config.donationAlerts, port),
        });
        throw new Error("token exchange failed");
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
        expiresAt: tokenJson.expires_in ? Date.now() + (Number(tokenJson.expires_in) - 60) * 1000 : 0,
      });

      res.send(resultPage("DonationAlerts подключён", "Можно закрыть эту вкладку и вернуться в приложение.", true));
      hooks.onDonationAlertsConnected();
    } catch (err) {
      // tokenFailure есть только у провала обмена кода: остальные ошибки
      // (например запрос профиля) описываем как есть. К объяснению добавляем
      // то, что отправили, — иначе по ответу сервиса не понять, какие ключи ушли.
      const config = state.config.donationAlerts;
      const message = tokenFailure
        ? `${describeTokenExchangeFailure("DonationAlerts", tokenFailure)}\n\n${describeSentCredentials({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: redirectUri(state.config.port, "donationalerts"),
          })}`
        : String((err && err.message) || err);
      res.status(500).send(resultPage("DonationAlerts: не удалось подключиться", message, false));
    }
  });

  app.get("/oauth/youtube/callback", async (req, res) => {
    const log = reporter("youtube");
    const { code, state: returnedState, error, error_description } = req.query;
    if (error) {
      res.status(400).send(resultPage("YouTube: ошибка авторизации", String(error_description || error), false));
      return;
    }
    if (!consumeState(returnedState, "youtube")) {
      res.status(400).send(resultPage("YouTube: недействительный запрос", "state не совпадает, попробуйте подключиться заново.", false));
      return;
    }
    const missing = missingCredentials(state.config.youtube);
    if (missing.length) {
      logMissingCredentials("youtube", state.config.youtube, missing);
      res.status(400).send(
        resultPage(
          "YouTube: не удалось подключиться",
          credentialsProblemMessage("YouTube", missing),
          false
        )
      );
      return;
    }
    let tokenFailure = null;
    try {
      const port = state.config.port;
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: state.config.youtube.clientId,
          client_secret: state.config.youtube.clientSecret,
          code: String(code),
          grant_type: "authorization_code",
          redirect_uri: redirectUri(port, "youtube"),
        }),
      });
      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok) {
        tokenFailure = tokenJson;
        log.error("youtube: token exchange failed", {
          status: tokenRes.status,
          response: tokenJson,
          sent: sentCredentials("youtube", state.config.youtube, port),
        });
        throw new Error("token exchange failed");
      }

      state.saveYoutubeTokens({
        accessToken: tokenJson.access_token,
        refreshToken: tokenJson.refresh_token,
        expiresAt: tokenJson.expires_in ? Date.now() + (Number(tokenJson.expires_in) - 60) * 1000 : 0,
      });

      res.send(resultPage("YouTube подключён", "Можно закрыть эту вкладку и вернуться в приложение.", true));
      hooks.onYoutubeConnected();
    } catch (err) {
      const config = state.config.youtube;
      const message = tokenFailure
        ? `${describeTokenExchangeFailure("YouTube", tokenFailure)}\n\n${describeSentCredentials({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: redirectUri(state.config.port, "youtube"),
          })}`
        : String((err && err.message) || err);
      res.status(500).send(resultPage("YouTube: не удалось подключиться", message, false));
    }
  });
}

module.exports = {
  mountOAuthRoutes,
  buildTwitchAuthorizeUrl,
  buildDonationAlertsAuthorizeUrl,
  buildYoutubeAuthorizeUrl,
  redirectUri,
  // Чистые помощники: показываются пользователю на странице-результате, поэтому
  // их формулировки зафиксированы тестами.
  missingCredentials,
  credentialsProblemMessage,
  describeTokenExchangeFailure,
  describeSentCredentials,
  pendingStateCount,
};
