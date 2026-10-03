//! Пользовательские медиафайлы: список, уборка мусора и перенос через экспорт.
//!
//! Порт `server/media.js`. В медиа лежат звуки звуковой панели, картинки и
//! видео-заставки — всё то, на что ссылаются настройки и раскладка. Файлы живут
//! в каталоге `media/` рядом с настройками, а не в поставке: пользователь кладёт
//! их сам, и поставка их не перезаписывает.
//!
//! Отличие от JS: там каталог берётся из глобального `getUserMediaDir()`, здесь
//! он приходит аргументом (`Storage::media_dir()`) — так модуль не зависит от
//! того, кто и когда настроил хранилище, и его можно проверять тестами напрямую.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{json, Map, Value};

/// Предел размера файла для экспорта в один JSON: крупнее просто не тянем.
pub const MAX_EXPORT_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// Расширения, которые считаются медиа, если строка — просто имя файла.
///
/// Видео (.mp4/.webm) здесь намеренно нет: заставки ссылаются на файлы с
/// префиксом `media/`, и этого достаточно, а случайное имя в настройках вроде
/// «release.mp4» не должно тянуть файл в сохранённые ссылки. Так же и в JS.
const MEDIA_EXTENSIONS: [&str; 10] = [
    "mp3", "wav", "ogg", "m4a", "aac", "png", "jpeg", "jpg", "gif", "webp",
];

/// Файл в каталоге медиа.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaFile {
    pub name: String,
    pub path: PathBuf,
}

/// Список файлов медиа (подкаталоги не считаются; нет каталога — пустой список).
pub fn list_media_files(dir: &Path) -> Vec<MediaFile> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // `statSync(...).isFile()` в JS идёт по ссылке, поэтому metadata, а не
        // file_type: ссылка на файл — тоже файл.
        if !fs::metadata(&path)
            .map(|data| data.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        files.push(MediaFile {
            name: entry.file_name().to_string_lossy().into_owned(),
            path,
        });
    }
    files
}

/// Имена файлов, на которые ссылаются настройки и раскладка.
///
/// Обходятся не все настройки, а только те, где такие ссылки бывают: звуковая
/// панель, стримдек, сцены (заставки), общая заставка и виджеты раскладки.
pub fn collect_referenced_media(config: &Value, layout: Option<&[Value]>) -> HashSet<String> {
    let mut refs = HashSet::new();

    for key in ["soundboard", "streamdeck", "scenes", "splash"] {
        scan_value(config.get(key), &mut refs);
    }
    for widget in layout.unwrap_or_default() {
        scan_value(Some(widget), &mut refs);
    }
    refs
}

/// Удалить файлы, на которые никто не ссылается.
///
/// Возвращает `{removed, removedNames, kept}` — тот же ответ, что уходит в
/// панель и в CLI.
pub fn cleanup_orphaned_media(dir: &Path, config: &Value, layout: Option<&[Value]>) -> Value {
    let refs = collect_referenced_media(config, layout);
    let files = list_media_files(dir);
    let mut removed_names = Vec::new();

    for file in &files {
        if refs.contains(&file.name) {
            continue;
        }
        // Файл мог быть занят или уже удалён — просто пропускаем.
        if fs::remove_file(&file.path).is_ok() {
            removed_names.push(file.name.clone());
        }
    }

    json!({
        "removed": removed_names.len(),
        "removedNames": removed_names,
        "kept": files.len() - removed_names.len(),
    })
}

/// Упаковать содержимое `media/` в base64 — для переносимого экспорта настроек.
pub fn collect_media_for_export(dir: &Path) -> Map<String, Value> {
    let mut out = Map::new();
    for file in list_media_files(dir) {
        let Ok(data) = fs::read(&file.path) else {
            continue; // нечитаемый файл — не повод ронять экспорт
        };
        if data.len() as u64 > MAX_EXPORT_FILE_BYTES {
            continue;
        }
        out.insert(
            format!("media/{}", file.name),
            Value::from(base64::engine::general_purpose::STANDARD.encode(&data)),
        );
    }
    out
}

