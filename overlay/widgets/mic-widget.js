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
  Microphone visualizer widget — a 2D <canvas> wave (sine / bars / ring) driven
  by Web Audio (getUserMedia) locally, or by the remote mic bridge
  (MIC_AUDIO_DATA). Its rAF loop, microphone stream and AudioContext are fully
  torn down in onUnmount().
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const MicWidget = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = MicWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.MicWidget = MicWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  class MicWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-mic";
      this.element.appendChild(this.host);

      this.micCanvas = document.createElement("canvas");
      this.micCanvas.className = "widget-mic__canvas";
      this.host.appendChild(this.micCanvas);
      this.micCtx = this.micCanvas.getContext("2d");

      this.t0 = performance.now();
      this.analyser = null;
      this.dataArray = null;
      this.freqArray = null;
      this.rafId = null;
      this.audioCtx = null;
      this.stream = null;
      this.micError = null;
      this._eqBars = null;
      this._eqLast = null;

      this._startAudio();
      this._loop();
    }

    onUnmount() {
      this._stopVisualizer();
      this.host = null;
      this.micCanvas = null;
      this.micCtx = null;
    }

    render() {}

    // ---- audio capture ----

    _startAudio() {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        this.micError = "unsupported";
        if (typeof console !== "undefined") console.warn("[mic] Web Audio API not supported");
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.micError = "insecure";
        if (typeof console !== "undefined") console.warn("[mic] getUserMedia unavailable");
        return;
      }
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          if (!this.micCanvas || !this.micCanvas.isConnected) {
            stream.getTracks().forEach((tr) => tr.stop());
            return;
          }
          const ctx = new Ctx();
          if (ctx.state === "suspended") ctx.resume().catch(() => {});
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0.6;
          source.connect(analyser);
          this.stream = stream;
          this.audioCtx = ctx;
          this.analyser = analyser;
          this.dataArray = new Uint8Array(analyser.fftSize);
          this.freqArray = new Uint8Array(analyser.frequencyBinCount);
          this.micError = null;
        })
        .catch((err) => {
          this.micError = (err && err.name) || "error";
          if (typeof console !== "undefined") console.warn("[mic] microphone unavailable:", (err && err.name) || "unknown");
        });
    }

    _stopVisualizer() {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      if (this.stream) {
        this.stream.getTracks().forEach((tr) => tr.stop());
        this.stream = null;
      }
      if (this.audioCtx) {
        this.audioCtx.close().catch(() => {});
        this.audioCtx = null;
      }
      this.analyser = null;
      this.dataArray = null;
      this.freqArray = null;
    }

    _loop() {
      const tick = (now) => {
        if (!this.micCanvas || !this.micCanvas.isConnected) {
          this.rafId = null;
          return;
        }
        this._draw(now);
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    }

    // ---- drawing ----

    _draw(now) {
      const { readCssVar, state } = this.context;
      const canvas = this.micCanvas;
      const host = this.host;
      const cw = host.clientWidth || 320;
      const ch = host.clientHeight || 96;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
      }

      const ctx = this.micCtx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      const cfg = state.micConfig || {};
      const color = this.config.color || cfg.color || readCssVar("--md-primary") || "#0060A8";
      const sensitivity = this._clamp(cfg.sensitivity, 0.2, 6, 1.5);
      const lineWidth = this._clamp(cfg.lineWidth, 1, 12, 2);
      const opacity = this._clamp(cfg.opacity, 0.05, 1, 0.9);
      const mode = cfg.visualizer_mode || "sine";

      const amp = (ch / 2) * 0.92 * sensitivity;
      const t = (now - this.t0) / 1000;
      const dt = this._eqLast == null ? 0 : Math.min(0.1, (now - this._eqLast) / 1000);
      this._eqLast = now;

      let level = 0;
      if (this.analyser && this.dataArray) {
        this.analyser.getByteTimeDomainData(this.dataArray);
        let sum = 0;
        for (let i = 0; i < this.dataArray.length; i++) {
          const v = (this.dataArray[i] - 128) / 128;
          sum += v * v;
        }
        level = Math.sqrt(sum / this.dataArray.length);
      } else if (state.remoteMicData) {
        level = state.remoteMicData.level || 0;
        this.dataArray = state.remoteMicData.wave;
        this.freqArray = state.remoteMicData.freq;
      }
      this.level = level;

      if (mode !== "sine" && this.analyser && this.freqArray) {
        this.analyser.getByteFrequencyData(this.freqArray);
      }

      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.globalAlpha = opacity;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      if (!this.analyser && this.micError && !state.remoteMicData) {
        const hint =
          this.micError === "NotAllowedError" || this.micError === "insecure"
            ? "🎤 нет доступа к микрофону"
            : "🎤 микрофон недоступен";
        ctx.font = `${Math.max(12, Math.round(ch * 0.18))}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(hint, cw / 2, ch / 2);
        ctx.globalAlpha = 1;
        return;
      }

      if (mode === "bars") {
        this._drawBars(ctx, cw, ch, cfg);
      } else if (mode === "ring") {
        this._drawRing(ctx, cw, ch, cfg);
      } else if (mode === "equalizer") {
        this._drawEqualizer(ctx, cw, ch, cfg, dt);
      } else {
        this._drawSine(ctx, cw, ch, t, amp, level);
      }

      ctx.globalAlpha = 1;
    }

    _drawSine(ctx, cw, ch, t, amp, level) {
      const live = level > 0.02;
      const POINTS = 240;
      const midY = ch / 2;
      ctx.beginPath();
      for (let i = 0; i <= POINTS; i++) {
        const x = (i / POINTS) * cw;
        let y = midY;
        if (live && this.dataArray && this.dataArray.length) {
          const idx = Math.floor((i / POINTS) * (this.dataArray.length - 1));
          const v = (this.dataArray[idx] - 128) / 128;
          y = midY + v * amp;
        } else {
          y = midY + Math.sin(x * 0.02 + t * 1.6) * (amp * 0.05) + Math.sin(x * 0.006 - t * 0.9) * (amp * 0.03);
        }
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    _drawBars(ctx, cw, ch, cfg) {
      const freq = this.freqArray;
      if (!freq || !freq.length) return;
      const barCount = Math.round(this._clamp(cfg.barCount, 10, 64, 32));
      const gap = Math.max(0, Number(cfg.barGap) || 0);
      const usable = Math.max(8, Math.floor(freq.length * 0.8));
      const slotW = cw / barCount;
      const barW = Math.max(1, slotW - gap);
      for (let i = 0; i < barCount; i++) {
        const idx = Math.floor((i / (barCount - 1)) * (usable - 1));
        const v = freq[idx] / 255;
        const h = Math.max(1, v * ch * 0.96);
        const x = i * slotW + (slotW - barW) / 2;
        const y = (ch - h) / 2;
        ctx.fillRect(x, y, barW, h);
      }
    }

    _drawEqualizer(ctx, cw, ch, cfg, dt) {
      const freq = this.freqArray;
      if (!freq || !freq.length) return;
      const barCount = Math.round(this._clamp(cfg.barCount, 10, 64, 32));
      const gap = Math.max(0, Number(cfg.barGap) || 0);

      // Vertical LED segments: ~8px cells with 2px gaps, scaled to the host
      // height. The classic palette (green → yellow → red) matches the reference.
      const cellCount = Math.max(2, Math.round(ch / 10));
      const cellGap = 2;
      const cellH = Math.max(1, (ch - (cellCount - 1) * cellGap) / cellCount);
      const GREEN = "#2ecc40";
      const YELLOW = "#ffdc00";
      const RED = "#ff4136";
      const read = this.context.readCssVar;
      const off = (read && read("--md-surface-container-high")) || "rgba(255,255,255,0.08)";

      // Falling-peak physics, expressed in cells/second so it is independent of
      // the host frame rate. `level` rises instantly to the live value and
      // decays smoothly; `peak` holds for a moment, then falls back down.
      const levelDecay = 10;
      const peakFall = this._clamp(cfg.peakFall, 0.5, 10, 2.5);
      const holdSec = 0.54;

      if (!this._eqBars || this._eqBars.length !== barCount) {
        this._eqBars = [];
        for (let i = 0; i < barCount; i++) this._eqBars.push({ level: 0, peak: 0, hold: 0 });
      }

      const usable = Math.max(8, Math.floor(freq.length * 0.8));
      const slotW = cw / barCount;
      const barW = Math.max(1, slotW - gap);

      for (let i = 0; i < barCount; i++) {
        const idx = Math.floor((i / (barCount - 1)) * (usable - 1));
        const v = freq[idx] / 255;
        const target = v * cellCount;
        const bar = this._eqBars[i];

        if (target > bar.level) bar.level = target;
        else bar.level = Math.max(target, bar.level - levelDecay * dt);

        if (bar.level >= bar.peak) {
          bar.peak = bar.level;
          bar.hold = holdSec;
        } else if (bar.hold > 0) {
          bar.hold -= dt;
        } else {
          bar.peak = Math.max(bar.level, bar.peak - peakFall * dt);
        }

        const x = i * slotW + (slotW - barW) / 2;
        const lit = Math.round(bar.level);
        const peakIndex = Math.round(bar.peak) - 1;

        for (let c = 0; c < cellCount; c++) {
          const y = ch - (c + 1) * cellH - c * cellGap;
          const on = c < lit || c === peakIndex;
          ctx.fillStyle = on ? this._eqColor(c, cellCount, GREEN, YELLOW, RED) : off;
          ctx.fillRect(x, y, barW, cellH);
        }
      }
    }

    _eqColor(c, count, green, yellow, red) {
      if (c < (count * 8) / 14) return green;
      if (c < (count * 12) / 14) return yellow;
      return red;
    }

    _drawRing(ctx, cw, ch, cfg) {
      const freq = this.freqArray;
      if (!freq || !freq.length) return;
      const barCount = Math.round(this._clamp(cfg.barCount, 10, 64, 32));
      const cx = cw / 2;
      const cy = ch / 2;
      const maxR = Math.min(cw, ch) / 2 - 2;
      const minR = maxR * 0.35;
      const usable = Math.max(8, Math.floor(freq.length * 0.8));
      for (let i = 0; i < barCount; i++) {
        const idx = Math.floor((i / (barCount - 1)) * (usable - 1));
        const v = freq[idx] / 255;
        const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
        const r = minR + (maxR - minR) * v;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * minR, cy + Math.sin(angle) * minR);
        ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
        ctx.stroke();
      }
    }

    _clamp(v, min, max, fallback) {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    }
  }

  return MicWidget;
});
