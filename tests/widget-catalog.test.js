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

const { WIDGET_TYPES, widgetsForTheme, themeAllowsWidget, replacedBy3d, widgetRole, resolveTypeForTheme, typeForAdd, isAnimatedWidget } = require("../shared/widget-catalog");
const { THREE_D_STYLES } = require("../shared/themes");

describe("widget-catalog helpers", () => {
  test("isAnimatedWidget отмечает только виджеты с canvas-циклом", () => {
    // Тяжёлые: собственный rAF (20–30 FPS).
    expect(isAnimatedWidget("mic")).toBe(true);
    expect(isAnimatedWidget("grimhex-radar")).toBe(true);
    expect(isAnimatedWidget("cobra-shield")).toBe(true);
    expect(isAnimatedWidget("md3-orb")).toBe(true);
    expect(isAnimatedWidget("pixel-cube")).toBe(true);
    expect(isAnimatedWidget("teso-seal")).toBe(true);
    expect(isAnimatedWidget("ticker")).toBe(true);
    expect(isAnimatedWidget("retrowave-ticker")).toBe(true);
    expect(isAnimatedWidget("sf-tachometer")).toBe(true);
    expect(isAnimatedWidget("sf-goal")).toBe(true);
    expect(isAnimatedWidget("sf-cube")).toBe(true);
    expect(isAnimatedWidget("sf-ticker")).toBe(true);
    expect(isAnimatedWidget("orbital-symbol")).toBe(true);
    expect(isAnimatedWidget("win98-cube")).toBe(true);
    expect(isAnimatedWidget("win98-ticker")).toBe(true);

    // Лёгкие: DOM-only, без цикла.
    expect(isAnimatedWidget("chat")).toBe(false);
    expect(isAnimatedWidget("goal")).toBe(false);
    expect(isAnimatedWidget("grimhex-chat")).toBe(false);
    expect(isAnimatedWidget("teso-goal")).toBe(false);
    expect(isAnimatedWidget("md3-holo-alert")).toBe(false);
    expect(isAnimatedWidget("roulette")).toBe(false);
    expect(isAnimatedWidget("win98-goal")).toBe(false);
    expect(isAnimatedWidget("win98-chat")).toBe(false);
    expect(isAnimatedWidget(undefined)).toBe(false);
  });

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

    // Таймер: 3D-вариант заменяет 2D-таймер по роли.
    expect(replacedBy3d("grimhex-timer")).toBe("timer");

    // Новостная лента: 3D-вариант заменяет 2D-ленту.
    expect(replacedBy3d("retrowave-ticker")).toBe("ticker");
    expect(replacedBy3d("nuclear-ticker")).toBe("ticker");
  });

  test("widgetsForTheme возвращает 3D-виджеты темы", () => {
    const md3 = widgetsForTheme("nebula").map((d) => d.type);
    expect(md3).toEqual(expect.arrayContaining(["md3-orb", "md3-chat", "md3-goal", "md3-holo-alert", "md3-recent", "md3-ticker"]));
    expect(md3).toHaveLength(6);

    const grimhex = widgetsForTheme("grimhex").map((d) => d.type);
    expect(grimhex).toEqual(expect.arrayContaining(["grimhex", "musain", "grimhex-chat", "grimhex-goal", "grimhex-holo-alert", "grimhex-recent", "grimhex-radar", "grimhex-ticker", "orbital-symbol"]));

    const retrowave = widgetsForTheme("retrowave").map((d) => d.type);
    expect(retrowave).toEqual(expect.arrayContaining(["retrowave-goal", "retrowave-chat", "retrowave-holo-alert", "retrowave-recent", "retrowave-symbol", "retrowave-ticker"]));

    const sf = widgetsForTheme("sf").map((d) => d.type);
    expect(sf).toEqual(expect.arrayContaining(["sf-tachometer", "sf-goal", "sf-chat", "sf-holo-alert", "sf-cube", "sf-recent", "sf-ticker"]));
    expect(sf).toHaveLength(7);

    const win98 = widgetsForTheme("win98").map((d) => d.type);
    expect(win98).toEqual(
      expect.arrayContaining([
        "win98-cube",
        "win98-goal",
        "win98-chat",
        "win98-holo-alert",
        "win98-recent",
        "win98-ticker",
      ])
    );
    expect(win98).toHaveLength(6);

    expect(widgetsForTheme("")).toEqual([]);
  });

  test("виджеты одной темы идут в каталоге подряд", () => {
    // Порядок ключей задаёт порядок карточек в колонке виджетов: тематический
    // блок не должен перемешиваться с соседними темами.
    const keys = Object.keys(WIDGET_TYPES);
    const byTheme = new Map();
    keys.forEach((key, index) => {
      const theme = WIDGET_TYPES[key].theme;
      if (!theme) return;
      if (!byTheme.has(theme)) byTheme.set(theme, []);
      byTheme.get(theme).push(index);
    });
    for (const [theme, indices] of byTheme) {
      // Внутри блока могут стоять виджеты без привязки к теме (например,
      // UEC-перевод в блоке Grim HEX), но чужая тема разрывать блок не должна.
      const foreign = keys
        .slice(indices[0], indices[indices.length - 1] + 1)
        .map((key) => WIDGET_TYPES[key].theme)
        .filter((value) => value && value !== theme);
      expect(`${theme}: ${foreign.join(",")}`).toBe(`${theme}: `);
    }
  });

  test("UEC-перевод стоит сразу после «Цель Grim HEX»", () => {
    const keys = Object.keys(WIDGET_TYPES);
    expect(keys[keys.indexOf("grimhex-goal") + 1]).toBe("uec-transfer");
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

    // Таймер: 2D-база и 3D-вариант — одна роль.
    expect(widgetRole("timer")).toBe("timer");
    expect(widgetRole("grimhex-timer")).toBe("timer");

    // Новостная лента: 2D-база и 3D-варианты — одна роль.
    expect(widgetRole("ticker")).toBe("ticker");
    expect(widgetRole("retrowave-ticker")).toBe("ticker");
    expect(widgetRole("md3-ticker")).toBe("ticker");
    expect(widgetRole("sf-tachometer")).toBe("sign");
    expect(widgetRole("sf-cube")).toBeNull();
    expect(widgetRole("sf-chat")).toBe("chat");
    expect(widgetRole("sf-goal")).toBe("goal");
    expect(widgetRole("sf-holo-alert")).toBe("alerts");
    expect(widgetRole("win98-cube")).toBeNull();
    expect(widgetRole("win98-chat")).toBe("chat");
    expect(widgetRole("win98-goal")).toBe("goal");
    expect(widgetRole("win98-holo-alert")).toBe("alerts");

    // Декоративные 3D-виджеты (основные вывески) имеют роль для кросс-темной
    // замены. Вторичные вывески (musain/elite-sign) остаются без роли — они
    // аддитивные и просто скрываются при смене темы, а не подменяются.
    expect(widgetRole("grimhex")).toBe("sign");
    expect(widgetRole("musain")).toBeNull();
    expect(widgetRole("orbital-symbol")).toBeNull();
    expect(widgetRole("nuclear")).toBe("sign");
    expect(widgetRole("cobra")).toBe("sign");
    expect(widgetRole("elite-sign")).toBeNull();
    expect(widgetRole("md3-orb")).toBe("sign");
    expect(widgetRole("pixel-cube")).toBe("sign");
    expect(widgetRole("grimhex-radar")).toBe("radar");
    expect(widgetRole("cobra-radar")).toBe("radar");
    expect(widgetRole("cobra-shield")).toBe("shield");

    // «Последние события»: 2D-база и 3D-варианты — одна роль.
    expect(widgetRole("recent")).toBe("recent");
    expect(widgetRole("retrowave-recent")).toBe("recent");
    expect(widgetRole("md3-recent")).toBe("recent");

    // Без роли: остальные 2D-виджеты.
    expect(widgetRole("custom")).toBeNull();
    expect(widgetRole("roulette")).toBeNull();
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

    // «Последние события» следуют за активной 3D-темой.
    expect(resolveTypeForTheme("recent", "nebula", {})).toBe("md3-recent");
    expect(resolveTypeForTheme("recent", "", {})).toBe("recent");

    // Декоративные вывески тоже следуют за темой.
    expect(resolveTypeForTheme("grimhex", "cobra-mk2", {})).toBe("cobra");
    expect(resolveTypeForTheme("md3-orb", "pixel", {})).toBe("pixel-cube");
    expect(resolveTypeForTheme("grimhex-radar", "cobra-mk2", {})).toBe("cobra-radar");
    // Нет аналога в активной теме — остаётся исходный тип (будет скрыт).
    expect(resolveTypeForTheme("cobra-shield", "grimhex", {})).toBe("cobra-shield");

    // 2D-таймер подменяется Grim HEX-вариантом при активной 3D-теме.
    expect(resolveTypeForTheme("timer", "grimhex", {})).toBe("grimhex-timer");
    expect(resolveTypeForTheme("timer", "", {})).toBe("timer");

    // Новостная лента так же следит за активной 3D-темой.
    expect(resolveTypeForTheme("ticker", "retrowave", {})).toBe("retrowave-ticker");
    expect(resolveTypeForTheme("ticker", "", {})).toBe("ticker");
  });

  test("resolveTypeForTheme с явным набором 3D-виджетов (своя тема)", () => {
    // Уникальный аналог роли — подмена работает.
    expect(resolveTypeForTheme("chat", ["teso-chat", "cobra-radar"])).toBe("teso-chat");
    expect(resolveTypeForTheme("goal", ["teso-goal"])).toBe("teso-goal");
    expect(resolveTypeForTheme("md3-chat", ["cobra-chat"])).toBe("cobra-chat");

    // Несколько кандидатов одной роли — неоднозначно, тип не меняется.
    expect(resolveTypeForTheme("chat", ["teso-chat", "cobra-chat"])).toBe("chat");
    expect(resolveTypeForTheme("md3-chat", ["teso-chat", "cobra-chat"])).toBe("md3-chat");

    // Пустой набор — без изменений; виджеты без роли не трогаем.
    expect(resolveTypeForTheme("chat", [])).toBe("chat");
    expect(resolveTypeForTheme("recent", ["teso-chat"])).toBe("recent");
  });

  test("все 3D-виджеты имеют привязку theme и dimension 3d", () => {
    Object.values(WIDGET_TYPES).forEach((d) => {
      if (d.dimension === "3d") {
        expect(d.theme).toBeTruthy();
      }
    });
  });

  test("themeAllowsWidget: 2D-таймер доступен в Orbital и своих темах", () => {
    const timer = WIDGET_TYPES.timer;
    const themes = [
      { id: "nebula", builtin: true },
      { id: "orbital", builtin: true },
      { id: "pixel", builtin: true },
      { id: "custom-1", builtin: false },
    ];

    expect(themeAllowsWidget(timer, { activeThemeId: "orbital", themes })).toBe(true);
    expect(themeAllowsWidget(timer, { activeThemeId: "custom-1", themes })).toBe(true);
    expect(themeAllowsWidget(timer, { activeThemeId: "nebula", themes })).toBe(false);
    expect(themeAllowsWidget(timer, { activeThemeId: "pixel", themes })).toBe(false);
    // Своя тема не подтверждена списком — считаем встроенной.
    expect(themeAllowsWidget(timer, { activeThemeId: "custom-1" })).toBe(false);

    // Виджеты без привязки доступны в любой теме.
    expect(themeAllowsWidget(WIDGET_TYPES.chat, { activeThemeId: "nebula", themes })).toBe(true);
    expect(themeAllowsWidget(WIDGET_TYPES.chat, null)).toBe(true);
    expect(themeAllowsWidget(null, { activeThemeId: "orbital", themes })).toBe(true);
  });

  test("typeForAdd не добавляет 2D-виджет, который сразу скроется 3D-двойником", () => {
    const layout = [{ type: "webcam" }, { type: "grimhex-chat" }];

    // Явный 3D-чат в раскладке: добавляем 3D-вариант, иначе виджет будет скрыт.
    expect(typeForAdd("chat", layout, ["grimhex-chat"])).toBe("grimhex-chat");
    expect(typeForAdd("goal", layout, ["grimhex-chat"])).toBe("goal");

    // Без явного двойника тип остаётся прежним.
    expect(typeForAdd("chat", [{ type: "webcam" }], ["grimhex-chat"])).toBe("chat");

    // 3D-виджет добавляется как есть, даже если рядом стоит его 2D-роль.
    expect(typeForAdd("grimhex-chat", [{ type: "chat" }], ["grimhex-chat"])).toBe("grimhex-chat");

    // Несколько кандидатов на роль — подменять нечем.
    expect(typeForAdd("chat", layout, ["grimhex-chat", "teso-chat"])).toBe("chat");

    // Нет роли или нет каталога — тот же тип.
    expect(typeForAdd("webcam", layout, ["grimhex-chat"])).toBe("webcam");
    expect(typeForAdd(undefined, layout, [])).toBeUndefined();
  });

  test("THREE_D_STYLES покрывает ровно все 3D-наборы виджетов", () => {
    const widgetThemes = new Set(
      Object.values(WIDGET_TYPES)
        .filter((d) => d.dimension === "3d")
        .map((d) => d.theme)
    );
    expect(new Set(THREE_D_STYLES.map((s) => s.id))).toEqual(widgetThemes);

    THREE_D_STYLES.forEach((s) => {
      expect(widgetsForTheme(s.id).length).toBeGreaterThan(0);
    });
  });
});
