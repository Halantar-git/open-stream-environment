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
  WidgetWardogsHoloAlert — alert card for the Wardogs HUD theme.

  A DOM alert card over the theme's own panel surface (neutral dark background
  shared with every Wardogs widget) with a circular badge whose dashed ring
  spins continuously (Web Animations). The readout follows the game's terminal
  style: a monospace "WARD // <KIND>" label, the username in the display face,
  the amount in the theme accent and the donation message below. Alerts arrive
  on the shared bus and are queued one at a time.

  Theme isolation: hard-gated to "wardogs" in onMount() and via the manager.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetWardogsHoloAlert = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetWardogsHoloAlert;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetWardogsHoloAlert = WidgetWardogsHoloAlert;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_ACCENT = "#f0a92c"; // --md-primary (wardogs)
  const DEFAULT_TEXT = "#e8e5dd"; // --md-on-surface (wardogs)
  const DEFAULT_MUTED = "#b6b3a7"; // --md-on-surface-variant (wardogs)
  const FONT_DISPLAY = "'Roboto Condensed', 'Segoe UI', sans-serif";
  const FONT_MONO = "'JetBrains Mono', 'Consolas', monospace";

  class WidgetWardogsHoloAlert extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.accent = DEFAULT_ACCENT;
      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;

      this.host = null;
      this.queue = [];
      this.playing = false;
    }

    onMount() {
      // HARD theme gate: no DOM, no events on a non-Wardogs theme.
      if (this.theme !== "wardogs") return;

      this._readColors();

      this.element.classList.add("wardogs-holo-surface");
      this._applySurface();
      // Hidden until the first alert — the panel must not linger on screen.
      this.element.style.opacity = "0";

      this.host = document.createElement("div");
      this.host.className = "wardogs-holo-host";
      Object.assign(this.host.style, {
        position: "absolute",
        inset: "0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      });
      this.element.appendChild(this.host);

      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this.queueAlert(alert));
    }

    onUnmount() {
      this.queue = [];
      this.playing = false;
      if (this.element) this.element.innerHTML = "";
      this.host = null;
    }

    _readColors() {
      const read = this.context.readCssVar;
      this.accent = (read && read("--md-primary")) || DEFAULT_ACCENT;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
    }

    // Panel surface from the theme's tokens (shared background with every
    // other Wardogs widget).
    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(9, 9, 9, 0.90)";
      const blur = (read && read("--panel-blur")) || "0px";
      const border = (read && read("--panel-border")) || "1px solid rgba(240, 169, 44, 0.26)";
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow = (read && read("--panel-glow")) || "0 0 12px rgba(240, 169, 44, 0.18)";

      s.backgroundColor = bg;
      s.backgroundImage = "";
      s.backdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.webkitBackdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.border = border;
      s.borderRadius = radius;
      s.clipPath = clip;
      s.boxShadow = `${elev}, ${glow}`;
    }

    // ---- queue ----

    queueAlert(alert) {
      if (!alert) return;
      this.queue.push(alert);
      if (!this.playing) this.drain();
    }

    drain() {
      const alert = this.queue.shift();
      if (!alert) {
        this.playing = false;
        this.element.style.opacity = "0";
        this.element.style.height = this.geometry.h + "%"; // reset to layout height while hidden
        return;
      }
      this.playing = true;

      const card = this.buildCard(alert);
      this.host.appendChild(card);
      this.element.style.opacity = "1";
      this._autoSize(card);

      const ring = card.querySelector(".wardogs-holo__ring");
      if (ring && ring.animate) {
        ring.animate(
          [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
          { duration: 4200, iterations: Infinity, easing: "linear" }
        );
      }
      if (card.animate) {
        card.animate(
          [
            { opacity: 0, transform: "translateX(-16px)" },
            { opacity: 1, transform: "translateX(0)" },
          ],
          { duration: 240, easing: "ease-out" }
        );
      }

      const holdMs = alert.durationMs || 5000;
      this.later(() => {
        if (card.animate) {
          card.animate(
            [
              { opacity: 1, transform: "translateX(0)" },
              { opacity: 0, transform: "translateX(12px)" },
            ],
            { duration: 220, easing: "ease-in", fill: "forwards" }
          );
        }
        this.later(() => {
          card.remove();
          this.drain();
        }, 220);
      }, holdMs);
    }

    // ---- content helpers ----

    kindLabel(alert) {
      const { t } = this.context;
      switch (alert.kind) {
        case "follow": return t("alert.follow");
        case "sub":
          return Number(alert.months) > 1
            ? t("alert.resubMonths", { months: alert.months })
            : t("alert.sub");
        case "gift_sub": return t("alert.giftSub", { count: alert.count || 1 });
        case "cheer": return t("alert.cheer");
        case "donation": return t("alert.donation");
        case "ai": return t("alert.ai");
        case "boosty_sub": return t("alert.boostySub");
        case "boosty_resub": return t("alert.boostyResub");
        case "wheel_start": return t("alert.wheelStart");
        case "wheel_winner": return t("alert.wheelWinner");
        case "reward": return t("alert.reward");
        default: return "";
      }
    }

    formatAmount(alert) {
      const { t, formatMoney, currencySymbol } = this.context;
      if (alert.kind === "cheer") return t("alert.cheerBits", { amount: alert.amount });
      if (alert.kind === "donation") return `${formatMoney(alert.amount)} ${currencySymbol(alert.currency || "RUB")}`;
      if (alert.kind === "boosty_sub" || alert.kind === "boosty_resub") {
        return alert.amount ? `${formatMoney(alert.amount)} ${currencySymbol(alert.currency || "RUB")}` : "";
      }
      return "";
    }

    buildCard(alert) {
      const { t, ICONS, escapeHtml } = this.context;

      const showAmount =
        alert.kind === "donation" ||
        alert.kind === "cheer" ||
        ((alert.kind === "boosty_sub" || alert.kind === "boosty_resub") && Number(alert.amount) > 0);

      let icon = ICONS[alert.kind] || "";
      if (alert.kind === "wheel_start") icon = "🎉";

      let nameHtml = escapeHtml(alert.user || "");
      let messageHtml = "";
      let musicHtml = "";

      if (alert.kind === "wheel_start") {
        nameHtml = escapeHtml(t("alert.wheelStartMessage", { command: alert.command || "" }));
      } else if (alert.kind === "wheel_winner") {
        icon = "";
        const name = escapeHtml(alert.user || "");
        if (alert.isElimination) nameHtml = t("alert.eliminated", { name });
        else if (alert.isFinalWinner) nameHtml = t("alert.finalWinner", { name });
        else nameHtml = t("alert.winner", { name });
      } else if (alert.kind === "ai" || alert.kind === "donation" || alert.kind === "cheer") {
        if (alert.message) {
          messageHtml = `<span style="font-family:${FONT_DISPLAY};color:${this.mutedColor};font-size:12px;line-height:1.35;overflow-wrap:anywhere;word-break:break-word;">«${escapeHtml(alert.message)}»</span>`;
        }
        if (alert.musicTitle) {
          musicHtml = `<span style="font-family:${FONT_DISPLAY};color:${this.mutedColor};font-size:12px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">♪ ${escapeHtml(alert.musicTitle)}</span>`;
        }
      }

      const card = document.createElement("div");
      card.className = "wardogs-holo";
      Object.assign(card.style, {
        display: "flex",
        alignItems: "center",
        gap: "12px",
        maxWidth: "92%",
        padding: "10px 14px",
        boxSizing: "border-box",
      });

      card.innerHTML = `
        <div class="wardogs-holo__badge" style="position:relative;width:44px;height:44px;flex-shrink:0;">
          <div class="wardogs-holo__ring" style="position:absolute;inset:0;border-radius:50%;border:2px dashed ${this.accent};box-sizing:border-box;"></div>
          <div style="position:absolute;inset:6px;border-radius:50%;background:${this.accent}1f;display:flex;align-items:center;justify-content:center;color:${this.accent};">
            <span style="width:20px;height:20px;display:inline-flex;">${icon}</span>
          </div>
        </div>
        <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
          <span style="font-family:${FONT_MONO};color:${this.mutedColor};font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;">WARD // ${escapeHtml(this.kindLabel(alert))}</span>
          <span style="font-family:${FONT_DISPLAY};color:${this.textColor};font-size:16px;font-weight:700;line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${nameHtml}</span>
          ${showAmount ? `<span style="font-family:${FONT_MONO};color:${this.accent};font-size:13px;font-weight:700;">${escapeHtml(this.formatAmount(alert))}</span>` : ""}
          ${musicHtml}
          ${messageHtml}
        </div>`;

      return card;
    }

    // Grow the panel to fit the message (bounded), so long donation texts
    // don't get clipped by the fixed layout height.
    _autoSize(card) {
      if (!this.element) return;
      this.element.style.height = this.geometry.h + "%";
      const base = this.element.clientHeight || 100;
      const needed = (card ? card.offsetHeight : 0) + 20;
      const cap = Math.max(360, base);
      this.element.style.height = Math.min(Math.max(base, needed), cap) + "px";
    }
  }

  return WidgetWardogsHoloAlert;
});
