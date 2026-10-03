//! Где лежат пользовательские файлы: настройки, база, логи, медиа, состояние окна.
//!
//! Порт `server/storage-paths.js` вместе с решением о каталоге из `main.js`
//! (`resolveConfigDir`): в разработке пишем рядом с исходниками, в собранном
//! приложении — либо в портативный каталог (если его дал упаковщик), либо в
//! системный каталог данных.
//!
//! Разделение важное: **шаблон** `config.example.json` лежит там, куда писать
//! нельзя (в собранном приложении это ресурсы), а **настройки** — там, куда можно.
//! Поэтому у хранилища два корня, а не один.

use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Имя файла настроек.
pub const CONFIG_FILE: &str = "config.json";
/// Имя файла базы (история стрима и чата — рядом, отдельными файлами).
pub const DB_FILE: &str = "local-db.json";
/// Имя шаблона настроек: с него начинается первый запуск.
pub const EXAMPLE_FILE: &str = "config.example.json";
/// Имя файла с положением и размером окон.
pub const WINDOW_STATE_FILE: &str = "window-state.json";

/// Разложенные по местам каталоги приложения.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Storage {
    bundled: PathBuf,
    config: PathBuf,
}

impl Storage {
    /// Хранилище рядом с исходниками — режим разработки и `server:only`.
    pub fn beside_sources(bundled: PathBuf) -> Self {
        Self {
            config: bundled.clone(),
            bundled,
        }
    }

    /// Хранилище с отдельными корнями: шаблон — в одном, запись — в другом.
    pub fn new(bundled: PathBuf, config: PathBuf) -> Self {
        Self { bundled, config }
    }

    /// Каталог, куда пишутся настройки, база, логи и медиа.
    pub fn config_dir(&self) -> &Path {
        &self.config
    }

    /// Каталог с шаблоном настроек (только чтение).
    pub fn bundled_dir(&self) -> &Path {
        &self.bundled
    }

    pub fn config_path(&self) -> PathBuf {
        self.config.join(CONFIG_FILE)
    }

    pub fn db_path(&self) -> PathBuf {
        self.config.join(DB_FILE)
    }

    /// Шаблон настроек — из каталога шаблона, не из каталога записи.
    pub fn example_path(&self) -> PathBuf {
        self.bundled.join(EXAMPLE_FILE)
    }

    /// Каталог пользовательских звуков и картинок для звуковой панели.
    pub fn media_dir(&self) -> PathBuf {
        self.config.join("media")
    }

    /// Каталог файлового журнала (суточная ротация).
    pub fn logs_dir(&self) -> PathBuf {
        self.config.join("logs")
    }

    pub fn window_state_path(&self) -> PathBuf {
        self.config.join(WINDOW_STATE_FILE)
    }

    /// Создать каталог для записи — как `mkdirSync(recursive: true)` в JS.
    pub fn ensure_config_dir(&self) -> io::Result<()> {
        std::fs::create_dir_all(&self.config)
    }
}

/// Каталог для записи.
///
/// - в разработке (`packaged == false`) — рядом с исходниками, как и раньше;
/// - в собранном приложении — портативный каталог, если упаковщик его дал и в
///   него получилось создать каталог (read-only носитель — обычное дело), иначе
///   системный каталог данных.
///
/// Создание каталога здесь не побочный эффект, а часть решения: «можно ли сюда
/// писать» иначе не проверить.
pub fn resolve_config_dir(
    sources: &Path,
    packaged: bool,
    portable_dir: Option<&Path>,
    user_data: &Path,
) -> PathBuf {
    if !packaged {
        return sources.to_path_buf();
    }

    if let Some(dir) = portable_dir {
        if std::fs::create_dir_all(dir).is_ok() {
            return dir.to_path_buf();
        }
    }

    user_data.to_path_buf()
}

/// Положение и размер окна в экранных координатах.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Видно ли окно хотя бы на одном экране — защита от отключённого монитора.
///
/// Порт `isBoundsVisible`: прямоугольники считаются пересекающимися, если
/// пересекаются обе оси; окно нулевого размера не видно.
pub fn is_visible(bounds: Option<Bounds>, work_areas: &[Bounds]) -> bool {
    let Some(bounds) = bounds else {
        return false;
    };
    if bounds.width == 0 || bounds.height == 0 {
        return false;
    }

    work_areas.iter().any(|area| {
        bounds.x < area.x + area.width
            && bounds.x + bounds.width > area.x
            && bounds.y < area.y + area.height
            && bounds.y + bounds.height > area.y
    })
}

