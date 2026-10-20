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
  Мелкие защитные помощники панели управления: безопасное значение цвета для
  инлайнового стиля, счётчик поколений захвата микрофона и выбор устройства
  ввода, когда системное умолчание оказалось виртуальным.

  Формат UMD, как у модулей shared/: в браузере файл подключается обычным
  <script> и живёт на window (control.js читает window.ControlGuards), а Jest
  забирает его через require — поэтому у панели есть тесты на чистой логике
  без jsdom (см. tests/control-guards.test.js).
*/
(function (root) {
  "use strict";

  const HEX = /^#[0-9a-f]{3,8}$/i;
  const CSS_VAR = /^var\(--[a-z0-9-]+\)$/i;

  /*
    Цвет из данных (тема могла приехать из чужого JSON-файла) нельзя склеивать в
    разметку: строка вида `#fff"></span><img onerror=…>` вырвалась бы из
    атрибута style. Пропускаем только одиночный цвет — hex или ссылку на токен
    темы, — остальное заменяем безопасным значением по умолчанию.
  */
  function safeCssColor(value, fallback) {
    const fallbackColor = typeof fallback === "string" && fallback ? fallback : "#888";
    const v = typeof value === "string" ? value.trim() : "";
    return HEX.test(v) || CSS_VAR.test(v) ? v : fallbackColor;
  }

  /*
    Счётчик поколений захвата микрофона. Мик-мост асинхронный: getUserMedia
    отвечает не сразу, а за это время мост могли остановить или перезапустить
    (смена устройства, выключение виджета). begin() выдаёт номер текущего
    поколения, invalidate() его увеличивает, isStale() проверяет, что результат
    всё ещё актуален — устаревший поток надо остановить, иначе микрофон остаётся
    захваченным (stop() про него уже не знает).
  */
  function createCaptureGeneration() {
    let current = 0;
    return {
      begin: () => current,
      invalidate: () => {
        current += 1;
        return current;
      },
      isStale: (generation) => generation !== current,
    };
  }

  const api = { safeCssColor, createCaptureGeneration, pickCaptureDevice, isExplicitDevice };

  /*
    Виртуальные входы. Если Windows выбирает такой по умолчанию, настоящий
    микрофон остаётся в списке «лишним», а мост получает тишину: NVIDIA
    Broadcast молчит, пока в него не завернули источник, виртуальные кабели —
    пока в них ничего не играет. Поэтому такой выбор по умолчанию заменяем
    первым физическим устройством.
  */
  const VIRTUAL_INPUT =
    /nvidia broadcast|vb-audio|voicemeeter|virtual (audio|cable|mic)|blackhole|soundflower|stereo mix|steam streaming|obs virtual|droidcam|loopback/i;

  /*
    «default» и «communications» — не конкретные устройства, а псевдонимы
    системного выбора. Сохранённый «default» означает «пусть решает Windows»,
    а не осознанный выбор пользователя: его можно заменить на физический вход.
  */
  function isExplicitDevice(deviceId) {
    const id = typeof deviceId === "string" ? deviceId.trim() : "";
    return !!id && id !== "default" && id !== "communications";
  }

  /*
    Возвращает deviceId физического входа, если системное умолчание
    виртуальное, иначе пустую строку — тогда пусть решает система. Метки
    устройства пусты, пока браузер не получил разрешение: без них выбор не
    делаем, иначе первым в списке окажется тот же виртуальный вход.
  */
  function pickCaptureDevice(devices) {
    const list = Array.isArray(devices) ? devices.filter((d) => d && d.deviceId) : [];
    const systemDefault = list.find((d) => d.deviceId === "default");
    if (!systemDefault || !systemDefault.label) return "";
    if (!VIRTUAL_INPUT.test(systemDefault.label)) return "";
    const physical = list.find(
      (d) =>
        d.deviceId !== "default" &&
        d.deviceId !== "communications" &&
        d.label &&
        !VIRTUAL_INPUT.test(d.label)
    );
    return physical ? physical.deviceId : "";
  }

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ControlGuards = api;
})(typeof window !== "undefined" ? window : globalThis);
