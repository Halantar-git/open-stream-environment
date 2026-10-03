//! HTTP-сервер: статика страниц, общие ресурсы, диагностика и шина.
//!
//! Порт берётся из настроек (`config/config.json`, поле `port`) — тот же, что у
//! Electron-версии. Шина (`/ws`) отдаёт клиенту словари и снимок состояния
//! первыми кадрами и разбирает команды ([`commands`]); правила допуска — в
//! [`access`], реестр клиентов — в [`bus`].
//!
//! Порт можно сменить на ходу ([`ServerControl`], порт `switchPort` в JS).
//! Отличие от Electron: там порт лежит в настройках и читается по месту, а
//! слушатель закрывается и открывается заново; здесь единый источник порта —
//! [`Diagnostics`], поэтому роуты и проверка источника читают его на каждом
//! запросе и не нуждаются в пересборке. Второе отличие — новый порт занимается
//! **до** остановки старого: неудача оставляет приложение с рабочим сервером, а
//! запасного «любого свободного» порта при смене нет (иначе адрес панели и OBS
//! разошлись бы). Третье: панель в Tauri загружена по HTTP, а не `file://`, как
//! окна Electron, поэтому после переезда окна переводятся на новый адрес — их
//! `Origin` иначе не совпал бы с портом, и шина отклонила бы подключение.

pub mod access;
pub mod bus;
pub mod cli;
pub mod commands;
pub mod locales;
pub mod oauth;
pub mod remote;
pub mod utils;

use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, RawQuery, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, get_service};
use axum::{Json, Router};
use chrono::Utc;
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, oneshot};
use tower_http::services::{ServeDir, ServeFile};

use crate::diagnostics::{Diagnostics, ServerHost};
use crate::integrations::http;
use crate::protocol::event_types;
use crate::server::locales::Locales;
use crate::storage::audit_log::summarize_payload;
use crate::storage::history::{js_number, js_truthy};
use crate::storage::paths::Storage;

/// Порт по умолчанию — как у Electron-версии.
const DEFAULT_PORT: u16 = 8710;

/// Поднять сервер, вернуть порт, на котором он слушает, и состояние диагностики.
///
/// Слушаем на всех интерфейсах, как `server.listen(port)` в Electron: пульт
/// (`/remote?token=…`) открывают с телефона из локальной сети, поэтому на одном
/// `127.0.0.1` он был бы недостижим. Свои страницы и код доступа — как раньше:
/// клиент с этой машины (loopback) проходит без кода, из сети — только с кодом
/// ([`access`]), а полный отчёт `/support-bundle` отдаётся только loopback.
pub fn spawn(root: &Path, storage: Storage) -> std::io::Result<(u16, Arc<Diagnostics>)> {
    let mut diagnostics = Diagnostics::open(storage)?;
    // Нормализация настроек — как конструктор `state.js` при старте с диска.
    diagnostics.normalize();
    let diagnostics = Arc::new(diagnostics);
    // Смена сцены по награде канала идёт полным `SCENE_SET` (маппинг сцен,
    // заставка) — обработчик нужен `Arc<Diagnostics>`.
    {
        let handler_diagnostics = Arc::clone(&diagnostics);
        diagnostics.set_remote_scene_handler(Arc::new(move |payload: Value| {
            crate::server::remote::handle(
                &handler_diagnostics,
                &json!({ "action": "SCENE_SET", "payload": payload }),
            );
        }));
    }
    let listener = bind(diagnostics.configured_port().unwrap_or(DEFAULT_PORT))?;
    let port = listener.local_addr()?.port();
    // Настоящий порт нужен адресу пульта и `/healthz`.
    diagnostics.set_port(port);

    // Журнал сервера — как `serverLog` в JS: виден в панели и в суточном файле.
    diagnostics.logger("server").success(
        "overlay + control bus listening",
        Some(&json!({ "url": format!("http://localhost:{port}") })),
    );
    diagnostics.logger("server").success(
        "web remote ready",
        Some(&json!({ "url": diagnostics.remote_url() })),
    );

    // Слушатель живёт под контролем: он же умеет сменить порт на ходу.
    let control = Arc::new(ServerControl::new(root.to_path_buf(), diagnostics.clone()));
    diagnostics.install_server(control.clone());
    control.serve(listener);

    Ok((port, diagnostics))
}

/// Занять порт на всех интерфейсах (как `server.listen(port)` в Electron —
/// иначе пульт с телефона не открыть). Если порт занят (например, запущена
/// Electron-версия) — любой свободный.
fn bind(port: u16) -> std::io::Result<TcpListener> {
    let any = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port));
    TcpListener::bind(any)
        .or_else(|_| TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))))
}

