# Open Stream Environment — Stream Deck Plugin

Плагин для Elgato Stream Deck, который переключает сцены OSE через локальный
WebSocket-шин (`ws://localhost:8710/ws`).

## Возможности

- **Сцены** — одна кнопка на сцену: Start, BRB, Wheel (Колесо), Talk (Разговор)
  и End (окончание стрима). Команда пробрасывается в OBS WebSocket v5
  (`SetCurrentProgramScene`). Активная сцена подсвечивается на кнопке
  (2 состояния).

## Требования

- Node.js 18+.
- Зависимость `ws` (`npm install` в этой папке). Так как Stream Deck запускает
  плагин как Node-процесс, `ws` должен быть доступен во время выполнения —
  либо соберите плагин бандлером (`esbuild`/`rollup`) в один файл, либо
  положите `node_modules` рядом с `app.js`.

## Структура

```
streamdeck-plugin/
  manifest.json      # описание плагина и экшенов
  app.js             # точка входа: мост Stream Deck <-> OSE
  package.json
  pi/settings.html   # Property Inspector (выбор сцены для кнопки)
  assets/            # PNG-иконки (создайте сами, см. ниже)
```

## Иконки

В `manifest.json` используются пути `assets/*`. Перед сборкой создайте PNG-файлы:

| Файл | Размер |
|---|---|
| `assets/plugin.png` (иконка плагина) | 288×288 |
| `assets/scene.png`, `assets/scene-active.png` | 72×72 (или 144×144 @2x) |

Пути в манифесте указываются без расширения `.png`.

Иконки из `assets/` — базовые. Пользователь может задать свою иконку для каждой
сцены через панель управления OSE («Настройки → Stream Deck»): плагин получает
пути из `state.streamdeck.icons` (`start`, `brb`, `wheel`, `talk`, `end`),
скачивает файлы с `http://localhost:8710/media/...` и применяет их через
`setImage` поверх стандартных иконок.

## Установка / разработка

1. Запустите OSE (`npm start`), чтобы локальный шин слушал `8710`.
2. Установите плагин в Stream Deck (SDK-режим разработки или упакованный
   `.streamDeckPlugin`).
3. Добавьте экшен на кнопку, откройте Property Inspector и выберите сцену.

## Протокол OSE

Плагин отправляет команды как обычный WS-клиент:

```json
{ "type": "remote_action", "action": "SCENE_SET", "payload": { "scene": "talk" } }
```

И получает события шины `state` и `remote_action` для подсветки активной сцены.
