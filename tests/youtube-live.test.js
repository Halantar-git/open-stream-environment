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
  Разбор причины отказа liveChatMessages.

  Раньше любой 403 считался превышением квоты, поэтому после конца эфира
  интеграция бесконечно опрашивала мёртвый чат и не подхватывала новый стрим:
  сброс liveChatId был только в ветке 404.
*/

const { classifyLiveChatFailure } = require("../server/integrations/youtube-live");

function errorBody(reason) {
  return JSON.stringify({
    error: {
      code: 403,
      message: "The caller does not have permission",
      errors: [{ domain: "youtube.liveChat", reason, message: "…" }],
    },
  });
}

describe("classifyLiveChatFailure", () => {
  test("конец эфира — чат мёртв", () => {
    expect(classifyLiveChatFailure(errorBody("liveChatEnded"))).toBe("ended");
  });

  test("чат выключен или не найден — тоже мёртв", () => {
    expect(classifyLiveChatFailure(errorBody("liveChatDisabled"))).toBe("ended");
    expect(classifyLiveChatFailure(errorBody("liveChatNotFound"))).toBe("ended");
  });

  test("offlineAt в теле — эфир завершился", () => {
    expect(classifyLiveChatFailure(JSON.stringify({ offlineAt: "2026-01-01T00:00:00Z" }))).toBe("ended");
  });

  test("квота, лимит запросов и запрет доступа — ждём и повторяем", () => {
    expect(classifyLiveChatFailure(errorBody("rateLimitExceeded"))).toBe("backoff");
    expect(classifyLiveChatFailure(errorBody("quotaExceeded"))).toBe("backoff");
    expect(classifyLiveChatFailure(errorBody("forbidden"))).toBe("backoff");
  });

  test("не-JSON тело распознаётся по сырому тексту", () => {
    expect(classifyLiveChatFailure("<html>liveChatDisabled</html>")).toBe("ended");
    expect(classifyLiveChatFailure("<html>Bad Request</html>")).toBe("backoff");
  });

  test("пустое тело — безопасный бэкофф, а не сброс чата", () => {
    expect(classifyLiveChatFailure("")).toBe("backoff");
    expect(classifyLiveChatFailure(null)).toBe("backoff");
    expect(classifyLiveChatFailure(undefined)).toBe("backoff");
  });
});