/// Управление живым слушателем: смена порта без перезапуска приложения.
///
/// Фоновая задача `axum::serve` владеет сокетом, поэтому сменить порт можно
/// только «снаружи»: старую задачу просим дослушать и остановиться сигналом
/// [`oneshot`], а на новом порту поднимаем новую. Порт при этом не зашит в
/// роуты — они читают его из [`Diagnostics`], поэтому роутер пересобирается лишь
/// потому, что так проще, а не потому, что состояние порта нельзя обновить.
pub struct ServerControl {
    /// Корень статики: из него собирается роутер для новой привязки.
    root: PathBuf,
    diagnostics: Arc<Diagnostics>,
    /// Сериализует смены порта: две одновременные команды иначе гонялись бы за
    /// слушатель. Замок держится без `await` — блокировка короткая.
    switching: Mutex<()>,
    /// Остановка текущей задачи `axum::serve`: послав единицу, просим её
    /// перестать принимать соединения и освободить порт.
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl ServerControl {
    fn new(root: PathBuf, diagnostics: Arc<Diagnostics>) -> Self {
        Self {
            root,
            diagnostics,
            switching: Mutex::new(()),
            shutdown: Mutex::new(None),
        }
    }

    /// Поднять фоновую задачу `axum::serve` на уже занятом сокете.
    fn serve(&self, listener: TcpListener) {
        if let Err(error) = listener.set_nonblocking(true) {
            eprintln!("[ose] сервер не поднялся: {error}");
            return;
        }
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        *self
            .shutdown
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(shutdown_tx);

        let app = router(&self.root, self.diagnostics.clone());
        tauri::async_runtime::spawn(async move {
            match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => {
                    // Сведения о соединении нужны шине: по адресу решается,
                    // «свой» ли клиент и обязателен ли для него код доступа.
                    let service = app.into_make_service_with_connect_info::<SocketAddr>();
                    let serve = axum::serve(listener, service).with_graceful_shutdown(async move {
                        let _ = shutdown_rx.await;
                    });
                    if let Err(error) = serve.await {
                        eprintln!("[ose] сервер остановился: {error}");
                    }
                }
                Err(error) => eprintln!("[ose] сервер не поднялся: {error}"),
            }
        });
    }

    /// Попросить текущую задачу `axum::serve` остановиться и освободить порт.
    fn stop_current(&self) {
        let sender = self
            .shutdown
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(sender) = sender {
            let _ = sender.send(());
        }
    }
}

impl ServerHost for ServerControl {
    fn switch_port(&self, requested: &Value) -> Value {
        let _guard = self
            .switching
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous = self.diagnostics.port();
        let next = valid_switch_port(requested).unwrap_or(previous);
        if next == previous {
            return json!({ "ok": true, "port": next, "remoteUrl": self.diagnostics.remote_url() });
        }

        self.diagnostics.logger("server").info(
            "switching server port",
            Some(&json!({ "from": previous, "to": next })),
        );

        // Новый порт занимаем строго: при занятости остаёмся на прежнем, и
        // приложение продолжает работать — панель даже не отключается.
        let any = SocketAddr::from((Ipv4Addr::UNSPECIFIED, next));
        let Ok(listener) = TcpListener::bind(any) else {
            self.diagnostics.logger("server").error(
                &format!(
                    "не удалось запустить сервер: порт {next} занят другой программой. Смените порт в настройках."
                ),
                Some(&json!({ "port": next })),
            );
            return json!({ "ok": false, "port": previous, "remoteUrl": self.diagnostics.remote_url() });
        };

        // Настройки сохраняем первыми (как `setAppConfig` в JS): оттуда порт
        // читают панель, OAuth-адреса и отчёт. Замок настроек отпускаем до
        // `set_port`, иначе `refresh_remote_url` повторно взял бы его.
        {
            let mut config = self.diagnostics.config();
            crate::state::config::set_app_config(&mut config, &json!({ "port": next }));
        }
        self.diagnostics.set_port(next);

        // Прежние клиенты отключаются: их соединение привязано к старому порту.
        self.diagnostics.clients().remove_all();
        self.stop_current();
        self.serve(listener);

        self.diagnostics.logger("server").success(
            "overlay + control bus listening",
            Some(&json!({ "url": format!("http://localhost:{next}") })),
        );
        self.diagnostics.logger("server").success(
            "web remote ready",
            Some(&json!({ "url": self.diagnostics.remote_url() })),
        );
        // Панель и окна поверх игры загружены со старого адреса — переводим их
        // на новый, иначе их `Origin` не совпадёт с портом и шина их отклонит.
        self.diagnostics.server_port_changed(previous, next);

        json!({ "ok": true, "port": next, "remoteUrl": self.diagnostics.remote_url() })
    }
}

/// Порт для смены на ходу — как проверка `switchPort` в JS: целое из диапазона
/// 1024–65535; всё остальное (`NaN`, дробное, строка) означает «оставить как было».
fn valid_switch_port(requested: &Value) -> Option<u16> {
    let number = js_number(Some(requested));
    if !number.is_finite() || number.fract() != 0.0 {
        return None;
    }
    if !(1024.0..=65535.0).contains(&number) {
        return None;
    }
    Some(number as u16)
}

/// Роуты сервера: статика, диагностика и шина.
///
/// Порт в состояние не зашивается: и шина, и отчёты читают его из диагностики,
/// поэтому смена порта на ходу роутер не ломает.
pub fn router(root: &Path, diagnostics: Arc<Diagnostics>) -> Router {
    let bus = Bus {
        diagnostics: diagnostics.clone(),
        locales: Locales::load(root).map(Arc::new),
    };
    let media_dir = diagnostics.storage().media_dir();
    static_routes(root)
        .merge(ws_routes(bus))
        .merge(diagnostics_routes(diagnostics.clone()))
        .merge(oauth_routes(diagnostics))
        .merge(media_routes(media_dir))
}

/// Состояние шины: диагностика (в ней же реестр клиентов) и словари.
#[derive(Clone)]
struct Bus {
    diagnostics: Arc<Diagnostics>,
    locales: Option<Arc<Locales>>,
}

fn ws_routes(bus: Bus) -> Router {
    Router::new().route("/ws", get(websocket)).with_state(bus)
}

