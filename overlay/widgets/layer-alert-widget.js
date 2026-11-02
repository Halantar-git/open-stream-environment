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
      this.pendingStack = [];
      this.playing = false;
      this._compositionKey = this._key();

      const options = {
        formatMoney: this.context.formatMoney,
        currencySymbol: this.context.currencySymbol,
        resolveMediaUrl: this.context.resolveMediaUrl,
        t: this.context.t,
      };
      // Список и одиночные алерты живут в разных слоях: список не должен
      // стираться, когда одиночная композиция доиграла.
      this.stackHost = document.createElement("div");
      this.stackHost.className = "la-stack";
      this.host.appendChild(this.stackHost);
      this.queueHost = document.createElement("div");
      this.queueHost.className = "la-queue";
      this.host.appendChild(this.queueHost);

      this.stack = LayerComposition.createStack(this.stackHost, options);
      this.stack.onEmpty(() => this.drain());
      this.player = LayerComposition.createPlayer(this.queueHost, options);
      this.subscribe(this.context.EVENT_TYPES.ALERT, (alert) => this.queueAlert(alert));
      this._seedFromHistory();
    }

    onUpdate() {
      // Правка композиции приходит с сохранением в редакторе. Текущий алерт
      // смысла доигрывать по старой раскладке нет: он смешался бы с новой.
      const key = this._key();
      if (key === this._compositionKey) return;
      this._compositionKey = key;
      this.queue = [];
      this.pendingStack = [];
      this._stopCurrent();
      // Вид списка изменился — собираем его заново из той же истории.
      this._seedFromHistory();
    }

    onUnmount() {
      this.queue = [];
      this.pendingStack = [];
      this._stopCurrent();
      this.stack = null;
      this.player = null;
    }

    _key() {
      const config = this.config || {};
      return JSON.stringify([
        config.eventKinds,
        config.durationMs,
        config.stack,
        config.stackMax,
        config.persistent,
        config.minAmount,
        config.layers,
        config.reactions,
      ]);
    }

    _stopCurrent() {
      this.playing = false;
      if (this.stack) this.stack.clear();
      if (this.player) this.player.stop();
      else if (this.queueHost) this.queueHost.innerHTML = "";
    }

    /*
      Постоянный список после перезагрузки оверлея пуст, хотя история событий
      уже есть в снимке состояния. Набиваем строки из неё — от старых к новым,
      чтобы последнее событие оказалось сверху. Слушаем только историю: живые
      события приходят кадром ALERT и строками не дублируются.
    */
    _seedFromHistory() {
      const state = this.context.state || {};
      const recent = Array.isArray(state.recentEvents) ? state.recentEvents : [];
      if (!recent.length || !this.stack) return;
      // Больше шести строк интерфейс не умеет, глубже историю не берём.
      recent
        .slice(0, 6)
        .reverse()
        .forEach((alert) => {
          if (!alert) return;
          if (!LayerComposition.matchesEvent(this.config, alert)) return;
          // У категории может быть своя реакция: в список попадает по ней.
          const composition = LayerComposition.compositionForEvent(this.config, alert.kind);
          if (!composition.stack || !composition.persistent) return;
          if (!composition.layers.length) return;
          if (!LayerComposition.passesAmount(composition, alert)) return;
          this.stack.push(composition, alert);
        });
    }

    queueAlert(alert) {
      if (!alert || !LayerComposition.matchesEvent(this.config, alert)) return;
      const composition = LayerComposition.compositionForEvent(this.config, alert.kind);
      // Порог суммы — часть композиции категории, поэтому проверяем его после
      // выбора реакции, а не до.
      if (!LayerComposition.passesAmount(composition, alert)) return;
      // Категория без слоёв — осознанное «молчать»: событие не занимает эфир.
      if (!composition.layers.length) return;
      if (composition.stack) {
        // Пока играет одиночный алерт, список ждёт своей очереди, чтобы два
        // разных поведения не наложились друг на друга.
        if (this.playing) this.pendingStack.push(alert);
        else this.stack.push(composition, alert);
        return;
      }
      this.queue.push(alert);
      this.drain();
    }

    drain() {
      if (!this.player || !this.stack) return;
      if (this.playing) return;
      // Пока список на экране, одиночные алерты ждут: они занимают всю рамку
      // и перекрыли бы строки списка. Постоянный список сам не освободится,
      // поэтому его ждать не заставляем.
      if (this.stack.size() > 0 && !this.stack.persistent()) return;

      if (this.pendingStack.length) {
        const pending = this.pendingStack;
        this.pendingStack = [];
        pending.forEach((alert) => {
          const composition = LayerComposition.compositionForEvent(this.config, alert.kind);
          if (!composition.layers.length) return;
          if (composition.stack) this.stack.push(composition, alert);
          else this.queue.push(alert);
        });
        if (this.stack.size() > 0 && !this.stack.persistent()) return;
      }

      // Категория без слоёв пропускается, не занимая эфир пустой композицией.
      // Цикл вместо рекурсии: очередь может быть длинной.
      let alert = this.queue.shift();
      while (alert) {
        const composition = LayerComposition.compositionForEvent(this.config, alert.kind);
        if (composition.layers.length) {
          if (composition.stack) {
            this.stack.push(composition, alert);
            return;
          }
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
      if (this.queueHost) this.queueHost.innerHTML = "";
    }

    render() {}
  }

  return LayerAlertWidget;
});
