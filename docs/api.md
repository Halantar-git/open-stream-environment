# API Open Stream Environment

Локальный HTTP-сервер и шина WebSocket — единственная точка, через которую
панель, оверлей, сцены, пульт и внешние инструменты общаются с приложением.
Документ описывает контракт: маршруты, кадры, доступ и форматы. Формат пакетов
виджетов и тем подробно разобран в [`plugin-api.md`](plugin-api.md).

Источник истины — код:

| Что | Где |
|---|---|
| HTTP-маршруты | `src-tauri/src/server/mod.rs` |
| Доступ и ограничитель частоты | `src-tauri/src/server/access.rs` |
| Команды панели | `src-tauri/src/server/commands.rs` |
| Действия пульта | `src-tauri/src/server/remote.rs` |
| Идентификаторы кадров | `shared/events.js`, `src-tauri/src/protocol.rs` |
| Снимок состояния | `src-tauri/src/state/snapshot.rs` |
| Пакеты виджетов и тем | `docs/plugin-api.md`, `src-tauri/src/plugins.rs` |

Если меняется маршрут или идентификатор кадра, меняется и этот файл: список в
приложении сверяется с `shared/events.js` тестами (`tests/events.test.js`,
`src-tauri/src/protocol.rs`).

## База

```
http://localhost:8710
```

Порт по умолчанию — `8710`; значение берётся из `port` в `config/config.json`.
Порт можно сменить на ходу из панели — фактический адрес всегда виден в шапке
приложения и в ответе `/healthz`. Сервер слушает все интерфейсы: пульт с
телефона открывается по адресу этой машины в локальной сети.

Ответы HTTP не содержат заголовков CORS, поэтому читать их из браузера можно
только со страниц самого приложения. Для внешних инструментов (Stream Deck,
скрипты, мониторинг) ограничений нет: CORS действует только в браузере.

## Доступ

| Откуда | Что нужно |
|---|---|
| Эта же машина (`127.0.0.0/8`, `::1`) | ничего |
| Локальная сеть (телефон, другой ПК) | код доступа |
| Гостевое подключение (мультикам) | одноразовый токен приглашения |

Код доступа передаётся в query (`?token=…`) или заголовком `x-ose-token`
(устаревшее имя — `x-ose-code`). Код лежит в адресе пульта и меняется кнопкой
«Новый код доступа» в настройках.

Для WebSocket дополнительно проверяется `Origin`:

- без `Origin` (скрипты, Stream Deck) — разрешено;
- `file://` и `null` — разрешено (окна прошлой Electron-версии);
- `http(s)://host:port` — только если порт совпадает с портом сервера, а хост
  локальный: `localhost`, `127.*`, `::1`, имя вида `*.local`, односоставное
  имя компьютера или частный адрес (`10/8`, `172.16/12`, `192.168/16`).

Ограничитель частоты: **60 команд в секунду** на одно подключение. Лишние
команды не выполняются и попадают в журнал (`command rate limited`). Исключения
— автодополнение CLI и сигналинг WebRTC: они не считаются командами.

## HTTP

| Метод | Путь | Что отдаёт |
|---|---|---|
| `GET` | `/` | страница панели (`control/control.html`) |
| `GET` | `/control/`, `/overlay/`, `/remote/`, `/chatwindow/`, `/splash/`, `/widgeteditor/`, `/themeeditor/`, `/csseditor/` | статические страницы и их файлы |
| `GET` | `/healthz` | короткий JSON о состоянии сервера |
| `GET` | `/support-bundle` | полный отчёт для поддержки текстом (только с этой машины) |
| `GET` | `/api/plugins` | список пакетов виджетов и тем |
| `GET` | `/plugins/<id>/<file>` | файлы пакета: манифест, код, стили, ресурсы |
| `GET` | `/media/<file>` | пользовательские медиа (с поддержкой `Range`) |
| `GET` | `/oauth/twitch/callback` | возврат OAuth Twitch |
| `GET` | `/oauth/donationalerts/callback` | возврат OAuth DonationAlerts |
| `GET` | `/oauth/youtube/callback` | возврат OAuth YouTube |

Статика отдаётся с `Cache-Control: no-store`, медиа — с `no-cache` и
`Accept-Ranges`: заставки и видео должны перематываться и не залипать в кэше
webview. Неизвестный путь — `404`.

Машиночитаемая схема HTTP-части — [`openapi.json`](openapi.json) (OpenAPI 3.1).
Шина WebSocket в неё не входит: кадры и роли описаны ниже.

### `GET /healthz`

Публичный (код не нужен): по нему мониторинг отвечает на вопрос «сервер жив?».
Путей к данным и секретов в ответе нет.

```json
{
  "at": 1792742400000,
  "ok": true,
  "app": "Open Stream Environment",
  "version": "4.4.0",
  "mode": "tauri",
  "pid": 12345,
  "uptimeSec": 3600,
  "port": 8710,
  "listening": true,
  "server": { "clients": 4, "byRole": { "control": 1, "overlay": 2 } },
  "session": { "id": "…", "channel": "канал", "startedAt": 1792738800000 },
  "integrations": { "twitchChat": "connected", "obs": "not_configured" },
  "storage": { "...": "размеры и лимиты" },
  "writes": { "...": "очередь записи" },
  "perf": { "...": "память и задержки" },
  "longrun": { "...": "долгие операции" },
  "security": { "...": "код доступа и отказы" },
  "problems": []
}
```

`ok` равен `false`, если в `problems` есть хотя бы одна запись.

### `GET /support-bundle`

Только с loopback: из сети отвечает `403`. Это тот же отчёт, что сохраняется
кнопкой «Отчёт для поддержки», но текстом (`text/plain; charset=utf-8`,
`Content-Disposition: attachment`). Содержит сводку настроек без секретов,
размеры хранилища, хвост журнала, последние аварии и список резервных копий.

