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

// Ответы сторонних API — по одному на каждый запрос, который делает модуль.
const RESPONSES = {
  "https://api.betterttv.net/3/cached/emotes/global": [
    { id: "bttv-global", code: "PogU" },
    { id: "bttv-dup", code: "Dup" },
  ],
  "https://api.betterttv.net/3/cached/users/twitch/42": {
    channelEmotes: [{ id: "bttv-channel", code: "ChannelEmote" }],
    sharedEmotes: [{ id: "bttv-shared", code: "SharedEmote" }],
  },
  "https://api.frankerfacez.com/v1/set/global": {
    default_sets: [1],
    sets: {
      1: { emoticons: [{ name: "FFZGlobal", urls: { "2": "//cdn.frankerfacez.com/global/2" } }] },
    },
  },
  "https://api.frankerfacez.com/v1/room/halantar": {
    sets: {
      2: { emoticons: [{ name: "FFZChannel", urls: { "4": "https://cdn.frankerfacez.com/channel/4" } }] },
    },
  },
  "https://7tv.io/v3/emote-sets/global": {
    emotes: [{ name: "SevenGlobal", data: { host: { url: "//cdn.7tv.app/emote/seven-global" } } }],
  },
  "https://7tv.io/v3/users/twitch/42": {
    emote_set: {
      emotes: [
        { name: "SevenChannel", data: { host: { url: "https://cdn.7tv.app/emote/seven-channel" } } },
        { name: "Dup", data: { host: { url: "https://cdn.7tv.app/emote/seven-dup" } } },
      ],
    },
  },
};

let TwitchEmotes;

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn((url) =>
    Promise.resolve({ ok: true, json: async () => RESPONSES[url] ?? null })
  );
  TwitchEmotes = require("../shared/twitch-emotes");
});

afterEach(() => {
  delete global.fetch;
});

async function configure() {
  await TwitchEmotes.configure({ channel: "halantar", channelId: "42" });
}

describe("TwitchEmotes — сторонние наборы", () => {
  test("подставляет смайлы BetterTTV по имени", async () => {
    await configure();
    const html = TwitchEmotes.renderEmotes("PogU", null);
    expect(html).toContain("https://cdn.betterttv.net/emote/bttv-global/2x");
    expect(html).toContain('class="twitch-emote"');
  });

  test("смайлы FrankerFaceZ получают https и крупный размер", async () => {
    await configure();
    expect(TwitchEmotes.renderEmotes("FFZGlobal", null)).toContain(
      "https://cdn.frankerfacez.com/global/2"
    );
    expect(TwitchEmotes.renderEmotes("FFZChannel", null)).toContain(
      "https://cdn.frankerfacez.com/channel/4"
    );
  });

  test("смайлы 7TV собираются из host.url", async () => {
    await configure();
    expect(TwitchEmotes.renderEmotes("SevenChannel", null)).toContain(
      "https://cdn.7tv.app/emote/seven-channel/2x.webp"
    );
  });

  test("канальный набор перекрывает глобальный", async () => {
    await configure();
    const html = TwitchEmotes.renderEmotes("Dup", null);
    expect(html).toContain("https://cdn.7tv.app/emote/seven-dup/2x.webp");
    expect(html).not.toContain("bttv-dup");
  });

  test("родной смайл Twitch важнее одноимённого стороннего", async () => {
    await configure();
    const html = TwitchEmotes.renderEmotes("PogU", { "25": ["0-3"] });
    expect(html).toContain("static-cdn.jtvnw.net/emoticons/v2/25");
    expect(html).not.toContain("betterttv");
  });

  test("текст между смайлами экранируется", async () => {
    await configure();
    expect(TwitchEmotes.renderEmotes("<b>Привет</b> PogU", null)).toBe(
      '&lt;b&gt;Привет&lt;/b&gt; <img src="https://cdn.betterttv.net/emote/bttv-global/2x" alt="PogU" title="PogU" class="twitch-emote" loading="lazy" />'
    );
  });

  test("повторная настройка того же канала не перезагружает наборы", async () => {
    await configure();
    const calls = global.fetch.mock.calls.length;
    await TwitchEmotes.configure({ channel: "halantar", channelId: "42" });
    expect(calls).toBe(6);
    expect(global.fetch.mock.calls.length).toBe(calls);
  });

  test("смена канала перезагружает наборы", async () => {
    await configure();
    await TwitchEmotes.configure({ channel: "other", channelId: "43" });
    expect(global.fetch.mock.calls.length).toBe(12);
  });

  test("без канала и id грузятся только глобальные наборы", async () => {
    await TwitchEmotes.configure({ channel: "", channelId: "" });
    // Три глобальных набора, канальные запросы не нужны.
    expect(global.fetch.mock.calls.length).toBe(3);
    expect(TwitchEmotes.renderEmotes("PogU", null)).toContain("bttv-global");
  });
});
