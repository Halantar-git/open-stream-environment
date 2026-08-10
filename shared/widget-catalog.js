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
      defaultGeometry: { x: 3, y: 84, w: 32, h: 11 },
      minW: 16,
      minH: 7,
      defaultConfig: { showPercentage: false },
    },
    chat: {
      type: "chat",
      label: "Чат Twitch",
      description: "Лента сообщений чата канала",
      icon: "widgetChat",
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
      defaultGeometry: { x: 3, y: 4, w: 24, h: 26 },
      minW: 14,
      minH: 12,
      defaultConfig: { maxItems: 5 },
    },
    custom: {
      type: "custom",
      label: "Свой виджет",
      description: "Текст, картинка или свой HTML",
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
      },
    },
    stat: {
      type: "stat",
      label: "Счётчик",
      description: "Фолловеры, подписчики или топ донат — плашкой",
      icon: "widgetStat",
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
  };

  const CANVAS = { w: 1920, h: 1080 };

  const api = { WIDGET_TYPES, CANVAS };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.WidgetCatalog = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
