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

export function initCanvasEditor({
  state,
  t,
  ICONS,
  WIDGET_TYPES,
  widgetsForTheme,
  replacedBy3d,
  widgetRole,
  resolveTypeForTheme,
  EVENT_TYPES,
  send,
  clamp,
  round1,
  escapeHtml,
  escapeAttr,
  formatMoney,
  currencySymbol,
  resolveMediaUrl,
  onSelectionChange,
}) {
  const canvasWrapEl = el("canvasWrap");
  const canvasEl = el("canvas");
  const layersEl = el("layers");
  const gridSizeSelect = el("gridSizeSelect");
  const aspectRatioSelect = el("aspectRatioSelect");

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

  function buildEqualizerPreview({ width, height, opacity }) {
    const barCount = 24;
    const cellCount = 14;
    const cellGap = 2;
    const slotW = width / barCount;
    const barW = Math.max(1, slotW - 2);
    const cellH = Math.max(1, (height - (cellCount - 1) * cellGap) / cellCount);
    const green = "#2ecc40";
    const yellow = "#ffdc00";
    const red = "#ff4136";
    const off = "rgba(255,255,255,0.08)";
    const colorFor = (c) => (c < (cellCount * 8) / 14 ? green : c < (cellCount * 12) / 14 ? yellow : red);
    const levels = [];
    for (let i = 0; i < barCount; i++) {
      const v = Math.abs(Math.sin(i * 0.55) * 0.7 + Math.sin(i * 0.23) * 0.3);
      const level = Math.round(v * cellCount);
      const peak = Math.min(cellCount - 1, level + 1);
      levels.push({ level, peak });
    }
    const rects = [];
    for (let b = 0; b < barCount; b++) {
      const x = b * slotW + (slotW - barW) / 2;
      const { level, peak } = levels[b];
      for (let c = 0; c < cellCount; c++) {
        const y = height - (c + 1) * cellH - c * cellGap;
        const on = c < level || c === peak;
        rects.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${cellH.toFixed(1)}" rx="1" fill="${on ? colorFor(c) : off}"/>`);
      }
    }
    return `<div class="widget-mic widget-mic--preview">
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:100%;opacity:${opacity}">${rects.join("")}</svg>
    </div>`;
  }

  // The type a widget renders as under the active theme — mirrors the overlay's
  // transform(). Role widgets (chat/goal/alerts) follow the active 3D variant's
  // counterpart; everything else keeps its own type. The editor box keeps the
  // stored x/y/w/h, so the preview only swaps the visuals, never the geometry.
  function effectiveType(inst) {
    return resolveTypeForTheme
      ? resolveTypeForTheme(inst.type, state.appearance.activeThemeId3d, state.appearance.enabled3d)
      : inst.type;
  }

  function buildPreviewHtml(inst) {
    const config = inst.config || {};
    switch (effectiveType(inst)) {
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
        return `<div class="widget-recent"><div class="widget-recent__title">${t("preview.recentTitle")}</div><div class="widget-recent__list">${items}</div></div>`;
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
        const withCard = mode !== "image" && config.showBackground !== false;
        if (mode === "image") {
          const src = resolveMediaUrl ? resolveMediaUrl(config.imageUrl) : config.imageUrl;
          return src
            ? `<div class="widget-custom"><img class="widget-custom__image" src="${escapeAttr(src)}" style="object-fit:${escapeAttr(config.imageFit || "contain")}" alt=""></div>`
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
            : { icon: ICONS.follow, label: config.label || t("preview.followers"), value: state.stats.followerCount != null ? formatMoney(state.stats.followerCount) : "—" };
        return `<div class="widget-stat"><div class="widget-stat__icon">${sample.icon}</div><div class="widget-stat__info"><span class="widget-stat__label">${escapeHtml(sample.label)}</span><span class="widget-stat__value">${escapeHtml(sample.value)}</span></div></div>`;
      }
      case "social": {
        const s = (config.socials || [])[0] || { platform: "TG", text: "t.me/your_channel" };
        return `<div class="widget-social"><div class="widget-social__content"><span class="widget-social__icon">${escapeHtml(s.platform)}</span><div class="widget-social__info"><span class="widget-social__platform">${escapeHtml(s.platform)}</span><span class="widget-social__handle">${escapeHtml(s.text)}</span></div></div></div>`;
      }
      case "participants": {
        const names = ["viewer_1", "viewer_2", "viewer_3", "viewer_4"].slice(0, Math.max(1, Number(state.participantsConfig.maxNames) || 10));
        const chips = names.map((n) => `<span class="widget-participants__chip">${escapeHtml(n)}</span>`).join("");
        const style = `--pw-font-size:${state.participantsConfig.fontSize ?? 16}px;--pw-text:${escapeAttr(state.participantsConfig.textColor || "#e8e1f0")};--pw-bg-opacity:${state.participantsConfig.backgroundOpacity ?? 82}%;`;
        return `<div class="widget-participants" style="${style}">
          <div class="widget-participants__title">${t("wheelScene.participantsTitle", { count: 4 })}</div>
          <div class="widget-participants__list">${chips}</div>
        </div>`;
      }
      case "mic": {
        const themePrimary = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#0060A8";
        const color = config.color || state.micConfig.color || themePrimary;
        const opacity = state.micConfig.opacity ?? 0.9;
        const width = 400;
        const height = 80;
        if (state.micConfig.visualizer_mode === "equalizer") {
          return buildEqualizerPreview({ width, height, opacity });
        }
        const pts = [];
        for (let x = 0; x <= width; x += 6) {
          const y = height / 2 + Math.sin(x * 0.045) * 22 + Math.sin(x * 0.012) * 9;
          pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        }
        const d = "M" + pts.join(" L");
        return `<div class="widget-mic widget-mic--preview">
          <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:100%;opacity:${opacity}">
            <path d="${d}" fill="none" stroke="${escapeAttr(color)}" stroke-width="${state.micConfig.lineWidth || 2}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
          </svg>
        </div>`;
      }
      case "death": {
        const label = config.label || t("preview.death");
        const color = config.color || "#ff4d4d";
        return `<div class="widget-death"><div class="widget-death__label">${escapeHtml(label)}</div><div class="widget-death__value" style="color:${escapeAttr(color)}">${state.deathCount ?? 0}</div></div>`;
      }
      case "soundboard": {
        return `<div class="widget-soundboard"><div class="widget-soundboard__placeholder">🔊 ${escapeHtml(t("widgets.soundboard"))}</div></div>`;
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
      case "grimhex-chat": {
        const rows = [
          { user: "nova_viewer", message: t("preview.chat1") },
          { user: "star_gazer", message: t("preview.chat2") },
          { user: "orbit_fan", message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div class="grimhex-chat__row" style="display:flex;gap:7px;font-size:13px;line-height:1.55;color:#e9eef2;">
                <span style="color:#64748b">[12:00]</span>
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
          { user: "nova_viewer", message: t("preview.chat1") },
          { user: "star_gazer", message: t("preview.chat2") },
          { user: "orbit_fan", message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div class="nuclear-chat__row" style="display:flex;gap:7px;font-size:13px;line-height:1.55;color:#a7ada8;">
                <span style="color:#59615b">[12:00]</span>
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
          { user: "nova_viewer", message: t("preview.chat1") },
          { user: "star_gazer", message: t("preview.chat2") },
          { user: "orbit_fan", message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div class="cobra-chat__row" style="display:flex;gap:7px;font-size:13px;line-height:1.55;color:#ffb07c;">
                <span style="color:#bdb0a1">[12:00]</span>
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
          { user: "nova_viewer", message: t("preview.chat1") },
          { user: "star_gazer", message: t("preview.chat2") },
          { user: "orbit_fan", message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div class="md3-chat__row" style="display:flex;gap:7px;font-size:13px;line-height:1.55;color:${text};">
                <span style="color:${muted}">[12:00]</span>
                <span style="color:${primary};font-weight:700">${escapeHtml(m.user)}</span>
                <span style="color:${muted}">:</span>
                <span style="color:${text}">${escapeHtml(m.message)}</span>
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
          <div style="display:flex;justify-content:space-between;gap:10px;color:${text};font-size:11px;"><span style="font-family:'Manrope','Segoe UI',sans-serif;font-weight:700;">${escapeHtml(state.goal.title || t("preview.goalTitle"))}</span><span style="color:${muted};font-family:'JetBrains Mono','Consolas',monospace;">${formatMoney(state.goal.current)} / ${formatMoney(state.goal.target)}</span></div>
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
            <span style="font-size:13px;font-weight:700;color:${text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">nova_viewer</span>
          </div>
        </div>`;
      }
      case "pixel-cube": {
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
      case "pixel-chat": {
        const text = (state.appearance.tokens && state.appearance.tokens["--md-on-surface"]) || "#e6e6e6";
        const muted = (state.appearance.tokens && state.appearance.tokens["--md-on-surface-variant"]) || "#b8b8b8";
        const gold = (state.appearance.tokens && state.appearance.tokens["--md-primary"]) || "#d6b675";
        const rows = [
          { user: "nova_viewer", message: t("preview.chat1") },
          { user: "star_gazer", message: t("preview.chat2") },
          { user: "orbit_fan", message: t("preview.chat3") },
        ]
          .map(
            (m) =>
              `<div class="pixel-chat__row" style="display:flex;gap:7px;font-size:13px;line-height:1.5;color:${text};font-family:'Roboto Condensed','Segoe UI',sans-serif;">
                <span style="color:${muted}">[12:00]</span>
                <span style="color:${gold};font-weight:700">${escapeHtml(m.user)}</span>
                <span style="color:${muted}">:</span>
                <span style="color:${text}">${escapeHtml(m.message)}</span>
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
          <div style="display:flex;justify-content:space-between;gap:10px;color:${text};font-size:11px;font-family:'PT Sans Caption','Segoe UI',sans-serif;"><span style="font-weight:700;">${escapeHtml(state.goal.title || t("preview.goalTitle"))}</span><span style="color:${muted};">${formatMoney(state.goal.current)} / ${formatMoney(state.goal.target)}</span></div>
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
            <span style="font-size:13px;font-weight:700;color:${text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">nova_viewer</span>
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
    const variantId = state.appearance.activeThemeId3d;
    if (!variantId) return false;
    const counterpart = (widgetsForTheme ? widgetsForTheme(variantId) : []).find(
      (w) => widgetRole(w.type) === role
    );
    if (!counterpart) return false;
    if (state.appearance.enabled3d && state.appearance.enabled3d[counterpart.type] === false) {
      return false;
    }
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
    if (!def.theme) return false;
    const role = widgetRole(inst.type);
    const variantId = state.appearance.activeThemeId3d;
    if (role) {
      // Role widget: inactive unless the active theme has an enabled counterpart.
      if (!variantId) return true; // 3D off
      const counterpart = (widgetsForTheme ? widgetsForTheme(variantId) : []).find(
        (w) => widgetRole(w.type) === role
      );
      if (!counterpart) return true; // no counterpart in the active theme
      if (state.appearance.enabled3d && state.appearance.enabled3d[counterpart.type] === false) return true;
      return false;
    }
    // Additive widget (no role): inactive when its own theme isn't active.
    return variantId !== def.theme;
  }

  // Human label shown in the canvas + layers. Follows the effective (theme-
  // remapped) type, and custom widgets can override it via `config.name` so
  // multiple "Свой виджет" entries stay distinguishable.
  function widgetLabel(inst) {
    if (inst.type === "custom" && inst.config && inst.config.name) return inst.config.name;
    return t("widgets." + effectiveType(inst));
  }

  function renderCanvas() {
    if (interacting) return; // don't rebuild the canvas mid-drag/mid-resize
    canvasEl.innerHTML = "";
    [...state.layout]
      .sort((a, b) => (a.z || 0) - (b.z || 0))
      .forEach((inst) => {
        if (isServiceDisabled(inst)) return;
        // Виджеты, не относящиеся к активной теме, на канвасе не показываем.
        if (isThemeGated(inst)) return;
        const replaced = isReplaced(inst);
        const box = document.createElement("div");
        box.className = "canvas-widget" + (inst.id === state.selectedId ? " is-selected" : "") + (replaced ? " is-replaced" : "");
        box.dataset.id = inst.id;
        box.style.left = inst.x + "%";
        box.style.top = inst.y + "%";
        box.style.width = inst.w + "%";
        box.style.height = inst.h + "%";
        box.style.zIndex = inst.z || 0;
        box.style.opacity = !inst.visible ? "0.35" : replaced ? "0.3" : "1";

        const def = WIDGET_TYPES[effectiveType(inst)] || {};
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
    state.pendingAdd = { knownIds: new Set(state.layout.map((w) => w.id)), dropXY };
    send(EVENT_TYPES.CMD_ADD_WIDGET, { type });
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

  function attachDragHandlers(boxEl, inst) {
    boxEl.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".resize-handle")) return;
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
    const visible = state.layout.filter((inst) => !isServiceDisabled(inst));
    if (!visible.length) {
      layersEl.innerHTML = `<div class="layers__empty">${t("editor.layersEmpty")}</div>`;
      return;
    }
    layersEl.innerHTML = "";
    [...visible]
      .sort((a, b) => (b.z || 0) - (a.z || 0))
      .forEach((inst) => {
        const def = WIDGET_TYPES[effectiveType(inst)] || {};
        const replaced = isReplaced(inst);
        const inactive = isThemeGated(inst);
        const row = document.createElement("div");
        row.className = "layer-row" + (inst.id === state.selectedId ? " is-selected" : "") + (replaced ? " is-replaced" : "") + (inactive ? " is-theme-gated" : "");
        row.innerHTML = `
          <span class="layer-row__icon">${ICONS[def.icon] || ""}</span>
          <span class="layer-row__label">${escapeHtml(widgetLabel(inst))}</span>
          ${replaced ? `<span class="layer-row__3d-tag" title="${escapeAttr(t("editor.replacedBy3d"))}">3D</span>` : ""}
          ${inactive ? `<span class="layer-row__3d-tag layer-row__off-tag" title="${escapeAttr(t("editor.themeInactive"))}">${escapeHtml(t("editor.themeInactiveTag"))}</span>` : ""}
          <span class="layer-row__btns">
            <button class="layer-row__btn" data-action="forward" title="${t("common.forward")}">▲</button>
            <button class="layer-row__btn" data-action="backward" title="${t("common.backward")}">▼</button>
            <button class="layer-row__btn" data-action="toggle" title="${t("common.toggleVisibility")}">${ICONS[inst.visible ? "eye" : "eyeOff"]}</button>
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
    if ((e.key === "Delete" || e.key === "Backspace") && state.selectedId && document.activeElement.tagName !== "INPUT") {
      send(EVENT_TYPES.CMD_REMOVE_WIDGET, { id: state.selectedId });
      state.selectedId = null;
    }
  });

  return { addWidget, renderCanvas, renderLayers, applyThemeToCanvas, applyCustomCssToCanvas, applyGridToCanvas, applyCanvasRatio };
}
