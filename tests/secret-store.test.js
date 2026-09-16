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
  Секрет из конфига: зашифрованное значение — это не секрет, а его зашифрованный
  вид.

  Отсюда рос самый неприятный отказ подключения: если сохранённый Client Secret
  не удалось прочитать, приложение отправляло в DonationAlerts строку «enc:…»
  вместо секрета. Сервис отвечал «{"error":"invalid_client"}», а ключ в настройках
  выглядел заполненным — искать причину было негде. Тесты фиксируют, что наружу
  такая строка не выходит, а причина видна пользователю.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");

const { configureStorage } = require("../server/storage-paths");
const { AppState } = require("../server/state");
const store = require("../server/secret-store");

const ROOT = path.join(__dirname, "..");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ose-secrets-"));
}

function sealed(value) {
  return "enc:" + Buffer.from(String(value), "utf8").toString("base64");
}

/*
  В тестах шифрование недоступно: `require("electron")` вне Electron отдаёт путь
  к исполняемому файлу, а не модуль, поэтому safeStorage нет. Это ровно тот
  случай, в котором раньше наружу уходила строка «enc:…».
*/
describe("secret-store: зашифрованное значение наружу не отдаётся", () => {
  beforeEach(() => store.clearSecretIssues());

  test("вместо зашифрованного значения возвращается пустота", () => {
    expect(store.open(sealed("настоящий секрет"), "DonationAlerts Client Secret")).toBe("");
    // И тот, кто сохраняет секрет, видит: это не пустое поле, а нечитаемое.
    expect(store.isSecretUnreadable("DonationAlerts Client Secret")).toBe(true);
  });

  test("незашифрованные значения проходят как есть", () => {
    expect(store.open("простой-секрет", "X")).toBe("простой-секрет");
    expect(store.open("", "X")).toBe("");
    expect(store.open(undefined, "X")).toBe(undefined);
    expect(store.open(null, "X")).toBe(null);
  });

  test("без доступного шифрования секрет сохраняется как есть и не считается нечитаемым", () => {
    // Режим `npm run server:only`: Electron API нет, это нормальный режим.
    expect(store.seal("простой-секрет", "X")).toBe("простой-секрет");
    expect(store.isSecretUnreadable("X")).toBe(false);
    // Пустые значения не превращаются в шифротекст и не создают проблем.
    expect(store.seal("", "X")).toBe("");
    expect(store.seal(undefined, "X")).toBe(undefined);
  });

  test("зашифрованным считается только значение с префиксом", () => {
    expect(store.isSealed(sealed("x"))).toBe(true);
    expect(store.isSealed("enc")).toBe(false);
    expect(store.isSealed("")).toBe(false);
    expect(store.isSealed(undefined)).toBe(false);
    expect(store.isSealed(null)).toBe(false);
  });

  test("снимок состояния говорит, что сохранённый секрет нечитаем, и не выдаёт секрет", () => {
    const dir = tmpDir();
    configureStorage({ configDir: dir });
    store.clearSecretIssues();

    // Реальная раскладка конфига: с ней снимок состояния собирается как в жизни.
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "config.example.json"), "utf8"));
    config.donationAlerts = {
      ...config.donationAlerts,
      clientId: "da-client-id",
      clientSecret: sealed("da-client-secret"),
    };
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));

    const state = new AppState(null);

    // Ровно то, что уходило в сервис вместо секрета: зашифрованный вид.
    expect(state.config.donationAlerts.clientSecret).toBe("");

    const auth = state.snapshot().donationAlertsAuth;
    expect(auth.hasClientSecret).toBe(false);
    expect(auth.clientSecretUnreadable).toBe(true);
    expect(JSON.stringify(auth)).not.toContain("enc:");
    expect(JSON.stringify(auth)).not.toContain("da-client-secret");
  });
});

/*
  Вторая половина поведения — когда хранилище секретов работает: секрет читается
  обратно, а повторная запись снимает пометку «нечитаем».
*/
describe("secret-store: когда шифрование доступно", () => {
  function loadWith(safeStorage) {
    let mod = null;
    jest.isolateModules(() => {
      jest.doMock("electron", () => ({ safeStorage }));
      mod = require("../server/secret-store");
    });
    return mod;
  }

  const workingStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from("sealed:" + value, "utf8"),
    decryptString: (buffer) => {
      const text = buffer.toString("utf8");
      if (!text.startsWith("sealed:")) throw new Error("чужой ключ");
      return text.slice("sealed:".length);
    },
  };

  test("секрет возвращается в исходном виде, а в конфиге лежит зашифрованным", () => {
    const mod = loadWith(workingStorage);

    const stored = mod.seal("da-client-secret", "DonationAlerts Client Secret");

    expect(stored.startsWith("enc:")).toBe(true);
    expect(stored).not.toContain("da-client-secret");
    expect(mod.open(stored, "DonationAlerts Client Secret")).toBe("da-client-secret");
  });

  test("провал расшифровки отличается от недоступного хранилища", () => {
    const mod = loadWith({ ...workingStorage, decryptString: () => { throw new Error("чужой ключ"); } });

    expect(mod.open(sealed("da-client-secret"), "DonationAlerts Client Secret")).toBe("");
    expect(mod.getSecretIssues()).toEqual([
      { label: "DonationAlerts Client Secret", reason: mod.SECRET_ISSUE.UNREADABLE },
    ]);
  });

  test("повторное сохранение снимает пометку о нечитаемом секрете", () => {
    const mod = loadWith({ ...workingStorage, decryptString: () => { throw new Error("чужой ключ"); } });

    expect(mod.open(sealed("старый"), "DonationAlerts Client Secret")).toBe("");
    expect(mod.isSecretUnreadable("DonationAlerts Client Secret")).toBe(true);

    // Пользователь вставил ключ заново, и он сохранился читаемым.
    mod.seal("новый-секрет", "DonationAlerts Client Secret");

    expect(mod.isSecretUnreadable("DonationAlerts Client Secret")).toBe(false);
    expect(mod.getSecretIssues()).toEqual([]);
  });

  test("список причин отдаётся копией и очищается целиком", () => {
    const mod = loadWith({ ...workingStorage, decryptString: () => { throw new Error("чужой ключ"); } });

    mod.open(sealed("a"), "A");
    mod.open(sealed("b"), "B");

    const issues = mod.getSecretIssues();
    expect(issues).toHaveLength(2);
    // Мутация копии не должна менять состояние стора.
    issues.length = 0;
    expect(mod.getSecretIssues()).toHaveLength(2);

    mod.clearSecretIssues();
    expect(mod.getSecretIssues()).toEqual([]);
    expect(mod.isSecretUnreadable("A")).toBe(false);
  });
});