/// Подключение к шине: проверка допуска, первый кадр со словарями и состоянием.
async fn websocket(
    State(bus): State<Bus>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let incoming = access::Incoming::new(address.ip(), &headers, query.as_deref());
    let expected = bus.diagnostics.remote_token();
    let decision = incoming.check_upgrade(bus.diagnostics.port(), &|given| {
        access::tokens_match(&expected, given)
    });
    if !decision.ok {
        bus.diagnostics.access().increment_denied_upgrade();
        let reason = decision
            .reason
            .map(access::Rejection::as_str)
            .unwrap_or("unknown");
        eprintln!("[ose] подключение к шине отклонено: {reason}");
        return (StatusCode::FORBIDDEN, "403").into_response();
    }

    let role = access::role_from_query(query.as_deref(), "other");
    let external = decision.external;
    upgrade.on_upgrade(move |socket| handle_socket(socket, bus, role, external))
}

/// Соединение с клиентом: отправка очереди кадров и чтение команд.
async fn handle_socket(mut socket: WebSocket, bus: Bus, role: String, external: bool) {
    let (sender, mut receiver) = mpsc::unbounded_channel::<Message>();
    let id = bus
        .diagnostics
        .clients()
        .add(role.clone(), external, sender);

    // Первыми кадрами — словари и состояние: без них клиент остался бы с пустым
    // интерфейсом (панель ждёт `state`, оверлей — тему и раскладку).
    if let Some(locales) = &bus.locales {
        send_frame(
            &mut socket,
            event_types::LOCALES,
            locales.payload(bus.diagnostics.language()),
        )
        .await;
    }
    send_frame(
        &mut socket,
        event_types::STATE,
        bus.diagnostics.state_snapshot(),
    )
    .await;

    // Настройки виджетов колеса и микрофона — сразу после состояния, как в JS:
    // иначе панель и оверлей остаются с умолчаниями, а первая же правка затирает
    // сохранённое значение дефолтом (перезагрузка источника в OBS сбрасывала
    // позицию/скорость колеса и настройки участников).
    {
        let database = bus.diagnostics.database();
        for (kind, config) in [
            (
                event_types::OVERLAY_PARTICIPANTS_CONFIG,
                database.participants_config(),
            ),
            (event_types::WHEEL_CONFIG, database.wheel_config()),
            (
                event_types::WHEEL_SPEED_CONFIG,
                database.wheel_speed_config(),
            ),
            (event_types::OVERLAY_MIC_CONFIG, database.mic_config()),
        ] {
            send_frame(&mut socket, kind, json!({ "config": config })).await;
        }
    }

    // Перезагрузка страницы OBS не должна съедать то, что играет: очередь знает
    // текущий алерт, поэтому отдаём его заново — как в JS.
    if role == "overlay" {
        let current = bus.diagnostics.queue_snapshot()["now"].clone();
        if !current.is_null() {
            send_frame(&mut socket, event_types::ALERT, current).await;
        }
    }

    loop {
        tokio::select! {
            outgoing = receiver.recv() => match outgoing {
                Some(message) => {
                    if socket.send(message).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    handle_client_message(&bus, id, &role, external, text.as_str())
                }
                // Микрокадры: бинарный кадр от панели идёт оверлеям как есть —
                // сервер только проверяет магию и длину (`MicFrame.isFrame`),
                // не разбирая FFT-данные.
                Some(Ok(Message::Binary(data))) => {
                    if crate::audio::frame::is_frame(&data) {
                        bus.diagnostics
                            .clients()
                            .broadcast_binary_to_role("overlay", data.to_vec());
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
        }
    }

    bus.diagnostics.clients().remove(id);
}

/// Один входящий кадр: разбор, журнал, ограничитель частоты, команда.
///
/// Кадр попадает в журнал команд (тип, роль, происхождение, безопасные детали)
/// и учитывается ограничителем частоты — ровно как в Electron-версии; сверх
/// лимита команда не выполняется. Разбор — в [`commands::handle`].
fn handle_client_message(bus: &Bus, id: u64, role: &str, external: bool, raw: &str) {
    let Ok(message) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let kind = message
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind.is_empty() {
        return;
    }

    // Автодополнение CLI отвечает прямо отправителю и не попадает ни в
    // ограничитель частоты, ни в журнал команд — как в JS: Tab не должен
    // упираться в лимит, а журнал — забиваться мусором от каждого нажатия.
    if kind == event_types::EXEC_CLI_COMPLETION {
        commands::handle_message(
            bus.diagnostics.as_ref(),
            bus.locales.as_deref(),
            Some(id),
            &message,
        );
        return;
    }

    let limited = !bus.diagnostics.limiter().allow(id);
    if limited {
        bus.diagnostics.access().increment_rate_limited();
    }

    let details = summarize_payload(message.get("payload").unwrap_or(&Value::Null));
    let mut entry: Map<String, Value> = Map::new();
    entry.insert("type".to_string(), Value::from(kind));
    entry.insert("role".to_string(), Value::from(role));
    entry.insert("external".to_string(), Value::Bool(external));
    entry.insert("limited".to_string(), Value::Bool(limited));
    if let Some(details) = &details {
        entry.insert("details".to_string(), details.clone());
    }
    bus.diagnostics.audit().record(&Value::Object(entry));

    // Команда сверх лимита или пришедшая из сети — как `serverLog.warn` в JS.
    if limited || external {
        let what = if limited {
            "command rate limited"
        } else {
            "command from network"
        };
        bus.diagnostics.logger("server").warn(
            what,
            Some(&json!({
                "type": kind,
                "role": role,
                "details": details.unwrap_or(Value::Null),
            })),
        );
    }

    if !limited {
        commands::handle_message(
            bus.diagnostics.as_ref(),
            bus.locales.as_deref(),
            Some(id),
            &message,
        );
    }
}

/// Отправить кадр `{ type, payload }`.
async fn send_frame(socket: &mut WebSocket, kind: &str, payload: Value) {
    let text = json!({ "type": kind, "payload": payload }).to_string();
    let _ = socket.send(Message::Text(text.into())).await;
}

/// Состояние роутов диагностики: оба отчёта собираются из одного объекта.
#[derive(Clone)]
struct Routes {
    diagnostics: Arc<Diagnostics>,
}

/// Каталоги, которые сервер отдаёт статикой.
///
/// Набор тот же, что грузит Electron-версия: страницы панели и окон-редакторов
/// (`loadFile`), оверлей и пульт (по HTTP, иначе у них пустой `location.host` для
/// WebSocket), плюс общие ресурсы `shared/` и `assets/`. Список общий: тот же
/// набор упаковщик кладёт в ресурсы приложения (см. `bundle.resources`).
pub const SERVED_DIRS: &[&str] = &[
    "control",
    "overlay",
    "remote",
    "chatwindow",
    "splash",
    "widgeteditor",
    "themeeditor",
    "csseditor",
    "shared",
    "assets",
];

/// Редирект на слэш для корней отдаваемых каталогов — как `express.static`.
///
/// Это не косметика. `remote/index.html` подключает `style.css` и `remote.js`
/// **относительными** путями: без слэша в адресе браузер считает базой `/` и
/// просит `/style.css` (404) — пульт открывался бы без стилей и скрипта, а
/// `/remote.js` не нашёлся бы тем более. Express решал это редиректом
/// `express.static` с каталога на адрес со слэшем; `nest_service`/`ServeDir`
/// так себя не ведут — они сразу отдают `index.html`, — поэтому редирект нужен
/// здесь. Код доступа в query сохраняется.
async fn redirect_directory_roots(request: Request, next: Next) -> Response {
    let path = request.uri().path();
    if let Some(name) = path.strip_prefix('/') {
        if SERVED_DIRS.contains(&name) {
            let query = request
                .uri()
                .query()
                .map(|query| format!("?{query}"))
                .unwrap_or_default();
            return (
                StatusCode::MOVED_PERMANENTLY,
                [(header::LOCATION, format!("/{name}/{query}"))],
            )
                .into_response();
        }
    }
    next.run(request).await
}

fn static_routes(root: &Path) -> Router {
    let dir = |name: &str| root.join(name);
    let mut router = Router::new().route(
        "/",
        get_service(ServeFile::new(dir("control").join("control.html"))),
    );
    for name in SERVED_DIRS {
        router = router.nest_service(&format!("/{name}"), ServeDir::new(dir(name)));
    }
    router
        .layer(middleware::from_fn(redirect_directory_roots))
        .layer(middleware::from_fn(no_cache))
}

/// Просить клиента перепроверять файлы: статика меняется вместе с приложением, а
/// адреса у файлов те же. Без этого webview (WebView2) может отдать
/// закэшированный JS и не показать новую разметку — так значок в чате не
/// появлялся до ручной чистки кэша.
async fn no_cache(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    if !response.headers().contains_key(header::CACHE_CONTROL) {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }
    response
}

/// Пользовательские медиа (`media` в каталоге данных): видео-заставки, фоны
/// паузы, картинки и звуки звуковой панели.
///
/// Каталог лежит вне статики приложения — это данные пользователя, а не
/// ресурсы сборки, — поэтому у него отдельный маршрут. `ServeDir` отвечает на
/// `Range`: без этого `<video>` не проигрывает файл, а сразу шлёт `error`, и
/// заставка проматывается мгновенно. Так же отдавал файлы Electron-сервер.
fn media_routes(media_dir: PathBuf) -> Router {
    Router::new()
        .nest_service("/media", ServeDir::new(media_dir))
        .layer(middleware::from_fn(no_cache))
}

fn diagnostics_routes(diagnostics: Arc<Diagnostics>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/support-bundle", get(support_bundle))
        .with_state(Routes { diagnostics })
}

/// Короткий JSON о том, что происходит. Путей и секретов в нём нет, поэтому
/// отдаём всем, кто достучался до порта: на это смотрит мониторинг и отвечает
/// вопрос «сервер точно работает?».
async fn healthz(State(routes): State<Routes>) -> Response {
    let port = routes.diagnostics.port();
    let mut response = Json(routes.diagnostics.health_report(port, true)).into_response();
    no_store(&mut response);
    response
}

/// Полный отчёт для поддержки — текстом: его читают глазами и прикладывают к
/// обращению. Имя файла — то же, что в Electron-версии, чтобы диалог сохранения
/// и загрузка по HTTP не разъезжались.
async fn support_bundle(
    State(routes): State<Routes>,
    ConnectInfo(address): ConnectInfo<SocketAddr>,
) -> Response {
    // Слушаем на всех интерфейсах (пульт с телефона), поэтому отчёт для
    // поддержки, как в Electron, отдаётся только с этой машины: в нём
    // окружение и хвост журнала.
    if !access::is_loopback_addr(&address.ip()) {
        routes.diagnostics.access().increment_denied_http();
        routes.diagnostics.logger("server").warn(
            "support bundle requested from outside localhost",
            Some(&json!({ "address": address.ip().to_string() })),
        );
        return (
            StatusCode::FORBIDDEN,
            "403: отчёт доступен только с этой машины",
        )
            .into_response();
    }

    let stamp = Utc::now()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string()
        .replace([':', 'T'], "-");
    let mut response = routes
        .diagnostics
        .support_bundle_text(routes.diagnostics.port(), true)
        .into_response();

    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    let name = format!("attachment; filename=\"ose-support-{stamp}.txt\"");
    if let Ok(value) = HeaderValue::from_str(&name) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    no_store(&mut response);
    response
}

/// Отчёты не кэшируются: они отвечают на вопрос «что сейчас», а не «что было».
fn no_store(response: &mut Response) {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
}

/// Состояние роутов возврата из браузера: та же диагностика, что у остального
/// сервера. Порт берётся из диагностики на каждом запросе — он нужен для
/// `redirect_uri` и должен совпадать с зарегистрированным в кабинете сервиса,
/// в том числе после смены порта на ходу.
#[derive(Clone)]
struct OAuthRoutes {
    diagnostics: Arc<Diagnostics>,
}

/// Параметры возврата: `code` для обмена, `state` для проверки, `error` — отказ.
///
/// Имена — как в query-строке сервиса; лишние параметры `serde` игнорирует.
#[derive(serde::Deserialize)]
struct OAuthCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

fn oauth_routes(diagnostics: Arc<Diagnostics>) -> Router {
    Router::new()
        .route("/oauth/twitch/callback", get(oauth_twitch_callback))
        .route(
            "/oauth/donationalerts/callback",
            get(oauth_donation_alerts_callback),
        )
        .route("/oauth/youtube/callback", get(oauth_youtube_callback))
        .with_state(OAuthRoutes { diagnostics })
}

/// Отдать страницу-результат: тот же `text/html`, что и `res.send` в JS, и без
/// кэша — страница одноразовая.
fn html_page(status: StatusCode, body: String) -> Response {
    let mut response = (status, body).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    no_store(&mut response);
    response
}

/// Успех авторизации: короткая страница, которую можно закрыть.
fn connected_page(service: &str) -> Response {
    html_page(
        StatusCode::OK,
        oauth::result_page(
            &format!("{service} подключён"),
            "Можно закрыть эту вкладку и вернуться в приложение.",
            true,
        ),
    )
}

/// Общий вход возврата: отказ сервиса или чужой/просроченный `state`.
///
/// `None` — можно продолжать обмен; `Some` — готовый ответ с объяснением.
fn guard_callback(query: &OAuthCallbackQuery, provider: &str, service: &str) -> Option<Response> {
    if let Some(error) = query.error.as_deref().filter(|value| !value.is_empty()) {
        // `error_description || error`: описание важнее кода, но пустое не годится.
        let description = query
            .error_description
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(error);
        return Some(html_page(
            StatusCode::BAD_REQUEST,
            oauth::result_page(
                &format!("{service}: ошибка авторизации"),
                description,
                false,
            ),
        ));
    }
    let now = Utc::now().timestamp_millis();
    let state = query.state.as_deref().unwrap_or_default();
    if !oauth::pending().consume(state, provider, now) {
        return Some(html_page(
            StatusCode::BAD_REQUEST,
            oauth::result_page(
                &format!("{service}: недействительный запрос"),
                "state не совпадает, попробуйте подключиться заново.",
                false,
            ),
        ));
    }
    None
}

/// Раздел настроек сервиса на момент возврата — копией, без удержания замка.
fn service_section(routes: &OAuthRoutes, key: &str) -> Value {
    let config = routes.diagnostics.config();
    config.get(key).cloned().unwrap_or(Value::Null)
}

/// Ключи приложения не заполнены — до сети дело не доходит, но в журнале это
/// должно быть видно так же явно, как ответ сервиса.
fn missing_guard(
    routes: &OAuthRoutes,
    section: &Value,
    key: &str,
    service: &str,
) -> Option<Response> {
    let missing = oauth::missing_credentials(section);
    if missing.is_empty() {
        return None;
    }
    routes.diagnostics.logger(key).warn(
        &format!("{key}: app credentials are not usable"),
        Some(&json!({
            "missing": missing,
            "client_id": oauth::section_text(section, "clientId"),
            "client_secret_len": oauth::section_text(section, "clientSecret").chars().count(),
        })),
    );
    Some(html_page(
        StatusCode::BAD_REQUEST,
        oauth::result_page(
            &format!("{service}: не удалось подключиться"),
            &oauth::credentials_problem_message(service, &missing),
            false,
        ),
    ))
}

/// Что ушло в сервис при обмене — для журнала; секрет показывается только длиной.
fn sent_credentials_log(service: &str, provider: &str, port: u16, section: &Value) -> Value {
    json!({
        "service": service,
        "client_id": oauth::section_text(section, "clientId"),
        "client_secret_len": oauth::section_text(section, "clientSecret").chars().count(),
        "grant_type": "authorization_code",
        "redirect_uri": oauth::redirect_uri(port, provider),
    })
}

/// Провал обмена кода на токен: объяснение причины плюс что именно отправили —
/// иначе по ответу сервиса не понять, какие ключи были в настройках.
fn token_failure_page(
    service: &str,
    provider: &str,
    port: u16,
    section: &Value,
    failure: &Value,
) -> Response {
    let sent = json!({
        "clientId": section.get("clientId").cloned().unwrap_or(Value::Null),
        "clientSecret": section.get("clientSecret").cloned().unwrap_or(Value::Null),
        "redirectUri": oauth::redirect_uri(port, provider),
    });
    let message = format!(
        "{}\n\n{}",
        oauth::describe_token_exchange_failure(service, failure),
        oauth::describe_sent_credentials(&sent),
    );
    html_page(
        StatusCode::INTERNAL_SERVER_ERROR,
        oauth::result_page(
            &format!("{service}: не удалось подключиться"),
            &message,
            false,
        ),
    )
}

/// Значение `code` строкой — как `String(code)` в JS.
fn callback_code(query: &OAuthCallbackQuery) -> String {
    query
        .code
        .clone()
        .unwrap_or_else(|| "undefined".to_string())
}

/// Токен доступа строкой — для запроса профиля.
fn access_token(token: &Value) -> String {
    token
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Возврат Twitch: обмен кода на токен, поиск `broadcasterId`, сохранение.
async fn oauth_twitch_callback(
    State(routes): State<OAuthRoutes>,
    Query(query): Query<OAuthCallbackQuery>,
) -> Response {
    if let Some(response) = guard_callback(&query, "twitch", "Twitch") {
        return response;
    }
    let section = service_section(&routes, "twitch");
    if let Some(response) = missing_guard(&routes, &section, "twitch", "Twitch") {
        return response;
    }

    let params = oauth::authorization_code_params(
        &section,
        "twitch",
        routes.diagnostics.port(),
        &callback_code(&query),
    );
    let outcome = http::form_post("https://id.twitch.tv/oauth2/token", &params).await;
    if !(200..300).contains(&outcome.status) {
        routes.diagnostics.logger("twitch").error(
            "twitch: token exchange failed",
            Some(&json!({
                "status": outcome.status,
                "response": outcome.body,
                "sent": sent_credentials_log("twitch", "twitch", routes.diagnostics.port(), &section),
            })),
        );
        return token_failure_page(
            "Twitch",
            "twitch",
            routes.diagnostics.port(),
            &section,
            &outcome.body,
        );
    }

    let token = outcome.body;
    // Логин канала уходит в адрес Helix — как `encodeURIComponent(channel)` в JS.
    let user_url = format!(
        "https://api.twitch.tv/helix/users?login={}",
        oauth::encode_uri_component(&oauth::section_text(&section, "channel"))
    );
    let (_, user) = http::helix_get(
        user_url,
        oauth::section_text(&section, "clientId"),
        access_token(&token),
    )
    .await;
    let broadcaster_id = user
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("id"))
        .cloned();

    let mut patch = Map::new();
    if let Some(value) = token.get("access_token") {
        patch.insert("userAccessToken".to_string(), value.clone());
    }
    if let Some(value) = token.get("refresh_token") {
        patch.insert("refreshToken".to_string(), value.clone());
    }
    if let Some(value) = broadcaster_id {
        patch.insert("broadcasterId".to_string(), value);
    }
    patch.insert(
        "expiresAt".to_string(),
        Value::from(oauth::token_expiry(&token, Utc::now().timestamp_millis())),
    );
    routes
        .diagnostics
        .save_twitch_tokens_and_restart(&Value::Object(patch));
    connected_page("Twitch")
}

/// Возврат DonationAlerts: обмен кода, чтение профиля (`userId`), сохранение.
async fn oauth_donation_alerts_callback(
    State(routes): State<OAuthRoutes>,
    Query(query): Query<OAuthCallbackQuery>,
) -> Response {
    if let Some(response) = guard_callback(&query, "donationalerts", "DonationAlerts") {
        return response;
    }
    let section = service_section(&routes, "donationAlerts");
    if let Some(response) = missing_guard(&routes, &section, "donationAlerts", "DonationAlerts") {
        return response;
    }

    let params = oauth::authorization_code_params(
        &section,
        "donationalerts",
        routes.diagnostics.port(),
        &callback_code(&query),
    );
    let outcome = http::form_post("https://www.donationalerts.com/oauth/token", &params).await;
    if !(200..300).contains(&outcome.status) {
        routes.diagnostics.logger("donationAlerts").error(
            "donationAlerts: token exchange failed",
            Some(&json!({
                "status": outcome.status,
                "response": outcome.body,
                "sent": sent_credentials_log("donationAlerts", "donationalerts", routes.diagnostics.port(), &section),
            })),
        );
        return token_failure_page(
            "DonationAlerts",
            "donationalerts",
            routes.diagnostics.port(),
            &section,
            &outcome.body,
        );
    }

    let token = outcome.body;
    let (_, body) = http::bearer_get(
        "https://www.donationalerts.com/api/v1/user/oauth".to_string(),
        access_token(&token),
    )
    .await;
    // `userJson.data || userJson`: пустой объект в JS — тоже правда, поэтому
    // откат делаем только на «ложном» `data`.
    let user_data = match body.get("data") {
        Some(data) if js_truthy(Some(data)) => data.clone(),
        _ => body.clone(),
    };
    let user_id = user_data.get("id").cloned();

    let mut patch = Map::new();
    if let Some(value) = token.get("access_token") {
        patch.insert("accessToken".to_string(), value.clone());
    }
    if let Some(value) = token.get("refresh_token") {
        patch.insert("refreshToken".to_string(), value.clone());
    }
    if let Some(value) = user_id {
        patch.insert("userId".to_string(), value);
    }
    patch.insert(
        "expiresAt".to_string(),
        Value::from(oauth::token_expiry(&token, Utc::now().timestamp_millis())),
    );
    routes
        .diagnostics
        .save_donation_alerts_tokens_and_restart(&Value::Object(patch));
    connected_page("DonationAlerts")
}

/// Возврат YouTube: обмен кода на токен и сохранение.
async fn oauth_youtube_callback(
    State(routes): State<OAuthRoutes>,
    Query(query): Query<OAuthCallbackQuery>,
) -> Response {
    if let Some(response) = guard_callback(&query, "youtube", "YouTube") {
        return response;
    }
    let section = service_section(&routes, "youtube");
    if let Some(response) = missing_guard(&routes, &section, "youtube", "YouTube") {
        return response;
    }

    let params = oauth::authorization_code_params(
        &section,
        "youtube",
        routes.diagnostics.port(),
        &callback_code(&query),
    );
    let outcome = http::form_post("https://oauth2.googleapis.com/token", &params).await;
    if !(200..300).contains(&outcome.status) {
        routes.diagnostics.logger("youtube").error(
            "youtube: token exchange failed",
            Some(&json!({
                "status": outcome.status,
                "response": outcome.body,
                "sent": sent_credentials_log("youtube", "youtube", routes.diagnostics.port(), &section),
            })),
        );
        return token_failure_page(
            "YouTube",
            "youtube",
            routes.diagnostics.port(),
            &section,
            &outcome.body,
        );
    }

    let token = outcome.body;
    let mut patch = Map::new();
    if let Some(value) = token.get("access_token") {
        patch.insert("accessToken".to_string(), value.clone());
    }
    if let Some(value) = token.get("refresh_token") {
        patch.insert("refreshToken".to_string(), value.clone());
    }
    patch.insert(
        "expiresAt".to_string(),
        Value::from(oauth::token_expiry(&token, Utc::now().timestamp_millis())),
    );
    routes
        .diagnostics
        .save_youtube_tokens_and_restart(&Value::Object(patch));
    connected_page("YouTube")
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;

    /// Сервер отдаёт статику из настоящего репозитория — подставных файлов нет:
    /// так тест ловит и опечатку в имени каталога, и переименование страницы.
    fn repo_root() -> PathBuf {
        crate::repository_root()
    }

    /// Диагностика во временном каталоге: тест не трогает пользовательские файлы.
    struct Fixture {
        dir: PathBuf,
        diagnostics: Arc<Diagnostics>,
    }

    impl Fixture {
        fn new() -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let index = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir =
                std::env::temp_dir().join(format!("ose-server-{}-{index}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("временный каталог должен создаваться");
            fs::write(dir.join("config.example.json"), "{\n  \"port\": 8710\n}\n")
                .expect("шаблон должен записываться");
            let diagnostics = Arc::new(
                Diagnostics::open(Storage::beside_sources(dir.clone())).expect("диагностика"),
            );
            Self { dir, diagnostics }
        }

        fn app(&self) -> Router {
            router(&repo_root(), self.diagnostics.clone())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.dir).ok();
        }
    }

    /// Запрос из указанного адреса: `ConnectInfo` нужен `/support-bundle`,
    /// который отдаётся только с этой машины (настоящий сервер подставляет его
    /// через `into_make_service_with_connect_info`).
    fn request_from(uri: &str, address: [u8; 4]) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .extension(ConnectInfo(SocketAddr::from((address, 1234))))
            .body(Body::empty())
            .unwrap()
    }

    async fn request(fixture: &Fixture, uri: &str) -> Response {
        fixture
            .app()
            .oneshot(request_from(uri, [127, 0, 0, 1]))
            .await
            .expect("запрос должен дойти до сервера")
    }

    async fn get(fixture: &Fixture, uri: &str) -> (StatusCode, Vec<u8>) {
        let response = request(fixture, uri).await;
        let status = response.status();
        let body = response
            .into_body()
            .collect()
            .await
            .expect("тело должно читаться")
            .to_bytes()
            .to_vec();
        (status, body)
    }

    #[tokio::test]
    async fn support_bundle_is_refused_from_the_network() {
        let fixture = Fixture::new();
        // Слушаем на всех интерфейсах ради пульта, поэтому отчёт для поддержки
        // обязан отсекать запросы из сети — как `isLoopbackRequest` в JS.
        let response = fixture
            .app()
            .oneshot(request_from("/support-bundle", [192, 168, 1, 5]))
            .await
            .expect("запрос должен дойти до сервера");
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn serves_the_panel_at_root_and_by_path() {
        let fixture = Fixture::new();
        for uri in ["/", "/control/control.html"] {
            let (status, body) = get(&fixture, uri).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
            assert!(body.len() > 1000, "{uri}: страница подозрительно мала");
        }
    }

    #[tokio::test]
    async fn static_files_ask_the_client_to_revalidate() {
        let fixture = Fixture::new();
        // Обновление не должно залипать в кэше webview: адреса файлов те же.
        let response = request(&fixture, "/control/control.html").await;
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
    }

    #[tokio::test]
    async fn serves_user_media_with_ranges() {
        let fixture = Fixture::new();
        let media = fixture.diagnostics.storage().media_dir();
        fs::create_dir_all(&media).expect("каталог media должен создаваться");
        fs::write(media.join("intro.mp4"), b"0123456789").expect("файл заставки");

        // Обычный запрос: файл отдаётся с типом видео.
        let response = request(&fixture, "/media/intro.mp4").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("video/mp4"),
            "заставка должна отдаваться как видео"
        );

        // С `Range` — 206: без этого `<video>` не проигрывает файл.
        let ranged = fixture
            .app()
            .oneshot(
                Request::builder()
                    .uri("/media/intro.mp4")
                    .header(header::RANGE, "bytes=0-3")
                    .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 1234))))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("запрос должен дойти до сервера");
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
    }

    #[tokio::test]
    async fn serves_shared_assets_and_overlay() {
        let fixture = Fixture::new();
        // Общие ресурсы и оверлей — то, без чего панель и OBS останутся пустыми.
        for uri in [
            "/shared/theme.css",
            "/shared/events.js",
            "/overlay/overlay.html",
            "/assets/icons/32x32.png",
        ] {
            let (status, body) = get(&fixture, uri).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
            assert!(!body.is_empty(), "{uri}: пустой ответ");
        }
    }

    #[tokio::test]
    async fn directory_roots_redirect_to_the_trailing_slash() {
        let fixture = Fixture::new();
        // `express.static` отвечал на `/remote` редиректом на `/remote/`, иначе
        // относительные `style.css`/`remote.js` разрешались бы от корня и пульт
        // открывался бы без стилей (это и был баг). Код доступа сохраняется.
        let response = request(&fixture, "/remote?token=x").await;
        assert_eq!(response.status(), StatusCode::MOVED_PERMANENTLY);
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::LOCATION)
                .unwrap(),
            "/remote/?token=x"
        );
        // Со слэшем страница отдаётся, а её относительные ресурсы находятся.
        for uri in ["/remote/", "/remote/style.css", "/remote/remote.js"] {
            let (status, body) = get(&fixture, uri).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
            assert!(!body.is_empty(), "{uri}: пустой ответ");
        }
    }

    #[tokio::test]
    async fn unknown_path_is_not_found() {
        let fixture = Fixture::new();
        let (status, _) = get(&fixture, "/nope/nope.js").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn healthz_answers_with_a_short_report() {
        let fixture = Fixture::new();
        let response = request(&fixture, "/healthz").await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("application/json"));

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let report: serde_json::Value =
            serde_json::from_slice(&body).expect("ответ должен быть JSON");
        assert_eq!(report["ok"], serde_json::json!(true));
        assert_eq!(report["port"], serde_json::json!(8710));
        // Пути к файлам в сетевой отчёт не попадают.
        assert!(!report.to_string().contains("config.json"));
    }

    #[tokio::test]
    async fn support_bundle_answers_with_text_and_a_file_name() {
        let fixture = Fixture::new();
        let response = request(&fixture, "/support-bundle").await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/plain; charset=utf-8"
        );
        let disposition = response.headers()[header::CONTENT_DISPOSITION]
            .to_str()
            .expect("имя файла должно быть заголовком");
        assert!(
            disposition.starts_with("attachment; filename=\"ose-support-"),
            "{disposition}"
        );
        assert!(disposition.ends_with(".txt\""), "{disposition}");

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(body.to_vec()).expect("отчёт должен быть UTF-8");
        // BOM: Windows-блокнот иначе покажет кракозябры.
        assert!(text.starts_with('\u{FEFF}'));
        assert!(text.contains("== Приложение =="));
        assert!(text.contains("== Настройки (без секретов) =="));
    }

    #[tokio::test]
    async fn oauth_callback_reports_a_service_error() {
        let fixture = Fixture::new();
        let response = request(
            &fixture,
            "/oauth/twitch/callback?error=access_denied&error_description=отказано",
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(response.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/html"));

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(body.to_vec()).expect("страница — UTF-8");
        assert!(text.contains("Twitch: ошибка авторизации"), "{text}");
        assert!(text.contains("отказано"), "{text}");
    }

    #[tokio::test]
    async fn oauth_callback_rejects_a_foreign_state() {
        let fixture = Fixture::new();
        // Чужой `state` отсекается до сети: чужой redirect не должен ставить токены.
        let (status, body) = get(
            &fixture,
            "/oauth/donationalerts/callback?code=x&state=bogus",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let text = String::from_utf8(body).expect("страница — UTF-8");
        assert!(
            text.contains("DonationAlerts: недействительный запрос"),
            "{text}"
        );
        assert!(text.contains("state не совпадает"), "{text}");
    }

    #[tokio::test]
    async fn oauth_callback_explains_missing_credentials() {
        let fixture = Fixture::new();
        // Свой `state` проходит проверку, дальше — пустые ключи приложения из
        // шаблона: обмен не начинается, страница объясняет, что заполнить.
        let state = oauth::pending().make("youtube", Utc::now().timestamp_millis());
        let (status, body) = get(
            &fixture,
            &format!("/oauth/youtube/callback?code=x&state={state}"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let text = String::from_utf8(body).expect("страница — UTF-8");
        assert!(text.contains("YouTube: не удалось подключиться"), "{text}");
        assert!(text.contains("Не заполнено"), "{text}");
    }

    #[test]
    fn a_switch_port_is_accepted_only_inside_the_range() {
        // Как `Number.isInteger(requested) && requested >= 1024 && <= 65535`
        // в `switchPort`: строка приводится к числу, дробь и мусор — не порт.
        for (value, expected) in [
            (json!(9000), Some(9000)),
            (json!(1024), Some(1024)),
            (json!(65535), Some(65535)),
            (json!(1023), None),
            (json!(65536), None),
            (json!(8710.5), None),
            (json!("9000"), Some(9000)),
            (json!("abc"), None),
            (json!(null), None),
        ] {
            assert_eq!(valid_switch_port(&value), expected, "вход: {value}");
        }
    }

    #[test]
    fn a_busy_port_leaves_the_server_on_the_old_one() {
        let fixture = Fixture::new();
        // Занимаем порт на всех интерфейсах и просим переехать на него же: привязка
        // (теперь тоже на всех интерфейсах, ради пульта) должна провалиться,
        // а состояние — остаться прежним.
        let held = std::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, 0))
            .expect("временный порт");
        let busy = held.local_addr().expect("адрес").port();
        let control = ServerControl::new(repo_root(), fixture.diagnostics.clone());

        let response = control.switch_port(&json!(busy));

        assert_eq!(response["ok"], json!(false), "{response}");
        assert_eq!(response["port"], json!(8710));
        assert_eq!(fixture.diagnostics.port(), 8710);
    }

    #[test]
    fn a_switch_to_the_same_port_changes_nothing() {
        let fixture = Fixture::new();
        let control = ServerControl::new(repo_root(), fixture.diagnostics.clone());

        for requested in [json!(8710), json!(80), json!("abc")] {
            let response = control.switch_port(&requested);
            assert_eq!(response["ok"], json!(true), "{requested}: {response}");
            assert_eq!(response["port"], json!(8710));
        }
        assert_eq!(fixture.diagnostics.port(), 8710);
    }
}
