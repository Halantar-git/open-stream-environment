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
  WidgetGrimHexHoloAlert — holographic terminal + rotating 3D badge for the
  Grim HEX theme.

  Alerts arrive on the shared bus ({ kind: follow|sub|gift_sub|cheer|donation|
  wheel_start|wheel_winner, ... }) and are queued one at a time. The background
  is a filled panel surface matching the Recent events widget (var(--panel-bg)
  + border + radius + shadow + scanlines + corner brackets). The canvas draws a
  slowly rotating hexagonal holographic badge; on each new alert the badge
  flashes and ejects a small particle burst. The text (type, user, amount,
  message) lives in a DOM layer beside the badge.

  Theme isolation: hard-gated to "grimhex" in onMount() and via the manager.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetGrimHexHoloAlert = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetGrimHexHoloAlert;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetGrimHexHoloAlert = WidgetGrimHexHoloAlert;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  const CYAN = "#00f0ff";
  const AMBER = "#ffaa00";
  const PINK = "#ff3860";
  const TEXT = "#dcebf5";
  const MUTED = "#8ab4d0";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  class WidgetGrimHexHoloAlert extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      this.canvas = null;
      this.ctx = null;
      this.contentEl = null;

      this.queue = [];
      this.current = null;
      this._startedAt = 0;
      this._duration = 0;
      this._hideId = null;

      this._nextFlickerAt = 0;
      this._flickerUntil = 0;
      this._glitchUntil = 0;
      this._flashUntil = 0;
      this._particles = [];
    }

    // The hologram + badge + particles animate.
    _isAnimated() {
      return true;
    }

    onMount() {
      // HARD theme gate: no canvas, no loop, no events on a non-grimhex theme.
      if (this.theme !== "grimhex") return;

      this.canvas = document.createElement("canvas");
      this.canvas.className = "grimhex-holo-alert__canvas";
      Object.assign(this.canvas.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: "100%",
        height: "100%",
      });
      this.element.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");

      this.contentEl = document.createElement("div");
      this.contentEl.className = "grimhex-holo-alert__content";
      this.contentEl.style.cssText =
        "position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;box-sizing:border-box;padding:12px 16px 16px 40%;";
      this.element.appendChild(this.contentEl);

      this.element.classList.add("grimhex-holo-alert-surface");
      this._applySurface();
      this._applyTilt();
      this._nextFlickerAt = performance.now() + 2000 + Math.random() * 3000;

      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this.queueAlert(alert));
      this.startRenderLoop(30); // strictly 30 FPS
      // Hidden until the first alert; the loop sleeps meanwhile.
      this.element.style.opacity = "0";
      this.setIdle(true);
    }

    onUnmount() {
      this._flickerUntil = 0;
      this._glitchUntil = 0;
      this._flashUntil = 0;
      this._particles = [];
      if (this._hideId != null) this.clearTimer(this._hideId);
      this._hideId = null;
      this.queue = [];
      this.current = null;
      if (this.contentEl) this.contentEl.innerHTML = "";
      this.contentEl = null;
      this.ctx = null;
      this.canvas = null;
    }

    // Panel surface matching the Recent events widget: filled panel, border,
    // radius, drop shadow/glow, scanline texture + corner brackets.
    _applySurface() {
      const read = this.context.readCssVar;
      const s = this.element.style;

      const bg = (read && read("--panel-bg")) || "rgba(8, 14, 20, 0.92)";
      const blur = (read && read("--panel-blur")) || "0px";
      const border = (read && read("--panel-border")) || "1px solid rgba(0, 240, 255, 0.35)";
      const radius = (read && read("--panel-radius")) || "0px";
      const clip = (read && read("--panel-clip")) || "none";
      const elev =
        (read && read("--elev-1")) ||
        "0 1px 3px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.35)";
      const glow =
        (read && read("--panel-glow")) ||
        "0 0 15px rgba(0,240,255,0.3), inset 0 0 30px rgba(0,240,255,0.04)";

      // Set only backgroundColor so the scanline background-image from the
      // HUD decoration ([data-decoration]) can layer on top, like Recent events.
      s.backgroundColor = bg;
      s.backgroundImage = "";
      s.backdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.webkitBackdropFilter = blur === "0px" ? "none" : `blur(${blur})`;
      s.border = border;
      s.borderRadius = radius;
      s.clipPath = clip;
      s.boxShadow = `${elev}, ${glow}`;
    }

    // Subtle holographic tilt.
    _applyTilt() {
      this.element.style.transform = "perspective(1400px) rotateY(-6deg) rotateX(1deg)";
      this.element.style.transformStyle = "preserve-3d";
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
        this.setIdle(true);
        return;
      }
      this.current = alert;
      this._startedAt = performance.now();
      this._duration = alert.durationMs || 5000;
      this._glitchUntil = this._startedAt + 300; // materialize glitch
      this._flashUntil = this._startedAt + 260; // badge flash
      this._spawnParticles();

      this.element.style.opacity = "1";
      this.setIdle(false);
      this.renderContent(alert);

      if (this._hideId != null) this.clearTimer(this._hideId);
      this._hideId = this.later(() => {
        this._hideId = null;
        this.showNext();
      }, this._duration);
    }

    _spawnParticles() {
      this._particles = [];
      for (let i = 0; i < 18; i++) {
        const a = (Math.PI * 2 * i) / 18 + Math.random() * 0.6;
        const sp = 2 + Math.random() * 4;
        this._particles.push({
          x: 0,
          y: 0,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 0,
          maxLife: 26 + Math.floor(Math.random() * 26),
          size: 1.5 + Math.random() * 2.5,
        });
      }
    }

    // ---- content helpers ----

    kindColor(kind) {
      const read = this.context.readCssVar;
      switch (kind) {
        case "sub":
        case "gift_sub":
        case "wheel_start":
        case "wheel_winner":
          return (read && read("--md-secondary")) || AMBER;
        case "cheer":
        case "donation":
          return (read && read("--md-tertiary")) || PINK;
        default:
          return (read && read("--md-primary")) || CYAN;
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
      const color = this.kindColor(alert.kind);
      const amount = this.formatAmount(alert);
      const message =
        (alert.kind === "donation" || alert.kind === "cheer") && alert.message
          ? escapeHtml(alert.message)
          : "";

      // Keep the terminal text in lock-step with AlertsWidget: wheel events
      // carry no plain username, so they render a dedicated status line.
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

      this.contentEl.innerHTML =
        `<span style="font-size:10px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${MUTED};">HOLO // TERMINAL</span>` +
        `<div style="display:flex;align-items:center;gap:8px;margin-top:5px;">
          <span style="width:15px;height:15px;flex-shrink:0;color:${color};display:inline-flex;">${icon}</span>
          <span style="font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:${color};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(this.kindLabel(alert))}</span>
        </div>` +
        `<span style="font-size:20px;font-weight:700;color:${TEXT};line-height:1.15;margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${nameHtml}</span>` +
        (amount ? `<span style="font-size:14px;font-weight:700;color:${color};margin-top:4px;">${amount}</span>` : "") +
        (message ? `<span style="font-size:12px;color:${MUTED};line-height:1.35;margin-top:4px;overflow-wrap:anywhere;word-break:break-word;">«${message}»</span>` : "");
    }

    // ---- rendering ----

    render() {
      if (this.theme !== "grimhex") return;
      const ctx = this.ctx;
      if (!ctx || !this.canvas) return;

      const cw = this.canvas.clientWidth || this.element.clientWidth || 320;
      const ch = this.canvas.clientHeight || this.element.clientHeight || 140;
      const dpr = window.devicePixelRatio || 1;

      const bw = Math.max(1, Math.round(cw * dpr));
      const bh = Math.max(1, Math.round(ch * dpr));
      if (this.canvas.width !== bw || this.canvas.height !== bh) {
        this.canvas.width = bw;
        this.canvas.height = bh;
      }

      const now = performance.now();
      const t = now / 1000;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      // --- Flicker State Machine ---
      if (now >= this._nextFlickerAt) {
        this._flickerUntil = now + 120 + Math.random() * 200;
        this._nextFlickerAt = now + 2000 + Math.random() * 3000;
      }
      const glitching = now < this._glitchUntil;
      let intensity = 0.82 + 0.18 * Math.sin(t * 2.4) * Math.sin(t * 1.15);
      if (now < this._flickerUntil) intensity *= 0.35 + 0.65 * Math.abs(Math.sin(now * 0.055));
      if (glitching) intensity = 0.3 + 0.7 * Math.abs(Math.sin(now * 0.09));
      intensity = clamp(intensity, 0.12, 1);

      if (this.current) {
        const bx = cw * 0.2;
        const by = ch * 0.5;
        const R = Math.min(cw, ch) * 0.18;
        this._drawBadge(ctx, bx, by, R, t * 1.6, this.kindColor(this.current.kind), intensity, this.current.kind);
        this._drawParticles(ctx, bx, by, this.kindColor(this.current.kind));
        if (now < this._flashUntil) this._drawFlash(ctx, bx, by, R, (this._flashUntil - now) / 260);
      }

      if (glitching) this._glitchBands(ctx, bw, bh, dpr);
    }

    _drawBadge(ctx, cx, cy, R, angle, color, intensity, kind) {
      const s = Math.cos(angle); // Y-rotation projection
      const a = Math.max(0.06, Math.abs(s));

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(a, 1);
      ctx.globalAlpha = clamp(Math.abs(s), 0.15, 1);

      // Outer hexagon.
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8 + 20 * intensity;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const aa = (Math.PI / 3) * i - Math.PI / 2;
        const x = Math.cos(aa) * R;
        const y = Math.sin(aa) * R;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();

      // Kind-specific symbol inside the badge.
      ctx.lineWidth = 1.6;
      ctx.shadowBlur = 0;
      this._drawKindSymbol(ctx, R, kind);

      ctx.restore();
    }

    _drawKindSymbol(ctx, R, kind) {
      const s = R;
      switch (kind) {
        case "sub": {
          // Five-point star.
          ctx.beginPath();
          for (let i = 0; i < 10; i++) {
            const rad = i % 2 === 0 ? s * 0.5 : s * 0.22;
            const a = (Math.PI * i) / 5 - Math.PI / 2;
            const x = Math.cos(a) * rad;
            const y = Math.sin(a) * rad;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.stroke();
          break;
        }
        case "gift_sub": {
          // Gift box + ribbon + bow.
          ctx.beginPath();
          ctx.rect(-s * 0.42, -s * 0.16, s * 0.84, s * 0.52);
          ctx.moveTo(0, -s * 0.16);
          ctx.lineTo(0, s * 0.36);
          ctx.moveTo(-s * 0.42, s * 0.06);
          ctx.lineTo(s * 0.42, s * 0.06);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(0, -s * 0.16);
          ctx.lineTo(-s * 0.2, -s * 0.3);
          ctx.lineTo(-s * 0.05, -s * 0.14);
          ctx.moveTo(0, -s * 0.16);
          ctx.lineTo(s * 0.2, -s * 0.3);
          ctx.lineTo(s * 0.05, -s * 0.14);
          ctx.stroke();
          break;
        }
        case "cheer": {
          // Lightning bolt.
          ctx.beginPath();
          ctx.moveTo(s * 0.16, -s * 0.5);
          ctx.lineTo(-s * 0.24, s * 0.06);
          ctx.lineTo(s * 0.04, s * 0.06);
          ctx.lineTo(-s * 0.1, s * 0.5);
          ctx.lineTo(s * 0.36, -s * 0.04);
          ctx.lineTo(s * 0.04, -s * 0.04);
          ctx.closePath();
          ctx.stroke();
          break;
        }
        case "donation": {
          // Coin + vertical line.
          ctx.beginPath();
          ctx.arc(0, 0, s * 0.4, 0, Math.PI * 2);
          ctx.moveTo(0, -s * 0.26);
          ctx.lineTo(0, s * 0.26);
          ctx.stroke();
          break;
        }
        case "wheel_start":
        case "wheel_winner": {
          // Wheel: ring + spokes.
          ctx.beginPath();
          ctx.arc(0, 0, s * 0.45, 0, Math.PI * 2);
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i;
            ctx.moveTo(Math.cos(a) * s * 0.12, Math.sin(a) * s * 0.12);
            ctx.lineTo(Math.cos(a) * s * 0.45, Math.sin(a) * s * 0.45);
          }
          ctx.stroke();
          break;
        }
        case "follow":
        default: {
          // Heart.
          ctx.beginPath();
          ctx.moveTo(0, s * 0.32);
          ctx.bezierCurveTo(-s * 0.56, -s * 0.24, -s * 0.3, -s * 0.66, 0, -s * 0.24);
          ctx.bezierCurveTo(s * 0.3, -s * 0.66, s * 0.56, -s * 0.24, 0, s * 0.32);
          ctx.closePath();
          ctx.stroke();
          break;
        }
      }
    }

    _drawParticles(ctx, cx, cy, color) {
      const gravity = 0.06;
      for (const p of this._particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += gravity;
        p.life++;
      }
      this._particles = this._particles.filter((p) => p.life < p.maxLife);

      ctx.save();
      ctx.translate(cx, cy);
      for (const p of this._particles) {
        const alpha = 1 - p.life / p.maxLife;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.restore();
    }

    _drawFlash(ctx, cx, cy, R, alpha) {
      ctx.save();
      ctx.globalAlpha = clamp(alpha, 0, 1) * 0.7;
      ctx.fillStyle = "#ffffff";
      ctx.shadowColor = "#ffffff";
      ctx.shadowBlur = 30;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    _glitchBands(ctx, bw, bh, dpr) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const bands = 6;
      const bandH = bh / bands;
      for (let i = 0; i < bands; i++) {
        if (Math.random() < 0.45) continue;
        const offset = (Math.random() * 2 - 1) * 18 * dpr;
        const y = Math.floor(i * bandH);
        const h = Math.ceil(bandH) + 1;
        ctx.drawImage(this.canvas, 0, y, bw, h, offset, y, bw, h);
      }
      ctx.restore();
    }
  }

  return WidgetGrimHexHoloAlert;
});
