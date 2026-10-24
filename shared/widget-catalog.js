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
  // Общие настройки таймера Executive Hangar — используются 2D- и 3D-вариантом.
  // Заголовок фиксирован, источник всегда Longshot — в панели остаются только
  // переключатели отображения.
  const EXEC_TIMER_DEFAULT_CONFIG = {
    showLights: true,
    showCycle: true,
    showTelemetry: true,
  };

  // Общие настройки новостной ленты: одинаковые у 2D-виджета и 3D-вариантов,
  // различается только наклон.
  const TICKER_DEFAULT_CONFIG = {
    speed: 80,
    direction: "left",
    label: "",
    showLabel: true,
    maxItems: 24,
    // Награды за баллы канала показываются срочной полосой: их замечают
    // быстрее, чем бегущую строку. Переключатель — в инспекторе.
    rewardsBreaking: true,
    sources: {
      donations: true,
      follows: true,
      subs: true,
      rewards: true,
      chat: false,
      goal: false,
      top: false,
    },
  };

  // 3D-вариант новостной ленты: один и тот же движок, отличается только
  // наклоном и привязкой к набору темы.
  function ticker3d(type, label, description, theme, perspective) {
    return {
      type,
      label,
      description,
      icon: "widgetTicker",
      services: ["twitchEvents", "twitchChat", "donationAlerts", "youtube"],
      dimension: "3d",
      theme,
      renderType: "2d",
      defaultGeometry: { x: 3, y: 92, w: 94, h: 6 },
      minW: 30,
      minH: 4,
      defaultConfig: {
        ...TICKER_DEFAULT_CONFIG,
        perspective,
        sources: { ...TICKER_DEFAULT_CONFIG.sources },
      },
    };
  }

  // 3D-вариант «Последних событий»: анимация выезда слева и сдвиг списка.
  // Стилизуется токенами темы, поэтому один класс работает во всех наборах.
  function recent3d(type, label, description, theme) {
    return {
      type,
      label,
      description,
      icon: "widgetRecent",
      services: ["twitchEvents", "donationAlerts", "youtube"],
      dimension: "3d",
      theme,
      renderType: "2d",
      defaultGeometry: { x: 3, y: 24, w: 26, h: 30 },
      minW: 14,
      minH: 12,
      defaultConfig: { maxItems: 5, animationMs: 840 },
    };
  }

  const WIDGET_TYPES = {
    // ---- Общие 2D-виджеты (доступны в любой теме) ----
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
      defaultConfig: { maxMessages: 8 },
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
    ticker: {
      type: "ticker",
      label: "Новостная лента",
      description: "Бегущая строка событий стрима: донаты, фоллоу, сабы и чат",
      icon: "widgetTicker",
      services: ["twitchEvents", "twitchChat", "donationAlerts", "youtube"],
      defaultGeometry: { x: 3, y: 92, w: 94, h: 6 },
      minW: 30,
      minH: 4,
      defaultConfig: {
        ...TICKER_DEFAULT_CONFIG,
        sources: { ...TICKER_DEFAULT_CONFIG.sources },
      },
    },
    custom: {
      type: "custom",
      label: "Свой виджет",
      description: "Текст, картинка, видео, свой HTML или встраивание",
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
        // Видео: свой файл или ссылка. `videoMuted` по умолчанию включён —
        // без звука браузер разрешает автозапуск всегда, а прозрачный WebM
        // обычно и не несёт дорожки.
        videoUrl: "",
        videoFit: "contain",
        videoLoop: true,
        videoMuted: true,
        html: "",
        css: "",
        js: "",
        embedUrl: "",
      },
    },
    stat: {
      type: "stat",
      label: "Счётчик",
      description: "Фолловеры, подписчики, топ донат или донаты за стрим — плашкой",
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
      description: "Список участников колеса Фортуны",
      icon: "widgetParticipants",
      defaultGeometry: { x: 3, y: 60, w: 20, h: 28 },
      minW: 10,
      minH: 8,
      defaultConfig: { maxNames: 10, marquee: false, fontSize: 16, textColor: "", backgroundOpacity: 82 },
    },
    mic: {
      type: "mic",
      label: "Визуализатор микрофона",
      description: "Анимированная звуковая волна",
      icon: "widgetMic",
      defaultGeometry: { x: 50, y: 82, w: 40, h: 12 },
      minW: 10,
      minH: 3,
      defaultConfig: { perspective: 0, rotation: 0 },
    },
    webcam: {
      type: "webcam",
      label: "Рамка веб-камеры",
      description: "Рамка для камеры: оформление или живое видео через панель управления",
      icon: "widgetWebcam",
      defaultGeometry: { x: 3, y: 60, w: 24, h: 24 },
      minW: 8,
      minH: 8,
      defaultConfig: {
        source: "frame",
        // Гость обычно сидит в Discord, и его микрофон в эфире не нужен:
        // по умолчанию звук не выводим и даже не просим у него аудиодорожку.
        videoOnly: true,
        label: "LIVE",
        showLabel: true,
        labelPosition: "top-left",
        showBorder: true,
        showCorners: true,
        showBackground: false,
        showVignette: false,
        mirror: false,
        fit: "cover",
        color: "",
        thickness: 4,
        perspective: 0,
        perspectiveDirection: "left",
      },
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
    // Гирлянда — декоративный виджет без данных: строка лампочек, висящая с
    // верхней кромки виджета. Растяните плашку вдоль края сцены — провод и
    // лампочки подстроятся под ширину.
    garland: {
      type: "garland",
      label: "Гирлянда",
      description: "Лампочки на проводе вдоль верхнего края сцены",
      icon: "widgetGarland",
      defaultGeometry: { x: 2, y: 0, w: 96, h: 10 },
      minW: 6,
      minH: 6,
      defaultConfig: {
        mode: "twinkle",
        palette: "classic",
        bulbs: 24,
        swags: 5,
        sag: 0.5,
        speed: 1,
        reactToAlerts: true,
      },
    },
    // Снегопад — тоже без данных: поле снежинок, падающих на CSS. Занимает
    // всю сцену, поэтому и геометрия по умолчанию — на весь кадр.
    snow: {
      type: "snow",
      label: "Снегопад",
      description: "Падающий снег: плотность, скорость, снос и цвет",
      icon: "widgetSnow",
      defaultGeometry: { x: 0, y: 0, w: 100, h: 100 },
      minW: 6,
      minH: 6,
      defaultConfig: {
        density: 40,
        speed: 1,
        size: 3,
        wind: 0.2,
        color: "#ffffff",
        reactToAlerts: true,
      },
    },

    // ---- Orbital и свои темы ----
    timer: {
      type: "timer",
      label: "Таймер Executive Hangar",
      description: "Executive Hangar: фазы, огни и обратный отсчёт (темы Orbital и свои)",
      icon: "widgetTimer",
      themes: ["orbital", "custom"],
      defaultGeometry: { x: 36, y: 8, w: 28, h: 18 },
      minW: 16,
      minH: 10,
      defaultConfig: { ...EXEC_TIMER_DEFAULT_CONFIG },
    },

    // ---- Star Citizen / Grim HEX (3D) ----
    "grimhex-timer": {
      type: "grimhex-timer",
      label: "Таймер Grim HEX",
      description: "Executive Hangar: фазы, огни и обратный отсчёт (только для темы Grim HEX)",
      icon: "widgetTimer",
      dimension: "3d",
      theme: "grimhex",
      renderType: "2d",
      defaultGeometry: { x: 36, y: 6, w: 28, h: 20 },
      minW: 16,
      minH: 10,
      defaultConfig: { ...EXEC_TIMER_DEFAULT_CONFIG },
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
    // UEC-перевод — 2D-виджет и доступен в любой теме, но по стилю это Star
    // Citizen, поэтому в колонке он стоит в блоке Grim HEX сразу после цели.
    "uec-transfer": {
      type: "uec-transfer",
      label: "UEC-перевод",
      description: "Входящая передача: канал, позывной и сумма — в стиле Star Citizen",
      icon: "widgetUecTransfer",
      services: ["twitchEvents", "donationAlerts", "donatex", "youtube"],
      defaultGeometry: { x: 25, y: 3, w: 50, h: 20 },
      minW: 30,
      minH: 14,
      defaultConfig: { showAmount: true, showMessage: true, durationMs: 9000, decodeTickMs: 76 },
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
    "grimhex-recent": recent3d(
      "grimhex-recent",
      "События Grim HEX",
      "3D-очередь событий с выездом слева (только для темы Grim HEX)",
      "grimhex"
    ),
    "grimhex-ticker": {
      type: "grimhex-ticker",
      label: "Лента Grim HEX",
      description: "Бегущая строка событий в HUD Grim HEX (только для темы Grim HEX)",
      icon: "widgetTicker",
      services: ["twitchEvents", "twitchChat", "donationAlerts", "youtube"],
      dimension: "3d",
      theme: "grimhex",
      renderType: "2d",
      defaultGeometry: { x: 3, y: 92, w: 94, h: 6 },
      minW: 30,
      minH: 4,
      defaultConfig: {
        ...TICKER_DEFAULT_CONFIG,
        perspective: 35,
        sources: { ...TICKER_DEFAULT_CONFIG.sources },
      },
    },

    // ---- Nuclear (3D) ----
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

    "nuclear-recent": recent3d(
      "nuclear-recent",
      "События Nuclear",
      "3D-очередь событий с выездом слева (только для темы Nuclear)",
      "nuclear"
    ),

    "nuclear-ticker": ticker3d(
      "nuclear-ticker",
      "Лента Nuclear",
      "Бегущая строка событий в радиоактивном HUD (только для темы Nuclear)",
      "nuclear",
      35
    ),

    // ---- Cobra Mk II (3D) ----
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

    "cobra-recent": recent3d(
      "cobra-recent",
      "События Cobra",
      "3D-очередь событий с выездом слева (только для темы Cobra Mk II)",
      "cobra-mk2"
    ),

    "cobra-ticker": ticker3d(
      "cobra-ticker",
      "Лента Cobra",
      "Бегущая строка событий в оранжевом HUD (только для темы Cobra Mk II)",
      "cobra-mk2",
      35
    ),

    // ---- TESO (3D) ----
    "teso-seal": {
      type: "teso-seal",
      label: "Печать Уроборос",
      description: "Анимированная золотая печать Уроборос (только для темы TESO)",
      icon: "widgetTesoSeal",
      dimension: "3d",
      theme: "teso-seal",
      role: "sign",
      defaultGeometry: { x: 38, y: 6, w: 24, h: 16 },
      minW: 10,
      minH: 6,
      defaultConfig: { perspective: 0 },
    },
    "teso-chat": {
      type: "teso-chat",
      label: "Чат TESO",
      description: "Чат стрима в золотом HUD TESO (только для темы TESO)",
      icon: "widgetTesoChat",
      services: ["twitchChat", "youtube"],
      dimension: "3d",
      theme: "teso-seal",
      renderType: "2d",
      defaultGeometry: { x: 68, y: 6, w: 29, h: 46 },
      minW: 16,
      minH: 16,
      defaultConfig: { maxMessages: 50, perspective: 0 },
    },
    "teso-goal": {
      type: "teso-goal",
      label: "Цель TESO",
      description: "ХП-бар цели в стиле TESO (только для темы TESO)",
      icon: "widgetTesoGoal",
      services: ["donationAlerts", "youtube"],
      dimension: "3d",
      theme: "teso-seal",
      renderType: "2d",
      defaultGeometry: { x: 3, y: 84, w: 32, h: 3 },
      minW: 16,
      minH: 2,
      defaultConfig: { showPercentage: false },
    },
    "teso-holo-alert": {
      type: "teso-holo-alert",
      label: "Голограмма TESO",
      description: "Голографический терминал с вращающейся золотой печатью (только для темы TESO)",
      icon: "widgetTesoHoloAlert",
      services: ["twitchEvents", "donationAlerts", "youtube"],
      dimension: "3d",
      theme: "teso-seal",
      renderType: "2d",
      defaultGeometry: { x: 40, y: 16, w: 26, h: 14 },
      minW: 16,
      minH: 8,
      defaultConfig: {},
    },

    "teso-recent": recent3d(
      "teso-recent",
      "События TESO",
      "3D-очередь событий с выездом слева (только для темы TESO)",
      "teso-seal"
    ),

    "teso-ticker": ticker3d(
      "teso-ticker",
      "Лента TESO",
      "Бегущая строка событий в золотом HUD (только для темы TESO)",
      "teso-seal",
      35
    ),

    // ---- Wardogs (3D) ----
    "wardogs-goal": {
      type: "wardogs-goal",
      label: "Цель Wardogs",
      description: "Донат-цель как шкала загрузки из HUD WarDogs (только для темы Wardogs)",
      icon: "widgetWardogsGoal",
      services: ["donationAlerts", "youtube"],
      dimension: "3d",
      theme: "wardogs",
      renderType: "2d",
      defaultGeometry: { x: 3, y: 84, w: 32, h: 6 },
      minW: 16,
      minH: 4,
      defaultConfig: { showPercentage: true },
    },
    "wardogs-chat": {
      type: "wardogs-chat",
      label: "Чат Wardogs",
      description: "Чат стрима в HUD WarDogs (только для темы Wardogs)",
      icon: "widgetWardogsChat",
      services: ["twitchChat", "youtube"],
      dimension: "3d",
      theme: "wardogs",
      renderType: "2d",
      defaultGeometry: { x: 68, y: 6, w: 29, h: 46 },
      minW: 16,
      minH: 16,
      defaultConfig: { maxMessages: 50, perspective: 0 },
    },
    "wardogs-holo-alert": {
      type: "wardogs-holo-alert",
      label: "Алерт Wardogs",
      description: "Всплывающий алерт с голографическим значком (только для темы Wardogs)",
      icon: "widgetWardogsHoloAlert",
      services: ["twitchEvents", "donationAlerts", "youtube"],
      dimension: "3d",
      theme: "wardogs",
      renderType: "2d",
      defaultGeometry: { x: 40, y: 16, w: 26, h: 14 },
      minW: 16,
      minH: 8,
      defaultConfig: {},
    },
    "wardogs-cube": {
      type: "wardogs-cube",
      label: "Куб Wardogs",
      description: "Вращающийся куб из логотипа WarDogs (только для темы Wardogs)",
      icon: "widgetWardogsCube",
      dimension: "3d",
      theme: "wardogs",
      role: "sign",
      defaultGeometry: { x: 38, y: 6, w: 24, h: 16 },
      minW: 10,
      minH: 6,
      defaultConfig: { perspective: 0, motion: true },
    },

    "wardogs-recent": recent3d(
      "wardogs-recent",
      "События Wardogs",
      "3D-очередь событий с выездом слева (только для темы Wardogs)",
      "wardogs"
    ),

    "wardogs-ticker": ticker3d(
      "wardogs-ticker",
      "Лента Wardogs",
      "Бегущая строка событий в HUD WarDogs (только для темы Wardogs)",
      "wardogs",
      35
    ),

    // ---- Material You (3D) ----
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

    "md3-recent": recent3d(
      "md3-recent",
      "События Material You",
      "3D-очередь событий с выездом слева (только для темы Material You)",
      "nebula"
    ),

    "md3-ticker": ticker3d(
      "md3-ticker",
      "Лента Material You",
      "Бегущая строка событий на мягкой карточке Material You (только для темы Material You)",
      "nebula",
      30
    ),

    // ---- Pixel Perfect (3D) ----
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

    "pixel-recent": recent3d(
      "pixel-recent",
      "События Pixel Perfect",
      "3D-очередь событий с выездом слева (только для темы Pixel Perfect)",
      "pixel"
    ),

    "pixel-ticker": ticker3d(
      "pixel-ticker",
      "Лента Pixel Perfect",
      "Бегущая строка событий на пиксельной панели (только для темы Pixel Perfect)",
      "pixel",
      25
    ),

    // ---- Retrowave (3D) ----
    "retrowave-goal": {
      type: "retrowave-goal",
      label: "Цель Retrowave",
      description: "Донат-цель с неоновой шкалой и закатной заливкой (только для темы Retrowave)",
      icon: "widgetRetrowaveGoal",
      services: ["donationAlerts", "youtube"],
      dimension: "3d",
      theme: "retrowave",
      renderType: "2d",
      defaultGeometry: { x: 3, y: 84, w: 32, h: 6 },
      minW: 16,
      minH: 4,
      defaultConfig: { showPercentage: true, perspective: 0, perspectiveDirection: "left" },
    },
    "retrowave-chat": {
      type: "retrowave-chat",
      label: "Чат Retrowave",
      description: "Чат стрима на неоновой панели с косой кромкой (только для темы Retrowave)",
      icon: "widgetRetrowaveChat",
      services: ["twitchChat", "youtube"],
      dimension: "3d",
      theme: "retrowave",
      renderType: "2d",
      defaultGeometry: { x: 68, y: 6, w: 29, h: 46 },
      minW: 16,
      minH: 16,
      defaultConfig: { maxMessages: 50, perspective: 0 },
    },
    "retrowave-holo-alert": {
      type: "retrowave-holo-alert",
      label: "Алерт Retrowave",
      description: "Всплывающий неоновый алерт с полосатым солнцем (только для темы Retrowave)",
      icon: "widgetRetrowaveHoloAlert",
      services: ["twitchEvents", "donationAlerts", "youtube"],
      dimension: "3d",
      theme: "retrowave",
      renderType: "2d",
      defaultGeometry: { x: 40, y: 16, w: 26, h: 14 },
      minW: 16,
      minH: 8,
      defaultConfig: {},
    },
    "retrowave-symbol": {
      type: "retrowave-symbol",
      label: "Символ Retrowave",
      description: "Вращающаяся неоновая сфера-сетка, появляется на алерте (только для темы Retrowave)",
      icon: "widgetRetrowaveSymbol",
      dimension: "3d",
      theme: "retrowave",
      role: "sign",
      defaultGeometry: { x: 38, y: 6, w: 24, h: 16 },
      minW: 10,
      minH: 6,
      defaultConfig: { perspective: 0 },
    },

    "retrowave-recent": recent3d(
      "retrowave-recent",
      "События Retrowave",
      "3D-очередь событий с выездом слева (только для темы Retrowave)",
      "retrowave"
    ),

    "retrowave-ticker": ticker3d(
      "retrowave-ticker",
      "Лента Retrowave",
      "Неоновая бегущая строка событий с косой кромкой (только для темы Retrowave)",
      "retrowave",
      45
    ),

    // ---- Интеграции DonateX ----
    "donatex-ai": {
      type: "donatex-ai",
      label: "ИИ-персонаж DonateX",
      description: "Озвучка донатного и ИИ-виджетов DonateX без картинки; без ссылок — встроенный персонаж",
      icon: "widgetDonatexAi",
      services: ["donatex"],
      defaultGeometry: { x: 30, y: 58, w: 40, h: 30 },
      minW: 16,
      minH: 10,
      defaultConfig: { donationUrl: "", url: "", characterName: "", showName: true, showDonor: true, queue: true, volume: 0.8, hideDelayMs: 5000 },
    },
    music: {
      type: "music",
      label: "Музыка донатов",
      description: "Трек, приложенный к донату: обложка, название, автор, сумма и очередь",
      icon: "widgetMusic",
      services: ["donatex"],
      defaultGeometry: { x: 30, y: 84, w: 40, h: 12 },
      minW: 20,
      minH: 6,
      defaultConfig: { autoplay: true, queue: true, showAmount: true, volume: 1 },
    },

  };

  const CANVAS = { w: 1920, h: 1080 };

  // All 3D widget defs that belong to a given theme id (its 3D variant).
  function widgetsForTheme(themeId) {
    if (!themeId) return [];
    return Object.values(WIDGET_TYPES).filter((d) => d.dimension === "3d" && d.theme === themeId);
  }

  // 2D widget ↔ theme binding. `def.themes` lists the theme ids a widget belongs
  // to plus the special token "custom" for any user-created theme; a widget
  // without `themes` is available everywhere (the default). `appearance` is the
  // server snapshot shape `{ activeThemeId, themes: [{ id, builtin, ... }] }`.
  function themeAllowsWidget(def, appearance) {
    if (!def || !Array.isArray(def.themes) || !def.themes.length) return true;
    const a = appearance || {};
    const themeId = a.activeThemeId || "";
    const list = Array.isArray(a.themes) ? a.themes : [];
    const active = list.find((x) => x && x.id === themeId);
    const isCustom = !!active && !active.builtin;
    if (isCustom && def.themes.includes("custom")) return true;
    return !!themeId && def.themes.includes(themeId);
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
    if (widgetType.endsWith("-timer")) return "timer";
    if (widgetType.endsWith("-ticker")) return "ticker";
    if (widgetType.endsWith("-recent")) return "recent";
    return null;
  }

  // The "role" a widget plays for cross-theme correspondence. 2D base widgets
  // ("chat"/"goal"/"alerts"), every 3D variant of them, and the decorative
  // 3D widgets (signs / radar / shield / orb / cube, via the catalog `role`
  // field) all share a role, so switching themes can remap one variant to
  // another. Widgets without a role are strictly theme-bound (additive).
  function widgetRole(widgetType) {
    if (!widgetType) return null;
    if (widgetType === "chat" || widgetType === "goal" || widgetType === "alerts" || widgetType === "timer" || widgetType === "ticker" || widgetType === "recent") return widgetType;
    const r3d = replacedBy3d(widgetType);
    if (r3d) return r3d;
    const def = WIDGET_TYPES[widgetType];
    return (def && def.role) || null;
  }

  // The type that stands in for a role among an explicit set of enabled 3D
  // widget types. Returns null when the set has zero or several candidates
  // (ambiguous) — callers then leave the widget as-is instead of remapping.
  function counterpartTypeForRole(role, types) {
    if (!role || !Array.isArray(types)) return null;
    const matches = types.filter((t) => widgetRole(t) === role);
    return matches.length === 1 ? matches[0] : null;
  }

  // The type a widget renders as under the active theme. Role widgets
  // (chat/goal/alerts and the decorative signs/radar/shield) follow the active
  // 3D variant's enabled counterpart; everything else keeps its own type. Used
  // by both the editor preview and the properties panel so the UI mirrors the
  // overlay's transform().
  //
  // `variantIdOrSet` accepts either a single 3D variant id (legacy built-in
  // path, with `enabled3d` disabling individual фишки) or an explicit array of
  // enabled 3D widget types (custom themes — arbitrary widget combinations).
  function resolveTypeForTheme(widgetType, variantIdOrSet, enabled3d) {
    const role = widgetRole(widgetType);
    if (!role) return widgetType;
    if (Array.isArray(variantIdOrSet)) {
      return counterpartTypeForRole(role, variantIdOrSet) || widgetType;
    }
    const variantId = variantIdOrSet;
    if (!variantId) return widgetType; // 3D off
    const counterpart = widgetsForTheme(variantId).find((w) => widgetRole(w.type) === role);
    if (!counterpart) return widgetType;
    if (enabled3d && enabled3d[counterpart.type] === false) return widgetType;
    return counterpart.type;
  }

  // Какой тип реально добавить в раскладку.
  //
  // Если в ней уже стоит явный 3D-виджет той же роли, 2D-двойник скроется
  // правилом замены: в редиторе он серый, в эфире его нет. В этом случае
  // добавляем 3D-вариант — иначе пользователь ставит виджет, а он «исчезает».
  function typeForAdd(widgetType, layout, active3d) {
    const def = WIDGET_TYPES[widgetType];
    if (!def || def.theme) return widgetType;
    const role = widgetRole(widgetType);
    if (!role) return widgetType;
    const items = Array.isArray(layout) ? layout : [];
    const explicit = items.some((other) => {
      const otherDef = other && WIDGET_TYPES[other.type];
      return !!otherDef && !!otherDef.theme && widgetRole(other.type) === role;
    });
    if (!explicit) return widgetType;
    return resolveTypeForTheme(widgetType, Array.isArray(active3d) ? active3d : []);
  }

  // Типы, которые держат собственный canvas-цикл (`requestAnimationFrame`,
  // 20–30 FPS) и потому реально грузят GPU/CPU. Источник истины — виджеты,
  // вызывающие `startRenderLoop()` или переопределяющие `_isAnimated()`,
  // плюс микровизатор со своим rAF. Используется для диагностики «бюджета
  // сцены» в редакторе: держать одновременно стоит 2–3 таких виджета.
  const ANIMATED_TYPES = new Set([
    "mic",
    "grimhex",
    "musain",
    "grimhex-radar",
    "grimhex-holo-alert",
    "grimhex-goal",
    "cobra",
    "cobra-radar",
    "cobra-shield",
    "cobra-holo-alert",
    "cobra-goal",
    "wardogs-goal",
    "wardogs-cube",
    "elite-sign",
    "nuclear",
    "nuclear-goal",
    "nuclear-holo-alert",
    "teso-seal",
    "md3-orb",
    "md3-goal",
    "pixel-cube",
    "pixel-goal",
    "retrowave-goal",
    "retrowave-symbol",
    "ticker",
    "grimhex-ticker",
    "nuclear-ticker",
    "cobra-ticker",
    "teso-ticker",
    "wardogs-ticker",
    "md3-ticker",
    "pixel-ticker",
    "retrowave-ticker",
  ]);

  function isAnimatedWidget(type) {
    return ANIMATED_TYPES.has(type);
  }

  const api = { WIDGET_TYPES, CANVAS, widgetsForTheme, themeAllowsWidget, replacedBy3d, widgetRole, counterpartTypeForRole, resolveTypeForTheme, typeForAdd, isAnimatedWidget };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.WidgetCatalog = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
