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
  createBotEngine,
  parseModCommand,
  formatUptime,
  userLevel,
  renderTemplate,
  normalizeName,
} = require("../server/integrations/chat-bot");

describe("chat-bot helpers", () => {
  test("normalizeName очищает префикс и регистр", () => {
    expect(normalizeName("!Discord")).toBe("discord");
    expect(normalizeName("ДИСКОРД")).toBe("дискорд");
    expect(normalizeName(".points")).toBe("points");
  });

  test("formatUptime форматирует время", () => {
    expect(formatUptime(60000)).toBe("1м 0с");
    expect(formatUptime(3661000)).toBe("1ч 1м 1с");
    expect(formatUptime(45000)).toBe("45с");
  });

  test("parseModCommand парсит !timeout и !ban", () => {
    expect(parseModCommand("!", "!ban @user")).toEqual({ name: "ban", target: "user", durationRaw: null });
    expect(parseModCommand("!", "!timeout @user 120")).toEqual({ name: "timeout", target: "user", durationRaw: "120" });
    expect(parseModCommand("!", "!hello")).toBeNull();
  });

  test("userLevel определяет уровень по бейджам и каналу", () => {
    expect(userLevel({ user: "HalanTar", badges: [], channel: "halantar" })).toBe("broadcaster");
    expect(userLevel({ user: "mod", badges: ["moderator"], channel: "chan" })).toBe("moderator");
    expect(userLevel({ user: "sub", badges: ["subscriber"], channel: "chan" })).toBe("subscriber");
    expect(userLevel({ user: "vip", badges: ["vip"], channel: "chan" })).toBe("subscriber");
    expect(userLevel({ user: "guest", badges: [], channel: "chan" })).toBe("everyone");
  });

  test("renderTemplate подставляет переменные и $(random ...)", () => {
    const out = renderTemplate("Привет, $(user)! Счёт: $(count). $(args)", {
      user: "Bob",
      channel: "chan",
      args: "привет мир",
      count: 3,
    });
    expect(out).toBe("Привет, Bob! Счёт: 3. привет мир");

    const random = renderTemplate("$(random a|b|c)", {});
    expect(["a", "b", "c"]).toContain(random);
  });
});

describe("createBotEngine commands", () => {
  const commands = [
    { id: "discord", name: "discord", response: "Discord: discord.gg/test", level: "everyone", cooldown: 0, userCooldown: 0 },
    { id: "hello", name: "hello", response: "Привет, $(user)! Счёт: $(count)", level: "everyone", cooldown: 0, userCooldown: 0 },
    { id: "secret", name: "secret", response: "Только для модов", level: "moderator", cooldown: 0, userCooldown: 0 },
    { id: "slow", name: "slow", response: "Не спешу", level: "everyone", cooldown: 30, userCooldown: 0 },
  ];

  test("находит команду и рендерит ответ", () => {
    const engine = createBotEngine({ prefix: "!", channel: "chan", commands });
    const result = engine.handleChat({ user: "viewer", badges: [], message: "!discord" });
    expect(result.reply).toBe("Discord: discord.gg/test");
  });

  test("переменная $(count) растёт при повторных вызовах", () => {
    const engine = createBotEngine({ prefix: "!", channel: "chan", commands });
    expect(engine.handleChat({ user: "a", badges: [], message: "!hello" }).reply).toBe("Привет, a! Счёт: 1");
    expect(engine.handleChat({ user: "a", badges: [], message: "!hello" }).reply).toBe("Привет, a! Счёт: 2");
  });

  test("глобальный кулдаун блокирует повторный вызов", () => {
    let clock = 0;
    const engine = createBotEngine({ prefix: "!", channel: "chan", commands, now: () => clock });
    expect(engine.handleChat({ user: "a", badges: [], message: "!slow" })).not.toBeNull();
    expect(engine.handleChat({ user: "a", badges: [], message: "!slow" })).toBeNull();
    clock = 31 * 1000;
    expect(engine.handleChat({ user: "a", badges: [], message: "!slow" })).not.toBeNull();
  });

  test("уровень прав: модераторская команда недоступна обычному зрителю", () => {
    const engine = createBotEngine({ prefix: "!", channel: "chan", commands });
    expect(engine.handleChat({ user: "guest", badges: [], message: "!secret" })).toBeNull();
    expect(engine.handleChat({ user: "mod", badges: ["moderator"], message: "!secret" }).reply).toBe("Только для модов");
  });

  test("встроенная команда !commands перечисляет встроенные и свои команды", () => {
    const engine = createBotEngine({ prefix: "!", channel: "chan", commands });
    const result = engine.handleChat({ user: "guest", badges: [], message: "!commands" });
    expect(result.reply).toContain("!discord");
    expect(result.reply).toContain("!hello");
    expect(result.reply).toContain("!uptime");
    expect(result.reply).toContain("!8ball");
    expect(result.reply).not.toContain("!secret");
    expect(result.reply).not.toContain("!timeout");
    expect(result.reply).not.toContain("!ban");
  });

  test("!commands для модератора включает !timeout и !ban", () => {
    const engine = createBotEngine({ prefix: "!", channel: "chan", commands });
    const result = engine.handleChat({ user: "mod", badges: ["moderator"], message: "!commands" });
    expect(result.reply).toContain("!timeout");
    expect(result.reply).toContain("!ban");
    expect(result.reply).toContain("!secret");
  });
});

