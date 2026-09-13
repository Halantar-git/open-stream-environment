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
  Executive Hangar timer — shared rendering core.

  One implementation for both widget variants:

    * `timer`          — 2D variant (Orbital + custom themes, catalog `themes`);
    * `grimhex-timer`  — Grim HEX 3D variant (sets `requiredTheme`).

  The countdown is always driven by the public Longshot timers config: the
  server fetches and caches it and delivers the anchor over the bus
  (`state.longshot`), while the phase/light durations and all cycle math stay
  local (shared/hangar-cycle.js). The title is fixed and the widget has no
  free-text note — the panel only exposes display toggles.

  Layout: title + phase, then the five cycle indicators (circles), then the
  big phase countdown, the cycle line and the next-indicator hint. The host
  element always carries the shared `exec-timer` class, so one style sheet
  covers both variants; the theme does the rest via its tokens.
*/
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const BaseWidget = isNode ? require("./base-widget") : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const HangarCycle = isNode ? require("../../shared/hangar-cycle") : root.HangarCycle;
  const api = factory(BaseWidget, HangarCycle);

  if (isNode) {
    module.exports = api;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.ExecutiveHangarTimer = api.ExecutiveHangarTimer;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget, HangarCycle) {
  "use strict";

  const PHASE_LABEL_KEY = {
    red: "timer.phaseRed",
    green: "timer.phaseGreen",
    black: "timer.phaseBlack",
  };

  class ExecutiveHangarTimer extends BaseWidget {
    constructor(config, context) {
      super(config, context);
      // Theme family id handed over by the WidgetManager (3D variants).
      this.theme = (context && (context.theme || context.activeThemeId)) || "";
      // Hard theme gate; empty means "no extra gate" (2D variant).
      this.requiredTheme = "";
      this.host = null;
    }

    onMount() {
      if (this.requiredTheme && this.theme !== this.requiredTheme) return;

      this.host = document.createElement("div");
      this.host.className = "exec-timer";
      this.element.appendChild(this.host);

      const { EVENT_TYPES } = this.context;
      if (EVENT_TYPES && EVENT_TYPES.LOCALES) {
        this.subscribe(EVENT_TYPES.LOCALES, () => this.render());
      }
      if (EVENT_TYPES && EVENT_TYPES.LONGSHOT_UPDATE) {
        this.subscribe(EVENT_TYPES.LONGSHOT_UPDATE, () => this.render());
      }

      // 1 Hz display clock. Every value is derived from the anchor, so this
      // only repaints the text — and is skipped while the widget is hidden.
      this.every(() => this._tick(), 1000);
    }

    onUnmount() {
      this.host = null;
    }

    _tick() {
      if (!this.host) return;
      if (!this.geometry.visible) return;
      if (typeof document !== "undefined" && document.hidden === true) return;
      this.render();
    }

    // Заголовок фиксирован — это всегда «Executive Hangar» из локалей.
    _title() {
      return this.context.t("timer.defaultTitle");
    }

    // Анкер и длительности цикла из последнего снимка Longshot.
    _source() {
      return HangarCycle.sourceFromSnapshot(this.context.state && this.context.state.longshot);
    }

    render() {
      if (!this.host) return;
      const { escapeHtml, t } = this.context;
      const cfg = this.config || {};
      const src = this._source();

      if (!src.ready) {
        this.host.dataset.phase = "off";
        const label = src.syncing ? t("timer.syncing") : t("timer.notOperational");
        this.host.innerHTML = `
          <div class="exec-timer__head">
            <span class="exec-timer__title">${escapeHtml(this._title())}</span>
          </div>
          <div class="exec-timer__off">${escapeHtml(label)}</div>`;
        return;
      }

      const st = HangarCycle.stateAt(HangarCycle.elapsedSec(src.anchorMs, Date.now(), src.durations), src.durations);
      const lights = st.lights
        .map((state) => `<span class="exec-timer__light" data-state="${state}"></span>`)
        .join("");
      const telemetry =
        st.next.kind === "blackout"
          ? t("timer.blackoutIn", { time: HangarCycle.formatDuration(st.next.inSec) })
          : st.next.kind === "green"
            ? t("timer.lightGreenIn", { light: st.next.light, time: HangarCycle.formatDuration(st.next.inSec) })
            : t("timer.lightOffIn", { light: st.next.light, time: HangarCycle.formatDuration(st.next.inSec) });
      // Строка под цифрами показывает остаток цикла. В блэкауте сайт меняет
      // подпись на «Red phase starts in …», хотя значение то же самое.
      const cycleLabel =
        st.phase === "black"
          ? t("timer.redPhaseStartsIn", { time: HangarCycle.formatDuration(st.cycleRemainingSec) })
          : t("timer.cycleResetsIn", { time: HangarCycle.formatDuration(st.cycleRemainingSec) });

      this.host.dataset.phase = st.phase;
      this.host.innerHTML = `
        <div class="exec-timer__head">
          <span class="exec-timer__title">${escapeHtml(this._title())}</span>
          <span class="exec-timer__phase">${escapeHtml(t(PHASE_LABEL_KEY[st.phase]))}</span>
        </div>
        ${cfg.showLights !== false ? `<div class="exec-timer__lights">${lights}</div>` : ""}
        <div class="exec-timer__digits">${HangarCycle.formatDuration(st.phaseRemainingSec)}</div>
        ${
          cfg.showCycle !== false
            ? `<div class="exec-timer__cycle">${escapeHtml(cycleLabel)}</div>`
            : ""
        }
        ${cfg.showTelemetry !== false ? `<div class="exec-timer__telemetry">${escapeHtml(telemetry)}</div>` : ""}`;
    }
  }

  return { ExecutiveHangarTimer };
});
