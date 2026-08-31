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
  WidgetMd3HoloAlert — Material You alert with a rotating 3D badge.

  A DOM-based alert card (the theme's glass panel) with a circular badge whose
  dashed ring spins continuously (Web Animations), a kind label, the username,
  amount and message. Alerts are queued and drained one at a time.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetMd3HoloAlert = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetMd3HoloAlert;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetMd3HoloAlert = WidgetMd3HoloAlert;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_PRIMARY = "#d0bcff";
  const DEFAULT_SECONDARY = "#ccc2dc";
  const DEFAULT_TEXT = "#e6e1e5";
  const DEFAULT_MUTED = "#cac4d0";

  class WidgetMd3HoloAlert extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.primary = DEFAULT_PRIMARY;
      this.secondary = DEFAULT_SECONDARY;
      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;

      this.host = null;
      this.queue = [];
      this.playing = false;
    }

    onMount() {
      if (this.theme !== "nebula") return;

      this._readColors();

      this.element.classList.add("md3-holo-surface");
      this._applySurface();
      // Hidden until the first alert — the panel must not linger on screen.
      this.element.style.opacity = "0";

      this.host = document.createElement("div");
      this.host.className = "md3-holo-host";
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
      this.primary = (read && read("--md-primary")) || DEFAULT_PRIMARY;
      this.secondary = (read && read("--md-secondary")) || DEFAULT_SECONDARY;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
    }

    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(33, 31, 38, 0.82)";
      const blur = (read && read("--panel-blur")) || "20px";
      const border = (read && read("--panel-border")) || "1px solid rgba(255, 255, 255, 0.12)";
      const radius = (read && read("--panel-radius")) || "24px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) || "0 1px 3px rgba(0,0,0,0.45), 0 1px 2px rgba(0,0,0,0.3)";
      const glow = (read && read("--panel-glow")) || "0 24px 48px rgba(0,0,0,0.45)";

      s.backgroundColor = bg;
      s.backgroundImage = "";
      s.backdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.webkitBackdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.border = border;
      s.borderRadius = radius;
      s.clipPath = clip;
      s.boxShadow = `${elev}, ${glow}`;
    }

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
        return;
      }
      this.playing = true;

      const card = this.buildCard(alert);
      this.host.appendChild(card);
      this.element.style.opacity = "1";

      const ring = card.querySelector(".md3-holo__ring");
      if (ring && ring.animate) {
        ring.animate(
          [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
          { duration: 4000, iterations: Infinity, easing: "linear" }
        );
      }
      if (card.animate) {
        card.animate(
          [
            { opacity: 0, transform: "scale(0.9) translateY(8px)" },
            { opacity: 1, transform: "scale(1) translateY(0)" },
          ],
          { duration: 260, easing: "cubic-bezier(0.05, 0.7, 0.1, 1)" }
        );
      }

      const holdMs = alert.durationMs || 5000;
      this.later(() => {
        if (card.animate) {
          card.animate(
            [
              { opacity: 1, transform: "scale(1)" },
              { opacity: 0, transform: "scale(0.96)" },
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

    kindLabel(alert) {
      const { t } = this.context;
      switch (alert.kind) {
        case "follow": return t("alert.follow");
        case "sub": return t("alert.sub");
        case "gift_sub": return t("alert.giftSub", { count: alert.count || 1 });
        case "cheer": return t("alert.cheer");
        case "donation": return t("alert.donation");
        case "boosty_sub": return t("alert.boostySub");
        case "boosty_resub": return t("alert.boostyResub");
        case "wheel_start": return t("alert.wheelStart");
        case "wheel_winner": return t("alert.wheelWinner");
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

      if (alert.kind === "wheel_start") {
        nameHtml = escapeHtml(t("alert.wheelStartMessage", { command: alert.command || "" }));
      } else if (alert.kind === "wheel_winner") {
        icon = "";
        const name = escapeHtml(alert.user || "");
        if (alert.isElimination) nameHtml = t("alert.eliminated", { name });
        else if (alert.isFinalWinner) nameHtml = t("alert.finalWinner", { name });
        else nameHtml = t("alert.winner", { name });
      } else if (alert.kind === "donation" || alert.kind === "cheer") {
        if (alert.message) messageHtml = `<div style="color:${this.mutedColor};font-size:13px;font-style:italic;">«${escapeHtml(alert.message)}»</div>`;
      }

      const card = document.createElement("div");
      card.className = "md3-holo";
      Object.assign(card.style, {
        display: "flex",
        alignItems: "center",
        gap: "12px",
        maxWidth: "90%",
        padding: "10px 16px",
        boxSizing: "border-box",
      });

      card.innerHTML = `
        <div class="md3-holo__badge" style="position:relative;width:40px;height:40px;flex-shrink:0;">
          <div class="md3-holo__ring" style="position:absolute;inset:0;border-radius:50%;border:2px dashed ${this.primary};box-sizing:border-box;"></div>
          <div style="position:absolute;inset:6px;border-radius:50%;background:${this.secondary}22;display:flex;align-items:center;justify-content:center;color:${this.primary};">
            <span style="width:18px;height:18px;display:inline-flex;">${icon}</span>
          </div>
        </div>
        <div style="min-width:0;">
          <div style="color:${this.mutedColor};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(this.kindLabel(alert))}</div>
          <div style="color:${this.textColor};font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${nameHtml}</div>
          ${showAmount ? `<div style="color:${this.primary};font-size:14px;font-weight:700;">${escapeHtml(this.formatAmount(alert))}</div>` : ""}
          ${messageHtml}
        </div>`;

      return card;
    }
  }

  return WidgetMd3HoloAlert;
});
