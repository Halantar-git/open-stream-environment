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
  WidgetManager — layout orchestrator.

  Keeps the set of live widgets in sync with an incoming layout array without
  tearing down the whole overlay on every state change:

    * new widget id     -> create via registry/factory + mount()
    * known widget id   -> update()
    * changed type      -> unmount() old + mount() new
    * removed widget id -> unmount() + drop from the Map

  Widget classes are resolved through `registry` (type -> class) or an optional
  `factory` override, and the render mode ("2d" | "3d-webgl") is decided by
  `resolveRenderType(item)` so themes can opt specific widgets into WebGL.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const WidgetManager = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WidgetManager;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.WidgetManager = WidgetManager;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  class WidgetManager {
    constructor(rootEl, options = {}) {
      if (!rootEl) throw new Error("WidgetManager(rootEl): root element is required");

      this.root = rootEl;
      this.registry = new Map(); // type -> WidgetClass
      this.instances = new Map(); // id -> BaseWidget instance
      this.context = options.context || {};

      // (item) => "2d" | "canvas" | "3d-webgl" — theme-driven render mode.
      this.resolveRenderType = options.resolveRenderType || (() => "2d");

      // (item) => boolean — theme guard. If false, the widget is not created
      // (and is unmounted if it was already on screen). Used to isolate 3D
      // Star Citizen widgets from lightweight 2D themes.
      this.shouldMount = options.shouldMount || (() => true);

      // (item) => WidgetClass — optional full override of the registry.
      this.factory = options.factory || null;

      this.hooks = {
        mount: options.onMount || null,
        update: options.onUpdate || null,
        unmount: options.onUnmount || null,
      };
    }

    register(type, WidgetClass) {
      this.registry.set(type, WidgetClass);
      return this;
    }

    _build(item) {
      const WidgetClass =
        (this.factory && this.factory(item)) || this.registry.get(item.type) || BaseWidget;
      const renderType = this.resolveRenderType(item) || "2d";
      return new WidgetClass(Object.assign({}, item, { renderType }), this.context);
    }

    syncLayout(layoutConfig) {
      const incoming = new Map();
      const items = Array.isArray(layoutConfig) ? layoutConfig : [];

      for (const item of items) {
        if (item && item.id != null && this.shouldMount(item)) incoming.set(String(item.id), item);
      }

      // Mount new, re-mount changed types, update existing.
      for (const item of incoming.values()) {
        const id = String(item.id);
        let inst = this.instances.get(id);

        if (!inst || inst.type !== item.type) {
          if (inst) {
            inst.unmount();
            this.instances.delete(id);
            if (this.hooks.unmount) this.hooks.unmount(inst);
          }
          inst = this._build(item);
          this.instances.set(id, inst);
          inst.mount(this.root);
          if (this.hooks.mount) this.hooks.mount(inst, item);
        }

        inst.update(item);
        if (this.hooks.update) this.hooks.update(inst, item);
      }

      // Unmount widgets that disappeared from the config.
      for (const [id, inst] of this.instances) {
        if (!incoming.has(id)) {
          inst.unmount();
          this.instances.delete(id);
          if (this.hooks.unmount) this.hooks.unmount(inst);
        }
      }

      return this.instances.size;
    }

    get(id) {
      return this.instances.get(String(id));
    }

    has(id) {
      return this.instances.has(String(id));
    }

    get size() {
      return this.instances.size;
    }

    clear() {
      for (const [, inst] of this.instances) inst.unmount();
      this.instances.clear();
    }
  }

  return WidgetManager;
});
