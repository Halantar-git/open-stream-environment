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
  WidgetRetrowaveHoloAlert — floating alert card for the Retrowave theme.

  The card rides the theme's own panel surface with a striped sunset sun on the
  left: a gradient disc cut by horizontal gaps, the genre's most recognisable
  motif. The readout is a monospaced "SIGNAL // <KIND>" line, the username in the
  display face, the amount in neon magenta and the donation message below.
  Alerts arrive on the shared bus and are queued one at a time; the panel stays
  invisible until the first one, so nothing lingers on stream.

  Theme isolation: hard-gated to "retrowave" in onMount() and via the manager.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetRetrowaveHoloAlert = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetRetrowaveHoloAlert;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetRetrowaveHoloAlert = WidgetRetrowaveHoloAlert;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const DEFAULT_PRIMARY = "#ff2d95"; // --md-primary
  const DEFAULT_SECONDARY = "#2de2e6"; // --md-secondary
  const DEFAULT_TERTIARY = "#ffa24c"; // --md-tertiary
  const DEFAULT_TEXT = "#f3e8ff"; // --md-on-surface
  const DEFAULT_MUTED = "#c3b0e0"; // --md-on-surface-variant

  const FONT_DISPLAY = "'Orbitron', 'Segoe UI', sans-serif";
  const FONT_BODY = "'Montserrat', 'Segoe UI', sans-serif";
  const FONT_MONO = "'JetBrains Mono', 'Consolas', monospace";

  class WidgetRetrowaveHoloAlert extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.primary = DEFAULT_PRIMARY;
      this.secondary = DEFAULT_SECONDARY;
      this.tertiary = DEFAULT_TERTIARY;
      this.textColor = DEFAULT_TEXT;
      this.mutedColor = DEFAULT_MUTED;

      this.host = null;
      this.queue = [];
      this.playing = false;
    }

    onMount() {
      // HARD theme gate: no DOM, no events on a foreign theme.
      if (this.theme !== "retrowave") return;

      this._readColors();
      this.element.classList.add("retrowave-surface");
      this._applySurface();
      // Hidden until the first alert — the panel must not linger on screen.
      this.element.style.opacity = "0";

      this.host = document.createElement("div");
      this.host.className = "retrowave-holo-host";
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
      this.tertiary = (read && read("--md-tertiary")) || DEFAULT_TERTIARY;
      this.textColor = (read && read("--md-on-surface")) || DEFAULT_TEXT;
      this.mutedColor = (read && read("--md-on-surface-variant")) || DEFAULT_MUTED;
    }

    // Panel surface from the theme's tokens (one background for every widget).
    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(13, 7, 25, 0.88)";
      const blur = (read && read("--panel-blur")) || "0px";
      const border = (read && read("--panel-border")) || "2px solid rgba(255, 45, 149, 0.8)";
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow = (read && read("--panel-glow")) || "0 0 18px rgba(255,45,149,0.35)";

      // An empty backgroundImage lets the grid from `.retrowave-surface` show.
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
        this.element.style.height = this.geometry.h + "%"; // reset while hidden
        return;
      }
      this.playing = true;

      const card = this.buildCard(alert);
      this.host.appendChild(card);
      this.element.style.opacity = "1";
      this._autoSize(card);

      if (card.animate) {
        card.animate(
          [
            { opacity: 0, transform: "translateX(-18px) skewX(-8deg)" },
            { opacity: 1, transform: "translateX(0) skewX(0deg)" },
          ],
          { duration: 240, easing: "cubic-bezier(0.2, 0.9, 0.2, 1.1)" }
        );
      }

      const holdMs = alert.durationMs || 5000;
      this.later(() => {
        if (card.animate) {
          card.animate(
            [
              { opacity: 1, transform: "translateX(0) skewX(0deg)" },
              { opacity: 0, transform: "translateX(14px) skewX(6deg)" },
            ],
            { duration: 200, easing: "ease-in", fill: "forwards" }
          );
        }
        this.later(() => {
          card.remove();
          this.drain();
        }, 200);
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
        const name = escapeHtml(alert.user || "");
        if (alert.isElimination) nameHtml = t("alert.eliminated", { name });
        else if (alert.isFinalWinner) nameHtml = t("alert.finalWinner", { name });
        else nameHtml = t("alert.winner", { name });
      } else if (alert.kind === "donation" || alert.kind === "cheer") {
        if (alert.message) {
          messageHtml = `<span style="font-family:${FONT_BODY};color:${this.mutedColor};font-size:12px;line-height:1.35;overflow-wrap:anywhere;word-break:break-word;">«${escapeHtml(alert.message)}»</span>`;
        }
        if (alert.musicTitle) {
          musicHtml = `<span style="font-family:${FONT_BODY};color:${this.mutedColor};font-size:12px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">♪ ${escapeHtml(alert.musicTitle)}</span>`;
        }
      }

      const card = document.createElement("div");
      card.className = "retrowave-holo";
      Object.assign(card.style, {
        display: "flex",
        alignItems: "center",
        gap: "13px",
        maxWidth: "92%",
        padding: "10px 15px",
        boxSizing: "border-box",
      });

      card.innerHTML = `
        <div class="retrowave-holo__sun" style="position:relative;width:46px;height:46px;flex-shrink:0;">
          ${this._sunSvg()}
          <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:${this.textColor};">
            <span style="width:16px;height:16px;display:inline-flex;">${icon}</span>
          </span>
        </div>
        <div style="min-width:0;display:flex;flex-direction:column;gap:2px;">
          <span style="font-family:${FONT_MONO};color:${this.secondary};font-size:10px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;">SIGNAL // ${escapeHtml(this.kindLabel(alert))}</span>
          <span style="font-family:${FONT_DISPLAY};color:${this.textColor};font-size:16px;font-weight:700;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 0 10px rgba(255,45,149,0.55);">${nameHtml}</span>
          ${showAmount ? `<span style="font-family:${FONT_MONO};color:${this.primary};font-size:13px;font-weight:700;text-shadow:0 0 10px rgba(45,226,230,0.45);">${escapeHtml(this.formatAmount(alert))}</span>` : ""}
          ${musicHtml}
          ${messageHtml}
        </div>`;

      return card;
    }

    // The striped sun: a warm gradient disc with horizontal gaps cut through the
    // lower half. Painted as SVG so it stays crisp at any widget size and needs
    // no extra image asset on stream.
    _sunSvg() {
      const id = "rwSun" + String(this.id || "x").replace(/[^a-zA-Z0-9_-]/g, "");
      const stripes = [26, 30, 34, 38, 42]
        .map((y, i) => `<rect x="6" y="${y}" width="36" height="${i < 2 ? 2 : 1.6}" fill="rgba(13,7,25,0.92)"/>`)
        .join("");
      return `<svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true" style="display:block;">
        <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${this.tertiary}"/>
          <stop offset="55%" stop-color="${this.primary}"/>
          <stop offset="100%" stop-color="${this.primary}"/>
        </linearGradient></defs>
        <circle cx="24" cy="24" r="18" fill="url(#${id})" opacity="0.95"/>
        <circle cx="24" cy="24" r="18" fill="none" stroke="${this.secondary}" stroke-width="1.2" opacity="0.65"/>
        ${stripes}
      </svg>`;
    }

    // Grow the panel to fit the message (bounded), so long donation texts are
    // not clipped by the fixed layout height.
    _autoSize(card) {
      if (!this.element) return;
      this.element.style.height = this.geometry.h + "%";
      const base = this.element.clientHeight || 100;
      const needed = (card ? card.offsetHeight : 0) + 20;
      const cap = Math.max(360, base);
      this.element.style.height = Math.min(Math.max(base, needed), cap) + "px";
    }
  }

  return WidgetRetrowaveHoloAlert;
});
