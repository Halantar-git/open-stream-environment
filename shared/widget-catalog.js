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
      description: "Анимированная неоновая 3D-вывеска (только для темы Star Citizen)",
      icon: "widgetGrimHex",
      dimension: "3d",
      theme: "grimhex",
      defaultGeometry: { x: 38, y: 6, w: 24, h: 16 },
      minW: 10,
      minH: 6,
      defaultConfig: { perspective: 0 },
    },
    "grimhex-chat": {
      type: "grimhex-chat",
      label: "Чат Star Citizen",
      description: "Чат стрима в неоновом HUD Star Citizen (только для темы Star Citizen)",
      icon: "widgetStarCitizenChat",
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
      label: "Цель Star Citizen",
      description: "Донат-цель из 5 неоновых секторов (только для темы Star Citizen)",
      icon: "widgetStarCitizenGoal",
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
      label: "Голограмма Star Citizen",
      description: "Голографический терминал с вращающимся 3D-значком (только для темы Star Citizen)",
      icon: "widgetStarCitizenHoloAlert",
      dimension: "3d",
      theme: "grimhex",
      renderType: "2d",
      defaultGeometry: { x: 40, y: 16, w: 26, h: 14 },
      minW: 16,
      minH: 8,
      defaultConfig: {},
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
