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
  Алерт-композиция: по событию проигрывает набор слоёв (картинки, видео,
  текст), разложенных по времени. Слои друг за другом не «переключаются» —
  каждый живёт в своём окне, поэтому тень, фон и подпись могут появляться
  одновременно, как на монтажном таймлайне.

  Карточка события в кадре только одна: композиции идут очередью. Иначе
  два доната подряд нарисовались бы друг поверх друга.
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const LayerComposition =
    typeof module !== "undefined" && module.exports
      ? require("../../shared/layer-composition")
      : root.OSEWidgets && root.OSEWidgets.LayerComposition;
  const LayerAlertWidget = factory(BaseWidget, LayerComposition);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = LayerAlertWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.LayerAlertWidget = LayerAlertWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget, LayerComposition) {
  "use strict";

  class LayerAlertWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-layer-alert-host";
      this.element.appendChild(this.host);
      this.queue = [];
      this.playing = false;
      this._compositionKey = this._key();
      this.player = LayerComposition.createPlayer(this.host, {
        formatMoney: this.context.formatMoney,
        currencySymbol: this.context.currencySymbol,
        resolveMediaUrl: this.context.resolveMediaUrl,
      });
      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this.queueAlert(alert));
    }

    onUpdate() {
      // Правка композиции приходит с сохранением в редакторе. Текущий алерт
      // смысла доигрывать по старой раскладке нет: он смешался бы с новой.
      const key = this._key();
      if (key === this._compositionKey) return;
      this._compositionKey = key;
      this.queue = [];
      this._stopCurrent();
    }

    onUnmount() {
      this.queue = [];
      this._stopCurrent();
      this.player = null;
    }

    _key() {
      const config = this.config || {};
      return JSON.stringify([
        config.eventKinds,
        config.durationMs,
        config.layers,
        config.reactions,
      ]);
    }

    _stopCurrent() {
      this.playing = false;
      if (this.player) this.player.stop();
      else if (this.host) this.host.innerHTML = "";
    }

    queueAlert(alert) {
      if (!alert || !LayerComposition.matchesEvent(this.config, alert)) return;
      this.queue.push(alert);
      if (!this.playing) this.drain();
    }

    drain() {
      // Категория без слоёв — осознанное «молчать»: пропускаем её, не занимая
      // эфир пустой композицией. Цикл вместо рекурсии: очередь может быть
      // длинной, а тишина не должна упираться в стек.
      let alert = this.queue.shift();
      while (alert) {
        const composition = LayerComposition.compositionForEvent(this.config, alert.kind);
        if (composition.layers.length) {
          this.playing = true;
          this.player.play(composition, alert, () => {
            this.playing = false;
            this.drain();
          });
          return;
        }
        alert = this.queue.shift();
      }
      this.playing = false;
      if (this.host) this.host.innerHTML = "";
    }

    render() {}
  }

  return LayerAlertWidget;
});
