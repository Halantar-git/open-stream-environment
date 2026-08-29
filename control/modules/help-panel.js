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
  Built-in help panel for the control panel.

  Single responsibility: render the localized user guide into a slide-out
  panel, provide a section nav with a light scroll-spy, and toggle the panel
  from the top bar help button. Content lives entirely in the locale
  dictionaries (see `help.*`), so it follows the selected language.
*/

import { el, on } from "./dom.js";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Sections are rendered in order. `code` blocks are non-localized literals
// (URLs are identical across languages); `p` and `steps` reference i18n keys.
const SECTIONS = [
  {
    id: "overview",
    title: "help.overview.title",
    blocks: [
      { type: "p", key: "help.overview.p1" },
      { type: "p", key: "help.overview.p2" },
    ],
  },
  {
    id: "quickstart",
    title: "help.quickstart.title",
    blocks: [
      { type: "steps", items: ["help.quickstart.s1", "help.quickstart.s2", "help.quickstart.s3", "help.quickstart.s4"] },
    ],
  },
  {
    id: "editor",
    title: "help.editor.title",
    blocks: [
      { type: "p", key: "help.editor.p1" },
      { type: "p", key: "help.editor.p2" },
      { type: "p", key: "help.editor.p3" },
      { type: "p", key: "help.editor.p4" },
      { type: "code", text: "http://localhost:8710/overlay/overlay.html" },
    ],
  },
  {
    id: "widget",
    title: "help.widget.title",
    blocks: [
      { type: "p", key: "help.widget.p1" },
      { type: "p", key: "help.widget.p2" },
      { type: "p", key: "help.widget.p3" },
    ],
  },
  {
    id: "presets",
    title: "help.presets.title",
    blocks: [
      { type: "p", key: "help.presets.p1" },
      { type: "p", key: "help.presets.p2" },
      { type: "p", key: "help.presets.p3" },
    ],
  },
  {
    id: "themes",
    title: "help.themes.title",
    blocks: [
      { type: "p", key: "help.themes.p1" },
      { type: "p", key: "help.themes.p2" },
      { type: "p", key: "help.themes.p3" },
      { type: "p", key: "help.themes.p4" },
    ],
  },
  {
    id: "scenes",
    title: "help.scenes.title",
    blocks: [
      { type: "p", key: "help.scenes.p1" },
      { type: "p", key: "help.scenes.p2" },
      { type: "p", key: "help.scenes.p3" },
      { type: "p", key: "help.scenes.p4" },
    ],
  },
  {
    id: "twitch",
    title: "help.twitch.title",
    blocks: [
      { type: "p", key: "help.twitch.p1" },
      { type: "p", key: "help.twitch.p2" },
      { type: "steps", items: ["help.twitch.s1", "help.twitch.s2", "help.twitch.s3", "help.twitch.s4"] },
    ],
  },
  {
    id: "donationalerts",
    title: "help.donationalerts.title",
    blocks: [
      { type: "p", key: "help.donationalerts.p1" },
      { type: "p", key: "help.donationalerts.p2" },
      { type: "steps", items: ["help.donationalerts.s1", "help.donationalerts.s2", "help.donationalerts.s3"] },
    ],
  },
  {
    id: "youtube",
    title: "help.youtube.title",
    blocks: [
      { type: "p", key: "help.youtube.p1" },
      { type: "steps", items: ["help.youtube.s1", "help.youtube.s2", "help.youtube.s3", "help.youtube.s4"] },
    ],
  },
  {
    id: "obs",
    title: "help.obs.title",
    blocks: [
      { type: "p", key: "help.obs.p1" },
      { type: "p", key: "help.obs.p2" },
      { type: "p", key: "help.obs.p3" },
    ],
  },
  {
    id: "soundboard",
    title: "help.soundboard.title",
    blocks: [
      { type: "p", key: "help.soundboard.p1" },
      { type: "p", key: "help.soundboard.p2" },
    ],
  },
  {
    id: "streamdeck",
    title: "help.streamdeck.title",
    blocks: [
      { type: "p", key: "help.streamdeck.p1" },
      { type: "p", key: "help.streamdeck.p2" },
    ],
  },
  {
    id: "remote",
    title: "help.remote.title",
    blocks: [
      { type: "p", key: "help.remote.p1" },
      { type: "p", key: "help.remote.p2" },
    ],
  },
  {
    id: "terminal",
    title: "help.terminal.title",
    blocks: [
      { type: "p", key: "help.terminal.p1" },
      { type: "p", key: "help.terminal.p2" },
      { type: "p", key: "help.terminal.p3" },
    ],
  },
  {
    id: "debug",
    title: "help.debug.title",
    blocks: [
      { type: "p", key: "help.debug.p1" },
      { type: "p", key: "help.debug.p2" },
    ],
  },
  {
    id: "wheel",
    title: "help.wheel.title",
    blocks: [
      { type: "p", key: "help.wheel.p1" },
      { type: "p", key: "help.wheel.p2" },
      { type: "p", key: "help.wheel.p3" },
      { type: "p", key: "help.wheel.p4" },
    ],
  },
  {
    id: "settings",
    title: "help.settings.title",
    blocks: [
      { type: "p", key: "help.settings.p1" },
      { type: "p", key: "help.settings.p2" },
      { type: "p", key: "help.settings.p3" },
    ],
  },
  {
    id: "data",
    title: "help.data.title",
    blocks: [
      { type: "p", key: "help.data.p1" },
      { type: "p", key: "help.data.p2" },
      { type: "p", key: "help.data.p3" },
    ],
  },
];

