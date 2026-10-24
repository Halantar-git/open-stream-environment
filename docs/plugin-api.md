# API пакетов: виджеты и темы

Пакет — каталог в данных пользователя, из которого OSE сам подхватывает
виджет или тему. Ничего не нужно пересобирать и никуда встраивать.

Общее описание локального HTTP-сервера, шины WebSocket и действий пульта — в
[`api.md`](api.md). Здесь — только формат пакетов и API виджета.

```
%APPDATA%/com.openstreamenvironment.app/plugins/<id>/
```

В разработке (`npm run tauri:dev`) данные лежат в `config/`, поэтому пакеты
кладутся в `config/plugins/<id>/`. После установки или правки манифеста
приложение нужно перезапустить: каталог и список тем читаются один раз при
старте.

## Виджет

`widget.json`:

```json
{
  "apiVersion": 1,
  "kind": "widget",
  "id": "hello",
  "name": "Привет",
  "description": "Карточка с текстом",
  "version": "1.0.0",
  "author": "Ваше имя",
  "entry": "widget.js",
  "styles": ["widget.css"],
  "icon": "widgetCustom",
  "defaultGeometry": { "x": 40, "y": 40, "w": 20, "h": 10 },
  "minW": 8,
  "minH": 4,
  "settings": {
    "text": { "type": "string", "label": "Текст", "default": "Привет" },
    "size": { "type": "range", "label": "Размер", "min": 8, "max": 72, "step": 1, "default": 24 },
    "color": { "type": "color", "label": "Цвет", "default": "#ffffff" },
    "align": {
      "type": "select",
      "label": "Выравнивание",
      "default": "center",
      "options": [
        { "value": "left", "label": "Слева" },
        { "value": "center", "label": "По центру" }
      ]
    }
  }
}
```

Обязательные поля: `apiVersion`, `kind`, `id`, `name`, `entry`. `id`
совпадает с именем папки (латиница в нижнем регистре, цифры, `.`, `-`, `_`).

`entry` — `.js`-файл внутри пакета. `styles` — список `.css`-файлов внутри
пакета. Пути не могут выходить за каталог пакета.

`defaultGeometry` — проценты холста (0–100). `minW`/`minH` ограничивают
растягивание в редакторе. `icon` — ключ из `shared/icons.js` (например,
`widgetCustom`); неизвестный ключ заменяется на `widgetCustom`.

### Код виджета

```js
(function () {
  const OSE = window.OSE;

  class HelloWidget extends OSE.BaseWidget {
    render() {
      if (!this.element) return;
      const text = String(this.config.text || "Привет");
      const size = Number(this.config.size) || 24;
      const color = String(this.config.color || "#ffffff");
      const align = this.config.align === "left" ? "flex-start" : "center";

      this.element.style.display = "flex";
      this.element.style.alignItems = "center";
      this.element.style.justifyContent = align;
      this.element.textContent = text;
      this.element.style.fontSize = `${size}px`;
      this.element.style.color = color;
    }
  }

  OSE.defineWidget("hello", HelloWidget);
})();
```

`OSE.BaseWidget` — тот же класс, что у встроенных виджетов. Доступно:

| Что | Зачем |
|---|---|
| `this.config` | настройки из инспектора (значения по умолчанию берутся из `settings`) |
| `this.geometry` | `x`, `y`, `w`, `h`, `z`, `visible` в процентах холста |
| `this.element` | `div`, в котором рисует 2D-виджет |
| `this.onMount()` / `render()` / `onUpdate()` / `onUnmount()` | жизненный цикл |
| `this.subscribe(type, handler)` | подписка на шину событий (`OSE.EVENT_TYPES`) |
| `this.later(fn, ms)` / `this.every(fn, ms)` | таймеры, которые снимаются при удалении |
| `this.startRenderLoop(fps)` / `this.stopRenderLoop()` | анимация на canvas |
| `this.context.readCssVar(name)` | токен темы (`--md-primary` и т. д.) |
| `OSE.asset("hello", "cover.png")` | адрес ресурса пакета |
| `OSE.t("help.title")` | строка интерфейса на языке пользователя |
| `OSE.cssVar("--md-primary")` | цвет темы для canvas |

События приходят те же, что у встроенных виджетов: `chat_message`, `alert`,
`recent_event`, `goal_update`, `music_control` и остальные из
`shared/events.js`. Полный список — `OSE.EVENT_TYPES`.

Пакет исполняется в странице оверлея с полными правами. Поэтому ставить можно
только доверенный код: песочницы пока нет, это следующий этап.

## Тема

`theme.json`:

```json
{
  "apiVersion": 1,
  "kind": "theme",
  "id": "plain-theme",
  "name": "Plain",
  "version": "1.0.0",
  "author": "Ваше имя",
  "tokens": {
    "--md-primary": "#7aa2f7",
    "--md-on-primary": "#0b1020",
    "--md-secondary": "#bb9af7",
    "--md-tertiary": "#f7768e",
    "--md-surface": "#0b1020",
    "--md-on-surface": "#e6edf7",
    "--md-on-surface-variant": "#9aa7bd",
    "--md-outline": "#3b4a63"
  },
  "css": "theme.css"
}
```

Обязательное поле — `tokens`: хотя бы один токен, имя начинается с `--`,
значение — строка. Тема появляется в списке тем как `plugin:<id>` и
применяется на оверлее, сценах и заставке так же, как встроенная. Править и
удалять её из панели нельзя: источник правды — пакет.

`css` — необязательный файл. В нём пишите правила **под своим id**, иначе они
протекут в другие темы и в панель:

```css
[data-theme="plugin:plain-theme"] .widget-instance {
  border-radius: 4px;
}
```

## HTTP

| Маршрут | Что отдаёт |
|---|---|
| `GET /api/plugins` | `{ apiVersion, plugins: [...], errors: [...] }` |
| `GET /plugins/<id>/<file>` | файлы пакета |

Элемент `plugins` для виджета:

```json
{
  "kind": "widget",
  "id": "hello",
  "type": "plugin:hello",
  "name": "Привет",
  "description": "Карточка с текстом",
  "version": "1.0.0",
  "author": "Ваше имя",
  "baseUrl": "/plugins/hello/",
  "entry": "widget.js",
  "styles": ["widget.css"],
  "icon": "widgetCustom",
  "geometry": { "x": 40, "y": 40, "w": 20, "h": 10 },
  "minW": 8,
  "minH": 4,
  "settings": { "text": { "type": "string", "default": "Привет" } }
}
```

Для темы: `kind: "theme"`, `id: "plugin:<id>"`, `css`, `tokens`, `colors`.

Ошибки разбора не ломают остальные пакеты:

```json
{ "dir": "broken", "error": "JSON: expected value at line 1 column 3" }
```

## Ограничения первой версии

- Только 2D-виджеты: 3D-наборы и `threeDWidgets` у тем пока не читаются.
- Установка и удаление — вручную, папкой; zip, обновления и подписи — позже.
- Песочницы нет: пакет — обычный скрипт страницы.
- Перезапуск после установки и правки манифеста.

Готовые примеры — в `docs/examples/plugins/`.
