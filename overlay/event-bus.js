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
  EventBus — minimal, dependency-free pub/sub used to decouple the WebSocket
  data layer (Twitch / YouTube / OBS) from the widgets. Widgets subscribe in
  onMount() and are fully unsubscribed by BaseWidget.unmount().
*/
(function (root, factory) {
  const EventBus = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = EventBus;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.EventBus = EventBus;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  class EventBus {
    constructor() {
      this._handlers = new Map();
    }

    on(type, fn) {
      if (!this._handlers.has(type)) this._handlers.set(type, new Set());
      this._handlers.get(type).add(fn);
      return () => this.off(type, fn);
    }

    off(type, fn) {
      const set = this._handlers.get(type);
      if (!set) return;
      set.delete(fn);
      if (set.size === 0) this._handlers.delete(type);
    }

    once(type, fn) {
      const off = this.on(type, (payload) => {
        off();
        fn(payload);
      });
      return off;
    }

    emit(type, payload) {
      const set = this._handlers.get(type);
      if (!set) return;
      set.forEach((fn) => {
        try {
          fn(payload);
        } catch (err) {
          if (typeof console !== "undefined" && console.error) console.error("[EventBus]", type, err);
        }
      });
    }

    removeAll() {
      this._handlers.clear();
    }
  }

  return EventBus;
});
