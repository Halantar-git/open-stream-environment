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
  BaseWidget — foundation class for overlay widgets.

  Contract
  --------
  A widget instance receives a layout item of the shape:

      { id, type, x, y, w, h, z, visible, config, renderType }

  where `config` holds widget-specific settings and geometry is in percent of
  the 1920x1080 canvas (0-100).

  renderType
  ----------
    * "2d"        -> a <div> rendered once by CSS/DOM. Zero GPU cost while idle
                    (used by MD3 and Pixel Perfect themes).
    * "3d-webgl"  -> a <canvas> with a WebGL2/WebGL context and an internal,
                    hard FPS-limited requestAnimationFrame loop (Star Citizen
                    themes), so the overlay never fights the
                    running game for GPU.

  Idle state ("режим сна")
  ------------------------
  The 3D render loop runs only when ALL of these hold:
    * renderType === "3d-webgl"
    * geometry.visible === true
    * not explicitly idle (setIdle(true) — e.g. animation finished)
  Otherwise the loop is fully stopped (cancelAnimationFrame) and, for hidden
  widgets, the canvas is not composited (display:none). setIdle(false) resumes
  the loop when the widget is visible again.

  Event bus
  ---------
  Data arrives via the existing Event Bus (Twitch/YouTube/OBS), never directly
  through BaseWidget. Subclasses subscribe with subscribe(channel, handler),
  where this.context.bus is any emitter exposing `on(channel, handler)`
  (returning an unsubscribe function) and/or `off(channel, handler)`.
  unmount() unsubscribes everything.

  Memory safety
  -------------
  unmount() is idempotent and performs a total teardown: cancels rAF, clears all
  timers scheduled via later()/every(), removes all DOM listeners registered via
  on(), unsubscribes from the bus, releases the WebGL context and detaches the
  DOM node.
