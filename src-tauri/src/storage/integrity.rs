//! Целостность файлов состояния: карантин битого файла и восстановление из копий.
//!
//! Порт `server/data-integrity.js`. `config.json` и `local-db.json` — единственное
//! место, где живут настройки пользователя, и порча файла раньше означала одно из
//! двух: приложение не стартует вовсе или молча затирает повреждённый файл
//! значениями по умолчанию, теряя данные. Теперь ни то, ни другое:
//!
//! - битый файл не удаляется и не затирается, а переносится в карантин
//!   (`<файл>.corrupt-<метка>`) — его можно изучить и спасти руками;
//! - значение поднимается из последней удачной копии (`.bak.0`, затем `.bak.1`, …);
//! - если поднимать нечего, значение остаётся пустым, а вызывающий берёт шаблон
//!   поставки;
//! - каждый случай порчи уходит строкой в `logs/recovery-<дата>.log`, а событие
//!   возвращается вызывающему — по нему главное окно показывает диалог. Иначе
//!   «настройки слетели» выглядит загадкой без следов.
//!
//! Отличие от Electron-версии: список событий не хранится глобально. Событие
//! возвращается тем же вызовом, а собирает их вызывающий — так функция остаётся
//! чистой и проверяемой без общего состояния.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{Local, SecondsFormat, Utc};
use serde_json::Value;

use super::atomic::{self, DEFAULT_BACKUP_SLOTS};

/// Что вышло при чтении файла JSON.
#[derive(Debug, Clone, PartialEq)]
pub enum JsonRead {
    /// Прочитан объект.
    Value(Value),
    /// Файла нет — это не порча, а первый запуск.
    Missing,
    /// Файл есть, но нечитаем: нет прав, пуст, не разобрался или это не объект.
    Invalid(String),
}

/// Откуда взялось состояние.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoverySource {
    /// Файл прочитан как есть.
    File,
    /// Файла ещё нет.
    Missing,
    /// Файл был испорчен, значение поднято из копии.
    Backup,
    /// Файл испорчен, и поднимать нечего.
    Unrecoverable,
}

/// Вид события восстановления — от него зависит формулировка.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryKind {
    RestoredFromBackup,
    Unrecoverable,
}

/// Случай порчи файла — то, что показывают пользователю.
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryEvent {
    /// Когда случилось (миллисекунды от начала эпохи).
    pub at_ms: u64,
    pub kind: RecoveryKind,
    pub file: PathBuf,
    /// Понятное имя файла для сообщения («config.json», «база»).
    pub label: String,
    /// Почему файл признан испорченным.
    pub reason: String,
    pub quarantine_path: Option<PathBuf>,
    pub backup_path: Option<PathBuf>,
}

/// Результат чтения с восстановлением.
#[derive(Debug, Clone, PartialEq)]
pub struct Recovered {
    pub source: RecoverySource,
    pub value: Option<Value>,
    pub quarantine_path: Option<PathBuf>,
    pub backup_path: Option<PathBuf>,
    /// Заполнено, только если файл был испорчен.
    pub event: Option<RecoveryEvent>,
}

/// Как выглядит слот резервной копии — для списка «Резервные копии» в настройках.
#[derive(Debug, Clone, PartialEq)]
pub struct BackupSlot {
    pub slot: usize,
    pub file: PathBuf,
    pub name: String,
    pub bytes: u64,
    pub mtime_ms: u64,
    /// Годится ли слот для восстановления.
    pub valid: bool,
    pub error: Option<String>,
}