/// Восстановить файлы из манифеста экспорта; возвращает число записанных.
///
/// Из ключа берётся только имя файла: иначе `../../` из чужого манифеста записал
/// бы файл куда угодно. Значения не-строки пропускаются: `String(b64)` в JS
/// превратил бы их в мусор, из которого в лучшем случае вышел бы мусорный файл.
pub fn import_media(dir: &Path, media: &Map<String, Value>) -> usize {
    let _ = fs::create_dir_all(dir);
    let mut imported = 0;

    for (relative, payload) in media {
        let normalized = relative.replace('\\', "/");
        let name = base_name(&normalized);
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let Some(payload) = payload.as_str() else {
            continue;
        };
        let Ok(data) = base64::engine::general_purpose::STANDARD.decode(payload) else {
            continue;
        };
        if data.is_empty() {
            continue;
        }
        if fs::write(dir.join(name), &data).is_ok() {
            imported += 1;
        }
    }

    imported
}

/// Рекурсивный обход значения: строки проверяем, массивы и объекты обходим.
fn scan_value(value: Option<&Value>, refs: &mut HashSet<String>) {
    match value {
        Some(Value::String(text)) => {
            if let Some(name) = referenced_name(text) {
                refs.insert(name);
            }
        }
        Some(Value::Array(items)) => {
            for item in items {
                scan_value(Some(item), refs);
            }
        }
        Some(Value::Object(fields)) => {
            for value in fields.values() {
                scan_value(Some(value), refs);
            }
        }
        _ => {}
    }
}

