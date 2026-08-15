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

const crypto = require("crypto");
const { computeAuth, sha256Base64 } = require("../server/integrations/obs-websocket");

function refSha256Base64(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("base64");
}

describe("obs-websocket v5 auth", () => {
  test("sha256Base64 считает корректный base64 sha256", () => {
    expect(sha256Base64("abc")).toBe(refSha256Base64("abc"));
    expect(sha256Base64("")).toBe(refSha256Base64(""));
  });

  test("computeAuth следует формуле challenge-response v5", () => {
    const password = "secret";
    const salt = "abc123";
    const challenge = "xyz789";

    const secret = refSha256Base64(`${password}${salt}`);
    const expected = refSha256Base64(`${secret}${challenge}`);

    expect(computeAuth(password, challenge, salt)).toBe(expected);
  });
});
