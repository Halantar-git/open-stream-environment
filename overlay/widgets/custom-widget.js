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
  Custom widget — text / image / raw HTML (iframe). Config-driven, re-rendered
  on update().
*/
(function (root, factory) {
  const BaseWidget =
    typeof module !== "undefined" && module.exports
      ? require("./base-widget")
      : root.OSEWidgets && root.OSEWidgets.BaseWidget;
  const CustomWidget = factory(BaseWidget);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = CustomWidget;
  } else {
    root.OSEWidgets = root.OSEWidgets || {};
    root.OSEWidgets.CustomWidget = CustomWidget;
  }
})(typeof window !== "undefined" ? window : globalThis, function (BaseWidget) {
  "use strict";

  function buildDocument(cfg) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#e8e1f0;font-family:sans-serif;}${cfg.css || ""}</style></head><body>${cfg.html || ""}<script>${cfg.js || ""}</script></body></html>`;
  }

  class CustomWidget extends BaseWidget {
    onMount() {
      this.host = document.createElement("div");
      this.host.className = "widget-custom";
      this.element.appendChild(this.host);
      this._codeKey = null;
    }

    render() {
      const { escapeHtml, escapeAttr } = this.context;
      const cfg = this.config;
      const mode = cfg.mode || "text";
      const withCard = mode !== "image" && cfg.showBackground !== false;
      this.host.className = "widget-custom" + (withCard ? " has-card" : "");

      if (mode === "image") {
        this._codeKey = null;
        const src = this.context.resolveMediaUrl
          ? this.context.resolveMediaUrl(cfg.imageUrl)
          : cfg.imageUrl;
        this.host.innerHTML = src
          ? `<img class="widget-custom__image" src="${escapeAttr(src)}" style="object-fit:${escapeAttr(cfg.imageFit || "contain")}" alt="">`
          : "";
      } else if (mode === "html") {
        const key = `${cfg.html || ""}\u0000${cfg.css || ""}\u0000${cfg.js || ""}`;
        if (this._codeKey !== key) {
          this._codeKey = key;
          this.host.innerHTML = "";
          const iframe = document.createElement("iframe");
          iframe.className = "widget-custom__html";
          iframe.srcdoc = buildDocument(cfg);
          this.host.appendChild(iframe);
        }
      } else {
        this._codeKey = null;
        const title = cfg.textTitle ? `<div class="widget-custom__title">${escapeHtml(cfg.textTitle)}</div>` : "";
        const colorStyle = cfg.textColor ? ` style="color:${escapeAttr(cfg.textColor)}"` : "";
        this.host.innerHTML = `<div class="widget-custom__text" data-align="${escapeAttr(cfg.textAlign || "center")}">${title}<div class="widget-custom__body" data-size="${escapeAttr(cfg.textSize || "medium")}"${colorStyle}>${escapeHtml(cfg.text || "")}</div></div>`;
      }
    }
  }

  return CustomWidget;
});
