# OSE signal — публичный signaling

Сервис для гостевых камер через интернет и обмен OAuth2-кода GoodGame.
Медиа он **не передаёт**: обе стороны комнаты соединяются по WebRTC напрямую,
а Worker только сводит их и пересылает SDP/ICE. Из OAuth здесь живёт только
обмен кода на токен — секрет приложения GoodGame в приложение не попадает.

## Что внутри

- `worker.js` — Cloudflare Worker: маршруты `/ws`, `/oauth/goodgame/*` и
  Durable Objects комнаты и OAuth-состояний.
- `room.js` — состояние комнаты (два места: хост и гость), общее с тестами.
- `oauth.js` — адреса и формы OAuth2 GoodGame, общие с тестами.
- `wrangler.toml` — конфигурация воркера и Durable Objects.

## Протокол

Подключение:

```
wss://signal.example/ws?room=<16–64 alnum/_-]&token=<16–64 alnum/_-]&role=host|guest&name=<имя>
```

- комнату создаёт только `host`; `guest` обязан принести тот же токен;
- одновременно в комнате не больше двух сокетов — по одному на роль;
- после подключения сервис шлёт `{"type":"joined"}`;
- когда обе стороны на месте — `{"type":"peer_joined","payload":{"role","name"}}`
  каждой стороне;
- при уходе — `{"type":"peer_left","payload":{"role"}}` оставшемуся;
- все остальные текстовые кадры пересылаются второй стороне как есть.
  Бинарные кадры не принимаются.

Медиа и SDP сервис не разбирает и не хранит. Токен комнаты живёт в хранилище
Durable Object; пустая комната удаляется через два часа после ухода последнего
участника.

## Деплой

```bash
cd signal
npx wrangler login
npx wrangler deploy
```

Рабочий адрес — `wss://ose-signal.halantar.workers.dev` (аккаунт Cloudflare
`halantar`). Свой домен привязывается в **Workers → ose-signal → Settings →
Domains & Routes**; зона должна быть в том же аккаунте Cloudflare (для
`signal.ose-overlay.ru` это значит перенести DNS домена в Cloudflare).

Проверка:

```bash
curl -4 -i https://ose-signal.halantar.workers.dev/healthz     # 200 OSE signal
curl -4 -i https://ose-signal.halantar.workers.dev/ws          # 426 websocket required
npx wrangler dev          # локально, http://127.0.0.1:8787
```

Флаг `-4` не случаен: у части провайдеров IPv6-маршрут до Cloudflare
обрывается на TLS, хотя IPv4 отвечает. Клиент в приложении сам ставит IPv4
вперёд по той же причине.

В приложении адрес задаётся в «Настройки → Гостевые камеры → Адрес signaling»:
по умолчанию `wss://ose-signal.halantar.workers.dev`, для локальной проверки —
`ws://127.0.0.1:8787`.

GitHub Pages сюда не подходит: статический хостинг не умеет WebSocket.
Домен сайта при этом не меняется — signaling живёт на поддомене.

## OAuth2 GoodGame

GoodGame принимает `redirect_uri` только на HTTPS и только с путём, поэтому
браузер возвращается не в приложение, а в этот же Worker. Приложение просит
адрес входа, открывает браузер, а токены забирает у воркера по одноразовому
пропуску. **Секрет приложения остаётся в Cloudflare** — в приложение и в
репозиторий он не попадает.

### Регистрация приложения

1. Откройте `https://goodgame.ru/user/<ваш id>/oauth2`.
2. Придумайте уникальный `client_id`.
3. Укажите `redirect_uri` ровно так, со слэшем в конце:

   ```
   https://ose-signal.halantar.workers.dev/oauth/goodgame/callback/
   ```

   Свой домен — тоже можно, но он должен вести на этот воркер (Workers →
   ose-signal → Settings → Domains & Routes).
4. Сохраните и скопируйте `client_secret`.

Приложение регистрируется **один раз для всех**: каждому стримеру отдельный
домен или поддомен не нужен. Стример просто нажимает «Подключить GoodGame» и
разрешает доступ к своему аккаунту.

### Секреты воркера

```bash
cd signal
npx wrangler secret put GOODGAME_CLIENT_ID
npx wrangler secret put GOODGAME_CLIENT_SECRET
npx wrangler secret put GOODGAME_REDIRECT_URI   # https://…/oauth/goodgame/callback/
npx wrangler deploy
```

`GOODGAME_REDIRECT_URI` можно не задавать: тогда берётся адрес по умолчанию —
`https://ose-signal.halantar.workers.dev/oauth/goodgame/callback/`.

### Маршруты

| Маршрут | Кто зовёт | Что делает |
| --- | --- | --- |
| `POST /oauth/goodgame/prepare` | приложение | принимает `state`, `verifier`, `port`; возвращает `authorize_url` |
| `GET /oauth/goodgame/callback[/]` | браузер после GoodGame | меняет `code` на токены и уводит на `http://127.0.0.1:<port>/oauth/goodgame/callback?state=…&ticket=…` |
| `POST /oauth/goodgame/ticket` | приложение | по `state` + `verifier` + `ticket` отдаёт токены (один раз) |
| `POST /oauth/goodgame/refresh` | приложение | меняет `refresh_token` на новую пару токенов |

### Почему это безопасно

- `client_secret` живёт только секретом Cloudflare и в браузер не попадает.
- В адресную строку не попадают ни код, ни токены: браузер уносит домой
  только `state` и одноразовый `ticket`.
- В хранилище воркера лежит хеш пары `state` + `verifier`; без `verifier`,
  который остался в приложении, тикет не обменять.
- `state` живёт 15 минут, `ticket` — 5 минут и гасится при первом обмене.
- Локальный возврат принимается только с loopback-адреса, а порт берётся из
  подготовки входа (1024–65535).

Проверка после деплоя:

```bash
curl -4 -i https://ose-signal.halantar.workers.dev/oauth/goodgame/prepare   # 405
```

## Ограничения

- P2P-соединение не обходит симметричный NAT; для таких сетей нужен TURN
  (пока не подключён).
- Прямое соединение раскрывает собеседнику публичный IP. Для случайных гостей
  нужен режим через TURN.
- Сервис не знает, что передаётся в SDP; доверять комнате можно только после
  подтверждения в приложении.
