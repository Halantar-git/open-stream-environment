//! Секреты внутри `config.json`: шифрование системным хранилищем.
//!
//! Порт `server/secret-store.js`. Что выяснилось при переносе — и почему модуль
//! устроен именно так.
//!
//! В Electron секреты шифрует не приложение, а система (`safeStorage`), и
//! **повторить её формат не удалось**. Разбор показал:
//!
//! - значение Electron — это `enc:` + base64, а внутри маркер `v10` и следом
//!   49 байт на 21 байт открытого текста; для блоба DPAPI это слишком мало
//!   (у него одна только обвязка длиннее), то есть это AES-GCM;
//! - ключ AES лежит **не** в `os_crypt.encrypted_key` из `Local State`: значение,
//!   собранное на этом ключе, сам Electron расшифровать отказался
//!   (`Error while decrypting the ciphertext provided to safeStorage.decryptString`).
//!
//! То есть у Electron 43 на Windows своя, недокументированная схема хранения
//! ключа. Повторять её — значит зависеть от внутренностей, которые меняются от
//! версии к версии: расшифровка «сегодня работает, завтра нет».
//!
//! Поэтому решение: **свой формат, честный разговор с пользователем**.
//!
//! - Пишем и читаем блоб DPAPI по открытому тексту: без файла ключей и без
//!   управления им. DPAPI привязан к пользователю системы, поэтому значение
//!   переживает перезапуск и не читается на другой машине или у другого
//!   пользователя.
//! - Значения, записанные старой версией, распознаются (маркер `v10`) и попадают
//!   в разряд `unreadable` — панель скажет «введите ключ заново» вместо «не
//!   заполнено». Ключи придётся ввести один раз при переезде; сами настройки,
//!   раскладка, темы и история при этом не теряются.
//!
//! Формат значения — `<префикс><base64>`; открытый текст остаётся открытым:
//! так выглядят настройки, в которые секрет ещё не вписывали.
//!
//! Почему различаются два вида неудачи (в JS это `SECRET_ISSUE`):
//!
//! - **unreadable** — расшифровка не удалась: значение зашифровано другим ключом
//!   (сменился пользователь ОС, файл принесли с другой машины, значение оставила
//!   старая версия);
//! - **locked** — шифрование сейчас недоступно, и прочитать зашифрованное нечем.
//!
//! Для пользователя разница существенная: «ключ не вписан» лечится вставкой
//! ключа, а «ключ не читается» — тем, что его вставляют **заново**. Сброшенное
//! значение при этом не отдаётся сервису как есть: зашифрованный вид — это не
//! секрет, и сервис ответил бы невнятным `invalid_client`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use base64::Engine;

/// Префикс значения, зашифрованного системным хранилищем.
pub const SEALED_PREFIX: &str = "enc:";

/// Маркер старого формата: так начинается значение, записанное Electron-версией.
///
/// Читать его мы не умеем (см. заголовок модуля), но по нему отличаем «значение
/// оставила старая версия» от «значение испорчено» — это разные объяснения.
pub const LEGACY_MARKER: &[u8] = b"v10";

/// Человекочитаемые имена секретов — те же, что в `SECRET_LABELS` (`state.js`).
///
/// Ими подписаны замечания «секрет не удалось прочитать», и панель показывает
/// именно их: пользователь должен видеть, какой ключ вставлять заново, а не
/// «секрет №3». Строки совпадают с JS до символа.
pub mod labels {
    pub const TWITCH_CLIENT_SECRET: &str = "Twitch Client Secret";
    pub const TWITCH_ACCESS_TOKEN: &str = "Twitch User Access Token";
    pub const TWITCH_REFRESH_TOKEN: &str = "Twitch Refresh Token";
    pub const DONATION_ALERTS_CLIENT_SECRET: &str = "DonationAlerts Client Secret";
    pub const DONATION_ALERTS_ACCESS_TOKEN: &str = "DonationAlerts Access Token";
    pub const DONATION_ALERTS_REFRESH_TOKEN: &str = "DonationAlerts Refresh Token";
    pub const YOUTUBE_CLIENT_SECRET: &str = "YouTube Client Secret";
    pub const YOUTUBE_ACCESS_TOKEN: &str = "YouTube Access Token";
    pub const YOUTUBE_REFRESH_TOKEN: &str = "YouTube Refresh Token";
    pub const OBS_PASSWORD: &str = "OBS Password";
}