*/
(function (root, factory) {
  const BaseWidget = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = BaseWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.BaseWidget = BaseWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  class BaseWidget {
    constructor(config = {}, context = {}) {
      this.id = config.id != null ? String(config.id) : null;
      this.type = config.type || "custom";
      this.renderType =
        config.renderType === "3d-webgl" || config.renderType === "canvas" ? config.renderType : "2d";
      this.context = context || {};

      this.config = Object.assign({}, config.config);

      this.geometry = {
        x: config.x != null ? config.x : 0,
        y: config.y != null ? config.y : 0,
        w: config.w != null ? config.w : 10,
        h: config.h != null ? config.h : 10,
        z: config.z != null ? config.z : 0,
        visible: config.visible !== false,
      };

      this.element = null;
      this.canvas = null;
      this.gl = null;
      this.ctx = null;

      this._mounted = false;
      this._rafId = 0;
      this._fps = 0;
      this._loopDesired = false; // subclass asked for animation (startRenderLoop)
      this._idle = false; // explicit sleep (animation finished, etc.)
      this._timers = new Set(); // setTimeout/setInterval handles
      this._listeners = []; // { target, type, fn, options }
      this._subs = []; // { channel, handler, off }
      this._handleResize = () => this.resize();
    }

    // ---- public lifecycle ----

    mount(parentEl) {
      if (this._mounted) return this.element;
      if (!parentEl) throw new Error("BaseWidget.mount(parentEl): parentEl is required");

      this.element = this._createElement();
      parentEl.appendChild(this.element);
      this._mounted = true;

      this._applyGeometry();

      if (this.renderType === "3d-webgl") {
        this._initWebGL();
        if (!this.gl) {
          this.renderType = "2d"; // graceful fallback when WebGL is unavailable
        } else if (typeof window !== "undefined") {
          this.on(window, "resize", this._handleResize);
        }
      } else if (this.renderType === "canvas") {
        this._initCanvas2D();
        if (typeof window !== "undefined") this.on(window, "resize", this._handleResize);
      }

      this.onMount();
      this.render();
      return this.element;
    }

    update(newConfig = {}) {
      const prev = Object.assign({}, this.config);
      this.config = Object.assign({}, this.config, newConfig.config);

      if (newConfig.x !== undefined) this.geometry.x = newConfig.x;
      if (newConfig.y !== undefined) this.geometry.y = newConfig.y;
      if (newConfig.w !== undefined) this.geometry.w = newConfig.w;
      if (newConfig.h !== undefined) this.geometry.h = newConfig.h;
      if (newConfig.z !== undefined) this.geometry.z = newConfig.z;
      if (newConfig.visible !== undefined) this.geometry.visible = !!newConfig.visible;

      this._applyGeometry();
      this.onUpdate(prev, this.config);

      // 2D re-renders on change; 3D is driven by the frame loop.
      if (this.renderType === "2d") this.render();

      this._syncLoop();
    }

    unmount() {
      if (!this._mounted) return;

      this.stopRenderLoop();
      this._clearTimers();
      this._offAll();
      this._unsubscribeAll();
      this.onUnmount();
      if (this.gl) this._disposeGL();

      if (this.element && this.element.parentNode) {
        this.element.parentNode.removeChild(this.element);
      }

      this.element = null;
      this.canvas = null;
      this.gl = null;
      this.ctx = null;
      this._mounted = false;
    }

    // ---- render loop (3D only) ----

    startRenderLoop(fps = 30) {
      this._fps = clamp(fps, 1, 120);
      this._loopDesired = true;
      this._syncLoop();
    }

    stopRenderLoop() {
      this._loopDesired = false;
      this._cancelFrame();
    }

    setIdle(idle) {
      const next = !!idle;
      if (next === this._idle) return;
      this._idle = next;
      this.onIdle(next);
      this._syncLoop();
    }

    // ---- auto-tracked resource helpers (cleared by unmount) ----

    later(fn, ms = 0) {
      const id = setTimeout(() => {
        this._timers.delete(id);
        fn();
      }, ms);
      this._timers.add(id);
      return id;
    }

    every(fn, ms) {
      const id = setInterval(fn, ms);
      this._timers.add(id);
      return id;
    }

    clearTimer(id) {
      clearTimeout(id);
      clearInterval(id);
      this._timers.delete(id);
    }

    on(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      this._listeners.push({ target, type, fn, options });
    }

    // Subscribe to the shared Event Bus. Returns the subscription record
    // (or null if no bus is available in this.context).
    subscribe(channel, handler) {
      const bus = this.context.bus;
      if (!bus || typeof bus.on !== "function") return null;
      const off = bus.on(channel, handler);
      const sub = { channel, handler, off: typeof off === "function" ? off : null };
      this._subs.push(sub);
      return sub;
    }

    resize() {
      if (this.canvas) this._resizeCanvas();
    }

    // ---- subclass hooks ----

    onMount() {}
    onUpdate(_prevConfig, _nextConfig) {}
    onUnmount() {}
    onIdle(_isIdle) {}
    render() {}

    // ---- internals ----

    _isAnimated() {
      return this.renderType === "3d-webgl" || this.renderType === "canvas";
    }

    _syncLoop() {
      const shouldRun = this._isAnimated() && this._loopDesired && this.geometry.visible && !this._idle;
      if (shouldRun) this._scheduleFrame();
      else this._cancelFrame();
    }

    _scheduleFrame() {
      if (this._rafId !== 0) return;
      const frameMs = 1000 / (this._fps || 30);
      let last = performance.now();

      const tick = (now) => {
        this._rafId = requestAnimationFrame(tick);
        const delta = now - last;
        if (delta < frameMs) return; // hard FPS cap: skip this frame
        last = now - (delta % frameMs); // keep cadence stable, no drift
        this.render();
      };

      this._rafId = requestAnimationFrame(tick);
    }

    _cancelFrame() {
      if (this._rafId !== 0) {
        cancelAnimationFrame(this._rafId);
        this._rafId = 0;
      }
    }

    _createElement() {
      if (this.renderType === "3d-webgl" || this.renderType === "canvas") {
        this.canvas = document.createElement("canvas");
        this.canvas.className = "widget-instance widget-instance--3d";
        this.canvas.dataset.type = this.type;
        return this.canvas;
      }
      const el = document.createElement("div");
      el.className = "widget-instance";
      el.dataset.type = this.type;
      return el;
    }

    _applyGeometry() {
      if (!this.element) return;
      const s = this.element.style;
      s.position = "absolute";
      s.left = this.geometry.x + "%";
      s.top = this.geometry.y + "%";
      s.width = this.geometry.w + "%";
      s.height = this.geometry.h + "%";
      s.zIndex = String(this.geometry.z);
      s.display = this.geometry.visible ? "" : "none";
    }

    _initWebGL() {
      if (!this.canvas) return;
      const attrs = {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        powerPreference: "low-power",
      };
      this.gl =
        this.canvas.getContext("webgl2", attrs) ||
        this.canvas.getContext("webgl", attrs) ||
        this.canvas.getContext("experimental-webgl", attrs);
      if (this.gl) this._resizeCanvas();
    }

    _initCanvas2D() {
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext("2d");
      if (this.ctx) this._resizeCanvas();
    }

    _resizeCanvas() {
      if (!this.canvas) return;
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      const w = Math.max(1, Math.floor((this.canvas.clientWidth || 1) * dpr));
      const h = Math.max(1, Math.floor((this.canvas.clientHeight || 1) * dpr));
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      if (this.gl && typeof this.gl.viewport === "function") this.gl.viewport(0, 0, w, h);
      if (this.ctx && typeof this.ctx.setTransform === "function") this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    _disposeGL() {
      const gl = this.gl;
      if (!gl) return;
      try {
        const lose = gl.getExtension && gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      } catch (_) {
        /* context may already be lost — ignore */
      }
    }

    _clearTimers() {
      for (const id of this._timers) {
        clearTimeout(id);
        clearInterval(id);
      }
      this._timers.clear();
    }

    _offAll() {
      for (const { target, type, fn, options } of this._listeners) {
        target.removeEventListener(type, fn, options);
      }
      this._listeners.length = 0;
    }

    _unsubscribeAll() {
      const bus = this.context.bus;
      for (const sub of this._subs) {
        if (typeof sub.off === "function") {
          try {
            sub.off();
          } catch (_) {
            /* ignore */
          }
        } else if (bus && typeof bus.off === "function") {
          try {
            bus.off(sub.channel, sub.handler);
          } catch (_) {
            /* ignore */
          }
        }
      }
      this._subs.length = 0;
    }
  }

  return BaseWidget;
});
