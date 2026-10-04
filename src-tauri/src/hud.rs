//! Окна поверх игры и глобальные хоткеи — `main.js` в части HUD.
//!
//! Порт одномониторного режима из Electron: прозрачный оверлей на весь экран
//! (`hud-overlay`), который в обычном состоянии пропускает клики насквозь, а по
//! хоткею входит в режим редактирования и ловит мышь; отдельное окно чата поверх
//! игры (`chat-hud`), которое только показывается/скрывается. Плюс глобальные
//! хоткеи: настраиваемые HUD и чата, игровой режим (Ctrl+Shift+G) и закрепление
//! чата поверх окон (Ctrl+Shift+C).
//!
//! Сервер сюда не заглядывает: `server/commands.rs` зовёт [`Diagnostics`] через
//! [`HudHost`], а глобальный хоткей находит оболочку в состоянии приложения. Так
//! `AppHandle` нужен только этому модулю, а разбор команд остаётся чистым.
//!
//! Отличия от Electron, там где API не совпадает: нет `setFrameRate` (частоту
//! кадров окна Tauri не выставляет) и нет `showInactive` — чат HUD создаётся
//! нефокусируемым и показывается без захвата фокуса по возможности платформы.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::desktop::DesktopState;
use crate::diagnostics::HudHost;

/// Метка окна оверлея поверх игры.
const HUD_LABEL: &str = "hud-overlay";
/// Метка окна чата поверх игры.
const CHAT_HUD_LABEL: &str = "chat-hud";

/// Живое состояние окон: меняется только из главного потока-обработчика.
#[derive(Default)]
struct Inner {
    hud_editing: bool,
    chat_enabled: bool,
    game_mode: bool,
    chat_pinned: bool,
    hud_hotkey: Option<String>,
    chat_hotkey: Option<String>,
}

/// Оболочка окон поверх игры: хранит `AppHandle` и состояние окон.
pub struct Hud {
    app: AppHandle,
    inner: Mutex<Inner>,
}

impl Hud {
    /// Создать оболочку. Состояние окон ставит [`Hud::install`].
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            inner: Mutex::new(Inner {
                // Чат закреплён поверх окон по умолчанию — как `chatPinned = true`.
                chat_pinned: true,
                ..Inner::default()
            }),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn port(&self) -> Option<u16> {
        self.app
            .try_state::<DesktopState>()
            .map(|state| state.diagnostics.port())
    }

    /// Перевести окна оболочки на новый порт.
    ///
    /// Окна загружены по HTTP с прежнего адреса, и их источник (`Origin`) несёт
    /// старый порт: шина сверяет его с текущим и отклонила бы переподключение.
    /// Меняем порт в URL и перезагружаем окно — страница сама подключается к
    /// шине уже с правильным источником. Чужие окна (не с нашего сервера) не
    /// трогаем: адрес у них свой.
    fn reload_windows_for_port(&self, previous: u16, next: u16) {
        let previous_host = format!(":{previous}");
        let next_host = format!(":{next}");
        let previous_query = format!("port={previous}");
        let next_query = format!("port={next}");
        for (_label, window) in self.app.webview_windows() {
            let Ok(url) = window.url() else {
                continue;
            };
            if url.host_str() != Some("127.0.0.1") {
                continue;
            }
            let text = url
                .as_str()
                .replace(&previous_host, &next_host)
                .replace(&previous_query, &next_query);
            if let Ok(new_url) = tauri::Url::parse(&text) {
                let _ = window.navigate(new_url);
            }
        }
    }

    fn config(&self) -> Value {
        match self.app.try_state::<DesktopState>() {
            Some(state) => Value::Object(state.diagnostics.config().value().clone()),
            None => Value::Object(serde_json::Map::new()),
        }
    }

