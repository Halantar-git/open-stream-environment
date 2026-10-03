//! Точка входа: всё в ядре (`ose`), здесь только запуск.
//!
//! `windows_subsystem = "windows"` только в релизе: в отладочной сборке консоль
//! нужна, иначе не увидеть ни адреса панели, ни ошибок.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ose::run();
}
