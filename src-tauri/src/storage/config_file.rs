//! Настройки приложения как документ: чтение с восстановлением, правка и запись.
//!
//! Порт `readConfig`/`saveConfig` из `server/state.js`. Главный контракт здесь —
//! **совместимость**: файл читается и пишется как есть, поэтому ключи, которых
//! эта версия не знает (настройки будущих версий, чужие правки руками), остаются
//! на месте. Поэтому документ хранится как `serde_json::Map` с включённым
//! `preserve_order`, а не как структура с полями: структура «съела» бы всё
//! лишнее при первой же записи.
//!
//! Что делает открытие, по порядку (как `readConfig`):
//!
//! 1. файл читается через `integrity::recover_json_file` — порча переживается,
//!    а не роняет запуск;
//! 2. если значение подняли из копии, оно сразу становится рабочим файлом: дальше
//!    приложение живёт обычным порядком и сохраняет поверх валидного файла;
//! 3. если файла нет или восстанавливать нечего — берётся шаблон поставки
//!    (`config.example.json`) и записывается как рабочий файл ровно тем текстом,
//!    каким он лежит в поставке.
//!
//! Секреты (`secret-store`) трогаются на границах: при открытии зашифрованные
//! строки расшифровываются (как `decryptConfig` в JS), при записи — снова
//! шифруются (`encryptConfig`). В памяти значения остаются открытыми: так их
//! видят интеграции, а на диск они уходят в шифрованном виде. Неудачная
//! расшифровка даёт пустую строку и замечание в [`SecretStore`] — панель скажет
//! «введите ключ заново» вместо «не заполнено».

use std::fs;
use std::io;
use std::path::PathBuf;

use serde_json::{Map, Value};

use super::async_store::{AtomicStore, StoreOptions};
use super::atomic;
use super::integrity::{self, RecoveryEvent, RecoverySource};
use super::paths::Storage;
use super::secrets::{self, labels, SecretStore};

/// Документ настроек: значения плюс файл, куда они пишутся.
pub struct ConfigFile {
    path: PathBuf,
    label: String,
    /// Значения в памяти — с **открытыми** секретами (расшифрованы при открытии).
    value: Map<String, Value>,
    store: AtomicStore,
    /// Системное хранилище секретов: им же подписаны замечания о нечитаемых.
    secrets: SecretStore,
    /// Случай порчи при открытии — для диалога; `None`, если всё было цело.
    recovery: Option<RecoveryEvent>,
}

impl ConfigFile {
    /// Открыть (при необходимости — восстановить и развернуть шаблон).
    ///
    /// Ошибку возвращаем только тогда, когда недоступен **шаблон поставки**:
    /// это признак сломанной установки, и молча стартовать с пустыми настройками
    /// было бы хуже. Порча пользовательского файла — не ошибка, а штатный случай.
    pub fn open(storage: &Storage) -> io::Result<Self> {
        let path = storage.config_path();
        let example = storage.example_path();
        let label = "config.json".to_string();

        let recovered = integrity::recover_json_file(
            &path,
            &label,
            integrity::default_backup_slots(),
            &storage.logs_dir(),
        );

        let value = match recovered.source {
            RecoverySource::File => recovered.value.and_then(|value| value.as_object().cloned()),
            RecoverySource::Backup => {
                // Восстановленное сразу делаем рабочим файлом, чтобы дальше всё
                // шло обычным порядком и сохранение легло поверх валидного файла.
                if let Some(value) = &recovered.value {
                    let _ = atomic::write_file_sync(&path, pretty(value).as_bytes());
                }
                recovered.value.and_then(|value| value.as_object().cloned())
            }
            RecoverySource::Missing | RecoverySource::Unrecoverable => {
                // Шаблон пишем ровно тем текстом, каким он лежит в поставке:
                // комментарии и порядок ключей в нём — часть замысла.
                let text = fs::read_to_string(&example)?;
                atomic::write_file_sync(&path, text.as_bytes())?;
                serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|value| value.as_object().cloned())
            }
        };

        // В памяти держим открытые секреты — как `decryptConfig` при чтении.
        let secrets = SecretStore::new();
        let mut value = value.unwrap_or_default();
        open_secrets(&mut value, &secrets);