    /// Экран для окна: выбранный в настройках (по имени) или основной.
    fn resolve_monitor(&self, key: &str) -> Option<tauri::Monitor> {
        let window = self.app.get_webview_window("main")?;
        let desired = self
            .config()
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string);
        let monitors = window.available_monitors().ok()?;
        if let Some(desired) = desired {
            if let Some(found) = monitors
                .iter()
                .find(|monitor| monitor.name().map(|name| name == &desired).unwrap_or(false))
            {
                return Some(found.clone());
            }
        }
        window
            .primary_monitor()
            .ok()
            .flatten()
            .or_else(|| monitors.into_iter().next())
    }

    // ---- Оверлей поверх игры ----

    fn ensure_hud_window(&self) -> Option<WebviewWindow> {
        if let Some(window) = self.app.get_webview_window(HUD_LABEL) {
            return Some(window);
        }
        self.create_hud_window()
    }

    fn create_hud_window(&self) -> Option<WebviewWindow> {
        let port = self.port()?;
        let monitor = self.resolve_monitor("hud_display_id")?;
        let (x, y, width, height) = monitor_bounds(&monitor);
        let url = page_url(port, "/overlay/overlay.html", &[]);
        // Без моста: оверлей получает раскладку и режим по WebSocket, а лишний
        // мост в окне поверх игры — только лишняя поверхность (как в JS).
        let built = WebviewWindowBuilder::new(&self.app, HUD_LABEL, WebviewUrl::External(url))
            .title("Open Stream Environment — HUD")
            .position(x, y)
            .inner_size(width, height)
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .shadow(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .visible(false)
            .build();
        match built {
            Ok(window) => {
                let _ = window.set_ignore_cursor_events(true);
                Some(window)
            }
            Err(error) => {
                eprintln!("[ose] окно HUD не создалось: {error}");
                None
            }
        }
    }

    fn toggle_hud_edit(&self) -> bool {
        let Some(window) = self.ensure_hud_window() else {
            return self.lock().hud_editing;
        };
        let editing = {
            let mut inner = self.lock();
            inner.hud_editing = !inner.hud_editing;
            inner.hud_editing
        };
        // Во время редактирования ловим мышь, иначе — сквозной клик.
        let _ = window.set_ignore_cursor_events(!editing);
        if editing {
            let _ = window.show();
        } else {
            let _ = window.hide();
        }
        editing
    }

    fn hud_display_changed(&self) {
        let was_editing = self.lock().hud_editing;
        if let Some(window) = self.app.get_webview_window(HUD_LABEL) {
            let _ = window.close();
        }
        self.lock().hud_editing = false;
        if was_editing {
            self.toggle_hud_edit();
        }
    }

    // ---- Чат поверх игры ----

    fn ensure_chat_hud_window(&self) -> Option<WebviewWindow> {
        if let Some(window) = self.app.get_webview_window(CHAT_HUD_LABEL) {
            return Some(window);
        }
        self.create_chat_hud_window()
    }

    fn create_chat_hud_window(&self) -> Option<WebviewWindow> {
        let port = self.port()?;
        let (x, y, width, height) = self.resolve_chat_hud_bounds()?;
        let opacity = number_text(self.chat_hud_number("opacity", 70.0));
        let font = number_text(self.chat_hud_number("fontSize", 14.0));
        let port_text = port.to_string();
        let url = page_url(
            port,
            "/chatwindow/chat-window.html",
            &[
                ("port", &port_text),
                ("hud", "1"),
                ("opacity", &opacity),
                ("fontSize", &font),
            ],
        );
        let built = WebviewWindowBuilder::new(&self.app, CHAT_HUD_LABEL, WebviewUrl::External(url))
            .title("Open Stream Environment — чат")
            .initialization_script(include_str!("../preload-tauri.js"))
            .position(x, y)
            .inner_size(width, height)
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .shadow(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            // Чат только читается и не должен выдёргивать фокус из игры
            // (`focusable: false` в `main.js`).
            .focusable(false)
            .visible(false)
            .build();
        match built {
            Ok(window) => {
                // Чат только читается — мышь не перехватываем.
                let _ = window.set_ignore_cursor_events(true);
                Some(window)
            }
            Err(error) => {
                eprintln!("[ose] окно чата поверх игры не создалось: {error}");
                None
            }
        }
    }

    fn chat_hud_number(&self, key: &str, default: f64) -> f64 {
        self.config()
            .get("chatHud")
            .and_then(|cfg| cfg.get(key))
            .and_then(Value::as_f64)
            .unwrap_or(default)
    }

    /// Геометрия окна чата: размеры ограничены, позиция по умолчанию — правый верх
    /// монитора (как `resolveChatHudBounds` в JS).
    fn resolve_chat_hud_bounds(&self) -> Option<(f64, f64, f64, f64)> {
        let monitor = self.resolve_monitor("chat_hud_display_id")?;
        let (monitor_x, monitor_y, monitor_width, _) = monitor_bounds(&monitor);
        let cfg = self.config().get("chatHud").cloned().unwrap_or(Value::Null);
        let clamp = |value: f64, min: f64, max: f64| value.max(min).min(max);
        let width = clamp(self.chat_hud_number("width", 360.0), 240.0, 1200.0).round();
        let height = clamp(self.chat_hud_number("height", 560.0), 160.0, 2000.0).round();
        let x = cfg
            .get("x")
            .and_then(Value::as_f64)
            .map(|value| value.round())
            .unwrap_or_else(|| (monitor_x + monitor_width - width - 16.0).round());
        let y = cfg
            .get("y")
            .and_then(Value::as_f64)
            .map(|value| value.round())
            .unwrap_or_else(|| (monitor_y + 16.0).round());
        Some((x, y, width, height))
    }

    fn toggle_chat_hud(&self) {
        let Some(window) = self.ensure_chat_hud_window() else {
            return;
        };
        let enabled = {
            let mut inner = self.lock();
            inner.chat_enabled = !inner.chat_enabled;
            inner.chat_enabled
        };
        if enabled {
            let _ = window.show();
        } else {
            let _ = window.hide();
        }
    }

    fn chat_hud_display_changed(&self) {
        let was_enabled = self.lock().chat_enabled;
        if let Some(window) = self.app.get_webview_window(CHAT_HUD_LABEL) {
            let _ = window.close();
        }
        self.lock().chat_enabled = false;
        if was_enabled {
            self.lock().chat_enabled = true;
            if let Some(window) = self.ensure_chat_hud_window() {
                let _ = window.show();
            }
        }
    }

    fn chat_hud_config_changed(&self) {
        let Some(window) = self.app.get_webview_window(CHAT_HUD_LABEL) else {
            return;
        };
        if let Some((x, y, width, height)) = self.resolve_chat_hud_bounds() {
            let _ = window.set_position(tauri::LogicalPosition::new(x, y));
            let _ = window.set_size(tauri::LogicalSize::new(width, height));
        }
    }

    // ---- Игровой режим и закрепление чата ----

    fn toggle_game_mode(&self) {
        let (game_mode, pinned) = {
            let mut inner = self.lock();
            inner.game_mode = !inner.game_mode;
            (inner.game_mode, inner.chat_pinned)
        };
        if let Some(main) = self.app.get_webview_window("main") {
            if game_mode {
                let _ = main.hide();
            } else {
                let _ = main.show();
            }
        }
        self.apply_chat_always_on_top(pinned || game_mode);
        if let Some(state) = self.app.try_state::<DesktopState>() {
            // Флаг уходит клиентам тем же кадром, что рассылал `main.js`.
            state
                .diagnostics
                .broadcast("game_mode", serde_json::json!({ "enabled": game_mode }));
        }
    }

    /// Закрепление чата: кнопка 📌 в окне чата и хоткей Ctrl+Shift+C.
    pub fn toggle_chat_pin(&self) -> bool {
        if self.app.get_webview_window("chat").is_none() {
            // Окна чата нет — и переключать нечего (как `if (!chatWindow) return false`).
            return false;
        }
        let (pinned, game_mode) = {
            let mut inner = self.lock();
            inner.chat_pinned = !inner.chat_pinned;
            (inner.chat_pinned, inner.game_mode)
        };
        self.apply_chat_always_on_top(pinned || game_mode);
        let _ = self
            .app
            .emit_to("chat", "app:chat-always-on-top-changed", pinned);
        pinned
    }

    /// Закреплён ли чат поверх окон.
    pub fn chat_pinned(&self) -> bool {
        self.lock().chat_pinned
    }

    fn apply_chat_always_on_top(&self, on: bool) {
        if let Some(chat) = self.app.get_webview_window("chat") {
            let _ = chat.set_always_on_top(on);
        }
    }

    // ---- Глобальные хоткеи ----

    /// Зарегистрировать хоткей переключения HUD или чата поверх игры.
    fn register_toggle_hotkey(&self, hotkey: &str, hud: bool) -> bool {
        if hotkey.is_empty() {
            return false;
        }
        let previous = {
            let inner = self.lock();
            if hud {
                inner.hud_hotkey.clone()
            } else {
                inner.chat_hotkey.clone()
            }
        };
        if previous.as_deref() == Some(hotkey) {
            return true;
        }
        let app = self.app.clone();
        // Оболочка окна создаёт webview, а `WebviewWindowBuilder::build`
        // небезопасен в контексте обработчика сообщения: колбэк глобального
        // хоткея приходит из виндового message-loop в главном потоке, и
        // синхронное создание окна там роняет процесс. Поэтому переключение
        // уходит в фоновую задачу — как окна редакторов в `desktop::open_window`.
        let registered = if hud {
            self.app
                .global_shortcut()
                .on_shortcut(hotkey, move |_app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let app = app.clone();
                        std::mem::drop(tauri::async_runtime::spawn(async move {
                            if let Some(state) = app.try_state::<DesktopState>() {
                                state.diagnostics.toggle_hud_edit_mode();
                            }
                        }));
                    }
                })
        } else {
            self.app
                .global_shortcut()
                .on_shortcut(hotkey, move |_app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let app = app.clone();
                        std::mem::drop(tauri::async_runtime::spawn(async move {
                            if let Some(state) = app.try_state::<DesktopState>() {
                                state.diagnostics.toggle_chat_hud();
                            }
                        }));
                    }
                })
        };
        if registered.is_err() {
            return false;
        }
        // Новый хоткей зарегистрирован — только теперь снимаем прежний, чтобы не
        // оставить мусор в реестре горячих клавиш, если регистрация не удалась.
        if let Some(previous) = previous {
            let _ = self.app.global_shortcut().unregister(previous.as_str());
        }
        let mut inner = self.lock();
        if hud {
            inner.hud_hotkey = Some(hotkey.to_string());
        } else {
            inner.chat_hotkey = Some(hotkey.to_string());
        }
        true
    }

    /// Поставить оболочку: закрепить хоткеи и поднять уже настроенные.
    ///
    /// Зовётся один раз при старте приложения, когда состояние зарегистрировано.
    pub fn install(self: &Arc<Self>) {
        let game = Arc::clone(self);
        let _ = self.app.global_shortcut().on_shortcut(
            "Ctrl+Shift+G",
            move |_app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    game.toggle_game_mode();
                }
            },
        );
        let pin = Arc::clone(self);
        let _ = self.app.global_shortcut().on_shortcut(
            "Ctrl+Shift+C",
            move |_app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    pin.toggle_chat_pin();
                }
            },
        );

        let config = self.config();
        let hud_hotkey = config
            .get("hud_edit_hotkey")
            .and_then(Value::as_str)
            .unwrap_or("Control+Shift+H")
            .to_string();
        let chat_hotkey = config
            .get("chat_hud_hotkey")
            .and_then(Value::as_str)
            .unwrap_or("Control+Shift+L")
            .to_string();
        self.register_toggle_hotkey(&hud_hotkey, true);
        self.register_toggle_hotkey(&chat_hotkey, false);
    }
}

