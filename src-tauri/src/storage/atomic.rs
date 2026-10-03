//! Атомарная запись файлов состояния и ротация резервных копий.
//!
//! Порт синхронной части `server/atomic-write.js`. Зачем это вообще нужно:
//! файл настроек переписывается целиком, и обычная запись «поверх» на секунду
//! оставляет на диске обрезанный файл — если в этот момент пропадёт питание или
//! процесс убьют, настройки пропадут. Поэтому пишем во временный файл рядом и
//! переименовываем: переименование в пределах одного каталога атомарно.
//!
//! Резервные копии (`<файл>.bak.0`, `.bak.1`, …) спасают не от сбоя записи, а от
//! порчи уже лежащего файла: правки руками, сбой файловой системы, кривая
//! синхронизация. Слот 0 — самый свежий.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Сколько живёт осиротевший временный файл, прежде чем его можно удалить.
///
/// Живая запись занимает миллисекунды, поэтому минута — безопасный запас: за это
/// время чужой экземпляр приложения точно закончит свою запись.
pub const TEMP_MAX_AGE: Duration = Duration::from_secs(60);

/// Сколько резервных копий держим: цель — спасти настройки, а не вести архив.
pub const DEFAULT_BACKUP_SLOTS: usize = 3;

/// Предел размера файла, который ещё имеет смысл копировать в бэкап.
///
/// Файлы состояния измеряются килобайтами; порог нужен только чтобы случайно
/// разросшаяся база не начала утраивать место бэкапами.
pub const DEFAULT_BACKUP_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// Временный файл, в который пишет атомарная запись (рядом с целевым).
pub fn temp_path(file: &Path) -> PathBuf {
    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    file.with_file_name(format!(".{name}.tmp"))
}

/// Атомарно записать файл: сначала во временный, затем переименовать.
///
/// Каталог должен существовать — как и в JS, где `writeFileSync` не создаёт его.
pub fn write_file_sync(file: &Path, data: &[u8]) -> io::Result<()> {
    let tmp = temp_path(file);
    fs::write(&tmp, data)?;

    match fs::rename(&tmp, file) {
        Ok(()) => Ok(()),
        Err(error) => {
            // Временный файл убираем, но наружу отдаём исходную ошибку: она важнее.
            let _ = fs::remove_file(&tmp);
            Err(error)
        }
    }
}

/// Убрать осиротевшие временные файлы рядом с `file`.
///
/// Такие остаются, если процесс убили ровно между записью и переименованием.
/// Свежие файлы не трогаем: их может писать работающий экземпляр прямо сейчас.
/// Ошибки глушим — уборка не должна мешать основной работе.
///
/// Возвращает число удалённых файлов.
pub fn sweep_stale_temp_files(file: &Path, max_age: Duration) -> usize {
    let Some(dir) = file.parent() else {
        return 0;
    };
    let base = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let prefix = format!(".{base}.");
    let now = SystemTime::now();

    let Ok(entries) = fs::read_dir(dir) else {
        return 0; // каталога может ещё не быть
    };

    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&prefix) || !name.ends_with(".tmp") {
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let fresh = now
            .duration_since(modified)
            .map(|elapsed| elapsed < max_age)
            .unwrap_or(true); // время «из будущего» — считаем файл свежим
        if fresh {
            continue;
        }

        if fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }

    removed
}

/// Путь слота резервной копии: 0 — самый свежий.
pub fn backup_path(file: &Path, index: usize) -> PathBuf {
    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    file.with_file_name(format!("{name}.bak.{index}"))
}

