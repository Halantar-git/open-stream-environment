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
  Safe DOM element cache for the control panel.

  `el()` returns `null` instead of throwing when an id is missing, and logs a
  single warning per id, so the rest of the UI keeps running even if a future
  markup change drops or renames an element. Lookups are cached once, because
  the control panel is a long-lived single page.
*/

const cache = new Map();

/** Cached lookup by id. Returns the element or null (never throws). */
export function el(id) {
  if (!cache.has(id)) {
    const node = document.getElementById(id);
    if (!node) {
      console.warn(`[dom] missing element #${id}`);
    }
    cache.set(id, node || null);
  }
  return cache.get(id);
}

/** Query many elements under an optional root. Always returns an array. */
export function all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/** Add an event listener to a cached element. Returns the element or null. */
export function on(id, event, handler) {
  const node = el(id);
  if (node) node.addEventListener(event, handler);
  return node;
}