### `GET /api/plugins`

Открытый JSON: секретов в манифестах нет, а код пакета загружает и оверлей в
другом браузере. Ответ всегда `200`; ошибки отдельных пакетов — в `errors`,
а не в статусе.

```json
{
  "apiVersion": 1,
  "plugins": [
    {
      "kind": "widget",
      "id": "hello",
      "type": "plugin:hello",
      "name": "Привет",
      "description": "Карточка с текстом",
      "version": "1.0.0",
      "author": "Автор",
      "baseUrl": "/plugins/hello/",
      "entry": "widget.js",
      "styles": ["widget.css"],
      "icon": "widgetCustom",
      "geometry": { "x": 40, "y": 42, "w": 20, "h": 10 },
      "minW": 8,
      "minH": 4,
      "settings": {
        "text": { "type": "string", "label": "Текст", "default": "Привет" }
      }
    },
    {
      "kind": "theme",
      "id": "plugin:plain-theme",
      "pluginId": "plain-theme",
      "name": "Plain",
      "version": "1.0.0",
      "author": "Автор",
      "baseUrl": "/plugins/plain-theme/",
      "css": "theme.css",
      "tokens": { "--md-primary": "#7aa2f7" },
      "colors": ["#7aa2f7", null, null]
    }
  ],
  "errors": [{ "dir": "broken", "error": "JSON: expected value at line 1 column 3" }]
}
```

Поля виджета:

| Поле | Смысл |
|---|---|
| `type` | тип в раскладке: `plugin:<id>` |
| `entry` | `.js`-файл, который подключает страница |
| `styles` | `.css`-файлы пакета |
| `geometry` | положение и размер по умолчанию, проценты холста |
| `minW` / `minH` | минимальные размеры при растягивании |
| `settings` | схема полей инспектора и умолчания |

Тема приходит в форме встроенной (`id` — `plugin:<id>`, `tokens` — готовый
набор), поэтому применяется теми же механизмами, что и `themes.js`. Править и
удалять её из панели нельзя: источник правды — пакет.

### `GET /plugins/<id>/<file>`

Статика из `%APPDATA%/com.openstreamenvironment.app/plugins/<id>/`. Пути внутри
манифеста не могут выходить за каталог пакета; выход за него — `404`.

### OAuth

Возвраты OAuth принимают `code` и `state` в query. `state` сверяется с
сохранённым guard-значением; чужой или устаревший `state` даёт страницу ошибки,
а не обмен кода. Результат — HTML-страница «можно закрыть окно»; токены в
ответе не показываются.

## WebSocket

```
ws://localhost:8710/ws?role=control
ws://localhost:8710/ws?role=remote&token=<код>
```

### Роли

| `role` | Кто | Особенности |
|---|---|---|
| `control` | панель | может слать кадры камеры |
| `overlay` | оверлей в OBS и HUD | получает текущий алерт при подключении, бинарные кадры микрофона и камеры |
| `scene` | полноэкранные сцены | получает бинарные кадры |
| `chat` | окно чата | только события |
| `remote` | веб-пульт | шлёт `remote_action` |
| `guest` | гость мультикама | только `guest_signal`; остальное отклоняется |
| `host` | исходящее соединение к другому OSE | сигналинг мультикама |
| `other` | служебные страницы | по умолчанию, если `role` не указан |

Роль — это метка для журнала и выбора рассылок. Отдельной проверки «эта роль
имеет право на команду» нет: команду может прислать любой прошедший доступ;
гостевой сокет — исключение, он принимает только сигналинг.

### Первые кадры

Сразу после подключения сервер присылает по порядку:

1. `locales` — словари и язык;
2. `state` — полный снимок;
3. `wheel_config`, `wheel_speed_config`, `overlay_mic_config`,
   `overlay_camera_config` — настройки, которые нельзя терять при перезагрузке
   источника OBS;
4. `guest_status` — слоты гостевых камер;
5. `ticker_pause` — стоит ли новостная лента;
6. `alert` — если роль `overlay` и в очереди есть играющий алерт.

Клиенту не нужно запрашивать состояние: оно приходит само.

### Формат кадра

```json
{ "type": "chat_message", "payload": { "user": "зритель", "message": "привет" } }
```

Текст — UTF-8 JSON. Неизвестный `type` клиент и сервер игнорируют: это правило
совместимости при обновлении одной из сторон.

Двоичные кадры — отдельный канал для медиа: кадры микрофона и камеры
различаются магией в первых байтах. Сервер не разбирает содержимое, а
пересылает их ролям `overlay` и `scene`. Кадры камеры принимаются только от
`control`.

### Сервер → клиент

