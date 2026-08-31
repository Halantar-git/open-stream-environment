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

const { WIDGET_TYPES, widgetsForTheme, replacedBy3d, widgetRole, resolveTypeForTheme } = require("../shared/widget-catalog");

describe("widget-catalog helpers", () => {
  test("replacedBy3d маппит 3D-виджеты на их 2D-аналоги", () => {
    expect(replacedBy3d("md3-chat")).toBe("chat");
    expect(replacedBy3d("grimhex-goal")).toBe("goal");
    expect(replacedBy3d("nuclear-holo-alert")).toBe("alerts");
    expect(replacedBy3d("cobra-chat")).toBe("chat");

    // Sign/radar/shield виджеты ничего не заменяют.
    expect(replacedBy3d("md3-orb")).toBeNull();
    expect(replacedBy3d("cobra-radar")).toBeNull();
    expect(replacedBy3d("cobra-shield")).toBeNull();
    expect(replacedBy3d("chat")).toBeNull(); // 2D-виджет не заменяет
  });

  test("widgetsForTheme возвращает 3D-виджеты темы", () => {
    const md3 = widgetsForTheme("nebula").map((d) => d.type);
    expect(md3).toEqual(expect.arrayContaining(["md3-orb", "md3-chat", "md3-goal", "md3-holo-alert"]));
    expect(md3).toHaveLength(4);

    const grimhex = widgetsForTheme("grimhex").map((d) => d.type);
    expect(grimhex).toEqual(expect.arrayContaining(["grimhex", "musain", "grimhex-chat", "grimhex-goal", "grimhex-holo-alert", "grimhex-radar"]));

    expect(widgetsForTheme("")).toEqual([]);
  });

  test("widgetRole сводит 2D-базу и её 3D-варианты к одной роли", () => {
    // 2D-база и все 3D-варианты — одна роль.
    expect(widgetRole("chat")).toBe("chat");
    expect(widgetRole("md3-chat")).toBe("chat");
    expect(widgetRole("grimhex-chat")).toBe("chat");
    expect(widgetRole("nuclear-chat")).toBe("chat");
    expect(widgetRole("cobra-chat")).toBe("chat");
    expect(widgetRole("pixel-chat")).toBe("chat");

    expect(widgetRole("goal")).toBe("goal");
    expect(widgetRole("md3-goal")).toBe("goal");
    expect(widgetRole("grimhex-holo-alert")).toBe("alerts");
    expect(widgetRole("alerts")).toBe("alerts");

    // Декоративные 3D-виджеты (основные вывески) имеют роль для кросс-темной
    // замены. Вторичные вывески (musain/elite-sign) остаются без роли — они
    // аддитивные и просто скрываются при смене темы, а не подменяются.
    expect(widgetRole("grimhex")).toBe("sign");
    expect(widgetRole("musain")).toBeNull();
    expect(widgetRole("nuclear")).toBe("sign");
    expect(widgetRole("cobra")).toBe("sign");
    expect(widgetRole("elite-sign")).toBeNull();
    expect(widgetRole("md3-orb")).toBe("sign");
    expect(widgetRole("pixel-cube")).toBe("sign");
    expect(widgetRole("grimhex-radar")).toBe("radar");
    expect(widgetRole("cobra-radar")).toBe("radar");
    expect(widgetRole("cobra-shield")).toBe("shield");

    // Без роли: остальные 2D-виджеты.
    expect(widgetRole("recent")).toBeNull();
    expect(widgetRole("custom")).toBeNull();
    expect(widgetRole(null)).toBeNull();
  });

  test("resolveTypeForTheme подменяет роль на аналог активной 3D-темы", () => {
    // 3D включён: 2D-роль и чужая 3D-вариант — обе сводятся к аналогу темы.
    expect(resolveTypeForTheme("chat", "nebula", {})).toBe("md3-chat");
    expect(resolveTypeForTheme("md3-chat", "grimhex", {})).toBe("grimhex-chat");
    expect(resolveTypeForTheme("alerts", "pixel", {})).toBe("pixel-holo-alert");
    expect(resolveTypeForTheme("goal", "cobra-mk2", {})).toBe("cobra-goal");

    // 3D выключен / нет аналога / аналог отключён — остаётся исходный тип.
    expect(resolveTypeForTheme("chat", "", {})).toBe("chat");
    expect(resolveTypeForTheme("md3-chat", "", {})).toBe("md3-chat");
    expect(resolveTypeForTheme("chat", "nebula", { "md3-chat": false })).toBe("chat");

    // Без роли — не меняется.
    expect(resolveTypeForTheme("md3-orb", "nebula", {})).toBe("md3-orb");
    expect(resolveTypeForTheme("recent", "nebula", {})).toBe("recent");

    // Декоративные вывески тоже следуют за темой.
    expect(resolveTypeForTheme("grimhex", "cobra-mk2", {})).toBe("cobra");
    expect(resolveTypeForTheme("md3-orb", "pixel", {})).toBe("pixel-cube");
    expect(resolveTypeForTheme("grimhex-radar", "cobra-mk2", {})).toBe("cobra-radar");
    // Нет аналога в активной теме — остаётся исходный тип (будет скрыт).
    expect(resolveTypeForTheme("cobra-shield", "grimhex", {})).toBe("cobra-shield");
  });

  test("все 3D-виджеты имеют привязку theme и dimension 3d", () => {
    Object.values(WIDGET_TYPES).forEach((d) => {
      if (d.dimension === "3d") {
        expect(d.theme).toBeTruthy();
      }
    });
  });
});
