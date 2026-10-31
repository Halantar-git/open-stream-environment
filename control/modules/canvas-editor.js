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
  Canvas editor for the overlay layout.

  Single responsibility: render the widget layout onto the editor canvas and
  own every canvas interaction — drag-and-drop from the library, drag/resize of
  placed widgets, selection, layers (z-order / visibility), the snap grid and
  the theme applied to the canvas preview. It also owns the widget preview HTML
  used inside the canvas boxes.

  It reads the live `state` object and delegates "the selection changed" to
  `onSelectionChange` so the properties inspector can stay decoupled.
*/

import { el } from "./dom.js";

// Тот же tier-цвет донатов, что у TESO- и UEC-виджетов: сумма красится по
// размеру доната, а не по акценту темы.
function donationQualityColor(amount) {
  const a = Number(amount) || 0;
  if (a < 200) return "#ffffff";
  if (a < 400) return "#2dc50e";
  if (a < 600) return "#3a92ff";
  if (a < 800) return "#a02dc5";
  if (a < 1000) return "#e5a823";
  return "#ee6a00";
}

export function initCanvasEditor({
  state,
  t,
  ICONS,
  WIDGET_TYPES,
  themeAllowsWidget,
  replacedBy3d,
  widgetRole,
  resolveTypeForTheme,
  typeForAdd,
  EVENT_TYPES,
  send,
  clamp,
  round1,
  escapeHtml,
  escapeAttr,
  formatMoney,
  currencySymbol,
  formatSessionAmount,
  resolveMediaUrl,
  onSelectionChange,
}) {
  const canvasWrapEl = el("canvasWrap");
  const canvasEl = el("canvas");
  const layersEl = el("layers");
  const gridSizeSelect = el("gridSizeSelect");
  const aspectRatioSelect = el("aspectRatioSelect");
  const layoutLockBtn = el("layoutLockBtn");
  const layoutLockIcon = el("layoutLockIcon");
  const toggleHudBtn = document.getElementById("toggleHudBtn");

  // While a drag/resize is in progress the canvas must not rebuild its DOM —
  // doing so would detach the element the pointer handlers are bound to and
  // make the widget snap back to its pre-drag position. Re-renders that arrive
  // mid-gesture are skipped; the final LAYOUT_UPDATE after release re-syncs.
  let interacting = false;

  // ---- canvas preview content (sample data for event-driven widgets, real data for goal) ----
  function sampleChat() {
    return [
      { user: "nova_viewer", color: "#7ee0d6", message: t("preview.chat1"), badges: ["subscriber"] },
      { user: "star_gazer", color: "#ffb0d8", message: t("preview.chat2"), badges: [] },
      { user: "orbit_fan", color: "#c6b8ff", message: t("preview.chat3"), badges: ["moderator"] },
    ];
  }
  const SAMPLE_RECENT = [
    { kind: "donation", user: "comet_watcher", amount: 300 },
    { kind: "sub", user: "nova_viewer" },
    { kind: "follow", user: "star_gazer" },
  ];
  // Пока розыгрыш не начался, список участников пуст — на канвасе показываем
  // пример, иначе виджет выглядел бы сломанным при настройке.
  const SAMPLE_PARTICIPANTS = ["nova_viewer", "star_gazer", "orbit_fan", "pixel_pilot"];

  // Значки в превью — буквами, как запасной вариант в эфире: тянуть картинки
  // Twitch в инспектор незачем, а роль зрителя читается и так. Без этого
  // 3D-чаты на канвасе выглядели беднее, чем в эфире.
  function previewBadges(badges, color) {
    return (badges || [])
      .slice(0, 3)
      .map(
        (badge) =>
          `<span style="color:${escapeAttr(color)};font-weight:700;">${escapeHtml(String(badge).slice(0, 1).toUpperCase())}</span>`
      )
      .join(" ");
  }

  function recentTextPreview(e) {
    const user = `<b>${e.user}</b>`;
    switch (e.kind) {
      case "donation": return t("preview.recentDonation", { user, amount: formatMoney(e.amount) });
      case "sub": return t("preview.recentSub", { user });
      case "follow": return t("preview.recentFollow", { user });
      default: return user;
    }
  }

  function buildCustomWidgetDocument(cfg) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#e8e1f0;font-family:sans-serif;}${cfg.css || ""}</style></head><body>${cfg.html || ""}<script>${cfg.js || ""}</script></body></html>`;
  }

  // Поворот повторяет трансформацию живого виджета (см. `_draw` в
  // mic-widget.js): при 90° и 270° ширина и высота области рисования
  // меняются местами, и только потом картинка поворачивается — иначе
  // превью вылезало бы за границы виджета.
  function micRotation(value) {
    const r = Number(value);
    return r === 90 || r === 180 || r === 270 ? r : 0;
  }

  function micDrawSize(width, height, rotation) {
    const r = micRotation(rotation);
    return r === 90 || r === 270 ? { w: height, h: width } : { w: width, h: height };
  }

  function buildMicPreviewFrame(inner, width, height, opacity, rotation, mirror) {
    const r = micRotation(rotation);
    const draw = micDrawSize(width, height, r);
    // Отражение — в системе координат рисунка, до поворота: так превью
    // совпадает с эфиром при любом угле.
    const content = mirror ? `<g transform="translate(${draw.w},0) scale(-1,1)">${inner}</g>` : inner;
    const wrap =
      r === 90
        ? `translate(${width},0) rotate(90)`
        : r === 180
        ? `translate(${width},${height}) rotate(180)`
        : r === 270
        ? `translate(0,${height}) rotate(-90)`
        : "";
    const body = wrap ? `<g transform="${wrap}">${content}</g>` : content;
    return `<div class="widget-mic widget-mic--preview"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:100%;opacity:${opacity}">${body}</svg></div>`;
  }

  // Per-widget mic setting with the global mic config as fallback.
  function micCfg(config, key, fallback) {
    const own = config[key];
    if (own !== undefined && own !== null && own !== "") return own;
    const g = state.micConfig[key];
    if (g !== undefined && g !== null && g !== "") return g;
    return fallback;
  }

  // Тот же наклон, что у живого виджета: превью в редакторе должно показывать
  // перспективу, иначе настройка выглядит неработающей.
  function perspectiveStyle(config) {
    const value = Math.max(0, Math.min(100, Number(config.perspective) || 0));
    if (!value) return "";
    const magnitude = value * 0.15;
    const direction = config.perspectiveDirection || "left";
    let ry = -magnitude;
    let rx = magnitude * 0.2;
    if (direction === "right") {
      ry = magnitude;
    } else if (direction === "up") {
      ry = 0;
      rx = magnitude;
    } else if (direction === "down") {
      ry = 0;
      rx = -magnitude;
    }
    return `perspective(1200px) rotateY(${ry}deg) rotateX(${rx}deg)`;
  }

  function buildBarsPreview({ width, height, opacity, color, barCount, gap, rotation, mirror }) {
    const { w: dw, h: dh } = micDrawSize(width, height, rotation);
    const n = Math.max(2, Math.round(barCount));
    const slotW = dw / n;
    const barW = Math.max(1, slotW - gap);
    let rects = "";
    for (let i = 0; i < n; i++) {
      const v = Math.abs(Math.sin(i * 0.5) * 0.65 + Math.sin(i * 0.19) * 0.35);
      const h = Math.max(1, v * dh * 0.96);
      const x = i * slotW + (slotW - barW) / 2;
      const y = (dh - h) / 2;
      rects += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${escapeAttr(color)}"/>`;
    }
    return buildMicPreviewFrame(rects, width, height, opacity, rotation, mirror);
  }

  function buildBarsUpPreview({ width, height, opacity, color, barCount, gap, rotation, mirror }) {
    const { w: dw, h: dh } = micDrawSize(width, height, rotation);
    const n = Math.max(2, Math.round(barCount));
    const slotW = dw / n;
    const barW = Math.max(1, slotW - gap);
    let rects = "";
    for (let i = 0; i < n; i++) {
      const v = Math.abs(Math.sin(i * 0.5) * 0.65 + Math.sin(i * 0.19) * 0.35);
      const h = Math.max(1, v * dh * 0.96);
      const x = i * slotW + (slotW - barW) / 2;
      rects += `<rect x="${x.toFixed(1)}" y="${(dh - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${escapeAttr(color)}"/>`;
    }
    return buildMicPreviewFrame(rects, width, height, opacity, rotation, mirror);
  }

  function buildSinePreview({ width, height, opacity, color, lineWidth, rotation, mirror }) {
    const { w: dw, h: dh } = micDrawSize(width, height, rotation);
    const pts = [];
    for (let x = 0; x <= dw; x += 6) {
      const y = dh / 2 + Math.sin(x * 0.045) * dh * 0.28 + Math.sin(x * 0.012) * dh * 0.11;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    const inner = `<path d="M${pts.join(" L")}" fill="none" stroke="${escapeAttr(color)}" stroke-width="${lineWidth}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    return buildMicPreviewFrame(inner, width, height, opacity, rotation, mirror);
  }

  function buildRingPreview({ width, height, opacity, color, barCount, lineWidth, rotation, mirror }) {
    const { w: dw, h: dh } = micDrawSize(width, height, rotation);
    const n = Math.max(2, Math.round(barCount));
    const cx = dw / 2;
    const cy = dh / 2;
    const maxR = Math.min(dw, dh) / 2 - 2;
    const minR = maxR * 0.35;
    let lines = "";
    for (let i = 0; i < n; i++) {
      const v = Math.abs(Math.sin(i * 0.5) * 0.6 + Math.sin(i * 0.2) * 0.4);
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const r = minR + (maxR - minR) * v;
      lines += `<line x1="${(cx + Math.cos(angle) * minR).toFixed(1)}" y1="${(cy + Math.sin(angle) * minR).toFixed(1)}" x2="${(cx + Math.cos(angle) * r).toFixed(1)}" y2="${(cy + Math.sin(angle) * r).toFixed(1)}" stroke="${escapeAttr(color)}" stroke-width="${lineWidth}" stroke-linecap="round"/>`;
    }
    return buildMicPreviewFrame(lines, width, height, opacity, rotation, mirror);
  }

  // Огибающая: сглаженный спектр с заливкой вниз — копия `_drawCurve` из
  // живого виджета, но с зафиксированным «спектром».
  function buildCurvePreview({ width, height, opacity, color, barCount, lineWidth, rotation, mirror }) {
    const { w: dw, h: dh } = micDrawSize(width, height, rotation);
    const n = Math.max(2, Math.round(barCount));
    const stepX = dw / Math.max(1, n - 1);
    const value = (i) => Math.abs(Math.sin(i * 0.5) * 0.6 + Math.sin(i * 0.19) * 0.4);
    const top = (i) => dh - Math.max(0.04, value(i)) * dh * 0.96;
    let prevX = 0;
    let prevY = top(0);
    let d = `M${prevX.toFixed(1)} ${prevY.toFixed(1)}`;
    for (let i = 1; i < n; i++) {
      const x = i * stepX;
      const y = top(i);
      d += ` Q${prevX.toFixed(1)} ${prevY.toFixed(1)} ${((prevX + x) / 2).toFixed(1)} ${((prevY + y) / 2).toFixed(1)}`;
      prevX = x;
      prevY = y;
    }
    d += ` Q${prevX.toFixed(1)} ${prevY.toFixed(1)} ${dw.toFixed(1)} ${prevY.toFixed(1)}`;
    d += ` L${dw.toFixed(1)} ${dh.toFixed(1)} L0 ${dh.toFixed(1)} Z`;
    const inner = `<path d="${d}" fill="${escapeAttr(color)}" fill-opacity="0.28" stroke="${escapeAttr(color)}" stroke-width="${lineWidth}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    return buildMicPreviewFrame(inner, width, height, opacity, rotation, mirror);
  }

  // The type a widget renders as under the active theme — mirrors the overlay's
  // transform(). Role widgets (chat/goal/alerts) follow the active 3D variant's
  // counterpart; everything else keeps its own type. The editor box keeps the
  // stored x/y/w/h, so the preview only swaps the visuals, never the geometry.
  function effectiveType(inst) {
    return resolveTypeForTheme
      ? resolveTypeForTheme(inst.type, state.appearance.active3dWidgets || [])
      : inst.type;
  }

  // Executive Hangar timer preview, shared by the 2D ("timer") and Grim HEX
  // ("grimhex-timer") variants — the overlay renders the same markup for both.
  // Источник всегда Longshot, поэтому превью идёт от `state.longshot`.
  function buildExecTimerPreview(config) {
    const HC = window.HangarCycle;
    const src = HC ? HC.sourceFromSnapshot(state.longshot) : null;
    if (!src || !src.ready) {
      const label = src && !src.syncing ? t("timer.notOperational") : t("timer.syncing");
      return `<div class="exec-timer" data-phase="off">
        <div class="exec-timer__head"><span class="exec-timer__title">${escapeHtml(t("timer.defaultTitle"))}</span></div>
        <div class="exec-timer__off">${escapeHtml(label)}</div>
      </div>`;
    }
    const st = HC.stateAt(HC.elapsedSec(src.anchorMs, Date.now(), src.durations), src.durations);
    const phaseKey = { red: "timer.phaseRed", green: "timer.phaseGreen", black: "timer.phaseBlack" }[st.phase];
    const lights = st.lights.map((s) => `<span class="exec-timer__light" data-state="${s}"></span>`).join("");
    const telemetry =
      st.next.kind === "blackout"
        ? t("timer.blackoutIn", { time: HC.formatDuration(st.next.inSec) })
        : st.next.kind === "green"
          ? t("timer.lightGreenIn", { light: st.next.light, time: HC.formatDuration(st.next.inSec) })
          : t("timer.lightOffIn", { light: st.next.light, time: HC.formatDuration(st.next.inSec) });
    // В блэкауте подпись строки цикла другая — как в оверлее.
    const cycleLabel =
      st.phase === "black"
        ? t("timer.redPhaseStartsIn", { time: HC.formatDuration(st.cycleRemainingSec) })
        : t("timer.cycleResetsIn", { time: HC.formatDuration(st.cycleRemainingSec) });
    return `<div class="exec-timer" data-phase="${st.phase}">
      <div class="exec-timer__head">
        <span class="exec-timer__title">${escapeHtml(t("timer.defaultTitle"))}</span>
        <span class="exec-timer__phase">${escapeHtml(t(phaseKey))}</span>
      </div>
      <div class="exec-timer__digits">${HC.formatDuration(st.phaseRemainingSec)}</div>
      ${config.showLights !== false ? `<div class="exec-timer__lights">${lights}</div>` : ""}
      ${config.showCycle !== false ? `<div class="exec-timer__cycle">${escapeHtml(cycleLabel)}</div>` : ""}
      ${config.showTelemetry !== false ? `<div class="exec-timer__telemetry">${escapeHtml(telemetry)}</div>` : ""}
    </div>`;
  }

  function tickerPreview(is3d) {
    const label = escapeHtml(t("ticker.label"));
    const item = (kind, tagKey, text) =>
      `<span class="ticker__item" data-kind="${kind}"><span class="ticker__tag">${escapeHtml(t(tagKey))}</span><span class="ticker__text">${escapeHtml(text)}</span><span class="ticker__sep">◆</span></span>`;
    const items = [
      item("donation", "ticker.tagDonation", t("ticker.donation", { user: "star_gazer", amount: `+${formatMoney(750)} ${currencySymbol("RUB")}` })),
      item("follow", "ticker.tagFollow", t("ticker.follow", { user: "neon_rider" })),
      item("sub", "ticker.tagSub", t("ticker.sub", { user: "pixelwave", tier: "2" })),
    ].join("");
    return `<div class="ticker${is3d ? " ticker--3d" : ""}" style="--ticker-font:12px;--ticker-tilt:${is3d ? "3deg" : "0deg"}">
      <div class="ticker__frame">
        <span class="ticker__label">${label}</span>
        <div class="ticker__rail"><div class="ticker__track"><div class="ticker__group">${items}</div></div></div>
      </div>
    </div>`;
  }

  // Миниатюра гирлянды для колонки редактора: дуга провода с лампочками вдоль
  // верхнего края — как у самого виджета. Пресеты повторяют `PALETTES` из
  // `overlay/widgets/garland-widget.js`: превью живёт в другой странице, так что
  // общий модуль ради пяти массивов не тянем.
  const GARLAND_PREVIEW_PALETTES = {
    classic: ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ff2d92"],
    warm: ["#ffd9a0", "#ffc46b", "#ffe6c2"],
    cool: ["#bfe3ff", "#8fd0ff", "#e8f6ff"],
    redgreen: ["#e5222b", "#1fae4b"],
    retro: ["#ff6a3d", "#ffd23f", "#3bceac", "#4d9de0", "#e15554"],
  };

  // Высота viewBox повторяет пропорции плашки (канвас 16:9): при растягивании
  // по ширине SVG масштабируется без искажения, иначе круги лампочек
  // превращаются в широкие эллипсы.
  function garlandPreview(paletteValue, geometry = {}) {
    const colors = GARLAND_PREVIEW_PALETTES[paletteValue] || GARLAND_PREVIEW_PALETTES.classic;
    const w = Math.max(1, Number(geometry.w) || 96);
    const h = Math.max(1, Number(geometry.h) || 10);
    const height = Math.max(4, Math.min(100, (100 * h * 9) / (w * 16)));
    const y0 = Math.max(0.8, height * 0.14);
    const r = Math.max(0.9, Math.min(2.6, height * 0.2));
    const dip = Math.max(0.8, height - y0 - r * 2.2);
    const ctrl = (y0 + dip * 2).toFixed(2);
    // Точки на той же квадратичной кривой, что и провод: t = 0.2 / 0.5 / 0.8.
    const bulbs = [0.2, 0.5, 0.8]
      .map((t, index) => {
        const q = 1 - t;
        const x = q * q * 2 + 2 * q * t * 50 + t * t * 98;
        const y = y0 + 2 * q * t * 2 * dip;
        const color = escapeAttr(colors[index % colors.length]);
        const cy = (y + r * 1.1).toFixed(2);
        return `<circle cx="${x.toFixed(2)}" cy="${cy}" r="${r.toFixed(2)}" fill="${color}"/>`;
      })
      .join("");
    return `<div class="garland" style="position:relative;width:100%;height:100%;pointer-events:none;"><svg class="garland__svg" viewBox="0 0 100 ${height.toFixed(2)}" preserveAspectRatio="none" aria-hidden="true" style="width:100%;height:100%;"><path d="M2 ${y0.toFixed(2)} Q50 ${ctrl} 98 ${y0.toFixed(2)}" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="0.8" vector-effect="non-scaling-stroke"/>${bulbs}</svg></div>`;
  }

  // Миниатюра снегопада: статичное поле точек — та же картинка, что в эфире,
  // но без анимации. Точки — обычные `span` в процентах, поэтому круги не
  // растягиваются вместе с плашкой.
  function snowPreview(config = {}) {
    const raw = String(config.color == null ? "" : config.color).trim();
    const color = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw) ? raw : "#ffffff";
    const density = Math.max(5, Math.min(100, Number(config.density) || 40));
    const count = Math.max(12, Math.round((density / 100) * 48));
    const flakes = Array.from({ length: count }, (_, i) => {
      // Детерминированный разброс: превью не должно мерцать при перерисовке.
      const x = ((i * 37.7 + 11) % 100).toFixed(1);
      const y = ((i * 61.3 + 7) % 100).toFixed(1);
      const size = (1.5 + ((i * 13) % 7) * 0.45).toFixed(1);
      const opacity = (0.3 + ((i * 17) % 10) / 14).toFixed(2);
      return `<span style="position:absolute;left:${x}%;top:${y}%;width:${size}px;height:${size}px;border-radius:50%;background:${escapeAttr(color)};opacity:${opacity};"></span>`;
    }).join("");
    return `<div class="snow" style="position:relative;width:100%;height:100%;pointer-events:none;">${flakes}</div>`;
  }

  function buildPreviewHtml(inst) {
    const config = inst.config || {};
    const previewType = effectiveType(inst);
    if (previewType === "ticker" || previewType.endsWith("-ticker")) {
      return tickerPreview(previewType !== "ticker");
    }
    switch (previewType) {
      case "goal": {
        const pct = state.goal.target ? Math.min(100, Math.round((state.goal.current / state.goal.target) * 100)) : 0;
        const noBg = config.showBackground === false ? " widget-goal--no-bg" : "";

        // Elite (2D) previews the Cobra-style 10-segment readout.
        let barHtml = `<div class="md-linear-progress"><div class="md-linear-progress__bar" style="width:${pct}%"></div></div>`;
        if (state.appearance.activeThemeId === "elite") {
          let cells = "";
          for (let i = 0; i < 10; i++) {
            const segStart = (i * 100) / 10;
            const fill = Math.max(0, Math.min(1, (pct - segStart) / 10));
            cells += `<div class="widget-goal__seg"><div class="widget-goal__seg-fill" style="width:${Math.round(fill * 100)}%"></div></div>`;
          }
          barHtml = `<div class="widget-goal__segments">${cells}</div>`;
        }

        return `<div class="widget-goal${noBg}">
          <div class="widget-goal__row">
            <span class="widget-goal__title">${escapeHtml(state.goal.title || t("preview.goalTitle"))}</span>
            <span class="widget-goal__amounts"><b>${formatMoney(state.goal.current)}</b> / ${formatMoney(state.goal.target)} ${escapeHtml(currencySymbol(state.goal.currency))}</span>
          </div>
          ${barHtml}
          ${config.showPercentage ? `<div class="widget-goal__percent">${pct}%</div>` : ""}
        </div>`;
      }
      case "chat": {
        const max = Math.min(3, config.maxMessages || 8);
        const rows = sampleChat().slice(0, max)
          .map((m) => {
            const badges = (m.badges || []).map((b) => `<span class="widget-chat__badge">${b.slice(0, 1).toUpperCase()}</span>`).join("");
            return `<div class="widget-chat__msg">${badges}<span class="widget-chat__user" style="color:${m.color}">${m.user}</span><span class="widget-chat__colon">:</span><span class="widget-chat__text">${escapeHtml(m.message)}</span></div>`;
          })
          .join("");
        return `<div class="widget-chat">${rows}</div>`;
      }
      case "grimhex-recent":
      case "nuclear-recent":
      case "cobra-recent":
      case "teso-recent":
      case "wardogs-recent":
      case "md3-recent":
      case "pixel-recent":
      case "retrowave-recent":
      case "sf-recent":
      case "win98-recent": {
        const items = SAMPLE_RECENT.slice(0, Math.min(3, config.maxItems || 5))
          .map((e) => `<div class="widget-recent__item widget-recent3d__item"><span class="widget-recent__dot" data-kind="${escapeAttr(e.kind)}"></span><span class="widget-recent3d__text">${recentTextPreview(e)}</span></div>`)
          .join("");
        const preview = `<div class="widget-recent widget-recent3d"><div class="widget-recent__title">${t("preview.recentTitle")}</div><div class="widget-recent__list widget-recent3d__list">${items}</div></div>`;
        const transform = perspectiveStyle(config);
        return transform ? `<div style="width:100%;height:100%;transform:${transform};transform-style:preserve-3d;">${preview}</div>` : preview;
      }
      case "recent": {
        const max = Math.min(3, config.maxItems || 5);
        const items = SAMPLE_RECENT.slice(0, max)
          .map((e) => `<div class="widget-recent__item"><span class="widget-recent__dot" data-kind="${e.kind}"></span><span>${recentTextPreview(e)}</span></div>`)
          .join("");
        const preview = `<div class="widget-recent"><div class="widget-recent__title">${t("preview.recentTitle")}</div><div class="widget-recent__list">${items}</div></div>`;
        const transform = perspectiveStyle(config);
        return transform ? `<div style="width:100%;height:100%;transform:${transform};transform-style:preserve-3d;">${preview}</div>` : preview;
      }
      case "alerts":
        return `<div class="widget-alerts-host"><div class="widget-alert" data-kind="follow">
          <div class="widget-alert__icon">${ICONS.follow}</div>
          <div class="widget-alert__body">
            <div class="widget-alert__status"><span class="widget-alert__dot"></span><span class="widget-alert__kicker">${t("preview.followKicker")}</span></div>
            <div class="widget-alert__name">nova_viewer</div>
          </div>
          <div class="widget-alert__lockbar"><div class="widget-alert__lockbar-fill"></div></div>
        </div></div>`;
      case "custom": {
        const mode = config.mode || "text";
        const withCard = mode !== "image" && mode !== "video" && config.showBackground !== false;
        if (mode === "image") {
          const src = resolveMediaUrl ? resolveMediaUrl(config.imageUrl) : config.imageUrl;
          return src
            ? `<div class="widget-custom"><img class="widget-custom__image" src="${escapeAttr(src)}" style="object-fit:${escapeAttr(config.imageFit || "contain")}" alt=""></div>`
            : `<div class="widget-custom"></div>`;
        }
        if (mode === "video") {
          // В превью всегда без звука и с повтором: звук панели не нужен,
          // а короткий ролик иначе закончился бы пустым прямоугольником.
          const src = resolveMediaUrl ? resolveMediaUrl(config.videoUrl) : config.videoUrl;
          const fit = config.videoFit === "cover" ? "cover" : "contain";
          return src
            ? `<div class="widget-custom"><video class="widget-custom__video" src="${escapeAttr(src)}" style="object-fit:${fit}" autoplay loop muted playsinline preload="metadata"></video></div>`
            : `<div class="widget-custom"></div>`;
        }
        if (mode === "html") {
          const doc = buildCustomWidgetDocument(config);
          return `<div class="widget-custom${withCard ? " has-card" : ""}"><iframe class="widget-custom__html" srcdoc="${escapeAttr(doc)}"></iframe></div>`;
        }
        const title = config.textTitle ? `<div class="widget-custom__title">${escapeHtml(config.textTitle)}</div>` : "";
        const colorStyle = config.textColor ? ` style="color:${escapeAttr(config.textColor)}"` : "";
        return `<div class="widget-custom${withCard ? " has-card" : ""}"><div class="widget-custom__text" data-align="${escapeAttr(config.textAlign || "center")}">${title}<div class="widget-custom__body" data-size="${escapeAttr(config.textSize || "medium")}"${colorStyle}>${escapeHtml(config.text || "")}</div></div></div>`;
      }
      case "stat": {
        const metric = config.metric || "followers";
        const sample =
          metric === "subscribers"
            ? { icon: ICONS.sub, label: config.label || t("preview.subscribers"), value: state.stats.subscriberCount != null ? formatMoney(state.stats.subscriberCount) : "—" }
            : metric === "latestFollower"
            ? { icon: ICONS.follow, label: config.label || t("preview.latestFollower"), value: "star_gazer" }
            : metric === "latestSubscriber"
            ? { icon: ICONS.sub, label: config.label || t("preview.latestSubscriber"), value: "nova_viewer" }
            : metric === "topDonation"
            ? { icon: ICONS.donation, label: config.label || t("preview.topDonation"), value: state.topDonation.amount > 0 ? `${state.topDonation.user} (${formatMoney(state.topDonation.amount)} ${currencySymbol(state.topDonation.currency)})` : t("scene.notYet") }
            // Счёт стрима показывает живые данные, как и остальные метрики с сервера:
            // выбранная метрика на канвасе должна совпадать с эфиром, а не с примером.
            : metric === "sessionDonations"
            ? { icon: ICONS.donation, label: config.label || t("preview.sessionDonations"), value: state.sessionDonations ? formatMoney(state.sessionDonations.count) : "—" }
            : metric === "sessionAmount"
            ? { icon: ICONS.donation, label: config.label || t("preview.sessionAmount"), value: state.sessionDonations ? formatSessionAmount(state.sessionDonations) : "—" }
            : { icon: ICONS.follow, label: config.label || t("preview.followers"), value: state.stats.followerCount != null ? formatMoney(state.stats.followerCount) : "—" };
        return `<div class="widget-stat"><div class="widget-stat__icon">${sample.icon}</div><div class="widget-stat__info"><span class="widget-stat__label">${escapeHtml(sample.label)}</span><span class="widget-stat__value">${escapeHtml(sample.value)}</span></div></div>`;
      }
      case "social": {
        const s = (config.socials || [])[0] || { platform: "TG", text: "t.me/your_channel" };
        return `<div class="widget-social"><div class="widget-social__content"><span class="widget-social__icon">${escapeHtml(s.platform)}</span><div class="widget-social__info"><span class="widget-social__platform">${escapeHtml(s.platform)}</span><span class="widget-social__handle">${escapeHtml(s.text)}</span></div></div></div>`;
      }
      case "participants": {
        const live = state.giveaway && Array.isArray(state.giveaway.participants) ? state.giveaway.participants : [];
        const all = live.length ? live : SAMPLE_PARTICIPANTS;
        const count = state.giveaway && state.giveaway.count != null ? state.giveaway.count : all.length;
        const style = `--pw-font-size:${Math.min(64, Math.max(8, Number(config.fontSize) || 16))}px;--pw-text:${escapeAttr(config.textColor || "var(--md-on-surface)")};--pw-bg-opacity:${Math.min(100, Math.max(0, config.backgroundOpacity == null ? 82 : Number(config.backgroundOpacity)))}%;`;
        const title = `<div class="widget-participants__title">${escapeHtml(t("wheelScene.participantsTitle", { count }))}</div>`;
        if (config.marquee) {
          const text = all.join(" • ");
          return `<div class="widget-participants" style="${style}">${title}<div class="widget-participants__marquee"><span>${escapeHtml(text)}</span><span>${escapeHtml(text)}</span></div></div>`;
        }
        const max = Math.max(1, Number(config.maxNames) || 10);
        const names = all.slice(0, max);
        const extra = Math.max(0, count - names.length);
        return `<div class="widget-participants" style="${style}">${title}<div class="widget-participants__list">${names.map((name) => `<span class="widget-participants__chip">${escapeHtml(name)}</span>`).join("")}${extra > 0 ? `<span class="widget-participants__more">+${extra}</span>` : ""}</div></div>`;
      }
      case "timer":
      case "grimhex-timer":
        return buildExecTimerPreview(config);
      case "donatex-ai": {
        // Аудио-мост ничего не рисует в эфире, но на канвасе должен быть виден:
        // иначе пустой прямоугольник легко потерять среди виджетов. Ссылки
        // живут в настройках DonateX, старые поля раскладки — запасной путь.
        const donatexWidgets = (state.donatex && state.donatex.widgets) || {};
        const bridge = [donatexWidgets.donation, donatexWidgets.ai, config.donationUrl, config.url].some(
          (value) => String(value || "").trim() !== "",
        );
        const icon = bridge ? ICONS.widgetSoundboard : ICONS.widgetDonatexAi;
        const label = bridge ? t("preview.donatexAudio") : t("widgets.donatex-ai");
        const html = `<div class="canvas-widget__placeholder">${icon}<span>${escapeHtml(label)}</span></div>`;
        // Наклон виден и в редакторе: пузырь на канвасе не должен лежать ровно,
        // если в эфире он стоит под углом.
        const transform = perspectiveStyle(config);
        return transform
          ? `<div style="width:100%;height:100%;transform:${transform};transform-style:preserve-3d;">${html}</div>`
          : html;
      }
      case "music": {
        // Та же строка, что в эфире, и с тем же наклоном: без неё виджет
        // на канвасе — пустой прямоугольник, который легко потерять.
        const html = `<div class="widget-music"><div class="orbital"><span class="orbital__badge" aria-hidden="true"><i></i><i></i><i></i></span><div class="orbital__track"><span class="orbital__track-text">${escapeHtml(t("music.track"))}</span></div></div></div>`;
        const transform = perspectiveStyle(config);
        return transform
          ? `<div style="width:100%;height:100%;transform:${transform};transform-style:preserve-3d;">${html}</div>`
          : html;
      }
      case "roulette": {
        // Та же лента и те же карточки, что в эфире: так проценты, категории
        // и декор темы видно ещё до включения виджета.
        const items = Array.isArray(config.items) && config.items.length ? config.items : [];
        const sample = items.length ? items.slice(0, 6) : [{ title: t("widgets.roulette"), category: "common" }];
        const cards = sample
          .map(
            (item) =>
              `<div class="roulette__card is-${escapeAttr(item.category || "common")}"><span class="roulette__card-title">${escapeHtml(item.title || "")}</span><span class="roulette__card-cat">${escapeHtml(t("roulette.category." + (item.category || "common")))}</span></div>`
          )
          .join("");
        const html = `<div class="widget-roulette"><div class="roulette${config.showBackground === false ? " is-bare" : ""}"><div class="roulette__viewport"><div class="roulette__track">${cards}</div><div class="roulette__pointer"></div></div></div></div>`;
        const transform = perspectiveStyle(config);
        return transform
          ? `<div style="width:100%;height:100%;transform:${transform};transform-style:preserve-3d;">${html}</div>`
          : html;
      }
      case "mic": {
        const themePrimary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#0060A8";
        const color = config.color || state.micConfig.color || themePrimary;
        const opacity = Number(micCfg(config, "opacity", 0.9)) || 0.9;
        const mode = micCfg(config, "visualizer_mode", "sine");
        const barCount = Number(micCfg(config, "barCount", 32)) || 32;
        const gap = Number(micCfg(config, "barGap", 2)) || 0;
        const lineWidth = Number(micCfg(config, "lineWidth", 2)) || 2;
        const rotation = micRotation(config.rotation);
        const mirror = micCfg(config, "mirror", false) === true;
        const width = 400;
        const height = 80;
        let preview;
        if (mode === "bars-up") preview = buildBarsUpPreview({ width, height, opacity, color, barCount, gap, rotation, mirror });
        else if (mode === "bars") preview = buildBarsPreview({ width, height, opacity, color, barCount, gap, rotation, mirror });
        else if (mode === "ring") preview = buildRingPreview({ width, height, opacity, color, barCount, lineWidth, rotation, mirror });
        else if (mode === "curve") preview = buildCurvePreview({ width, height, opacity, color, barCount, lineWidth, rotation, mirror });
        else preview = buildSinePreview({ width, height, opacity, color, lineWidth, rotation, mirror });
        const transform = perspectiveStyle(config);
        return transform
          ? `<div style="width:100%;height:100%;transform:${transform};transform-style:preserve-3d;">${preview}</div>`
          : preview;
      }
      case "death": {
        const label = config.label || t("preview.death");
        const color = config.color || "#ff4d4d";
        return `<div class="widget-death"><div class="widget-death__label">${escapeHtml(label)}</div><div class="widget-death__value" style="color:${escapeAttr(color)}">${state.deathCount ?? 0}</div></div>`;
      }
      case "webcam": {
        // Превью повторяет DOM-структуру оверлея, чтобы рамка на канвасе и в
        // эфире совпадала; цвет по умолчанию берётся из токена активной темы.
        const accent = /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))$/i.test(String(config.color || "").trim())
          ? String(config.color).trim()
          : "var(--md-primary)";
        const thickness = Math.max(1, Math.min(16, Number(config.thickness) || 4));
        const themeRadiusRaw = parseFloat((state.appearance.tokens && state.appearance.tokens["--panel-radius"]) || "");
        const themeRadius = Number.isFinite(themeRadiusRaw) ? Math.max(0, Math.min(64, Math.round(themeRadiusRaw))) : 16;
        const legacyRadius = Number(config.radius) === 16 && config.radiusAuto !== false;
        const radius = config.radius == null || legacyRadius ? themeRadius : Math.max(0, Math.min(64, Math.round(Number(config.radius) || 0)));
        const label = String(config.label == null ? "LIVE" : config.label).trim();
        const showLabel = config.showLabel !== false && label.length > 0;
        const position = ["top-left", "top-right", "bottom-left", "bottom-right"].includes(config.labelPosition) ? config.labelPosition : "top-left";
        const corners = config.showCorners !== false
          ? ["tl", "tr", "bl", "br"].map((corner) => `<span class="widget-webcam__corner" data-corner="${corner}"></span>`).join("")
          : "";
        // Цвет уголков и неон — те же переменные, что и в эфире: превью должно
        // совпадать с оверлеем, иначе настройка выглядит неработающей.
        const cornerColor = /^#[0-9a-f]{3,8}$/i.test(String(config.cornerColor || "").trim()) ? String(config.cornerColor).trim() : "";
        const neon = config.neon === true;
        const neonStrength = Math.max(2, Math.min(40, Math.round(Number(config.neonStrength) || 14)));
        const neonVars = neon ? `--webcam-glow:${neonStrength}px;` : "";
        const cornerVars = cornerColor ? `--webcam-corner:${escapeAttr(cornerColor)};` : "";
        const camera = config.source === "camera";
        const remote = config.source === "remote";
        const videoHtml = camera
          ? `<div class="widget-webcam__video-wrap" data-fit="${escapeAttr(config.fit === "contain" ? "contain" : "cover")}">` +
            `<div class="widget-webcam__empty">${escapeHtml(t("webcam.previewLive"))}</div>` +
            `</div>`
          : remote
            ? `<div class="widget-webcam__video-wrap" data-fit="${escapeAttr(config.fit === "contain" ? "contain" : "cover")}">` +
              `<div class="widget-webcam__empty">${escapeHtml(t(config.guestSlot ? "webcam.guestWaiting" : "webcam.guestNoSlot"))}</div>` +
              `</div>`
            : "";
        const html = `<div class="widget-webcam" data-corner-color="${cornerColor ? "custom" : ""}" data-neon="${neon ? "on" : ""}" style="--webcam-accent:${escapeAttr(accent)};--webcam-thickness:${thickness}px;--webcam-radius:${radius}px;${cornerVars}${neonVars}">
          ${config.showBackground ? `<div class="widget-webcam__backdrop"></div>` : ""}
          ${videoHtml}
          ${neon ? `<div class="widget-webcam__glow"></div>` : ""}
          ${config.showBorder !== false ? `<div class="widget-webcam__frame"></div>` : ""}
          ${corners}
          ${showLabel ? `<div class="widget-webcam__label" data-pos="${escapeAttr(position)}"><span class="widget-webcam__dot"></span><span class="widget-webcam__label-text">${escapeHtml(label)}</span></div>` : ""}
          ${config.showVignette ? `<div class="widget-webcam__vignette"></div>` : ""}
        </div>`;
        const transform = perspectiveStyle(config);
        return transform
          ? `<div style="width:100%;height:100%;transform:${transform};transform-style:preserve-3d;">${html}</div>`
          : html;
      }
      case "soundboard": {
        return `<div class="widget-soundboard"><div class="widget-soundboard__placeholder">🔊 ${escapeHtml(t("widgets.soundboard"))}</div></div>`;
      }
      case "garland": {
        return garlandPreview(config.palette, inst);
      }
      case "snow": {
        return snowPreview(config);
      }
      case "grimhex": {
        const primary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#FF1800";
        return `<div class="widget-grimhex-preview">
          <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%">
            <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9L12 3z" fill="none" stroke="${escapeAttr(primary)}" stroke-width="1.2"/>
            <path d="M12 8l4.5 2.6v5.2L12 18.4 7.5 15.8v-5.2L12 8z" fill="none" stroke="${escapeAttr(primary)}" stroke-width="0.8"/>
          </svg>
        </div>`;
      }
      case "musain": {
        const amber = "#ffb300";
        return `<div class="widget-grimhex-preview" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" style="width:72%;height:72%;">
            <path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z" fill="none" stroke="${amber}" stroke-width="1.2"/>
            <path d="M17 10h1a2.5 2.5 0 0 1 0 5h-1" fill="none" stroke="${amber}" stroke-width="1.2"/>
            <path d="M8 4c0 1-.8 1-.8 2M12 4c0 1-.8 1-.8 2" fill="none" stroke="${amber}" stroke-width="1.2"/>
          </svg>
        </div>`;
      }
      case "elite-sign": {
        const orange = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#ff7605";
        return `<div class="widget-grimhex-preview" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" style="width:72%;height:72%;filter:drop-shadow(0 0 6px ${escapeAttr(orange)});">
            <path d="M12 3l2.5 4.5L21 5.5l-1.8 4.7 4.4 1.8-5.6 1.2 2 4.3-5.5-1.6L12 21l-2.5-5.1-5.5 1.6 2-4.3-5.6-1.2 4.4-1.8L3 5.5l6.5 2L12 3z" fill="${escapeAttr(orange)}"/>
          </svg>
        </div>`;
      }
      case "teso-seal": {
        const gold = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#c7a75c";
        const emblem = window.SharedTesoEmblem || { d: "", w: 652.32001, h: 626.40002 };
        return `<div class="widget-grimhex-preview" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 ${emblem.w} ${emblem.h}" preserveAspectRatio="xMidYMid meet" style="width:82%;height:82%;filter:drop-shadow(0 0 6px ${escapeAttr(gold)});">
            <path d="${escapeAttr(emblem.d)}" fill="${escapeAttr(gold)}" stroke="none"/>
          </svg>
        </div>`;
      }
      case "teso-chat": {
        const gold = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#c7a75c";
        const goldBright = (state.appearance.tokens && state.appearance.tokens["--md-secondary"]) || "#e2c47e";
        const rows = [
          { user: "Vestige_99", badges: ["moderator"], message: t("preview.chat1") },
          { user: "TamrielHero", badges: ["subscriber"], message: t("preview.chat2") },
          { user: "SkoomaDealer", badges: ["vip"], message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div class="teso-chat__row" style="font-family:'Montserrat','Segoe UI',sans-serif;font-size:13px;line-height:1.5;color:#e6e3d8;text-shadow:1px 1px 2px rgba(0,0,0,0.9);">` +
              `${previewBadges(m.badges, "#bfc3b0")} ` +
              `<span style="color:${goldBright};font-weight:600;">${escapeHtml(m.user)}</span><span style="color:#bfc3b0;">:</span> <span>${escapeHtml(m.message)}</span></div>`
          )
          .join("");
        return `<div class="teso-chat" style="position:relative;height:100%;">
          <div style="position:absolute;inset:0;display:flex;flex-direction:column;padding:18px 24px 20px;box-sizing:border-box;">
            <div style="font-family:'Cinzel','Georgia',serif;color:${gold};text-align:center;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Game Chat</div>
            <div style="display:flex;align-items:center;margin:8px 0 10px;">
              <div style="flex:1;height:1px;background:linear-gradient(90deg,transparent,rgba(199,167,92,0.4),transparent);"></div>
              <div style="width:6px;height:6px;background:${gold};transform:rotate(45deg);margin:0 10px;box-shadow:0 0 5px ${gold};flex-shrink:0;"></div>
              <div style="flex:1;height:1px;background:linear-gradient(90deg,transparent,rgba(199,167,92,0.4),transparent);"></div>
            </div>
            <div style="flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:10px;">${rows}</div>
          </div>
        </div>`;
      }
      case "teso-goal": {
        const gold = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#c7a75c";
        const goldBright = (state.appearance.tokens && state.appearance.tokens["--md-secondary"]) || "#e2c47e";
        const goal = state.goal || {};
        const pct = goal.target ? Math.min(100, (goal.current / goal.target) * 100) : 0;
        const pctStr = config.showPercentage ? `<span style="color:${goldBright};"> (${Math.round(pct)}%)</span>` : "";
        const shape = "polygon(0 50%, 12px 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 12px 100%)";
        return `<div class="teso-goal" style="position:relative;height:100%;box-sizing:border-box;padding:2px;background:${gold};clip-path:${shape};">
          <div style="position:relative;width:100%;height:100%;box-sizing:border-box;background:#171310;box-shadow:inset 0 0 10px rgba(0,0,0,0.9);clip-path:${shape};">
            <div style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:linear-gradient(90deg,#611313,#a62323,#da3636);box-shadow:0 0 8px rgba(166,35,35,0.6);"></div>
            <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 20px;box-sizing:border-box;">
              <span style="font-family:'Cinzel','Georgia',serif;color:${gold};font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:1px 1px 2px rgba(0,0,0,0.95);">${escapeHtml(goal.title || t("preview.goalTitle"))}</span>
              <span style="font-family:'Cinzel','Georgia',serif;color:#bfc3b0;font-size:12px;white-space:nowrap;text-shadow:1px 1px 2px rgba(0,0,0,0.95);"><b style="color:${goldBright};">${formatMoney(goal.current)}</b> / ${formatMoney(goal.target)}${pctStr}</span>
            </div>
          </div>
        </div>`;
      }
      case "teso-holo-alert": {
        const gold = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#c7a75c";
        const icon = (ICONS.follow || "").replace("<svg ", '<svg width="100%" height="100%" ');
        return `<div class="teso-holo-preview" style="position:relative;height:100%;display:flex;align-items:center;gap:14px;padding:12px 16px;box-sizing:border-box;">
          <div style="width:48px;height:48px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(0,0,0,0.35);border:1px solid ${gold}66;box-shadow:0 0 16px ${gold}55;color:${gold};">${icon}</div>
          <div style="min-width:0;display:flex;flex-direction:column;gap:3px;">
            <span style="font-family:'Cinzel','Georgia',serif;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#bfc3b0;">TESO // ${escapeHtml(t("alert.follow"))}</span>
            <span style="font-family:'Cinzel','Georgia',serif;font-size:20px;font-weight:700;color:#e6e3d8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:1px 1px 2px rgba(0,0,0,0.9);">nova_viewer</span>
          </div>
        </div>`;
      }
      case "grimhex-chat": {
        const rows = [
          { user: "nova_viewer", badges: ["moderator"], message: t("preview.chat1") },
          { user: "star_gazer", badges: ["subscriber"], message: t("preview.chat2") },
          { user: "orbit_fan", badges: ["vip"], message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div class="grimhex-chat__row" style="display:flex;gap:7px;font-size:13px;line-height:1.55;color:#e9eef2;">
                ${config.showTime === false ? "" : `<span style="color:#64748b">[12:00]</span>`}
                ${previewBadges(m.badges, "#64748b")}
                <span style="color:#F97316;font-weight:700">${escapeHtml(m.user)}</span>
                <span style="color:#64748b">:</span>
                <span style="color:#e9eef2">${escapeHtml(m.message)}</span>
              </div>`
          )
          .join("");
        return `<div class="grimhex-chat" style="position:relative;height:100%;"><div class="chat-messages-container" style="position:absolute;overflow:hidden;left:0;right:0;top:0;bottom:0;display:flex;flex-direction:column;justify-content:flex-end;padding:22px 26px;box-sizing:border-box;">${rows}</div></div>`;
      }
      case "grimhex-goal": {
        const pct = state.goal && state.goal.target ? Math.min(100, Math.round((state.goal.current / state.goal.target) * 100)) : 0;
        const red = "#ff1800";
        const green = "#00ff66";
        const sectors = [0, 1, 2, 3, 4]
          .map((i) => {
            const fill = Math.max(0, Math.min(1, (pct - i * 20) / 20));
            const x = 6 + i * 38;
            return `<rect x="${x}" y="12" width="36" height="36" rx="3" fill="${red}"/>` +
              (fill > 0.01 ? `<rect x="${x}" y="12" width="${Math.max(3, Math.round(36 * fill))}" height="36" rx="3" fill="${green}"/>` : "");
          })
          .join("");
        return `<div class="grimhex-goal-preview" style="position:relative;height:100%;display:flex;flex-direction:column;padding:4px;">
          <div style="display:flex;justify-content:space-between;gap:10px;color:#e9eef2;font-size:11px;"><span style="font-family:'Orbitron','Segoe UI',sans-serif;">${escapeHtml(state.goal.title || t("preview.goalTitle"))}</span><span style="color:#64748b;font-family:'Orbitron','Consolas',monospace;">${formatMoney(state.goal.current)} / ${formatMoney(state.goal.target)}</span></div>
          <svg viewBox="0 0 200 60" preserveAspectRatio="xMidYMid meet" style="flex:1;width:100%;min-height:0;">${sectors}</svg>
        </div>`;
      }
      case "grimhex-holo-alert": {
        const cyan = "#00f0ff";
        return `<div class="grimhex-holo-preview" style="position:relative;height:100%;display:flex;align-items:center;gap:8px;padding:6px 8px;box-sizing:border-box;">
          <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" style="flex-shrink:0;width:40px;height:40px;">
            <path d="M12 2.8l7.6 4.4v7.6L12 19.2l-7.6-4.4V7.2L12 2.8z" fill="none" stroke="${cyan}" stroke-width="1.2"/>
            <path d="M12 8.4c-1.2-1.7-3.4-1.6-4.2 0-0.7 1.4.1 3.1 1.2 4.1 1 .9 2.2 1.7 3 2.4.8-.7 2-1.5 3-2.4 1.1-1 1.9-2.7 1.2-4.1-0.8-1.6-3-1.7-4.2 0z" fill="none" stroke="${cyan}" stroke-width="0.9"/>
          </svg>
          <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
            <span style="font-size:9px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#8ab4d0;">HOLO // TERMINAL</span>
            <span style="font-size:13px;font-weight:700;color:#dcebf5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">star_gazer</span>
            <span style="font-size:10px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${cyan};">${escapeHtml(t("properties.testFollow"))}</span>
          </div>
        </div>`;
      }
      case "uec-transfer": {
        const tokens = state.appearance.tokens || {};
        const cyan = tokens["--md-primary"] || "#00f0ff";
        const text = tokens["--md-on-surface"] || "#dcebf5";
        const muted = tokens["--md-on-surface-variant"] || "#8ab4d0";
        const panelBg = tokens["--panel-bg"] || "rgba(8, 14, 20, 0.92)";
        const panelBorder = tokens["--panel-border"] || "1px solid rgba(0, 240, 255, 0.35)";
        const panelRadius = tokens["--panel-radius"] || "0px";
        const panelClip = tokens["--panel-clip"] || "none";
        // Срез Retrowave 26px рассчитан на высокие панели. В превью виджета он
        // съедает заголовок и бейдж, поэтому берём ту же мягкую кромку, что у
        // самой панели UEC в shared/widgets.css.
        const previewClip =
          tokens["--panel-decoration"] === "retrowave"
            ? "polygon(14px 0, 100% 0, 100% 100%, 0 100%)"
            : panelClip;
        const previewPadding =
          tokens["--panel-decoration"] === "retrowave" ? "8px 12px 8px 20px" : "8px 12px";
        const panelGlow = tokens["--panel-glow"] || "0 0 15px rgba(0, 240, 255, 0.3)";
        const channel = escapeHtml(config.channel || t("uec.channel"));
        const amountColor = donationQualityColor(250);
        return `<div class="uec-transfer-preview" style="position:relative;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:${previewPadding};background-color:${panelBg};border:${panelBorder};border-radius:${panelRadius};clip-path:${previewClip};box-shadow:${panelGlow};font-family:'Orbitron','Segoe UI',sans-serif;">
          <div style="display:flex;align-items:center;gap:6px;color:${cyan};font-size:8px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;white-space:nowrap;">
            <svg viewBox="0 0 24 24" style="width:12px;height:12px;flex-shrink:0;color:${cyan};"><path d="M12 2.4l8.2 4.7v9.8L12 21.6l-8.2-4.7V7.1L12 2.4z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M12 6.2l4.9 2.8v5.9L12 17.8l-4.9-2.9V9L12 6.2z" fill="none" stroke="currentColor" stroke-width="0.9"/></svg>
            <span>${escapeHtml(t("uec.transmission"))}</span>
            <span style="opacity:.5">·</span>
            <span style="color:${text};overflow:hidden;text-overflow:ellipsis;">${channel}</span>
            <span style="margin-left:auto;border:1px solid ${cyan};padding:2px 6px;color:${text};">${escapeHtml(t("uec.chipDonation"))}</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:0;">
            <div style="min-width:0;display:flex;flex-direction:column;gap:2px;border-left:2px solid ${cyan};padding-left:6px;">
              <span style="font-size:7px;letter-spacing:1.4px;color:${muted};text-transform:uppercase;">${escapeHtml(t("uec.callsign"))}</span>
              <span style="font-size:16px;color:${text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">star_gazer</span>
              <span style="font-size:7px;color:${muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(t("uec.commLog"))} · ${escapeHtml(t("uec.emptyLog"))}</span>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;border-left:1px solid color-mix(in srgb, ${cyan} 20%, transparent);padding-left:10px;flex-shrink:0;">
              <span style="font-size:7px;letter-spacing:1.2px;color:${cyan};text-transform:uppercase;">${escapeHtml(t("uec.credited"))}</span>
              <span style="font-size:16px;color:${amountColor};white-space:nowrap;">+${formatMoney(250)} ${currencySymbol("RUB")}</span>
              <span style="font-size:7px;letter-spacing:1.2px;color:${muted};text-transform:uppercase;">${escapeHtml(t("uec.decoded"))}</span>
            </div>
          </div>
        </div>`;
      }
      case "grimhex-radar": {
        const cyan = "#00f0ff";
        return `<div class="grimhex-radar-preview" style="position:relative;height:100%;display:flex;align-items:center;justify-content:center;padding:4px;box-sizing:border-box;">
          <svg viewBox="0 0 120 80" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;">
            <ellipse cx="60" cy="40" rx="48" ry="18" fill="none" stroke="${cyan}" stroke-width="1"/>
            <ellipse cx="60" cy="40" rx="32" ry="12" fill="none" stroke="${cyan}" stroke-width="0.6" opacity="0.5"/>
            <ellipse cx="60" cy="40" rx="16" ry="6" fill="none" stroke="${cyan}" stroke-width="0.5" opacity="0.4"/>
            <path d="M60 22v36M12 40h96" fill="none" stroke="${cyan}" stroke-width="0.4" opacity="0.4"/>
            <path d="M60 36l3.4 4-3.4-4z" fill="none" stroke="${cyan}" stroke-width="1"/>
            <path d="M32 38l-3.4 4-3.4-4 3.4-2.4z" fill="none" stroke="#ffffff" stroke-width="1"/>
            <path d="M86 44v-9" stroke="${cyan}" stroke-width="0.6" opacity="0.6"/>
            <path d="M82 33h8v8h-8z" fill="none" stroke="#ffaa00" stroke-width="1"/>
          </svg>
        </div>`;
      }
      case "nuclear": {
        const green = "#39ff14";
        const cx = 12;
        const cy = 12;
        const rOut = 10;
        const rIn = 4.6;
        const rDot = 2.6;
        const pt = (r, ang) =>
          (cx + r * Math.cos(ang)).toFixed(2) + " " + (cy + r * Math.sin(ang)).toFixed(2);
        const blades = [0, 1, 2]
          .map((i) => {
            const a = -Math.PI / 2 + i * ((Math.PI * 2) / 3);
            const a0 = a - Math.PI / 6;
            const a1 = a + Math.PI / 6;
            return (
              "M" + pt(rIn, a0) +
              "L" + pt(rOut, a0) +
              "A" + rOut + " " + rOut + " 0 0 1 " + pt(rOut, a1) +
              "L" + pt(rIn, a1) +
              "A" + rIn + " " + rIn + " 0 0 0 " + pt(rIn, a0) +
              "Z"
            );
          })
          .join("");
        return `<div class="widget-nuclear-preview" style="position:relative;height:100%;display:flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" style="width:72%;height:72%;">
            <circle cx="12" cy="12" r="10" fill="none" stroke="${green}" stroke-width="1.1"/>
            <path d="${blades}" fill="${green}"/>
            <circle cx="12" cy="12" r="${rDot}" fill="${green}"/>
          </svg>
        </div>`;
      }
      case "nuclear-chat": {
        const rows = [
          { user: "nova_viewer", badges: ["moderator"], message: t("preview.chat1") },
          { user: "star_gazer", badges: ["subscriber"], message: t("preview.chat2") },
          { user: "orbit_fan", badges: ["vip"], message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div class="nuclear-chat__row" style="display:flex;gap:7px;font-size:13px;line-height:1.55;color:#a7ada8;">
                ${config.showTime === false ? "" : `<span style="color:#59615b">[12:00]</span>`}
                ${previewBadges(m.badges, "#59615b")}
                <span style="color:#d3d8d4;font-weight:700">${escapeHtml(m.user)}</span>
                <span style="color:#59615b">:</span>
                <span style="color:#a7ada8">${escapeHtml(m.message)}</span>
              </div>`
          )
          .join("");
        return `<div class="nuclear-chat" style="position:relative;height:100%;"><div class="chat-messages-container" style="position:absolute;overflow:hidden;left:0;right:0;top:0;bottom:0;display:flex;flex-direction:column;justify-content:flex-end;padding:22px 26px;box-sizing:border-box;">${rows}</div></div>`;
      }
      case "nuclear-goal": {
        const pct = state.goal && state.goal.target ? Math.min(100, Math.round((state.goal.current / state.goal.target) * 100)) : 0;
        const green = "#39ff14";
        const track = "#242a26";
        const sectors = [0, 1, 2, 3, 4]
          .map((i) => {
            const fill = Math.max(0, Math.min(1, (pct - i * 20) / 20));
            const x = 6 + i * 38;
            return `<rect x="${x}" y="12" width="36" height="36" rx="3" fill="${track}"/>` +
              (fill > 0.01 ? `<rect x="${x}" y="12" width="${Math.max(3, Math.round(36 * fill))}" height="36" rx="3" fill="${green}"/>` : "");
          })
          .join("");
        return `<div class="nuclear-goal-preview" style="position:relative;height:100%;display:flex;flex-direction:column;padding:4px;">
          <div style="display:flex;justify-content:space-between;gap:10px;color:#a7ada8;font-size:11px;"><span style="font-family:'IBM Plex Mono','Consolas',monospace;">${escapeHtml(state.goal.title || t("preview.goalTitle"))}</span><span style="color:#59615b;font-family:'IBM Plex Mono','Consolas',monospace;">${formatMoney(state.goal.current)} / ${formatMoney(state.goal.target)}</span></div>
          <svg viewBox="0 0 200 60" preserveAspectRatio="xMidYMid meet" style="flex:1;width:100%;min-height:0;">${sectors}</svg>
        </div>`;
      }
      case "nuclear-holo-alert": {
        const green = "#39ff14";
        const cx = 12;
        const cy = 12;
        const rOut = 10;
        const rIn = 4.6;
        const pt = (r, ang) =>
          (cx + r * Math.cos(ang)).toFixed(2) + " " + (cy + r * Math.sin(ang)).toFixed(2);
        const blades = [0, 1, 2]
          .map((i) => {
            const a = -Math.PI / 2 + i * ((Math.PI * 2) / 3);
            const a0 = a - Math.PI / 6;
            const a1 = a + Math.PI / 6;
            return (
              "M" + pt(rIn, a0) +
              "L" + pt(rOut, a0) +
              "A" + rOut + " " + rOut + " 0 0 1 " + pt(rOut, a1) +
              "L" + pt(rIn, a1) +
              "A" + rIn + " " + rIn + " 0 0 0 " + pt(rIn, a0) +
              "Z"
            );
          })
          .join("");
        return `<div class="nuclear-holo-preview" style="position:relative;height:100%;display:flex;align-items:center;gap:8px;padding:6px 8px;box-sizing:border-box;">
          <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" style="flex-shrink:0;width:40px;height:40px;">
            <circle cx="12" cy="12" r="10" fill="none" stroke="${green}" stroke-width="1.2"/>
            <path d="${blades}" fill="${green}"/>
            <circle cx="12" cy="12" r="2.4" fill="#0d100e" stroke="${green}" stroke-width="0.8"/>
          </svg>
          <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
            <span style="font-family:'IBM Plex Mono','Consolas',monospace;font-size:9px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#59615b;">NUC // TERMINAL</span>
            <span style="font-family:'IBM Plex Mono','Consolas',monospace;font-size:13px;font-weight:700;color:#a7ada8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">nova_viewer</span>
            <span style="font-family:'IBM Plex Mono','Consolas',monospace;font-size:10px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${green};">${escapeHtml(t("properties.testFollow"))}</span>
          </div>
        </div>`;
      }
      case "cobra": {
        const orange = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#ff7605";
        return `<div class="widget-cobra-preview" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" style="width:72%;height:72%;">
            <path d="M12 3 L18 10 L21 15 L18 18 L14 17 L12 20 L10 17 L6 18 L3 15 L6 10 Z" fill="none" stroke="${escapeAttr(orange)}" stroke-width="1.1" stroke-linejoin="round"/>
            <path d="M12 5 L12 18" fill="none" stroke="${escapeAttr(orange)}" stroke-width="0.7"/>
            <circle cx="12" cy="9" r="0.9" fill="${escapeAttr(orange)}"/>
          </svg>
        </div>`;
      }
      case "cobra-chat": {
        const rows = [
          { user: "nova_viewer", badges: ["moderator"], message: t("preview.chat1") },
          { user: "star_gazer", badges: ["subscriber"], message: t("preview.chat2") },
          { user: "orbit_fan", badges: ["vip"], message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div class="cobra-chat__row" style="display:flex;gap:7px;font-size:13px;line-height:1.55;color:#ffb07c;">
                ${config.showTime === false ? "" : `<span style="color:#bdb0a1">[12:00]</span>`}
                ${previewBadges(m.badges, "#bdb0a1")}
                <span style="color:#ff7605;font-weight:700">${escapeHtml(m.user)}</span>
                <span style="color:#bdb0a1">:</span>
                <span style="color:#ffb07c">${escapeHtml(m.message)}</span>
              </div>`
          )
          .join("");
        return `<div class="cobra-chat" style="position:relative;height:100%;"><div class="chat-messages-container" style="position:absolute;overflow:hidden;left:0;right:0;top:0;bottom:0;display:flex;flex-direction:column;justify-content:flex-end;padding:22px 26px;box-sizing:border-box;">${rows}</div></div>`;
      }
      case "cobra-goal": {
        const pct = state.goal && state.goal.target ? Math.min(100, Math.round((state.goal.current / state.goal.target) * 100)) : 0;
        const orange = "#ff7605";
        const track = "#33261a";
        const sectors = [0, 1, 2, 3, 4]
          .map((i) => {
            const fill = Math.max(0, Math.min(1, (pct - i * 20) / 20));
            const x = 6 + i * 38;
            return `<rect x="${x}" y="12" width="36" height="36" rx="3" fill="${track}"/>` +
              (fill > 0.01 ? `<rect x="${x}" y="12" width="${Math.max(3, Math.round(36 * fill))}" height="36" rx="3" fill="${orange}"/>` : "");
          })
          .join("");
        return `<div class="cobra-goal-preview" style="position:relative;height:100%;display:flex;flex-direction:column;padding:4px;">
          <div style="display:flex;justify-content:space-between;gap:10px;color:#ffb07c;font-size:11px;"><span style="font-family:'Orbitron','Segoe UI',sans-serif;">${escapeHtml(state.goal.title || t("preview.goalTitle"))}</span><span style="color:#bdb0a1;font-family:'Orbitron','Consolas',monospace;">${formatMoney(state.goal.current)} / ${formatMoney(state.goal.target)}</span></div>
          <svg viewBox="0 0 200 60" preserveAspectRatio="xMidYMid meet" style="flex:1;width:100%;min-height:0;">${sectors}</svg>
        </div>`;
      }
      case "wardogs-goal": {
        const fill = "#dcdcdc";
        const track = "rgba(255,255,255,0.20)";
        const text = "#e2e2e2";
        const muted = "#8f8f8f";
        const pct = state.goal && state.goal.target ? Math.min(100, Math.round((state.goal.current / state.goal.target) * 100)) : 0;
        const count = 52;
        const pitch = 194 / count;
        const stripes = Array.from({ length: count }, (_, i) => {
          const sx = 3 + i * pitch;
          const part = Math.max(0, Math.min(1, (pct - i * (100 / count)) / (100 / count)));
          const cw = pitch - 0.5;
          return `<rect x="${sx.toFixed(2)}" y="5" width="${cw.toFixed(2)}" height="12" fill="${track}"/>` +
            (part > 0.01 ? `<rect x="${sx.toFixed(2)}" y="5" width="${(cw * part).toFixed(2)}" height="12" fill="${fill}"/>` : "");
        }).join("");
        return `<div class="wardogs-goal-preview" style="position:relative;height:100%;display:flex;flex-direction:column;justify-content:center;gap:5px;padding:6px 8px;box-sizing:border-box;">
          <div style="display:flex;justify-content:space-between;gap:10px;color:${text};font-size:11px;"><span style="font-family:'Roboto Condensed','Segoe UI',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">${escapeHtml(state.goal.title || t("preview.goalTitle"))}</span><span style="color:${muted};font-family:'JetBrains Mono','Consolas',monospace;">${formatMoney(state.goal.current)} / ${formatMoney(state.goal.target)}<b style="color:${text};"> [${pct}%]</b></span></div>
          <svg viewBox="0 0 200 22" preserveAspectRatio="none" style="width:100%;height:22px;"><rect x="0.5" y="0.5" width="199" height="21" fill="none" stroke="rgba(220,220,220,0.45)"/>${stripes}</svg>
        </div>`;
      }
      case "wardogs-chat": {
        const text = (state.appearance.tokens && state.appearance.tokens["--md-on-surface"]) || "#e8e5dd";
        const muted = (state.appearance.tokens && state.appearance.tokens["--md-on-surface-variant"]) || "#b6b3a7";
        const primary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#f0a92c";
        const rows = [
          { user: "nova_viewer", badges: ["moderator"], message: t("preview.chat1") },
          { user: "star_gazer", badges: ["subscriber"], message: t("preview.chat2") },
          { user: "orbit_fan", badges: ["vip"], message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div class="wardogs-chat__row" style="display:flex;gap:7px;font-family:'Roboto Condensed','Segoe UI',sans-serif;font-size:14px;line-height:1.45;color:${escapeAttr(text)};">
                ${config.showTime === false ? "" : `<span style="color:${muted};font-family:'JetBrains Mono','Consolas',monospace;font-size:11px;">[12:00]</span>`}
                ${previewBadges(m.badges, muted)}
                <span style="color:${primary};font-weight:700">${escapeHtml(m.user)}</span>
                <span style="color:${muted}">:</span>
                <span style="color:${escapeAttr(text)}">${escapeHtml(m.message)}</span>
              </div>`
          )
          .join("");
        return `<div class="wardogs-chat" style="position:relative;height:100%;padding:12px 14px;box-sizing:border-box;display:flex;flex-direction:column;">
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;color:${escapeAttr(text)};font-family:'Roboto Condensed','Segoe UI',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:1.6px;font-size:13px;"><span style="width:7px;height:7px;background:${primary};box-shadow:0 0 6px ${primary};"></span><span>${escapeHtml(t("editor.chat"))}</span><span style="flex:1;height:5px;background:repeating-linear-gradient(90deg,${muted} 0 2px,transparent 2px 5px);opacity:0.45;"></span></div>
          <div style="flex:1;min-height:0;overflow:hidden;margin-top:10px;display:flex;flex-direction:column;justify-content:flex-end;gap:7px;">${rows}</div>
        </div>`;
      }
      case "wardogs-holo-alert": {
        const primary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#f0a92c";
        const text = (state.appearance.tokens && state.appearance.tokens["--md-on-surface"]) || "#e8e5dd";
        const muted = (state.appearance.tokens && state.appearance.tokens["--md-on-surface-variant"]) || "#b6b3a7";
        return `<div class="wardogs-holo-preview" style="position:relative;height:100%;display:flex;align-items:center;gap:10px;padding:6px 10px;box-sizing:border-box;">
          <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" style="flex-shrink:0;width:38px;height:38px;">
            <circle cx="12" cy="12" r="10" fill="none" stroke="${primary}" stroke-width="1.4" stroke-dasharray="4 3"/>
            <circle cx="12" cy="12" r="5.5" fill="${primary}" opacity="0.22"/>
            <path d="M12 7.5l1.5 3.4 3.5.5-2.6 2.4.7 3.4-3.1-1.8-3.1 1.8.7-3.4-2.6-2.4 3.5-.5L12 7.5z" fill="${primary}"/>
          </svg>
          <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
            <span style="font-family:'JetBrains Mono','Consolas',monospace;font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${muted};">WARD // ${escapeHtml(t("properties.testFollow"))}</span>
            <span style="font-family:'Roboto Condensed','Segoe UI',sans-serif;font-size:15px;font-weight:700;color:${escapeAttr(text)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">nova_viewer</span>
          </div>
        </div>`;
      }
      case "cobra-holo-alert": {
        const orange = "#ff7605";
        return `<div class="cobra-holo-preview" style="position:relative;height:100%;display:flex;align-items:center;gap:8px;padding:6px 8px;box-sizing:border-box;">
          <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" style="flex-shrink:0;width:40px;height:40px;">
            <circle cx="12" cy="12" r="9" fill="none" stroke="${orange}" stroke-width="1.2"/>
            <circle cx="12" cy="12" r="5.5" fill="none" stroke="${orange}" stroke-width="0.8"/>
            <path d="M12 6.5l1.8 4.7 5 .8-3.7 3.4 1 5-4.1-2.4-4.1 2.4 1-5L5 12l5-.8 2-4.7z" fill="none" stroke="${orange}" stroke-width="0.9"/>
          </svg>
          <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
            <span style="font-size:9px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#bdb0a1;">COBRA // TERMINAL</span>
            <span style="font-size:13px;font-weight:700;color:#ffb07c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">nova_viewer</span>
            <span style="font-size:10px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${orange};">${escapeHtml(t("properties.testFollow"))}</span>
          </div>
        </div>`;
      }
      case "cobra-shield": {
        const pct = state.goal && state.goal.target ? Math.min(100, Math.round((state.goal.current / state.goal.target) * 100)) : 0;
        const orange = "#ff7605";
        const isLow = pct < 5;
        const color = isLow ? "#ff3b30" : orange;
        const label = isLow ? "SHIELDS OFFLINE" : `SHIELD: ${pct}%`;
        return `<div class="cobra-shield-preview" style="position:relative;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:4px;box-sizing:border-box;">
          <span style="font-family:'Orbitron','Consolas',monospace;font-size:8px;color:rgba(255,118,5,0.5);">FAULCON DELACY // COBRA MK II</span>
          <svg viewBox="0 0 100 72" preserveAspectRatio="xMidYMid meet" style="flex:1;width:100%;min-height:0;">
            <ellipse cx="50" cy="36" rx="30" ry="16" fill="none" stroke="${color}" stroke-width="1.5"/>
            <ellipse cx="50" cy="36" rx="21" ry="11" fill="none" stroke="${color}" stroke-width="1"/>
            <ellipse cx="50" cy="36" rx="12" ry="6" fill="none" stroke="${color}" stroke-width="0.8"/>
            <path d="M50 25 L59 31 L55 35 L52 34 L50 36 L48 34 L45 35 L41 31 Z" fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round"/>
          </svg>
          <span style="font-family:'Orbitron',sans-serif;font-size:14px;font-weight:700;color:${color};">${label}</span>
          <span style="font-family:'Orbitron','Consolas',monospace;font-size:10px;color:#ffb07c;">SYS_CR: ${formatMoney(state.goal.current)} / ${formatMoney(state.goal.target)}</span>
        </div>`;
      }
      case "cobra-radar": {
        const orange = "#ff7605";
        return `<div class="cobra-radar-preview" style="position:relative;height:100%;display:flex;align-items:center;justify-content:center;padding:4px;box-sizing:border-box;">
          <svg viewBox="0 0 120 80" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;">
            <ellipse cx="60" cy="40" rx="48" ry="18" fill="none" stroke="${orange}" stroke-width="1"/>
            <ellipse cx="60" cy="40" rx="32" ry="12" fill="none" stroke="${orange}" stroke-width="0.6" opacity="0.5"/>
            <ellipse cx="60" cy="40" rx="16" ry="6" fill="none" stroke="${orange}" stroke-width="0.5" opacity="0.4"/>
            <path d="M60 22v36M12 40h96" fill="none" stroke="${orange}" stroke-width="0.4" opacity="0.4"/>
            <path d="M60 36l3.4 4-3.4-4z" fill="none" stroke="${orange}" stroke-width="1"/>
            <path d="M32 38l-3.4 4-3.4-4 3.4-2.4z" fill="none" stroke="${orange}" stroke-width="1"/>
            <path d="M86 44v-9" stroke="${orange}" stroke-width="0.6" opacity="0.6"/>
            <path d="M82 33h8v8h-8z" fill="none" stroke="#ff3b30" stroke-width="1"/>
          </svg>
        </div>`;
      }
      case "md3-orb": {
        const primary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#d0bcff";
        const secondary = (state.appearance.tokens && state.appearance.tokens["--md-secondary"]) || "#ccc2dc";
        return `<div class="md3-orb-preview" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="width:80%;height:80%;">
            <defs><radialGradient id="md3o" cx="35%" cy="30%" r="75%"><stop offset="0%" stop-color="${escapeAttr(secondary)}"/><stop offset="55%" stop-color="${escapeAttr(primary)}"/><stop offset="100%" stop-color="#1d192b"/></radialGradient></defs>
            <circle cx="50" cy="50" r="34" fill="url(#md3o)"/>
            <circle cx="40" cy="38" r="8" fill="rgba(255,255,255,0.45)"/>
            <ellipse cx="50" cy="50" rx="44" ry="16" fill="none" stroke="${escapeAttr(primary)}" stroke-width="1.4" opacity="0.6"/>
            <circle cx="92" cy="50" r="4" fill="${escapeAttr(secondary)}"/>
          </svg>
        </div>`;
      }
      case "md3-chat": {
        const text = (state.appearance.tokens && state.appearance.tokens["--md-on-surface"]) || "#e6e1e5";
        const muted = (state.appearance.tokens && state.appearance.tokens["--md-on-surface-variant"]) || "#cac4d0";
        const primary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#d0bcff";
        const rows = [
          { user: "nova_viewer", badges: ["moderator"], message: t("preview.chat1") },
          { user: "star_gazer", badges: ["subscriber"], message: t("preview.chat2") },
          { user: "orbit_fan", badges: ["vip"], message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              // ${text} — единственный токен, который тема хранит как есть (seeds.text),
              // поэтому в разметку он идёт только через escapeAttr: остальные акценты
              // theme-engine выводит в hex сам.
              `<div class="md3-chat__row" style="display:flex;gap:7px;font-size:13px;line-height:1.55;color:${escapeAttr(text)};">
                ${config.showTime === false ? "" : `<span style="color:${muted}">[12:00]</span>`}
                ${previewBadges(m.badges, muted)}
                <span style="color:${primary};font-weight:700">${escapeHtml(m.user)}</span>
                <span style="color:${muted}">:</span>
                <span style="color:${escapeAttr(text)}">${escapeHtml(m.message)}</span>
              </div>`
          )
          .join("");
        return `<div class="md3-chat" style="position:relative;height:100%;"><div class="chat-messages-container" style="position:absolute;overflow:hidden;left:0;right:0;top:0;bottom:0;display:flex;flex-direction:column;justify-content:flex-end;padding:22px 26px;box-sizing:border-box;">${rows}</div></div>`;
      }
      case "md3-goal": {
        const pct = state.goal && state.goal.target ? Math.min(100, Math.round((state.goal.current / state.goal.target) * 100)) : 0;
        const primary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#d0bcff";
        const secondary = (state.appearance.tokens && state.appearance.tokens["--md-secondary"]) || "#ccc2dc";
        const text = (state.appearance.tokens && state.appearance.tokens["--md-on-surface"]) || "#e6e1e5";
        const muted = (state.appearance.tokens && state.appearance.tokens["--md-on-surface-variant"]) || "#cac4d0";
        return `<div class="md3-goal-preview" style="position:relative;height:100%;display:flex;flex-direction:column;padding:4px;">
          <div style="display:flex;justify-content:space-between;gap:10px;color:${escapeAttr(text)};font-size:11px;"><span style="font-family:'Manrope','Segoe UI',sans-serif;font-weight:700;">${escapeHtml(state.goal.title || t("preview.goalTitle"))}</span><span style="color:${muted};font-family:'JetBrains Mono','Consolas',monospace;">${formatMoney(state.goal.current)} / ${formatMoney(state.goal.target)}</span></div>
          <svg viewBox="0 0 200 40" preserveAspectRatio="xMidYMid meet" style="flex:1;width:100%;min-height:0;">
            <defs><linearGradient id="md3g" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="${escapeAttr(primary)}"/><stop offset="100%" stop-color="${escapeAttr(secondary)}"/></linearGradient></defs>
            <rect x="4" y="12" width="192" height="16" rx="8" fill="rgba(255,255,255,0.10)"/>
            <rect x="4" y="12" width="${Math.max(8, Math.round(192 * pct / 100))}" height="16" rx="8" fill="url(#md3g)"/>
          </svg>
        </div>`;
      }
      case "md3-holo-alert": {
        const primary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#d0bcff";
        const text = (state.appearance.tokens && state.appearance.tokens["--md-on-surface"]) || "#e6e1e5";
        const muted = (state.appearance.tokens && state.appearance.tokens["--md-on-surface-variant"]) || "#cac4d0";
        return `<div class="md3-holo-preview" style="position:relative;height:100%;display:flex;align-items:center;gap:10px;padding:6px 10px;box-sizing:border-box;">
          <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" style="flex-shrink:0;width:36px;height:36px;">
            <circle cx="12" cy="12" r="10" fill="none" stroke="${primary}" stroke-width="1.4" stroke-dasharray="4 3"/>
            <circle cx="12" cy="12" r="5.5" fill="${primary}" opacity="0.22"/>
            <path d="M12 7.5l1.5 3.4 3.5.5-2.6 2.4.7 3.4-3.1-1.8-3.1 1.8.7-3.4-2.6-2.4 3.5-.5L12 7.5z" fill="${primary}"/>
          </svg>
          <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
            <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:${muted};">${escapeHtml(t("properties.testFollow"))}</span>
            <span style="font-size:13px;font-weight:700;color:${escapeAttr(text)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">nova_viewer</span>
          </div>
        </div>`;
      }
      case "pixel-cube":
      case "wardogs-cube": {
        const gold = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#d6b675";
        return `<div class="pixel-cube-preview" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="width:76%;height:76%;">
            <g fill="none" stroke="${gold}" stroke-linecap="square" stroke-linejoin="miter">
              <path d="M50 52 L82 68 L82 36 L50 20 L50 52 Z" stroke-width="2"/>
              <path d="M18 68 L50 84 L50 52 L18 36 L18 68 Z" stroke-width="1" opacity="0.4"/>
              <path d="M50 52 L18 68 M82 68 L50 84 M82 36 L50 52 M50 20 L18 36" stroke-width="1" opacity="0.4"/>
            </g>
          </svg>
        </div>`;
      }
      case "sf-cube": {
        const tokens = state.appearance.tokens || {};
        const glow = tokens["--sf-glow"] || tokens["--md-primary"] || "#9d4edd";
        const pink = tokens["--sf-candy-pink"] || "#ff007f";
        return `<div class="sf-cube-preview" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="width:76%;height:76%;filter:drop-shadow(0 0 5px ${escapeAttr(glow)});">
            <g fill="none" stroke="${escapeAttr(glow)}" stroke-linecap="square" stroke-linejoin="miter">
              <path d="M50 52 L82 68 L82 36 L50 20 L50 52 Z" stroke-width="2"/>
              <path d="M18 68 L50 84 L50 52 L18 36 L18 68 Z" stroke-width="1" opacity="0.45"/>
              <path d="M50 52 L18 68 M82 68 L50 84 M82 36 L50 52 M50 20 L18 36" stroke-width="1" opacity="0.45"/>
            </g>
            <path d="M50 46 L54 52 L50 58 L46 52 Z" fill="${escapeAttr(pink)}" stroke="none"/>
          </svg>
        </div>`;
      }
      case "pixel-chat": {
        const text = (state.appearance.tokens && state.appearance.tokens["--md-on-surface"]) || "#e6e6e6";
        const muted = (state.appearance.tokens && state.appearance.tokens["--md-on-surface-variant"]) || "#b8b8b8";
        const gold = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#d6b675";
        const rows = [
          { user: "nova_viewer", badges: ["moderator"], message: t("preview.chat1") },
          { user: "star_gazer", badges: ["subscriber"], message: t("preview.chat2") },
          { user: "orbit_fan", badges: ["vip"], message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div class="pixel-chat__row" style="display:flex;gap:7px;font-size:13px;line-height:1.5;color:${escapeAttr(text)};font-family:'Roboto Condensed','Segoe UI',sans-serif;">
                ${config.showTime === false ? "" : `<span style="color:${muted}">[12:00]</span>`}
                ${previewBadges(m.badges, muted)}
                <span style="color:${gold};font-weight:700">${escapeHtml(m.user)}</span>
                <span style="color:${muted}">:</span>
                <span style="color:${escapeAttr(text)}">${escapeHtml(m.message)}</span>
              </div>`
          )
          .join("");
        return `<div class="pixel-chat" style="position:relative;height:100%;"><div class="chat-messages-container" style="position:absolute;overflow:hidden;left:0;right:0;top:0;bottom:0;display:flex;flex-direction:column;justify-content:flex-end;padding:18px 22px;box-sizing:border-box;">${rows}</div></div>`;
      }
      case "pixel-goal": {
        const pct = state.goal && state.goal.target ? Math.min(100, Math.round((state.goal.current / state.goal.target) * 100)) : 0;
        const gold = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#d6b675";
        const text = (state.appearance.tokens && state.appearance.tokens["--md-on-surface"]) || "#e6e6e6";
        const muted = (state.appearance.tokens && state.appearance.tokens["--md-on-surface-variant"]) || "#b8b8b8";
        const cells = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
          .map((i) => {
            const fill = Math.max(0, Math.min(1, (pct - i * 10) / 10));
            const x = 4 + i * 19.5;
            return `<rect x="${x}" y="10" width="18" height="20" fill="#19191c" stroke="#3a3a3e" stroke-width="1"/>` +
              (fill > 0.01 ? `<rect x="${x}" y="10" width="${Math.max(1, Math.round(18 * fill))}" height="20" fill="${gold}"/>` : "");
          })
          .join("");
        return `<div class="pixel-goal-preview" style="position:relative;height:100%;display:flex;flex-direction:column;padding:4px;">
          <div style="display:flex;justify-content:space-between;gap:10px;color:${escapeAttr(text)};font-size:11px;font-family:'PT Sans Caption','Segoe UI',sans-serif;"><span style="font-weight:700;">${escapeHtml(state.goal.title || t("preview.goalTitle"))}</span><span style="color:${muted};">${formatMoney(state.goal.current)} / ${formatMoney(state.goal.target)}</span></div>
          <svg viewBox="0 0 200 40" preserveAspectRatio="xMidYMid meet" style="flex:1;width:100%;min-height:0;">${cells}</svg>
        </div>`;
      }
      case "pixel-holo-alert": {
        const gold = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#d6b675";
        const text = (state.appearance.tokens && state.appearance.tokens["--md-on-surface"]) || "#e6e6e6";
        const muted = (state.appearance.tokens && state.appearance.tokens["--md-on-surface-variant"]) || "#b8b8b8";
        return `<div class="pixel-holo-preview" style="position:relative;height:100%;display:flex;align-items:center;gap:10px;padding:6px 10px;box-sizing:border-box;font-family:'PT Sans Caption','Segoe UI',sans-serif;">
          <svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" style="flex-shrink:0;width:30px;height:30px;">
            <path d="M12 3l2.2 4.2 4.6.6-3.4 3.2.8 4.6L12 13.4 7.8 15.6l.8-4.6L5.2 7.8l4.6-.6L12 3z" fill="${gold}"/>
          </svg>
          <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
            <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${muted};">${escapeHtml(t("properties.testFollow"))}</span>
            <span style="font-size:13px;font-weight:700;color:${escapeAttr(text)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">nova_viewer</span>
          </div>
        </div>`;
      }
      case "retrowave-goal": {
        const pct = state.goal && state.goal.target ? Math.min(100, Math.round((state.goal.current / state.goal.target) * 100)) : 0;
        const primary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#ff2d95";
        const secondary = (state.appearance.tokens && state.appearance.tokens["--md-secondary"]) || "#2de2e6";
        const tertiary = (state.appearance.tokens && state.appearance.tokens["--md-tertiary"]) || "#ffa24c";
        const text = (state.appearance.tokens && state.appearance.tokens["--md-on-surface"]) || "#f3e8ff";
        const muted = (state.appearance.tokens && state.appearance.tokens["--md-on-surface-variant"]) || "#c3b0e0";
        const fillW = (199 * pct) / 100;
        const stripes = Array.from({ length: 5 }, (_, i) => `<rect x="0" y="${5 + i * 5}" width="${fillW.toFixed(2)}" height="1" fill="rgba(5,2,11,0.30)"/>`).join("");
        return `<div class="retrowave-goal-preview" style="position:relative;height:100%;display:flex;flex-direction:column;justify-content:center;gap:5px;padding:6px 8px 6px 14px;box-sizing:border-box;">
          <div style="display:flex;justify-content:space-between;gap:10px;font-size:11px;"><span style="color:${escapeAttr(text)};font-family:'Orbitron','Segoe UI',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:1.4px;">${escapeHtml(state.goal.title || t("preview.goalTitle"))}</span><span style="color:${escapeAttr(muted)};font-family:'JetBrains Mono','Consolas',monospace;">${formatMoney(state.goal.current)} / ${formatMoney(state.goal.target)} <b style="color:${escapeAttr(primary)};">[${pct}%]</b></span></div>
          <svg viewBox="0 0 200 26" preserveAspectRatio="none" style="width:100%;height:24px;">
            <defs>
              <linearGradient id="rwg" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="${escapeAttr(secondary)}"/><stop offset="55%" stop-color="${escapeAttr(primary)}"/><stop offset="100%" stop-color="${escapeAttr(tertiary)}"/></linearGradient>
              <clipPath id="rwc"><path d="M9 0.5H199.5L191 25.5H0.5Z"/></clipPath>
            </defs>
            <path d="M9 0.5H199.5L191 25.5H0.5Z" fill="rgba(5,2,11,0.82)" stroke="rgba(45,226,230,0.55)"/>
            <g clip-path="url(#rwc)">
              <rect x="0" y="0" width="${fillW.toFixed(2)}" height="26" fill="url(#rwg)"/>
              ${stripes}
              ${pct > 0 ? `<rect x="${fillW.toFixed(2)}" y="1" width="1.5" height="23" fill="#ffffff"/>` : ""}
            </g>
          </svg>
        </div>`;
      }
      case "retrowave-chat": {
        const text = (state.appearance.tokens && state.appearance.tokens["--md-on-surface"]) || "#f3e8ff";
        const muted = (state.appearance.tokens && state.appearance.tokens["--md-on-surface-variant"]) || "#c3b0e0";
        const primary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#ff2d95";
        const secondary = (state.appearance.tokens && state.appearance.tokens["--md-secondary"]) || "#2de2e6";
        const rows = [
          { user: "nova_viewer", badges: ["moderator"], message: t("preview.chat1") },
          { user: "star_gazer", badges: ["subscriber"], message: t("preview.chat2") },
          { user: "orbit_fan", badges: ["vip"], message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div style="display:flex;gap:7px;padding:3px 8px 3px 10px;font-family:'Montserrat','Segoe UI',sans-serif;font-size:12px;line-height:1.45;color:${escapeAttr(text)};background:linear-gradient(90deg,rgba(255,45,149,0.10),rgba(5,2,11,0.30) 42%,transparent);border-left:2px solid rgba(45,226,230,0.55);">
                ${config.showTime === false ? "" : `<span style="color:${escapeAttr(muted)};font-family:'JetBrains Mono','Consolas',monospace;font-size:10px;">[12:00]</span>`}
                ${previewBadges(m.badges, muted)}
                <span style="color:${escapeAttr(primary)};font-weight:700">${escapeHtml(m.user)}</span>
                <span style="color:${escapeAttr(muted)}">:</span>
                <span style="color:${escapeAttr(text)}">${escapeHtml(m.message)}</span>
              </div>`
          )
          .join("");
        return `<div class="retrowave-chat" style="position:relative;height:100%;padding:12px 12px 12px 20px;box-sizing:border-box;display:flex;flex-direction:column;">
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;color:${escapeAttr(text)};font-family:'Orbitron','Segoe UI',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:2px;font-size:11px;"><span style="width:7px;height:7px;background:${escapeAttr(primary)};box-shadow:0 0 8px ${escapeAttr(primary)};transform:rotate(45deg);"></span><span>${escapeHtml(t("editor.chat"))}</span><span style="flex:1;height:1px;background:linear-gradient(90deg,${escapeAttr(secondary)},${escapeAttr(primary)} 60%,transparent);"></span></div>
          <div style="flex:1;min-height:0;overflow:hidden;margin-top:10px;display:flex;flex-direction:column;justify-content:flex-end;gap:5px;">${rows}</div>
        </div>`;
      }
      case "retrowave-holo-alert": {
        const primary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#ff2d95";
        const secondary = (state.appearance.tokens && state.appearance.tokens["--md-secondary"]) || "#2de2e6";
        const tertiary = (state.appearance.tokens && state.appearance.tokens["--md-tertiary"]) || "#ffa24c";
        const text = (state.appearance.tokens && state.appearance.tokens["--md-on-surface"]) || "#f3e8ff";
        const stripes = [26, 30, 34, 38, 42].map((y, i) => `<rect x="6" y="${y}" width="36" height="${i < 2 ? 2 : 1.6}" fill="rgba(13,7,25,0.92)"/>`).join("");
        return `<div class="retrowave-holo-preview" style="position:relative;height:100%;display:flex;align-items:center;gap:10px;padding:6px 10px;box-sizing:border-box;">
          <svg viewBox="0 0 48 48" preserveAspectRatio="xMidYMid meet" style="flex-shrink:0;width:40px;height:40px;">
            <defs><linearGradient id="rws" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${escapeAttr(tertiary)}"/><stop offset="55%" stop-color="${escapeAttr(primary)}"/><stop offset="100%" stop-color="${escapeAttr(primary)}"/></linearGradient></defs>
            <circle cx="24" cy="24" r="18" fill="url(#rws)" opacity="0.95"/>
            <circle cx="24" cy="24" r="18" fill="none" stroke="${escapeAttr(secondary)}" stroke-width="1.2" opacity="0.65"/>
            ${stripes}
          </svg>
          <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
            <span style="font-family:'JetBrains Mono','Consolas',monospace;font-size:9px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:${escapeAttr(secondary)};">SIGNAL // ${escapeHtml(t("properties.testFollow"))}</span>
            <span style="font-family:'Orbitron','Segoe UI',sans-serif;font-size:14px;font-weight:700;color:${escapeAttr(text)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">nova_viewer</span>
          </div>
        </div>`;
      }
      case "retrowave-symbol":
      case "orbital-symbol": {
        const primary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#ff2d95";
        const secondary = (state.appearance.tokens && state.appearance.tokens["--md-secondary"]) || "#2de2e6";
        return `<div class="retrowave-symbol-preview" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="width:78%;height:78%;">
            <defs><linearGradient id="rwl" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${escapeAttr(secondary)}"/><stop offset="100%" stop-color="${escapeAttr(primary)}"/></linearGradient></defs>
            <g transform="rotate(-24 50 50)">
              <g fill="none" stroke="${escapeAttr(secondary)}" stroke-width="0.9" opacity="0.8">
                <ellipse cx="50" cy="50" rx="13" ry="40"/>
                <ellipse cx="50" cy="50" rx="26" ry="40"/>
              </g>
              <g fill="none" stroke="${escapeAttr(secondary)}" stroke-width="0.7" opacity="0.5">
                <ellipse cx="50" cy="36" rx="29" ry="6"/>
                <ellipse cx="50" cy="64" rx="29" ry="6"/>
              </g>
              <ellipse cx="50" cy="50" rx="40" ry="9" fill="none" stroke="${escapeAttr(primary)}" stroke-width="1.6"/>
              <circle cx="88" cy="50" r="2.1" fill="${escapeAttr(secondary)}"/>
            </g>
            <circle cx="50" cy="50" r="40" fill="none" stroke="url(#rwl)" stroke-width="1.2"/>
            <svg x="41" y="41" width="18" height="18" viewBox="0 0 24 24" style="filter:drop-shadow(0 0 4px ${escapeAttr(secondary)});"><path d="M12 2l2.4 6.1 6.6.4-5.1 4.2 1.7 6.4L12 15.6 6.4 19.1l1.7-6.4L3 8.5l6.6-.4L12 2z" fill="${escapeAttr(secondary)}"/></svg>
            <circle cx="33.7" cy="13.5" r="1.6" fill="${escapeAttr(secondary)}"/>
            <circle cx="66.3" cy="86.5" r="1.6" fill="${escapeAttr(secondary)}"/>
          </svg>
        </div>`;
      }
      case "sf-goal": {
        const tokens = state.appearance.tokens || {};
        const pct = state.goal && state.goal.target ? Math.min(100, Math.round((state.goal.current / state.goal.target) * 100)) : 0;
        const primary = tokens["--md-primary"] || "#7b2cbf";
        const secondary = tokens["--md-secondary"] || "#ffb700";
        const tertiary = tokens["--md-tertiary"] || "#00f5d4";
        const text = tokens["--md-on-surface"] || "#ffffff";
        const muted = tokens["--md-on-surface-variant"] || "#9a8c98";
        const bg = tokens["--panel-bg"] || "rgba(34, 22, 62, 0.92)";
        const border = tokens["--panel-border"] || "2px solid rgba(123, 44, 191, 0.55)";
        const radius = tokens["--panel-radius"] || "6px";
        const glow = tokens["--panel-glow"] || "0 0 12px rgba(157, 78, 221, 0.5)";
        // Те же 14 клеток, что и в эфире: последние три — золотая отсечка.
        const cells = Array.from({ length: 14 }, (_, i) => {
          const x = i * 14.5;
          const redline = i >= 11;
          const fill = Math.max(0, Math.min(1, (pct - i * (100 / 14)) / (100 / 14)));
          const color = redline ? secondary : i < 6 ? primary : tertiary;
          return (
            `<rect x="${x}" y="0" width="13" height="22" fill="${redline ? "rgba(255,183,0,0.16)" : "rgba(154,140,152,0.12)"}"/>` +
            (fill > 0 ? `<rect x="${x}" y="0" width="${(13 * fill).toFixed(2)}" height="22" fill="${color}"/>` : "") +
            (fill > 0 && fill < 1 ? `<rect x="${(x + 13 * fill - 1).toFixed(2)}" y="1" width="1" height="20" fill="#ffffff"/>` : "")
          );
        }).join("");
        return `<div style="position:relative;height:100%;display:flex;flex-direction:column;justify-content:center;gap:5px;padding:8px 12px;box-sizing:border-box;background:${escapeAttr(bg)};border:${escapeAttr(border)};border-radius:${escapeAttr(radius)};box-shadow:${escapeAttr(glow)};">
          <div style="display:flex;justify-content:space-between;gap:10px;font-size:11px;"><span style="color:${escapeAttr(text)};font-family:'Rajdhani','Segoe UI',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;">${escapeHtml(state.goal.title || t("preview.goalTitle"))}</span><span style="color:${escapeAttr(muted)};font-family:'JetBrains Mono','Consolas',monospace;">${formatMoney(state.goal.current)} / ${formatMoney(state.goal.target)} <b style="color:${escapeAttr(secondary)};">[${pct}%]</b></span></div>
          <svg viewBox="0 0 200 22" preserveAspectRatio="none" style="width:100%;height:22px;">${cells}</svg>
        </div>`;
      }
      case "sf-chat": {
        const tokens = state.appearance.tokens || {};
        const text = tokens["--md-on-surface"] || "#ffffff";
        const muted = tokens["--md-on-surface-variant"] || "#9a8c98";
        const primary = tokens["--md-primary"] || "#7b2cbf";
        const pink = tokens["--sf-candy-pink"] || tokens["--md-secondary"] || "#ff007f";
        const cyan = tokens["--sf-candy-cyan"] || tokens["--md-tertiary"] || "#00f5d4";
        const bg = tokens["--panel-bg"] || "rgba(34, 22, 62, 0.92)";
        const border = tokens["--panel-border"] || "2px solid rgba(123, 44, 191, 0.55)";
        const radius = tokens["--panel-radius"] || "6px";
        const glow = tokens["--panel-glow"] || "0 0 12px rgba(157, 78, 221, 0.5)";
        const cylinders = Array.from({ length: 4 }, (_, i) => `<span style="width:5px;height:5px;border-radius:50%;background:${i === 0 ? escapeAttr(pink) : "rgba(154,140,152,0.3)"};box-shadow:${i === 0 ? `0 0 7px ${escapeAttr(pink)}` : `inset 0 0 0 1px ${escapeAttr(primary)}`};"></span>`).join("");
        const rows = [
          { user: "nova_viewer", badges: ["moderator"], message: t("preview.chat1") },
          { user: "star_gazer", badges: ["subscriber"], message: t("preview.chat2") },
          { user: "orbit_fan", badges: ["vip"], message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div style="display:flex;gap:7px;padding:3px 8px 3px 9px;font-family:'Manrope','Segoe UI',sans-serif;font-size:12px;line-height:1.45;color:${escapeAttr(text)};background:linear-gradient(90deg,rgba(123,44,191,0.12),rgba(13,8,25,0.28) 46%,transparent);border-left:2px solid ${escapeAttr(pink)};">
                ${config.showTime === false ? "" : `<span style="color:${escapeAttr(muted)};font-family:'JetBrains Mono','Consolas',monospace;font-size:10px;">[12:00]</span>`}
                ${previewBadges(m.badges, cyan)}
                <span style="color:${escapeAttr(cyan)};font-weight:700">${escapeHtml(m.user)}</span>
                <span style="color:${escapeAttr(muted)}">:</span>
                <span style="color:${escapeAttr(text)}">${escapeHtml(m.message)}</span>
              </div>`
          )
          .join("");
        return `<div style="position:relative;height:100%;padding:12px 12px 12px 14px;box-sizing:border-box;display:flex;flex-direction:column;background:${escapeAttr(bg)};border:${escapeAttr(border)};border-radius:${escapeAttr(radius)};box-shadow:${escapeAttr(glow)};overflow:hidden;">
          <div style="display:flex;align-items:center;gap:9px;flex-shrink:0;color:${escapeAttr(text)};font-family:'Rajdhani','Segoe UI',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:1.8px;font-size:11px;"><span style="display:inline-flex;gap:3px;">${cylinders}</span><span>${escapeHtml(t("editor.chat"))}</span><span style="flex:1;height:1px;background:linear-gradient(90deg,${escapeAttr(pink)},${escapeAttr(cyan)} 70%,transparent);"></span></div>
          <div style="flex:1;min-height:0;overflow:hidden;margin-top:10px;display:flex;flex-direction:column;justify-content:flex-end;gap:5px;">${rows}</div>
        </div>`;
      }
      case "sf-holo-alert": {
        const tokens = state.appearance.tokens || {};
        const primary = tokens["--md-primary"] || "#7b2cbf";
        const tertiary = tokens["--md-tertiary"] || "#00f5d4";
        const text = tokens["--md-on-surface"] || "#ffffff";
        const muted = tokens["--md-on-surface-variant"] || "#9a8c98";
        const bg = tokens["--panel-bg"] || "rgba(34, 22, 62, 0.92)";
        const border = tokens["--panel-border"] || "2px solid rgba(123, 44, 191, 0.55)";
        const radius = tokens["--panel-radius"] || "6px";
        const glow = tokens["--panel-glow"] || "0 0 12px rgba(157, 78, 221, 0.5)";
        const redline = tokens["--sf-redline"] || tokens["--md-error"] || "#ff3b30";
        const angle = (rpm) => Math.PI * 0.75 + (Math.PI * 1.5 * rpm) / 14;
        const point = (rpm, r) => [24 + Math.cos(angle(rpm)) * r, 24 + Math.sin(angle(rpm)) * r];
        const arc = (a, b, r) => {
          const [x1, y1] = point(a, r);
          const [x2, y2] = point(b, r);
          return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${(b - a) / 14 > 0.5 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
        };
        const [nx, ny] = point(6.4, 13);
        return `<div style="position:relative;height:100%;display:flex;align-items:center;gap:10px;padding:8px 12px;box-sizing:border-box;background:${escapeAttr(bg)};border:${escapeAttr(border)};border-radius:${escapeAttr(radius)};box-shadow:${escapeAttr(glow)};">
          <svg viewBox="0 0 48 48" preserveAspectRatio="xMidYMid meet" style="flex-shrink:0;width:42px;height:42px;">
            <circle cx="24" cy="24" r="19" fill="rgba(34,22,62,0.9)" stroke="${escapeAttr(primary)}" stroke-opacity="0.55" stroke-width="1.2"/>
            <path d="${arc(0, 14, 16)}" fill="none" stroke="${escapeAttr(muted)}" stroke-opacity="0.28" stroke-width="1.2"/>
            <path d="${arc(11.5, 14, 16)}" fill="none" stroke="${escapeAttr(redline)}" stroke-width="2" stroke-linecap="round"/>
            <line x1="21.5" y1="25.5" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}" stroke="${escapeAttr(text)}" stroke-width="1.4" stroke-linecap="round"/>
            <circle cx="24" cy="24" r="2" fill="${escapeAttr(primary)}"/>
            <circle cx="24" cy="24" r="1" fill="${escapeAttr(tertiary)}"/>
          </svg>
          <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
            <span style="font-family:'JetBrains Mono','Consolas',monospace;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${escapeAttr(tertiary)};">DASH // ${escapeHtml(t("properties.testFollow"))}</span>
            <span style="font-family:'Orbitron','Rajdhani','Segoe UI',sans-serif;font-size:13px;font-weight:700;letter-spacing:0.04em;color:${escapeAttr(text)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">nova_viewer</span>
          </div>
        </div>`;
      }
      case "sf-tachometer": {
        const tokens = state.appearance.tokens || {};
        const primary = tokens["--md-primary"] || "#7b2cbf";
        const secondary = tokens["--md-secondary"] || "#ffb700";
        const text = tokens["--md-on-surface"] || "#ffffff";
        const muted = tokens["--md-on-surface-variant"] || "#9a8c98";
        const dial = tokens["--panel-bg"] || "rgba(34, 22, 62, 0.92)";
        const pink = tokens["--sf-candy-pink"] || secondary || "#ff007f";
        const redline = tokens["--sf-redline"] || tokens["--md-error"] || "#ff3b30";
        const angle = (rpm) => Math.PI * 0.75 + (Math.PI * 1.5 * rpm) / 14;
        const point = (rpm, r) => [50 + Math.cos(angle(rpm)) * r, 50 + Math.sin(angle(rpm)) * r];
        const arc = (a, b, r) => {
          const [x1, y1] = point(a, r);
          const [x2, y2] = point(b, r);
          return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${(b - a) / 14 > 0.5 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
        };
        const ticks = Array.from({ length: 29 }, (_, i) => {
          const rpm = i / 2;
          const major = i % 2 === 0;
          const redline = rpm >= 11.5;
          const [x1, y1] = point(rpm, major ? 30 : 32);
          const [x2, y2] = point(rpm, 34);
          const [lx, ly] = point(rpm, 25);
          return (
            `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${redline ? escapeAttr(redline) : escapeAttr(text)}" stroke-opacity="${major ? 0.72 : 0.36}" stroke-width="${major ? 0.9 : 0.5}"/>` +
            (major ? `<text x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" fill="${redline ? escapeAttr(redline) : escapeAttr(muted)}" font-family="'JetBrains Mono','Consolas',monospace" font-size="4.4" text-anchor="middle" dominant-baseline="middle">${rpm}</text>` : "")
          );
        }).join("");
        const [nx, ny] = point(4.2, 27);
        return `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="width:88%;height:88%;overflow:visible;">
            <circle cx="50" cy="50" r="38" fill="${escapeAttr(dial)}" stroke="${escapeAttr(primary)}" stroke-opacity="0.55" stroke-width="1.1"/>
            <circle cx="50" cy="50" r="33" fill="none" stroke="${escapeAttr(muted)}" stroke-opacity="0.22" stroke-width="0.6"/>
            <path d="${arc(0, 14, 35)}" fill="none" stroke="${escapeAttr(muted)}" stroke-opacity="0.3" stroke-width="0.7"/>
            <path d="${arc(11.5, 14, 35.5)}" fill="none" stroke="${escapeAttr(redline)}" stroke-width="1.8" stroke-linecap="round"/>
            ${ticks}
            <line x1="48" y1="52" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}" stroke="${escapeAttr(text)}" stroke-width="1.1" stroke-linecap="round"/>
            <circle cx="50" cy="50" r="1.6" fill="${escapeAttr(primary)}"/>
            <text x="50" y="66" fill="${escapeAttr(muted)}" font-family="'JetBrains Mono','Consolas',monospace" font-size="3.6" text-anchor="middle">CB400SF</text>
            <rect x="43" y="69" width="14" height="9" fill="rgba(13,8,25,0.92)" stroke="${escapeAttr(primary)}" stroke-opacity="0.6" stroke-width="0.6"/>
            <rect x="43" y="69" width="14" height="1" fill="${escapeAttr(pink)}"/>
            <text x="50" y="75" fill="${escapeAttr(muted)}" font-family="'JetBrains Mono','Consolas',monospace" font-size="5" font-weight="700" text-anchor="middle">N</text>
          </svg>
        </div>`;
      }
      case "win98-cube": {
        const tokens = state.appearance.tokens || {};
        const light = tokens["--md-surface-bright"] || "#dfdfdf";
        const mid = tokens["--win98-window"] || "#c0c0c0";
        const dark = tokens["--win98-shadow"] || "#808080";
        const outline = tokens["--win98-shadow-dark"] || "#000000";
        const ink = tokens["--md-primary"] || "#000080";
        return `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="width:76%;height:76%;">
            <path d="M50 20 L82 36 L50 52 L18 36 Z" fill="${escapeAttr(light)}" stroke="${escapeAttr(outline)}" stroke-width="1.4"/>
            <path d="M18 36 L50 52 L50 84 L18 68 Z" fill="${escapeAttr(mid)}" stroke="${escapeAttr(outline)}" stroke-width="1.4"/>
            <path d="M50 52 L82 36 L82 68 L50 84 Z" fill="${escapeAttr(dark)}" stroke="${escapeAttr(outline)}" stroke-width="1.4"/>
            <path d="M50 30 L57 34 L50 38 L43 34 Z" fill="${escapeAttr(ink)}"/>
          </svg>
        </div>`;
      }
      case "win98-goal": {
        const tokens = state.appearance.tokens || {};
        const pct = state.goal && state.goal.target ? Math.min(100, Math.round((state.goal.current / state.goal.target) * 100)) : 0;
        const bg = tokens["--panel-bg"] || "#c0c0c0";
        const border = tokens["--panel-border"] || "1px solid #808080";
        const glow = tokens["--panel-glow"] || "inset 1px 1px 0 #ffffff, inset -1px -1px 0 #000000";
        const win = tokens["--win98-window"] || "#c0c0c0";
        const light = tokens["--win98-light"] || "#ffffff";
        const shadow = tokens["--win98-shadow"] || "#808080";
        const dark = tokens["--win98-shadow-dark"] || "#000000";
        const titleA = tokens["--win98-titlebar"] || "#000080";
        const titleB = tokens["--win98-titlebar-end"] || "#1080d0";
        const muted = tokens["--md-on-surface-variant"] || "#404040";
        return `<div style="position:relative;height:100%;box-sizing:border-box;padding:3px;background:${escapeAttr(bg)};border:${escapeAttr(border)};box-shadow:${escapeAttr(glow)};">
          <div style="display:flex;flex-direction:column;height:100%;box-sizing:border-box;">
            <div style="display:flex;align-items:center;gap:6px;padding:1px 3px;background:linear-gradient(90deg,${escapeAttr(titleA)},${escapeAttr(titleB)});color:${escapeAttr(light)};font-family:var(--font-display);font-size:10px;font-weight:700;">
              <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:uppercase;">${escapeHtml(state.goal.title || t("preview.goalTitle"))}</span>
              <span style="font-family:var(--font-mono);font-size:12px;flex-shrink:0;">[${pct}%]</span>
              <span style="display:inline-flex;gap:2px;flex-shrink:0;"><i style="display:inline-block;width:10px;height:9px;background:${escapeAttr(win)};box-shadow:inset 1px 1px 0 ${escapeAttr(light)}, inset -1px -1px 0 ${escapeAttr(dark)};"></i><i style="display:inline-block;width:10px;height:9px;background:${escapeAttr(win)};box-shadow:inset 1px 1px 0 ${escapeAttr(light)}, inset -1px -1px 0 ${escapeAttr(dark)};"></i></span>
            </div>
            <div style="flex:1;min-height:0;display:flex;align-items:center;padding:0 4px;box-sizing:border-box;">
              <div style="position:relative;width:100%;height:10px;background:${escapeAttr(light)};box-shadow:inset 1px 1px 0 ${escapeAttr(shadow)}, inset -1px -1px 0 ${escapeAttr(light)};">
                <div style="position:absolute;left:0;top:0;bottom:0;width:${pct}%;background:repeating-linear-gradient(90deg,${escapeAttr(titleA)} 0 9px,transparent 9px 11px);"></div>
              </div>
            </div>
            <div style="padding:0 4px 1px;font-family:var(--font-mono);font-size:11px;color:${escapeAttr(muted)};text-align:right;white-space:nowrap;">${formatMoney(state.goal.current)} / ${formatMoney(state.goal.target)}</div>
          </div>
        </div>`;
      }
      case "win98-chat": {
        const tokens = state.appearance.tokens || {};
        const bg = tokens["--panel-bg"] || "#c0c0c0";
        const border = tokens["--panel-border"] || "1px solid #808080";
        const glow = tokens["--panel-glow"] || "inset 1px 1px 0 #ffffff, inset -1px -1px 0 #000000";
        const win = tokens["--win98-window"] || "#c0c0c0";
        const light = tokens["--win98-light"] || "#ffffff";
        const shadow = tokens["--win98-shadow"] || "#808080";
        const dark = tokens["--win98-shadow-dark"] || "#000000";
        const titleA = tokens["--win98-titlebar"] || "#000080";
        const titleB = tokens["--win98-titlebar-end"] || "#1080d0";
        const text = tokens["--md-on-surface"] || "#000000";
        const muted = tokens["--md-on-surface-variant"] || "#404040";
        const primary = tokens["--md-primary"] || "#000080";
        const rows = [
          { user: "nova_viewer", badges: ["moderator"], message: t("preview.chat1") },
          { user: "star_gazer", badges: ["subscriber"], message: t("preview.chat2") },
          { user: "orbit_fan", badges: ["vip"], message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div style="display:flex;gap:6px;padding:2px 3px;font-family:var(--font-body);font-size:11px;line-height:1.35;color:${escapeAttr(text)};border-bottom:1px dotted rgba(0,0,0,0.18);">
                ${config.showTime === false ? "" : `<span style="color:${escapeAttr(muted)};font-family:var(--font-mono);font-size:12px;">[12:00]</span>`}
                ${previewBadges(m.badges, primary)}
                <span style="color:${escapeAttr(primary)};font-weight:700">${escapeHtml(m.user)}</span>
                <span style="color:${escapeAttr(muted)}">:</span>
                <span style="color:${escapeAttr(text)}">${escapeHtml(m.message)}</span>
              </div>`
          )
          .join("");
        const buttons = `<span style="display:inline-flex;gap:2px;flex-shrink:0;"><i style="display:inline-block;width:10px;height:9px;background:${escapeAttr(win)};box-shadow:inset 1px 1px 0 ${escapeAttr(light)}, inset -1px -1px 0 ${escapeAttr(dark)};"></i><i style="display:inline-block;width:10px;height:9px;background:${escapeAttr(win)};box-shadow:inset 1px 1px 0 ${escapeAttr(light)}, inset -1px -1px 0 ${escapeAttr(dark)};"></i></span>`;
        return `<div style="position:relative;height:100%;box-sizing:border-box;padding:3px;background:${escapeAttr(bg)};border:${escapeAttr(border)};box-shadow:${escapeAttr(glow)};">
          <div style="display:flex;flex-direction:column;height:100%;box-sizing:border-box;">
            <div style="display:flex;align-items:center;gap:6px;padding:1px 3px;background:linear-gradient(90deg,${escapeAttr(titleA)},${escapeAttr(titleB)});color:${escapeAttr(light)};font-family:var(--font-display);font-size:10px;font-weight:700;">
              <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:uppercase;">${escapeHtml(t("editor.chat"))}</span>${buttons}
            </div>
            <div style="flex:1;min-height:0;padding:3px;box-sizing:border-box;">
              <div style="height:100%;overflow:hidden;background:${escapeAttr(light)};box-shadow:inset 1px 1px 0 ${escapeAttr(shadow)}, inset -1px -1px 0 ${escapeAttr(light)};padding:3px 5px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:flex-end;">${rows}</div>
            </div>
          </div>
        </div>`;
      }
      case "win98-holo-alert": {
        const tokens = state.appearance.tokens || {};
        const bg = tokens["--panel-bg"] || "#c0c0c0";
        const border = tokens["--panel-border"] || "1px solid #808080";
        const glow = tokens["--panel-glow"] || "inset 1px 1px 0 #ffffff, inset -1px -1px 0 #000000";
        const win = tokens["--win98-window"] || "#c0c0c0";
        const light = tokens["--win98-light"] || "#ffffff";
        const shadow = tokens["--win98-shadow"] || "#808080";
        const dark = tokens["--win98-shadow-dark"] || "#000000";
        const titleA = tokens["--win98-titlebar"] || "#000080";
        const titleB = tokens["--win98-titlebar-end"] || "#1080d0";
        const text = tokens["--md-on-surface"] || "#000000";
        const primary = tokens["--md-primary"] || "#000080";
        return `<div style="position:relative;height:100%;box-sizing:border-box;padding:3px;background:${escapeAttr(bg)};border:${escapeAttr(border)};box-shadow:${escapeAttr(glow)};">
          <div style="display:flex;flex-direction:column;height:100%;box-sizing:border-box;">
            <div style="display:flex;align-items:center;gap:6px;padding:1px 3px;background:linear-gradient(90deg,${escapeAttr(titleA)},${escapeAttr(titleB)});color:${escapeAttr(light)};font-family:var(--font-display);font-size:10px;font-weight:700;">
              <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:uppercase;">${escapeHtml(t("properties.testFollow"))}</span>
              <span style="display:inline-flex;gap:2px;flex-shrink:0;"><i style="display:inline-block;width:10px;height:9px;background:${escapeAttr(win)};box-shadow:inset 1px 1px 0 ${escapeAttr(light)}, inset -1px -1px 0 ${escapeAttr(dark)};"></i><i style="display:inline-block;width:10px;height:9px;background:${escapeAttr(win)};box-shadow:inset 1px 1px 0 ${escapeAttr(light)}, inset -1px -1px 0 ${escapeAttr(dark)};"></i></span>
            </div>
            <div style="flex:1;min-height:0;display:flex;align-items:center;gap:9px;padding:6px 9px;box-sizing:border-box;">
              <span style="display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:34px;height:34px;background:${escapeAttr(light)};color:${escapeAttr(primary)};box-shadow:inset 1px 1px 0 ${escapeAttr(shadow)}, inset -1px -1px 0 ${escapeAttr(light)};">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.2 3.1-5.4 7-5.4s7 2.2 7 5.4"/></svg>
              </span>
              <span style="min-width:0;display:flex;flex-direction:column;gap:1px;">
                <span style="font-family:var(--font-display);font-size:14px;font-weight:700;color:${escapeAttr(text)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">nova_viewer</span>
                <span style="font-family:var(--font-mono);font-size:12px;color:${escapeAttr(primary)};">${formatMoney(500)} ${currencySymbol("RUB")}</span>
              </span>
            </div>
          </div>
        </div>`;
      }
      default:
        return "";
    }
  }

  // ---- canvas render + drag/resize ----
  // A widget is hidden from the editor canvas + layers when every service it
  // depends on has been disabled (mirrors the overlay's shouldMount() guard).
  function isServiceDisabled(inst) {
    const def = WIDGET_TYPES[inst.type] || {};
    const services = def.services || null;
    if (!services || !services.length) return false;
    const statuses = state.connectionStatus || {};
    return services.every((service) => statuses[service] === "disabled");
  }

  // True only when this 2D widget is actually hidden in the overlay because an
  // explicit 3D widget of the same role is placed (dedup). Auto-transformed 2D
  // widgets (no explicit 3D) are NOT "replaced" — they render as their 3D
  // counterpart, which the label/preview already reflect via effectiveType().
  function isReplaced(inst) {
    if (!replacedBy3d || !widgetRole) return false;
    const def = WIDGET_TYPES[inst.type] || {};
    if (def.theme) return false; // 3D widgets (role or decorative) are never dedup'd
    const role = widgetRole(inst.type);
    if (!role) return false;
    // Only a unique same-role counterpart among the enabled 3D widgets can take
    // over (an ambiguous custom set remaps nothing).
    const active = state.appearance.active3dWidgets || [];
    if (active.filter((t) => widgetRole(t) === role).length !== 1) return false;
    // Only mark as replaced when an explicit 3D widget of the same role is
    // placed in the layout (it takes over and hides this 2D widget).
    return state.layout.some((other) => {
      if (other.id === inst.id) return false;
      const otherDef = WIDGET_TYPES[other.type] || {};
      return !!otherDef.theme && widgetRole(other.type) === role;
    });
  }

  // True when a theme-bound widget will not be mounted on the overlay right
  // now. For role widgets (chat/goal/alerts and decorative signs/radar/shield)
  // that means the active 3D theme has no enabled counterpart to remap to; for
  // additive (role-less) widgets it means its own theme isn't the active 3D
  // variant. The canvas skips these widgets entirely (they belong to another
  // theme); the layers list still shows them marked as inactive.
  function isThemeGated(inst) {
    const def = WIDGET_TYPES[inst.type] || {};
    // 2D-привязка к теме (Orbital и свои темы).
    if (!themeAllowsWidget(def, state.appearance)) return true;
    if (!def.theme) return false;
    const role = widgetRole(inst.type);
    const active = state.appearance.active3dWidgets || [];
    if (active.includes(inst.type)) return false;
    if (role) {
      // Not enabled itself: active only when a unique same-role counterpart
      // will remap it. Zero or several candidates -> it will not be mounted.
      return active.filter((t) => widgetRole(t) === role).length !== 1;
    }
    return true;
  }

  // Human label shown in the canvas + layers. Follows the effective (theme-
  // remapped) type, and custom widgets can override it via `config.name` so
  // multiple "Свой виджет" entries stay distinguishable.
  function widgetLabel(inst) {
    if (inst.type === "custom" && inst.config && inst.config.name) return inst.config.name;
    const type = effectiveType(inst);
    const def = WIDGET_TYPES[type] || {};
    // Пакетный виджет называет себя сам; у встроенных имя берётся из словарей.
    return (def.plugin && def.label) || t("widgets." + type);
  }

  function renderCanvas() {
    if (interacting) return; // don't rebuild the canvas mid-drag/mid-resize
    canvasEl.innerHTML = "";
    [...state.layout]
      .sort((a, b) => (a.z || 0) - (b.z || 0))
      .forEach((inst) => {
        // Виджет с выключенным сервисом показываем приглушённым: иначе
        // добавление выглядит как «ничего не произошло», хотя виджет уже в
        // раскладке и просто не пойдёт в эфир, пока сервис не включат.
        const serviceOff = isServiceDisabled(inst);
        // Виджеты, не относящиеся к активной теме, на канвасе не показываем.
        if (isThemeGated(inst)) return;
        const replaced = isReplaced(inst);
        const box = document.createElement("div");
        box.className = "canvas-widget" + (inst.id === state.selectedId ? " is-selected" : "") + (replaced ? " is-replaced" : "") + (serviceOff ? " is-service-off" : "");
        box.dataset.id = inst.id;
        box.style.left = inst.x + "%";
        box.style.top = inst.y + "%";
        box.style.width = inst.w + "%";
        box.style.height = inst.h + "%";
        box.style.zIndex = inst.z || 0;
        box.style.opacity = !inst.visible ? "0.35" : replaced ? "0.3" : serviceOff ? "0.45" : "1";
        if (serviceOff) box.title = t("editor.serviceInactive");

        const def = WIDGET_TYPES[effectiveType(inst)] || {};
        // Угол поворота 3D-виджета: поворачиваем всю рамку, а не только
        // картинку — иначе граница выделения и ручки остаются прямыми и не
        // совпадают с тем, что уходит в эфир.
        const angle = Math.round((((Number(inst.config && inst.config.angle) || 0) % 360) + 360) % 360);
        if (angle) box.style.transform = `rotate(${angle}deg)`;
        const label = document.createElement("div");
        label.className = "canvas-widget__label";
        label.innerHTML = `${ICONS[def.icon] || ""}<span>${escapeHtml(widgetLabel(inst))}</span>`;
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
      el.classList.toggle("is-selected", el.dataset.id === state.selectedId);
    });
  }

  function selectWidget(id) {
    state.selectedId = id;
    applySelectionClasses();
    renderLayers();
    onSelectionChange();
  }

  function addWidget(type, dropXY) {
    if (state.layoutLocked) return;
    // В раскладке с явным 3D-виджетом той же роли 2D-двойник будет скрыт:
    // ставим тот тип, который реально отрисуется.
    const nextType = typeForAdd
      ? typeForAdd(type, state.layout, state.appearance.active3dWidgets || [])
      : type;
    state.pendingAdd = { knownIds: new Set(state.layout.map((w) => w.id)), dropXY };
    send(EVENT_TYPES.CMD_ADD_WIDGET, { type: nextType });
  }

  // ---- theme + grid (canvas preview only — app chrome stays fixed Nebula) ----
  function applyThemeToCanvas(tokens, themeId, customCss) {
    if (!tokens) return;
    Object.entries(tokens).forEach(([k, v]) => canvasEl.style.setProperty(k, v));
    canvasEl.dataset.decoration = tokens["--panel-decoration"] || "none";
    canvasEl.dataset.theme = themeId || "";
    applyCustomCssToCanvas(customCss || "");
  }

  // Raw custom CSS is scoped to the canvas via @scope so widget-targeting rules
  // apply inside the preview without leaking onto the control panel chrome.
  function applyCustomCssToCanvas(css) {
    let style = document.getElementById("ose-canvas-theme-css");
    if (!css) {
      if (style) style.remove();
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.id = "ose-canvas-theme-css";
      document.head.appendChild(style);
    }
    style.textContent = `@scope (#canvas) { ${css} }`;
  }

  function parseRatio(value) {
    const match = String(value || "16:9").match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) return { w: 16, h: 9 };
    const w = parseFloat(match[1]);
    const h = parseFloat(match[2]);
    if (!(w > 0) || !(h > 0)) return { w: 16, h: 9 };
    return { w, h };
  }

  // Size the editor canvas to match the selected aspect ratio, fitting it
  // inside the available canvas-wrap area (so portrait ratios like 9:16 don't
  // overflow). The overlay itself fills 100vw/100vh, so it needs no change.
  function applyCanvasRatio() {
    const { w, h } = parseRatio(state.editorPrefs.aspectRatio);
    const pad = 48; // .canvas-wrap padding (24px each side)
    const availW = Math.max(120, canvasWrapEl.clientWidth - pad);
    const availH = Math.max(120, canvasWrapEl.clientHeight - pad);
    const ratio = w / h;
    let cw = availW;
    let ch = cw / ratio;
    if (ch > availH) {
      ch = availH;
      cw = ch * ratio;
    }
    canvasEl.style.width = Math.round(cw) + "px";
    canvasEl.style.height = Math.round(ch) + "px";
    applyGridToCanvas();
  }

  function applyGridToCanvas() {
    const size = state.editorPrefs.gridSize || 0;
    canvasEl.classList.toggle("show-grid", size > 0);
    if (size > 0) {
      const w = canvasEl.clientWidth || 960;
      const h = canvasEl.clientHeight || 540;
      canvasEl.style.setProperty("--grid-x", (size / 100) * w + "px");
      canvasEl.style.setProperty("--grid-y", (size / 100) * h + "px");
    }
  }

  function snapValue(v) {
    const size = state.editorPrefs.gridSize;
    if (!state.editorPrefs.snapEnabled || !size) return v;
    return Math.round(v / size) * size;
  }

  // Блокировка раскладки: предохранитель для эфира. Выбор виджета и правка
  // свойств остаются доступны, а геометрия, порядок и состав — нет.
  function applyLayoutLock(updateLayers = true) {
    const locked = !!state.layoutLocked;
    canvasEl.classList.toggle("is-locked", locked);
    document.body.classList.toggle("layout-locked", locked);
    if (layoutLockBtn) {
      layoutLockBtn.classList.toggle("is-on", locked);
      layoutLockBtn.setAttribute("aria-pressed", String(locked));
    }
    if (layoutLockIcon) {
      layoutLockIcon.innerHTML = locked ? ICONS.unlock : ICONS.lock;
    }
    // HUD-редактор тоже двигает виджеты — в заблокированной раскладке
    // не даём в него войти, иначе предохранитель обходится одной кнопкой.
    if (toggleHudBtn) toggleHudBtn.disabled = locked;
    if (updateLayers) renderLayers();
  }

  if (layoutLockBtn) {
    layoutLockBtn.addEventListener("click", () => {
      state.layoutLocked = !state.layoutLocked;
      applyLayoutLock();
    });
  }
  applyLayoutLock(false);

  function attachDragHandlers(boxEl, inst) {
    boxEl.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".resize-handle")) return;
      // В режиме блокировки виджет всё ещё можно выбрать и настроить,
      // но сдвинуть его нельзя.
      if (state.layoutLocked) {
        selectWidget(inst.id);
        return;
      }
      e.preventDefault();
      selectWidget(inst.id);
      interacting = true;
      const canvasRect = canvasEl.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const cur = state.layout.find((w) => w.id === inst.id) || inst;
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
        interacting = false;
        if (moved) {
          const x = round1(parseFloat(boxEl.dataset.pendingX));
          const y = round1(parseFloat(boxEl.dataset.pendingY));
          // Optimistically apply so an interleaved re-render (connection status,
          // etc.) uses the new position instead of snapping back to the old one.
          const widget = state.layout.find((w) => w.id === inst.id);
          if (widget) { widget.x = x; widget.y = y; }
          send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { x, y } });
        }
      }
      function onCancel() {
        boxEl.removeEventListener("pointermove", onMove);
        boxEl.removeEventListener("pointerup", onUp);
        boxEl.removeEventListener("pointercancel", onCancel);
        boxEl.classList.remove("is-dragging");
        interacting = false;
      }
      boxEl.addEventListener("pointermove", onMove);
      boxEl.addEventListener("pointerup", onUp);
      boxEl.addEventListener("pointercancel", onCancel);
    });
  }

  function attachResizeHandlers(boxEl, inst) {
    ["nw", "ne", "sw", "se"].forEach((pos) => {
      const handle = document.createElement("div");
      handle.className = "resize-handle";
      handle.dataset.h = pos;
      boxEl.appendChild(handle);

      handle.addEventListener("pointerdown", (e) => {
        if (state.layoutLocked) return;
        e.preventDefault();
        e.stopPropagation();
        selectWidget(inst.id);
        interacting = true;
        const canvasRect = canvasEl.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        const cur = state.layout.find((w) => w.id === inst.id) || inst;
        const start = { x: cur.x, y: cur.y, w: cur.w, h: cur.h };
        const def = WIDGET_TYPES[inst.type] || { minW: 5, minH: 5 };
        handle.setPointerCapture(e.pointerId);

        function onMove(ev) {
          const rawDx = ev.clientX - startX;
          const rawDy = ev.clientY - startY;
          // Виджет может быть повёрнут: тянем ручку в его собственных осях,
          // иначе угол не следует за курсором.
          const radians = ((Number(cur.config && cur.config.angle) || 0) * Math.PI) / 180;
          const cos = Math.cos(radians);
          const sin = Math.sin(radians);
          const dx = rawDx * cos + rawDy * sin;
          const dy = -rawDx * sin + rawDy * cos;
          const dxPct = (dx / canvasRect.width) * 100;
          const dyPct = (dy / canvasRect.height) * 100;
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
          interacting = false;
          if (boxEl.dataset.pendingGeo) {
            const geo = JSON.parse(boxEl.dataset.pendingGeo);
            // Optimistically apply so an interleaved re-render can't reset the box.
            const widget = state.layout.find((w) => w.id === inst.id);
            if (widget) { widget.x = geo.x; widget.y = geo.y; widget.w = geo.w; widget.h = geo.h; }
            send(EVENT_TYPES.CMD_UPDATE_WIDGET, {
              id: inst.id,
              patch: { x: round1(geo.x), y: round1(geo.y), w: round1(geo.w), h: round1(geo.h) },
            });
            delete boxEl.dataset.pendingGeo;
          }
        }
        function onCancel() {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onCancel);
          interacting = false;
        }
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onCancel);
      });
    });
  }

  // ---- layers panel ----
  function renderLayers() {
    // Виджеты с выключенным сервисом остаются в списке (приглушёнными):
    // иначе добавленный чат исчезает из обоих мест и выглядит как неудача.
    if (!state.layout.length) {
      layersEl.innerHTML = `<div class="layers__empty">${t("editor.layersEmpty")}</div>`;
      return;
    }
    layersEl.innerHTML = "";
    [...state.layout]
      .sort((a, b) => (b.z || 0) - (a.z || 0))
      .forEach((inst) => {
        const def = WIDGET_TYPES[effectiveType(inst)] || {};
        const replaced = isReplaced(inst);
        const inactive = isThemeGated(inst);
        const serviceOff = isServiceDisabled(inst);
        const row = document.createElement("div");
        row.className = "layer-row" + (inst.id === state.selectedId ? " is-selected" : "") + (replaced ? " is-replaced" : "") + (inactive ? " is-theme-gated" : "") + (serviceOff ? " is-service-off" : "");
        row.innerHTML = `
          <span class="layer-row__icon">${ICONS[def.icon] || ICONS.widgetCustom || ""}</span>
          <span class="layer-row__label">${escapeHtml(widgetLabel(inst))}</span>
          ${replaced ? `<span class="layer-row__3d-tag" title="${escapeAttr(t("editor.replacedBy3d"))}">3D</span>` : ""}
          ${inactive ? `<span class="layer-row__3d-tag layer-row__off-tag" title="${escapeAttr(t("editor.themeInactive"))}">${escapeHtml(t("editor.themeInactiveTag"))}</span>` : ""}
          ${serviceOff ? `<span class="layer-row__3d-tag layer-row__off-tag" title="${escapeAttr(t("editor.serviceInactive"))}">${escapeHtml(t("editor.serviceInactiveTag"))}</span>` : ""}
          <span class="layer-row__btns">
            <button class="layer-row__btn" data-action="forward" title="${t("common.forward")}"${state.layoutLocked ? " disabled" : ""}>▲</button>
            <button class="layer-row__btn" data-action="backward" title="${t("common.backward")}"${state.layoutLocked ? " disabled" : ""}>▼</button>
            <button class="layer-row__btn" data-action="toggle" title="${t("common.toggleVisibility")}"${state.layoutLocked ? " disabled" : ""}>${ICONS[inst.visible ? "eye" : "eyeOff"]}</button>
          </span>`;
        row.addEventListener("click", (e) => {
          if (e.target.closest("[data-action]")) return;
          selectWidget(inst.id);
        });
        row.querySelector('[data-action="toggle"]').addEventListener("click", (e) => {
          e.stopPropagation();
          if (state.layoutLocked) return;
          send(EVENT_TYPES.CMD_UPDATE_WIDGET, { id: inst.id, patch: { visible: !inst.visible } });
        });
        row.querySelector('[data-action="forward"]').addEventListener("click", (e) => {
          e.stopPropagation();
          if (state.layoutLocked) return;
          send(EVENT_TYPES.CMD_REORDER_WIDGET, { id: inst.id, direction: "forward" });
        });
        row.querySelector('[data-action="backward"]').addEventListener("click", (e) => {
          e.stopPropagation();
          if (state.layoutLocked) return;
          send(EVENT_TYPES.CMD_REORDER_WIDGET, { id: inst.id, direction: "backward" });
        });
        layersEl.appendChild(row);
      });
  }

  // ---- event wiring ----
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
    if (state.layoutLocked) return;
    const type = e.dataTransfer.getData("text/widget-type");
    if (!type) return;
    const rect = canvasEl.getBoundingClientRect();
    const xPct = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
    const yPct = clamp(((e.clientY - rect.top) / rect.height) * 100, 0, 100);
    addWidget(type, { x: xPct, y: yPct });
  });

  gridSizeSelect.addEventListener("change", () => {
    const size = Number(gridSizeSelect.value);
    send(EVENT_TYPES.CMD_SET_EDITOR_PREFS, { gridSize: size, snapEnabled: size > 0 });
  });

  aspectRatioSelect.addEventListener("change", () => {
    send(EVENT_TYPES.CMD_SET_EDITOR_PREFS, { aspectRatio: aspectRatioSelect.value });
  });

  // Refit the canvas when the available area changes (window resize, panel
  // resize, etc.) so the chosen aspect ratio is preserved.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => applyCanvasRatio()).observe(canvasWrapEl);
  } else {
    window.addEventListener("resize", () => applyCanvasRatio());
  }

  canvasEl.addEventListener("pointerdown", (e) => {
    if (e.target === canvasEl) selectWidget(null);
  });

  document.addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && !state.layoutLocked && state.selectedId && document.activeElement.tagName !== "INPUT") {
      send(EVENT_TYPES.CMD_REMOVE_WIDGET, { id: state.selectedId });
      state.selectedId = null;
    }
  });

  // Карточки библиотеки остаются на месте, но в режиме блокировки их нельзя
  // утащить на канвас — визуально это показывает .layout-locked в CSS.
  document.addEventListener(
    "dragstart",
    (e) => {
      if (state.layoutLocked && e.target.closest(".library-card")) e.preventDefault();
    },
    true
  );

  return { addWidget, renderCanvas, renderLayers, applyThemeToCanvas, applyCustomCssToCanvas, applyGridToCanvas, applyCanvasRatio };
}
