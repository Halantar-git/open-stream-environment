(function () {
  const { EVENT_TYPES } = window.SharedEvents;
  const params = new URLSearchParams(location.search);
  const port = params.get("port") || "8710";

  const chatListEl = document.getElementById("chatList");
  const channelLabelEl = document.getElementById("channelLabel");
  const statusChipEl = document.getElementById("statusChip");
  const statusLabelEl = document.getElementById("statusLabel");
  const jumpBtn = document.getElementById("jumpToLatest");

  const MAX_ROWS = 300;
  let atBottom = true;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }
  function formatTime(d) {
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  function isNearBottom() {
    return chatListEl.scrollHeight - chatListEl.scrollTop - chatListEl.clientHeight < 60;
  }
  chatListEl.addEventListener("scroll", () => {
    atBottom = isNearBottom();
    if (atBottom) jumpBtn.hidden = true;
  });
  jumpBtn.addEventListener("click", () => {
    chatListEl.scrollTop = chatListEl.scrollHeight;
    jumpBtn.hidden = true;
    atBottom = true;
  });

  function clearEmptyState() {
    const empty = chatListEl.querySelector(".chat-list__empty");
    if (empty) empty.remove();
  }

  function pushMessage(msg) {
    clearEmptyState();
    const row = document.createElement("div");
    row.className = "chat-row";
    const badges = (msg.badges || [])
      .slice(0, 3)
      .map((b) => `<span class="chat-row__badge" data-role="${escapeAttr(String(b))}">${escapeHtml(String(b).slice(0, 1).toUpperCase())}</span>`)
      .join("");
    row.innerHTML = `${badges}<span class="chat-row__user" style="color:${escapeAttr(msg.color || "#c9c1d6")}">${escapeHtml(msg.user)}</span><span class="chat-row__colon">:</span><span class="chat-row__text">${escapeHtml(msg.message)}</span><span class="chat-row__time">${formatTime(new Date())}</span>`;
    chatListEl.appendChild(row);
    while (chatListEl.children.length > MAX_ROWS) chatListEl.removeChild(chatListEl.firstChild);

    if (atBottom) {
      chatListEl.scrollTop = chatListEl.scrollHeight;
    } else {
      jumpBtn.hidden = false;
    }
  }

  const STATUS_TEXT = { connected: "подключено", connecting: "подключение…", disconnected: "отключено", error: "ошибка", not_configured: "не настроено" };
  function statusClass(status) {
    if (status === "connected") return "is-connected";
    if (status === "error") return "is-error";
    if (status === "connecting") return "is-pending";
    return "";
  }
  function setStatus(status) {
    statusChipEl.className = "md-chip " + statusClass(status);
    statusLabelEl.textContent = STATUS_TEXT[status] || status || "—";
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case EVENT_TYPES.STATE:
        channelLabelEl.textContent = msg.payload.twitchChannel || "—";
        setStatus((msg.payload.connectionStatus || {}).twitchChat);
        break;
      case EVENT_TYPES.CHAT_MESSAGE:
        pushMessage(msg.payload);
        break;
      case EVENT_TYPES.CONNECTION_STATUS:
        if (msg.payload.service === "twitchChat") setStatus(msg.payload.status);
        break;
      default:
        break;
    }
  }

  function connect() {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
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

  chatListEl.innerHTML = '<div class="chat-list__empty">Пока нет сообщений</div>';
  connect();
})();
