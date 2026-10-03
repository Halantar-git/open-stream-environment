//! Хранилище: где лежат файлы пользователя и как они читаются и пишутся.
//!
//! Волна 1 плана (`docs/tauri-migration.md`): настройки, база и история, медиа,
//! секреты, журналы, резервные копии. Пока перенесены пути — с них начинается
//! всё остальное, и они же нужны остальным частям, — и атомарная запись.

pub mod async_store;
pub mod atomic;
pub mod audit_log;
pub mod config_file;
pub mod crash_guard;
pub mod db;
pub mod export;
pub mod health;
pub mod history;
pub mod integrity;
pub mod logger;
pub mod longrun;
pub mod media;
pub mod paths;
pub mod perf;
pub mod secrets;
pub mod support_bundle;
