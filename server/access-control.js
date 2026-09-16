/*
  Copyright (C) 2026  Halantar

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://gnu.org>.
*/

/*
  Правила доступа к локальному серверу и ограничитель частоты команд.

  Почему отдельным модулем: это чистая логика принятия решений — «пустить или
  нет», «принять команду или отбросить», — и проверять её через настоящие сокеты
  неудобно и ненадёжно (адрес клиента в тесте не подменить). Здесь решения
  описываются функциями от запроса, поэтому их можно перебрать по вариантам, а
  server/index.js остаётся тонкой обвязкой.

  Модель доступа:

    * панель, оверлей в OBS, HUD и редакторы живут на этой же машине — их
      запросы приходят с loopback-адреса и код не спрашивают: иначе пришлось бы
      носить код по всем внутренним окнам и в адресе Browser Source;
    * всё, что пришло из локальной сети (телефон, сторонние скрипты), обязано
      предъявить код доступа в query (`?token=…`) или заголовке `x-ose-token`.
      Порт слушает все интерфейсы, поэтому без этого любой в той же Wi-Fi-сети
      мог бы переключать сцены и рассылать алерты;
    * источник WebSocket проверяется отдельно (`isAllowedWsOrigin` в
      index.js) — это защита от чужой страницы в браузере, а код — от чужого
      устройства в сети; проверки дополняют друг друга.
*/

// Адреса, с которых клиент считается «своим»: IPv4/IPv6 loopback, в том числе
// в виде, который отдаёт Node для двойного стека.
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]);

function isLoopbackAddress(address) {
  return LOOPBACK_ADDRESSES.has(String(address || ""));
}

function isLoopbackRequest(req) {
  const address = (req && req.socket && req.socket.remoteAddress) || "";
  return isLoopbackAddress(address);
}

// Код доступа предъявляется либо заголовком (удобно скриптам и мониторингу),
// либо в query — так его несёт адрес пульта.
function presentedToken(req) {
  const headers = (req && req.headers) || {};
  const header = headers["x-ose-token"] || headers["x-ose-code"];
  if (header) return String(header);
  const query = String((req && req.url) || "").split("?")[1] || "";
  if (!query) return "";
  try {
    return new URLSearchParams(query).get("token") || "";
  } catch (_) {
    return "";
  }
}

/*
  Решение по WebSocket-подключению: проверяются и источник запроса, и код.

  Возвращает объект с причиной отказа, чтобы вызывающий код мог записать в лог
  внятную строку, а тесты — проверить именно причину, а не факт «не пустили».

  `matchesToken` — функция сравнения (в приложении — state.checkRemoteToken,
  сравнение с постоянным временем).
*/
function checkUpgrade(req, options = {}) {
  const port = options.port;
  const isAllowedOrigin = typeof options.isAllowedOrigin === "function" ? options.isAllowedOrigin : () => true;
  const matchesToken = typeof options.matchesToken === "function" ? options.matchesToken : () => false;

  if (!isAllowedOrigin(req, port)) {
    return { ok: false, reason: "origin", external: !isLoopbackRequest(req) };
  }

  const external = !isLoopbackRequest(req);
  if (external && !matchesToken(presentedToken(req))) {
    return { ok: false, reason: "token", external };
  }

  return { ok: true, reason: null, external };
}

/*
  Ограничитель частоты команд на клиента.

  Зачем: команды приходят от панели по одной на действие, а вот самодельный
  скрипт или зациклившийся пульт могут засыпать шину тысячами сообщений в
  секунду — это и лаг event loop, и мусор в журнале. Лимит с запасом к
  человеческому темпу, но не бесконечный; часы инжектируются, чтобы окно
  проверялось в тесте без ожидания.
*/
function createCommandLimiter(options = {}) {
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0 ? options.windowMs : 1000;
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.floor(options.max) : 60;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const counters = { allowed: 0, limited: 0, windows: 0 };

  function allow(socket) {
    const now = clock();
    let bucket = socket && socket._oseRate;
    if (!bucket || now - bucket.since >= windowMs) {
      bucket = { since: now, count: 0 };
      counters.windows += 1;
      if (socket) socket._oseRate = bucket;
    }
    bucket.count += 1;
    if (bucket.count <= max) {
      counters.allowed += 1;
      return true;
    }
    counters.limited += 1;
    return false;
  }

  return {
    allow,
    counters: () => ({ ...counters }),
    get windowMs() {
      return windowMs;
    },
    get max() {
      return max;
    },
  };
}

module.exports = {
  isLoopbackAddress,
  isLoopbackRequest,
  presentedToken,
  checkUpgrade,
  createCommandLimiter,
  LOOPBACK_ADDRESSES,
};
