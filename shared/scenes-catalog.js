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
    end: { id: "end", label: "Окончание стрима", icon: "sceneEnd" },
    wheel: { id: "wheel", label: "Колесо Фортуны", icon: "sceneWheel" },
    poll: { id: "poll", label: "Голосование", icon: "scenePoll" },
  };

  const DEFAULT_SOCIALS = [
    { platform: "TG", text: "t.me/your_channel" },
    { platform: "DC", text: "discord.gg/your_server" },
    { platform: "YT", text: "youtube.com/@channel" },
  ];

  function defaultScenes() {
    return {
      start: {
        statusLabel: "СТРИМ СКОРО НАЧНЁТСЯ",
        title: "Скоро начнём",
        subtitle: "Стрим начнётся через несколько минут. Не переключайтесь!",
        splashFile: "",
        splashDuration: 0,
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
        showTimer: false,
        timerDuration: 0,
        timerDoneText: "",
        showEvents: true,
        showSocials: true,
        socials: DEFAULT_SOCIALS.map((s) => ({ ...s })),
      },
      end: {
        statusLabel: "СТРИМ ЗАВЕРШЁН",
        title: "Спасибо за просмотр!",
        subtitle: "Увидимся в следующий раз",
        splashFile: "",
        splashDuration: 0,
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
