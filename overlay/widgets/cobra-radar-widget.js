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
  WidgetCobraRadar — a perspective circular sensor radar for the Elite Dangerous
  "Cobra Mk II" theme.

  The disc is a squashed ellipse (like the in-cockpit sensor panel), drawn every
  frame with a forward FOV cone and an expanding scan impulse. The player's ship
  sits at the centre. Donations materialise as contacts: one donation = one ship,
  in Elite's native marker language — a triangle for a regular ship, a square for
  a large target (>= 1000), coloured orange for neutral and red for a large /
  hostile contact. Each contact orbits slowly, rises on a height stem and drifts
  outward, disappearing only when it leaves the rim.

  This is a standalone widget: the radar runs continuously (no alert gating) and
  is fully torn down (0% GPU) in onUnmount().

  Theme isolation: hard-gated to "cobra-mk2" in onMount() and via the manager.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetCobraRadar = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetCobraRadar;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetCobraRadar = WidgetCobraRadar;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  // Elite HUD fonts (Orbitron display/mono).
  const FONT_DISPLAY = '"Orbitron", "Segoe UI", sans-serif';
  const FONT_MONO = '"Orbitron", "Consolas", monospace';

  const ORANGE = "#ff7605";
  const RED = "#ff3b30";

  // Hard cap on simultaneous contacts so a donation barrage can't overload the
  // radar (the oldest ship is dropped first).
  const MAX_CONTACTS = 24;

  class WidgetCobraRadar extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";
      this._contacts = [];
    }

    onMount() {
      // HARD theme gate: no loop, no events on a non-Cobra Mk II theme.
      if (this.theme !== "cobra-mk2") return;

      this._applyOpacity();
      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this._onAlert(alert));
      this.startRenderLoop(30); // strictly 30 FPS
    }

    onUnmount() {
      this._contacts = [];
    }

    onUpdate(prev, next) {
      if (prev.opacity !== next.opacity) this._applyOpacity();
    }

    // Widget-wide transparency (0-100), adjustable from the inspector.
    _applyOpacity() {
      const raw = Number(this.config.opacity);
      const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 100;
      this.element.style.opacity = String(pct / 100);
    }

    // One donation = one radar contact (ship). Large donations are "hostile"
    // targets and render as a red square, matching Elite's radar vocabulary.
    _onAlert(alert) {
      if (!alert || alert.kind !== "donation") return;
      const amount = Number(alert.amount) || 0;
      const hostile = amount >= 1000;
      const direction = Math.random() < 0.5 ? -1 : 1;
      const distance0 = 0.3 + Math.random() * 0.4;
      const travelMs = 25000 + Math.random() * 5000; // 25–30s to reach the rim

      this._contacts.push({
        hostile,
        angle0: Math.random() * Math.PI * 2,
        distance0,
        heightZ: Math.random() * 90 - 45,
        angularSpeed: direction * (0.0001 + Math.random() * 0.0003), // rad/ms
        radialSpeed: (1 - distance0) / travelMs, // reaches distance 1 in ~travelMs
        spawnedAt: performance.now(),
      });

      // Overflow protection: drop the oldest contact beyond the cap.
      if (this._contacts.length > MAX_CONTACTS) this._contacts.shift();
    }

    render() {
      if (this.theme !== "cobra-mk2") return;
      const ctx = this.ctx;
      if (!ctx) return;
      const canvas = this.canvas;

      const cw = canvas.clientWidth || 320;
      const ch = canvas.clientHeight || 180;
      const dpr = window.devicePixelRatio || 1;

      const bw = Math.max(1, Math.round(cw * dpr));
      const bh = Math.max(1, Math.round(ch * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }

      const now = performance.now();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      const cx = cw / 2;
      const cy = ch / 2 + 10;
      const tiltFactor = 0.45; // HUD plate tilt -> wide ellipse
      const radarRadius = Math.min(cw * 0.5, ch) * 0.85;

      const drawLine = (p1, p2, color, width = 1) => {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke();
      };

      // --- 1. Perspective radar disc ---
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, tiltFactor);

      // Outer rim.
      ctx.shadowBlur = 12;
      ctx.shadowColor = "rgba(255, 118, 5, 0.8)";
      ctx.beginPath();
      ctx.arc(0, 0, radarRadius, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 118, 5, 0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Inner sensor grid rings.
      [0.35, 0.7].forEach((r) => {
        ctx.beginPath();
        ctx.arc(0, 0, radarRadius * r, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255, 118, 5, 0.35)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
      ctx.shadowBlur = 0;

      ctx.restore();

      // Crosshair on the disc plane.
      drawLine(
        { x: cx - radarRadius, y: cy },
        { x: cx + radarRadius, y: cy },
        "rgba(255, 118, 5, 0.28)"
      );
      drawLine(
        { x: cx, y: cy - radarRadius * tiltFactor },
        { x: cx, y: cy + radarRadius * tiltFactor },
        "rgba(255, 118, 5, 0.28)"
      );

      // Forward FOV cone.
      const fov = 0.45;
      const fovLeft = {
        x: cx + Math.cos(-Math.PI / 2 + fov) * radarRadius,
        y: cy + Math.sin(-Math.PI / 2 + fov) * radarRadius * tiltFactor,
      };
      const fovRight = {
        x: cx + Math.cos(-Math.PI / 2 - fov) * radarRadius,
        y: cy + Math.sin(-Math.PI / 2 - fov) * radarRadius * tiltFactor,
      };
      drawLine({ x: cx, y: cy }, fovLeft, "rgba(255, 118, 5, 0.18)");
      drawLine({ x: cx, y: cy }, fovRight, "rgba(255, 118, 5, 0.18)");

      // --- 2. Expanding scan impulse ---
      const scanProgress = (now % 3800) / 3800;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, tiltFactor);
      ctx.beginPath();
      ctx.arc(0, 0, radarRadius * scanProgress, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 118, 5, ${0.6 * (1 - scanProgress)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      // --- 3. Player's ship at the centre ---
      ctx.fillStyle = ORANGE;
      ctx.shadowBlur = 6;
      ctx.shadowColor = ORANGE;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 6);
      ctx.lineTo(cx + 5, cy + 4);
      ctx.lineTo(cx - 5, cy + 4);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;

      // --- 4. Contacts (one per donation) ---
      // Ships drift outward and disappear only when they leave the rim, not on
      // a timer. A subtle fade over the last 10% masks the rim pop.
      this._contacts = this._contacts.filter((contact) => {
        const elapsed = now - contact.spawnedAt;
        const distance = contact.distance0 + contact.radialSpeed * elapsed;
        if (distance >= 1) return false;

        const angle = contact.angle0 + contact.angularSpeed * elapsed;
        const alpha = Math.max(0, Math.min(1, (1 - distance) / 0.1));
        const color = contact.hostile ? RED : ORANGE;

        const baseX = cx + Math.cos(angle) * distance * radarRadius;
        const baseY = cy + Math.sin(angle) * distance * radarRadius * tiltFactor;
        const targetX = baseX;
        const targetY = baseY - contact.heightZ;

        // Height stem (vertical, above the squashed disc).
        drawLine(
          { x: baseX, y: baseY },
          { x: targetX, y: targetY },
          this._rgba(color, 0.35 * alpha),
          1
        );

        // Pixel base dot on the disc.
        ctx.fillStyle = this._rgba(color, 0.4 * alpha);
        ctx.beginPath();
        ctx.arc(baseX, baseY, 2, 0, Math.PI * 2);
        ctx.fill();

        // Marker: triangle (regular) or square (large target).
        ctx.save();
        ctx.translate(targetX, targetY);
        ctx.globalAlpha = alpha;
        ctx.shadowColor = color;
        ctx.shadowBlur = 6;
        ctx.lineWidth = 1.5;

        ctx.beginPath();
        if (contact.hostile) {
          const s = 4;
          ctx.moveTo(-s, -s);
          ctx.lineTo(s, -s);
          ctx.lineTo(s, s);
          ctx.lineTo(-s, s);
        } else {
          ctx.moveTo(0, -5);
          ctx.lineTo(5, 4);
          ctx.lineTo(-5, 4);
        }
        ctx.closePath();

        // Translucent fill first, then a solid outline.
        ctx.globalAlpha = alpha * 0.2;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.stroke();

        ctx.restore();

        return true;
      });

      // --- 5. Telemetry text ---
      ctx.shadowBlur = 6;
      ctx.shadowColor = ORANGE;
      ctx.fillStyle = "rgba(255, 118, 5, 0.9)";
      ctx.font = `700 11px ${FONT_DISPLAY}`;

      ctx.textAlign = "left";
      ctx.fillText("SENSORS ON", 15, 25);

      ctx.textAlign = "right";
      ctx.fillText(`CONTACTS: ${this._contacts.length}`, cw - 15, 25);
      ctx.shadowBlur = 0;
    }

    _rgba(hex, alpha) {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }

  return WidgetCobraRadar;
});