| `type` | Payload |
|---|---|
| `state` | полный снимок: `layout`, `appearance`, `goal`, `recentEvents`, `stats`, `connectionStatus`, `scenes`, `donatex` (флаг и ссылки на виджеты), `port`, `remoteUrl` и др. |
| `layout_update` | `{ layout }` — раскладка основного оверлея |
| `scene_layout_update` | `{ scene, layout }` — раскладка конкретной сцены |
| `layout_presets_update` | `{ presets }` |
| `theme_update` | `{ activeThemeId, enable3d, activeThemeId3d, tokens, themes, customCss, active3dWidgets, enabled3d }` |
| `locales` | `{ lang, locales: { ru, en } }` |
| `alert` | `{ kind: "follow" \| "sub" \| "gift_sub" \| "cheer" \| "donation", ... }` |
| `alert_queue_update` | `{ queue: { now, items, paused, pausedUntil, rules, stats } }` |
| `chat_message` | сообщение чата: `{ user, message, badges, ... }` |
| `chat_sent` | `{ clientId, ok, messageId, error? }` — результат отправки в чат |
| `recent_event` | одно событие для ленты «Последние события» |
| `goal_update` | `{ current, target, title, currency }` |
| `session_stats` | `{ count, amount, currency }` — счёт донатов стрима |
| `top_donation_update` | `{ user, amount, currency }` |
| `ticker_message` | `{ text, priority: "normal" \| "breaking", durationMs? }` |
| `ticker_pause` | `{ paused }` |
| `ticker_control` | `{ action: "remove" \| "clear", text? }` |
| `music_play` | `{ musicLink, musicTitle?, user?, silent? }` — `silent` значит, что трек уже звучит на странице DonateX и его надо только показать |
| `music_control` | `{ action: "skip" \| "stop" }` |
| `death_count_update` | `{ count }` |
| `connection_status` | `{ service, status }` |
| `stat_update` | `{ followerCount, subscriberCount }` |
| `guest_status` | `{ slots: [{ slot, name, state, guest? }] }` |
| `guest_join_request` / `guest_accepted` / `guest_declined` / `guest_left` | `{ slot, name? }` |
| `guest_signal` | `{ slot, payload }` — SDP/ICE, сервер не разбирает |
| `terminal_log` / `debug_log` | `{ timestamp, service, level, message, data }` |
| `twitch_action_result` | `{ action, ok, message?, error? }` |

Полный список идентификаторов и их payload — в приложении к этому файлу и в
`shared/events.js`.

### Клиент → сервер

Команды шлются в том же формате `{ "type": "...", "payload": { ... } }`.
Основные группы:

**Раскладка**

| `type` | Payload |
|---|---|
| `cmd_add_widget` | `{ type, target? }` — `target` — имя сцены, без него основная раскладка |
| `cmd_update_widget` | `{ id, patch: { x?, y?, w?, h?, visible?, z?, config? } }` |
| `cmd_remove_widget` | `{ id }` |
| `cmd_reorder_widget` | `{ id, direction: "forward" \| "backward" }` |
| `cmd_save_layout` | `{ layout, target? }` — сохранить раскладку из HUD-редактора |
| `cmd_save_layout_preset` / `cmd_apply_layout_preset` / `cmd_delete_layout_preset` | `{ id?, name }` / `{ id }` / `{ id }` |

**Темы**

| `type` | Payload |
|---|---|
| `cmd_set_active_theme` | `{ id, enable3d? }` |
| `cmd_set_enabled_3d` | `{ type, enabled }` — отдельная 3D-фишка |
| `cmd_save_custom_theme` | `{ id?, name, seeds }` |
| `cmd_delete_custom_theme` / `cmd_duplicate_custom_theme` | `{ id }` |
| `cmd_import_custom_theme` | `{ name, seeds }` |
| `cmd_preview_theme_draft` | `{ tokens, customCss, themeId, name, clear? }` |

**Контент и интеграции**

| `type` | Payload |
|---|---|
| `cmd_ticker_message` | `{ text, priority? }` |
| `cmd_ticker_pause` | `{ paused }` |
| `cmd_ticker_control` | `{ action: "remove" \| "clear", text? }` |
| `cmd_music_control` | `{ action: "skip" \| "stop" }` |
| `cmd_test_music` | `{ url }` |
| `cmd_test_alert` | `{ kind }` |
| `cmd_set_goal` | `{ title?, current?, target?, currency? }` |
| `cmd_send_chat` | `{ message, clientId }` |
| `cmd_create_clip` / `cmd_create_stream_marker` | `{}` / `{ description? }` |
| `cmd_set_obs_config` | `{ host?, port?, password?, clearPassword?, sceneMap? }` |
| `cmd_setup_obs_scenes` | `{}` |
| `cmd_run_obs_command` | `{ id }` |
| `cmd_set_language` | `{ lang }` |

Очередь алертов (`cmd_alert_queue_*`), колесо (`cmd_*_wheel*`,
`cmd_*_giveaway*`), голосование (`cmd_*_poll*`), камеры, микрофон, звуковая
панель и гости — по тому же принципу: имя команды и объект `payload` описаны
в `shared/events.js`.

**Терминал**

| `type` | Payload |
|---|---|
| `exec_cli_command` | `{ command }` |
| `exec_cli_completion` | `{ input }` — ответ приходит только этому клиенту как `cli_completions` |

**Пульт** — `remote_action`:

```json
{ "type": "remote_action", "action": "SCENE_SET", "payload": { "scene": "brb" } }
```

`action` не чувствителен к регистру. Список действий:

| `action` | Payload | Что делает |
|---|---|---|
| `SCENE_SET` | `{ scene }` | переход сцены, при настроенной заставке — через неё |
| `WHEEL_START` | `{ command? }` | начать розыгрыш |
| `WHEEL_STOP` | `{}` | остановить |
| `WHEEL_SPIN` | `{}` | вращение |
| `WHEEL_GENERATE` | `{}` | собрать колесо |
| `WHEEL_RESET_PARTICIPANTS` | `{}` | сбросить участников |
| `WHEEL_CLEAR_RESULT` | `{}` | очистить результат |
| `DEATH_INCREMENT` / `DEATH_DECREMENT` | `{}` | счётчик смертей ±1 |
| `DEATH_RESET` | `{}` | сброс счётчика |
| `TEST_ALERT` | `{ kind }` | тестовый алерт |
| `TICKER_MESSAGE` | `{ text, priority? }` | сообщение в ленту |
| `MUSIC_SKIP` / `MUSIC_STOP` | `{}` | очередь музыки донатов |
| `THEME_SET` | `{ id \| themeId, enable3d? }` | смена темы |
| `OBS_RAW_COMMAND` | `{ id }` | OBS-команда из настроек |
| `SOUNDBOARD_TRIGGER` | `{ soundId, user? }` | звук звуковой панели |
| `CAMERA_SET` | `{ angleId }` | ракурс камеры |
| `CAMERA_FILTER` | `{ filterId }` | эффект камеры |
| `WEBCAM_TOGGLE` / `MIC_TOGGLE` | `{}` | включить/выключить источник OBS |

