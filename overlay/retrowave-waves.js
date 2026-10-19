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
  Retrowave background — закатное небо сцены: неоновые волны, полосатое
  солнце и горы-каркас.

  Слои живут только в теме Retrowave: при другой `data-decoration` они скрыты,
  а цикл волн остановлен. Волны рисуются на canvas, а не CSS-градиентами,
  потому что синус с двумя гармониками даёт живой, не повторяющийся рисунок,
  который к тому же дёшево перерисовывается в 30 FPS. Солнце — CSS-элемент
  (градиент и маска полос), горы — статичный canvas: перерисовывать их каждый
  кадр незачем. Цвета читаются из токенов темы при каждой смене
  `data-decoration`/`data-theme`, поэтому слои подхватывают палитру.

  У заставки (`splash-bg`) солнца и гор нет: там своя композиция — замкнутая
  неоновая комната, — и этот фон её не меняет.

  При `prefers-reduced-motion` волны рисуются одним статичным кадром: движение
  здесь декоративное, и его можно выключить без потери смысла.
*/
(function () {
  "use strict";

  const DPR_LIMIT = 2;
  const FPS = 30;

  // Четыре волны с разными длинами, амплитудами и скоростями. Скорость —
  // радианы в секунду, поэтому соседние линии не двигаются синхронно.
  const LINES = [
    { base: 0.50, amp: 26, length: 540, speed: 0.55, width: 1.3, alpha: 0.34, color: "secondary" },
    { base: 0.62, amp: 34, length: 380, speed: -0.8, width: 1.6, alpha: 0.58, color: "primary" },
    { base: 0.73, amp: 20, length: 300, speed: 1.05, width: 1.2, alpha: 0.4, color: "tertiary" },
    { base: 0.83, amp: 14, length: 620, speed: -0.45, width: 1.1, alpha: 0.28, color: "secondary" },
  ];

  const wrapper = document.querySelector(".scene-wrapper");
  if (!wrapper) return;

  const canvas = document.createElement("canvas");
  canvas.className = "retrowave-waves";
  canvas.setAttribute("aria-hidden", "true");
  wrapper.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  /*
    Солнце и горы — только сценам. У заставки (`splash-bg`) своя композиция,
    и трогать её пока не нужно: элементы просто не создаются.
  */
  const isSplash = wrapper.classList.contains("splash-bg");
  let mountains = null;
  let mountainsCtx = null;
  let road = null;
  let roadCtx = null;
  if (!isSplash) {
    // Дымка у горизонта: тёплое пятно заката, поверх которого садится солнце.
    const haze = document.createElement("div");
    haze.className = "retrowave-haze";
    haze.setAttribute("aria-hidden", "true");
    wrapper.appendChild(haze);

    const sun = document.createElement("div");
    sun.className = "retrowave-sun";
    sun.setAttribute("aria-hidden", "true");
    wrapper.appendChild(sun);

    mountains = document.createElement("canvas");
    mountains.className = "retrowave-mountains";
    mountains.setAttribute("aria-hidden", "true");
    wrapper.appendChild(mountains);
    mountainsCtx = mountains.getContext("2d");

    // Дорога лежит поверх сетки: у референса центр кадра — коридор к точке схода.
    road = document.createElement("canvas");
    road.className = "retrowave-road";
    road.setAttribute("aria-hidden", "true");
    wrapper.appendChild(road);
    roadCtx = road.getContext("2d");
  }

  const palette = { primary: "#ff2d95", secondary: "#2de2e6", tertiary: "#ffa24c" };
  let rafId = 0;
  let lastFrame = 0;
  let width = 0;
  let height = 0;
  let mountainWidth = 0;
  let mountainHeight = 0;
  let roadWidth = 0;
  let roadHeight = 0;
  let running = false;

  const motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  function hexToRgb(value) {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || "").trim());
    if (!match) return null;
    let hex = match[1];
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  function withAlpha(color, alpha) {
    const rgb = hexToRgb(color);
    if (rgb) return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
    // Токен может быть уже задан как rgb()/rgba() или именем цвета.
    const rgbFn = /^rgba?\(([^)]+)\)$/i.exec(String(color || "").trim());
    if (rgbFn) {
      const parts = rgbFn[1].split(",").map((part) => part.trim());
      if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    }
    return color;
  }

  function readPalette() {
    const style = getComputedStyle(document.documentElement);
    const read = (name, fallback) => String(style.getPropertyValue(name) || "").trim() || fallback;
    palette.primary = read("--md-primary", palette.primary);
    palette.secondary = read("--md-secondary", palette.secondary);
    palette.tertiary = read("--md-tertiary", palette.tertiary);
  }

  function isActive() {
    return (document.body && document.body.dataset.decoration) === "retrowave";
  }

  function reducedMotion() {
    return !!(motionQuery && motionQuery.matches);
  }

  function resize() {
    const dpr = Math.min(DPR_LIMIT, window.devicePixelRatio || 1);
    width = Math.max(1, Math.round(canvas.clientWidth || 0));
    height = Math.max(1, Math.round(canvas.clientHeight || 0));
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Одна волна: две гармоники дают «морской» силуэт вместо ровной синусоиды.
  function waveY(line, x, time) {
    const phase = (x / line.length) * Math.PI * 2;
    const ripple = (x / (line.length * 0.47)) * Math.PI * 2;
    return (
      line.base * height +
      Math.sin(phase + time * line.speed) * line.amp +
      Math.sin(ripple - time * line.speed * 1.6) * line.amp * 0.28
    );
  }

  function trace(line, time) {
    ctx.beginPath();
    const step = Math.max(2, Math.round(width / 260));
    for (let x = -step; x <= width + step; x += step) {
      const y = waveY(line, x, time);
      if (x === -step) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  function draw(time) {
    if (!width || !height) return;
    ctx.clearRect(0, 0, width, height);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    for (const line of LINES) {
      const color = palette[line.color] || palette.primary;
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, withAlpha(color, 0));
      gradient.addColorStop(0.12, withAlpha(color, line.alpha));
      gradient.addColorStop(0.5, withAlpha(color, line.alpha));
      gradient.addColorStop(0.88, withAlpha(color, line.alpha));
      gradient.addColorStop(1, withAlpha(color, 0));

      // Мягкое свечение: широкая полупрозрачная линия под чёткой.
      ctx.save();
      ctx.strokeStyle = gradient;
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = line.width * 3.4;
      trace(line, time);
      ctx.stroke();
      ctx.restore();

      // Чёткий неоновый контур.
      ctx.save();
      ctx.strokeStyle = gradient;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.lineWidth = line.width;
      trace(line, time);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- закатный пейзаж: горы-каркас -----------------------------------

  // Где сходятся земля и небо. Та же линия, что у `::after` сцены.
  const HORIZON = 0.52;

  function resizeMountains() {
    if (!mountains || !mountainsCtx) return;
    const dpr = Math.min(DPR_LIMIT, window.devicePixelRatio || 1);
    mountainWidth = Math.max(1, Math.round(mountains.clientWidth || 0));
    mountainHeight = Math.max(1, Math.round(mountains.clientHeight || 0));
    const pixelWidth = Math.round(mountainWidth * dpr);
    const pixelHeight = Math.round(mountainHeight * dpr);
    if (mountains.width !== pixelWidth || mountains.height !== pixelHeight) {
      mountains.width = pixelWidth;
      mountains.height = pixelHeight;
    }
    mountainsCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Гребень задан ломаной по контрольным точкам: у референса несколько
  // крупных вершин с крутыми склонами. Ряд гауссовых пиков давал слишком
  // ровный «частокол» одинаковых горбов.
  const RIDGE_PROFILE = {
    left: [
      [0.0, 0.02],
      [0.18, 0.04],
      [0.32, 0.16],
      [0.42, 0.24],
      [0.52, 0.12],
      [0.66, 0.18],
      [0.78, 0.34],
      [0.88, 0.22],
      [0.96, 0.3],
      [1.0, 0.26],
    ],
    right: [
      [0.0, 0.02],
      [0.14, 0.05],
      [0.26, 0.12],
      [0.38, 0.2],
      [0.5, 0.1],
      [0.62, 0.16],
      [0.74, 0.3],
      [0.84, 0.18],
      [0.92, 0.24],
      [1.0, 0.3],
    ],
  };

  function ridgeY(x, side) {
    const half = mountainWidth / 2;
    const t = side === "left" ? (half - x) / half : (x - half) / half;
    const k = Math.min(1, Math.max(0, t));
    const profile = RIDGE_PROFILE[side];
    let height = profile[profile.length - 1][1];
    for (let i = 0; i < profile.length - 1; i += 1) {
      const [k0, h0] = profile[i];
      const [k1, h1] = profile[i + 1];
      if (k >= k0 && k <= k1) {
        // Косинусная интерполяция сглаживает углы между точками: у референса
        // горы округлые, а не пилообразные.
        const f = (1 - Math.cos(((k - k0) / (k1 - k0)) * Math.PI)) / 2;
        height = h0 + (h1 - h0) * f;
        break;
      }
    }
    return mountainHeight * (HORIZON - 0.015 - 0.05 * k - height * 0.82);
  }

  // Подошва горы: у центра она на горизонте, к краю кадра уходит вниз —
  // та же перспектива, что у сетки. Между подошвами остаётся долина с дорогой.
  function baseY(x, side) {
    const half = mountainWidth / 2;
    const t = side === "left" ? (half - x) / half : (x - half) / half;
    const k = Math.min(1, Math.max(0, t));
    return mountainHeight * (HORIZON + k * 0.55);
  }

  function ridgePath(side) {
    const half = mountainWidth / 2;
    const step = Math.max(4, Math.round(mountainWidth / 260));
    const dir = side === "left" ? -step : step;
    const end = side === "left" ? -step : mountainWidth + step;
    const path = new Path2D();
    let x = half;
    path.moveTo(x, ridgeY(x, side));
    for (x += dir; side === "left" ? x >= end : x <= end; x += dir) {
      path.lineTo(x, ridgeY(x, side));
    }
    return { path, end, dir };
  }

  // Дальний хребет у горизонта: он перекрывает низ солнца и отделяет небо
  // от сетки — тот самый закатный силуэт из референса.
  function drawFarRidge() {
    const step = Math.max(6, Math.round(mountainWidth / 180));
    const path = new Path2D();
    path.moveTo(-step, mountainHeight);
    for (let x = -step; x <= mountainWidth + step; x += step) {
      const t = x / mountainWidth;
      const bump = Math.sin(t * Math.PI * 5.5 + 0.6) * 0.012 + Math.sin(t * Math.PI * 15 + 2.1) * 0.006;
      path.lineTo(x, mountainHeight * (HORIZON - 0.012 + bump));
    }
    path.lineTo(mountainWidth + step, mountainHeight);
    path.closePath();

    const gradient = mountainsCtx.createLinearGradient(
      0,
      mountainHeight * 0.42,
      0,
      mountainHeight * HORIZON + 24
    );
    gradient.addColorStop(0, "rgba(48, 20, 78, 0.9)");
    gradient.addColorStop(1, "rgba(18, 8, 38, 0.95)");
    mountainsCtx.fillStyle = gradient;
    mountainsCtx.fill(path);
    mountainsCtx.strokeStyle = withAlpha(palette.primary, 0.45);
    mountainsCtx.lineWidth = 1;
    mountainsCtx.stroke(path);
  }

  function drawSide(side) {
    const color = side === "left" ? palette.secondary : palette.primary;
    const { path, end, dir } = ridgePath(side);
    const half = mountainWidth / 2;

    const fill = new Path2D(path);
    fill.lineTo(end, baseY(end, side));
    for (let x = end; side === "left" ? x <= half : x >= half; x -= dir) {
      fill.lineTo(x, baseY(x, side));
    }
    fill.closePath();

    const gradient = mountainsCtx.createLinearGradient(0, mountainHeight * 0.1, 0, mountainHeight);
    gradient.addColorStop(0, "rgba(32, 14, 58, 0.92)");
    gradient.addColorStop(0.55, "rgba(18, 7, 36, 0.95)");
    gradient.addColorStop(1, "rgba(7, 3, 18, 0.98)");
    mountainsCtx.fillStyle = gradient;
    mountainsCtx.fill(fill);

    mountainsCtx.save();
    mountainsCtx.clip(fill);

    // Вертикальные рёбра каркаса: от гребня к подошве и к зрителю — так
    // поверхность читается наклонной, а не плоской ширмой.
    mountainsCtx.lineWidth = 1;
    mountainsCtx.strokeStyle = withAlpha(color, 0.3);
    for (let x = half; side === "left" ? x >= end : x <= end; x += dir * 4) {
      const bx = x + (x - half) * 0.42;
      mountainsCtx.beginPath();
      mountainsCtx.moveTo(x, ridgeY(x, side) + 2);
      mountainsCtx.lineTo(bx, baseY(bx, side));
      mountainsCtx.stroke();
    }

    // Горизонтальные контуры повторяют хребет и тоже расходятся к зрителю,
    // из-за чего поверхность выглядит наклонной.
    for (let row = 1; row <= 9; row += 1) {
      const offset = row * mountainHeight * 0.038;
      const depth = offset / mountainHeight;
      mountainsCtx.beginPath();
      let x = half;
      mountainsCtx.moveTo(x, ridgeY(x, side) + offset);
      for (x += dir; side === "left" ? x >= end : x <= end; x += dir) {
        mountainsCtx.lineTo(x + (x - half) * depth * 1.4, ridgeY(x, side) + offset);
      }
      mountainsCtx.strokeStyle = withAlpha(row % 2 ? color : palette.primary, 0.2);
      mountainsCtx.stroke();
    }
    mountainsCtx.restore();

    // Светящийся гребень: широкий ореол и чёткая неоновая линия.
    mountainsCtx.save();
    mountainsCtx.strokeStyle = withAlpha(color, 0.5);
    mountainsCtx.shadowColor = color;
    mountainsCtx.shadowBlur = 22;
    mountainsCtx.lineWidth = 4;
    mountainsCtx.stroke(path);
    mountainsCtx.strokeStyle = withAlpha(color, 0.95);
    mountainsCtx.shadowBlur = 10;
    mountainsCtx.lineWidth = 1.8;
    mountainsCtx.stroke(path);
    mountainsCtx.restore();
  }

  function drawMountains() {
    if (!mountainsCtx || !mountainWidth || !mountainHeight) return;
    mountainsCtx.clearRect(0, 0, mountainWidth, mountainHeight);
    drawFarRidge();
    drawSide("left");
    drawSide("right");
  }

  // ---- дорога к точке схода -------------------------------------------

  function resizeRoad() {
    if (!road || !roadCtx) return;
    const dpr = Math.min(DPR_LIMIT, window.devicePixelRatio || 1);
    roadWidth = Math.max(1, Math.round(road.clientWidth || 0));
    roadHeight = Math.max(1, Math.round(road.clientHeight || 0));
    const pixelWidth = Math.round(roadWidth * dpr);
    const pixelHeight = Math.round(roadHeight * dpr);
    if (road.width !== pixelWidth || road.height !== pixelHeight) {
      road.width = pixelWidth;
      road.height = pixelHeight;
    }
    roadCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawRoad() {
    if (!roadCtx || !roadWidth || !roadHeight) return;
    const ctx2 = roadCtx;
    ctx2.clearRect(0, 0, roadWidth, roadHeight);
    const vx = roadWidth / 2;
    const vy = roadHeight * HORIZON;
    const halfTop = roadWidth * 0.006;
    const halfBottom = roadWidth * 0.17;

    // Полотно полупрозрачное: бегущая сетка просвечивает, и дорога живёт
    // вместе с фоном, а не висит плоской заплаткой.
    const path = new Path2D();
    path.moveTo(vx - halfTop, vy);
    path.lineTo(vx - halfBottom, roadHeight);
    path.lineTo(vx + halfBottom, roadHeight);
    path.lineTo(vx + halfTop, vy);
    path.closePath();
    const gradient = ctx2.createLinearGradient(0, vy, 0, roadHeight);
    gradient.addColorStop(0, "rgba(36, 14, 66, 0.36)");
    gradient.addColorStop(0.55, "rgba(20, 9, 40, 0.26)");
    gradient.addColorStop(1, "rgba(8, 3, 20, 0.12)");
    ctx2.fillStyle = gradient;
    ctx2.fill(path);

    // Кромки: левая циановая, правая магентовая — как рёбра гор.
    for (const [color, sign] of [
      [palette.secondary, -1],
      [palette.primary, 1],
    ]) {
      ctx2.save();
      ctx2.strokeStyle = withAlpha(color, 0.62);
      ctx2.shadowColor = color;
      ctx2.shadowBlur = 10;
      ctx2.lineWidth = 2;
      ctx2.beginPath();
      ctx2.moveTo(vx + sign * halfTop, vy);
      ctx2.lineTo(vx + sign * halfBottom, roadHeight);
      ctx2.stroke();
      ctx2.restore();
    }

    // Разметка: у горизонта штрихи короткие и частые, ближе к зрителю — длиннее.
    ctx2.save();
    ctx2.strokeStyle = withAlpha(palette.tertiary, 0.35);
    ctx2.lineWidth = 2;
    for (let i = 0; i < 14; i += 1) {
      const t0 = 0.2 + i * 0.055;
      const t1 = t0 + 0.018;
      if (t1 > 1) break;
      const y0 = vy + (roadHeight - vy) * t0 * t0;
      const y1 = vy + (roadHeight - vy) * t1 * t1;
      ctx2.beginPath();
      ctx2.moveTo(vx, y0);
      ctx2.lineTo(vx, y1);
      ctx2.stroke();
    }
    ctx2.restore();
  }

  function stop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function start() {
    if (running) return;
    running = true;
    lastFrame = 0;
    // Первый кадр сразу, чтобы волны появились без ожидания rAF.
    draw(performance.now() / 1000);
    rafId = requestAnimationFrame(frame);
  }

  function frame(now) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    const frameMs = 1000 / FPS;
    if (now - lastFrame < frameMs) return;
    lastFrame = now - ((now - lastFrame) % frameMs);
    draw(now / 1000);
  }

  function sync() {
    const active = isActive();
    canvas.style.display = active ? "block" : "none";
    if (!active) {
      stop();
      return;
    }
    readPalette();
    resize();
    if (mountainsCtx) {
      resizeMountains();
      drawMountains();
    }
    if (roadCtx) {
      resizeRoad();
      drawRoad();
    }
    if (reducedMotion()) {
      stop();
      draw(0);
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
    if (mountainsCtx) {
      resizeMountains();
      drawMountains();
    }
    if (roadCtx) {
      resizeRoad();
      drawRoad();
    }
    if (reducedMotion()) draw(0);
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