impl HudHost for Hud {
    fn toggle_hud_edit(&self) -> bool {
        Hud::toggle_hud_edit(self)
    }

    fn hud_display_changed(&self) {
        Hud::hud_display_changed(self);
    }

    fn toggle_chat_hud(&self) {
        Hud::toggle_chat_hud(self);
    }

    fn chat_hud_display_changed(&self) {
        Hud::chat_hud_display_changed(self);
    }

    fn chat_hud_config_changed(&self) {
        Hud::chat_hud_config_changed(self);
    }

    fn register_hud_hotkey(&self, hotkey: &str) -> bool {
        self.register_toggle_hotkey(hotkey, true)
    }

    fn register_chat_hud_hotkey(&self, hotkey: &str) -> bool {
        self.register_toggle_hotkey(hotkey, false)
    }

    fn server_port_changed(&self, previous: u16, next: u16) {
        self.reload_windows_for_port(previous, next);
    }
}

/// Логические границы монитора: физические пиксели, делённые на масштаб.
fn monitor_bounds(monitor: &tauri::Monitor) -> (f64, f64, f64, f64) {
    let scale = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    (
        position.x as f64 / scale,
        position.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    )
}

/// Адрес страницы на своём сервере — по нему окно подключается к шине.
fn page_url(port: u16, path: &str, query: &[(&str, &str)]) -> tauri::Url {
    let mut url =
        tauri::Url::parse(&format!("http://127.0.0.1:{port}{path}")).expect("адрес окна HUD");
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    url
}

/// Число строкой, как `String(n)` для query-параметра: целое — без дробной части.
fn number_text(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}
