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
  Новогодняя гирлянда.

  Провисающие дуги провода с лампочками вдоль верхней кромки. Это
  SVG-виджет без таймеров и rAF: всё мерцание — CSS-анимации по `opacity` и
  `transform`, у каждой лампочки свои `--d` (длительность) и `--delay`, так
  что нагрузка на сцену минимальна. Геометрия строится по реальным размерам
  виджета и пересобирается при ресайзе.

  Гирлянда всегда виснет с верхней кромки виджета: растягиваемый бокс задаёт
  длину провода и глубину провиса. Длина гирлянды — это ширина виджета:
  растяни виджет, и лампочек станет больше (до `bulbs`).

  Режимы: twinkle (случайное мерцание), chase (бегущие огни по трём фазам),
  wave (волна вдоль провода), blink (все мигают разом), steady (горят ровно).
  На алерты гирлянда отвечает вспышкой: чем крупнее донат, тем дольше.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetGarland = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetGarland;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetGarland = WidgetGarland;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

  const PALETTES = {
    classic: ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ff2d92"],
    warm: ["#ffd9a0", "#ffc46b", "#ffe6c2"],
    cool: ["#bfe3ff", "#8fd0ff", "#e8f6ff"],
    redgreen: ["#e5222b", "#1fae4b"],
    retro: ["#ff6a3d", "#ffd23f", "#3bceac", "#4d9de0", "#e15554"],
  };
  const MODES = ["twinkle", "chase", "wave", "blink", "steady"];

  // Вспышка на алерт: базовая длительность плюс по 2 мс за каждую единицу
  // суммы, но не дольше потолка — иначе крупный донат «залипнет» на минуты.
  const BURST_BASE_MS = 1400;
  const BURST_MAX_MS = 3600;

  let instanceCounter = 0;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    if (attrs) {
      for (const key of Object.keys(attrs)) el.setAttribute(key, String(attrs[key]));
    }
    return el;
  }

  // Детерминированный «рандом»: пересборка при ресайзе не должна перетасовывать
  // мерцание, иначе гирлянда дёргается при каждом изменении размера.
  function rand(i, salt) {
    const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function toRgb(hex) {
    let h = hex.slice(1);
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }

  function mix(hex, target, t) {
    const a = toRgb(hex);
    return "#" + a.map((v, i) => Math.round(v + (target[i] - v) * t).toString(16).padStart(2, "0")).join("");
  }

  // Палитра: имя пресета, массив или строка «#aaa, #bbb». Всё некорректное
  // отбрасываем и откатываемся на classic, чтобы виджет не оставался чёрным.
  function parsePalette(value) {
    let list = [];
    if (Array.isArray(value)) list = value;
    else if (typeof value === "string") {
      const key = value.trim().toLowerCase();
      if (PALETTES[key]) return PALETTES[key];
      list = value.split(/[\s,;]+/);
    }
    const colors = list.map((c) => String(c).trim()).filter((c) => HEX.test(c));
    return colors.length ? colors : PALETTES.classic;
  }

  class WidgetGarland extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this._sig = "";
      this._burstId = null;
      this._observer = null;
      this.svgEl = null;
    }

    onMount() {
      this.element.classList.add("garland");
      this.element.style.pointerEvents = "none";

      this.svgEl = svgEl("svg", { class: "garland__svg", "aria-hidden": "true" });
      this.element.appendChild(this.svgEl);

      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this.react(alert));

      if (typeof ResizeObserver === "function") {
        this._observer = new ResizeObserver(() => this.rebuild());
        this._observer.observe(this.element);
      }
      this.applyConfig();
      this.rebuild();
      // Размер может определиться только после первой раскладки.
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => this.rebuild());
    }

    onUpdate() {
      this.applyConfig();
      this.rebuild();
    }

    onUnmount() {
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
      if (this._burstId != null) this.clearTimer(this._burstId);
      this._burstId = null;
    }

    // ---- config ----

    settings() {
      const c = this.config || {};
      const mode = MODES.includes(c.mode) ? c.mode : "twinkle";
      return {
        mode,
        palette: parsePalette(c.palette),
        bulbs: Math.round(clamp(num(c.bulbs, 24), 4, 240)),
        swags: Math.round(clamp(num(c.swags, 5), 1, 24)),
        sag: clamp(num(c.sag, 0.5), 0, 1),
        speed: clamp(num(c.speed, 1), 0.25, 4),
        reactToAlerts: c.reactToAlerts !== false,
      };
    }

    applyConfig() {
      const { mode } = this.settings();
      for (const m of MODES) this.element.classList.toggle("garland--" + m, m === mode);
    }

    // ---- alerts ----

    react(alert) {
      if (!alert || !this.settings().reactToAlerts) return;
      const amount = Number(alert.amount) || 0;
      const ms = clamp(BURST_BASE_MS + amount * 2, BURST_BASE_MS, BURST_MAX_MS);
      this.element.classList.add("is-burst");
      if (this._burstId != null) this.clearTimer(this._burstId);
      this._burstId = this.later(() => {
        this._burstId = null;
        this.element.classList.remove("is-burst");
      }, ms);
    }

    // ---- geometry ----

    // Провод — цепочка квадратичных кривых Безье между якорями на одной
    // высоте. Нижняя точка каждой дуги ровно на `depth` ниже якоря, поэтому
    // провисание честно ограничивается поперечным размером.
    rebuild() {
      if (!this.svgEl) return;
      const w = Math.round(this.element.clientWidth);
      const h = Math.round(this.element.clientHeight);
      if (!w || !h) return;

      const s = this.settings();
      const sig = [w, h, s.mode, s.palette.join(), s.bulbs, s.swags, s.sag, s.speed].join("|");
      if (sig === this._sig) return;
      this._sig = sig;

      const uid = ++instanceCounter;
      const svg = this.svgEl;
      svg.textContent = "";
      svg.setAttribute("viewBox", "0 0 " + w + " " + h);
      svg.setAttribute("width", w);
      svg.setAttribute("height", h);
      svg.appendChild(this._buildDefs(uid, s.palette));

      // Одна строка вдоль верхней кромки: ширина виджета — длина провода,
      // высота — сколько места есть на провис.
      if (w < 20 || h < 12) return;
      this._buildString(svg, uid, s, { length: w, cross: h, bulbs: s.bulbs, swags: s.swags, startIndex: 0 });
    }

    // Градиенты: свечение и объём стекла для каждого цвета палитры.
    _buildDefs(uid, palette) {
      const defs = svgEl("defs");
      palette.forEach((color, ci) => {
        const glow = svgEl("radialGradient", { id: "gg" + uid + "-" + ci });
        glow.appendChild(svgEl("stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.85 }));
        glow.appendChild(svgEl("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0 }));
        defs.appendChild(glow);
        const glass = svgEl("radialGradient", { id: "gl" + uid + "-" + ci, cx: 0.38, cy: 0.35, r: 0.8 });
        glass.appendChild(svgEl("stop", { offset: "0%", "stop-color": mix(color, [255, 255, 255], 0.55) }));
        glass.appendChild(svgEl("stop", { offset: "55%", "stop-color": color }));
        glass.appendChild(svgEl("stop", { offset: "100%", "stop-color": mix(color, [0, 0, 0], 0.4) }));
        defs.appendChild(glass);
      });
      return defs;
    }

    // Одна «верхняя» гирлянда в локальных координатах: x — вдоль, y — вниз.
    // Возвращает индекс следующей лампочки, чтобы волна и бегущие огни шли
    // сквозной нумерацией по всему периметру.
    _buildString(svg, uid, s, o) {
      const { length, cross, startIndex } = o;
      const size = clamp(cross * 0.3, 10, 46); // длина лампочки
      const margin = size * 0.2;
      const y0 = 4;
      const depth = Math.max(0, cross - y0 - size * 1.08) * s.sag;
      const swagW = (length - margin * 2) / o.swags;
      let perSwag = Math.max(1, Math.round(o.bulbs / o.swags));
      perSwag = Math.max(1, Math.min(perSwag, Math.floor(swagW / (size * 0.8))));

      // Провод.
      let d = "M" + margin.toFixed(1) + " " + y0;
      const swagPoints = [];
      for (let k = 0; k < o.swags; k++) {
        const ax = margin + k * swagW;
        const bx = ax + swagW;
        const cx = (ax + bx) / 2;
        const cy = y0 + depth * 2;
        d += " Q" + cx.toFixed(1) + " " + cy.toFixed(1) + " " + bx.toFixed(1) + " " + y0;
        swagPoints.push({ ax, bx, cx, cy });
      }
      const wireW = Math.max(1.5, size * 0.07);
      svg.appendChild(svgEl("path", { class: "garland__wire", d, fill: "none", "stroke-width": wireW.toFixed(2) }));
      svg.appendChild(svgEl("path", { class: "garland__wire-sheen", d, fill: "none", "stroke-width": (wireW * 0.4).toFixed(2) }));

      // Якоря (крепления).
      for (let k = 0; k <= o.swags; k++) {
        svg.appendChild(svgEl("circle", {
          class: "garland__knot",
          cx: (margin + k * swagW).toFixed(1),
          cy: y0,
          r: (size * 0.09).toFixed(2),
        }));
      }

      // Лампочки.
      const groups = s.palette.length >= 3 ? 3 : s.palette.length;
      const baseD = 2.4 / s.speed;
      let index = startIndex;
      for (const sp of swagPoints) {
        for (let n = 0; n < perSwag; n++) {
          const t = (n + 0.5) / perSwag;
          const u = 1 - t;
          const x = u * u * sp.ax + 2 * u * t * sp.cx + t * t * sp.bx;
          const y = u * u * y0 + 2 * u * t * sp.cy + t * t * y0;
          // Касательная: лампочка чуть наклонена вдоль провода, но не
          // перпендикулярна ему — так висят настоящие.
          const tx = 2 * u * (sp.cx - sp.ax) + 2 * t * (sp.bx - sp.cx);
          const ty = 2 * u * (sp.cy - y0) + 2 * t * (y0 - sp.cy);
          const rot = (Math.atan2(ty, tx) * 180) / Math.PI * 0.4;

          const ci = index % s.palette.length;

          let dur = baseD;
          let delay = 0;
          if (s.mode === "twinkle") {
            dur = baseD * (0.6 + rand(index, 1) * 1.1);
            delay = -rand(index, 2) * dur;
          } else if (s.mode === "wave") {
            dur = baseD * 0.9;
            delay = -((index * 0.11) / s.speed);
          } else if (s.mode === "blink") {
            dur = 1.2 / s.speed;
          } else if (s.mode === "chase") {
            dur = 1.35 / s.speed;
            delay = (index % groups) * (dur / groups);
          }

          const bulb = svgEl("g", {
            class: "garland__bulb",
            transform: "translate(" + x.toFixed(1) + " " + y.toFixed(1) + ") rotate(" + rot.toFixed(1) + ")",
          });
          bulb.style.setProperty("--d", dur.toFixed(2) + "s");
          bulb.style.setProperty("--delay", delay.toFixed(2) + "s");
          bulb.style.setProperty("--par", String(index % 2));

          bulb.appendChild(svgEl("rect", {
            class: "garland__cap",
            x: (-size * 0.17).toFixed(2),
            y: 0,
            width: (size * 0.34).toFixed(2),
            height: (size * 0.22).toFixed(2),
            rx: (size * 0.05).toFixed(2),
          }));

          const lamp = svgEl("g", { class: "garland__lamp" });
          lamp.appendChild(svgEl("circle", {
            class: "garland__glow",
            cx: 0,
            cy: (size * 0.62).toFixed(2),
            r: (size * 0.9).toFixed(2),
            fill: "url(#gg" + uid + "-" + ci + ")",
          }));
          const b = size;
          lamp.appendChild(svgEl("path", {
            d:
              "M" + (-0.19 * b).toFixed(2) + " " + (0.2 * b).toFixed(2) +
              " C" + (-0.4 * b).toFixed(2) + " " + (0.48 * b).toFixed(2) +
              " " + (-0.33 * b).toFixed(2) + " " + (0.9 * b).toFixed(2) +
              " 0 " + b.toFixed(2) +
              " C" + (0.33 * b).toFixed(2) + " " + (0.9 * b).toFixed(2) +
              " " + (0.4 * b).toFixed(2) + " " + (0.48 * b).toFixed(2) +
              " " + (0.19 * b).toFixed(2) + " " + (0.2 * b).toFixed(2) + "Z",
            fill: "url(#gl" + uid + "-" + ci + ")",
          }));
          lamp.appendChild(svgEl("ellipse", {
            class: "garland__shine",
            cx: (-0.1 * b).toFixed(2),
            cy: (0.52 * b).toFixed(2),
            rx: (0.055 * b).toFixed(2),
            ry: (0.14 * b).toFixed(2),
          }));
          bulb.appendChild(lamp);
          svg.appendChild(bulb);
          index += 1;
        }
      }
      return index;
    }
  }

  return WidgetGarland;
});
