(function () {
  const { EVENT_TYPES } = window.SharedEvents;
  const { ICONS } = window.SharedIcons;
  const { WIDGET_TYPES } = window.WidgetCatalog;

  const params = new URLSearchParams(location.search);
  const port = params.get("port") || "8710";
  const wsUrl = `ws://localhost:${port}/ws`;
  const overlayUrl = `http://localhost:${port}/overlay/overlay.html`;

  // ---- state ----
  let ws;
  let layout = [];
  let goal = { title: "Цель", current: 0, target: 1, currency: "RUB" };
  let connectionStatus = {};
  let twitchChannel = "";
  let twitchClientId = "";
  let daClientId = "";
  let selectedId = null;
  let pendingAdd = null; // { knownIds:Set, dropXY:{x,y}|null }
  let appearance = { activeThemeId: "nebula", tokens: {}, themes: [] };
  let editorPrefs = { gridSize: 5, snapEnabled: true };
  let editingThemeId = null; // theme currently open in the editor form, or null for "new"
  let scenes = {};
  let topDonation = { user: "", amount: 0, currency: "RUB" };
  let stats = { followerCount: null, subscriberCount: null };
  let activeSceneId = "start";

  // ---- dom refs ----
  const tabsEl = document.getElementById("tabs");
  const viewEditor = document.getElementById("view-editor");
  const viewScenes = document.getElementById("view-scenes");
  const viewSettings = document.getElementById("view-settings");
  const libraryListEl = document.getElementById("libraryList");
  const canvasWrapEl = document.getElementById("canvasWrap");
  const canvasEl = document.getElementById("canvas");
  const layersEl = document.getElementById("layers");
  const propertiesSection = document.getElementById("propertiesSection");
  const propertiesTitle = document.getElementById("propertiesTitle");
  const propertiesEl = document.getElementById("properties");
  const statusChipsEl = document.getElementById("statusChips");
  const obsUrlLabel = document.getElementById("obsUrlLabel");
  const copyUrlBtn = document.getElementById("copyUrlBtn");
  const gridSizeSelect = document.getElementById("gridSizeSelect");
  const themeGridEl = document.getElementById("themeGrid");
  const themeEditorEl = document.getElementById("themeEditor");
  const newThemeBtn = document.getElementById("newThemeBtn");
  const exportConfigBtn = document.getElementById("exportConfigBtn");
  const importConfigBtn = document.getElementById("importConfigBtn");
  const exportImportStatus = document.getElementById("exportImportStatus");
  const scenesNavListEl = document.getElementById("scenesNavList");
  const scenesPreviewFrame = document.getElementById("scenesPreviewFrame");
  const sceneUrlLabel = document.getElementById("sceneUrlLabel");
  const copySceneUrlBtn = document.getElementById("copySceneUrlBtn");
  const sceneFormTitle = document.getElementById("sceneFormTitle");
  const sceneFormEl = document.getElementById("sceneForm");

  const twitchChannelInput = document.getElementById("twitchChannel");
  const twitchClientIdInput = document.getElementById("twitchClientId");
  const twitchClientSecretInput = document.getElementById("twitchClientSecret");
  const twitchRedirectUriEl = document.getElementById("twitchRedirectUri");
  const daClientIdInput = document.getElementById("daClientId");
  const daClientSecretInput = document.getElementById("daClientSecret");
  const daRedirectUriEl = document.getElementById("daRedirectUri");
  const appPortInput = document.getElementById("appPort");
  const appOverlayUrlInput = document.getElementById("appOverlayUrl");

  // ---- helpers ----
  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
  function round1(n) { return Math.round(n * 10) / 10; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }
  function formatMoney(n) { return Number(n || 0).toLocaleString("ru-RU"); }
  const CURRENCY_SYMBOLS = { RUB: "₽", USD: "$", EUR: "€", UAH: "₴", KZT: "₸", GBP: "£" };
  function currencySymbol(code) { return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || code || ""; }
  function send(type, payload) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
  }
  function switchHtml(id, on) {
    return `<div class="md-switch${on ? " is-on" : ""}" id="${id}"><div class="md-switch__thumb"></div></div>`;
  }
  function wireSwitch(el, cb) {
    if (!el) return;
    el.addEventListener("click", () => {
      const now = !el.classList.contains("is-on");
      el.classList.toggle("is-on", now);
      cb(now);
    });
  }

  // ---- tabs ----
  tabsEl.querySelectorAll(".topbar__tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      tabsEl.querySelectorAll(".topbar__tab").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const view = btn.dataset.view;
      viewEditor.hidden = view !== "editor";
      viewScenes.hidden = view !== "scenes";
      viewSettings.hidden = view !== "settings";
    });
  });

  // ---- library rail ----
  function renderLibrary() {
    libraryListEl.innerHTML = "";
    Object.values(WIDGET_TYPES).forEach((def) => {
      const card = document.createElement("div");
      card.className = "library-card";
      card.draggable = true;
      card.innerHTML = `
        <span class="library-card__icon">${ICONS[def.icon] || ""}</span>
        <span class="library-card__text">
          <span class="library-card__label">${def.label}</span>
          <span class="library-card__desc">${def.description}</span>
        </span>`;
      card.addEventListener("click", () => addWidget(def.type, null));
      card.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/widget-type", def.type);
        e.dataTransfer.effectAllowed = "copy";
      });
      libraryListEl.appendChild(card);
    });
  }

  canvasWrapEl.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("text/widget-type")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    canvasWrapEl.classList.add("is-drop-target");
  });
  canvasWrapEl.addEventListener("dragleave", (e) => {
    if (e.target === canvasWrapEl) canvasWrapEl.classList.remove("is-drop-target");
  });
  canvasWrapEl.addEventListener("drop", (e) => {
    e.preventDefault();
    canvasWrapEl.classList.remove("is-drop-target");
    const type = e.dataTransfer.getData("text/widget-type");
    if (!type) return;
    const rect = canvasEl.getBoundingClientRect();
    const xPct = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
    const yPct = clamp(((e.clientY - rect.top) / rect.height) * 100, 0, 100);
    addWidget(type, { x: xPct, y: yPct });
  });

  function addWidget(type, dropXY) {
    pendingAdd = { knownIds: new Set(layout.map((w) => w.id)), dropXY };
    send(EVENT_TYPES.CMD_ADD_WIDGET, { type });
  }

  // ---- canvas preview content (sample data for event-driven widgets, real data for goal) ----
  const SAMPLE_CHAT = [
    { user: "nova_viewer", color: "#7ee0d6", message: "го катку!", badges: ["subscriber"] },
    { user: "star_gazer", color: "#ffb0d8", message: "красивый оверлей 🔥", badges: [] },
    { user: "orbit_fan", color: "#c6b8ff", message: "хаю хай", badges: ["moderator"] },
  ];
  const SAMPLE_RECENT = [
    { kind: "donation", user: "comet_watcher", amount: 300 },
    { kind: "sub", user: "nova_viewer" },
    { kind: "follow", user: "star_gazer" },
  ];

  function recentTextPreview(e) {
    const user = `<b>${e.user}</b>`;
    switch (e.kind) {
      case "donation": return `${user} задонатил ${formatMoney(e.amount)}`;
      case "sub": return `${user} оформил подписку`;
      case "follow": return `${user} подписался`;
      default: return user;
    }
  }

  function buildPreviewHtml(inst) {
    const config = inst.config || {};
    switch (inst.type) {
      case "goal": {
        const pct = goal.target ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
        return `<div class="widget-goal">
          <div class="widget-goal__row">
            <span class="widget-goal__title">${escapeHtml(goal.title || "Цель")}</span>
            <span class="widget-goal__amounts"><b>${formatMoney(goal.current)}</b> / ${formatMoney(goal.target)} ${escapeHtml(currencySymbol(goal.currency))}</span>
          </div>
          <div class="md-linear-progress"><div class="md-linear-progress__bar" style="width:${pct}%"></div></div>
          ${config.showPercentage ? `<div class="widget-goal__percent">${pct}%</div>` : ""}
        </div>`;
      }
      case "chat": {
        const max = Math.min(3, config.maxMessages || 8);
        const rows = SAMPLE_CHAT.slice(0, max)
          .map((m) => {
            const badges = config.showBadges === false ? "" : (m.badges || []).map((b) => `<span class="widget-chat__badge">${b.slice(0, 1).toUpperCase()}</span>`).join("");
            return `<div class="widget-chat__msg">${badges}<span class="widget-chat__user" style="color:${m.color}">${m.user}</span><span class="widget-chat__colon">:</span><span class="widget-chat__text">${escapeHtml(m.message)}</span></div>`;
          })
          .join("");
        return `<div class="widget-chat">${rows}</div>`;
      }
      case "recent": {
        const max = Math.min(3, config.maxItems || 5);
        const items = SAMPLE_RECENT.slice(0, max)
          .map((e) => `<div class="widget-recent__item"><span class="widget-recent__dot" data-kind="${e.kind}"></span><span>${recentTextPreview(e)}</span></div>`)
          .join("");
        return `<div class="widget-recent"><div class="widget-recent__title">Последние события</div><div class="widget-recent__list">${items}</div></div>`;
      }
      case "alerts":
        return `<div class="widget-alerts-host"><div class="widget-alert" data-kind="follow">
          <div class="widget-alert__icon">${ICONS.follow}</div>
          <div class="widget-alert__body">
            <div class="widget-alert__kicker">Новый фолловер</div>
            <div class="widget-alert__name">nova_viewer</div>
          </div>
        </div></div>`;
      case "custom": {
        const mode = config.mode || "text";
        const withCard = mode !== "image" && config.showBackground !== false;
        if (mode === "image") {
          return config.imageUrl
            ? `<div class="widget-custom"><img class="widget-custom__image" src="${escapeAttr(config.imageUrl)}" style="object-fit:${escapeAttr(config.imageFit || "contain")}" alt=""></div>`
            : `<div class="widget-custom"></div>`;
        }
        if (mode === "html") {
          return `<div class="widget-custom${withCard ? " has-card" : ""}"><div class="widget-custom__html">${config.html || ""}</div></div>`;
        }
        const title = config.textTitle ? `<div class="widget-custom__title">${escapeHtml(config.textTitle)}</div>` : "";
        const colorStyle = config.textColor ? ` style="color:${escapeAttr(config.textColor)}"` : "";
        return `<div class="widget-custom${withCard ? " has-card" : ""}"><div class="widget-custom__text" data-align="${escapeAttr(config.textAlign || "center")}">${title}<div class="widget-custom__body" data-size="${escapeAttr(config.textSize || "medium")}"${colorStyle}>${escapeHtml(config.text || "")}</div></div></div>`;
      }
      case "stat": {
        const metric = config.metric || "followers";
        const sample =
          metric === "subscribers"
            ? { icon: ICONS.sub, label: config.label || "Подписчики", value: stats.subscriberCount != null ? formatMoney(stats.subscriberCount) : "—" }
            : metric === "latestFollower"
            ? { icon: ICONS.follow, label: config.label || "Последний фолловер", value: "star_gazer" }
            : metric === "latestSubscriber"
            ? { icon: ICONS.sub, label: config.label || "Последний подписчик", value: "nova_viewer" }
            : metric === "topDonation"
            ? { icon: ICONS.donation, label: config.label || "Топ донат", value: topDonation.amount > 0 ? `${topDonation.user} (${formatMoney(topDonation.amount)} ${currencySymbol(topDonation.currency)})` : "Пока нет" }
            : { icon: ICONS.follow, label: config.label || "Фолловеры", value: stats.followerCount != null ? formatMoney(stats.followerCount) : "—" };
        return `<div class="widget-stat"><div class="widget-stat__icon">${sample.icon}</div><div class="widget-stat__info"><span class="widget-stat__label">${escapeHtml(sample.label)}</span><span class="widget-stat__value">${escapeHtml(sample.value)}</span></div></div>`;
      }
      case "social": {
        const s = (config.socials || [])[0] || { platform: "TG", text: "t.me/your_channel" };
        return `<div class="widget-social"><div class="widget-social__content"><span class="widget-social__icon">${escapeHtml(s.platform)}</span><div class="widget-social__info"><span class="widget-social__platform">${escapeHtml(s.platform)}</span><span class="widget-social__handle">${escapeHtml(s.text)}</span></div></div></div>`;
      }
      default:
        return "";
    }
  }

  // ---- canvas render + drag/resize ----
  function renderCanvas() {
    canvasEl.innerHTML = "";
    [...layout]
      .sort((a, b) => (a.z || 0) - (b.z || 0))
      .forEach((inst) => {
        const box = document.createElement("div");
        box.className = "canvas-widget" + (inst.id === selectedId ? " is-selected" : "");
        box.dataset.id = inst.id;
        box.style.left = inst.x + "%";
        box.style.top = inst.y + "%";
        box.style.width = inst.w + "%";
        box.style.height = inst.h + "%";
        box.style.zIndex = inst.z || 0;
        box.style.opacity = inst.visible ? "1" : "0.35";

        const label = document.createElement("div");
        label.className = "canvas-widget__label";
        label.textContent = (WIDGET_TYPES[inst.type] || {}).label || inst.type;
        box.appendChild(label);

        const content = document.createElement("div");
        content.className = "canvas-widget__content";
        content.innerHTML = buildPreviewHtml(inst);
        box.appendChild(content);

        canvasEl.appendChild(box);
        attachDragHandlers(box, inst);
        attachResizeHandlers(box, inst);
      });
  }

  function applySelectionClasses() {
    canvasEl.querySelectorAll(".canvas-widget").forEach((el) => {
      el.classList.toggle("is-selected", el.dataset.id === selectedId);
    });
  }

  function selectWidget(id) {
    selectedId = id;
    applySelectionClasses();
    renderLayers();
    renderProperties();
  }

  // ---- theme + grid (canvas preview only — app chrome stays fixed Nebula) ----

  function applyThemeToCanvas(tokens) {
    if (!tokens) return;
    Object.entries(tokens).forEach(([k, v]) => canvasEl.style.setProperty(k, v));
    const isAngular = tokens["--panel-clip"] && tokens["--panel-clip"] !== "none";
    canvasEl.classList.toggle("theme-angular", !!isAngular);
  }

  function applyGridToCanvas() {
    const size = editorPrefs.gridSize || 0;
    canvasEl.classList.toggle("show-grid", size > 0);
    if (size > 0) {
      canvasEl.style.setProperty("--grid-x", (size / 100) * 960 + "px");
      canvasEl.style.setProperty("--grid-y", (size / 100) * 540 + "px");
    }
  }

  function snapValue(v) {
    const size = editorPrefs.gridSize;
    if (!editorPrefs.snapEnabled || !size) return v;
    return Math.round(v / size) * size;
  }

  gridSizeSelect.addEventListener("change", () => {
    const size = Number(gridSizeSelect.value);
    send(EVENT_TYPES.CMD_SET_EDITOR_PREFS, { gridSize: size, snapEnabled: size > 0 });
  });

  function attachDragHandlers(boxEl, inst) {
    boxEl.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".resize-handle")) return;
      e.preventDefault();
      selectWidget(inst.id);
      const canvasRect = canvasEl.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const cur = layout.find((w) => w.id === inst.id) || inst;
      const startXPct = cur.x;
      const startYPct = cur.y;
      let moved = false;
      boxEl.classList.add("is-dragging");
      boxEl.setPointerCapture(e.pointerId);

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
        const dxPct = (dx / canvasRect.width) * 100;
        const dyPct = (dy / canvasRect.height) * 100;
        const nx = snapValue(clamp(startXPct + dxPct, 0, 100 - cur.w));
        const ny = snapValue(clamp(startYPct + dyPct, 0, 100 - cur.h));
        boxEl.style.left = nx + "%";
        boxEl.style.top = ny + "%";
        boxEl.dataset.pendingX = nx;
        boxEl.dataset.pendingY = ny;
      }
      function onUp() {
        boxEl.removeEventListener("pointermove", onMove);
        boxEl.removeEventListener("pointerup", onUp);
        boxEl.classList.remove("is-dragging");
        if (moved) {
          send(EVENT_TYPES.CMD_UPDATE_WIDGET, {
            id: inst.id,
            patch: { x: round1(parseFloat(boxEl.dataset.pendingX)), y: round1(parseFloat(boxEl.dataset.pendingY)) },
          });
        }
      }
      boxEl.addEventListener("pointermove", onMove);
      boxEl.addEventListener("pointerup", onUp);
    });
  }

  function attachResizeHandlers(boxEl, inst) {
    ["nw", "ne", "sw", "se"].forEach((pos) => {
      const handle = document.createElement("div");
      handle.className = "resize-handle";
      handle.dataset.h = pos;
      boxEl.appendChild(handle);

      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectWidget(inst.id);
        const canvasRect = canvasEl.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        const cur = layout.find((w) => w.id === inst.id) || inst;
        const start = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
        const def = WIDGET_TYPES[inst.type] || { minW: 5, minH: 5 };
        handle.setPointerCapture(e.pointerId);

        function onMove(ev) {
          const dxPct = ((ev.clientX - startX) / canvasRect.width) * 100;
          const dyPct = ((ev.clientY - startY) / canvasRect.height) * 100;
          let { x, y, w, h } = start;
          if (pos.includes("e")) w = start.w + dxPct;
          if (pos.includes("s")) h = start.h + dyPct;
          if (pos.includes("w")) { w = start.w - dxPct; x = start.x + dxPct; }
          if (pos.includes("n")) { h = start.h - dyPct; y = start.y + dyPct; }
          w = Math.max(def.minW, w);
          h = Math.max(def.minH, h);
          x = clamp(x, 0, 100 - w);
          y = clamp(y, 0, 100 - h);
          w = snapValue(w);
          h = snapValue(h);
          x = snapValue(x);
          y = snapValue(y);
          boxEl.style.left = x + "%";
          boxEl.style.top = y + "%";
          boxEl.style.width = w + "%";
          boxEl.style.height = h + "%";
          boxEl.dataset.pendingGeo = JSON.stringify({ x, y, w, h });
        }
        function onUp() {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          if (boxEl.dataset.pendingGeo) {
            const geo = JSON.parse(boxEl.dataset.pendingGeo);
            send(EVENT_TYPES.CMD_UPDATE_WIDGET, {
              id: inst.id,
              patch: { x: round1(geo.x), y: round1(geo.y), w: round1(geo.w), h: round1(geo.h) },
            });
            delete boxEl.dataset.pendingGeo;
          }
        }
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
      });
    });
  }

  canvasEl.addEventListener("pointerdown", (e) => {
    if (e.target === canvasEl) selectWidget(null);
  });

  document.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && selectedId && document.activeElement.tagName !== "INPUT") {
      send(EVENT_TYPES.CMD_REMOVE_WIDGET, { id: selectedId });
      selectedId = null;
    }
  });

  // ---- layers panel ----
  function renderLayers() {
    if (!layout.length) {
      layersEl.innerHTML = `<div class="layers__empty">Пока нет виджетов — добавьте из библиотеки слева</div>`;
      return;
    }
    layersEl.innerHTML = "";
    [...layout]
      .sort((a, b) => (b.z || 0) - (a.z || 0))
      .forEach((inst) => {
        const def = WIDGET_TYPES[inst.type] || {};
        const row = document.createElement("div");
        row.className = "layer-row" + (inst.id === selectedId ? " is-selected" : "");
        row.innerHTML = `
          <span class="layer-row__icon">${ICONS[def.icon] || ""}</span>
          <span class="layer-row__label">${def.label || inst.type}</span>
          <span class="layer-row__btns">
            <button class="layer-row__btn" data-action="forward" title="На передний план">▲</button>
            <button class="layer-row__btn" data-action="backward" title="На задний план">▼</button>
            <button class="layer-row__btn" data-action="toggle" title="Показать/скрыть">${ICONS[inst.visible ? "eye" : "eyeOff"]}</button>
          </span>`;
        row.addEventListener("click", (e) => {
          if (e.target.closest("[data-action]")) return;
          selectWidget(inst.id);
        });
        row.querySelector('[data-action="toggle"]').addEventListener("click", (e) => {
          e.stopPropagation();
          send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { visible: !inst.visible } });
        });
        row.querySelector('[data-action="forward"]').addEventListener("click", (e) => {
          e.stopPropagation();
          send(EVENT_TYPES.CMD_REORDER_WIDGET, { id: inst.id, direction: "forward" });
        });
        row.querySelector('[data-action="backward"]').addEventListener("click", (e) => {
          e.stopPropagation();
          send(EVENT_TYPES.CMD_REORDER_WIDGET, { id: inst.id, direction: "backward" });
        });
        layersEl.appendChild(row);
      });
  }

  // ---- properties panel ----
  function renderProperties() {
    const inst = layout.find((w) => w.id === selectedId);
    if (!inst) {
      propertiesSection.hidden = true;
      return;
    }
    propertiesSection.hidden = false;
    const def = WIDGET_TYPES[inst.type] || {};
    propertiesTitle.textContent = def.label || inst.type;
    const config = inst.config || {};

    let extraHtml = "";
    if (inst.type === "goal") {
      extraHtml = `
        <div class="md-field"><label>Название цели</label><input type="text" id="pGoalTitle" value="${escapeAttr(goal.title || "")}"></div>
        <div class="properties__row">
          <div class="md-field"><label>Собрано</label><input type="number" id="pGoalCurrent" value="${goal.current || 0}"></div>
          <div class="md-field"><label>Цель</label><input type="number" id="pGoalTarget" value="${goal.target || 0}"></div>
        </div>
        <div class="md-field"><label>Валюта</label><input type="text" id="pGoalCurrency" value="${escapeAttr(goal.currency || "")}"></div>
        <div class="properties__toggle-row"><label>Показывать %</label>${switchHtml("pShowPercent", !!config.showPercentage)}</div>`;
    } else if (inst.type === "chat") {
      extraHtml = `
        <div class="md-field"><label>Макс. сообщений</label><input type="number" id="pMaxMessages" min="1" max="20" value="${config.maxMessages || 8}"></div>
        <div class="properties__toggle-row"><label>Показывать бейджи</label>${switchHtml("pShowBadges", config.showBadges !== false)}</div>`;
    } else if (inst.type === "recent") {
      extraHtml = `<div class="md-field"><label>Макс. элементов</label><input type="number" id="pMaxItems" min="1" max="15" value="${config.maxItems || 5}"></div>`;
    } else if (inst.type === "alerts") {
      extraHtml = `
        <div class="properties__hint">Тестовый алерт запустится на реальном оверлее в OBS (и в браузере по ссылке ниже):</div>
        <div class="properties__test-grid">
          <button class="md-button md-button--tonal" data-test="follow">Фоллоу</button>
          <button class="md-button md-button--tonal" data-test="sub">Саб</button>
          <button class="md-button md-button--tonal" data-test="gift_sub">Гифт</button>
          <button class="md-button md-button--tonal" data-test="cheer">Чир</button>
          <button class="md-button md-button--tonal" data-test="donation">Донат</button>
        </div>`;
    } else if (inst.type === "stat") {
      extraHtml = `
        <div class="md-field"><label>Что показывать</label>
          <select id="pStatMetric">
            <option value="followers" ${(config.metric || "followers") === "followers" ? "selected" : ""}>Фолловеры — число (Twitch)</option>
            <option value="subscribers" ${config.metric === "subscribers" ? "selected" : ""}>Подписчики — число (Twitch)</option>
            <option value="latestFollower" ${config.metric === "latestFollower" ? "selected" : ""}>Последний фолловер</option>
            <option value="latestSubscriber" ${config.metric === "latestSubscriber" ? "selected" : ""}>Последний подписчик</option>
            <option value="topDonation" ${config.metric === "topDonation" ? "selected" : ""}>Топ донат сессии</option>
          </select>
        </div>
        <div class="md-field"><label>Подпись (необязательно)</label><input type="text" id="pStatLabel" value="${escapeAttr(config.label || "")}"></div>
        <div class="properties__hint">Фолловеры/подписчики берутся из Twitch — нужно подключить алерты в Настройках.</div>`;
    } else if (inst.type === "social") {
      extraHtml = `
        <div class="md-field"><label>Смена каждые, сек</label><input type="number" id="pRotateSec" min="2" value="${config.rotateIntervalSec || 8}"></div>
        <div class="md-field">
          <label>Соцсети</label>
          <div class="scene-socials-list" id="pSocialsList"></div>
          <button class="md-button md-button--text" id="pAddSocial" style="align-self:flex-start;margin-top:4px;">+ Добавить</button>
        </div>`;
    } else if (inst.type === "custom") {
      const mode = config.mode || "text";
      extraHtml = `
        <div class="md-field"><label>Тип содержимого</label>
          <select id="pCustomMode">
            <option value="text" ${mode === "text" ? "selected" : ""}>Текст</option>
            <option value="image" ${mode === "image" ? "selected" : ""}>Изображение</option>
            <option value="html" ${mode === "html" ? "selected" : ""}>Свой HTML</option>
          </select>
        </div>
        <div id="pCustomFields"></div>`;
    }

    propertiesEl.innerHTML = `
      <div class="properties__toggle-row"><label>Видимость</label>${switchHtml("pVisible", inst.visible)}</div>
      <div class="properties__row">
        <div class="md-field"><label>X %</label><input type="number" id="pX" value="${round1(inst.x)}"></div>
        <div class="md-field"><label>Y %</label><input type="number" id="pY" value="${round1(inst.y)}"></div>
      </div>
      <div class="properties__row">
        <div class="md-field"><label>Ширина %</label><input type="number" id="pW" value="${round1(inst.w)}"></div>
        <div class="md-field"><label>Высота %</label><input type="number" id="pH" value="${round1(inst.h)}"></div>
      </div>
      ${extraHtml}
      <div class="properties__delete"><button class="md-button md-button--text" id="pDeleteBtn">${ICONS.trash} Удалить</button></div>`;

    [["pX", "x"], ["pY", "y"], ["pW", "w"], ["pH", "h"]].forEach(([id, key]) => {
      propertiesEl.querySelector("#" + id).addEventListener("change", (e) => {
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { [key]: Number(e.target.value) } });
      });
    });
    wireSwitch(propertiesEl.querySelector("#pVisible"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { visible: on } }));

    if (inst.type === "goal") {
      propertiesEl.querySelector("#pGoalTitle").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { title: e.target.value }));
      propertiesEl.querySelector("#pGoalCurrent").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { current: Number(e.target.value) }));
      propertiesEl.querySelector("#pGoalTarget").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { target: Number(e.target.value) }));
      propertiesEl.querySelector("#pGoalCurrency").addEventListener("change", (e) => send(EVENT_TYPES.CMD_SET_GOAL, { currency: e.target.value }));
      wireSwitch(propertiesEl.querySelector("#pShowPercent"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showPercentage: on } } }));
    } else if (inst.type === "chat") {
      propertiesEl.querySelector("#pMaxMessages").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { maxMessages: Number(e.target.value) } } }));
      wireSwitch(propertiesEl.querySelector("#pShowBadges"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showBadges: on } } }));
    } else if (inst.type === "recent") {
      propertiesEl.querySelector("#pMaxItems").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { maxItems: Number(e.target.value) } } }));
    } else if (inst.type === "alerts") {
      propertiesEl.querySelectorAll("[data-test]").forEach((btn) => btn.addEventListener("click", () => send(EVENT_TYPES.CMD_TEST_ALERT, { kind: btn.dataset.test })));
    } else if (inst.type === "stat") {
      propertiesEl.querySelector("#pStatMetric").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { metric: e.target.value } } }));
      propertiesEl.querySelector("#pStatLabel").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { label: e.target.value } } }));
    } else if (inst.type === "social") {
      propertiesEl.querySelector("#pRotateSec").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { rotateIntervalSec: Number(e.target.value) } } }));
      wireWidgetSocialsList(inst, config.socials || []);
      propertiesEl.querySelector("#pAddSocial").addEventListener("click", () => {
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { socials: [...(config.socials || []), { platform: "", text: "" }] } } });
      });
    } else if (inst.type === "custom") {
      wireCustomWidgetFields(inst, config);
      document.getElementById("pCustomMode").addEventListener("change", (e) => {
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { mode: e.target.value } } });
      });
    }

    document.getElementById("pDeleteBtn").addEventListener("click", () => {
      if (!confirm(`Удалить виджет «${def.label || inst.type}»?`)) return;
      send(EVENT_TYPES.CMD_REMOVE_WIDGET, { id: inst.id });
      selectedId = null;
    });
  }

  function wireWidgetSocialsList(inst, socials) {
    const host = document.getElementById("pSocialsList");
    host.innerHTML = socials
      .map(
        (s, i) => `
      <div class="scene-social-row">
        <input type="text" class="platform" data-idx="${i}" data-field="platform" value="${escapeAttr(s.platform)}" maxlength="4">
        <input type="text" class="text" data-idx="${i}" data-field="text" value="${escapeAttr(s.text)}">
        <button class="layer-row__btn" data-action="remove-social" data-idx="${i}" title="Удалить">${ICONS.trash}</button>
      </div>`
      )
      .join("");
    host.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("change", () => {
        const idx = Number(inp.dataset.idx);
        const field = inp.dataset.field;
        const newSocials = socials.map((s, i) => (i === idx ? { ...s, [field]: inp.value } : s));
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { socials: newSocials } } });
      });
    });
    host.querySelectorAll('[data-action="remove-social"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const newSocials = socials.filter((_, i) => i !== idx);
        send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { socials: newSocials } } });
      });
    });
  }

  function wireCustomWidgetFields(inst, config) {
    const mode = config.mode || "text";
    const host = document.getElementById("pCustomFields");
    if (mode === "image") {
      host.innerHTML = `
        <div class="md-field"><label>URL изображения</label><input type="text" id="pImageUrl" value="${escapeAttr(config.imageUrl || "")}" placeholder="https://..."></div>
        <div class="md-field"><label>Вписывание</label>
          <select id="pImageFit">
            <option value="contain" ${config.imageFit !== "cover" ? "selected" : ""}>Целиком (contain)</option>
            <option value="cover" ${config.imageFit === "cover" ? "selected" : ""}>Заполнить (cover)</option>
          </select>
        </div>`;
      host.querySelector("#pImageUrl").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { imageUrl: e.target.value.trim() } } }));
      host.querySelector("#pImageFit").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { imageFit: e.target.value } } }));
    } else if (mode === "html") {
      host.innerHTML = `
        <div class="md-field"><label>Свой HTML</label>
          <textarea id="pCustomHtml" rows="8" style="font-family:var(--font-mono);font-size:12px;background:var(--md-surface-container-highest);color:var(--md-on-surface);border:1px solid var(--md-outline-variant);border-radius:var(--shape-sm);padding:10px;width:100%;resize:vertical">${escapeHtml(config.html || "")}</textarea>
        </div>
        <div class="properties__hint">Рендерится как есть — свои теги, стили, дефисы CSS-переменных темы (var(--md-primary) и т.д.) тоже работают.</div>`;
      host.querySelector("#pCustomHtml").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { html: e.target.value } } }));
    } else {
      host.innerHTML = `
        <div class="md-field"><label>Заголовок (необязательно)</label><input type="text" id="pTextTitle" value="${escapeAttr(config.textTitle || "")}"></div>
        <div class="md-field"><label>Текст</label><input type="text" id="pTextBody" value="${escapeAttr(config.text || "")}"></div>
        <div class="properties__row">
          <div class="md-field"><label>Выравнивание</label>
            <select id="pTextAlign">
              <option value="left" ${config.textAlign === "left" ? "selected" : ""}>Слева</option>
              <option value="center" ${config.textAlign !== "left" && config.textAlign !== "right" ? "selected" : ""}>По центру</option>
              <option value="right" ${config.textAlign === "right" ? "selected" : ""}>Справа</option>
            </select>
          </div>
          <div class="md-field"><label>Размер</label>
            <select id="pTextSize">
              <option value="small" ${config.textSize === "small" ? "selected" : ""}>Малый</option>
              <option value="medium" ${config.textSize !== "small" && config.textSize !== "large" ? "selected" : ""}>Средний</option>
              <option value="large" ${config.textSize === "large" ? "selected" : ""}>Крупный</option>
            </select>
          </div>
        </div>
        <div class="properties__toggle-row"><label>Фон-карточка</label>${switchHtml("pShowBg", config.showBackground !== false)}</div>`;
      host.querySelector("#pTextTitle").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { textTitle: e.target.value } } }));
      host.querySelector("#pTextBody").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { text: e.target.value } } }));
      host.querySelector("#pTextAlign").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { textAlign: e.target.value } } }));
      host.querySelector("#pTextSize").addEventListener("change", (e) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { textSize: e.target.value } } }));
      wireSwitch(host.querySelector("#pShowBg"), (on) => send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { config: { showBackground: on } } }));
    }
  }

  // ---- status chips ----
  const STATUS_LABEL = { twitchChat: "Twitch чат", twitchEvents: "Twitch алерты", donationAlerts: "DonationAlerts" };
  const STATUS_TEXT = { connected: "подключено", connecting: "подключение…", disconnected: "отключено", error: "ошибка", not_configured: "не настроено" };

  function statusClass(status) {
    if (status === "connected") return "is-connected";
    if (status === "error") return "is-error";
    if (status === "connecting") return "is-pending";
    return "";
  }

  function renderStatusChips() {
    statusChipsEl.innerHTML = Object.entries(connectionStatus)
      .map(([service, status]) => `<span class="md-chip ${statusClass(status)}"><span class="md-chip__dot"></span>${STATUS_LABEL[service] || service}</span>`)
      .join("");
  }

  function updateSettingsChips() {
    ["twitchChat", "twitchEvents", "donationAlerts"].forEach((service) => {
      const el = document.getElementById("chip-" + service);
      if (!el) return;
      const status = connectionStatus[service];
      el.className = "md-chip " + statusClass(status);
      el.querySelector(".md-chip__label").textContent = `${STATUS_LABEL[service]}: ${STATUS_TEXT[status] || status || "—"}`;
    });
  }

  // ---- settings view ----
  function populateSettings() {
    twitchChannelInput.value = twitchChannel || "";
    twitchClientIdInput.value = twitchClientId || "";
    daClientIdInput.value = daClientId || "";
    appPortInput.value = port;
    appOverlayUrlInput.value = overlayUrl;
    twitchRedirectUriEl.textContent = `http://localhost:${port}/oauth/twitch/callback`;
    daRedirectUriEl.textContent = `http://localhost:${port}/oauth/donationalerts/callback`;
  }

  twitchChannelInput.addEventListener("change", () => {
    send(EVENT_TYPES.CMD_SET_APP_CONFIG, { twitchChannel: twitchChannelInput.value.trim() });
  });

  document.getElementById("connectTwitchBtn").addEventListener("click", () => {
    window.desktop?.connectTwitch({
      clientId: twitchClientIdInput.value.trim(),
      clientSecret: twitchClientSecretInput.value.trim(),
      channel: twitchChannelInput.value.trim(),
    });
  });
  document.getElementById("connectDaBtn").addEventListener("click", () => {
    window.desktop?.connectDonationAlerts({
      clientId: daClientIdInput.value.trim(),
      clientSecret: daClientSecretInput.value.trim(),
    });
  });
  document.getElementById("openTwitchConsole").addEventListener("click", () => window.desktop?.openExternal("https://dev.twitch.tv/console/apps"));
  document.getElementById("openDaConsole").addEventListener("click", () => window.desktop?.openExternal("https://www.donationalerts.com/application/clients"));
  document.getElementById("resetLayoutBtn").addEventListener("click", () => {
    if (!confirm("Удалить текущую раскладку и восстановить виджеты по умолчанию?")) return;
    layout.forEach((w) => send(EVENT_TYPES.CMD_REMOVE_WIDGET, { id: w.id }));
    ["recent", "alerts", "goal", "chat"].forEach((type) => send(EVENT_TYPES.CMD_ADD_WIDGET, { type }));
    selectedId = null;
  });

  // ---- appearance: theme picker + custom theme editor ----

  function renderThemeGrid() {
    themeGridEl.innerHTML = "";
    (appearance.themes || []).forEach((theme) => {
      const card = document.createElement("div");
      card.className = "theme-swatch" + (theme.id === appearance.activeThemeId ? " is-active" : "");
      const dotColors = theme.builtin
        ? BuiltinThemes.BUILTIN_THEMES[theme.id].tokens
        : null;
      const dots = theme.builtin
        ? [dotColors["--md-primary"], dotColors["--md-secondary"], dotColors["--md-tertiary"]]
        : theme.seeds
        ? [theme.seeds.primary, theme.seeds.secondary, theme.seeds.tertiary]
        : ["#888", "#888", "#888"];
      card.innerHTML = `
        <div class="theme-swatch__dots">${dots.map((c) => `<span class="theme-swatch__dot" style="background:${c}"></span>`).join("")}</div>
        <div class="theme-swatch__row">
          <span class="theme-swatch__name">${escapeHtml(theme.name)}</span>
          ${
            theme.builtin
              ? ""
              : `<span class="layer-row__btns">
                  <button class="theme-swatch__btn" data-action="edit" title="Изменить">✎</button>
                  <button class="theme-swatch__btn" data-action="delete" title="Удалить">${ICONS.trash}</button>
                </span>`
          }
        </div>`;
      card.addEventListener("click", (e) => {
        if (e.target.closest("[data-action]")) return;
        send(EVENT_TYPES.CMD_SET_ACTIVE_THEME, { id: theme.id });
      });
      if (!theme.builtin) {
        card.querySelector('[data-action="edit"]').addEventListener("click", (e) => {
          e.stopPropagation();
          openThemeEditor(theme);
        });
        card.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
          e.stopPropagation();
          if (confirm(`Удалить тему «${theme.name}»?`)) send(EVENT_TYPES.CMD_DELETE_CUSTOM_THEME, { id: theme.id });
        });
      }
      themeGridEl.appendChild(card);
    });
  }

  function openThemeEditor(theme) {
    editingThemeId = theme ? theme.id : null;
    const seeds = theme && theme.seeds
      ? theme.seeds
      : { primary: "#c6b8ff", secondary: "#7ee0d6", tertiary: "#ffb0d8", surfaceSeed: "#8878c8", shapeMode: "rounded", fontPreset: "nebula" };

    themeEditorEl.hidden = false;
    themeEditorEl.innerHTML = `
      <div class="md-field"><label>Название темы</label><input type="text" id="themeName" value="${escapeAttr(theme ? theme.name : "Моя тема")}"></div>
      <div class="theme-editor__colors">
        <div class="theme-editor__color"><label>Основной</label><input type="color" id="seedPrimary" value="${seeds.primary}"></div>
        <div class="theme-editor__color"><label>Второй</label><input type="color" id="seedSecondary" value="${seeds.secondary}"></div>
        <div class="theme-editor__color"><label>Третий</label><input type="color" id="seedTertiary" value="${seeds.tertiary}"></div>
        <div class="theme-editor__color"><label>Фон</label><input type="color" id="seedSurface" value="${seeds.surfaceSeed}"></div>
      </div>
      <div class="theme-editor__row">
        <div class="md-field"><label>Форма панелей</label>
          <select id="seedShape">
            <option value="rounded" ${seeds.shapeMode !== "angular" ? "selected" : ""}>Скруглённая</option>
            <option value="angular" ${seeds.shapeMode === "angular" ? "selected" : ""}>Угловатая (HUD)</option>
          </select>
        </div>
        <div class="md-field"><label>Шрифты</label>
          <select id="seedFont">
            <option value="nebula" ${seeds.fontPreset !== "star-citizen" ? "selected" : ""}>Roboto (Material You)</option>
            <option value="star-citizen" ${seeds.fontPreset === "star-citizen" ? "selected" : ""}>Rajdhani / Titillium Web</option>
          </select>
        </div>
      </div>
      <div class="settings__actions">
        <button class="md-button md-button--filled" id="saveThemeBtn">Сохранить тему</button>
        <button class="md-button md-button--text" id="cancelThemeBtn">Отмена</button>
      </div>`;

    const previewFromForm = () => {
      const liveSeeds = {
        primary: document.getElementById("seedPrimary").value,
        secondary: document.getElementById("seedSecondary").value,
        tertiary: document.getElementById("seedTertiary").value,
        surfaceSeed: document.getElementById("seedSurface").value,
        shapeMode: document.getElementById("seedShape").value,
        fontPreset: document.getElementById("seedFont").value,
      };
      applyThemeToCanvas(ThemeEngine.buildThemeTokens(liveSeeds));
      return liveSeeds;
    };
    themeEditorEl.querySelectorAll("input, select").forEach((el) => el.addEventListener("input", previewFromForm));

    document.getElementById("saveThemeBtn").addEventListener("click", () => {
      const liveSeeds = previewFromForm();
      send(EVENT_TYPES.CMD_SAVE_CUSTOM_THEME, {
        id: editingThemeId,
        name: document.getElementById("themeName").value.trim() || "Моя тема",
        seeds: liveSeeds,
      });
      closeThemeEditor();
    });
    document.getElementById("cancelThemeBtn").addEventListener("click", closeThemeEditor);

    themeEditorEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closeThemeEditor() {
    editingThemeId = null;
    themeEditorEl.hidden = true;
    themeEditorEl.innerHTML = "";
    applyThemeToCanvas(appearance.tokens); // revert live-preview back to the actually active theme
  }

  newThemeBtn.addEventListener("click", () => openThemeEditor(null));

  // ---- export / import ----

  function showExportImportStatus(text, isError) {
    exportImportStatus.hidden = false;
    exportImportStatus.textContent = text;
    exportImportStatus.style.color = isError ? "var(--md-error)" : "";
  }

  exportConfigBtn.textContent = "Экспортировать в файл";
  exportConfigBtn.addEventListener("click", async () => {
    const res = await window.desktop?.exportConfig();
    if (!res) return;
    if (res.canceled) return;
    if (res.ok) showExportImportStatus(`Сохранено: ${res.filePath}`, false);
    else showExportImportStatus(`Не удалось экспортировать: ${res.error}`, true);
  });

  importConfigBtn.textContent = "Импортировать из файла";
  importConfigBtn.addEventListener("click", async () => {
    if (!confirm("Импорт заменит текущие раскладку, темы, цель и настройки подключений. Продолжить?")) return;
    const res = await window.desktop?.importConfig();
    if (!res) return;
    if (res.canceled) return;
    if (res.ok) {
      showExportImportStatus("Настройки импортированы", false);
      selectedId = null;
    } else {
      showExportImportStatus(`Не удалось импортировать: ${res.error}`, true);
    }
  });

  // ---- scenes ----

  function sceneUrl(id) {
    return `http://localhost:${port}/overlay/scene.html?type=${id}`;
  }

  function renderScenesNav() {
    scenesNavListEl.innerHTML = "";
    Object.values(SceneCatalog.SCENE_DEFS).forEach((def) => {
      const card = document.createElement("div");
      card.className = "library-card" + (def.id === activeSceneId ? " is-active" : "");
      card.innerHTML = `<span class="library-card__icon">${ICONS[def.icon] || ""}</span><span class="library-card__text"><span class="library-card__label">${def.label}</span></span>`;
      card.addEventListener("click", () => selectScene(def.id));
      scenesNavListEl.appendChild(card);
    });
  }

  function selectScene(id) {
    activeSceneId = id;
    const url = sceneUrl(id);
    if (scenesPreviewFrame.src !== url) scenesPreviewFrame.src = url;
    sceneUrlLabel.textContent = url;
    renderScenesNav();
    renderSceneForm();
  }

  function sendSceneUpdate(patch) {
    send(EVENT_TYPES.CMD_SET_SCENE_CONFIG, { sceneId: activeSceneId, patch });
  }

  function renderSceneForm() {
    const scene = scenes[activeSceneId];
    if (!scene) return;
    const def = SceneCatalog.SCENE_DEFS[activeSceneId];
    sceneFormTitle.textContent = def.label;

    sceneFormEl.innerHTML = `
      <div class="md-field"><label>Статус-плашка</label><input type="text" id="sStatusLabel" value="${escapeAttr(scene.statusLabel)}"></div>
      <div class="md-field"><label>Заголовок</label><input type="text" id="sTitle" value="${escapeAttr(scene.title)}"></div>
      <div class="md-field"><label>Подзаголовок</label><input type="text" id="sSubtitle" value="${escapeAttr(scene.subtitle)}"></div>
      <div class="properties__toggle-row"><label>Таймер</label>${switchHtml("sShowTimer", scene.showTimer)}</div>
      <div class="md-field"><label>Длительность таймера, сек</label><input type="number" id="sTimerDuration" min="0" value="${scene.timerDuration}"></div>
      <div class="md-field"><label>Текст по окончании таймера</label><input type="text" id="sTimerDoneText" value="${escapeAttr(scene.timerDoneText || "")}"></div>
      <div class="properties__toggle-row"><label>Последние события</label>${switchHtml("sShowEvents", scene.showEvents)}</div>
      <div class="properties__toggle-row"><label>Соцсети</label>${switchHtml("sShowSocials", scene.showSocials)}</div>
      <div class="md-field">
        <label>Соцсети</label>
        <div class="scene-socials-list" id="sSocialsList"></div>
        <button class="md-button md-button--text" id="sAddSocial" style="align-self:flex-start;margin-top:4px;">+ Добавить</button>
      </div>
      <div class="inspector__title" style="margin-top:4px;">Топ донат сессии</div>
      <div class="properties__hint">${topDonation.amount > 0 ? `${escapeHtml(topDonation.user)} — ${formatMoney(topDonation.amount)} ${escapeHtml(currencySymbol(topDonation.currency))}` : "Пока нет донатов"}</div>
      <button class="md-button md-button--outlined" id="sResetTopDonation">Сбросить топ донат</button>
    `;

    renderSocialsList(scene.socials || []);

    sceneFormEl.querySelector("#sStatusLabel").addEventListener("change", (e) => sendSceneUpdate({ statusLabel: e.target.value }));
    sceneFormEl.querySelector("#sTitle").addEventListener("change", (e) => sendSceneUpdate({ title: e.target.value }));
    sceneFormEl.querySelector("#sSubtitle").addEventListener("change", (e) => sendSceneUpdate({ subtitle: e.target.value }));
    sceneFormEl.querySelector("#sTimerDuration").addEventListener("change", (e) => sendSceneUpdate({ timerDuration: Number(e.target.value) }));
    sceneFormEl.querySelector("#sTimerDoneText").addEventListener("change", (e) => sendSceneUpdate({ timerDoneText: e.target.value }));
    wireSwitch(sceneFormEl.querySelector("#sShowTimer"), (on) => sendSceneUpdate({ showTimer: on }));
    wireSwitch(sceneFormEl.querySelector("#sShowEvents"), (on) => sendSceneUpdate({ showEvents: on }));
    wireSwitch(sceneFormEl.querySelector("#sShowSocials"), (on) => sendSceneUpdate({ showSocials: on }));
    sceneFormEl.querySelector("#sAddSocial").addEventListener("click", () => {
      sendSceneUpdate({ socials: [...(scene.socials || []), { platform: "", text: "" }] });
    });
    sceneFormEl.querySelector("#sResetTopDonation").addEventListener("click", () => {
      if (confirm("Сбросить топ донат сессии?")) send(EVENT_TYPES.CMD_RESET_TOP_DONATION, {});
    });
  }

  function renderSocialsList(socials) {
    const host = document.getElementById("sSocialsList");
    host.innerHTML = socials
      .map(
        (s, i) => `
      <div class="scene-social-row">
        <input type="text" class="platform" data-idx="${i}" data-field="platform" value="${escapeAttr(s.platform)}" maxlength="4">
        <input type="text" class="text" data-idx="${i}" data-field="text" value="${escapeAttr(s.text)}">
        <button class="layer-row__btn" data-action="remove-social" data-idx="${i}" title="Удалить">${ICONS.trash}</button>
      </div>`
      )
      .join("");
    host.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("change", () => {
        const idx = Number(inp.dataset.idx);
        const field = inp.dataset.field;
        sendSceneUpdate({ socials: socials.map((s, i) => (i === idx ? { ...s, [field]: inp.value } : s)) });
      });
    });
    host.querySelectorAll('[data-action="remove-social"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        sendSceneUpdate({ socials: socials.filter((_, i) => i !== idx) });
      });
    });
  }

  copySceneUrlBtn.textContent = "Скопировать URL для OBS";
  copySceneUrlBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(sceneUrl(activeSceneId));
    copySceneUrlBtn.textContent = "Скопировано!";
    setTimeout(() => (copySceneUrlBtn.textContent = "Скопировать URL для OBS"), 1400);
  });

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.textContent = "Копировать";
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.copy);
      navigator.clipboard.writeText(target.textContent);
      btn.textContent = "Скопировано!";
      setTimeout(() => (btn.textContent = "Копировать"), 1400);
    });
  });

  obsUrlLabel.textContent = overlayUrl;
  copyUrlBtn.textContent = "Скопировать URL для OBS";
  copyUrlBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(overlayUrl);
    copyUrlBtn.textContent = "Скопировано!";
    setTimeout(() => (copyUrlBtn.textContent = "Скопировать URL для OBS"), 1400);
  });

  // ---- websocket ----
  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE:
        layout = msg.payload.layout || [];
        goal = msg.payload.goal;
        twitchChannel = msg.payload.twitchChannel;
        twitchClientId = msg.payload.twitchClientId;
        daClientId = msg.payload.donationAlertsClientId;
        connectionStatus = msg.payload.connectionStatus || {};
        appearance = msg.payload.appearance || appearance;
        editorPrefs = msg.payload.editor || editorPrefs;
        scenes = msg.payload.scenes || scenes;
        topDonation = msg.payload.topDonation || topDonation;
        stats = msg.payload.stats || stats;
        gridSizeSelect.value = String(editorPrefs.gridSize || 0);
        applyThemeToCanvas(appearance.tokens);
        applyGridToCanvas();
        renderThemeGrid();
        renderLibrary();
        renderCanvas();
        renderLayers();
        renderProperties();
        renderStatusChips();
        updateSettingsChips();
        populateSettings();
        selectScene(activeSceneId);
        break;
      case EVENT_TYPES.LAYOUT_UPDATE:
        handleLayoutUpdate(msg.payload.layout || []);
        break;
      case EVENT_TYPES.THEME_UPDATE:
        appearance = msg.payload;
        if (!editingThemeId) applyThemeToCanvas(appearance.tokens);
        renderThemeGrid();
        renderCanvas();
        break;
      case EVENT_TYPES.EDITOR_PREFS_UPDATE:
        editorPrefs = msg.payload;
        gridSizeSelect.value = String(editorPrefs.gridSize || 0);
        applyGridToCanvas();
        break;
      case EVENT_TYPES.SCENES_UPDATE:
        scenes = msg.payload;
        renderSceneForm();
        break;
      case EVENT_TYPES.TOP_DONATION_UPDATE:
        topDonation = msg.payload;
        renderSceneForm();
        renderCanvas();
        break;
      case EVENT_TYPES.STAT_UPDATE:
        stats = msg.payload;
        renderCanvas();
        break;
      case EVENT_TYPES.GOAL_UPDATE:
        goal = msg.payload;
        renderCanvas();
        renderProperties();
        break;
      case EVENT_TYPES.CONNECTION_STATUS:
        connectionStatus[msg.payload.service] = msg.payload.status;
        renderStatusChips();
        updateSettingsChips();
        break;
      default:
        break; // ALERT / CHAT_MESSAGE / RECENT_EVENT are for the overlay, not the editor
    }
  }

  function handleLayoutUpdate(newLayout) {
    layout = newLayout;
    if (pendingAdd) {
      const newItem = layout.find((w) => !pendingAdd.knownIds.has(w.id));
      if (newItem) {
        if (pendingAdd.dropXY) {
          const x = clamp(pendingAdd.dropXY.x - newItem.w / 2, 0, 100 - newItem.w);
          const y = clamp(pendingAdd.dropXY.y - newItem.h / 2, 0, 100 - newItem.h);
          send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: newItem.id, patch: { x: round1(x), y: round1(y) } });
        }
        selectedId = newItem.id;
      }
      pendingAdd = null;
    }
    if (selectedId && !layout.find((w) => w.id === selectedId)) selectedId = null;
    renderCanvas();
    renderLayers();
    renderProperties();
  }

  function connect() {
    ws = new WebSocket(wsUrl);
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
