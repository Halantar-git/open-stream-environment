/*
  Retrowave background — процедурный закатный пейзаж сцен.

  Слои рисуются на canvas: небо со звёздами и облаками, полосатое солнце,
  дальний хребет и уходящая к горизонту сетка с горами-каркасом. Камера
  медленно летит вперёд, поэтому сетка и горы движутся к зрителю — фон живёт
  без картинок и спрайтов, только шум и проекция.

  Почему так, а не CSS-слоями: у гор должны быть склоны и перспектива, а у
  дороги — сходящиеся к точке схода кромки. На canvas это одна сетка высот,
  которую проецирует та же формула, что и пол; CSS-градиенты такого не дают.
  Шум детерминированный (хеш от координат), поэтому кадр воспроизводим и не
  зависит от Math.random.

  Скрипт работает только на сценах и только в теме Retrowave. Заставка
  (`splash-bg`) остаётся со своей неоновой комнатой: её этот фон не трогает.
  При `prefers-reduced-motion` рисуется один статичный кадр.
*/
(function () {
  "use strict";

  const wrapper = document.querySelector(".scene-wrapper");
  if (!wrapper || wrapper.classList.contains("splash-bg")) return;

  const canvas = document.createElement("canvas");
  canvas.className = "retrowave-background";
  canvas.setAttribute("aria-hidden", "true");
  wrapper.insertBefore(canvas, wrapper.firstChild);

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return;

  // 60 FPS: камера летит непрерывно, и на 30 сетка заметно дёргается.
  // Расчёт сетки высот при этом укладывается в кадр; при скрытой сцене
  // цикл всё равно останавливается.
  const FPS = 60;
  const DPR_LIMIT = 1.5;
  const SPEED = 1;
  const STARS = 240;

  // --- геометрия сцены (мировые единицы) ---
  const COLS = 80;
  const ROWS = 44;
  const XW = 60;
  const DZ = 1.7;
  const ZN = 3;
  const CAMY = 3;
  const ROAD = 6;
  const AMP = 24;
  const ZFAR = ZN + ROWS * DZ;
  const COLORS = [
    [40, 210, 255],
    [90, 140, 255],
    [170, 90, 255],
    [255, 70, 215],
  ];

  let W = 2;
  let H = 2;
  let hy = 1;
  let f = 1;
  let U = 1;
  let stars = [];
  const PX = new Float32Array((ROWS + 1) * (COLS + 1));
  const PY = new Float32Array((ROWS + 1) * (COLS + 1));
  const PH = new Float32Array((ROWS + 1) * (COLS + 1));
  const Z = new Float32Array(ROWS + 1);
  const sunCache = document.createElement("canvas");

  let rafId = 0;
  let lastFrame = 0;
  let time = 0;
  let camZ = 0;
  let running = false;

  // Панель показывает сцену в iframe для превью. Там фон должен быть
  // статичным: второй анимированный canvas на той же машине отнимает
  // CPU/GPU у источника OBS и делает его дёрганым.
  const PREVIEW = new URLSearchParams(location.search).has("preview");

  const motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  // --- шум ---

  function hash(ix, iy) {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function vnoise(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  function smooth(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /*
    Горы: в каждой ячейке мира 1–2 купола разного размера. Основания
    перекрываются, поэтому получаются хребты и сёдла, а не отдельные холмы.
    Вдоль дороги высота нулевая — это ровный коридор к точке схода.
  */
  const CELL = 16;
  const FOOT = 0.28;

  function height(x, zw, z) {
    const ax = Math.abs(x);
    if (ax < ROAD) return 0;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(zw / CELL);
    let first = 0;
    let second = 0;
    for (let di = -1; di <= 1; di += 1) {
      for (let dj = -1; dj <= 1; dj += 1) {
        const ci = cx + di;
        const cj = cz + dj;
        for (let k = 0; k < 2; k += 1) {
          const salt = k * 57;
          if (hash(ci + 31 + salt, cj + 17) < (k ? 0.4 : 0.1)) continue;
          const r1 = hash(ci * 2 + 1 + salt, cj);
          const r2 = hash(ci + salt, cj * 2 + 7);
          const r3 = hash(ci + 13 + salt, cj + 5);
          const radius = CELL * (k ? 0.55 : 0.8) * (0.8 + 0.5 * r3);
          const mx = (ci + 0.1 + 0.8 * r1) * CELL;
          const mz = (cj + 0.1 + 0.8 * r2) * CELL;
          if (Math.abs(mx) < ROAD + radius * 0.6) continue;
          const d = Math.hypot(x - mx, zw - mz) / radius;
          if (d >= 1) continue;
          const h = Math.pow(1 - d * d, 1.15) * ((k ? 0.5 : 0.65) + 0.35 * r3);
          if (h > first) {
            second = first;
            first = h;
          } else if (h > second) {
            second = h;
          }
        }
      }
    }
    // Мягкая неровность склонов: без острых гребней, как у референса.
    const cut = 0.86 + 0.24 * vnoise(x * 0.3, zw * 0.3);
    const mountain = Math.min(1, first + 0.3 * second) * cut;
    // Предгорья заполняют долины между горами и поднимаются от края дороги.
    const offset = x < 0 ? 100 : 0;
    const f1 = smooth(0.3, 0.85, vnoise(x * 0.085 + offset, zw * 0.085 + 200));
    const f2 = vnoise(x * 0.2 + offset, zw * 0.2 + 300);
    const foot = (0.75 * f1 + 0.25 * f2) * FOOT * smooth(ROAD, ROAD + 12, ax);
    const total = mountain + foot * (1 - mountain);
    const near = 0.45 + 0.55 * smooth(5, 20, z);
    return total * AMP * near * smooth(ROAD, ROAD + 3, ax);
  }

  function resize() {
    const dpr = Math.min(DPR_LIMIT, window.devicePixelRatio || 1);
    W = canvas.width = Math.max(2, Math.round((canvas.clientWidth || 2) * dpr));
    H = canvas.height = Math.max(2, Math.round((canvas.clientHeight || 2) * dpr));
    hy = H * 0.55;
    f = ((H - hy) * ZN) / CAMY;
    U = H / 900;
  }

  function makeStars() {
    stars = [];
    for (let i = 0; i < STARS; i += 1) {
      stars.push({
        x: Math.random(),
        y: Math.random(),
        r: 0.6 + Math.random() * 1.2,
        p: Math.random() * 6.28,
        sp: 0.6 + Math.random() * 2,
      });
    }
  }

  // --- слои ---

  function cloud(x, y, rx, ry, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(rx, ry);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    gradient.addColorStop(0, `rgba(255,60,190,${alpha})`);
    gradient.addColorStop(1, "rgba(255,60,190,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, 7);
    ctx.fill();
    ctx.restore();
  }

  function drawSky(t) {
    const gradient = ctx.createLinearGradient(0, 0, 0, hy);
    gradient.addColorStop(0, "#0d0524");
    gradient.addColorStop(0.35, "#2a0a55");
    gradient.addColorStop(0.7, "#7a1a8a");
    gradient.addColorStop(1, "#e0209f");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, hy + 1);

    for (const star of stars) {
      const y = star.y * hy * 0.82;
      const alpha =
        (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * star.sp + star.p))) * (1 - star.y * star.y * 0.75);
      ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      const r = Math.max(1, star.r * U);
      ctx.fillRect(star.x * W, y, r, r);
    }

    const drift = Math.sin(t * 0.07) * W * 0.012;
    cloud(W * 0.85 + drift, H * 0.3, W * 0.22, H * 0.07, 0.45);
    cloud(W * 0.7 - drift, H * 0.37, W * 0.18, H * 0.05, 0.35);
    cloud(W * 0.1 + drift, H * 0.33, W * 0.14, H * 0.06, 0.3);
  }

  function drawSun(t) {
    const radius = H * 0.168;
    const cx = W * 0.49;
    const cy = H * 0.335 + Math.sin(t * 0.4) * H * 0.002;
    const pulse = 0.92 + 0.08 * Math.sin(t * 0.9);
    const glow = ctx.createRadialGradient(cx, cy, radius * 0.7, cx, cy, radius * 3.2);
    glow.addColorStop(0, `rgba(255,60,190,${0.65 * pulse})`);
    glow.addColorStop(0.35, `rgba(255,40,170,${0.28 * pulse})`);
    glow.addColorStop(1, "rgba(255,40,170,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(cx - radius * 3.3, cy - radius * 3.3, radius * 6.6, radius * 6.6);

    const size = Math.ceil(radius * 2);
    if (sunCache.width !== size) {
      sunCache.width = size;
      sunCache.height = size;
    }
    const sun = sunCache.getContext("2d");
    sun.globalCompositeOperation = "source-over";
    sun.clearRect(0, 0, size, size);
    const gradient = sun.createLinearGradient(0, 0, 0, size);
    gradient.addColorStop(0, "#fff27a");
    gradient.addColorStop(0.45, "#ffc860");
    gradient.addColorStop(0.7, "#ff7a90");
    gradient.addColorStop(1, "#ff2fb0");
    sun.fillStyle = gradient;
    sun.beginPath();
    sun.arc(radius, radius, radius, 0, 7);
    sun.fill();

    // Полосы-развёртка: вырезаем их из солнца, а не рисуем поверх, чтобы
    // диск просвечивал фоном. Фаза медленно плывёт.
    sun.globalCompositeOperation = "destination-out";
    const bands = 9;
    const phase = (t * 0.06) % 1;
    for (let k = 0; k < bands; k += 1) {
      const u = (k + phase) / bands;
      const y = radius * (0.95 + u * 1.05);
      const thickness = radius * (0.012 + 0.075 * u);
      sun.fillStyle = `rgba(0,0,0,${0.35 + 0.65 * Math.min(1, u * 2)})`;
      sun.fillRect(0, y, size, thickness);
    }
    ctx.drawImage(sunCache, cx - radius, cy - radius);
  }

  function drawFarRidge() {
    ctx.beginPath();
    ctx.moveTo(0, hy + 2);
    const step = W / 120;
    for (let x = 0; x <= W + step; x += step) {
      const u = x / W;
      const side = Math.pow(Math.abs(u - 0.5) * 2, 2);
      const y = hy - H * (0.01 + 0.03 * vnoise(u * 9 + 3.3, 3.3) + 0.05 * side * vnoise(u * 18, 7));
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, hy + 2);
    ctx.closePath();
    ctx.fillStyle = "rgba(78,26,125,0.95)";
    ctx.fill();
  }

  function drawTerrain(cameraZ) {
    const ground = ctx.createLinearGradient(0, hy, 0, H);
    ground.addColorStop(0, "#7a1c8c");
    ground.addColorStop(0.25, "#2a1060");
    ground.addColorStop(1, "#0a0630");
    ctx.fillStyle = ground;
    ctx.fillRect(0, hy, W, H - hy);

    const firstRow = Math.floor((cameraZ + ZN) / DZ);
    const dxStep = (2 * XW) / COLS;
    for (let i = 0; i <= ROWS; i += 1) {
      const zw = (firstRow + i) * DZ;
      const z = zw - cameraZ;
      Z[i] = z;
      const scale = f / z;
      for (let c = 0; c <= COLS; c += 1) {
        const x = -XW + c * dxStep;
        const h = height(x, zw, z);
        const idx = i * (COLS + 1) + c;
        PX[idx] = W / 2 + x * scale;
        PY[idx] = hy + (CAMY - h) * scale;
        PH[idx] = h / AMP;
      }
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const band = (value) => (value < 0.03 ? 0 : value < 0.25 ? 1 : value < 0.55 ? 2 : 3);

    // От дальних рядов к ближним: заливка под рядом закрывает дальние склоны.
    for (let i = ROWS; i >= 0; i -= 1) {
      const base = i * (COLS + 1);
      const fog = Math.min(1, Z[i] / ZFAR);
      const fade = Math.pow(fog, 1.5);

      ctx.beginPath();
      ctx.moveTo(0, PY[base]);
      for (let c = 0; c <= COLS; c += 1) ctx.lineTo(PX[base + c], PY[base + c]);
      ctx.lineTo(W, PY[base + COLS]);
      ctx.lineTo(W, H + 2);
      ctx.lineTo(0, H + 2);
      ctx.closePath();
      ctx.fillStyle =
        "rgb(" +
        Math.round(14 + (110 - 14) * fade) +
        "," +
        Math.round(8 + (26 - 8) * fade) +
        "," +
        Math.round(52 + (140 - 52) * fade) +
        ")";
      ctx.fill();

      const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      const used = [false, false, false, false];

      for (let c = 0; c < COLS; c += 1) {
        const a = base + c;
        const b = a + 1;
        const k = band((PH[a] + PH[b]) * 0.5);
        paths[k].moveTo(PX[a], PY[a]);
        paths[k].lineTo(PX[b], PY[b]);
        used[k] = true;
      }
      if (i > 0) {
        const next = (i - 1) * (COLS + 1);
        for (let c = 0; c <= COLS; c += 1) {
          const a = base + c;
          const b = next + c;
          const k = band(Math.max(PH[a], PH[b]));
          paths[k].moveTo(PX[a], PY[a]);
          paths[k].lineTo(PX[b], PY[b]);
          used[k] = true;
        }
      }

      const alpha = Math.pow(1 - fog, 1.2) * 0.95 + 0.04;
      const lineWidth = Math.min(2.6, Math.max(0.7, 5 / Z[i])) * U * 1.1;
      ctx.globalCompositeOperation = "lighter";
      for (let k = 0; k < 4; k += 1) {
        if (!used[k]) continue;
        const color = COLORS[k];
        const rgb = color[0] + "," + color[1] + "," + color[2];
        // Широкий полупрозрачный след — свечение неона; поверх него чёткая линия.
        ctx.lineWidth = lineWidth * 3.2;
        ctx.strokeStyle = `rgba(${rgb},${(alpha * 0.18).toFixed(3)})`;
        ctx.stroke(paths[k]);
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
        ctx.stroke(paths[k]);
      }
      ctx.globalCompositeOperation = "source-over";
    }
  }

  function drawFinish() {
    const haze = ctx.createLinearGradient(0, hy - H * 0.03, 0, hy + H * 0.14);
    haze.addColorStop(0, "rgba(255,70,200,0)");
    haze.addColorStop(0.22, "rgba(255,80,210,0.5)");
    haze.addColorStop(1, "rgba(255,70,200,0)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, hy - H * 0.03, W, H * 0.17);

    const vignette = ctx.createRadialGradient(W / 2, H * 0.55, H * 0.4, W / 2, H * 0.55, H * 1.1);
    vignette.addColorStop(0, "rgba(6,0,24,0)");
    vignette.addColorStop(1, "rgba(6,0,24,0.5)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);
  }

  function drawScene() {
    drawSky(time);
    drawSun(time);
    drawFarRidge();
    drawTerrain(camZ);
    drawFinish();
  }

  // --- цикл ---

  function frame(now) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    if (now - lastFrame < 1000 / FPS - 1) return;
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    time += dt;
    camZ += dt * 6 * SPEED;
    drawScene();
  }

  function start() {
    if (running) return;
    running = true;
    lastFrame = performance.now();
    // Первый кадр сразу: после смены темы сцена не должна мигать пустотой.
    drawScene();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function reducedMotion() {
    return !!(motionQuery && motionQuery.matches);
  }

  function isActive() {
    return (document.body && document.body.dataset.decoration) === "retrowave";
  }

  function sync() {
    const active = isActive();
    canvas.style.display = active ? "block" : "none";
    if (!active) {
      stop();
      return;
    }
    resize();
    if (!stars.length) makeStars();
    if (PREVIEW || reducedMotion()) {
      // Превью в панели и режим без анимации — один кадр, без цикла.
      stop();
      time = 0;
      camZ = 0;
      drawScene();
      return;
    }
    start();
  }

  if (motionQuery) {
    if (typeof motionQuery.addEventListener === "function") motionQuery.addEventListener("change", sync);
    else if (typeof motionQuery.addListener === "function") motionQuery.addListener(sync);
  }
  window.addEventListener("resize", () => {
    if (!isActive()) return;
    resize();
    if (PREVIEW || reducedMotion()) drawScene();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else sync();
  });
  if (document.body) {
    new MutationObserver(sync).observe(document.body, {
      attributes: true,
      attributeFilter: ["data-decoration", "data-theme"],
    });
  }

  sync();
})();
