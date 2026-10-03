/*
  Отпечаток исходника для генераторов данных (`build-widget-catalog.mjs`,
  `build-themes.mjs`).

  FNV-1a 64 по UTF-8 — счёт повторён в Rust (`src-tauri/src/catalog.rs`,
  `src-tauri/src/themes.rs`): тест берёт отпечаток из данных и сверяет с живым
  JS-файлом, поэтому забытая пересборка не проходит молча.
*/

/** FNV-1a 64 по UTF-8 в виде 16 шестнадцатеричных цифр. */
export function fnv1a(text) {
  const mask = 0xffffffffffffffffn;
  const prime = 0x00000100000001b3n;
  let hash = 0xcbf29ce484222325n;
  // Переводы строк нормализуются к LF: Git отдаёт один и тот же файл с CRLF на
  // Windows и с LF на Unix, а данные снимаются на машине разработчика — без
  // этого отпечаток «устаревал» при смене платформы.
  for (const byte of Buffer.from(text.replace(/\r\n/g, "\n"), "utf8")) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