        Ok(Self {
            store: AtomicStore::open(path.clone(), StoreOptions::default()),
            path,
            label,
            value,
            secrets,
            recovery: recovered.event,
        })
    }

    /// Путь рабочего файла.
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// Понятное имя файла для сообщений.
    pub fn label(&self) -> &str {
        &self.label
    }

    /// Все настройки целиком — включая ключи, которых эта версия не знает.
    pub fn value(&self) -> &Map<String, Value> {
        &self.value
    }

    /// Значение верхнего уровня.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.value.get(key)
    }

    /// Записать значение верхнего уровня (соседние ключи не трогаются).
    pub fn set(&mut self, key: &str, value: Value) {
        self.value.insert(key.to_string(), value);
    }

    /// Убрать ключ верхнего уровня.
    pub fn remove(&mut self, key: &str) {
        self.value.remove(key);
    }

    /// Заменить настройки целиком.
    ///
    /// Нужно только импорту настроек (`replaceConfig` в `state/config.rs`):
    /// он собирает новый документ из известных разделов, как это делает
    /// Electron-версия, и ключи, которых в новом документе нет, осознанно
    /// теряются. Для обычной записи есть [`ConfigFile::set`] — он соседей не
    /// трогает.
    pub fn replace(&mut self, value: Map<String, Value>) {
        self.value = value;
    }

    /// Сохранить: запись уходит в отдельный поток и схлопывается с соседними.
    pub fn save(&self) {
        self.store.write(self.sealed_document());
    }

    /// Сохранить синхронно — для выхода, когда ждать нельзя.
    pub fn save_sync(&self) -> bool {
        self.store.write(self.sealed_document());
        self.store.flush_sync()
    }

    /// Документ для записи: копия с зашифрованными секретами. Открытые значения
    /// в памяти при этом не меняются — шифруется только то, что уйдёт на диск.
    fn sealed_document(&self) -> Value {
        Value::Object(seal_secrets(&self.value, &self.secrets))
    }

    /// Системное хранилище секретов: по нему панель и снимок узнают, какие
    /// сохранённые секреты не удалось прочитать.
    pub fn secrets(&self) -> &SecretStore {
        &self.secrets
    }

    /// Дождаться, пока всё записанное окажется на диске.
    pub fn flush(&self) {
        self.store.flush();
    }

    /// Случай порчи при открытии — для диалога пользователю.
    pub fn recovery_event(&self) -> Option<&RecoveryEvent> {
        self.recovery.as_ref()
    }

    /// Снимок счётчиков записи (для журнала и диагностики).
    pub fn stats(&self) -> super::async_store::StatsSnapshot {
        self.store.stats()
    }
}

/// Снимок в JSON с отступом в два пробела — как `JSON.stringify(value, null, 2)`.
fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string())
}

/// Поля-секреты: раздел, поле и метка — как `encryptConfig`/`decryptConfig`
/// в `state.js`. Список один на чтение и запись, чтобы они не разъехались.
const SECRET_FIELDS: &[(&str, &str, &str)] = &[
    ("twitch", "clientSecret", labels::TWITCH_CLIENT_SECRET),
    ("twitch", "userAccessToken", labels::TWITCH_ACCESS_TOKEN),
    ("twitch", "refreshToken", labels::TWITCH_REFRESH_TOKEN),
    (
        "donationAlerts",
        "clientSecret",
        labels::DONATION_ALERTS_CLIENT_SECRET,
    ),
    (
        "donationAlerts",
        "accessToken",
        labels::DONATION_ALERTS_ACCESS_TOKEN,
    ),
    (
        "donationAlerts",
        "refreshToken",
        labels::DONATION_ALERTS_REFRESH_TOKEN,
    ),
    ("youtube", "clientSecret", labels::YOUTUBE_CLIENT_SECRET),
    ("youtube", "accessToken", labels::YOUTUBE_ACCESS_TOKEN),
    ("youtube", "refreshToken", labels::YOUTUBE_REFRESH_TOKEN),
    ("obs", "password", labels::OBS_PASSWORD),
];

/// Расшифровать секреты на месте — как `decryptConfig`. Открытый текст и
/// зашифрованный вид, который прочитать не удалось, — уже результат работы
/// [`SecretStore::open`].
///
/// Публичная, потому что тем же путём идёт откат настроек к бэкапу: в копии
/// секреты лежат зашифрованными, и без расшифровки на следующей записи они
/// зашифровались бы второй раз (как `restoreConfigFromBackup` в JS).
pub fn open_secrets(value: &mut Map<String, Value>, secrets: &SecretStore) {
    for (section, field, label) in SECRET_FIELDS {
        let Some(object) = value.get_mut(*section).and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(current) = object.get(*field).and_then(Value::as_str) else {
            continue;
        };
        if !secrets::is_sealed(current) {
            continue;
        }
        let opened = secrets.open(current, label);
        object.insert(field.to_string(), Value::from(opened));
    }
}