/// Метка времени для имени карантинного файла: «20260915-143012».
///
/// Местное время — как в Electron-версии: пользователь сопоставляет метку с тем,
/// когда это случилось у него, а не в UTC.
pub fn timestamp_tag() -> String {
    Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// Дата для имени суточного журнала: «2026-09-15».
pub fn day_stamp() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Перенести испорченный файл в карантин рядом с оригиналом.
///
/// Возвращает путь карантина; `None` — перенести не удалось (нет прав, файл
/// занят), и тогда вызывающий продолжает работать, ничего не удаляя.
///
/// Отличие от Electron-версии: если файл с такой меткой уже есть, имя получает
/// числовой хвост. В JS повторное перенаправление в ту же секунду **затирало**
/// предыдущий карантин (`rename` на Windows заменяет файл) — то есть теряло
/// именно ту улику, ради которой карантин и заведён.
pub fn quarantine_file(file: &Path, tag: &str) -> Option<PathBuf> {
    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    for attempt in 0..1000 {
        let candidate = if attempt == 0 {
            file.with_file_name(format!("{name}.corrupt-{tag}"))
        } else {
            file.with_file_name(format!("{name}.corrupt-{tag}-{attempt}"))
        };
        if candidate.exists() {
            continue;
        }
        if fs::rename(file, &candidate).is_ok() {
            return Some(candidate);
        }
        return None;
    }

    None
}

/// Прочитать объект из файла, различая «файла нет» и «файл есть, но нечитаем».
pub fn try_read_json(file: &Path) -> JsonRead {
    let raw = match fs::read_to_string(file) {
        Ok(raw) => raw,
        Err(error) => {
            return if error.kind() == io::ErrorKind::NotFound {
                JsonRead::Missing
            } else {
                JsonRead::Invalid(error.to_string())
            };
        }
    };

    if raw.trim().is_empty() {
        return JsonRead::Invalid("файл пуст".to_string());
    }

    match serde_json::from_str::<Value>(&raw) {
        Ok(value) if value.is_object() => JsonRead::Value(value),
        Ok(_) => JsonRead::Invalid("ожидался JSON-объект".to_string()),
        Err(error) => JsonRead::Invalid(error.to_string()),
    }
}

/// Дописать строку в суточный журнал восстановлений.
///
/// Best-effort: журнал не должен мешать самому восстановлению, поэтому ошибки
/// записи здесь не возвращаются наружу.
pub fn append_to_recovery_log(logs_dir: &Path, text: &str) {
    let stamp = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let _ = fs::create_dir_all(logs_dir);
    let file = logs_dir.join(format!("recovery-{}.log", day_stamp()));
    let line = format!("[{stamp}] {text}\n");
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .and_then(|mut handle| {
            use std::io::Write;
            handle.write_all(line.as_bytes())
        });
}

/// Строка для журнала и для диалога: что случилось и к чему пришли.
pub fn describe_event(event: &RecoveryEvent) -> String {
    let file = base_name(&event.file);
    let quarantine = event
        .quarantine_path
        .as_deref()
        .map(base_name)
        .unwrap_or_else(|| "—".to_string());

    match event.kind {
        RecoveryKind::RestoredFromBackup => {
            let backup = event
                .backup_path
                .as_deref()
                .map(base_name)
                .unwrap_or_else(|| "—".to_string());
            format!(
                "{file}: файл повреждён ({}) и перенесён в карантин ({quarantine}), данные \
                 восстановлены из бэкапа {backup}",
                event.reason
            )
        }
        RecoveryKind::Unrecoverable => format!(
            "{file}: файл повреждён ({}) и перенесён в карантин ({quarantine}); пригодного \
             бэкапа не нашлось — работа начата со значениями по умолчанию",
            event.reason
        ),
    }
}

/// Читает файл состояния, переживая порчу содержимого.
///
/// Что делать с пустым значением (`RecoverySource::Missing` и
/// `Unrecoverable`) — решает вызывающий: обычно берёт шаблон поставки и
/// дополняет умолчаниями.
pub fn recover_json_file(
    file: &Path,
    label: &str,
    backup_slots: usize,
    logs_dir: &Path,
) -> Recovered {
    match try_read_json(file) {
        JsonRead::Value(value) => Recovered {
            source: RecoverySource::File,
            value: Some(value),
            quarantine_path: None,
            backup_path: None,
            event: None,
        },
        JsonRead::Missing => Recovered {
            source: RecoverySource::Missing,
            value: None,
            quarantine_path: None,
            backup_path: None,
            event: None,
        },
        JsonRead::Invalid(reason) => {
            let quarantine_path = quarantine_file(file, &timestamp_tag());

            for slot in 0..backup_slots {
                let candidate = atomic::backup_path(file, slot);
                if let JsonRead::Value(value) = try_read_json(&candidate) {
                    let event = recovery_event(
                        RecoveryKind::RestoredFromBackup,
                        file,
                        label,
                        reason,
                        quarantine_path.clone(),
                        Some(candidate.clone()),
                    );
                    append_to_recovery_log(logs_dir, &describe_event(&event));
                    return Recovered {
                        source: RecoverySource::Backup,
                        value: Some(value),
                        quarantine_path,
                        backup_path: Some(candidate),
                        event: Some(event),
                    };
                }
            }

            let event = recovery_event(
                RecoveryKind::Unrecoverable,
                file,
                label,
                reason,
                quarantine_path.clone(),
                None,
            );
            append_to_recovery_log(logs_dir, &describe_event(&event));
            Recovered {
                source: RecoverySource::Unrecoverable,
                value: None,
                quarantine_path,
                backup_path: None,
                event: Some(event),
            }
        }
    }
}

/// Описание слотов резервных копий: что лежит в каждом и годится ли он.
///
/// Нужно для списка «Резервные копии» в настройках: пользователь видит, к чему
/// может откатиться, ещё до нажатия кнопки, а битый слот не предлагается.
pub fn describe_backups(file: &Path, slots: usize) -> Vec<BackupSlot> {
    let mut out = Vec::new();

    for slot in 0..slots {
        let path = atomic::backup_path(file, slot);
        let Ok(metadata) = fs::metadata(&path) else {
            continue; // слота нет — он ещё не создан
        };

        let attempt = try_read_json(&path);
        let valid = matches!(attempt, JsonRead::Value(_));
        out.push(BackupSlot {
            slot,
            name: base_name(&path),
            file: path,
            bytes: metadata.len(),
            mtime_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|since| since.as_millis() as u64)
                .unwrap_or(0),
            valid,
            error: match attempt {
                JsonRead::Invalid(reason) => Some(reason),
                _ => None,
            },
        });
    }

    out
}