Неизвестное действие пишется в журнал как предупреждение и ничего не меняет.

### Гостевой сигналинг

Гость подключается по адресу из приглашения:

```
ws://<host>:<port>/ws?role=guest&slot=cam2&token=<токен>&name=<имя>
```

Сервер проверяет одноразовый токен, привязывает сокет к слоту и принимает от
гостя только `guest_signal` с тем же слотом. `SDP` и `ICE` пересылаются
подписанному виджету хоста как есть; медиа идёт напрямую между браузерами.

## Примеры

HTTP-часть проверяется любым клиентом; шина — `websocat` или встроенным в
Node 22 `WebSocket`. Кадры — однострочный JSON, поэтому в консоли их удобно
заключать в одинарные кавычки.

### Проверить сервер

```bash
curl http://localhost:8710/healthz
```

Сокращённо (полный ответ — в `openapi.json`):

```json
{ "ok": true, "port": 8710, "version": "4.4.0", "problems": [] }
```

### Список пакетов и файл пакета

```bash
curl http://localhost:8710/api/plugins
curl -o hello.js http://localhost:8710/plugins/hello/widget.js
```

### Отчёт для поддержки

```bash
curl -o ose-support.txt http://localhost:8710/support-bundle
```

Сработает только с этой машины: из сети — `403`.

### Подключиться к шине

```bash
websocat "ws://localhost:8710/ws?role=control"
```

Сразу придут `locales`, `state`, настройки колеса/микрофона/камеры,
`guest_status` и `ticker_pause`. Дальше в ту же сессию можно вводить кадры.

### Переключить сцену

```json
{"type":"remote_action","action":"SCENE_SET","payload":{"scene":"brb"}}
```

Допустимые сцены — `start`, `main`, `pause`, `brb`, `talk`, `guests`, `end`,
`wheel`, `poll`. Переход на `main` из служебной сцены и вход в служебную
проходят через заставку, если она настроена.

### Отправить сообщение в ленту

```json
{"type":"cmd_ticker_message","payload":{"text":"Через 10 минут розыгрыш","priority":"normal"}}
```

`priority: "breaking"` показывает сообщение срочной полосой. Ответ — кадр
`ticker_message` всем клиентам.

### Поставить пакетный виджет

```json
{"type":"cmd_add_widget","payload":{"type":"plugin:hello"}}
```

Ответ — `layout_update` с новой раскладкой. Для сцены добавьте адресата:

```json
{"type":"cmd_add_widget","payload":{"type":"chat","target":"guests"}}
```

`plugin:hello` — тип из примера `docs/examples/plugins/hello`; без
установленного пакета сервер такой тип отклонит.

### Выбрать пакетную тему

```json
{"type":"cmd_set_active_theme","payload":{"id":"plugin:plain-theme"}}
```

Ответ — `theme_update` с токенами новой темы. `plugin:plain-theme` — тема из
`docs/examples/plugins/plain-theme`.

### Управлять музыкой донатов

```json
{"type":"cmd_music_control","payload":{"action":"skip"}}
```

`action: "stop"` останавливает трек и очищает очередь.

### Скрипт на Node

Node 22 умеет `WebSocket` без зависимостей: скрипт подключается, ждёт
`ticker_message` и выходит.

```js
const ws = new WebSocket("ws://localhost:8710/ws?role=control");

ws.addEventListener("open", () => {
  ws.send(
    JSON.stringify({
      type: "cmd_ticker_message",
      payload: { text: "Привет из скрипта", priority: "normal" },
    }),
  );
});

ws.addEventListener("message", (event) => {
  const frame = JSON.parse(event.data);
  if (frame.type === "ticker_message") {
    console.log(frame.payload.text);
    ws.close();
  }
});
```

### Из локальной сети

С этой машины код не нужен. С телефона или другого компьютера добавьте его в
адрес шины или заголовок HTTP:

```bash
websocat "ws://192.168.1.42:8710/ws?role=remote&token=<код>"
curl -H "x-ose-token: <код>" http://192.168.1.42:8710/api/plugins
```

## Пакеты виджетов и тем

Пакет — папка в данных пользователя:

```
%APPDATA%/com.openstreamenvironment.app/plugins/<id>/
```

В разработке — `config/plugins/<id>/`. Манифест — `widget.json` или
`theme.json`, `apiVersion` сейчас `1`. После установки нужен перезапуск:
каталог и список тем читаются на старте, а `/api/plugins` отдаёт уже
разобранный реестр.

Кратко о контракте:

- тип виджета — `plugin:<id>`, он проходит через каталог сервера: добавление,
  геометрия, минимальные размеры, настройки по умолчанию;
- поля инспектора рисуются по `settings` (`string`, `text`, `number`,
  `range`, `color`, `boolean`, `select`);
- код наследует `OSE.BaseWidget` и регистрируется через
  `OSE.defineWidget("id", class extends OSE.BaseWidget { … })`;
- тема — `theme.json` с `tokens` и необязательным `css`; правила CSS пишутся
  под `[data-theme="plugin:<id>"]`;
- код пакета исполняется в странице оверлея с полными правами — ставить можно
  только доверенные пакеты.

Подробности, схема манифеста, жизненный цикл `BaseWidget` и примеры —
[`plugin-api.md`](plugin-api.md) и `docs/examples/plugins/`.

