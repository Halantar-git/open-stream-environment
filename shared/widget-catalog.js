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
  Catalog of widget types that can be placed on the overlay canvas.
  Geometry is in percent of a 1920x1080 canvas (0-100), so layout is
  resolution-independent between the editor preview and the real OBS
  Browser Source. Shared between server/state.js (defaults on add) and
  control/control.js (library rail + resize clamping).
*/
(function (root) {
  const WIDGET_TYPES = {
    alerts: {
      type: "alerts",
      label: "Алерты",
      description: "Всплывающие карточки: фоллоу, сабы, донаты",
      icon: "widgetAlerts",
      services: ["twitchEvents", "donationAlerts", "youtube"],
      defaultGeometry: { x: 30, y: 4, w: 40, h: 20 },
      minW: 20,
      minH: 12,
      defaultConfig: {},
    },
    goal: {
      type: "goal",
      label: "Цель доната",
      description: "Прогресс-бар сбора",
      icon: "widgetGoal",
      services: ["donationAlerts", "youtube"],
      defaultGeometry: { x: 3, y: 84, w: 32, h: 6 },
      minW: 16,
      minH: 4,
      defaultConfig: { showPercentage: false },
    },
    chat: {
      type: "chat",
      label: "Чат Twitch",
      description: "Лента сообщений чата канала",
      icon: "widgetChat",
      services: ["twitchChat", "youtube"],
      defaultGeometry: { x: 68, y: 6, w: 29, h: 46 },
      minW: 16,
      minH: 16,
      defaultConfig: { maxMessages: 8, showBadges: true },
    },
    recent: {
      type: "recent",
      label: "Последние события",
      description: "Список последних фоллоу / сабов / донатов",
      icon: "widgetRecent",
      services: ["twitchEvents", "donationAlerts", "youtube"],
      defaultGeometry: { x: 3, y: 4, w: 24, h: 26 },
      minW: 14,
      minH: 12,
      defaultConfig: { maxItems: 5 },
    },
    custom: {
      type: "custom",
      label: "Свой виджет",
      description: "Текст, картинка, свой HTML или встраивание",
      icon: "widgetCustom",
      defaultGeometry: { x: 35, y: 40, w: 30, h: 16 },
      minW: 8,
      minH: 6,
      defaultConfig: {
        mode: "text",
        showBackground: true,
        textTitle: "",
        text: "Новый текст",
        textAlign: "center",
        textSize: "medium",
        imageUrl: "",
        imageFit: "contain",
        html: "",
        css: "",
        js: "",
        embedUrl: "",
      },
    },
    stat: {
      type: "stat",
      label: "Счётчик",
      description: "Фолловеры, подписчики или топ донат — плашкой",
      icon: "widgetStat",
      services: ["twitchEvents", "donationAlerts", "youtube"],
      defaultGeometry: { x: 3, y: 4, w: 18, h: 8 },
      minW: 10,
      minH: 5,
      defaultConfig: { metric: "followers", label: "" },
    },
    social: {
      type: "social",
      label: "Соц. баннер",
      description: "По очереди показывает ваши соцсети",
      icon: "widgetSocial",
      defaultGeometry: { x: 3, y: 90, w: 20, h: 7 },
      minW: 12,
      minH: 5,
      defaultConfig: {
        rotateIntervalSec: 8,
        socials: [
          { platform: "TG", text: "t.me/your_channel" },
          { platform: "DC", text: "discord.gg/your_server" },
          { platform: "YT", text: "youtube.com/@channel" },
        ],
      },
    },
    participants: {
      type: "participants",
      label: "Участники розыгрыша",
      description: "Список зрителей на оверлее",
      icon: "widgetParticipants",
      defaultGeometry: { x: 70, y: 55, w: 26, h: 38 },
      minW: 12,
      minH: 8,
      defaultConfig: {},
    },
    mic: {
      type: "mic",
      label: "Визуализатор микрофона",
      description: "Анимированная звуковая волна",
      icon: "widgetMic",
      defaultGeometry: { x: 50, y: 82, w: 40, h: 12 },
      minW: 10,
      minH: 3,
      defaultConfig: {},
    },
    death: {
      type: "death",
      label: "Счётчик смертей",
      description: "Крупный счётчик смертей для челлендж-стримов",
      icon: "widgetDeath",
      defaultGeometry: { x: 80, y: 4, w: 16, h: 12 },
      minW: 8,
      minH: 5,
      defaultConfig: { label: "Смерти", color: "#ff4d4d" },
    },
    soundboard: {
      type: "soundboard",
      label: "Шумотека",
      description: "Звук и попап-карточка за баллы канала",
      icon: "widgetSoundboard",
      defaultGeometry: { x: 32, y: 38, w: 36, h: 24 },
      minW: 12,
      minH: 8,
      defaultConfig: { popupDurationMs: 4600, imageSize: 200, showImage: true, showText: true, showBackground: true, showBorder: true },
    },
    grimhex: {
      type: "grimhex",
      label: "Вывеска Grim HEX",
      description: "Анимированная неоновая 3D-вывеска (только для темы Grim HEX)",
      icon: "widgetGrimHex",
      dimension: "3d",
      theme: "grimhex",
      role: "sign",
      defaultGeometry: { x: 38, y: 6, w: 24, h: 16 },
      minW: 10,
      minH: 6,
      defaultConfig: { perspective: 0 },
    },
    musain: {
      type: "musain",
      label: "Вывеска Café Musain",
      description: "Анимированная неоновая вывеска Café Musain (только для темы Grim HEX)",
      icon: "widgetMusain",
      dimension: "3d",
      theme: "grimhex",
      defaultGeometry: { x: 34, y: 8, w: 28, h: 21 },
      minW: 12,
      minH: 6,
      defaultConfig: { perspective: 0 },
    },
    "grimhex-chat": {
      type: "grimhex-chat",
      label: "Чат Grim HEX",
      description: "Чат стрима в неоновом HUD Grim HEX (только для темы Grim HEX)",
      icon: "widgetGrimHexChat",
      services: ["twitchChat", "youtube"],
      dimension: "3d",
      theme: "grimhex",
      renderType: "2d",
      defaultGeometry: { x: 68, y: 6, w: 29, h: 46 },
      minW: 16,
      minH: 16,
      defaultConfig: { maxMessages: 50, perspective: 0 },
    },
    "grimhex-goal": {
      type: "grimhex-goal",
      label: "Цель Grim HEX",
      description: "Донат-цель из 5 неоновых секторов (только для темы Grim HEX)",
      icon: "widgetGrimHexGoal",
      services: ["donationAlerts", "youtube"],
      dimension: "3d",
      theme: "grimhex",
      renderType: "2d",
      defaultGeometry: { x: 3, y: 84, w: 32, h: 6 },
      minW: 16,
      minH: 4,
      defaultConfig: { showPercentage: false },
    },
    "grimhex-holo-alert": {
      type: "grimhex-holo-alert",
      label: "Голограмма Grim HEX",
      description: "Голографический терминал с вращающимся 3D-значком (только для темы Grim HEX)",
      icon: "widgetGrimHexHoloAlert",
      services: ["twitchEvents", "donationAlerts", "youtube"],
      dimension: "3d",
      theme: "grimhex",
      renderType: "2d",
      defaultGeometry: { x: 40, y: 16, w: 26, h: 14 },
      minW: 16,
      minH: 8,
      defaultConfig: {},
    },
    "grimhex-radar": {
      type: "grimhex-radar",
      label: "Радар Grim HEX",
      description: "Голографический радар с кораблями-донатерами (только для темы Grim HEX)",
      icon: "widgetGrimHexRadar",
      services: ["donationAlerts", "youtube"],
      dimension: "3d",
      theme: "grimhex",
      role: "radar",
      defaultGeometry: { x: 42, y: 8, w: 16, h: 24 },
      minW: 12,
      minH: 12,
      defaultConfig: { opacity: 100 },
    },
    nuclear: {
      type: "nuclear",
      label: "Знак радиации",
      description: "Анимированный неоновый 3D-знак радиации (только для темы Nuclear)",
      icon: "widgetNuclear",
      dimension: "3d",
      theme: "nuclear",
      role: "sign",
      defaultGeometry: { x: 38, y: 6, w: 24, h: 16 },
      minW: 10,
      minH: 6,
      defaultConfig: { perspective: 0 },
    },
    "nuclear-chat": {
      type: "nuclear-chat",
      label: "Чат Nuclear",
      description: "Чат стрима в радиоактивном HUD (только для темы Nuclear)",
      icon: "widgetNuclearChat",
      services: ["twitchChat", "youtube"],
      dimension: "3d",
      theme: "nuclear",
      renderType: "2d",
      defaultGeometry: { x: 68, y: 6, w: 29, h: 46 },
      minW: 16,
      minH: 16,
      defaultConfig: { maxMessages: 50, perspective: 0 },
    },
    "nuclear-goal": {
      type: "nuclear-goal",
      label: "Цель Nuclear",
      description: "Донат-цель из радиоактивных секторов (только для темы Nuclear)",
      icon: "widgetNuclearGoal",
      services: ["donationAlerts", "youtube"],
      dimension: "3d",
      theme: "nuclear",
      renderType: "2d",
      defaultGeometry: { x: 3, y: 84, w: 32, h: 6 },
      minW: 16,
      minH: 4,
      defaultConfig: { showPercentage: false },
    },
    "nuclear-holo-alert": {
      type: "nuclear-holo-alert",
      label: "Голограмма Nuclear",
      description: "Радиоактивный терминал с вращающимся 3D-значком (только для темы Nuclear)",
      icon: "widgetNuclearHoloAlert",
      services: ["twitchEvents", "donationAlerts", "youtube"],
      dimension: "3d",
      theme: "nuclear",
      renderType: "2d",
      defaultGeometry: { x: 40, y: 16, w: 26, h: 14 },
      minW: 16,
      minH: 8,
      defaultConfig: {},
    },
    cobra: {
      type: "cobra",
      label: "Корабль Cobra Mk II",
      description: "Анимированная голограмма корабля Cobra Mk II (только для темы Cobra Mk II)",
      icon: "widgetCobra",
      dimension: "3d",
      theme: "cobra-mk2",
      role: "sign",
      defaultGeometry: { x: 38, y: 6, w: 24, h: 16 },
      minW: 10,
      minH: 6,
      defaultConfig: { perspective: 0 },
    },
    "elite-sign": {
      type: "elite-sign",
      label: "Вывеска Elite",
      description: "Анимированная неоновая вывеска с эмблемой Elite (только для темы Cobra Mk II)",
      icon: "widgetEliteSign",
      dimension: "3d",
      theme: "cobra-mk2",
      defaultGeometry: { x: 38, y: 6, w: 24, h: 16 },
      minW: 10,
      minH: 6,
      defaultConfig: { perspective: 0 },
    },
    "cobra-chat": {
      type: "cobra-chat",
      label: "Чат Cobra",
      description: "Чат стрима в оранжевом HUD Cobra Mk II (только для темы Cobra Mk II)",
      icon: "widgetCobraChat",
      services: ["twitchChat", "youtube"],
      dimension: "3d",
      theme: "cobra-mk2",
      renderType: "2d",
      defaultGeometry: { x: 68, y: 6, w: 29, h: 46 },
      minW: 16,
      minH: 16,
      defaultConfig: { maxMessages: 50, perspective: 0 },
    },
    "cobra-goal": {
      type: "cobra-goal",
      label: "Цель Cobra",
      description: "Донат-цель из оранжевых секторов (только для темы Cobra Mk II)",
      icon: "widgetCobraGoal",
      services: ["donationAlerts", "youtube"],
      dimension: "3d",
      theme: "cobra-mk2",
      renderType: "2d",
      defaultGeometry: { x: 3, y: 84, w: 32, h: 6 },
      minW: 16,
      minH: 4,
      defaultConfig: { showPercentage: false },
    },
    "cobra-holo-alert": {
      type: "cobra-holo-alert",
      label: "Голограмма Cobra",
      description: "Голографический терминал с вращающимся кораблём (только для темы Cobra Mk II)",
      icon: "widgetCobraHoloAlert",
      services: ["twitchEvents", "donationAlerts", "youtube"],
      dimension: "3d",
      theme: "cobra-mk2",
      renderType: "2d",
      defaultGeometry: { x: 40, y: 16, w: 26, h: 14 },
      minW: 16,
      minH: 8,
      defaultConfig: {},
    },
    "cobra-shield": {
      type: "cobra-shield",
      label: "Щит Cobra",
      description: "Донат-цель с кораблём и кольцами щита (только для темы Cobra Mk II)",
      icon: "widgetCobraShield",
      services: ["donationAlerts", "youtube"],
      dimension: "3d",
      theme: "cobra-mk2",
      role: "shield",
      defaultGeometry: { x: 40, y: 64, w: 20, h: 28 },
      minW: 12,
      minH: 14,
      defaultConfig: { opacity: 100 },
    },
    "cobra-radar": {
      type: "cobra-radar",
      label: "Радар Cobra",
      description: "Перспективный круговой радар с кораблями-донатерами (только для темы Cobra Mk II)",
      icon: "widgetCobraRadar",
      services: ["donationAlerts", "youtube"],
      dimension: "3d",
      theme: "cobra-mk2",
      role: "radar",
      defaultGeometry: { x: 42, y: 8, w: 16, h: 24 },
      minW: 12,
      minH: 12,
      defaultConfig: { opacity: 100 },
    },
    "md3-orb": {
      type: "md3-orb",
      label: "Сфера Material You",
      description: "Мягкая 3D-сфера в тонах темы с орбитой (только для темы Material You)",
      icon: "widgetMd3Orb",
      dimension: "3d",
      theme: "nebula",
      role: "sign",
      defaultGeometry: { x: 38, y: 6, w: 24, h: 16 },
      minW: 10,
      minH: 6,
      defaultConfig: { perspective: 0 },
    },
    "md3-chat": {
      type: "md3-chat",
      label: "Чат Material You",
      description: "Чат стрима на приподнятой карточке Material You (только для темы Material You)",
      icon: "widgetMd3Chat",
      services: ["twitchChat", "youtube"],
      dimension: "3d",
      theme: "nebula",
      renderType: "2d",
      defaultGeometry: { x: 68, y: 6, w: 29, h: 46 },
      minW: 16,
      minH: 16,
      defaultConfig: { maxMessages: 50, perspective: 0 },
    },
    "md3-goal": {
      type: "md3-goal",
      label: "Цель Material You",
      description: "Донат-цель с градиентным прогрессом в стиле Material You (только для темы Material You)",
      icon: "widgetMd3Goal",
      services: ["donationAlerts", "youtube"],
      dimension: "3d",
      theme: "nebula",
      renderType: "2d",
      defaultGeometry: { x: 3, y: 84, w: 32, h: 6 },
      minW: 16,
      minH: 4,
      defaultConfig: { showPercentage: false },
    },
    "md3-holo-alert": {
      type: "md3-holo-alert",
      label: "Алерт Material You",
      description: "Всплывающий алерт с вращающимся 3D-значком (только для темы Material You)",
      icon: "widgetMd3HoloAlert",
      services: ["twitchEvents", "donationAlerts", "youtube"],
      dimension: "3d",
      theme: "nebula",
      renderType: "2d",
      defaultGeometry: { x: 40, y: 16, w: 26, h: 14 },
      minW: 16,
      minH: 8,
      defaultConfig: {},
    },
    "pixel-cube": {
      type: "pixel-cube",
      label: "Куб Pixel Perfect",
      description: "Вращающийся изометрический пиксель-куб (только для темы Pixel Perfect)",
      icon: "widgetPixelCube",
      dimension: "3d",
      theme: "pixel",
      role: "sign",
      defaultGeometry: { x: 38, y: 6, w: 24, h: 16 },
      minW: 10,
      minH: 6,
      defaultConfig: { perspective: 0 },
    },
    "pixel-chat": {
      type: "pixel-chat",
      label: "Чат Pixel Perfect",
      description: "Пиксельный чат на плоской панели (только для темы Pixel Perfect)",
      icon: "widgetPixelChat",
      services: ["twitchChat", "youtube"],
      dimension: "3d",
      theme: "pixel",
      renderType: "2d",
      defaultGeometry: { x: 68, y: 6, w: 29, h: 46 },
      minW: 16,
      minH: 16,
      defaultConfig: { maxMessages: 50, perspective: 0 },
    },
    "pixel-goal": {
      type: "pixel-goal",
      label: "Цель Pixel Perfect",
      description: "Блочная пиксельная шкала донат-цели (только для темы Pixel Perfect)",
      icon: "widgetPixelGoal",
      services: ["donationAlerts", "youtube"],
      dimension: "3d",
      theme: "pixel",
      renderType: "2d",
      defaultGeometry: { x: 3, y: 84, w: 32, h: 6 },
      minW: 16,
      minH: 4,
      defaultConfig: { showPercentage: false },
    },
    "pixel-holo-alert": {
      type: "pixel-holo-alert",
      label: "Алерт Pixel Perfect",
      description: "Пиксельный алерт с вращающимся значком (только для темы Pixel Perfect)",
      icon: "widgetPixelHoloAlert",
      services: ["twitchEvents", "donationAlerts", "youtube"],
      dimension: "3d",
      theme: "pixel",
      renderType: "2d",
      defaultGeometry: { x: 40, y: 16, w: 26, h: 14 },
      minW: 16,
      minH: 8,
      defaultConfig: {},
    },
  };

  const CANVAS = { w: 1920, h: 1080 };

  // All 3D widget defs that belong to a given theme id (its 3D variant).
  function widgetsForTheme(themeId) {
    if (!themeId) return [];
    return Object.values(WIDGET_TYPES).filter((d) => d.dimension === "3d" && d.theme === themeId);
  }

  // A 3D widget "replaces" its 2D counterpart when the theme's 3D is active:
  // any "*-chat" replaces the 2D "chat", "*-goal" replaces "goal", and
  // "*-holo-alert" replaces "alerts". Sign/radar/shield/orb/cube widgets are
  // role-mapped across themes via the catalog `role` field (see widgetRole).
  function replacedBy3d(widgetType) {
    if (!widgetType) return null;
    if (widgetType.endsWith("-chat")) return "chat";
    if (widgetType.endsWith("-goal")) return "goal";
    if (widgetType.endsWith("-holo-alert")) return "alerts";
    return null;
  }

  // The "role" a widget plays for cross-theme correspondence. 2D base widgets
  // ("chat"/"goal"/"alerts"), every 3D variant of them, and the decorative
  // 3D widgets (signs / radar / shield / orb / cube, via the catalog `role`
  // field) all share a role, so switching themes can remap one variant to
  // another. Widgets without a role are strictly theme-bound (additive).
  function widgetRole(widgetType) {
    if (!widgetType) return null;
    if (widgetType === "chat" || widgetType === "goal" || widgetType === "alerts") return widgetType;
    const r3d = replacedBy3d(widgetType);
    if (r3d) return r3d;
    const def = WIDGET_TYPES[widgetType];
    return (def && def.role) || null;
  }

  // The type a widget renders as under the active theme. Role widgets
  // (chat/goal/alerts and the decorative signs/radar/shield) follow the active
  // 3D variant's enabled counterpart; everything else keeps its own type. Used
  // by both the editor preview and the properties panel so the UI mirrors the
  // overlay's transform().
  function resolveTypeForTheme(widgetType, variantId, enabled3d) {
    const role = widgetRole(widgetType);
    if (!role) return widgetType;
    if (!variantId) return widgetType; // 3D off
    const counterpart = widgetsForTheme(variantId).find((w) => widgetRole(w.type) === role);
    if (!counterpart) return widgetType;
    if (enabled3d && enabled3d[counterpart.type] === false) return widgetType;
    return counterpart.type;
  }

  const api = { WIDGET_TYPES, CANVAS, widgetsForTheme, replacedBy3d, widgetRole, resolveTypeForTheme };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.WidgetCatalog = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
