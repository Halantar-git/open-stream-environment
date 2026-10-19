//! Вторая копия приложения — для проверки гостевых камер на одной машине.
//!
//! Обычный запуск держит именованный lock и просто показывает уже открытое
//! окно: две копии с одним идентификатором делят порт, настройки и профиль
//! WebView. Для проверки нужны именно две независимые копии — хост и гость,
//! поэтому `OSE_SECOND_INSTANCE=1` снимает lock с этой копии и уводит её данные
//! в подкаталог `instance-2`, а профиль браузера — в отдельный каталог: два
//! процесса на одном профиле WebView2 конфликтуют.

use std::path::{Path, PathBuf};

use tauri::Manager;

/// Эта копия запущена для проверки рядом с первой.
pub fn second_instance() -> bool {
    std::env::var_os("OSE_SECOND_INSTANCE")
        .map(|value| !value.is_empty() && value != "0")
        .unwrap_or(false)
}

/// Каталог данных второй копии.
///
/// Отдельно от основной: гость не должен перезаписывать настройки, базу и
/// состояние окон хоста. Хранится рядом с системным каталогом данных, а не в
/// репозитории, — `release.bat` коммитит всё, что попадёт в рабочее дерево.
pub fn data_dir(base: &Path) -> PathBuf {
    base.join("instance-2")
}

/// Отдельный профиль WebView для второй копии.
pub fn webview_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    if !second_instance() {
        return None;
    }
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join("instance-2"))
}

/// Имя файла состояния окон: у второй копии оно своё.
pub fn window_state_file() -> &'static str {
    if second_instance() {
        "window-state-2.json"
    } else {
        "window-state.json"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_instance_data_lives_beside_the_main_one() {
        let base = Path::new("C:/Users/me/AppData/Roaming/com.openstreamenvironment.app");
        assert_eq!(data_dir(base), base.join("instance-2"));
    }
}
