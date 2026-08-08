(function () {
  const params = new URLSearchParams(location.search);
  const version = params.get("version");
  const subtitleEl = document.getElementById("subtitle");
  if (subtitleEl) subtitleEl.textContent = version ? `Desktop // v${version}` : "Desktop";

  const logs = [">> PARSING GRID SYSTEM CONFIG...", ">> INJECTING MATERIAL DESIGN TOKENS...", ">> PREPARING CONTROL PANEL...", "[SUCCESS] STREAM WORKSPACE IS READY"];
  let currentLog = 0;
  const logBox = document.getElementById("logBox");

  const interval = setInterval(() => {
    if (currentLog < logs.length) {
      const line = document.createElement("div");
      line.className = currentLog === logs.length - 1 ? "log-line success" : "log-line";
      line.textContent = logs[currentLog];
      logBox.appendChild(line);

      if (logBox.children.length > 4) {
        logBox.removeChild(logBox.children[0]);
      }
      currentLog++;
    } else {
      clearInterval(interval);
    }
  }, 800);
})();
