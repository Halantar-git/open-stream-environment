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

const { AppState, fisherYates } = require("../server/state");

function makeConfig() {
  return {
    twitch: {
      channel: "",
      clientId: "",
      clientSecret: "",
      userAccessToken: "",
      refreshToken: "",
      broadcasterId: "",
    },
    donationAlerts: {
      clientId: "",
      clientSecret: "",
      accessToken: "",
      refreshToken: "",
      userId: "",
    },
    goal: { title: "", current: 0, target: 1, currency: "RUB" },
    appearance: { activeThemeId: "nebula", customThemes: [] },
    editor: { gridSize: 5, snapEnabled: true },
    scenes: {},
    topDonation: {},
    layout: [],
  };
}

describe("fisherYates", () => {
  test("возвращает перестановку тех же элементов", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const output = fisherYates([...input]);
    expect(output).toHaveLength(input.length);
    expect([...output].sort((a, b) => a - b)).toEqual([...input].sort((a, b) => a - b));
  });
});

describe("giveaway (Колесо Фортуны)", () => {
  let state;

  beforeEach(() => {
    state = new AppState(null, makeConfig());
  });

  test("фильтрует дубликаты участников через Set", () => {
    state.startGiveaway("!go");
    expect(state.addGiveawayParticipant("alice")).toBeTruthy();
    expect(state.addGiveawayParticipant("alice")).toBeNull();
    expect(state.addGiveawayParticipant("bob")).toBeTruthy();
    expect(state.giveawaySnapshot().count).toBe(2);
  });

  test("перемешивание сохраняет всех участников", () => {
    state.startGiveaway("!go");
    ["a", "b", "c", "d"].forEach((u) => state.addGiveawayParticipant(u));

    const snap = state.shuffleGiveaway();
    expect(snap.count).toBe(4);
    expect(snap.participants.sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("режим на выбывание удаляет победителя из списка", () => {
    state.startGiveaway("!go");
    ["a", "b", "c"].forEach((u) => state.addGiveawayParticipant(u));

    state.setGiveawayEliminationMode(true);
    const snap = state.setGiveawayWinner("b");

    expect(snap.winner).toBe("b");
    expect(snap.participants).not.toContain("b");
    expect(snap.count).toBe(2);
  });
});