/// Сколько копий смотреть по умолчанию.
pub fn default_backup_slots() -> usize {
    DEFAULT_BACKUP_SLOTS
}

fn recovery_event(
    kind: RecoveryKind,
    file: &Path,
    label: &str,
    reason: String,
    quarantine_path: Option<PathBuf>,
    backup_path: Option<PathBuf>,
) -> RecoveryEvent {
    let at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0);
    RecoveryEvent {
        at_ms,
        kind,
        file: file.to_path_buf(),
        label: label.to_string(),
        reason,
        quarantine_path,
        backup_path,
    }
}

fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("ose-recovery-{}-{label}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            Self(dir)
        }

        fn file(&self) -> PathBuf {
            self.0.join("config.json")
        }

        fn logs(&self) -> PathBuf {
            self.0.join("logs")
        }

        fn recovery_log(&self) -> String {
            let dir = self.logs();
            let entry = fs::read_dir(&dir)
                .expect("каталог журналов должен быть")
                .flatten()
                .find(|entry| entry.file_name().to_string_lossy().starts_with("recovery-"))
                .expect("журнал восстановлений должен появиться");
            fs::read_to_string(entry.path()).expect("журнал должен читаться")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    fn recover(dir: &TempDir) -> Recovered {
        recover_json_file(&dir.file(), "config.json", 3, &dir.logs())
    }

    #[test]
    fn missing_file_is_not_damage() {
        let dir = TempDir::new("missing");
        let result = recover(&dir);

        assert_eq!(result.source, RecoverySource::Missing);
        assert!(result.value.is_none());
        assert!(result.event.is_none(), "первый запуск — не случай порчи");
        assert!(!dir.logs().exists(), "писать в журнал нечего");
    }

    #[test]
    fn valid_file_is_read_as_is() {
        let dir = TempDir::new("valid");
        fs::write(dir.file(), r#"{"port":8710,"twitch":{"channel":"me"}}"#).unwrap();

        let result = recover(&dir);
        assert_eq!(result.source, RecoverySource::File);
        assert_eq!(
            result.value,
            Some(json!({"port": 8710, "twitch": {"channel": "me"}}))
        );
        assert!(result.event.is_none());
    }

    #[test]
    fn damaged_file_is_quarantined_and_raised_from_backup() {
        let dir = TempDir::new("backup");
        let file = dir.file();
        let backup = atomic::backup_path(&file, 0);

        fs::write(&file, "{ это не json").unwrap();
        fs::write(&backup, r#"{"restored":true}"#).unwrap();

        let result = recover(&dir);

        assert_eq!(result.source, RecoverySource::Backup);
        assert_eq!(result.value, Some(json!({"restored": true})));
        assert_eq!(result.backup_path.as_deref(), Some(backup.as_path()));

        // Испорченный файл сохранён, а рабочий путь свободен для новой записи.
        let quarantine = result.quarantine_path.expect("карантин должен быть");
        assert!(quarantine.exists());
        assert!(fs::read_to_string(&quarantine)
            .unwrap()
            .contains("это не json"));
        assert!(!file.exists());

        let event = result.event.expect("событие должно быть");
        assert_eq!(event.kind, RecoveryKind::RestoredFromBackup);
        assert_eq!(event.label, "config.json");
        assert!(dir.recovery_log().contains("восстановлены из бэкапа"));
    }

    #[test]
    fn damaged_file_without_backup_is_unrecoverable() {
        let dir = TempDir::new("unrecoverable");
        fs::write(dir.file(), "").unwrap();

        let result = recover(&dir);

        assert_eq!(result.source, RecoverySource::Unrecoverable);
        assert!(result.value.is_none());
        assert!(result
            .quarantine_path
            .expect("карантин должен быть")
            .exists());

        let event = result.event.expect("событие должно быть");
        assert_eq!(event.kind, RecoveryKind::Unrecoverable);
        assert_eq!(event.reason, "файл пуст");
        assert!(dir.recovery_log().contains("пригодного бэкапа не нашлось"));
    }

    #[test]
    fn corrupt_backup_is_skipped_for_the_next_slot() {
        let dir = TempDir::new("slots");
        let file = dir.file();
        fs::write(&file, "мусор").unwrap();
        fs::write(atomic::backup_path(&file, 0), "тоже мусор").unwrap();
        fs::write(atomic::backup_path(&file, 1), r#"{"slot":1}"#).unwrap();

        let result = recover(&dir);
        assert_eq!(result.source, RecoverySource::Backup);
        assert_eq!(result.value, Some(json!({"slot": 1})));
        assert_eq!(
            result.backup_path.as_deref(),
            Some(atomic::backup_path(&file, 1).as_path())
        );
    }

    #[test]
    fn array_and_scalar_are_not_objects() {
        let dir = TempDir::new("shape");
        for text in ["[]", "42", "null", "\"строка\""] {
            let file = dir.file();
            let _ = fs::remove_file(&file);
            fs::write(&file, text).unwrap();

            let result = recover(&dir);
            assert_eq!(result.source, RecoverySource::Unrecoverable, "вход: {text}");
            assert_eq!(
                result.event.expect("событие").reason,
                "ожидался JSON-объект",
                "вход: {text}"
            );
        }
    }

    #[test]
    fn repeated_quarantine_keeps_both_files() {
        let dir = TempDir::new("repeat");
        let file = dir.file();
        fs::write(&file, "первый").unwrap();
        let first = quarantine_file(&file, "20260915-143012").expect("первый карантин");

        fs::write(&file, "второй").unwrap();
        let second = quarantine_file(&file, "20260915-143012").expect("второй карантин");

        // Обе улики на месте: Electron-версия на этом месте затёрла бы первую.
        assert_ne!(first, second);
        assert_eq!(fs::read_to_string(&first).unwrap(), "первый");
        assert_eq!(fs::read_to_string(&second).unwrap(), "второй");
    }

    #[test]
    fn backups_describe_what_can_be_restored() {
        let dir = TempDir::new("describe");
        let file = dir.file();
        fs::write(atomic::backup_path(&file, 0), r#"{"slot":0}"#).unwrap();
        fs::write(atomic::backup_path(&file, 1), "мусор").unwrap();

        let slots = describe_backups(&file, 3);

        // Третьего слота нет — о нём и говорить нечего.
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].slot, 0);
        assert!(slots[0].valid);
        assert!(slots[0].bytes > 0);
        assert!(slots[0].error.is_none());
        assert_eq!(slots[0].name, "config.json.bak.0");

        assert_eq!(slots[1].slot, 1);
        assert!(!slots[1].valid);
        assert!(slots[1].error.is_some());
    }

    #[test]
    fn event_wording_names_both_files() {
        let event = RecoveryEvent {
            at_ms: 0,
            kind: RecoveryKind::Unrecoverable,
            file: PathBuf::from("C:/data/config.json"),
            label: "config.json".to_string(),
            reason: "не разобрался".to_string(),
            quarantine_path: Some(PathBuf::from("C:/data/config.json.corrupt-20260915-143012")),
            backup_path: None,
        };

        let text = describe_event(&event);
        assert!(text.contains("config.json:"), "{text}");
        assert!(text.contains("corrupt-20260915-143012"), "{text}");
        assert!(
            text.contains("работа начата со значениями по умолчанию"),
            "{text}"
        );
    }
}
