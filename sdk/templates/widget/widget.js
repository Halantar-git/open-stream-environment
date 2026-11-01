/*
  Виджет пакета «{{name}}».

  OSE создаёт элемент, выставляет геометрию и зовёт render() при монтировании и
  изменении настроек. Схема настроек — в widget.json, значения приходят в
  this.config. Полный набор типов — sdk/index.d.ts, события — OSE.EVENT_TYPES.
*/
(function () {
  const OSE = window.OSE;
  if (!OSE) return;

  class PluginWidget extends OSE.BaseWidget {
    render() {
      if (!this.element) return;
      const text = String(this.config.text || "Привет, эфир!");
      const size = Number(this.config.size) || 24;
      const color = String(this.config.color || "#ffffff");

      this.element.style.display = "flex";
      this.element.style.alignItems = "center";
      this.element.style.justifyContent = "center";
      this.element.style.fontSize = `${size}px`;
      this.element.style.color = color;
      // textContent, а не innerHTML: настройку пишет пользователь, и случайный
      // «<» не должен становиться разметкой.
      this.element.textContent = text;
    }

    onMount() {
      // Подписки на шину снимаются при удалении виджета сами. Пример:
      // this.subscribe(OSE.EVENT_TYPES.ALERT, (alert) => {
      //   this.element.textContent = `Последний алерт: ${alert.user}`;
      // });
    }
  }

  OSE.defineWidget("{{id}}", PluginWidget);
})();
