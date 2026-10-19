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

const { mediaKind } = require("../shared/scene-background");

describe("scene background media kind", () => {
  test("recognizes video extensions in any case", () => {
    expect(mediaKind("media/intro.mp4")).toBe("video");
    expect(mediaKind("media/loop.WEBM")).toBe("video");
    expect(mediaKind("media/clip.mov")).toBe("video");
  });

  test("recognizes images and GIF", () => {
    expect(mediaKind("media/bg.png")).toBe("image");
    expect(mediaKind("media/bg.JPG")).toBe("image");
    expect(mediaKind("media/bg.webp")).toBe("image");
    expect(mediaKind("media/loop.gif")).toBe("image");
    expect(mediaKind("https://example.com/bg.mp4?token=1")).toBe("video");
  });

  test("rejects unknown or empty paths", () => {
    expect(mediaKind("media/audio.mp3")).toBe("");
    expect(mediaKind("")).toBe("");
    expect(mediaKind("https://example.com/bg")).toBe("");
  });
});
