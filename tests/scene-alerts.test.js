/*
 * Copyright (C) 2026  Halantar
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://gnu.org>.
 */

/*
  Виджет алертов на сценах: включение, геометрия и перекладывание событий
  в шину виджета. Здесь подменён только сам `AlertsWidget` — модуль сцены
  проверяется целиком.
*/

const MODULE_PATH = require.resolve("../overlay/scene-alerts");

function makeEl() {
  return {
    className: "",
    isConnected: true,
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}

class FakeAlertsWidget {
  constructor(config, context) {
    this.config = config;
    this.context = context;
    this.geometry = { x: config.x, y: config.y, w: config.w, h: config.h };
    this.received = [];
    context.bus.on(context.EVENT_TYPES.ALERT, (alert) => this.received.push(alert));
    FakeAlertsWidget.instances.push(this);
  }

  mount(parent) {
    this.parent = parent;
    this.mounted = true;
  }

  unmount() {
    this.unmounted = true;
    this.mounted = false;
  }

  update(next) {
    this.updated = next;
    this.geometry = { x: next.x, y: next.y, w: next.w, h: next.h };
  }
}
FakeAlertsWidget.instances = [];

// Второй виджет — UEC-перевод: тот же контракт BaseWidget, но своё поведение.
class FakeUecWidget {
  constructor(config, context) {
    this.config = config;
    this.context = context;
    this.geometry = { x: config.x, y: config.y, w: config.w, h: config.h };
    this.received = [];
    context.bus.on(context.EVENT_TYPES.ALERT, (alert) => this.received.push(alert));
    FakeUecWidget.instances.push(this);
  }

  mount(parent) {
    this.parent = parent;
    this.mounted = true;
  }

  unmount() {
    this.unmounted = true;
    this.mounted = false;
  }

  update(next) {
    this.updated = next;
    this.geometry = { x: next.x, y: next.y, w: next.w, h: next.h };
  }
}
FakeUecWidget.instances = [];

let originalWindow;
let originalDocument;
let originalComputed;
let wrapper;

beforeEach(() => {
  originalWindow = global.window;
  originalDocument = global.document;
  originalComputed = global.getComputedStyle;
  global.getComputedStyle = () => ({ getPropertyValue: () => "" });

  wrapper = makeEl();
  global.document = {
    createElement: () => makeEl(),
    querySelector: (selector) => (selector === ".scene-wrapper" ? wrapper : null),
  };
  global.window = {
    SharedEvents: { EVENT_TYPES: { ALERT: "alert" } },
    OSEWidgets: { AlertsWidget: FakeAlertsWidget, WidgetUecTransfer: FakeUecWidget },
    I18n: { t: (key) => key, getLang: () => "ru" },
    SharedIcons: { ICONS: {} },
  };
  FakeAlertsWidget.instances = [];
  FakeUecWidget.instances = [];
  jest.resetModules();
  require(MODULE_PATH);
});

afterEach(() => {
  global.window = originalWindow;
  global.document = originalDocument;
  global.getComputedStyle = originalComputed;
  jest.resetModules();
});

describe("SceneAlerts", () => {
  test("выключенные алерты не создают виджет", () => {
    window.SceneAlerts.init();
    window.SceneAlerts.applyScene({ alerts: { enabled: false, x: 10 } });
    expect(FakeAlertsWidget.instances).toHaveLength(0);
    // Событие без виджета не должно падать.
    expect(() => window.SceneAlerts.handleAlert({ kind: "donation" })).not.toThrow();
  });

  test("включённые алерты монтируются с геометрией сцены", () => {
    window.SceneAlerts.init();
    window.SceneAlerts.applyScene({ alerts: { enabled: true, x: 10, y: 20, w: 30, h: 40 } });

    expect(FakeAlertsWidget.instances).toHaveLength(1);
    const widget = FakeAlertsWidget.instances[0];
    expect(widget.mounted).toBe(true);
    expect(widget.parent).toBe(wrapper.children[0]);
    expect(widget.geometry).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  test("алерт уходит в шину смонтированного виджета", () => {
    window.SceneAlerts.init();
    window.SceneAlerts.applyScene({ alerts: { enabled: true, x: 10, y: 20, w: 30, h: 40 } });
    window.SceneAlerts.handleAlert({ kind: "donation", user: "bob" });

    expect(FakeAlertsWidget.instances[0].received).toEqual([{ kind: "donation", user: "bob" }]);
  });

  test("виджет UEC выбирается настройкой сцены", () => {
    window.SceneAlerts.init();
    window.SceneAlerts.applyScene({ alerts: { enabled: true, widget: "uec", x: 10, y: 20, w: 30, h: 40 } });

    expect(FakeUecWidget.instances).toHaveLength(1);
    expect(FakeAlertsWidget.instances).toHaveLength(0);

    window.SceneAlerts.handleAlert({ kind: "donation", user: "bob" });
    expect(FakeUecWidget.instances[0].received).toEqual([{ kind: "donation", user: "bob" }]);
  });

  test("смена вида алерта пересоздаёт виджет", () => {
    window.SceneAlerts.init();
    window.SceneAlerts.applyScene({ alerts: { enabled: true, widget: "card", x: 10, y: 20, w: 30, h: 40 } });
    expect(FakeAlertsWidget.instances).toHaveLength(1);

    window.SceneAlerts.applyScene({ alerts: { enabled: true, widget: "uec", x: 10, y: 20, w: 30, h: 40 } });
    expect(FakeAlertsWidget.instances[0].unmounted).toBe(true);
    expect(FakeUecWidget.instances).toHaveLength(1);
  });

  test("смена геометрии обновляет виджет, выключение — снимает", () => {
    window.SceneAlerts.init();
    window.SceneAlerts.applyScene({ alerts: { enabled: true, x: 10, y: 20, w: 30, h: 40 } });
    window.SceneAlerts.applyScene({ alerts: { enabled: true, x: 12, y: 22, w: 30, h: 40 } });

    expect(FakeAlertsWidget.instances).toHaveLength(1);
    expect(FakeAlertsWidget.instances[0].updated).toEqual({
      x: 12,
      y: 22,
      w: 30,
      h: 40,
      config: {},
    });

    window.SceneAlerts.applyScene({ alerts: { enabled: false } });
    expect(FakeAlertsWidget.instances[0].unmounted).toBe(true);
  });
});
