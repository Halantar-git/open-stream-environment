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

  Края (`edge`): auto (по умолчанию) — сторона выбирается по форме и положению
  виджета: широкая плашка в верхней половине сцены виснет сверху, в нижней —
  снизу; узкая слева — слева, справа — справа. Так гирлянду можно поставить на
  любую сторону, просто перетащив и растянув виджет. Явно: top / bottom / left /
  right, несколько через запятую ("left,top,right" — арка на три стороны,
  синоним `arc`), frame — по всему периметру. Строка строится в локальных
  координатах (вдоль, поперёк) и поворачивается под нужный край матрицей,
  поэтому код один для всех краёв. Длина гирлянды — это длина стороны виджета:
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
  // Стороны, вдоль которых вешается гирлянда. Порядок — по часовой стрелке от
  // левой, чтобы сквозная нумерация лампочек шла «аркой»: слева → сверху →
  // справа.
  const SIDES = ["left", "top", "right", "bottom"];

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

  // `edge` → список сторон. Принимает auto (по форме виджета), одну сторону,
  // список через запятую, arc (слева-сверху-справа) или frame; всё лишнее
  // отбрасывается.
  // Сторона для auto: широкая плашка виснет на верхней или нижней кромке (по
  // вертикали), узкая — на боковой (по горизонтали). Геометрия — проценты
  // сцены, поэтому половина берётся по 50.
  function autoSide(geometry) {
    const g = geometry || {};
    const x = num(g.x, 0);
    const y = num(g.y, 0);
    const w = num(g.w, 100);
    const h = num(g.h, 100);
    if (w >= h) return y + h / 2 < 50 ? "top" : "bottom";
    return x + w / 2 < 50 ? "left" : "right";
  }

  function parseEdges(value, geometry) {
    const raw = String(value == null ? "auto" : value).toLowerCase().trim();
    if (raw === "auto" || raw === "") return [autoSide(geometry)];
    if (raw === "frame") return SIDES.slice();
    if (raw === "arc") return ["left", "top", "right"];
    const wanted = raw.split(/[\s,;+]+/);
    const sides = SIDES.filter((side) => wanted.includes(side));
    return sides.length ? sides : [autoSide(geometry)];
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
        edges: parseEdges(c.edge, this.geometry),
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
      const sig = [w, h, s.mode, s.edges.join("+"), s.palette.join(), s.bulbs, s.swags, s.sag, s.speed].join("|");
      if (sig === this._sig) return;
      this._sig = sig;

      const uid = ++instanceCounter;
      const svg = this.svgEl;
      svg.textContent = "";
      svg.setAttribute("viewBox", "0 0 " + w + " " + h);
      svg.setAttribute("width", w);
      svg.setAttribute("height", h);
      svg.appendChild(this._buildDefs(uid, s.palette));

      // Описание сторон: длина вдоль, поперечный размер и матрица, которая
      // поворачивает «верхнюю» локальную гирлянду на нужный край.
      const sides = s.edges;
      const has = (side) => sides.includes(side);
      // Поперёк гирлянда занимает не всю плашку, а её узкую сторону: иначе на
      // широком боксе `edge: left` давал бы провис на всю ширину сцены.
      const crossMax = Math.min(w, h);
      let strings;
      if (sides.length === 1) {
        const side = sides[0];
        strings = [
          side === "bottom"
            ? { length: w, cross: crossMax, transform: "translate(0 " + h + ") scale(1 -1)" }
            : side === "left"
              ? { length: h, cross: crossMax, transform: "matrix(0 1 1 0 0 0)" }
              : side === "right"
                ? { length: h, cross: crossMax, transform: "matrix(0 1 -1 0 " + w + " 0)" }
                : { length: w, cross: crossMax, transform: "" },
        ];
      } else {
        const depth = clamp(Math.min(w, h) * 0.22, 24, 120);
        const corner = depth * 0.8;
        // Боковые стороны не заходят в углы, где уже висит верхняя или нижняя.
        const startInset = has("top") ? corner : 0;
        const endInset = has("bottom") ? corner : 0;
        const sideLen = h - startInset - endInset;
        const shift = " translate(" + startInset.toFixed(1) + " 0)";
        strings = sides.map((side) => {
          if (side === "top") return { length: w, cross: depth, transform: "" };
          if (side === "bottom") return { length: w, cross: depth, transform: "translate(0 " + h + ") scale(1 -1)" };
          if (side === "left") return { length: sideLen, cross: depth, transform: "matrix(0 1 1 0 0 0)" + shift };
          return { length: sideLen, cross: depth, transform: "matrix(0 1 -1 0 " + w + " 0)" + shift };
        });
      }

      // Лампочки и дуги делим между сторонами пропорционально длине.
      const total = strings.reduce((sum, st) => sum + Math.max(1, st.length), 0);
      let index = 0;
      for (const st of strings) {
        if (st.length < 20 || st.cross < 12) continue;
        const share = Math.max(1, st.length) / total;
        const g = svgEl("g", { transform: st.transform });
        svg.appendChild(g);
        index = this._buildString(g, uid, s, {
          length: st.length,
          cross: st.cross,
          bulbs: strings.length > 1 ? Math.max(2, Math.round(s.bulbs * share)) : s.bulbs,
          swags: strings.length > 1 ? Math.max(1, Math.round(s.swags * share)) : s.swags,
          startIndex: index,
        });
      }
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
