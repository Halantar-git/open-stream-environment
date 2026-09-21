# VK Video Live: можно ли интегрировать

Оценка от 21.09.2026. **Статус: отложено, ничего не реализовано.**

Короткий вывод: читать и отправлять сообщения в чат можно, алерты — под вопросом,
модерации нет вообще. Начать нельзя без аккаунта VK: у платформы нет анонимного
доступа, каждый запрос требует токена зарегистрированного приложения.

## Как читать саму документацию

Сайт `https://dev.live.vkvideo.ru/docs/index` — одностраничное приложение: по
HTTP он отдаёт пустую страницу, текст из него не вытаскивается. Варианты — открыть
в браузере и сохранить страницы как MHTML или взять готовый слепок (в разборе
использовался слепок из репозитория `acylut88/live_vkvideo_ru__API_docs`).

Важно не перепутать: `https://apidev.live.vkvideo.ru/` — это сам API, а не
документация. На любой путь он отвечает `{"error":"unknown_api_method"}`.

Разделы документации:

- `/docs/main/authorization`, `/docs/main/errors` — авторизация и ошибки;
- `/docs/method/<раздел>` — методы: `catalog`, `category`, `current_user`,
  `channel`, `chat`, `channel_points`, `channel_roles`, `stream_records`,
  `stream`, `video`, `token`, `websocket`;
- `/docs/pubsub/websocket`, `/docs/pubsub/webhook` — подписка на события;
- `/docs/schemas/<раздел>` — схемы ответов;
- `/docs/other/embed` — embed-плеер.

## Что доступно

| Раздел | Что есть |
|---|---|
| Чтение чата | `GET /v1/chat/messages` (`channel_url`, `limit` ≤ 200), `GET /v1/chat/members` (≤ 200 участников), `GET /v1/chat/member`. Уровень доступа — «пользователь, приложение», «доступность — все» |
| Отправка | `POST /v1/chat/message/send`, scope `chat:message:send`; ошибки данных `message_too_long`, `same_message`, `send_too_fast` |
| Настройки чата | `GET /v1/chat/settings`, `POST /v1/chat/settings/edit` (владелец или модератор, scope `chat:settings`) |
| Реалтайм | Centrifugo v4: `GET /v1/websocket/token` → `wss://pubsub-dev.live.vkvideo.ru/connection/websocket?format=json&cf_protocol_version=v2`; каналы `chat`, `channel_points`, `info`, `private_chat`, `private_info`, `limited_chat`, `limited_private_chat`, `private_channel_points`; для «limited»-каналов нужен ещё `GET /v1/websocket/subscription_token` |
| Сообщение | `author`, `created_at`, `id`, `is_private`, `parts[]` |
| Части сообщения | `text{content}`, `link{content,url}`, `mention{id,nick}`, `smile{id,name,animated,small/medium/large_url}` — смайлы и упоминания приходят структурно, а не текстом |
| Автор | `id`, `nick`, `avatar_url`, `nick_color`, `is_owner`, `is_moderator`, `badges[]` (например `owner`, `verified_streamer`, `subscription_01`), `roles[]` — с готовыми URL картинок |
| Баллы канала | `GET /v1/channel_point`, `/rewards`, `/rewards/manage_info`, `/reward/manage_info`, `POST /reward/create|edit|delete|enable|disable`, `POST /reward/activate`, `GET /reward/demands`, `POST /demand/accept|reject` |
| Канал и стрим | `GET /v1/channel` (статус `online`/`offline`/`wait`, счётчики), `GET /v1/channel/credentials` (RTMP-адрес и ключ), `POST /v1/channel/stream/edit` (заголовок, категория), `GET /v1/stream`, `GET /v1/stream_records`, `GET /v1/video` |
| Каталог | `GET /v1/catalog/*` (активные каналы, категории, промо), `GET /v1/category`, `/category/search` |
| Embed | `https://live.vkvideo.ru/app/embed/{channel_url}` и варианты для записи и клипа; управление через `postMessage` |

Авторизация: OAuth 2.0 CodeFlow (окно — `auth.live.vkvideo.ru/app/oauth2/authorize`,
обмен кода — `POST https://api.live.vkvideo.ru/oauth/server/token` с заголовком
`Authorization: Basic base64(client_id:secret)`, есть `refresh_token`), либо
ImplicitFlow (без refresh и **без вебхуков**), либо авторизация приложения
(`grant_type=client_credentials`). Scope: `channel:credentials`,
`channel:stream:settings`, `channel:points`, `channel:points:rewards`,
`channel:points:rewards:demands`, `channel:roles`, `chat:message:send`,
`chat:settings`. Документация прямо запрещает отдавать `secret` и `refresh_token`
на клиентскую сторону.

## Чего нет

- **Модерации.** Ни удаления сообщения, ни бана, ни таймаута, ни мьюта — таких
  методов в API нет. Единственное действие такого рода — назначение ролей
  (`POST /v1/channel_roles/user/set`, список ролей перетирается целиком).