/// Почему сохранённый секрет оказался непригоден.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretIssue {
    /// Расшифровка не удалась: значение зашифровано другим ключом.
    Unreadable,
    /// Шифрование недоступно, поэтому прочитать зашифрованное нечем.
    Locked,
}

/// Замечание о секрете: метка и причина. Самого секрета здесь нет — по этим
/// записям главное окно показывает диалог, а панель объясняет состояние.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueNote {
    pub label: String,
    pub reason: SecretIssue,
}

/// Зашифровать значение системным хранилищем?
pub fn available() -> bool {
    platform::available()
}

/// Лежит ли значение зашифрованным.
pub fn is_sealed(value: &str) -> bool {
    value.starts_with(SEALED_PREFIX)
}

/// Оставила ли значение старая (Electron) версия.
///
/// Нужно для объяснений при переезде: такое значение читать нечем, и это не
/// порча файла, а смена схемы.
pub fn is_legacy(value: &str) -> bool {
    let Some(rest) = value.strip_prefix(SEALED_PREFIX) else {
        return false;
    };
    base64::engine::general_purpose::STANDARD
        .decode(rest)
        .map(|payload| payload.starts_with(LEGACY_MARKER))
        .unwrap_or(false)
}

/// Как называется системное хранилище — для сообщений.
pub fn backend_name() -> &'static str {
    platform::NAME
}

/// Секреты приложения.
pub struct SecretStore {
    issues: Mutex<Vec<IssueNote>>,
    /// Предупреждение «пишем открытым текстом» — один раз за запуск.
    warned: AtomicBool,
}

impl Default for SecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore {
    pub fn new() -> Self {
        Self {
            issues: Mutex::new(Vec::new()),
            warned: AtomicBool::new(false),
        }
    }

    /// Зашифровать значение. Пустое остаётся пустым — шифровать нечего.
    ///
    /// Если хранилище недоступно, значение сохраняется как есть: приложение не
    /// должно перестать работать, но и делать вид, что всё в порядке, нельзя —
    /// об этом говорит [`SecretStore::protection_warning`].
    pub fn seal(&self, value: &str, label: &str) -> String {
        if value.is_empty() {
            return String::new();
        }

        let Some(ciphertext) = platform::encrypt(value.as_bytes()) else {
            self.warn_unprotected();
            return value.to_string();
        };

        // Значение снова читаемо — прошлая неудача чтения была не про него.
        self.clear_issue(label);
        format!(
            "{SEALED_PREFIX}{}",
            base64::engine::general_purpose::STANDARD.encode(ciphertext)
        )
    }

    /// Расшифровать значение. Открытый текст возвращается как есть.
    ///
    /// При неудаче возвращается пустая строка и записывается причина: отдать
    /// зашифрованный вид наружу нельзя — он уйдёт в сервис вместо секрета.
    pub fn open(&self, value: &str, label: &str) -> String {
        if !is_sealed(value) {
            return value.to_string();
        }

        if !platform::available() {
            self.note_issue(label, SecretIssue::Locked);
            return String::new();
        }

        let opened = base64::engine::general_purpose::STANDARD
            .decode(&value[SEALED_PREFIX.len()..])
            .ok()
            .and_then(|payload| platform::decrypt(&payload));

        match opened {
            Some(plain) => String::from_utf8_lossy(&plain).into_owned(),
            None => {
                self.note_issue(label, SecretIssue::Unreadable);
                String::new()
            }
        }
    }

    /// Замечания о секретах — для диалога и объяснений в панели.
    pub fn issues(&self) -> Vec<IssueNote> {
        self.issues.lock().unwrap().clone()
    }

    /// Забыть все замечания (после того, как пользователь их увидел).
    pub fn clear_issues(&self) {
        self.issues.lock().unwrap().clear();
    }

    /// Нечитаем ли секрет с этой меткой — панель по этому флагу говорит «вставьте
    /// ключ заново» вместо «не заполнен».
    pub fn is_unreadable(&self, label: &str) -> bool {
        self.issues
            .lock()
            .unwrap()
            .iter()
            .any(|note| note.label == label)
    }

