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
  WidgetGrimHexRadar — a perspective holographic sensor radar for the
  Grim HEX theme.

  Reproduces the in-cockpit SC radar language: a squashed holographic disc with
  a compass ring, an expanding sweep beam and a subtle 3D sensor globe. The
  player's ship sits at the centre. Donations materialise as contacts in the
  native marker vocabulary — a white hollow triangle on a dashed height stem
  with a base dot and a height-direction arrow; large donations (>= 1000) are
  tinted amber as a warning/hostile contact. Each contact orbits slowly, bobs on
  its stem and drifts outward, disappearing only when it leaves the rim.

  Side telemetry (speed / fuel / decoys) is decorative chrome matching the
  reference HUD. The radar runs continuously (no alert gating) and is fully torn
  down (0% GPU) in onUnmount().

  Theme isolation: hard-gated to "grimhex" in onMount() and via the manager.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetGrimHexRadar = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetGrimHexRadar;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetGrimHexRadar = WidgetGrimHexRadar;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  // Grim HEX / Orbital HUD fonts.
  const FONT_DISPLAY = '"Orbitron", "Segoe UI", sans-serif';
  const FONT_MONO = '"Orbitron", "Consolas", monospace';

  const CYAN = "#00f0ff";
  const AMBER = "#ffaa00";
  const WHITE = "#ffffff";
  const CYAN_DIM = "rgba(0, 240, 255, 0.4)";

  // Hard cap on simultaneous contacts so a donation barrage can't overload the
  // radar (the oldest contact is dropped first).
  const MAX_CONTACTS = 24;

  class WidgetGrimHexRadar extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";
      this._contacts = [];
    }

    onMount() {
      // HARD theme gate: no loop, no events on a non-grimhex theme.
      if (this.theme !== "grimhex") return;

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

    // One donation = one radar contact (ship). Large donations become amber
    // "hostile" contacts, matching the SC radar's warning language.
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
        phase: Math.random() * Math.PI * 2,
        spawnedAt: performance.now(),
      });

      // Overflow protection: drop the oldest contact beyond the cap.
      if (this._contacts.length > MAX_CONTACTS) this._contacts.shift();
    }

    render() {
      if (this.theme !== "grimhex") return;
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
      const cy = ch / 2 + ch * 0.02;
      const tiltFactor = 0.45; // HUD plate tilt -> wide ellipse
      const radarRadius = Math.min(cw * 0.36, ch * 0.48);
      const sweepAngle = (now * 0.001) % (Math.PI * 2);

      // Font sizes scale with the widget so the HUD text stays proportionate.
      const fs = Math.max(0.5, Math.min(3, Math.min(cw, ch) / 260));
      const fBig = Math.round(11 * fs);
      const fMed = Math.round(10 * fs);
      const fSml = Math.round(9 * fs);
      const fXsm = Math.round(8 * fs);

      // Player telemetry readouts. Speed drifts periodically; G-force tracks
      // speed (higher speed -> higher G, like real maneuvering); altitude
      // oscillates with a swing that scales with speed.
      const speed = Math.round(180 + Math.sin(now * 0.0004) * 120 + Math.sin(now * 0.0011 + 2) * 22);
      const gForce = (1.0 + (speed / 320) * 1.6).toFixed(1);
      const altitude = Math.round(
        4200 + Math.sin(now * 0.00035) * 2800 * (0.5 + speed / 640)
      );
      // DECOY / NOISE change in long, discrete steps (rarely), using a
      // deterministic per-step hash so each value holds steady for a while.
      const hash = (n) => {
        const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
        return x - Math.floor(x); // 0..1
      };
      const decoy = Math.round(10 + hash(Math.floor(now / 60000) + 7) * 24); // every 60s
      const noise = Math.round(10 + hash(Math.floor(now / 50000) + 31) * 70); // every 50s

      const drawLine = (p1, p2, color, width = 1, dashed = false) => {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(dashed ? [3, 3] : []);
        ctx.stroke();
        ctx.setLineDash([]);
      };

      const drawArrow = (x, y, isUp, color) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = color;
        ctx.beginPath();
        if (isUp) {
          ctx.moveTo(0, -3);
          ctx.lineTo(3.5, 2);
          ctx.lineTo(-3.5, 2);
        } else {
          ctx.moveTo(0, 3);
          ctx.lineTo(3.5, -2);
          ctx.lineTo(-3.5, -2);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      };

      const margin = Math.max(12, cw * 0.055);
      const scaleTop = cy - radarRadius * tiltFactor * 0.82;
      const scaleBot = cy + radarRadius * tiltFactor * 0.82;

      // --- 1. Left telemetry scale (speed) ---
      const lx = margin;
      const lxLabel = margin + 14;

      ctx.textAlign = "left";
      ctx.font = `700 ${fBig}px ${FONT_DISPLAY}`;
      drawLine({ x: lx + 10, y: scaleTop }, { x: lx, y: scaleTop }, CYAN_DIM, 1.5);
      drawLine({ x: lx, y: scaleTop }, { x: lx, y: scaleBot }, CYAN_DIM, 1.5);
      drawLine({ x: lx, y: scaleBot }, { x: lx + 10, y: scaleBot }, CYAN_DIM, 1.5);

      ctx.fillStyle = CYAN;
      ctx.fillText(`${speed} M/S`, lxLabel, cy - 5 * fs);
      ctx.fillStyle = CYAN_DIM;
      ctx.fillText(`${gForce} G`, lxLabel, cy + 12 * fs);
      ctx.fillStyle = CYAN;
      ctx.fillText(`ALT ${altitude}`, lxLabel, cy + 29 * fs);

      // Speed crosshair.
      drawLine({ x: lxLabel + 46, y: cy }, { x: lxLabel + 54, y: cy }, CYAN_DIM, 1);
      drawLine({ x: lxLabel + 50, y: cy - 4 }, { x: lxLabel + 50, y: cy + 4 }, CYAN_DIM, 1);

      // --- 2. Right telemetry scale (fuel / decoys) ---
      const rx = cw - margin;
      const rxLabel = cw - margin - 14;

      ctx.textAlign = "right";
      ctx.font = `700 ${fBig}px ${FONT_DISPLAY}`;
      drawLine({ x: rx - 10, y: scaleTop }, { x: rx, y: scaleTop }, CYAN_DIM, 1.5);
      drawLine({ x: rx, y: scaleTop }, { x: rx, y: scaleBot }, CYAN_DIM, 1.5);
      drawLine({ x: rx, y: scaleBot }, { x: rx - 10, y: scaleBot }, CYAN_DIM, 1.5);

      ctx.fillStyle = CYAN;
      ctx.fillText("AB 100%", rxLabel, cy - 5 * fs);
      ctx.fillStyle = CYAN_DIM;
      ctx.fillText("H 88%", rxLabel, cy + 12 * fs);

      ctx.font = `500 ${fSml}px ${FONT_MONO}`;
      ctx.fillStyle = CYAN_DIM;
      ctx.fillText(`DECOY ${decoy}`, rxLabel, scaleTop - 10 * fs);
      ctx.fillText(`NOISE ${noise}`, rxLabel, scaleTop + 2 * fs);

      // --- 3. Holographic sensor globe base: radial-glow disc + flat rings ---
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, tiltFactor);

      const discGrad = ctx.createRadialGradient(0, 0, radarRadius * 0.1, 0, 0, radarRadius);
      discGrad.addColorStop(0, "rgba(0, 240, 255, 0.10)");
      discGrad.addColorStop(0.55, "rgba(0, 240, 255, 0.03)");
      discGrad.addColorStop(1, "rgba(0, 240, 255, 0.12)");
      ctx.beginPath();
      ctx.arc(0, 0, radarRadius, 0, Math.PI * 2);
      ctx.fillStyle = discGrad;
      ctx.fill();
      ctx.restore();

      // Soft outer glow ring just beyond the rim.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, tiltFactor);
      ctx.beginPath();
      ctx.arc(0, 0, radarRadius + 3, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0, 240, 255, 0.12)";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();

      // Three concentric flat rings, centred on the radar axis (aligned).
      [0.9, 0.62, 0.34].forEach((r) => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, tiltFactor);
        ctx.beginPath();
        ctx.arc(0, 0, radarRadius * r, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(0, 240, 255, 0.04)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      });

      // --- 4. Compass disc with ticks + sweep beam ---
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, tiltFactor);

      // Outer rim.
      ctx.beginPath();
      ctx.arc(0, 0, radarRadius, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0, 240, 255, 0.4)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Inner rim.
      ctx.beginPath();
      ctx.arc(0, 0, radarRadius - 5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0, 240, 255, 0.15)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Minor compass ticks (every ~2.3°), majors every 45°.
      for (let a = 0; a < Math.PI * 2; a += 0.04) {
        const x1 = Math.cos(a) * (radarRadius - 4);
        const y1 = Math.sin(a) * (radarRadius - 4);
        const x2 = Math.cos(a) * radarRadius;
        const y2 = Math.sin(a) * radarRadius;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = "rgba(0, 240, 255, 0.2)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4 - Math.PI / 2; // aligned with the 000/045/... labels
        const x1 = Math.cos(a) * (radarRadius - 8);
        const y1 = Math.sin(a) * (radarRadius - 8);
        const x2 = Math.cos(a) * radarRadius;
        const y2 = Math.sin(a) * radarRadius;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = "rgba(0, 240, 255, 0.6)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Sweep scan beam (crisp, no blur).
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radarRadius, sweepAngle - 0.45, sweepAngle);
      ctx.closePath();
      ctx.fillStyle = "rgba(0, 240, 255, 0.12)";
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(sweepAngle) * radarRadius, Math.sin(sweepAngle) * radarRadius);
      ctx.strokeStyle = "rgba(0, 240, 255, 0.9)";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.restore();

      // Heading degree labels just inside the rim (readable, not squashed).
      ctx.font = `600 6px ${FONT_MONO}`;
      ctx.fillStyle = "rgba(0, 240, 255, 0.5)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let i = 0; i < 8; i++) {
        const deg = i * 45;
        const a = (deg * Math.PI) / 180 - Math.PI / 2; // 0° = forward (top), like the ship
        const lx = cx + Math.cos(a) * (radarRadius - 14);
        const ly = cy + Math.sin(a) * (radarRadius - 14) * tiltFactor;
        ctx.fillText(String(deg).padStart(3, "0"), lx, ly);
      }
      ctx.textBaseline = "alphabetic";

      // Crosshair axes on the disc plane.
      drawLine({ x: cx - radarRadius, y: cy }, { x: cx + radarRadius, y: cy }, "rgba(0, 240, 255, 0.08)");
      drawLine({ x: cx, y: cy - radarRadius * tiltFactor }, { x: cx, y: cy + radarRadius * tiltFactor }, "rgba(0, 240, 255, 0.08)");

      // --- 5. Player's ship at the centre ---
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = CYAN;
      ctx.shadowBlur = 6;
      ctx.shadowColor = CYAN;
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(4.5, 4);
      ctx.lineTo(-4.5, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.shadowBlur = 0;

      // --- 6. Contacts (one per donation) ---
      // Ships drift outward and disappear only when they leave the rim, not on
      // a timer. A subtle fade over the last 10% masks the rim pop.
      this._contacts = this._contacts.filter((contact) => {
        const elapsed = now - contact.spawnedAt;
        const distance = contact.distance0 + contact.radialSpeed * elapsed;
        if (distance >= 1) return false;

        const angle = contact.angle0 + contact.angularSpeed * elapsed;
        const alpha = Math.max(0, Math.min(1, (1 - distance) / 0.1));
        const color = contact.hostile ? AMBER : WHITE;

        const baseX = cx + Math.cos(angle) * distance * radarRadius;
        const baseY = cy + Math.sin(angle) * distance * radarRadius * tiltFactor;
        const liveHeight = contact.heightZ + Math.sin(now * 0.001 + contact.phase) * 30;
        const targetX = baseX;
        const targetY = baseY - liveHeight;

        const isAbove = liveHeight > 3;
        const isBelow = liveHeight < -3;

        // Dashed height stem (vertical, above the squashed disc).
        if (isAbove || isBelow) {
          drawLine({ x: baseX, y: baseY }, { x: targetX, y: targetY }, this._rgba(color, 0.45 * alpha), 1, true);
        }

        // Base dot strictly on the disc plane.
        ctx.fillStyle = this._rgba(color, 0.15 * alpha);
        ctx.strokeStyle = this._rgba(color, 0.7 * alpha);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(baseX, baseY, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Height-direction arrows on the middle of the stem.
        if (isAbove) drawArrow(baseX, baseY - liveHeight * 0.5, true, this._rgba(color, 0.8 * alpha));
        if (isBelow) drawArrow(baseX, baseY - liveHeight * 0.5, false, this._rgba(color, 0.8 * alpha));

        // Hollow triangle marker (contact ship).
        ctx.save();
        ctx.translate(targetX, targetY);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.fillStyle = this._rgba(color, 0.15);
        ctx.shadowColor = color;
        ctx.shadowBlur = 6;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, -5);
        ctx.lineTo(4.5, 4);
        ctx.lineTo(-4.5, 4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        // Altitude readout next to the marker.
        if (isAbove || isBelow) {
          ctx.font = `600 ${fXsm}px ${FONT_MONO}`;
          ctx.fillStyle = this._rgba(color, 0.65 * alpha);
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          const altText = `${liveHeight >= 0 ? "+" : ""}${Math.round(liveHeight)}`;
          ctx.fillText(altText, targetX + 8 * fs, targetY - fs);
          ctx.textBaseline = "alphabetic";
        }

        return true;
      });

      // --- 7. Header + distance readouts ---
      ctx.font = `700 ${fMed}px ${FONT_DISPLAY}`;
      ctx.shadowBlur = 4;
      ctx.shadowColor = CYAN;
      ctx.fillStyle = CYAN;

      ctx.textAlign = "left";
      ctx.fillText("SENSORS ON", margin, 32);

      ctx.textAlign = "right";
      ctx.fillText(`CONTACTS: ${this._contacts.length}`, cw - margin, 32);

      // Bearing (tracks the sweep) + a live target-range readout.
      const bearing = Math.round((((sweepAngle + Math.PI / 2) * 180) / Math.PI) % 360);
      const distance = (9 + Math.sin(now * 0.0003) * 3 + Math.sin(now * 0.0007 + 1) * 1).toFixed(1);

      ctx.font = `700 ${fBig}px ${FONT_DISPLAY}`;
      ctx.textAlign = "center";
      const readoutY = Math.min(cy + radarRadius * tiltFactor + 34, ch - 8);
      ctx.fillText(`${bearing}°          ${distance}km`, cx, readoutY);
      ctx.shadowBlur = 0;

      // Scanline texture overlay (HUD glass feel).
      ctx.save();
      ctx.fillStyle = "rgba(0, 240, 255, 0.025)";
      for (let y = 0; y < ch; y += 4) {
        ctx.fillRect(0, y, cw, 1);
      }
      ctx.restore();
    }

    _rgba(hex, alpha) {
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }

  return WidgetGrimHexRadar;
});
