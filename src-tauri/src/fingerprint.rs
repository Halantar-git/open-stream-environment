//! Отпечаток исходников для сверки со сгенерированными данными (только для тестов).
//!
//! Тот же FNV-1a 64, что в `tools/fingerprint.mjs`. Переводы строк нормализуются
//! к `LF`: Git отдаёт один и тот же файл с `CRLF` на Windows и с `LF` на Unix, а
//! данные снимаются на машине разработчика. Без нормализации отпечаток, снятый
//! на Windows, «устаревал» на Linux и macOS, хотя исходник не менялся.

use std::path::Path;

/// FNV-1a 64 по UTF-8 в виде 16 шестнадцатеричных цифр.
pub fn fnv1a(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Отпечаток файла с нормализацией переводов строк (`CRLF` → `LF`).
pub fn fnv1a_file(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    fnv1a(&normalize_newlines(&bytes))
}

/// Заменить `CRLF` на `LF` — как `fingerprint.mjs` перед счётом.
fn normalize_newlines(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
            index += 1;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_line_endings_do_not_change_the_fingerprint() {
        assert_eq!(
            fnv1a(b"a\nb\n"),
            fnv1a(&normalize_newlines(b"a\r\nb\r\n")),
            "CRLF и LF должны давать один отпечаток"
        );
    }
}