    /// Сказать один раз, что секреты ложатся на диск открытым текстом.
    ///
    /// Возвращает текст ровно один раз за запуск — вызывающий пишет строку в
    /// журнал. Так предупреждение не теряется и не превращается в поток.
    pub fn protection_warning(&self) -> Option<&'static str> {
        if platform::available() || self.warned.swap(true, Ordering::SeqCst) {
            return None;
        }
        Some(
            "[secret-store] системное хранилище секретов недоступно — ключи приложения \
             сохраняются без шифрования.",
        )
    }

    fn note_issue(&self, label: &str, reason: SecretIssue) {
        let mut issues = self.issues.lock().unwrap();
        let label = if label.is_empty() { "secret" } else { label };
        if issues
            .iter()
            .any(|note| note.label == label && note.reason == reason)
        {
            return;
        }
        issues.push(IssueNote {
            label: label.to_string(),
            reason,
        });
    }

    fn clear_issue(&self, label: &str) {
        let label = if label.is_empty() { "secret" } else { label };
        let mut issues = self.issues.lock().unwrap();
        issues.retain(|note| note.label != label);
    }

    fn warn_unprotected(&self) {
        // Предупреждение забирает вызывающий через `protection_warning`.
    }
}

/// Системное шифрование: на Windows — DPAPI, на остальных — пока ничего.
///
/// Разделение по платформам здесь, а не в вызывающем коде: всё остальное в
/// модуле одинаково для всех систем.
#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::ptr;

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    /// Имя механизма для сообщений.
    pub const NAME: &str = "DPAPI";

    pub fn available() -> bool {
        true
    }

    /// Зашифровать открытый текст блобом DPAPI.
    ///
    /// Без дополнительной энтропии и без запроса к пользователю: иначе шифрование
    /// всплывало бы окном.
    pub fn encrypt(plain: &[u8]) -> Option<Vec<u8>> {
        unsafe {
            let input = blob(plain);
            let mut output = empty_blob();
            let ok = CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            );
            take_output(ok, output)
        }
    }

    pub fn decrypt(ciphertext: &[u8]) -> Option<Vec<u8>> {
        unsafe {
            let input = blob(ciphertext);
            let mut output = empty_blob();
            let ok = CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            );
            take_output(ok, output)
        }
    }

    /// Описание входного буфера для DPAPI.
    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            // DPAPI не меняет входной буфер: приведение только для подписи FFI.
            pbData: bytes.as_ptr() as *mut u8,
        }
    }

    fn empty_blob() -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        }
    }

    /// Скопировать ответ и освободить память, которую выделила система.
    unsafe fn take_output(ok: i32, output: CRYPT_INTEGER_BLOB) -> Option<Vec<u8>> {
        if ok == 0 || output.pbData.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut c_void);
        Some(bytes)
    }
}

#[cfg(not(windows))]
mod platform {
    /// Имя механизма для сообщений: пока никакого.
    pub const NAME: &str = "системное хранилище не подключено";

    pub fn available() -> bool {
        false
    }

    pub fn encrypt(_plain: &[u8]) -> Option<Vec<u8>> {
        None
    }

