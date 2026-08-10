(function () {
  const { EVENT_TYPES } = window.SharedEvents;
  const { ICONS } = window.SharedIcons;

  const canvas = document.getElementById("canvas");
  const mounted = new Map(); // widget instance id -> { el, inner, type, config, ...typeState }

  let goal = { title: "Цель", current: 0, target: 1, currency: "RUB" };
  let recentEvents = [];
  let stats = { followerCount: null, subscriberCount: null };
  let topDonation = { user: "", amount: 0, currency: "RUB" };

  // ---------------- rendering / reconciliation ----------------

  function render(layout) {
    const seen = new Set();
    [...layout]
      .sort((a, b) => (a.z || 0) - (b.z || 0))
      .forEach((inst) => {
        seen.add(inst.id);
        let entry = mounted.get(inst.id);
        if (!entry || entry.type !== inst.type) {
          if (entry) unmountEntry(entry);
          entry = mountInstance(inst);
          mounted.set(inst.id, entry);
        }
        entry.config = inst.config || {};
        applyGeometry(entry.el, inst);
        entry.el.style.zIndex = inst.z || 0;
        entry.el.style.display = inst.visible ? "" : "none";
        if (entry.type === "goal") renderGoal(entry);
        if (entry.type === "recent") renderRecent(entry);
        if (entry.type === "custom") renderCustom(entry);
        if (entry.type === "stat") renderStat(entry);
        if (entry.type === "social") maybeStartSocialRotation(entry, inst.config || {});
        if (entry.type === "chat" && typeof inst.config.maxMessages === "number") {
          trimChat(entry);
        }
      });

    for (const [id, entry] of mounted) {
      if (!seen.has(id)) {
        unmountEntry(entry);
        mounted.delete(id);
      }
    }
  }

  function unmountEntry(entry) {
    if (entry.socialTimer) clearInterval(entry.socialTimer);
    entry.el.remove();
  }

  function applyGeometry(el, inst) {
    el.style.left = inst.x + "%";
    el.style.top = inst.y + "%";
    el.style.width = inst.w + "%";
    el.style.height = inst.h + "%";
  }

  function mountInstance(inst) {
    const el = document.createElement("div");
    el.className = "widget-instance";
    el.dataset.type = inst.type;
    canvas.appendChild(el);

    const inner = document.createElement("div");
    el.appendChild(inner);

    const entry = { el, inner, type: inst.type, config: inst.config || {} };

    switch (inst.type) {
      case "alerts":
        inner.className = "widget-alerts-host";
        entry.queue = [];
        entry.playing = false;
        break;
      case "goal":
        inner.className = "widget-goal";
        break;
      case "chat":
        inner.className = "widget-chat";
        break;
      case "recent":
        inner.className = "widget-recent";
        break;
      case "custom":
        inner.className = "widget-custom";
        break;
      case "stat":
        inner.className = "widget-stat";
        break;
      case "social":
        inner.className = "widget-social";
        entry.socialIndex = 0;
        entry.socialTimer = null;
        entry.socialKey = "";
        break;
      default:
        break;
    }
    return entry;
  }

  // ---------------- alerts ----------------

  function kindLabel(alert) {
    switch (alert.kind) {
      case "follow":
        return "Новый фолловер";
      case "sub":
        return "Новая подписка";
      case "gift_sub":
        return `Подарил ${alert.count || 1} подписок`;
      case "cheer":
        return "Чирс битами";
      case "donation":
        return "Новый донат";
      default:
        return "";
    }
  }

  function formatAmount(alert) {
    if (alert.kind === "cheer") return `${alert.amount} бит`;
    if (alert.kind === "donation") return `${formatMoney(alert.amount)} ${currencySymbol(alert.currency || "RUB")}`;
    return "";
  }

  function buildAlertCard(alert) {
    const card = document.createElement("div");
    card.className = "widget-alert";
    card.dataset.kind = alert.kind;
    const showAmount = alert.kind === "donation" || alert.kind === "cheer";
    const showMessage = (alert.kind === "donation" || alert.kind === "cheer") && alert.message;
    card.innerHTML = `
      <div class="widget-alert__spark">${"<span></span>".repeat(6)}</div>
      <div class="widget-alert__icon">${ICONS[alert.kind] || ""}</div>
      <div class="widget-alert__body">
        <div class="widget-alert__status"><span class="widget-alert__dot"></span><span class="widget-alert__kicker">${kindLabel(alert)}</span></div>
        <div class="widget-alert__name">${escapeHtml(alert.user || "")}</div>
        ${showAmount ? `<div class="widget-alert__amount">${formatAmount(alert)}</div>` : ""}
        ${showMessage ? `<div class="widget-alert__message">«${escapeHtml(alert.message)}»</div>` : ""}
      </div>
      <div class="widget-alert__lockbar"><div class="widget-alert__lockbar-fill"></div></div>`;
    return card;
  }

  function queueAlert(alert) {
    for (const entry of mounted.values()) {
      if (entry.type !== "alerts") continue;
      entry.queue.push(alert);
      if (!entry.playing) drainAlertQueue(entry);
    }
  }

  function drainAlertQueue(entry) {
    const alert = entry.queue.shift();
    if (!alert) {
      entry.playing = false;
      return;
    }
    entry.playing = true;
    const card = buildAlertCard(alert);
    entry.inner.appendChild(card);
    requestAnimationFrame(() => card.classList.add("alert-enter-active"));
    const holdMs = alert.durationMs || 5000;
    setTimeout(() => {
      card.classList.add("alert-exit");
      setTimeout(() => {
        card.remove();
        drainAlertQueue(entry);
      }, 280);
    }, holdMs);
  }

  // ---------------- goal ----------------

  function renderGoal(entry) {
    const pct = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
    entry.inner.innerHTML = `
      <div class="widget-goal__row">
        <span class="widget-goal__title">${escapeHtml(goal.title || "Цель")}</span>
        <span class="widget-goal__amounts"><b>${formatMoney(goal.current)}</b> / ${formatMoney(goal.target)} ${escapeHtml(currencySymbol(goal.currency))}</span>
      </div>
      <div class="md-linear-progress"><div class="md-linear-progress__bar" style="width:${pct}%"></div></div>
      ${entry.config.showPercentage ? `<div class="widget-goal__percent">${pct}%</div>` : ""}`;
  }

  function renderAllGoals() {
    for (const entry of mounted.values()) if (entry.type === "goal") renderGoal(entry);
  }

  // ---------------- chat ----------------

  function buildChatRow(msg, config) {
    const row = document.createElement("div");
    row.className = "widget-chat__msg";
    const badges =
      config && config.showBadges === false
        ? ""
        : (msg.badges || [])
            .slice(0, 3)
            .map((b) => `<span class="widget-chat__badge" data-role="${escapeAttr(String(b))}">${escapeHtml(String(b).slice(0, 1).toUpperCase())}</span>`)
            .join("");
    row.innerHTML = `${badges}<span class="widget-chat__user" style="color:${escapeAttr(msg.color || "#c9c1d6")}">${escapeHtml(msg.user)}</span><span class="widget-chat__colon">:</span><span class="widget-chat__text">${escapeHtml(msg.message)}</span>`;
    return row;
  }

  function pushChat(msg) {
    for (const entry of mounted.values()) {
      if (entry.type !== "chat") continue;
      entry.inner.appendChild(buildChatRow(msg, entry.config));
      trimChat(entry);
    }
  }

  function trimChat(entry) {
    const max = entry.config.maxMessages || 8;
    while (entry.inner.children.length > max) entry.inner.removeChild(entry.inner.firstChild);
  }

  // ---------------- recent events ----------------

  function recentText(evt) {
    const user = `<b>${escapeHtml(evt.user || "")}</b>`;
    switch (evt.kind) {
      case "follow":
        return `${user} подписался`;
      case "sub":
        return `${user} оформил подписку`;
      case "gift_sub":
        return `${user} подарил ${evt.amount || ""} подписок`;
      case "cheer":
        return `${user} чирснул ${evt.amount || 0} битами`;
      case "donation":
        return `${user} задонатил ${formatMoney(evt.amount || 0)}`;
      default:
        return user;
    }
  }

  function renderRecent(entry) {
    const max = entry.config.maxItems || 5;
    const items = recentEvents.slice(0, max);
    entry.inner.innerHTML =
      `<div class="widget-recent__title">Последние события</div>` +
      (items.length
        ? `<div class="widget-recent__list">${items
            .map((e) => `<div class="widget-recent__item"><span class="widget-recent__dot" data-kind="${e.kind}"></span><span>${recentText(e)}</span></div>`)
            .join("")}</div>`
        : `<div class="widget-recent__empty">Пока пусто</div>`);
  }

  function renderAllRecent() {
    for (const entry of mounted.values()) if (entry.type === "recent") renderRecent(entry);
  }

  // ---------------- stat pill ----------------

  function statContent(config) {
    const metric = config.metric || "followers";
    if (metric === "subscribers") {
      return {
        icon: ICONS.sub,
        label: config.label || "Подписчики",
        value: stats.subscriberCount != null ? formatMoney(stats.subscriberCount) : "—",
      };
    }
    if (metric === "latestFollower") {
      const e = recentEvents.find((ev) => ev.kind === "follow");
      return { icon: ICONS.follow, label: config.label || "Последний фолловер", value: e ? e.user : "Пока нет" };
    }
    if (metric === "latestSubscriber") {
      const e = recentEvents.find((ev) => ev.kind === "sub" || ev.kind === "gift_sub");
      return { icon: ICONS.sub, label: config.label || "Последний подписчик", value: e ? e.user : "Пока нет" };
    }
    if (metric === "topDonation") {
      return {
        icon: ICONS.donation,
        label: config.label || "Топ донат",
        value: topDonation.amount > 0 ? `${topDonation.user} (${formatMoney(topDonation.amount)} ${currencySymbol(topDonation.currency)})` : "Пока нет",
      };
    }
    return {
      icon: ICONS.follow,
      label: config.label || "Фолловеры",
      value: stats.followerCount != null ? formatMoney(stats.followerCount) : "—",
    };
  }

  function renderStat(entry) {
    const { icon, label, value } = statContent(entry.config || {});
    entry.inner.innerHTML = `<div class="widget-stat__icon">${icon}</div><div class="widget-stat__info"><span class="widget-stat__label">${escapeHtml(label)}</span><span class="widget-stat__value">${escapeHtml(value)}</span></div>`;
  }

  function renderAllStats() {
    for (const entry of mounted.values()) if (entry.type === "stat") renderStat(entry);
  }

  // ---------------- rotating social banner ----------------

  function maybeStartSocialRotation(entry, config) {
    const socials = config.socials || [];
    const key = JSON.stringify(socials) + "|" + (config.rotateIntervalSec || 8);
    if (entry.socialKey === key) return; // config unchanged, leave the running rotation alone
    entry.socialKey = key;
    if (entry.socialTimer) clearInterval(entry.socialTimer);
    entry.socialIndex = 0;
    renderSocialFrame(entry, socials);
    if (socials.length > 1) {
      const intervalMs = Math.max(2, config.rotateIntervalSec || 8) * 1000;
      entry.socialTimer = setInterval(() => {
        const contentEl = entry.inner.querySelector(".widget-social__content");
        if (contentEl) contentEl.classList.add("is-fading");
        setTimeout(() => {
          entry.socialIndex = (entry.socialIndex + 1) % socials.length;
          renderSocialFrame(entry, socials);
        }, 300);
      }, intervalMs);
    }
  }

  function renderSocialFrame(entry, socials) {
    const s = socials[entry.socialIndex] || { platform: "", text: "" };
    entry.inner.innerHTML = `<div class="widget-social__content"><span class="widget-social__icon">${escapeHtml(s.platform)}</span><div class="widget-social__info"><span class="widget-social__platform">${escapeHtml(s.platform)}</span><span class="widget-social__handle">${escapeHtml(s.text)}</span></div></div>`;
  }

  // ---------------- custom widget ----------------

  function renderCustom(entry) {
    const cfg = entry.config || {};
    const mode = cfg.mode || "text";
    const withCard = mode !== "image" && cfg.showBackground !== false;
    entry.inner.className = "widget-custom" + (withCard ? " has-card" : "");

    if (mode === "image") {
      entry.customCodeKey = null;
      entry.inner.innerHTML = cfg.imageUrl
        ? `<img class="widget-custom__image" src="${escapeAttr(cfg.imageUrl)}" style="object-fit:${escapeAttr(cfg.imageFit || "contain")}" alt="">`
        : "";
    } else if (mode === "html") {
      const key = `${cfg.html || ""}\u0000${cfg.css || ""}\u0000${cfg.js || ""}`;
      if (entry.customCodeKey !== key) {
        entry.customCodeKey = key;
        entry.inner.innerHTML = "";
        const iframe = document.createElement("iframe");
        iframe.className = "widget-custom__html";
        iframe.srcdoc = buildCustomWidgetDocument(cfg);
        entry.inner.appendChild(iframe);
      }
    } else {
      entry.customCodeKey = null;
      const title = cfg.textTitle ? `<div class="widget-custom__title">${escapeHtml(cfg.textTitle)}</div>` : "";
      const colorStyle = cfg.textColor ? ` style="color:${escapeAttr(cfg.textColor)}"` : "";
      entry.inner.innerHTML = `<div class="widget-custom__text" data-align="${escapeAttr(cfg.textAlign || "center")}">${title}<div class="widget-custom__body" data-size="${escapeAttr(cfg.textSize || "medium")}"${colorStyle}>${escapeHtml(cfg.text || "")}</div></div>`;
    }
  }

  function buildCustomWidgetDocument(cfg) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#e8e1f0;font-family:sans-serif;}${cfg.css || ""}</style></head><body>${cfg.html || ""}<script>${cfg.js || ""}</script></body></html>`;
  }

  // ---------------- theme ----------------

  function applyTheme(appearance) {
    if (!appearance || !appearance.tokens) return;
    const root = document.documentElement;
    Object.entries(appearance.tokens).forEach(([k, v]) => root.style.setProperty(k, v));
    document.body.dataset.decoration = appearance.tokens["--panel-decoration"] || "none";
    document.body.dataset.theme = appearance.activeThemeId || "";
  }

  // ---------------- utils ----------------

  function formatMoney(n) {
    return Number(n || 0).toLocaleString("ru-RU");
  }
  const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", UAH: "₴", KZT: "₸", GBP: "£" };
  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || code || "";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }

  // ---------------- socket ----------------

  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE:
        goal = msg.payload.goal;
        recentEvents = msg.payload.recentEvents || [];
        stats = msg.payload.stats || stats;
        topDonation = msg.payload.topDonation || topDonation;
        applyTheme(msg.payload.appearance);
        render(msg.payload.layout || []);
        break;
      case EVENT_TYPES.LAYOUT_UPDATE:
        render(msg.payload.layout || []);
        break;
      case EVENT_TYPES.THEME_UPDATE:
        applyTheme(msg.payload);
        break;
      case EVENT_TYPES.STAT_UPDATE:
        stats = msg.payload;
        renderAllStats();
        break;
      case EVENT_TYPES.TOP_DONATION_UPDATE:
        topDonation = msg.payload;
        renderAllStats();
        break;
      case EVENT_TYPES.ALERT:
        queueAlert(msg.payload);
        break;
      case EVENT_TYPES.CHAT_MESSAGE:
        pushChat(msg.payload);
        break;
      case EVENT_TYPES.RECENT_EVENT:
        recentEvents = [msg.payload, ...recentEvents].slice(0, 15);
        renderAllRecent();
        renderAllStats();
        break;
      case EVENT_TYPES.GOAL_UPDATE:
        goal = msg.payload;
        renderAllGoals();
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