describe("createBotEngine timers", () => {
  const timers = [
    { id: "t1", name: "socials", response: "Наши соцсети: $(count)", interval: 10, minChat: 0 },
    { id: "t2", name: "quiet", response: "Тихо не пишу", interval: 1, minChat: 3 },
  ];

  test("таймер срабатывает после интервала и считает срабатывания", () => {
    let clock = 0;
    const engine = createBotEngine({ prefix: "!", channel: "chan", commands: [], timers, now: () => clock });
    expect(engine.tick()).toEqual([]);
    clock = 10 * 60000;
    expect(engine.tick()).toEqual(["Наши соцсети: 1"]);
    clock = 20 * 60000;
    expect(engine.tick()).toEqual(["Наши соцсети: 2"]);
  });

  test("таймер с minChat ждёт активности в чате", () => {
    let clock = 0;
    const engine = createBotEngine({ prefix: "!", channel: "chan", commands: [], timers, now: () => clock });
    clock = 2 * 60000;
    // Не хватает активности — тихий таймер не срабатывает.
    expect(engine.tick()).toEqual([]);

    // Два сообщения в чат (не команды) увеличивают счётчик активности.
    engine.handleChat({ user: "a", badges: [], message: "привет" });
    engine.handleChat({ user: "b", badges: [], message: "как дела" });
    expect(engine.tick()).toEqual([]);

    engine.handleChat({ user: "c", badges: [], message: "третье сообщение" });
    expect(engine.tick()).toEqual(["Тихо не пишу"]);
  });
});

describe("createBotEngine built-in commands", () => {
  test("!so, !uptime, !8ball и !roll отвечают", () => {
    const engine = createBotEngine({ prefix: "!", channel: "chan", commands: [], now: () => 60000, startedAt: 0 });

    expect(engine.handleChat({ user: "u", badges: [], message: "!so bob" }).reply).toContain("bob");
    expect(engine.handleChat({ user: "u", badges: [], message: "!uptime" }).reply).toBe("Стрим идёт: 1м 0с");

    const ball = engine.handleChat({ user: "u", badges: [], message: "!8ball" }).reply;
    expect(typeof ball).toBe("string");
    expect(ball.length).toBeGreaterThan(0);

    expect(engine.handleChat({ user: "u", badges: [], message: "!roll 6" }).reply).toMatch(/выбросил \d+ \(1–6\)/);
  });
});
