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
  WidgetTesoHoloAlert — Elder Scrolls-style alert card for the TESO
  "Ouroboros Seal" 3D theme.

  Alerts arrive on the shared bus ({ kind: follow|sub|gift_sub|cheer|donation|
  wheel_start|wheel_winner, ... }) and are queued one at a time. The background
  is a filled panel surface matching the Recent events widget (var(--panel-bg)
  + border + radius + shadow + scanlines + corner brackets). Instead of the old
  rotating seal badge, the card shows the regular alert icon (shared/icons.js)
  beside the text (type, user, amount, message), set in Cinzel/Montserrat.

  Theme isolation: hard-gated to "teso-seal" in onMount() and via the manager.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetTesoHoloAlert = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetTesoHoloAlert;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetTesoHoloAlert = WidgetTesoHoloAlert;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const GOLD = "#c7a75c";
  const GOLD_BRIGHT = "#e2c47e";
  const HEALTH_RED = "#e0604f";
  const TEXT = "#e6e3d8";
  const MUTED = "#bfc3b0";
  const FONT_DISPLAY = "'Cinzel', 'Georgia', serif";
  const FONT_BODY = "'Montserrat', 'Segoe UI', sans-serif";

  // ESO item-quality tiers for donations, 200₽ wide, from 0 to 1000₽.
  function donationQualityColor(amount) {
    const a = Number(amount) || 0;
    if (a < 200) return "#ffffff";   // White (Trash)
    if (a < 400) return "#2dc50e";   // Green (Fine)
    if (a < 600) return "#3a92ff";   // Blue (Superior)
    if (a < 800) return "#a02dc5";   // Purple (Epic)
    if (a < 1000) return "#e5a823";  // Gold (Legendary)
    return "#ee6a00";                // Orange (Mythic)
  }

  // CSS keyframes are injected once per document (shared across instances).
  let alertStylesInjected = false;

  class WidgetTesoHoloAlert extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.contentEl = null;

      this.queue = [];
      this.current = null;
      this._startedAt = 0;
      this._duration = 0;
      this._hideId = null;
    }

    onMount() {
      // HARD theme gate: no DOM, no events on a non-TESO theme.
      if (this.theme !== "teso-seal") return;

      this.contentEl = document.createElement("div");
      this.contentEl.className = "teso-holo-alert__content";
      this.contentEl.style.cssText =
        "position:absolute;inset:0;display:flex;align-items:center;box-sizing:border-box;padding:12px 16px;";
      this.element.appendChild(this.contentEl);

      this.element.classList.add("teso-holo-alert-surface");
      this._applySurface();
      this._applyTilt();
      this._injectStyles();

      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this.queueAlert(alert));
      // Hidden until the first alert.
      this.element.style.opacity = "0";
    }

    onUnmount() {
      if (this._hideId != null) this.clearTimer(this._hideId);
      this._hideId = null;
      this.queue = [];
      this.current = null;
      if (this.contentEl) this.contentEl.innerHTML = "";
      this.contentEl = null;
    }

    // Panel surface matching the Recent events widget: filled panel, border,
    // radius, drop shadow/glow, scanline texture + corner brackets.
    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(13, 17, 15, 0.92)";
      const blur = (read && read("--panel-blur")) || "4px";
      const border = (read && read("--panel-border")) || "1px solid #a38652";
      const radius = (read && read("--panel-radius")) || "2px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow =
        (read && read("--panel-glow")) ||
        "0 0 15px rgba(199,167,92,0.35), inset 0 0 30px rgba(199,167,92,0.05)";

      s.backgroundColor = bg;
      s.backgroundImage = "";
      s.backdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.webkitBackdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.border = border;
      s.borderRadius = radius;
      s.clipPath = clip;
      s.boxShadow = `${elev}, ${glow}`;
      s.transition = "opacity 0.35s ease";
    }

    // Subtle holographic tilt.
    _applyTilt() {
      this.element.style.transform = "perspective(1400px) rotateY(-6deg) rotateX(1deg)";
      this.element.style.transformStyle = "preserve-3d";
    }

    // Inject the alert/badge keyframes once per document.
    _injectStyles() {
      if (alertStylesInjected) return;
      alertStylesInjected = true;

      const style = document.createElement("style");
      style.setAttribute("data-teso-holo-alert", "");
      style.textContent = `
        @keyframes teso-alert-enter {
          from { transform: translateY(16px) scale(0.97); }
          to { transform: translateY(0) scale(1); }
        }
        .teso-holo-alert__content.teso-alert-enter {
          animation: teso-alert-enter 0.45s cubic-bezier(0.2, 0, 0, 1) both;
        }

        @keyframes teso-badge-pulse {
          0%, 100% {
            transform: scale(1);
            box-shadow: 0 0 10px var(--teso-glow, rgba(199, 167, 92, 0.4)),
                        0 0 22px var(--teso-glow, rgba(199, 167, 92, 0.4));
          }
          50% {
            transform: scale(1.06);
            box-shadow: 0 0 20px var(--teso-glow, rgba(199, 167, 92, 0.4)),
                        0 0 40px var(--teso-glow, rgba(199, 167, 92, 0.4));
          }
        }
        .teso-holo-alert-badge {
          animation: teso-badge-pulse 2.6s ease-in-out infinite;
        }
      `;
      document.head.appendChild(style);
    }

    // Re-trigger the entrance animation on each new alert.
    _playEnter() {
      if (!this.contentEl) return;
      this.contentEl.classList.remove("teso-alert-enter");
      void this.contentEl.offsetWidth; // force reflow so back-to-back alerts restart
      this.contentEl.classList.add("teso-alert-enter");
    }

    // ---- queue ----

    queueAlert(alert) {
      if (!alert) return;
      if (alert.kind === "wheel_winner") {
        if (alert.isElimination) this.context.audio.playEliminationAudio();
        else this.context.audio.playWinSound();
      }
      this.queue.push(alert);
      if (!this.current) this.showNext();
    }

    showNext() {
      const alert = this.queue.shift();
      if (!alert) {
        this.current = null;
        this.element.style.opacity = "0";
        this.element.style.height = this.geometry.h + "%"; // reset to layout height while hidden
        return;
      }
      this.current = alert;
      this._startedAt = performance.now();
      this._duration = alert.durationMs || 5000;

      this.element.style.opacity = "1";
      this.renderContent(alert);
      this._playEnter();
      this._autoSize();

      if (this._hideId != null) this.clearTimer(this._hideId);
      this._hideId = this.later(() => {
        this._hideId = null;
        this.showNext();
      }, this._duration);
    }

    // ---- content helpers ----

    kindColor(alert) {
      const read = this.context.readCssVar;
      const kind = alert && alert.kind;
      switch (kind) {
        case "sub":
        case "gift_sub":
        case "wheel_start":
        case "wheel_winner":
          return (read && read("--md-secondary")) || GOLD_BRIGHT;
        case "cheer":
          return (read && read("--md-tertiary")) || HEALTH_RED;
        case "donation":
          return donationQualityColor(alert.amount);
        default:
          return (read && read("--md-primary")) || GOLD;
      }
    }

    kindLabel(alert) {
      const { t } = this.context;
      switch (alert.kind) {
        case "follow": return t("alert.follow");
        case "sub": return t("alert.sub");
        case "gift_sub": return t("alert.giftSub", { count: alert.count || 1 });
        case "cheer": return t("alert.cheer");
        case "donation": return t("alert.donation");
        case "wheel_start": return t("alert.wheelStart");
        case "wheel_winner": return t("alert.wheelWinner");
        case "reward": return t("alert.reward");
        default: return "";
      }
    }

    formatAmount(alert) {
      const { t, formatMoney, currencySymbol } = this.context;
      if (alert.kind === "cheer") return t("alert.cheerBits", { amount: alert.amount });
      if (alert.kind === "donation") {
        return `${formatMoney(alert.amount)} ${currencySymbol(alert.currency || "RUB")}`;
      }
      return "";
    }

    renderContent(alert) {
      if (!this.contentEl) return;
      const { t, ICONS, escapeHtml } = this.context;
      const color = this.kindColor(alert);
      const amount = this.formatAmount(alert);
      const message =
        (alert.kind === "donation" || alert.kind === "cheer") && alert.message
          ? escapeHtml(alert.message)
          : "";

      let icon = ICONS[alert.kind] || "";
      let nameHtml = escapeHtml(alert.user || "");

      if (alert.kind === "wheel_start") {
        icon = "🎉";
        nameHtml = escapeHtml(t("alert.wheelStartMessage", { command: alert.command || "" }));
      } else if (alert.kind === "wheel_winner") {
        icon = "";
        const name = escapeHtml(alert.user || "");
        if (alert.isElimination) nameHtml = t("alert.eliminated", { name });
        else if (alert.isFinalWinner) nameHtml = t("alert.finalWinner", { name });
        else nameHtml = t("alert.winner", { name });
      }

      const iconHtml = icon
        ? `<div class="teso-holo-alert-badge" style="width:48px;height:48px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(0,0,0,0.35);border:1px solid ${color}66;overflow:hidden;color:${color};--teso-glow:${color}59;">${icon.replace("<svg ", '<svg width="30px" height="30px" ')}</div>`
        : "";

      this.contentEl.innerHTML =
        `<div style="display:flex;align-items:center;gap:14px;min-width:0;width:100%;">` +
        iconHtml +
        `<div style="min-width:0;display:flex;flex-direction:column;gap:3px;">
          <span style="font-family:${FONT_DISPLAY};font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${MUTED};">TESO // ${escapeHtml(this.kindLabel(alert))}</span>
          <span style="font-family:${FONT_DISPLAY};font-size:20px;font-weight:700;color:${TEXT};line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:1px 1px 2px rgba(0,0,0,0.9);">${nameHtml}</span>
          ${amount ? `<span style="font-family:${FONT_DISPLAY};font-size:14px;font-weight:700;color:${color};">${amount}</span>` : ""}
          ${message ? `<span style="font-family:${FONT_BODY};font-size:12px;color:${MUTED};line-height:1.35;overflow-wrap:anywhere;word-break:break-word;">«${message}»</span>` : ""}
        </div>` +
        `</div>`;
    }

    // Grow the panel to fit the message (bounded), so long donation texts
    // don't get clipped by the fixed layout height.
    _autoSize() {
      if (!this.element || !this.contentEl) return;

      // Reset to the layout height first so `clientHeight` reflects the true
      // base, not a leftover auto-sized height from a previous (longer) alert.
      this.element.style.height = this.geometry.h + "%";
      const base = this.element.clientHeight || 140;

      const el = this.contentEl;
      const prev = el.style.cssText;

      // Temporarily let the content size naturally (same width + padding) to
      // measure the full wrapped height, then restore the fixed layout.
      el.style.height = "auto";
      el.style.bottom = "auto";
      el.style.justifyContent = "flex-start";
      const needed = el.offsetHeight;

      el.style.cssText = prev;

      const cap = Math.max(360, base);
      this.element.style.height = Math.min(Math.max(base, needed), cap) + "px";
    }
  }

  return WidgetTesoHoloAlert;
});