/// Размеры окна: сохранённые, если они видны на текущих экранах, иначе умолчания.
///
/// Порт `mergeBounds`: сохранённое положение не должно увести окно за пределы
/// оставшихся экранов, поэтому непроверенное просто отбрасывается целиком.
pub fn merge_bounds(defaults: Bounds, saved: Option<Bounds>, work_areas: &[Bounds]) -> Bounds {
    if is_visible(saved, work_areas) {
        saved.expect("видимые размеры существуют")
    } else {
        defaults
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(x: i32, y: i32, width: i32, height: i32) -> Bounds {
        Bounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn paths_sit_next_to_the_config() {
        let storage = Storage::beside_sources(PathBuf::from("C:/app/config"));

        assert_eq!(
            storage.config_path(),
            PathBuf::from("C:/app/config/config.json")
        );
        assert_eq!(
            storage.db_path(),
            PathBuf::from("C:/app/config/local-db.json")
        );
        // Шаблон — из каталога шаблона, а не из каталога записи.
        assert_eq!(
            storage.example_path(),
            PathBuf::from("C:/app/config/config.example.json")
        );
        assert_eq!(storage.media_dir(), PathBuf::from("C:/app/config/media"));
        assert_eq!(storage.logs_dir(), PathBuf::from("C:/app/config/logs"));
        assert_eq!(
            storage.window_state_path(),
            PathBuf::from("C:/app/config/window-state.json")
        );
    }

    #[test]
    fn separate_roots_keep_template_read_only() {
        let storage = Storage::new(
            PathBuf::from("C:/app/resources"),
            PathBuf::from("C:/users/me/AppData/OSE"),
        );

        assert_eq!(storage.config_dir(), Path::new("C:/users/me/AppData/OSE"));
        assert_eq!(
            storage.example_path(),
            PathBuf::from("C:/app/resources/config.example.json")
        );
    }

    #[test]
    fn development_writes_beside_sources() {
        let dir = std::env::temp_dir().join(format!("ose-dev-{}", std::process::id()));
        let resolved = resolve_config_dir(&dir, false, Some(Path::new("C:/portable")), &dir);

        // В разработке портативный каталог не смотрим вовсе.
        assert_eq!(resolved, dir);
    }

    #[test]
    fn packaged_prefers_portable_directory() {
        let root = std::env::temp_dir().join(format!("ose-portable-{}", std::process::id()));
        let portable = root.join("portable");
        let user_data = root.join("user-data");
        std::fs::create_dir_all(&root).expect("временный каталог должен создаваться");

        let resolved = resolve_config_dir(&root.join("sources"), true, Some(&portable), &user_data);
        assert_eq!(resolved, portable);
        assert!(
            portable.is_dir(),
            "каталог должен быть создан по ходу решения"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn packaged_falls_back_when_portable_is_unwritable() {
        let root = std::env::temp_dir().join(format!("ose-ro-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("временный каталог должен создаваться");

        // Каталог «внутри файла» создать нельзя — так и выглядит read-only носитель.
        let file = root.join("file");
        std::fs::write(&file, b"x").expect("файл должен записываться");
        let portable = file.join("portable");
        let user_data = root.join("user-data");

        let resolved = resolve_config_dir(&root.join("sources"), true, Some(&portable), &user_data);
        assert_eq!(resolved, user_data);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bounds_visibility_matches_overlap() {
        let screen = [bounds(0, 0, 1920, 1080)];

        assert!(is_visible(Some(bounds(100, 100, 800, 600)), &screen));
        // За правым краем — уже не видно.
        assert!(!is_visible(Some(bounds(1920, 0, 800, 600)), &screen));
        // Нулевой размер — не окно.
        assert!(!is_visible(Some(bounds(100, 100, 0, 600)), &screen));
        assert!(!is_visible(None, &screen));
        // Экранов нет — видеть негде.
        assert!(!is_visible(Some(bounds(0, 0, 800, 600)), &[]));
    }

    #[test]
    fn merge_keeps_only_visible_saved_bounds() {
        // Второй монитор отключили: сохранённое окно было на нём.
        let screens = [bounds(0, 0, 1920, 1080)];
        let defaults = bounds(100, 100, 1440, 900);

        let saved_on_missing_screen = bounds(-1500, 200, 800, 600);
        assert_eq!(
            merge_bounds(defaults, Some(saved_on_missing_screen), &screens),
            defaults
        );

        let saved_on_screen = bounds(200, 150, 1024, 768);
        assert_eq!(
            merge_bounds(defaults, Some(saved_on_screen), &screens),
            saved_on_screen
        );

        // Ничего не сохранено — умолчания.
        assert_eq!(merge_bounds(defaults, None, &screens), defaults);
    }
}
