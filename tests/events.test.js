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

const { EVENT_TYPES } = require("../shared/events");

describe("shared/events vocabulary", () => {
  test("все типы событий уникальны и являются строками", () => {
    const values = Object.values(EVENT_TYPES);
    expect(new Set(values).size).toBe(values.length);
    values.forEach((v) => expect(typeof v).toBe("string"));
  });

  test("ключевые события последних фич присутствуют", () => {
    expect(EVENT_TYPES.CAMERA_ANGLE_UPDATE).toBe("camera_angle_update");
    expect(EVENT_TYPES.CMD_SET_CAMERA_ANGLE).toBe("cmd_set_camera_angle");
    expect(EVENT_TYPES.SOUNDBOARD_PLAY).toBe("soundboard_play");
    expect(EVENT_TYPES.CMD_SET_SOUNDBOARD_CONFIG).toBe("cmd_set_soundboard_config");
    expect(EVENT_TYPES.CMD_SET_STREAMDECK_CONFIG).toBe("cmd_set_streamdeck_config");
  });
});
