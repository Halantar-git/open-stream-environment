/*
  Пример пакетного виджета.

  Класс наследуется от OSE.BaseWidget: движок сам создаёт элемент, выставляет
  геометрию и зовёт render() при монтировании и изменении настроек.
*/
(function () {
  const OSE = window.OSE;
  if (!OSE) return;

  class HelloWidget extends OSE.BaseWidget {
    render() {
      if (!this.element) return;
      const text = String(this.config.text || "Привет, эфир!");
      const size = Number(this.config.size) || 24;
      const color = String(this.config.color || "#ffffff");
      const align = this.config.align === "left" ? "flex-start" : "center";

      this.element.style.display = "flex";
      this.element.style.alignItems = "center";
      this.element.style.justifyContent = align;
      this.element.style.fontSize = `${size}px`;
      this.element.style.color = color;
      // textContent, а не innerHTML: текст настройки не должен становиться
      // разметкой — его пишет пользователь, и случайный «<» ломал бы карточку.
      this.element.textContent = text;
    }
  }

  OSE.defineWidget("hello", HelloWidget);
})();
