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
  Проверка docs/openapi.json без внешних валидаторов.

  Схема должна оставаться машинночитаемой: JSON парсится, ссылки `$ref`
  разрешаются, у каждой операции есть ответ и уникальный `operationId`, а
  маршруты HTTP-части совпадают с описанными в docs/api.md. Это дешёвые
  проверки, но они ловят опечатки, на которых ломается импорт в Swagger.
*/

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "openapi.json"), "utf8"));

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function operations() {
  const out = [];
  Object.entries(spec.paths || {}).forEach(([route, item]) => {
    METHODS.forEach((method) => {
      if (item[method]) out.push({ route, method: item[method] });
    });
  });
  return out;
}

function refs(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (typeof node.$ref === "string") out.push(node.$ref);
  Object.values(node).forEach((value) => refs(value, out));
  return out;
}

function resolve(ref) {
  return ref
    .replace(/^#\//, "")
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((node, part) => (node == null ? node : node[part]), spec);
}

describe("docs/openapi.json", () => {
  test("это OpenAPI 3.x с версией контракта", () => {
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(spec.servers[0].url).toMatch(/^http:\/\/localhost:\d+$/);
  });

  test("HTTP-маршруты приложения описаны", () => {
    const routes = Object.keys(spec.paths);
    [
      "/healthz",
      "/support-bundle",
      "/api/plugins",
      "/plugins/{id}/{file}",
      "/media/{file}",
      "/oauth/twitch/callback",
      "/oauth/donationalerts/callback",
      "/oauth/youtube/callback",
    ].forEach((route) => expect(routes).toContain(route));
  });

  test("у каждой операции есть ответ и уникальный operationId", () => {
    const ids = new Set();
    operations().forEach(({ route, method }) => {
      expect(method.operationId).toBeTruthy();
      expect(ids.has(method.operationId)).toBe(false);
      ids.add(method.operationId);
      const codes = Object.keys(method.responses || {});
      expect(codes.some((code) => code.startsWith("2"))).toBe(true);
      expect(route).toBeTruthy();
    });
  });

  test("все $ref разрешаются", () => {
    refs(spec).forEach((ref) => {
      expect(ref.startsWith("#/components/")).toBe(true);
      expect(resolve(ref)).toBeTruthy();
    });
  });

  test("реестр пакетов описан обязательными полями", () => {
    const schema = spec.components.schemas.PluginsResponse;
    expect(schema.required).toEqual(["apiVersion", "plugins", "errors"]);
    expect(schema.properties.apiVersion.const).toBe(1);
    const kinds = spec.components.schemas.Plugin.discriminator.mapping;
    expect(kinds).toEqual({
      widget: "#/components/schemas/WidgetPlugin",
      theme: "#/components/schemas/ThemePlugin",
    });
  });
});
