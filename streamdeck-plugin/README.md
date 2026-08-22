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
- `ws` как runtime-зависимость. Stream Deck запускает плагин как Node-процесс
  и **не** выполняет `npm install`, поэтому перед упаковкой нужно либо собрать
  плагин в один файл (`npm run build`), либо положить `node_modules` рядом с
  `app.js`. Рекомендуется бандл — см. «Сборка» ниже.

## Структура

```
streamdeck-plugin/
  manifest.json          # описание плагина и экшенов
  app.js                 # точка входа: мост Stream Deck <-> OSE
  package.json
  pi/settings.html       # Property Inspector (выбор сцены для кнопки)
  scripts/generate-icons.js  # генератор плейсхолдер-иконок
  assets/                # PNG-иконки (генерируются `npm run icons`)
  dist/app.js            # бандл (после `npm run build`)
```

## Иконки

В `manifest.json` используются пути `assets/*` без расширения `.png`. Базовые
плейсхолдеры генерируются командой `npm run icons`:

| Файл | Размер |
|---|---|
| `assets/plugin.png` (иконка плагина) | 288×288 |
| `assets/scene.png`, `assets/scene-active.png` | 144×144 (72×72 @2x) |

Иконки из `assets/` — базовые. Пользователь может задать свою иконку для каждой
сцены через панель управления OSE («Настройки → Stream Deck»): плагин получает
пути из `state.streamdeck.icons` (`start`, `brb`, `wheel`, `talk`, `end`),
скачивает файлы с `http://localhost:8710/media/...` и применяет их через
`setImage` поверх стандартных иконок.

Кастомная иконка применяется к обоим состояниям кнопки (обычное и активное).
Подсветка активной сцены вторым состоянием работает только со стандартными
иконками: если задана кастомная иконка, она показывается в обоих состояниях.
При очистке кастомной иконки плагин возвращает стандартные иконки из `assets/`.

## Сборка

```
cd streamdeck-plugin
npm install
npm run icons     # сгенерировать плейсхолдер-иконки (один раз)
npm run build     # собрать app.js + ws в dist/app.js
```

После сборки укажите в `manifest.json` `"CodePath": "dist/app.js"` (или
замените `app.js` бандлом), затем упакуйте плагин в `.streamDeckPlugin`.
Альтернатива без бандла — положить `node_modules` рядом с `app.js` в
упакованный плагин.

## Установка / разработка

1. Запустите OSE (`npm start`), чтобы локальный шин слушал `8710`.
2. Установите зависимости и соберите плагин (`npm install && npm run build`).
3. Установите плагин в Stream Deck (SDK-режим разработки или упакованный
   `.streamDeckPlugin`).
4. Добавьте экшен на кнопку, откройте Property Inspector и выберите сцену.

## Протокол OSE

Плагин отправляет команды как обычный WS-клиент:

```json
{ "type": "remote_action", "action": "SCENE_SET", "payload": { "scene": "talk" } }
```

И получает события шины `state` и `remote_action` для подсветки активной сцены.
