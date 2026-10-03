//! Инструмент разработчика: что можно выжать из сохранённого секрета.
//!
//! Зачем: панель шифрует ключи приложений системным хранилищем, и при переезде
//! надо понимать, что со старыми значениями. Свои значения (блоб DPAPI) читаются,
//! значения старой версии распознаются как `v10`, но **не** читаются — почему,
//! написано в `storage/secrets.rs`.
//!
//! ```text
//! cargo run --example open_sealed -- "enc:djEw…"
//! ```
//!
//! Печатает, зашифровано ли значение, оставила ли его старая версия, что вышло
//! при чтении и какая причина записана в хранилище. Выход 1 — прочитать не удалось.

use ose::storage::secrets::{available, is_legacy, is_sealed, SecretStore, SEALED_PREFIX};

fn main() {
    let Some(value) = std::env::args().nth(1) else {
        eprintln!("использование: open_sealed <значение с префиксом {SEALED_PREFIX}>");
        std::process::exit(2);
    };

    println!("системное хранилище доступно: {}", available());
    println!("значение зашифровано: {}", is_sealed(&value));
    println!("оставлено старой версией: {}", is_legacy(&value));

    let store = SecretStore::new();
    let opened = store.open(&value, "проверка");
    println!("прочитано: {opened}");

    for issue in store.issues() {
        println!("замечание: {} — {:?}", issue.label, issue.reason);
    }

    if opened.is_empty() {
        std::process::exit(1);
    }
}