/// Имя медиафайла, на который ссылается строка.
///
/// Две формы: путь с префиксом `media/` (в том числе в середине строки, как в
/// CSS-ссылке или в тексте) и просто имя файла с медиа-расширением.
fn referenced_name(text: &str) -> Option<String> {
    if let Some(captured) = media_path_capture(text) {
        let name = base_name(&captured);
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }

    let trimmed = text.trim();
    if has_media_extension(trimmed) {
        let name = base_name(trimmed);
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

/// Часть после `media/` — аналог `/(?:^|\/)media\/([^"'\s]+)/`.
///
/// Разбор руками, без регулярного выражения: правило короткое, а лишняя
/// зависимость ради одной строки ни к чему. Берётся первое вхождение, перед
/// которым начало строки или слэш; хвост обрывается на кавычке или пробеле.
fn media_path_capture(text: &str) -> Option<String> {
    const PREFIX: &str = "media/";
    for (index, _) in text.match_indices(PREFIX) {
        let preceded_ok = index == 0 || text.as_bytes()[index - 1] == b'/';
        if !preceded_ok {
            continue;
        }
        let tail = &text[index + PREFIX.len()..];
        let end = tail
            .find(['"', '\'', ' ', '\t', '\n', '\r'])
            .unwrap_or(tail.len());
        if end == 0 {
            continue;
        }
        return Some(tail[..end].to_string());
    }
    None
}

/// Есть ли у строки медиа-расширение в конце (без учёта регистра).
fn has_media_extension(text: &str) -> bool {
    let Some((_, extension)) = text.rsplit_once('.') else {
        return false;
    };
    MEDIA_EXTENSIONS
        .iter()
        .any(|known| extension.eq_ignore_ascii_case(known))
}

/// Имя файла без каталогов: `path.basename`.
///
/// И `/`, и `\` считаются разделителями: в JS версия для Windows ведёт себя так
/// же, а для импорта чужих манифестов это ещё и защита от выхода из каталога.
fn base_name(value: &str) -> &str {
    let trimmed = value.trim_end_matches(['/', '\\']);
    match trimmed.rfind(['/', '\\']) {
        Some(index) => &trimmed[index + 1..],
        None => trimmed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Временный каталог медиа под один тест.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("ose-media-{}-{label}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            Self(dir)
        }

        fn media(&self) -> PathBuf {
            self.0.join("media")
        }

        fn write(&self, name: &str, data: &[u8]) {
            let dir = self.media();
            fs::create_dir_all(&dir).expect("каталог медиа должен создаваться");
            fs::write(dir.join(name), data).expect("файл должен записываться");
        }

        fn has(&self, name: &str) -> bool {
            self.media().join(name).exists()
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = list_media_files(&self.media())
                .into_iter()
                .map(|file| file.name)
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn cleanup_removes_unused_files_and_keeps_referenced() {
        let dir = TempDir::new("cleanup");
        dir.write("keep.mp3", b"x");
        dir.write("keep.png", b"z");
        dir.write("drop.mp3", b"y");

        let config = json!({
            "soundboard": { "sounds": [{ "audioFile": "media/keep.mp3", "imageFile": "media/keep.png" }] },
            "streamdeck": { "icons": {} },
        });

        let result = cleanup_orphaned_media(&dir.media(), &config, None);

        assert_eq!(result["removed"], json!(1));
        assert_eq!(result["removedNames"], json!(["drop.mp3"]));
        assert_eq!(result["kept"], json!(2));
        assert!(dir.has("keep.mp3"));
        assert!(dir.has("keep.png"));
        assert!(!dir.has("drop.mp3"));
    }

    #[test]
    fn cleanup_keeps_scene_splash_videos() {
        let dir = TempDir::new("scenes");
        dir.write("intro.mp4", b"i");
        dir.write("outro.mp4", b"o");
        dir.write("drop.mp3", b"d");

        // .mp4 нет в списке расширений, но заставки ссылаются на него с префиксом
        // `media/`, и этого достаточно, чтобы файл не считался мусором.
        let config = json!({
            "soundboard": { "sounds": [] },
            "streamdeck": { "icons": {} },
            "scenes": {
                "start": { "splashFile": "media/intro.mp4" },
                "end": { "splashFile": "media/outro.mp4" },
            },
        });

        let result = cleanup_orphaned_media(&dir.media(), &config, None);

        assert_eq!(result["removed"], json!(1));
        assert_eq!(result["removedNames"], json!(["drop.mp3"]));
        assert!(dir.has("intro.mp4"));
        assert!(dir.has("outro.mp4"));
    }

    #[test]
    fn cleanup_keeps_the_global_splash() {
        let dir = TempDir::new("splash");
        dir.write("global.mp4", b"g");
        dir.write("drop.mp3", b"d");

        let config = json!({
            "soundboard": { "sounds": [] },
            "streamdeck": { "icons": {} },
            "splash": { "file": "media/global.mp4", "duration": 3 },
        });

        let result = cleanup_orphaned_media(&dir.media(), &config, None);

        assert_eq!(result["removed"], json!(1));
        assert_eq!(result["removedNames"], json!(["drop.mp3"]));
        assert!(dir.has("global.mp4"));
    }

    #[test]
    fn cleanup_keeps_media_referenced_by_the_layout() {
        let dir = TempDir::new("layout");
        dir.write("drop.png", b"x");
        let layout = vec![json!({ "id": "w1", "props": { "src": "/media/drop.png" } })];

        let result = cleanup_orphaned_media(&dir.media(), &json!({}), Some(&layout));

        assert_eq!(result["removed"], json!(0));
        assert_eq!(result["kept"], json!(1));
    }

    #[test]
    fn export_and_import_make_a_round_trip() {
        let dir = TempDir::new("export");
        dir.write("a.mp3", &[1, 2, 3, 4]);

        let manifest = collect_media_for_export(&dir.media());
        assert!(manifest.contains_key("media/a.mp3"));

        fs::remove_dir_all(dir.media()).expect("каталог должен удаляться");
        let imported = import_media(&dir.media(), &manifest);

        assert_eq!(imported, 1);
        assert_eq!(
            fs::read(dir.media().join("a.mp3")).unwrap(),
            vec![1, 2, 3, 4]
        );
    }

    #[test]
    fn import_does_not_escape_the_media_directory() {
        let dir = TempDir::new("escape");
        let payload = base64::engine::general_purpose::STANDARD.encode(b"x");
        let mut manifest = Map::new();
        manifest.insert("../../evil.txt".to_string(), Value::from(payload));

        let imported = import_media(&dir.media(), &manifest);

        assert_eq!(imported, 1);
        assert!(dir.has("evil.txt"));
        assert!(
            !dir.0.join("evil.txt").exists(),
            "файл не должен выйти наружу"
        );
    }

    #[test]
    fn references_come_from_prefix_and_extension() {
        let config = json!({
            "soundboard": {
                "sounds": [
                    "media/keep.mp3",
                    "media/nested/cover.PNG",
                    // Ссылка в середине фразы без слэша перед `media/` не считается:
                    // так же ведёт себя строка в JS.
                    "звук лежит в media/sound.wav и рядом",
                    "url(/media/bg image.png)",
                    "media/sub/../deep.mp3",
                    "xmedia/a.mp3",
                    "clip.mp4",
                ],
            },
            "streamdeck": { "icons": { "one": "click.ogg" } },
        });

        let refs = collect_referenced_media(&config, None);

        // Из префикса берётся имя файла, а не путь.
        assert!(refs.contains("keep.mp3"));
        assert!(refs.contains("cover.PNG"));
        // Пробел обрывает ссылку, поэтому имя — `bg`, а не `image.png`.
        assert!(refs.contains("bg"));
        assert!(refs.contains("deep.mp3"));
        // Без слэша перед `media/` остаётся второе правило — имя с расширением.
        assert!(refs.contains("a.mp3"));
        // Просто имя с медиа-расширением — тоже ссылка, регистр не важен.
        assert!(refs.contains("click.ogg"));

        assert!(!refs.contains("sound.wav"));
        assert!(!refs.contains("image.png"));
        assert!(!refs.contains("clip.mp4"));
    }

    #[test]
    fn bare_video_names_are_not_references() {
        let config = json!({ "splash": { "file": "intro.mp4" }, "scenes": { "brb": "brb.mp4" } });

        let refs = collect_referenced_media(&config, None);

        assert!(refs.is_empty(), "{refs:?}");
    }

    #[test]
    fn capture_stops_at_quotes_and_spaces() {
        assert_eq!(
            media_path_capture("url(/media/bg image.png)"),
            Some("bg".to_string()),
            "пробел обрывает ссылку — как в JS"
        );
        assert_eq!(
            media_path_capture("xmedia/a.mp3"),
            None,
            "префикс без начала строки или слэша не считается"
        );
        assert_eq!(media_path_capture("media/a.mp3"), Some("a.mp3".to_string()));
    }

    #[test]
    fn base_names_follow_the_script_rule() {
        assert_eq!(base_name("a/b/c.mp3"), "c.mp3");
        assert_eq!(base_name("c.mp3"), "c.mp3");
        // Хвостовые разделители отбрасываются, как в path.basename.
        assert_eq!(base_name("a/b/"), "b");
        assert_eq!(base_name("/"), "");
        assert_eq!(base_name(".."), "..");
        // Обратные слэши тоже разделители — так защищается импорт.
        assert_eq!(base_name("..\\..\\evil.txt"), "evil.txt");
    }

    #[test]
    fn import_skips_broken_and_empty_entries() {
        let dir = TempDir::new("import-broken");
        let payload = base64::engine::general_purpose::STANDARD.encode(b"ok");
        let mut manifest = Map::new();
        manifest.insert(String::new(), Value::from(payload.clone()));
        manifest.insert("..".to_string(), Value::from(payload.clone()));
        manifest.insert("broken.mp3".to_string(), Value::from("не base64!!"));
        manifest.insert("empty.mp3".to_string(), Value::from(""));
        manifest.insert("number.mp3".to_string(), json!(5));
        manifest.insert("good.mp3".to_string(), Value::from(payload));

        let imported = import_media(&dir.media(), &manifest);

        assert_eq!(imported, 1);
        assert_eq!(dir.names(), vec!["good.mp3".to_string()]);
    }

    #[test]
    fn listing_ignores_directories_and_missing_catalogue() {
        let dir = TempDir::new("listing");
        dir.write("keep.mp3", b"x");
        fs::create_dir_all(dir.media().join("subdir")).expect("подкаталог должен создаваться");

        assert_eq!(dir.names(), vec!["keep.mp3".to_string()]);

        // Каталога нет — пустой список, а не ошибка.
        assert!(list_media_files(&dir.0.join("nope")).is_empty());
    }
}
