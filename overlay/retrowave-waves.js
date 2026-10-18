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
  Retrowave waves — неоновые синусоиды над линией горизонта.

  Слой живёт только в теме Retrowave: при другой `data-decoration` canvas
  скрыт и цикл остановлен. Волны рисуются на canvas, а не CSS-градиентами,
  потому что синус с двумя гармониками даёт живой, не повторяющийся рисунок,
  который к тому же дёшево перерисовывается в 30 FPS. Цвета читаются из
  токенов темы при каждой смене `data-decoration`/`data-theme`, поэтому волны
  подхватывают и палитру своей темы.

  При `prefers-reduced-motion` рисуется один статичный кадр: движение здесь
  декоративное, и его можно выключить без потери смысла.
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

  const palette = { primary: "#ff2d95", secondary: "#2de2e6", tertiary: "#ffa24c" };
  let rafId = 0;
  let lastFrame = 0;
  let width = 0;
  let height = 0;
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
    if (reducedMotion()) {
      stop();
      resize();
      draw(0);
      return;
    }
    resize();
    start();
  }

  if (motionQuery) {
    if (typeof motionQuery.addEventListener === "function") motionQuery.addEventListener("change", sync);
    else if (typeof motionQuery.addListener === "function") motionQuery.addListener(sync);
  }
  window.addEventListener("resize", () => {
    if (!isActive()) return;
    resize();
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
