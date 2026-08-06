/*
  Full-screen scenes (as opposed to overlay widgets): separate OBS Browser
  Sources shown between gameplay, not on top of it. Each has its own URL.
  Shared between server/state.js (defaults) and control/control.js (forms).
*/
(function (root) {
  const SCENE_DEFS = {
    start: { id: "start", label: "Начало стрима", icon: "scenePlay" },
    brb: { id: "brb", label: "Отошёл (BRB)", icon: "sceneBrb" },
    end: { id: "end", label: "Окончание стрима", icon: "sceneEnd" },
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
        showTimer: true,
        timerDuration: 300,
        timerDoneText: "Стрим возобновится прямо сейчас!",
        showEvents: true,
        showSocials: true,
        socials: DEFAULT_SOCIALS.map((s) => ({ ...s })),
      },
      end: {
        statusLabel: "СТРИМ ЗАВЕРШЁН",
        title: "Спасибо за просмотр!",
        subtitle: "Увидимся в следующий раз",
        showTimer: false,
        timerDuration: 0,
        timerDoneText: "",
        showEvents: true,
        showSocials: true,
        socials: DEFAULT_SOCIALS.map((s) => ({ ...s })),
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