- **Каталога событий.** Страницы про WebSocket и WebHook описывают транспорт
  (`{type, data}` у WS; `event` + `signature` у вебхука), но перечень типов
  событий вынесен в отдельную «документацию по событиям», которой в слепке нет.
  Без неё объём алертов (подписчики, донаты, рейды) неизвестен.
- **Палитры цветов.** `nick_color` — это не hex, а «номер цвета владельца канала
  из палитры, число от 0 до 15». Самой палитры в документации нет.
- **Песочницы и числовых лимитов.** Есть только ошибка `ratelimit_exceeded` (429)
  и ограничение `limit` ≤ 200 в нескольких методах.
- **WebHook для нашего случая.** Нужен публичный web-push URL и авторизация
  CodeFlow, плюс при `not_linked` подписка восстанавливается только повторной
  авторизацией пользователя. Для локального desktop-приложения это не вариант —
  остаётся только WebSocket.

## Стоп-факторы

1. **Нет анонимного чтения.** В отличие от Twitch, где чат читается
   `justinfan`-режимом вообще без токена, у VK любой запрос — это
   `Authorization: Bearer`, а токен выдаётся только приложению, зарегистрированному
   в кабинете разработчика. Без аккаунта VK и зарегистрированного приложения
   нельзя ни прочитать чат, ни проверить подключение, ни отладить его.
2. **Неизвестно, разрешён ли `redirect_uri` на `http://localhost:порт`.** В
   документации сказано только, что адрес должен совпадать с указанным при
   регистрации. Наши три OAuth-потока (`server/oauth.js`) используют именно
   локальный колбэк, и если кабинет требует HTTPS, авторизацию пользователя так
   не сделать. Проверяется только своим приложением в кабинете.
3. **Нужен клиент Centrifugo v4.** Документация предупреждает, что сервер — это
   Centrifugo V4, и клиентская библиотека должна быть с ним совместима. Значит,
   новая зависимость, а не только новый модуль.

## Что переносится из нашего бота

| Возможность | На VK |
|---|---|
| Чтение чата, команды, шаблоны ответов | да |
| Уровни доступа (`is_owner`, `is_moderator`, `badges`, `roles`) | да |
| Кулдауны, таймеры, `!commands` | да, это наша логика |
| Отправка ответов | да, `chat/message/send` |
| Ссылки/мат/капс/смайлы и варны | проверять можем, наказывать — нет |
| Таймаут, бан, удаление сообщения | нет, методов в API нет |

То есть «бот-собеседник» переносится целиком, «бот-модератор» — нет.

## Куда это встраивалось бы в проект

- `server/integrations/vkvideo-live.js` — по образцу `youtube-live.js`;
- маппер `v1Message → chat_message` отдельной чистой функцией и тестом — ровно
  так же, как `chatMessageFromTags` в `twitch-chat.js` и `nickColor` в
  `server/nick-color.js`;
- OAuth-роут рядом с остальными в `server/oauth.js` (`redirectUri(port, "vkvideo")`);
- сервис в `CONNECTION_SERVICES` (`shared/events.js`), чипы статуса в
  `control/modules/ws-client.js`, локали в `shared/locales/ru.json` и `en.json`;
- `services: ["twitchChat", "youtube", …]` у чат-виджетов в
  `shared/widget-catalog.js`;
- цвета ников: палитра платформы не опубликована, поэтому либо подбирать её
  на глаз, либо использовать свою (`server/nick-color.js`), как сделано для
  YouTube.

## Чеклист перед началом работы

1. Завести аккаунт VK и зарегистрировать приложение в кабинете разработчика.
2. Выяснить, принимает ли кабинет `http://localhost:8710/oauth/vkvideo/callback`.
3. Пройти авторизацию и прочитать живой чат тестового канала — сначала
   `GET /v1/chat/messages`, потом WebSocket.
4. Найти каталог типов событий и решить, годятся ли они для алертов.
5. Найти или составить палитру `nick_color` (16 цветов).
6. Проверить совместимый с Centrifugo v4 клиент для Node/Electron.

## Шпаргалка по хостам

| Назначение | Адрес |
|---|---|
| DevAPI (методы `/v1/...`) | `https://apidev.live.vkvideo.ru/` |
| Окно авторизации | `https://auth.live.vkvideo.ru/app/oauth2/authorize` |
| Обмен и отзыв токена | `https://api.live.vkvideo.ru/oauth/server/token`, `/oauth/server/revoke` |
| WebSocket (Centrifugo v4) | `wss://pubsub-dev.live.vkvideo.ru/connection/websocket?format=json&cf_protocol_version=v2` |
| Embed-плеер | `https://live.vkvideo.ru/app/embed/{channel_url}` |

`channel_url` — короткое имя канала (в документации пример `vkvideo`), берётся из
`GET /v1/current_user` (`data.channel.url`) или `GET /v1/channel`. В подписи
вебхука — `sha256(url_decoded_event + app_signature_key)`; ожидаемый ответ — HTTP
200 с `{"id": "...", "status": "ok"}`.