    pub fn decrypt(_ciphertext: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_plain_values_pass_through() {
        let store = SecretStore::new();

        assert_eq!(store.seal("", "twitchClientSecret"), "");
        assert_eq!(store.open("", "twitchClientSecret"), "");
        // Открытый текст — это настройка, в которую секрет ещё не вписывали.
        assert_eq!(
            store.open("просто ключ", "twitchClientSecret"),
            "просто ключ"
        );
        assert!(store.issues().is_empty());
    }

    #[test]
    fn sealed_values_are_marked_by_prefix() {
        assert!(is_sealed("enc:AAAA"));
        assert!(!is_sealed("AAAA"));
        assert!(!is_sealed(""));
    }

    #[test]
    fn legacy_values_are_told_apart_from_our_own() {
        let store = SecretStore::new();

        // Значение старой версии узнаётся по маркеру внутри.
        let legacy = base64::engine::general_purpose::STANDARD.encode(b"v10\x00\x01\x02\x03");
        assert!(is_legacy(&format!("{SEALED_PREFIX}{legacy}")));

        // Своё значение — нет: это блоб DPAPI.
        let ours = store.seal("секрет", "label");
        if available() {
            assert!(!is_legacy(&ours));
        }

        assert!(!is_legacy("обычный текст"));
        assert!(!is_legacy("enc:???"));
    }

    #[test]
    fn legacy_value_is_unreadable_not_sent_to_the_service() {
        if !available() {
            return;
        }
        let store = SecretStore::new();
        // Маркер старой схемы: прочитать нечем, но и отдавать как есть нельзя.
        let legacy = base64::engine::general_purpose::STANDARD.encode(b"v10\x00\x01\x02\x03");
        assert_eq!(
            store.open(&format!("{SEALED_PREFIX}{legacy}"), "obsPassword"),
            ""
        );
        assert!(store.is_unreadable("obsPassword"));
    }

    #[test]
    fn seal_clears_the_previous_failure_for_the_same_label() {
        let store = SecretStore::new();
        // Значение зашифровано чужим ключом — так выглядит перенос конфига.
        let _ = store.open("enc:не-base64!", "twitchClientSecret");
        assert!(store.is_unreadable("twitchClientSecret"));

        let sealed = store.seal("новый ключ", "twitchClientSecret");
        assert!(!store.is_unreadable("twitchClientSecret"));
        assert!(sealed.starts_with("enc:") || !available());
    }

    #[test]
    fn broken_ciphertext_is_reported_as_unreadable() {
        if !available() {
            return;
        }
        let store = SecretStore::new();

        // Не base64 — расшифровывать нечего.
        assert_eq!(store.open("enc:???", "obsPassword"), "");
        assert_eq!(
            store.issues(),
            vec![IssueNote {
                label: "obsPassword".to_string(),
                reason: SecretIssue::Unreadable,
            }]
        );
    }

    #[test]
    fn issues_are_not_duplicated_and_can_be_cleared() {
        let store = SecretStore::new();
        let _ = store.open("enc:???", "obsPassword");
        let _ = store.open("enc:???", "obsPassword");
        assert_eq!(store.issues().len(), 1, "одна причина — одна запись");

        store.clear_issues();
        assert!(store.issues().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn sealed_value_round_trips_through_the_system() {
        let store = SecretStore::new();
        let secret = "ключ-с-юникодом-и-символами-!@#$%^&*()";

        let sealed = store.seal(secret, "twitchClientSecret");
        assert!(
            is_sealed(&sealed),
            "значение должно быть помечено: {sealed}"
        );
        assert!(
            !sealed.contains(secret),
            "секрет не должен лежать открытым текстом"
        );

        // Читается и этим экземпляром, и новым — DPAPI принадлежит пользователю
        // системы, а не процессу: так значение переживёт перезапуск.
        assert_eq!(store.open(&sealed, "twitchClientSecret"), secret);
        let other = SecretStore::new();
        assert_eq!(other.open(&sealed, "twitchClientSecret"), secret);
        assert!(other.issues().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn our_value_is_a_dpapi_blob() {
        // Блоб DPAPI узнаётся по структуре: версия 1 и следом GUID провайдера.
        let store = SecretStore::new();
        let sealed = store.seal("x", "label");

        let raw = base64::engine::general_purpose::STANDARD
            .decode(&sealed[SEALED_PREFIX.len()..])
            .expect("внутри должен быть base64");
        assert_eq!(&raw[..4], &[0x01, 0x00, 0x00, 0x00]);
        assert!(!raw.starts_with(LEGACY_MARKER));
    }

    #[cfg(not(windows))]
    #[test]
    fn without_system_storage_sealed_values_are_locked_not_leaked() {
        let store = SecretStore::new();

        // Зашифрованное значение не отдаём как есть: это не секрет.
        assert_eq!(store.open("enc:AAAA", "obsPassword"), "");
        assert_eq!(
            store.issues(),
            vec![IssueNote {
                label: "obsPassword".to_string(),
                reason: SecretIssue::Locked,
            }]
        );

        // И о том, что секреты лягут открытым текстом, говорим один раз.
        assert!(store.protection_warning().is_some());
        assert!(
            store.protection_warning().is_none(),
            "повторно не предупреждаем"
        );
    }

    #[cfg(windows)]
    #[test]
    fn with_system_storage_there_is_nothing_to_warn_about() {
        let store = SecretStore::new();
        assert!(store.protection_warning().is_none());
        assert_eq!(backend_name(), "DPAPI");
    }
}