export function initHelpPanel({ t, ICONS }) {
  const panel = el("helpPanel");
  const body = el("helpBody");
  const nav = el("helpNav");
  const toggleBtn = el("toggleHelpBtn");

  function blockHtml(block) {
    if (block.type === "code") {
      return `<code class="help-code">${escapeHtml(block.text)}</code>`;
    }
    if (block.type === "steps") {
      const items = (block.items || []).map((k) => `<li>${escapeHtml(t(k))}</li>`).join("");
      return `<ol>${items}</ol>`;
    }
    // paragraph
    return `<p>${escapeHtml(t(block.key))}</p>`;
  }

  function sectionHtml(section) {
    const blocks = (section.blocks || []).map(blockHtml).join("");
    return `<section class="help-section" id="help-sec-${section.id}" data-section="${section.id}">
      <h3 class="help-section__title">${escapeHtml(t(section.title))}</h3>
      ${blocks}
    </section>`;
  }

  function render() {
    if (!body || !nav) return;
    body.innerHTML = SECTIONS.map(sectionHtml).join("");

    nav.innerHTML = SECTIONS.map((s) =>
      `<button class="help-nav-chip" data-target="${s.id}" type="button">${escapeHtml(t(s.title))}</button>`
    ).join("");

    nav.querySelectorAll(".help-nav-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const target = document.getElementById(`help-sec-${chip.dataset.target}`);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function setOpen(open) {
    if (!panel || !toggleBtn) return;
    panel.hidden = !open;
    toggleBtn.classList.toggle("is-active", open);
  }

  function toggle() {
    setOpen(panel && panel.hidden);
  }

  function refreshLabel() {
    if (toggleBtn) toggleBtn.innerHTML = `${ICONS.help} ${t("help.title")}`;
  }

  function refresh() {
    refreshLabel();
    render();
  }

  // Scroll-spy: highlight the nav chip of the section currently in view.
  if (body) {
    body.addEventListener("scroll", () => {
      if (!nav) return;
      const sections = Array.from(body.querySelectorAll(".help-section"));
      let active = sections[0] && sections[0].dataset.section;
      const probe = body.scrollTop + 96;
      for (const s of sections) {
        if (s.offsetTop <= probe) active = s.dataset.section;
      }
      nav.querySelectorAll(".help-nav-chip").forEach((chip) => {
        chip.classList.toggle("is-active", chip.dataset.target === active);
      });
    });
  }

  refreshLabel();
  render();

  on("helpCloseBtn", "click", () => setOpen(false));

  return { toggle, setOpen, refreshLabel, refresh };
}
