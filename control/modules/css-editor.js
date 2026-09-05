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
  DOM layer for the lightweight CSS editor: a transparent <textarea> over a
  highlighted <pre> (the classic "highlighted textarea" trick), plus context
  autocomplete and inline validation.

  The pure logic (tokenizer, autocomplete context, validation) lives in
  shared/css-editor-core.js so it can be unit-tested; this module only owns the
  DOM and interaction.
*/

const {
  escapeHtml,
  highlightCss,
  detectContext,
  getCompletions,
  validate,
} = window.CssEditorCore;

export function initCssEditor({ container, initialValue = "", tokens = [], selectors = [], id = "seedCustomCss", t = (k) => k }) {
  const wrap = document.createElement("div");
  wrap.className = "css-editor";

  const pre = document.createElement("pre");
  pre.className = "css-editor__pre";
  pre.setAttribute("aria-hidden", "true");

  const matchPre = document.createElement("pre");
  matchPre.className = "css-editor__matches";
  matchPre.setAttribute("aria-hidden", "true");

  const textarea = document.createElement("textarea");
  textarea.className = "css-editor__input";
  textarea.id = id;
  textarea.spellcheck = false;
  textarea.value = initialValue;

  const menu = document.createElement("div");
  menu.className = "css-editor__menu";
  menu.hidden = true;

  const status = document.createElement("div");
  status.className = "css-editor__status";
  status.hidden = true;

  wrap.appendChild(pre);
  wrap.appendChild(matchPre);
  wrap.appendChild(textarea);
  wrap.appendChild(menu);
  container.appendChild(wrap);
  container.appendChild(status);

  let completions = [];
  let activeIndex = 0;
  let context = null;
  let currentFindQuery = "";

  function renderHighlight() {
    pre.innerHTML = highlightCss(textarea.value) + "\n";
  }

  // Renders translucent <mark> highlights for every match of `query` onto a
  // dedicated transparent layer between the syntax highlight and the textarea,
  // so matches are highlighted without disturbing the token colors.
  function highlightMatches(query) {
    currentFindQuery = String(query || "");
    const q = currentFindQuery.toLowerCase();
    if (!q) {
      matchPre.innerHTML = "";
      return;
    }
    const text = textarea.value;
    const lower = text.toLowerCase();
    const selStart = textarea.selectionStart;
    const selEnd = textarea.selectionEnd;
    const ranges = [];
    let idx = lower.indexOf(q);
    while (idx !== -1) {
      ranges.push([idx, idx + q.length]);
      idx = lower.indexOf(q, idx + q.length);
    }
    let html = "";
    let last = 0;
    ranges.forEach(([start, end]) => {
      html += escapeHtml(text.slice(last, start));
      const isCurrent = start <= selStart && selEnd <= end;
      html += `<mark class="css-find-match${isCurrent ? " is-current" : ""}">${escapeHtml(text.slice(start, end))}</mark>`;
      last = end;
    });
    html += escapeHtml(text.slice(last));
    matchPre.innerHTML = html + "\n";
  }

  function syncScroll() {
    pre.scrollTop = textarea.scrollTop;
    pre.scrollLeft = textarea.scrollLeft;
    matchPre.scrollTop = textarea.scrollTop;
    matchPre.scrollLeft = textarea.scrollLeft;
  }

  function closeMenu() {
    menu.hidden = true;
    menu.innerHTML = "";
    completions = [];
    context = null;
  }

  function setActive(index) {
    activeIndex = index;
    const items = menu.querySelectorAll(".css-editor__item");
    items.forEach((el, i) => el.classList.toggle("is-active", i === index));
    const active = items[index];
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function applyCompletion(index) {
    const c = completions[index];
    if (!c || !context) return;
    const [start, end] = context.range;
    textarea.focus();
    textarea.setSelectionRange(start, end);
    closeMenu();

    // Use the native insertion path so Ctrl+Z keeps a coherent undo history.
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, c.text);
    } catch (_) {
      inserted = false;
    }
    if (!inserted) {
      const val = textarea.value;
      textarea.value = val.slice(0, start) + c.text + val.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + c.text.length;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    renderHighlight();
    syncScroll();
    scheduleValidation();
    textarea.focus();
  }

  function positionMenu() {
    const before = textarea.value.slice(0, textarea.selectionStart);
    const line = before.split("\n").length - 1;
    const style = getComputedStyle(textarea);
    const lh = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    const padTop = parseFloat(style.paddingTop) || 0;
    menu.style.top = Math.min(padTop + line * lh, textarea.clientHeight - 8) + "px";
    menu.style.left = "12px";
  }

  function renderMenu() {
    menu.innerHTML = "";
    completions.forEach((c, i) => {
      const item = document.createElement("div");
      item.className = "css-editor__item" + (i === activeIndex ? " is-active" : "");
      item.innerHTML = `<span>${escapeHtml(c.label)}</span><span class="css-editor__item-kind">${c.kind}</span>`;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        applyCompletion(i);
      });
      item.addEventListener("mouseenter", () => setActive(i));
      menu.appendChild(item);
    });
    menu.hidden = false;
    positionMenu();
  }

  function computeAutocomplete() {
    closeMenu();
    context = detectContext(textarea.value, textarea.selectionStart);
    if (!context) return;
    completions = getCompletions(context, tokens, selectors);
    if (!completions.length) {
      context = null;
      return;
    }
    activeIndex = 0;
    renderMenu();
  }

  function renderValidation(issues) {
    if (!issues.length) {
      status.hidden = true;
      status.innerHTML = "";
      return;
    }
    status.hidden = false;
    status.innerHTML = issues
      .slice(0, 6)
      .map((issue) => {
        const line = issue.line ? `${t("themeEditor.cssLine")} ${issue.line}: ` : "";
        if (issue.kind === "syntax") return `<div class="css-editor__issue">${escapeHtml(t("themeEditor.cssIssueSyntax"))}</div>`;
        if (issue.kind === "property") return `<div class="css-editor__issue">${escapeHtml(line + t("themeEditor.cssIssueUnknownProperty", { name: issue.name }))}</div>`;
        return `<div class="css-editor__issue">${escapeHtml(line + t("themeEditor.cssIssueInvalidValue", { value: issue.value }))}</div>`;
      })
      .join("");
  }

  let validationTimer = null;
  function scheduleValidation() {
    clearTimeout(validationTimer);
    validationTimer = setTimeout(() => renderValidation(validate(textarea.value)), 250);
  }

  textarea.addEventListener("input", () => {
    renderHighlight();
    highlightMatches(currentFindQuery);
    syncScroll();
    scheduleValidation();
    computeAutocomplete();
  });
  textarea.addEventListener("scroll", syncScroll);
  textarea.addEventListener("blur", closeMenu);
  textarea.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((activeIndex + 1) % completions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((activeIndex - 1 + completions.length) % completions.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      applyCompletion(activeIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
    }
  });

  renderHighlight();
  scheduleValidation();

  return {
    textarea,
    getValue: () => textarea.value,
    setValue: (v) => {
      textarea.value = String(v == null ? "" : v);
      renderHighlight();
      highlightMatches(currentFindQuery);
      syncScroll();
      scheduleValidation();
    },
    highlightMatches,
  };
}
