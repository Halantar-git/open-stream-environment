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
  Сетевой сбой fetch не должен реджектить промис: панель ждёт результат
  действия (клип/маркер), а не падение с unhandledRejection.
*/

const EventBus = require("../overlay/event-bus");
const { createTwitchClip, createStreamMarker } = require("../server/integrations/twitch-helix");

function makeState() {
  return {
    config: {
      twitch: {
        channel: "chan",
        clientId: "cid",
        userAccessToken: "tok",
        broadcasterId: "bid",
      },
    },
    saveTwitchTokens: () => {},
  };
}

describe("twitch-helix: сетевой сбой fetch", () => {
  beforeEach(() => {
    global.fetch = jest.fn(() => Promise.reject(new Error("offline")));
  });

  afterEach(() => {
    delete global.fetch;
  });

  test("createTwitchClip возвращает { ok:false, error:'network' }", async () => {
    const bus = new EventBus();

    await expect(createTwitchClip({ bus, state: makeState() })).resolves.toEqual({
      ok: false,
      error: "network",
    });
  });

  test("createStreamMarker возвращает { ok:false, error:'network' }", async () => {
    const bus = new EventBus();

    await expect(createStreamMarker({ bus, state: makeState(), description: "момент" })).resolves.toEqual({
      ok: false,
      error: "network",
    });
  });
});