/// Сдвинуть слоты бэкапов и заполнить нулевой.
///
/// `content` — последний заведомо целый снимок (так делает вызывающий); если его
/// нет, копируется файл с диска. Всё best-effort: бэкап не должен мешать основной
/// записи, поэтому ошибки глушатся, а наружу уходит только признак успеха.
///
/// Пустой и слишком большой снимок бэкапить бессмысленно — возвращаем `false`.
pub fn rotate_backups(file: &Path, slots: usize, content: Option<&str>, max_bytes: u64) -> bool {
    if slots == 0 {
        return false;
    }

    if let Some(content) = content {
        if content.trim().is_empty() {
            return false;
        }
        if max_bytes > 0 && content.len() as u64 > max_bytes {
            return false;
        }
    } else if max_bytes > 0 {
        match fs::metadata(file) {
            Ok(metadata) if metadata.len() <= max_bytes => {}
            Ok(_) => return false,
            Err(_) => return false, // копировать нечего
        }
    }

    // Самый старый слот больше не нужен, дальше «переливаем» бэкапы назад.
    let _ = fs::remove_file(backup_path(file, slots - 1));
    for index in (0..slots.saturating_sub(1)).rev() {
        let _ = fs::rename(backup_path(file, index), backup_path(file, index + 1));
    }

    let target = backup_path(file, 0);
    let written = match content {
        Some(content) => write_file_sync(&target, content.as_bytes()).is_ok(),
        None => fs::copy(file, &target).is_ok(),
    };

    written
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Временный каталог под один тест; имя — по имени теста, чтобы не пересекались.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("ose-atomic-{}-{label}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            Self(dir)
        }

        fn file(&self) -> PathBuf {
            self.0.join("config.json")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn write_replaces_content_and_leaves_no_temp_file() {
        let dir = TempDir::new("write");
        let file = dir.file();

        write_file_sync(&file, b"first").expect("первая запись");
        write_file_sync(&file, b"second").expect("вторая запись");

        assert_eq!(fs::read(&file).unwrap(), b"second");
        assert!(
            !temp_path(&file).exists(),
            "временный файл должен исчезнуть"
        );
    }

    #[test]
    fn write_creates_the_fixed_temp_name_next_to_the_file() {
        let file = PathBuf::from("C:/app/config/config.json");
        assert_eq!(
            temp_path(&file),
            PathBuf::from("C:/app/config/.config.json.tmp")
        );
    }

    #[test]
    fn sweep_removes_only_stale_temps_of_this_file() {
        let dir = TempDir::new("sweep");
        let file = dir.file();

        // Имя как у асинхронного стора: .<файл>.<pid>.<счётчик>.tmp
        let stale = dir.0.join(".config.json.1234.7.tmp");
        fs::write(&stale, b"x").unwrap();
        let other = dir.0.join("local-db.json.1234.7.tmp");
        fs::write(&other, b"x").unwrap();
        let keeper = dir.0.join("config.json");
        fs::write(&keeper, b"{}").unwrap();

        // Свежие файлы не трогаем: минута запаса.
        assert_eq!(sweep_stale_temp_files(&file, Duration::from_secs(60)), 0);
        assert!(stale.exists(), "свежий временный файл трогать нельзя");

        // Нулевой возраст — «уже старый»: так проверяем и отбор по времени.
        assert_eq!(sweep_stale_temp_files(&file, Duration::ZERO), 1);
        assert!(!stale.exists());
        assert!(other.exists(), "чужой файл не наша забота");
        assert!(keeper.exists(), "сам файл настроек тем более");
    }

    #[test]
    fn sweep_survives_missing_directory() {
        let file = PathBuf::from("C:/app/config/config.json");
        assert_eq!(sweep_stale_temp_files(&file, Duration::ZERO), 0);
    }

    #[test]
    fn backup_slots_are_numbered() {
        let file = PathBuf::from("C:/app/config/config.json");
        assert_eq!(
            backup_path(&file, 0),
            PathBuf::from("C:/app/config/config.json.bak.0")
        );
        assert_eq!(
            backup_path(&file, 2),
            PathBuf::from("C:/app/config/config.json.bak.2")
        );
    }

    #[test]
    fn rotate_shifts_slots_and_fills_the_freshest() {
        let dir = TempDir::new("rotate");
        let file = dir.file();
        fs::write(&file, b"on disk").unwrap();

        assert!(rotate_backups(&file, 3, Some("first"), 0));
        assert!(rotate_backups(&file, 3, Some("second"), 0));

        let slot = |index: usize| {
            fs::read_to_string(backup_path(&file, index)).expect("слот должен быть на месте")
        };
        assert_eq!(slot(0), "second");
        assert_eq!(slot(1), "first");
        // Третий слот ещё пуст: было только две записи.
        assert!(!backup_path(&file, 2).exists());
    }

    #[test]
    fn rotate_drops_the_oldest_slot() {
        let dir = TempDir::new("rotate-drop");
        let file = dir.file();
        fs::write(&file, b"on disk").unwrap();

        for text in ["first", "second", "third", "fourth"] {
            assert!(rotate_backups(&file, 3, Some(text), 0), "{text}");
        }

        let slot = |index: usize| {
            fs::read_to_string(backup_path(&file, index)).expect("слот должен быть на месте")
        };
        assert_eq!(slot(0), "fourth");
        assert_eq!(slot(1), "third");
        assert_eq!(slot(2), "second");
        // «first» вытеснен — слотов ровно три.
        assert_eq!(
            slot(0).len() + slot(1).len() + slot(2).len(),
            "fourththirdsecond".len()
        );
    }

    #[test]
    fn rotate_copies_the_file_when_no_content_is_given() {
        let dir = TempDir::new("rotate-copy");
        let file = dir.file();
        fs::write(&file, b"on disk").unwrap();

        assert!(rotate_backups(&file, 3, None, 0));
        assert_eq!(
            fs::read_to_string(backup_path(&file, 0)).unwrap(),
            "on disk"
        );
    }

    #[test]
    fn rotate_refuses_empty_missing_and_oversized() {
        let dir = TempDir::new("rotate-refuse");
        let file = dir.file();

        assert!(!rotate_backups(&file, 3, Some("   \n"), 0), "пустой снимок");
        assert!(!rotate_backups(&file, 0, Some("data"), 0), "слотов нет");
        assert!(!rotate_backups(&file, 3, None, 0), "копировать нечего");
        assert!(
            !rotate_backups(&file, 3, Some("12345"), 4),
            "снимок больше предела"
        );
        assert!(
            !backup_path(&file, 0).exists(),
            "ничего записано не должно быть"
        );
    }
}