## Ошибки и совместимость

| Ситуация | Ответ |
|---|---|
| Нет или неверный код доступа из сети | `403` на upgrade WebSocket |
| Чужой `Origin` | `403` на upgrade WebSocket |
| `/support-bundle` из сети | `403` |
| Неизвестный путь или файл пакета | `404` |
| Битый манифест пакета | пакет не загружается, запись в `errors[]` и в журнал |
| Неизвестный `type` кадра | игнорируется |
| Команда сверх лимита | не выполняется, запись в журнал и аудит |

Идентификаторы кадров и поля payload не переименовываются без крайней
необходимости: на них завязаны панель, оверлей, пульт, Stream Deck и пакеты.
Новое поведение добавляется новым `type` или новым необязательным полем.
Версия формата пакетов (`apiVersion`) проверяется при разборе манифеста.

## Приложение: полный список идентификаторов

Сгенерировано из `shared/events.js`; обновить: `node src-tauri/tools/build-api-events.mjs`. Проверка на расхождение — `npm test` (`tests/api-docs.test.js`).

<!-- API_EVENTS_START -->
### События (сервер ↔ клиент)

| Ключ | `type` | Payload |
|---|---|---|
| `STATE` | `state` | full state snapshot, sent on connect |
| `LAYOUT_UPDATE` | `layout_update` | full layout array, sent after any add/update/remove/reorder |
| `SCENE_LAYOUT_UPDATE` | `scene_layout_update` | { scene, layout } — раскладка конкретной сцены |
| `LAYOUT_PRESETS_UPDATE` | `layout_presets_update` | { presets: [{ id, name, widgetCount, createdAt, updatedAt }] } |
| `ALERT` | `alert` | { kind: 'follow'\|'sub'\|'gift_sub'\|'cheer'\|'donation', ... } |
| `ALERT_QUEUE_UPDATE` | `alert_queue_update` | { queue: { now, items, paused, pausedUntil, rules, stats } } |
| `SESSION_STATS` | `session_stats` | { count, amount, currency } — счёт донатов текущего стрима |
| `CHAT_MESSAGE` | `chat_message` |  |
| `CHAT_SENT` | `chat_sent` | { clientId, ok, messageId, error? } — server -> client confirmation of an outgoing chat message |
| `RECENT_EVENT` | `recent_event` |  |
| `REWARD_REDEEM` | `reward_redeem` | { user, rewardTitle, message } — награда за баллы канала вне очереди алертов |
| `TICKER_MESSAGE` | `ticker_message` | { text, priority: "normal"\|"breaking", durationMs? } — произвольное сообщение в новостную ленту |
| `TICKER_PAUSE` | `ticker_pause` | { paused } — лента стоит: оверлеи останавливают бегущую строку |
| `TICKER_CONTROL` | `ticker_control` | { action: "remove"\|"clear", text? } — убрать отправленное сообщение из ленты |
| `GOAL_UPDATE` | `goal_update` | { current, target, title, currency } |
| `DONATEX_AI_EVENT` | `donatex_ai_event` | { characterName, aiText, aiAudio, user?, amount?, currency?, message? } — ответ ИИ-персонажа DonateX |
| `MUSIC_PLAY` | `music_play` | { musicLink, musicTitle?, user?, silent? } — трек для виджета музыки (донат, проверка или опрос DonateX) |
| `MUSIC_CONTROL` | `music_control` | { action: "skip" \| "stop" } — управление плеером из инспектора и опроса DonateX |
| `OBS_SCENES_SETUP` | `obs_scenes_setup` | { ok, sceneMap, createdScenes, createdSources, updatedSources, errors } — итог кнопки «Настроить сцены в OBS» |
| `OBS_SCENES` | `obs_scenes` | { scenes } — имена сцен в подключённой OBS для подсказок в маппинге |
| `CONNECTION_STATUS` | `connection_status` | { service, status } |
| `THEME_UPDATE` | `theme_update` | { activeThemeId, enable3d, activeThemeId3d, tokens, themes } |
| `THEME_DRAFT_PREVIEW` | `theme_draft_preview` | { tokens, customCss, themeId, name, clear? } — live draft for the theme preview window |
| `EDITOR_PREFS_UPDATE` | `editor_prefs_update` | { gridSize, snapEnabled } |
| `SCENES_UPDATE` | `scenes_update` | { start, brb, end } |
| `TOP_DONATION_UPDATE` | `top_donation_update` | { user, amount, currency } |
| `STAT_UPDATE` | `stat_update` | { followerCount, subscriberCount } |
| `GIVEAWAY_UPDATE` | `giveaway_update` | { giveaway } |
| `GIVEAWAY_WHEEL` | `giveaway_wheel` | { sectors } |
| `GIVEAWAY_SPIN` | `giveaway_spin` | {} |
| `GIVEAWAY_PARTICIPANTS` | `giveaway_participants` | { count, participants } |
| `POLL_UPDATE` | `poll_update` | { poll } |
| `POLL_PRESETS_UPDATE` | `poll_presets_update` | { presets: [{ id, name, ... }] } |
| `WHEEL_CONFIG` | `wheel_config` | { config } |
| `WHEEL_SPEED_CONFIG` | `wheel_speed_config` | { config } |
| `OVERLAY_MIC_CONFIG` | `overlay_mic_config` | { config } |
| `OVERLAY_CAMERA_CONFIG` | `overlay_camera_config` | { config } — глобальные настройки захвата камеры |
| `LONGSHOT_UPDATE` | `longshot_update` | { longshot } — Executive Hangar anchor from timers.longshotrelay.com |
| `LOCALES` | `locales` | { lang, locales: { ru, en } } |
| `TERMINAL_LOG` | `terminal_log` | { timestamp, service, level, message, data } |
| `DEBUG_LOG` | `debug_log` | { timestamp, service, level: "debug", message, data } |
| `CLEAR_TERMINAL` | `clear_terminal` | server -> client: clear the log panel |
| `REMOTE_ACTION` | `remote_action` | { action, payload } — remote quick action (command + broadcast) |
| `DEATH_COUNT_UPDATE` | `death_count_update` | { count } |
| `CAMERA_ANGLE_UPDATE` | `camera_angle_update` | { activeCameraAngle } |
| `CAMERA_FILTER_UPDATE` | `camera_filter_update` | { filterId, active } |
| `SOUNDBOARD_PLAY` | `soundboard_play` |  |
| `DONATION_MEDIA_PLAY` | `donation_media_play` | { ruleId, user, amount, currency, audioFile, imageFile, videoFile, durationMs, volume } — донат-медиа // { soundId, title, user, audioFile, imageFile, videoFile } |
| `VIDEO_SPLASH_PLAY` | `video_splash_play` | { mediaFile, scene, nextScene } — server -> overlay: play intro/brb/outro splash |
| `MIC_AUDIO_DATA` | `mic_audio_data` | { level, wave, freq } — mic bridge (control -> server -> overlay) |
| `CAMERA_STREAM_CONFIG` | `camera_stream_config` | { codec, width, height, fps, bitrate } — decoder config for the camera bridge |
| `CAMERA_DECODE_FAILED` | `camera_decode_failed` | { reason } — overlay could not decode H.264; control falls back to JPEG |
| `CAMERA_VIDEO_FRAME` | `camera_video_frame` | { blob } or { h264, keyframe, timestamp, data } — кадр камеры; событие шины, не провод |
| `HUD_EDIT_MODE` | `hud_edit_mode` | { enabled } — game HUD overlay entered/left direct-edit mode |
| `HUD_HOTKEY_UPDATE` | `hud_hotkey_update` | { hotkey } — current HUD toggle hotkey (after save) |
| `HUD_DISPLAY_UPDATE` | `hud_display_update` | { displayId } — selected monitor for the HUD overlay |
| `CHAT_HUD_HOTKEY_UPDATE` | `chat_hud_hotkey_update` | { hotkey } — current chat HUD toggle hotkey (after save) |
| `CHAT_HUD_DISPLAY_UPDATE` | `chat_hud_display_update` | { displayId } — selected monitor for the chat HUD overlay |
| `CHAT_HUD_CONFIG_UPDATE` | `chat_hud_config_update` | { config } — chat HUD window geometry/opacity/font (after save) |
| `REWARD_TTS` | `reward_tts` | { text } — server -> overlay: speak a channel-point reward phrase |
| `TWITCH_ACTION_RESULT` | `twitch_action_result` | { action, ok, message?, error? } — server -> control: clip/marker feedback |
| `GUEST_STATUS` | `guest_status` | { slots: [{ slot, name, state, guest? }] } — server -> все локальные окна |
| `GUEST_INVITE` | `guest_invite` | { slot, token, host, port } — server -> панель после создания приглашения |
| `GUEST_JOIN_REQUEST` | `guest_join_request` | { slot, name? } — гость подключился, нужно подтверждение |
| `GUEST_ACCEPTED` | `guest_accepted` | { slot } — хост пустил гостя |
| `GUEST_DECLINED` | `guest_declined` | { slot } — хост отклонил или отозвал приглашение |
| `GUEST_LEFT` | `guest_left` | { slot } — гость отключился |
| `GUEST_RECEIVER_READY` | `guest_receiver_ready` | { slot } — виджет на хосте готов принять поток |
| `GUEST_SIGNAL` | `guest_signal` | { slot, payload } — SDP/ICE в обе стороны (сервер не разбирает) |
| `VIDEO_SPLASH_ENDED` | `video_splash_ended` | overlay -> server: splash video finished/error — advance to pending scene |
| `VIDEO_SPLASH_READY` | `video_splash_ready` | overlay -> server: (re)connected — replay pending splash if any |
| `CLI_COMPLETIONS` | `cli_completions` | { input, completions } — server -> requesting client |
| `TERMINAL_FILTER` | `terminal_filter` | { level } — server -> client: filter log levels |

