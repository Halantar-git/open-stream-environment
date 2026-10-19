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
  Scene background — видео или картинка за карточкой и виджетами.

  Один слой на все полноэкранные сцены, включая паузу. Файл приходит из
  `scene.backgroundFile`; пусто — остаётся фон темы (размытые пятна MD3).
  Слой создаётся до первого кадра и переиспользуется: при смене файла старый
  поток отпускается, иначе видео продолжало бы занимать декодер в скрытой сцене.
*/
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.SceneBackground = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function mediaKind(file) {
    const clean = String(file || "").split(/[?#]/)[0];
    if (/\.(mp4|webm|mov)$/i.test(clean)) return "video";
    if (/\.(png|jpe?g|gif|webp)$/i.test(clean)) return "image";
    return "";
  }

  function resolveMediaUrl(p) {
    if (!p) return "";
    if (/^(https?:)?\/\//i.test(p) || p.startsWith("data:")) return p;
    return location.origin + "/" + String(p).replace(/^\/+/, "");
  }

  function create(container) {
    if (!container) return { apply() {}, clear() {} };

    let layer = container.querySelector(":scope > .scene-background");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "scene-background";
      layer.hidden = true;
      container.insertBefore(layer, container.firstChild);
    }

    let current = "";
    let video = null;

    function clear() {
      current = "";
      if (video) {
        video.pause();
        video.removeAttribute("src");
        if (typeof video.load === "function") video.load();
        video = null;
      }
      layer.replaceChildren();
      layer.hidden = true;
      container.classList.remove("has-scene-background");
    }

    function fail(key) {
      // Ошибка старого файла не должна гасить новый фон.
      if (current === key) clear();
    }

    // Скрытый источник OBS не должен декодировать видео вхолостую; при
    // возврате видимости продолжаем с того же места.
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        if (!video) return;
        if (document.hidden) {
          video.pause();
          return;
        }
        const attempt = video.play();
        if (attempt && typeof attempt.catch === "function") attempt.catch(() => {});
      });
    }

    function apply(scene) {
      const file = (scene && scene.backgroundFile) || "";
      const kind = mediaKind(file);
      const url = resolveMediaUrl(file);
      const key = kind + "|" + url;
      if (key === current) return;

      clear();
      if (!kind || !url) return;
      current = key;

      if (kind === "video") {
        video = document.createElement("video");
        video.className = "scene-background__video";
        video.muted = true;
        video.loop = true;
        video.autoplay = true;
        video.playsInline = true;
        video.preload = "auto";
        video.setAttribute("muted", "");
        video.setAttribute("loop", "");
        video.setAttribute("playsinline", "");
        video.addEventListener("error", () => fail(key));
        video.src = url;
        layer.appendChild(video);
        const attempt = video.play();
        if (attempt && typeof attempt.catch === "function") attempt.catch(() => {});
      } else {
        const image = document.createElement("img");
        image.className = "scene-background__image";
        image.alt = "";
        image.addEventListener("error", () => fail(key));
        image.src = url;
        layer.appendChild(image);
      }

      layer.hidden = false;
      container.classList.add("has-scene-background");
    }

    return { apply, clear };
  }

  return { create, mediaKind, resolveMediaUrl };
});
