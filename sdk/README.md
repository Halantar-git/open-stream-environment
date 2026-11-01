# SDK пакетов OSE

Набор для разработки виджетов и тем, которые OSE подхватывает из папки — без
пересборки приложения и без публикации в реестре.

Что внутри:

| Файл | Зачем |
|---|---|
| `create.mjs` | создаёт рабочий пакет виджета или темы |
| `validate.mjs` | проверяет пакет по тем же правилам, что `src-tauri/src/plugins.rs` |
| `index.d.ts` | типы `window.OSE`, `BaseWidget`, событий и манифестов |
| `schema/` | JSON-схемы `widget.json` и `theme.json` для редактора |
| `templates/` | то, из чего `create.mjs` собирает пакет |

Подробный формат пакета и таблица API — в
[`docs/plugin-api.md`](../docs/plugin-api.md). Здесь — как этим пользоваться.

## Быстрый старт

Нужен Node 22 (он уже нужен для `npm test`).

```sh
# виджет ./hello — рядом с репозиторием или прямо в dev-каталоге пакетов
node sdk/create.mjs hello
node sdk/create.mjs hello --dir config/plugins

# тема
node sdk/create.mjs plain --theme --name "Plain"

# проверить готовый пакет или весь каталог
node sdk/validate.mjs hello
node sdk/validate.mjs config/plugins
```

Пакет сразу рабочий: скопируйте папку в каталог пакетов, перезапустите OSE и
добавьте карточку из библиотеки.

- разработка (`npm run tauri:dev`) — `config/plugins/<id>/`;
- установленное приложение — каталог данных `com.openstreamenvironment.app`
  (Windows: `%APPDATA%\com.openstreamenvironment.app\plugins\`).

Манифесты читаются при старте, поэтому после правки `widget.json`/`theme.json`
приложение нужно перезапустить. Код и CSS сервер отдаёт с диска — здесь хватает
обновить источник в OBS или переоткрыть превью.

## Виджет

```
hello/
  widget.json   — манифест: id, настройки, геометрия по умолчанию
  widget.js     — класс виджета, регистрируется через OSE.defineWidget
  widget.css    — стили, ограниченные data-type="plugin:hello"
  README.md
```

```js
(function () {
  const OSE = window.OSE;
  if (!OSE) return;

  class HelloWidget extends OSE.BaseWidget {
    render() {
      if (!this.element) return;
      this.element.textContent = String(this.config.text || "Привет");
    }
  }

  OSE.defineWidget("hello", HelloWidget);
})();
```

`OSE.BaseWidget` даёт:

| Что | Зачем |
|---|---|
| `this.config` | значения настроек из инспектора (умолчания — из `settings`) |
| `this.geometry` | `x`, `y`, `w`, `h`, `z`, `visible` в процентах холста |
| `this.element` | `div` (`canvas` у `renderType: "canvas"`), в котором рисует виджет |
| `this.canvas`, `this.ctx`, `this.gl` | холст и контексты, если они нужны |
| `onMount()` / `render()` / `onUpdate(prev, next)` / `onUnmount()` | жизненный цикл |
| `this.subscribe(type, handler)` | подписка на шину; снимается при удалении |
| `this.later(fn, ms)` / `this.every(fn, ms)` | таймеры, которые снимаются при удалении |
| `this.on(target, type, fn)` | DOM-слушатель, который снимается при удалении |
| `this.startRenderLoop(fps)` / `this.stopRenderLoop()` | анимация на canvas |
| `this.context.readCssVar(name)` | токен темы (`--md-primary` и т. п.) |
| `this.context.t(key)`, `this.context.escapeHtml(text)` | локализация и экранирование |

Плюс у `window.OSE`: `asset(id, файл)` — адрес файла пакета, `cssVar(name)` —
цвет темы для canvas, `t(key)`, `EVENT_TYPES`, `onWidget(listener)`, `load()`.

### Настройки

Инспектор рисует поля сам по схеме `settings` — вручную ничего верстать не
нужно. Типы: `string`, `text`, `number`, `range`, `color`, `boolean`, `select`.
У `select` значение по умолчанию должно быть из `options`; иначе приложение
молча возьмёт первый вариант, а `validate.mjs` об этом предупредит.

```json
"settings": {
  "title": { "type": "string", "label": "Заголовок", "default": "Эфир" },
  "size": { "type": "range", "label": "Размер", "min": 8, "max": 72, "step": 1, "default": 24 },
  "mode": {
    "type": "select",
    "label": "Режим",
    "default": "short",
    "options": [
      { "value": "short", "label": "Коротко" },
      { "value": "full", "label": "Подробно" }
    ]
  }
}
```

### События

Подписка идёт по имени из `OSE.EVENT_TYPES` — это те же кадры, что летят в
оверлей:

```js
this.subscribe(OSE.EVENT_TYPES.ALERT, (alert) => {
  this.element.textContent = `${alert.kind}: ${alert.user}`;
});
```

Самые нужные: `ALERT`, `CHAT_MESSAGE`, `RECENT_EVENT`, `GOAL_UPDATE`,
`STAT_UPDATE`, `SESSION_STATS`, `THEME_UPDATE`. Полный список и нагрузка —
`shared/events.js` и `docs/api.md`; типы ключевых событий — в `index.d.ts`.

## Тема

```
plain/
  theme.json   — манифест и токены
  theme.css    — необязательные правила под [data-theme="plugin:plain"]
  README.md
```

Тема появляется в «Настройки → Оформление» как `plugin:<id>` и применяется на
оверлее, сценах и заставке. Править её из панели нельзя — источник правды в
пакете. CSS пишите под своим `data-theme`, иначе правила протекут в другие
темы и в панель управления.

Шрифт попадает в эфир — только свободная лицензия, разрешающая коммерческое
использование (SIL OFL и подобные), текст лицензии рядом с файлом.

## Типы

`index.d.ts` — обычный TypeScript-файл глобальных деклараций, компилировать
ничего не нужно. Добавьте в начало своего JS:

```js
/// <reference path="../sdk/index.d.ts" />
// @ts-check
```

Редактор начнёт подсказывать `this.config`, события и хуки. Если пакет лежит
вне репозитория, скопируйте `sdk/index.d.ts` к себе или укажите путь до него.

Манифесты типизированы отдельно: `Ose.WidgetManifest`, `Ose.ThemeManifest`.
Для проверки в редакторе добавьте в `widget.json` ссылку на схему:

```json
"$schema": "../../sdk/schema/widget.schema.json"
```

(путь считайте от расположения пакета; приложение поле `$schema` игнорирует.)

## Проверка

`validate.mjs` повторяет правила загрузчика: id совпадает с папкой, `entry` и
`styles` существуют и лежат внутри пакета, настройки известных типов, у темы
есть токены с `--`. Предупреждения не мешают установке — приложение такой
пакет примет, но обычно это опечатка.

```sh
node sdk/validate.mjs <папка>        # один пакет
node sdk/validate.mjs config/plugins # все пакеты каталога
node sdk/validate.mjs <папка> --json # для скриптов и CI
```

Код возврата 1 — есть ошибки.

## Ограничения

- Пакет исполняется в странице оверлея с полными правами: ставить можно только
  доверенный код, песочницы пока нет.
- Только 2D-виджеты; 3D-наборы и `threeDWidgets` у тем ещё не читаются.
- Установка — папкой; zip, обновления и подписи — следующий этап.