/// Копия документа с зашифрованными секретами — как `encryptConfig`.
fn seal_secrets(value: &Map<String, Value>, secrets: &SecretStore) -> Map<String, Value> {
    let mut out = value.clone();
    for (section, field, label) in SECRET_FIELDS {
        let Some(object) = out.get_mut(*section).and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(current) = object.get(*field).and_then(Value::as_str) else {
            continue;
        };
        let sealed = secrets.seal(current, label);
        object.insert(field.to_string(), Value::from(sealed));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("ose-config-{}-{label}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            Self(dir)
        }

        fn storage(&self) -> Storage {
            Storage::beside_sources(self.0.clone())
        }

        fn config(&self) -> PathBuf {
            self.0.join("config.json")
        }

        /// Шаблон поставки — как в репозитории.
        fn write_example(&self) -> String {
            let text = "{\n  \"port\": 8710,\n  \"twitch\": {\n    \"channel\": \"\"\n  },\n  \"unknown_from_template\": true\n}\n";
            fs::write(self.0.join("config.example.json"), text)
                .expect("шаблон должен записываться");
            text.to_string()
        }

        fn read(&self) -> Value {
            serde_json::from_str(&fs::read_to_string(self.config()).expect("файл должен читаться"))
                .expect("должен быть JSON")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn missing_file_is_seeded_from_the_template() {
        let dir = TempDir::new("seed");
        let template = dir.write_example();

        let config = ConfigFile::open(&dir.storage()).expect("открытие");

        assert_eq!(config.get("port"), Some(&json!(8710)));
        // Шаблон записан ровно тем текстом, каким лежит в поставке.
        assert_eq!(fs::read_to_string(dir.config()).unwrap(), template);
        assert!(
            config.recovery_event().is_none(),
            "первый запуск — не порча"
        );
    }

    #[test]
    fn unknown_keys_survive_edits_and_saving() {
        let dir = TempDir::new("unknown");
        dir.write_example();
        fs::write(
            dir.config(),
            r#"{"port":8710,"twitch":{"channel":"me","future":"keep me"},"setting_from_2027":42}"#,
        )
        .unwrap();

        let mut config = ConfigFile::open(&dir.storage()).expect("открытие");
        config.set("port", json!(9000));
        config.save();
        config.flush();

        let saved = dir.read();
        // Правка применилась…
        assert_eq!(saved["port"], json!(9000));
        // …а ключи, которых версия не знает, остались на месте.
        assert_eq!(saved["twitch"]["future"], json!("keep me"));
        assert_eq!(saved["setting_from_2027"], json!(42));
        assert_eq!(saved["twitch"]["channel"], json!("me"));
    }

    #[test]
    fn damaged_file_is_raised_from_backup_and_becomes_the_working_file() {
        let dir = TempDir::new("recover");
        dir.write_example();
        let file = dir.config();
        fs::write(&file, "{ сломано").unwrap();
        fs::write(
            atomic::backup_path(&file, 0),
            r#"{"port":7000,"from_backup":true}"#,
        )
        .unwrap();

        let config = ConfigFile::open(&dir.storage()).expect("открытие");

        assert_eq!(config.get("port"), Some(&json!(7000)));
        let event = config.recovery_event().expect("событие порчи должно быть");
        assert_eq!(event.kind, integrity::RecoveryKind::RestoredFromBackup);

        // Рабочий файл сразу стал валидным: дальше сохранение ляжет поверх него.
        let on_disk = dir.read();
        assert_eq!(on_disk["from_backup"], json!(true));
    }

    #[test]
    fn unrecoverable_file_starts_from_the_template() {
        let dir = TempDir::new("unrecoverable");
        dir.write_example();
        fs::write(dir.config(), "мусор без копий").unwrap();

        let config = ConfigFile::open(&dir.storage()).expect("открытие");

        assert_eq!(config.get("port"), Some(&json!(8710)));
        assert_eq!(
            config.recovery_event().expect("событие").kind,
            integrity::RecoveryKind::Unrecoverable
        );
        // Испорченный файл сохранён в карантине, а не потерян.
        let quarantine = config
            .recovery_event()
            .and_then(|event| event.quarantine_path.clone())
            .expect("карантин");
        assert!(quarantine.exists());
    }

    #[test]
    fn broken_install_without_template_fails_loudly() {
        let dir = TempDir::new("no-template");
        // Шаблона нет и файла нет — это уже не «первый запуск», а сломанная установка.
        let error = ConfigFile::open(&dir.storage())
            .err()
            .expect("без шаблона открытие должно падать");
        assert_eq!(error.kind(), io::ErrorKind::NotFound, "{error}");
    }

    #[test]
    fn save_sync_writes_without_waiting() {
        let dir = TempDir::new("sync");
        dir.write_example();
        let mut config = ConfigFile::open(&dir.storage()).expect("открытие");

        config.set("port", json!(1234));
        assert!(config.save_sync());
        assert_eq!(dir.read()["port"], json!(1234));
    }

    #[test]
    fn remove_drops_only_the_named_key() {
        let dir = TempDir::new("remove");
        dir.write_example();
        fs::write(dir.config(), r#"{"port":8710,"extra":1}"#).unwrap();

        let mut config = ConfigFile::open(&dir.storage()).expect("открытие");
        config.remove("extra");
        config.save();
        config.flush();

        let saved = dir.read();
        assert_eq!(saved["port"], json!(8710));
        assert!(saved.get("extra").is_none());
    }

    #[test]
    fn secrets_are_sealed_on_disk_and_open_in_memory() {
        let dir = TempDir::new("secrets");
        dir.write_example();
        // Секреты вводят в панели открытым текстом — так они и попадают в файл
        // до первого сохранения.
        fs::write(
            dir.config(),
            r#"{"port":8710,"twitch":{"clientSecret":"живой"},"obs":{"password":"пароль"}}"#,
        )
        .unwrap();

        let mut config = ConfigFile::open(&dir.storage()).expect("открытие");
        // В памяти значение остаётся открытым.
        assert_eq!(
            config.get("twitch").unwrap()["clientSecret"],
            json!("живой")
        );

        config.set("port", json!(9000));
        config.save();
        config.flush();

        let saved = dir.read();
        assert_eq!(saved["port"], json!(9000));
        let secret = saved["twitch"]["clientSecret"].as_str().unwrap();
        if super::secrets::available() {
            assert!(
                super::secrets::is_sealed(secret),
                "значение должно быть зашифровано: {secret}"
            );
            assert!(!secret.contains("живой"));
            assert!(super::secrets::is_sealed(
                saved["obs"]["password"].as_str().unwrap()
            ));
        } else {
            // Хранилища нет — значение остаётся открытым, но не пустым.
            assert_eq!(secret, "живой");
        }
    }

    #[test]
    fn a_sealed_secret_round_trips_back_into_memory() {
        if !super::secrets::available() {
            return;
        }
        let dir = TempDir::new("seal-round-trip");
        dir.write_example();

        let mut config = ConfigFile::open(&dir.storage()).expect("открытие");
        let mut twitch = config
            .get("twitch")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        twitch.insert("clientSecret".to_string(), json!("мой-ключ"));
        config.set("twitch", Value::Object(twitch));
        config.save();
        config.flush();
        drop(config);

        // После перезапуска зашифрованное значение снова читается.
        let reopened = ConfigFile::open(&dir.storage()).expect("повторное открытие");
        assert_eq!(
            reopened.get("twitch").unwrap()["clientSecret"],
            json!("мой-ключ")
        );
        assert!(!reopened
            .secrets()
            .is_unreadable(super::secrets::labels::TWITCH_CLIENT_SECRET));
    }

    #[test]
    fn an_unreadable_secret_becomes_empty_and_is_reported() {
        let dir = TempDir::new("unreadable");
        dir.write_example();
        // "enc:AAAA" — корректный base64, но не блоб DPAPI: расшифровать нечем.
        fs::write(
            dir.config(),
            r#"{"port":8710,"donationAlerts":{"clientSecret":"enc:AAAA"}}"#,
        )
        .unwrap();

        let config = ConfigFile::open(&dir.storage()).expect("открытие");

        // Зашифрованный вид наружу не отдаётся — иначе он ушёл бы в сервис
        // вместо секрета; вместо него пусто и замечание для панели.
        assert_eq!(
            config.get("donationAlerts").unwrap()["clientSecret"],
            json!("")
        );
        assert!(config
            .secrets()
            .is_unreadable(super::secrets::labels::DONATION_ALERTS_CLIENT_SECRET));
    }
}
