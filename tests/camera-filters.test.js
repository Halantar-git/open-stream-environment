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

const { matchCameraFilter } = require("../server/integrations/twitch-eventsub");

describe("matchCameraFilter (Twitch награды)", () => {
  const FILTERS = [
    { id: "f_bw", twitchRewardTitle: "Эффект: Нуар" },
    { id: "f_blur", twitchRewardTitle: "Эффект: Цензура" },
    { id: "f_empty", twitchRewardTitle: "" },
  ];

  test("находит фильтр по названию без учёта регистра и пробелов", () => {
    expect(matchCameraFilter(FILTERS, "эффект: нуар").id).toBe("f_bw");
    expect(matchCameraFilter(FILTERS, "  Эффект: Цензура ").id).toBe("f_blur");
  });

  test("возвращает null при отсутствии совпадения", () => {
    expect(matchCameraFilter(FILTERS, "Другой эффект")).toBeNull();
  });

  test("возвращает null для пустого названия или пустого списка", () => {
    expect(matchCameraFilter(FILTERS, "")).toBeNull();
    expect(matchCameraFilter([], "Эффект: Нуар")).toBeNull();
    expect(matchCameraFilter(null, "Эффект: Нуар")).toBeNull();
  });
});
