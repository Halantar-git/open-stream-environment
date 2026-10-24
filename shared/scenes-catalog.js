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
  Full-screen scenes (as opposed to overlay widgets): separate OBS Browser
  Sources shown between gameplay, not on top of it. Each has its own URL.
  Shared between server/state.js (defaults) and control/control.js (forms).
*/
(function (root) {
  const SCENE_DEFS = {
    start: { id: "start", label: "Начало стрима", icon: "scenePlay" },
    brb: { id: "brb", label: "Отошёл (BRB)", icon: "sceneBrb" },
    talk: { id: "talk", label: "Разговор", icon: "sceneTalk" },
    guests: { id: "guests", label: "Гости", icon: "sceneGuests" },
    end: { id: "end", label: "Окончание стрима", icon: "sceneEnd" },
    wheel: { id: "wheel", label: "Колесо Фортуны", icon: "sceneWheel" },
    poll: { id: "poll", label: "Голосование", icon: "scenePoll" },
    pause: { id: "pause", label: "Пауза", icon: "scenePause" },
  };

  const DEFAULT_SOCIALS = [
    { platform: "TG", text: "t.me/your_channel" },
    { platform: "DC", text: "discord.gg/your_server" },
    { platform: "YT", text: "youtube.com/@channel" },
  ];

  // Гостевая плитка раскладки сцены «Гости»: слот мультикама в сетке 2×2.
  // Ширина и высота в процентах равны, потому что холст 16:9 — одинаковые
  // проценты по осям дают кадр 16:9. Бейдж «LIVE» — как у остальных рамок,
  // имя гостя вписывают в инспекторе, если нужно.
  function guestCam(slot, x, y, z) {
    return {
      id: `guests-${slot}`,
      type: "webcam",
      x,
      y,
      w: 36,
      h: 36,
      z,
      visible: true,
      config: { source: "remote", guestSlot: slot, label: "LIVE", showLabel: true },
    };
  }

  function defaultScenes() {
    return {
      start: {
        statusLabel: "СТРИМ СКОРО НАЧНЁТСЯ",
        title: "Скоро начнём",
        subtitle: "Стрим начнётся через несколько минут. Не переключайтесь!",
        splashFile: "",
        splashDuration: 0,
        splashEnabled: true,
        backgroundFile: "",
        showTimer: true,
        timerDuration: 600,
        timerDoneText: "Начинаем прямо сейчас!",
        showEvents: true,
        showSocials: true,
        socials: DEFAULT_SOCIALS.map((s) => ({ ...s })),
      },
      brb: {
        statusLabel: "ПЕРЕРЫВ НА СТРИМЕ",
        title: "Скоро вернусь",
        subtitle: "Стрим возобновится через несколько минут. Не переключайтесь!",
        splashFile: "",
        splashDuration: 0,
        splashEnabled: true,
        backgroundFile: "",
        showTimer: true,
        timerDuration: 300,
        timerDoneText: "Стрим возобновится прямо сейчас!",
        showEvents: true,
        showSocials: true,
        socials: DEFAULT_SOCIALS.map((s) => ({ ...s })),
      },
      talk: {
        statusLabel: "ОБЩАЕМСЯ",
        title: "Разговор со зрителями",
        subtitle: "Задавайте вопросы в чате!",
        splashFile: "",
        splashDuration: 0,
        splashEnabled: true,
        backgroundFile: "",
        showTimer: false,
        timerDuration: 0,
        timerDoneText: "",
        showEvents: true,
        showSocials: true,
        socials: DEFAULT_SOCIALS.map((s) => ({ ...s })),
      },
      guests: {
        statusLabel: "В ЭФИРЕ С ГОСТЯМИ",
        title: "Гости",
        subtitle: "",
        splashFile: "",
        splashDuration: 0,
        splashEnabled: true,
        backgroundFile: "",
        showTimer: false,
        timerDuration: 0,
        timerDoneText: "",
        showEvents: false,
        showSocials: false,
        socials: [],
        widgets: [
          guestCam("cam2", 2, 3, 1),
          guestCam("cam3", 40, 3, 2),
          guestCam("cam4", 2, 41, 3),
          guestCam("cam5", 40, 41, 4),
          {
            id: "guests-chat",
            type: "chat",
            x: 78,
            y: 3,
            w: 20,
            h: 74,
            z: 5,
            visible: true,
            config: { maxMessages: 12 },
          },
        ],
      },
      end: {
        statusLabel: "СТРИМ ЗАВЕРШЁН",
        title: "Спасибо за просмотр!",
        subtitle: "Увидимся в следующий раз",
        splashFile: "",
        splashDuration: 0,
        splashEnabled: true,
        backgroundFile: "",
        showTimer: false,
        timerDuration: 0,
        timerDoneText: "",
        showEvents: true,
        showSocials: true,
        socials: DEFAULT_SOCIALS.map((s) => ({ ...s })),
      },
      wheel: {
        statusLabel: "РОЗЫГРЫШ",
        title: "Колесо Фортуны",
        subtitle: "Победителя определит колесо",
        splashFile: "",
        splashDuration: 0,
        splashEnabled: true,
        backgroundFile: "",
        showTimer: false,
        timerDuration: 0,
        timerDoneText: "",
        showEvents: false,
        showSocials: false,
        socials: [],
      },
      poll: {
        statusLabel: "ГОЛОСОВАНИЕ",
        title: "Голосование",
        subtitle: "Голосуйте в чате!",
        splashFile: "",
        splashDuration: 0,
        splashEnabled: true,
        backgroundFile: "",
        showTimer: false,
        timerDuration: 0,
        timerDoneText: "",
        showEvents: false,
        showSocials: false,
        socials: [],
      },
      pause: {
        statusLabel: "ПАУЗА",
        title: "Пауза",
        subtitle: "",
        splashFile: "",
        splashDuration: 0,
        backgroundFile: "",
        showTimer: false,
        timerDuration: 0,
        timerDoneText: "",
        showEvents: false,
        showSocials: false,
        socials: [],
      },
    };
  }

  const api = { SCENE_DEFS, defaultScenes };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.SceneCatalog = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
