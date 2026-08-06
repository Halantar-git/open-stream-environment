(function () {
  const { EVENT_TYPES } = window.SharedEvents;
  const { ICONS } = window.SharedIcons;

  const params = new URLSearchParams(location.search);
  const sceneType = params.get("type") || "brb";

  let recentEvents = [];
  let topDonation = { user: "", amount: 0, currency: "RUB" };
  let timerInterval = null;
  let timeLeft = 0;
  let totalDuration = 0;
  let doneText = "";

  const els = {
    statusLabel: document.getElementById("statusLabel"),
    title: document.getElementById("sceneTitle"),
    subtitle: document.getElementById("sceneSubtitle"),
    timerBox: document.getElementById("timerBox"),
    timerDisplay: document.getElementById("timerDisplay"),
    timerProgress: document.getElementById("timerProgress"),
    eventsGrid: document.getElementById("eventsGrid"),
    evFollower: document.getElementById("evFollower"),
    evSubscriber: document.getElementById("evSubscriber"),
    evTopDonation: document.getElementById("evTopDonation"),
    socialsFooter: document.getElementById("socialsFooter"),
  };

  document.querySelectorAll(".event-icon[data-icon]").forEach((el) => {
    el.innerHTML = ICONS[el.dataset.icon] || "";
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function formatMoney(n) {
    return Number(n || 0).toLocaleString("ru-RU");
  }
  const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", UAH: "₴", KZT: "₸", GBP: "£" };
  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || code || "";
  }

  function applyTheme(appearance) {
    if (!appearance || !appearance.tokens) return;
    const root = document.documentElement;
    Object.entries(appearance.tokens).forEach(([k, v]) => root.style.setProperty(k, v));
    const isAngular = appearance.tokens["--panel-clip"] && appearance.tokens["--panel-clip"] !== "none";
    document.body.classList.toggle("theme-angular", !!isAngular);
  }

  function renderScene(scene) {
    if (!scene) return;
    els.statusLabel.textContent = scene.statusLabel || "";
    els.title.textContent = scene.title || "";
    els.subtitle.textContent = scene.subtitle || "";
    els.eventsGrid.hidden = !scene.showEvents;
    els.socialsFooter.hidden = !scene.showSocials;
    els.timerBox.hidden = !scene.showTimer;

    renderSocials(scene.socials || []);
    renderEvents();

    if (scene.showTimer) startTimer(scene.timerDuration || 0, scene.timerDoneText || "");
    else stopTimer();
  }

  function renderSocials(socials) {
    els.socialsFooter.innerHTML = socials
      .map((s) => `<div class="social-pill"><span class="pill-icon">${escapeHtml(s.platform)}</span><span class="pill-text">${escapeHtml(s.text)}</span></div>`)
      .join("");
  }

  function renderEvents() {
    const follow = recentEvents.find((e) => e.kind === "follow");
    const sub = recentEvents.find((e) => e.kind === "sub" || e.kind === "gift_sub");
    els.evFollower.textContent = follow ? follow.user : "Пока нет";
    els.evSubscriber.textContent = sub ? sub.user : "Пока нет";
    els.evTopDonation.textContent = topDonation.amount > 0 ? `${topDonation.user} (${formatMoney(topDonation.amount)} ${currencySymbol(topDonation.currency)})` : "Пока нет";
  }

  function startTimer(duration, doneMsg) {
    stopTimer();
    totalDuration = duration;
    timeLeft = duration;
    doneText = doneMsg;
    updateTimerDisplay();
    if (duration <= 0) return;
    timerInterval = setInterval(() => {
      timeLeft = Math.max(0, timeLeft - 1);
      updateTimerDisplay();
      if (timeLeft <= 0) {
        if (doneText) els.subtitle.textContent = doneText;
        stopTimer();
      }
    }, 1000);
  }
  function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
  }
  function updateTimerDisplay() {
    const m = Math.floor(timeLeft / 60);
    const s = timeLeft % 60;
    els.timerDisplay.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    const pct = totalDuration ? (timeLeft / totalDuration) * 100 : 0;
    els.timerProgress.style.width = pct + "%";
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE:
        applyTheme(msg.payload.appearance);
        recentEvents = msg.payload.recentEvents || [];
        topDonation = msg.payload.topDonation || topDonation;
        renderScene(msg.payload.scenes && msg.payload.scenes[sceneType]);
        break;
      case EVENT_TYPES.THEME_UPDATE:
        applyTheme(msg.payload);
        break;
      case EVENT_TYPES.SCENES_UPDATE:
        renderScene(msg.payload[sceneType]);
        break;
      case EVENT_TYPES.RECENT_EVENT:
        recentEvents = [msg.payload, ...recentEvents].slice(0, 15);
        renderEvents();
        break;
      case EVENT_TYPES.TOP_DONATION_UPDATE:
        topDonation = msg.payload;
        renderEvents();
        break;
      default:
        break;
    }
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      try {
        handleMessage(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws.close();
  }

  connect();
})();
