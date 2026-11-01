/*
  Пример пакетного виджета с настройками и подпиской на шину.

  Виджет запоминает последний донат и перерисовывается на событии ALERT.
  Настройки приходят из widget.json: заголовок, размер суммы, цвет и тумблер
  сообщения. Пока донатов не было, вместо суммы показывается подсказка.
*/
(function () {
  const OSE = window.OSE;
  if (!OSE) return;

  function makeNode(tag, className, text, styles) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    Object.keys(styles || {}).forEach((key) => {
      if (styles[key]) node.style[key] = styles[key];
    });
    return node;
  }

  class LastDonationWidget extends OSE.BaseWidget {
    onMount() {
      // Одно событие покрывает и настоящий донат, и тестовый алерт из панели —
      // так виджет удобно проверять, не дожидаясь зрителя.
      this.subscribe(OSE.EVENT_TYPES.ALERT, (alert) => {
        if (!alert || alert.kind !== "donation") return;
        this.last = alert;
        this.render();
      });
    }

    render() {
      if (!this.element) return;
      const config = this.config || {};
      const title = String(config.title || "Последний донат");
      const size = Number(config.amountSize) || 36;
      const showMessage = config.showMessage !== false;
      const accent =
        String(config.accent || "").trim() ||
        (this.context.readCssVar ? this.context.readCssVar("--md-primary") : "") ||
        "#7ee0d6";
      const formatMoney =
        this.context.formatMoney || ((value) => String(value == null ? "" : value));
      const currencySymbol = this.context.currencySymbol || ((code) => String(code || ""));

      const alert = this.last;
      const amount = alert
        ? `${formatMoney(alert.amount)} ${currencySymbol(alert.currency)}`.trim()
        : "";
      const user = alert ? String(alert.user || "") : "";
      const message = alert && showMessage ? String(alert.message || "").trim() : "";

      const root = this.element;
      root.textContent = "";
      root.appendChild(makeNode("div", "ose-last-donation__title", title));
      root.appendChild(
        makeNode("div", "ose-last-donation__amount", alert ? amount : "Ждём донат", {
          color: alert ? accent : "",
          fontSize: `${size}px`,
        })
      );
      if (user) root.appendChild(makeNode("div", "ose-last-donation__user", user));
      if (message) root.appendChild(makeNode("div", "ose-last-donation__message", message));
    }
  }

  OSE.defineWidget("last-donation", LastDonationWidget);
})();
