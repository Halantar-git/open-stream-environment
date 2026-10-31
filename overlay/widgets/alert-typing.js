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
  Посимвольная печать текста — тот же приём, что в теме Terminal.

  Карточки тем собираются обычной разметкой, и заранее неизвестно, в каком
  узле лежит подпись события, а в каком — имя и сообщение. Поэтому печатаем
  все текстовые узлы поддерева по порядку: допечатанные строки сразу видны
  целиком, а в конце текущей стоит каретка. Так же печатается и текст в чате
  Terminal — там в поддерево передаётся только сообщение.

  `typeAlertText` возвращает ручку с `stop()`: она дорисовывает текст и
  убирает таймер. Если печатать нечего или включён `prefers-reduced-motion`,
  ручка пустая — вызывать можно без проверок.

  Опции: `keepCaret: false` убирает каретку с последней строки (когда она
  нужна только во время печати), `onTick` зовётся после каждого такта —
  чату по нему нужно доскроллить растущую строку.
*/
(function (root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.AlertTyping = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // Скорость как у Terminal: два символа за 16 мс.
  const TYPE_MS = 16;
  const CHARS_PER_TICK = 2;

  // Внутрь иконок и служебных блоков не лезем: это не текст события.
  const SKIP_TAGS = new Set(["svg", "style", "script"]);

  function reduceMotion() {
    return (
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function collectTextNodes(root) {
    const nodes = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        if ((node.nodeValue || "").trim()) nodes.push(node);
        return;
      }
      if (node.nodeType !== 1) return;
      if (SKIP_TAGS.has((node.nodeName || "").toLowerCase())) return;
      const children = node.childNodes || [];
      for (let i = 0; i < children.length; i += 1) walk(children[i]);
    };
    walk(root);
    return nodes;
  }

  function typeAlertText(root, options) {
    const settings = options || {};
    const keepCaret = settings.keepCaret !== false;
    const onTick = typeof settings.onTick === "function" ? settings.onTick : null;
    const idle = { stop() {} };
    if (!root || !root.childNodes || reduceMotion()) return idle;

    const nodes = collectTextNodes(root);
    if (!nodes.length) return idle;

    const originals = nodes.map((node) => node.nodeValue);
    // Режем по code point'ам: иначе эмодзи из сообщения на один такт развалится
    // на половинки суррогатной пары.
    const glyphs = originals.map((text) => Array.from(text));

    const caret = document.createElement("span");
    caret.className = "type-caret";

    let index = 0;
    let count = 0;
    let timer = null;

    const showAll = () => {
      nodes.forEach((node, i) => {
        node.nodeValue = originals[i];
      });
    };

    const dropCaret = () => {
      if (caret.parentNode) caret.parentNode.removeChild(caret);
    };

    const placeCaret = (node) => {
      const parent = node.parentNode;
      if (!parent) return;
      dropCaret();
      if (typeof parent.insertBefore === "function" && node.nextSibling !== undefined) {
        parent.insertBefore(caret, node.nextSibling);
      } else {
        parent.appendChild(caret);
      }
    };

    const stopTimer = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const finish = () => {
      stopTimer();
      showAll();
      dropCaret();
    };

    const step = () => {
      // Панель могли убрать раньше, чем текст допечатался.
      if (root.isConnected === false) {
        finish();
        return;
      }
      const chars = glyphs[index];
      if (!chars) {
        finish();
        return;
      }
      count = Math.min(chars.length, count + CHARS_PER_TICK);
      nodes[index].nodeValue = chars.slice(0, count).join("");
      if (onTick) onTick();
      if (count < chars.length) return;
      index += 1;
      count = 0;
      if (nodes[index]) {
        placeCaret(nodes[index]);
      } else {
        // Всё допечатано — каретка остаётся мигать в конце, как в терминале,
        // если виджет не попросил её убрать.
        if (!keepCaret) dropCaret();
        stopTimer();
      }
    };

    nodes.forEach((node) => {
      node.nodeValue = "";
    });
    placeCaret(nodes[0]);
    timer = setInterval(step, TYPE_MS);

    return { stop: finish };
  }

  return { typeAlertText };
});
