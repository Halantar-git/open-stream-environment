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

const {
  createModerationEngine,
  createMemoryStore,
  deleetize,
  countEmotes,
  capsRatio,
  findDisallowedLink,
  findBadWord,
} = require("../server/integrations/chat-moderation");

describe("chat-moderation helpers", () => {
  test("deleetize заменяет латинские дубликаты на кириллицу", () => {
    expect(deleetize("дypaк")).toBe("дурак");
    expect(deleetize("6лять")).toBe("блять");
    expect(deleetize("3абанен")).toBe("забанен");
  });

  test("countEmotes считает объект и сырой IRC-формат", () => {
    expect(countEmotes({ "25": ["0-1", "2-3", "4-5"], "1902": ["6-7"] })).toBe(4);
    expect(countEmotes("25:0-4,6-10/1902:12-16")).toBe(3);
    expect(countEmotes(null)).toBe(0);
  });

  test("capsRatio считает долю заглавных букв", () => {
    expect(capsRatio("ПРИВЕТ ВСЕМ")).toBe(1);
    expect(capsRatio("Привет всем")).toBeCloseTo(0.1, 3);
    expect(capsRatio("...")).toBe(0);
  });

  test("findDisallowedLink учитывает whitelist и поддомены", () => {
    const whitelist = ["youtube.com", "twitch.tv"];
    expect(findDisallowedLink("go to evil.com", whitelist)).toBe("evil.com");
    expect(findDisallowedLink("watch https://youtube.com/watch?v=x", whitelist)).toBeNull();
    expect(findDisallowedLink("clip: clips.twitch.tv/abc", whitelist)).toBeNull();
  });

  test("findBadWord ловит слово с делейтизацией и разбивкой", () => {
    expect(findBadWord("ты дypaк", ["дурак"])).toBe("дурак");
    expect(findBadWord("д у р а к", ["дурак"])).toBe("дурак");
    expect(findBadWord("всё ок", ["дурак"])).toBeNull();
  });
});

describe("createModerationEngine", () => {
  test("ссылка даёт первый варн с 1-секундным таймаутом", () => {
    const engine = createModerationEngine({ enabled: true, linkProtection: true, whitelistDomains: ["twitch.tv"] });
    const v = engine.check({ user: "u", userId: "1", message: "заходи evil.com", level: "everyone" });
    expect(v).toMatchObject({ type: "link", warn: 1, ban: false, timeoutSec: 1 });
    expect(v.message).toContain("1/3");
  });

  test("капс и смайлы детектятся", () => {
    const caps = createModerationEngine({ enabled: true, linkProtection: false, capsThreshold: 0.7, maxEmotes: 0 });
    expect(caps.check({ user: "u", userId: "2", message: "ПРИВЕТ ВСЕМ КАК ДЕЛА", level: "everyone" })).toMatchObject({ type: "caps" });

    const emotes = createModerationEngine({ enabled: true, linkProtection: false, capsThreshold: 1, maxEmotes: 2 });
    expect(emotes.check({ user: "u", userId: "3", message: "hi", emotes: { "25": ["0-1", "2-3", "4-5"] }, level: "everyone" })).toMatchObject({ type: "emotes" });
  });

  test("чёрный список срабатывает по делейтизации", () => {
    const engine = createModerationEngine({ enabled: true, linkProtection: false, badWords: ["дурак"], maxEmotes: 0 });
    expect(engine.check({ user: "u", userId: "4", message: "ты дypaк", level: "everyone" })).toMatchObject({ type: "badword" });
  });

  test("модератор и стример неуязвимы для фильтров", () => {
    const engine = createModerationEngine({ enabled: true, linkProtection: false, badWords: ["дурак"], maxEmotes: 0 });
    expect(engine.check({ user: "mod", userId: "5", message: "ты дурак", level: "moderator" })).toBeNull();
    expect(engine.check({ user: "owner", userId: "6", message: "evil.com", level: "broadcaster" })).toBeNull();
  });

  test("система варнов: 1 → таймаут → бан", () => {
    const engine = createModerationEngine({
      enabled: true,
      linkProtection: false,
      badWords: ["дурак"],
      maxEmotes: 0,
      maxWarns: 3,
      warnTimeoutSec: 600,
    });
    const u = { user: "u", userId: "9", level: "everyone" };
    expect(engine.check({ ...u, message: "ты дурак" })).toMatchObject({ warn: 1, ban: false, timeoutSec: 1 });
    expect(engine.check({ ...u, message: "ты дурак" })).toMatchObject({ warn: 2, ban: false, timeoutSec: 600 });
    expect(engine.check({ ...u, message: "ты дурак" })).toMatchObject({ warn: 3, ban: true, timeoutSec: null });
  });

  test("выключенная модерация ничего не делает", () => {
    const engine = createModerationEngine({ enabled: false, linkProtection: true });
    expect(engine.check({ user: "u", userId: "7", message: "evil.com", level: "everyone" })).toBeNull();
  });

  test("варны сохраняются в общем сторе между движками", () => {
    const store = createMemoryStore();
    const make = () =>
      createModerationEngine({ enabled: true, linkProtection: false, badWords: ["дурак"], maxEmotes: 0, maxWarns: 3 }, store);
    const u = { user: "u", userId: "10", level: "everyone" };
    expect(make().check({ ...u, message: "ты дурак" })).toMatchObject({ warn: 1 });
    expect(make().check({ ...u, message: "ты дурак" })).toMatchObject({ warn: 2 });
    expect(make().check({ ...u, message: "ты дурак" })).toMatchObject({ warn: 3, ban: true });
  });
});