### Команды и служебные сообщения

| Ключ | `type` | Payload |
|---|---|---|
| `CMD_ADD_WIDGET` | `cmd_add_widget` | { type } |
| `CMD_UPDATE_WIDGET` | `cmd_update_widget` | { id, patch: { x?,y?,w?,h?,visible?,z?,config? } } |
| `CMD_REMOVE_WIDGET` | `cmd_remove_widget` | { id } |
| `CMD_REORDER_WIDGET` | `cmd_reorder_widget` | { id, direction: 'forward'\|'backward' } |
| `CMD_SAVE_LAYOUT` | `cmd_save_layout` | { layout } — persist overlay layout from HUD edit mode |
| `CMD_TOGGLE_HUD_EDIT_MODE` | `cmd_toggle_hud_edit_mode` | {} — control panel requests HUD edit-mode toggle |
| `CMD_SET_HUD_HOTKEY` | `cmd_set_hud_hotkey` | { hotkey } — change the global HUD toggle hotkey |
| `CMD_SET_HUD_DISPLAY` | `cmd_set_hud_display` | { displayId } — change the monitor for the HUD overlay |
| `CMD_TOGGLE_CHAT_HUD` | `cmd_toggle_chat_hud` | {} — control panel requests the chat HUD overlay toggle |
| `CMD_SET_CHAT_HUD_HOTKEY` | `cmd_set_chat_hud_hotkey` | { hotkey } — change the global chat HUD toggle hotkey |
| `CMD_SET_CHAT_HUD_DISPLAY` | `cmd_set_chat_hud_display` | { displayId } — change the monitor for the chat HUD overlay |
| `CMD_SET_CHAT_HUD_CONFIG` | `cmd_set_chat_hud_config` | { config } — change the chat HUD window geometry/opacity/font |
| `CMD_SET_TWITCH_REWARDS` | `cmd_set_twitch_rewards` | { rewards } — channel-point reward -> action mappings |
| `CMD_TEST_TWITCH_REWARD` | `cmd_test_twitch_reward` | { rewardId } — simulate a channel-point redemption |
| `CMD_CREATE_CLIP` | `cmd_create_clip` | {} — create a Twitch clip via Helix |
| `CMD_CREATE_STREAM_MARKER` | `cmd_create_stream_marker` | { description? } — create a Twitch stream marker |
| `CMD_SAVE_LAYOUT_PRESET` | `cmd_save_layout_preset` | { id?, name } |
| `CMD_APPLY_LAYOUT_PRESET` | `cmd_apply_layout_preset` | { id } |
| `CMD_DELETE_LAYOUT_PRESET` | `cmd_delete_layout_preset` | { id } |
| `CMD_SET_GOAL` | `cmd_set_goal` | { title?, current?, target?, currency? } |
| `CMD_TEST_ALERT` | `cmd_test_alert` | { kind } |
| `CMD_TICKER_MESSAGE` | `cmd_ticker_message` | { text, priority? } — сообщение в новостную ленту |
| `CMD_TICKER_PAUSE` | `cmd_ticker_pause` | { paused } — остановить или продолжить бегущую строку |
| `CMD_TICKER_CONTROL` | `cmd_ticker_control` | { action: "remove"\|"clear", text? } — убрать сообщение из ленты |
| `CMD_ALERT_QUEUE_PAUSE` | `cmd_alert_queue_pause` | { minutes? } — без минут: до снятия вручную |
| `CMD_ALERT_QUEUE_RESUME` | `cmd_alert_queue_resume` | {} |
| `CMD_ALERT_QUEUE_SKIP` | `cmd_alert_queue_skip` | {} — закончить текущий и перейти к следующему |
| `CMD_ALERT_QUEUE_REMOVE` | `cmd_alert_queue_remove` | { id } |
| `CMD_ALERT_QUEUE_UP` | `cmd_alert_queue_up` | { id } — поднять наверх |
| `CMD_ALERT_QUEUE_PLAY_NOW` | `cmd_alert_queue_play_now` | { id } |
| `CMD_ALERT_QUEUE_CLEAR` | `cmd_alert_queue_clear` | {} — убрать ожидающих |
| `CMD_ALERT_QUEUE_CONFIG` | `cmd_alert_queue_config` | { minAmount?, mergeSameUser?, mergeWindowSec? } |
| `CMD_RECOVER_DONATIONS` | `cmd_recover_donations` | { limit? } — подтянуть с DonationAlerts пропущенные донаты |
| `CMD_RESET_SESSION_STATS` | `cmd_reset_session_stats` | {} — обнулить счёт донатов текущего стрима |
| `CMD_TEST_CHAT` | `cmd_test_chat` | { message? } |
| `CMD_SEND_CHAT` | `cmd_send_chat` | { message, clientId } — send a message to Twitch chat |
| `CMD_TEST_POLL` | `cmd_test_poll` | {} — simulate chat votes |
| `CMD_SET_APP_CONFIG` | `cmd_set_app_config` | { twitchChannel? } |
| `CMD_SET_ACTIVE_THEME` | `cmd_set_active_theme` | { id, enable3d? } — select a theme and optionally toggle its 3D variant |
| `CMD_SET_ENABLED_3D` | `cmd_set_enabled_3d` | { type, enabled } — enable/disable an individual 3D widget (фишка) |
| `CMD_SAVE_CUSTOM_THEME` | `cmd_save_custom_theme` | { id?, name, seeds } |
| `CMD_DELETE_CUSTOM_THEME` | `cmd_delete_custom_theme` | { id } |
| `CMD_DUPLICATE_CUSTOM_THEME` | `cmd_duplicate_custom_theme` | { id } |
| `CMD_IMPORT_CUSTOM_THEME` | `cmd_import_custom_theme` | { name, seeds } |
| `CMD_PREVIEW_THEME_DRAFT` | `cmd_preview_theme_draft` | { tokens, customCss, themeId, name, clear? } |
| `CMD_SET_EDITOR_PREFS` | `cmd_set_editor_prefs` | { gridSize?, snapEnabled? } |
| `CMD_SET_SCENE_CONFIG` | `cmd_set_scene_config` | { sceneId, patch } |
| `CMD_SET_SPLASH_CONFIG` | `cmd_set_splash_config` | { config: { file } } — global fallback splash media |
| `CMD_RESET_TOP_DONATION` | `cmd_reset_top_donation` |  |
| `CMD_START_GIVEAWAY` | `cmd_start_giveaway` | { command } |
| `CMD_STOP_GIVEAWAY` | `cmd_stop_giveaway` |  |
| `CMD_SHUFFLE_GIVEAWAY` | `cmd_shuffle_giveaway` |  |
| `CMD_SET_GIVEAWAY_ELIMINATION` | `cmd_set_giveaway_elimination` | { enabled } |
| `CMD_GENERATE_WHEEL` | `cmd_generate_wheel` |  |
| `CMD_SPIN_WHEEL` | `cmd_spin_wheel` |  |
| `CMD_SET_GIVEAWAY_WINNER` | `cmd_set_giveaway_winner` | { username } |
| `CMD_ADD_GIVEAWAY_PARTICIPANT` | `cmd_add_giveaway_participant` | { username } |
| `CMD_REMOVE_GIVEAWAY_PARTICIPANT` | `cmd_remove_giveaway_participant` | { username } |
| `CMD_CLEAR_GIVEAWAY_PARTICIPANTS` | `cmd_clear_giveaway_participants` |  |
| `CMD_SET_WHEEL_CONFIG` | `cmd_set_wheel_config` | { config } |
| `CMD_SET_WHEEL_SPEED_CONFIG` | `cmd_set_wheel_speed_config` | { config } |
| `CMD_START_POLL` | `cmd_start_poll` | { command } |
| `CMD_STOP_POLL` | `cmd_stop_poll` |  |
| `CMD_RESET_POLL` | `cmd_reset_poll` |  |
| `CMD_SET_POLL_CONFIG` | `cmd_set_poll_config` | { config } |
| `CMD_ADD_POLL_OPTION` | `cmd_add_poll_option` | { label } |
| `CMD_REMOVE_POLL_OPTION` | `cmd_remove_poll_option` | { id } |
| `CMD_CLEAR_POLL_OPTIONS` | `cmd_clear_poll_options` |  |
| `CMD_SAVE_POLL_PRESET` | `cmd_save_poll_preset` | { id?, name } |
| `CMD_APPLY_POLL_PRESET` | `cmd_apply_poll_preset` | { id } |
| `CMD_DELETE_POLL_PRESET` | `cmd_delete_poll_preset` | { id } |
| `CMD_SET_MIC_CONFIG` | `cmd_set_mic_config` | { config } |
| `CMD_SET_CAMERA_CONFIG` | `cmd_set_camera_config` | { config } |
| `CMD_CAMERA_DECODE_FAILED` | `cmd_camera_decode_failed` | { reason } — overlay -> server -> control |
| `CMD_REFRESH_LONGSHOT` | `cmd_refresh_longshot` | {} — fetch the Longshot timers config now |
| `CMD_SET_LANGUAGE` | `cmd_set_language` | { lang } |
| `CMD_SET_YOUTUBE_VIDEO_ID` | `cmd_set_youtube_video_id` | { videoId } |
| `CMD_SET_INTEGRATION_ENABLED` | `cmd_set_integration_enabled` | { service, enabled } |
| `CMD_RESTART_INTEGRATION` | `cmd_restart_integration` | { service } — переподключить сервис, не трогая настройки |
| `CMD_SET_NOTIFICATION_SOUND` | `cmd_set_notification_sound` | { enabled } |
| `CMD_SET_NOTIFICATION_VOLUME` | `cmd_set_notification_volume` | { volume: 0..1 } |
| `CMD_SET_NOTIFICATION_REPEATS` | `cmd_set_notification_repeats` | { repeats } |
| `CMD_SET_OBS_CONFIG` | `cmd_set_obs_config` | { host?, port?, password?, clearPassword?, sceneMap? } |
| `CMD_SET_SOUNDBOARD_CONFIG` | `cmd_set_soundboard_config` |  |
| `CMD_SET_DONATION_MEDIA_CONFIG` | `cmd_set_donation_media_config` | { config: { enabled?, volume?, rules? } } |
| `CMD_TEST_DONATION_MEDIA` | `cmd_test_donation_media` | { ruleId } // { config } |
| `CMD_TEST_MUSIC` | `cmd_test_music` | { url } — проиграть ссылку из инспектора виджета музыки |
| `CMD_MUSIC_CONTROL` | `cmd_music_control` | { action: "skip" \| "stop" } |
| `CMD_SET_CHAT_BOT_CONFIG` | `cmd_set_chat_bot_config` | { config } |
| `CMD_SET_TTS_CONFIG` | `cmd_set_tts_config` | { config: { enabled?, volume?, rate?, lang? } } |
| `CMD_SET_DONATION_VOICE` | `cmd_set_donation_voice` | { config: { donationAlerts?, volume? } } |
| `CMD_TEST_SOUNDBOARD` | `cmd_test_soundboard` | { soundId } |
| `CMD_SET_STREAMDECK_CONFIG` | `cmd_set_streamdeck_config` |  |
| `CMD_GUEST_INVITE` | `cmd_guest_invite` | { slot, name? } |
| `CMD_GUEST_ACCEPT` | `cmd_guest_accept` | { slot } |
| `CMD_GUEST_DECLINE` | `cmd_guest_decline` | { slot } |
| `CMD_GUEST_REVOKE` | `cmd_guest_revoke` | { slot } |
| `CMD_GUEST_JOIN` | `cmd_guest_join` | { host, port, slot, token, name? } |
| `CMD_GUEST_LEAVE` | `cmd_guest_leave` | {} |
| `CMD_GUEST_SUBSCRIBE` | `cmd_guest_subscribe` | { slot } — какой виджет принимает поток // { config } |
| `CMD_GUEST_UNSUBSCRIBE` | `cmd_guest_unsubscribe` | { slot } — виджет отпустил только этот слот |
| `CMD_RUN_OBS_COMMAND` | `cmd_run_obs_command` | { id } |
| `CMD_SETUP_OBS_SCENES` | `cmd_setup_obs_scenes` | {} — создать недостающие сцены и источники оверлея |
| `CMD_SET_CAMERA_ANGLE` | `cmd_set_camera_angle` | { angleId } |
| `CMD_TRIGGER_CAMERA_FILTER` | `cmd_trigger_camera_filter` | { filterId } |
| `EXEC_CLI_COMMAND` | `exec_cli_command` | { command } — control panel CLI console |
| `EXEC_CLI_COMPLETION` | `exec_cli_completion` | { input } — request CLI Tab completions |
<!-- API_EVENTS_END -->
