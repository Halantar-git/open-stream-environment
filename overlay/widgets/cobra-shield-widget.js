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
  WidgetCobraShield — a Cobra Mk II hologram wrapped in three shield rings for
  the Elite Dangerous "Cobra Mk II" theme.

  The donation goal drives three near-white shield rings that sweep from the
  left ("S") around the ship; the ship flashes cockpit-orange, or blinks
  hostile-red when the shields are offline (< 5%). A telemetry footer shows the
  credit amounts from the goal state, and each donation triggers a short flash
  pulse.

  Unlike the panel-style goal widgets this is a transparent hologram (no
  background), rendered on the built-in 30 FPS loop and torn down to 0% GPU in
  onUnmount().

  Theme isolation: hard-gated to "cobra-mk2" in onMount() and via the manager.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetCobraShield = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetCobraShield;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetCobraShield = WidgetCobraShield;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  // Elite HUD fonts (Orbitron display/mono).
  const FONT_DISPLAY = '"Orbitron", "Segoe UI", sans-serif';
  const FONT_MONO = '"Orbitron", "Consolas", monospace';

  class WidgetCobraShield extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      this.theme = (context && (context.theme || context.activeThemeId)) || "";

      // Goal state (target progress + telemetry footer).
      this._pct = 0;
      this._smooth = 0;
      this._goalText = "SYS_CR: 0 / 0";

      // Donation flash pulse.
      this._pulsing = false;
      this._pulseAt = 0;
    }

    onMount() {
      // HARD theme gate: never spin up the loop or draw on a non-Cobra Mk II theme.
      if (this.theme !== "cobra-mk2") return;

      this._applyOpacity();
      this._updateGoal();
      this.bindEvents();
      this.startRenderLoop(30); // strictly 30 FPS
    }

    onUnmount() {
      this._pulsing = false;
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

    bindEvents() {
      const { EVENT_TYPES } = this.context;
      this.subscribe(EVENT_TYPES.GOAL_UPDATE, () => this._updateGoal());
      this.subscribe(EVENT_TYPES.ALERT, (alert) => {
        if (alert && alert.kind === "donation") {
          this._pulsing = true;
          this._pulseAt = performance.now();
        }
      });
    }

    _updateGoal() {
      const { state, formatMoney, currencySymbol } = this.context;
      const goal = (state && state.goal) || {};
      const current = goal.current || 0;
      const target = goal.target || 0;
      this._pct = target > 0 ? Math.min(1, current / target) : 0;

      const cur = formatMoney ? formatMoney(current) : String(current);
      const tgt = formatMoney ? formatMoney(target) : String(target);
      const sym = currencySymbol ? currencySymbol(goal.currency || "RUB") : "";
      this._goalText = `SYS_CR: ${cur} / ${tgt} ${sym}`;
    }

    // ---- rendering ----

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

      const centerX = cw / 2;
      const centerY = ch * 0.45;

      // Font/offset scale relative to the widget size. Letters scale gently and
      // are about half the previous size (reference 600px).
      const scale = Math.min(cw, ch) / 600;

      // Goal progress, smoothed toward the target on each donation.
      this._smooth += (this._pct - this._smooth) * 0.08;

      const isLow = this._smooth < 0.05;
      const ringColor = isLow ? "255, 59, 48" : "236, 240, 245"; // red vs near-white

      // Donation flash pulse (fades over 1s).
      let flashAlpha = 0;
      if (this._pulsing) {
        const elapsed = now - this._pulseAt;
        if (elapsed > 1000) this._pulsing = false;
        else flashAlpha = 1 - elapsed / 1000;
      }

      // --- 1. 3D Cobra Mk II (fixed forward perspective, no rotation) ---
      ctx.save();
      ctx.translate(centerX, centerY + Math.min(cw, ch) * 0.05); // ship shifted slightly down

      const shipScale = Math.min(cw, ch) * 0.13;

      // 3D mesh (X, Y, Z) of the Cobra Mk II: stepped stern + wings + canopy.
      const vertices = {
        nose:        { x: 0,     y: -1.4, z: 0 },
        wingBreakR:  { x: 0.9,   y: -0.1, z: 0.05 },
        wingBreakL:  { x: -0.9,  y: -0.1, z: 0.05 },
        wingTipR:    { x: 1.4,   y: 0.5,  z: 0.1 },
        wingTipL:    { x: -1.4,  y: 0.5,  z: 0.1 },
        tailOuterR:  { x: 1.1,   y: 0.8,  z: 0.05 },
        tailOuterL:  { x: -1.1,  y: 0.8,  z: 0.05 },
        engineWallR: { x: 0.5,   y: 0.5,  z: -0.05 },
        engineWallL: { x: -0.5,  y: 0.5,  z: -0.05 },
        canopyFront: { x: 0,     y: -0.5, z: -0.2 },
        canopyBack:  { x: 0,     y: -0.1, z: -0.3 },
        ridgeR:      { x: 0.25,  y: 0.2,  z: -0.25 },
        ridgeL:      { x: -0.25, y: 0.2,  z: -0.25 },
        bottom:      { x: 0,     y: 0.1,  z: 0.25 },
      };

      // Fixed camera pitch + subtle idle hover: the nose stays pointing forward
      // (into the screen), with a gentle vertical bob and faint pitch breathing.
      const bobY = Math.sin(now * 0.001) * 3;
      const pitch = -0.55 + Math.sin(now * 0.0005) * 0.03;

      const project = (v) => {
        const y1 = v.y * Math.cos(pitch) - v.z * Math.sin(pitch);
        const z1 = v.y * Math.sin(pitch) + v.z * Math.cos(pitch);
        const persp = 1 / (1 + z1 * 0.5); // farther (positive z1) -> smaller
        return { x: v.x * shipScale * persp, y: y1 * shipScale * persp + bobY };
      };

      const p = {};
      for (const key in vertices) p[key] = project(vertices[key]);

      // Fill/stroke a hull polygon.
      const drawPoly = (points, fillColor, strokeColor, lineWidth = 1) => {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.closePath();
        if (fillColor) {
          ctx.fillStyle = fillColor;
          ctx.fill();
        }
        if (strokeColor) {
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = lineWidth;
          ctx.stroke();
        }
      };

      // Faulcon DeLacy livery.
      const baseHull = isLow ? "rgba(45, 15, 15, 0.85)" : "rgba(20, 26, 31, 0.9)";
      const glowLine = isLow ? "rgba(255, 59, 48, 0.9)" : "rgba(255, 118, 5, 0.85)";
      const canopyColor = isLow ? "rgba(255, 59, 48, 0.3)" : "rgba(0, 210, 255, 0.25)";

      ctx.shadowBlur = isLow ? 12 : 5;
      ctx.shadowColor = isLow ? "rgba(255, 59, 48, 0.5)" : "rgba(255, 118, 5, 0.4)";

      // 1. Left and right wings (main planes).
      drawPoly([p.nose, p.wingBreakR, p.wingTipR, p.tailOuterR, p.engineWallR, p.bottom], baseHull, glowLine);
      drawPoly([p.nose, p.wingBreakL, p.wingTipL, p.tailOuterL, p.engineWallL, p.bottom], baseHull, glowLine);

      // 2. Tail slopes (side superstructures next to the engines).
      drawPoly([p.wingTipR, p.tailOuterR, p.engineWallR, p.bottom], baseHull, glowLine);
      drawPoly([p.wingTipL, p.tailOuterL, p.engineWallL, p.bottom], baseHull, glowLine);

      // 3. Upper fuselage superstructure.
      drawPoly([p.nose, p.canopyFront, p.ridgeR, p.engineWallR, p.bottom], baseHull, glowLine);
      drawPoly([p.nose, p.canopyFront, p.ridgeL, p.engineWallL, p.bottom], baseHull, glowLine);

      // 4. Recessed engine plate (tail notch).
      drawPoly([p.engineWallL, p.engineWallR, p.bottom], "rgba(10, 12, 15, 0.95)", glowLine);

      // 5. Engine glow line inside the tail notch (cyan indicator).
      ctx.beginPath();
      ctx.moveTo(p.engineWallL.x, p.engineWallL.y);
      ctx.lineTo(p.engineWallR.x, p.engineWallR.y);
      ctx.strokeStyle = isLow ? "rgba(255, 59, 48, 0.4)" : "rgba(0, 210, 255, 0.8)";
      ctx.lineWidth = 3.5;
      ctx.stroke();

      // 6. Cockpit canopy glass (top of the nose).
      ctx.shadowColor = isLow ? "rgba(255, 59, 48, 0.8)" : "rgba(0, 210, 255, 0.8)";
      drawPoly([p.canopyFront, p.ridgeR, p.canopyBack, p.ridgeL], canopyColor, isLow ? "#ff3b30" : "#00d2ff", 1.5);

      ctx.restore();

      // --- 2. Three shield rings (round, around the ship) ---
      const baseRadius = Math.min(cw, ch) * 0.30;
      const ringGaps = [0, 14, 28];
      const ringY = centerY + Math.min(cw, ch) * 0.06; // shifted slightly down

      ctx.save();
      ctx.translate(centerX, ringY);
      ctx.scale(1.3, 0.6); // HUD plate tilt
      ctx.translate(-centerX, -ringY);

      ringGaps.forEach((gap) => {
        const radius = baseRadius + gap;

        // Gauge: from 7 o'clock (19:00) sweeping clockwise to 5 o'clock (17:00),
        // filling as the goal progresses.
        const startAngle = (2 * Math.PI) / 3; // 7 o'clock
        const sweepAngle = (300 / 180) * Math.PI; // ends at 5 o'clock
        const endAngle = startAngle + sweepAngle * this._smooth;

        if (this._smooth > 0) {
          ctx.beginPath();
          ctx.arc(centerX, ringY, radius, startAngle, endAngle);
          ctx.lineWidth = 3;
          ctx.strokeStyle = `rgba(${ringColor}, ${0.3 + this._smooth * 0.7})`;
          ctx.shadowBlur = 8;
          ctx.shadowColor = `rgba(${ringColor}, 0.8)`;

          if (flashAlpha > 0) {
            ctx.strokeStyle = `rgba(255, 255, 255, ${flashAlpha})`;
            ctx.lineWidth = 4;
          }
          ctx.stroke();
        } else {
          // Faint arc outline at 0%.
          ctx.beginPath();
          ctx.arc(centerX, ringY, radius, startAngle, startAngle + sweepAngle);
          ctx.lineWidth = 1;
          ctx.strokeStyle = `rgba(${ringColor}, 0.06)`;
          ctx.shadowBlur = 0;
          ctx.stroke();
        }
      });
      ctx.restore();

      // --- 3. Telemetry text ---
      ctx.shadowBlur = 4;
      ctx.shadowColor = "rgba(255, 118, 5, 0.6)";
      ctx.textAlign = "center";

      // Lore easter egg header (closer to the shield rings).
      ctx.fillStyle = "rgba(255, 118, 5, 0.4)";
      ctx.font = `500 ${Math.round(11 * scale)}px ${FONT_MONO}`;
      ctx.fillText("FAULCON DELACY // COBRA MK II", centerX, centerY - baseRadius * 0.8);

      // Shield percentage (round, matching the goal bar's 100% at target).
      const percentText = isLow ? "SHIELDS OFFLINE" : `SHIELD: ${Math.round(this._smooth * 100)}%`;
      const percentY = centerY + baseRadius * 0.6 + 40 * scale;
      ctx.font = `700 ${Math.round(22 * scale)}px ${FONT_DISPLAY}`;
      if (isLow) {
        ctx.fillStyle = "#ff3b30";
        ctx.shadowColor = "rgba(255, 59, 48, 0.6)";
      } else {
        ctx.fillStyle = "#ff7605";
      }
      ctx.fillText(percentText, centerX, percentY);

      // Credit goal footer (directly under the shield percentage).
      ctx.fillStyle = "#ffb07c";
      ctx.font = `${Math.round(13 * scale)}px ${FONT_MONO}`;
      ctx.fillText(this._goalText, centerX, percentY + 26 * scale);
    }
  }

  return WidgetCobraShield;
});
